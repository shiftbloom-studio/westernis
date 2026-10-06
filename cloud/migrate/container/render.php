<?php
/**
 * Westernis — render every page on one side of the migration, and compare both sides
 * (docs/cloudflare-design.md, section 2.9; migrate.sh step 6)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Row counts cannot tell whether the SQLite wiki shows the same thing as the MariaDB wiki: a Cargo query whose
 * meaning changes on SQLite (where=type="Realm" names a column there), a different sort order or a missing
 * link can keep every count equal. This script parses pages on each side with the same code, settings and
 * files (both runs happen in the migration container; only the database differs) and compares the results.
 *
 * Render mode, read-only (source: WST_DB=mysql, target: WST_DB=sqlite):
 *   php render.php --out /out/reports/render-source.json --timestamp 20261006120000 [--repeat 2] [--sample N]
 *   -> per page (current revision, canonical parser options, fixed {{CURRENT…}} time): sha256 of the HTML,
 *      the link sets the link tables are built from (local links, templates, categories with sort key
 *      prefix, files, existence checks, external, interwiki and language links), page properties (value
 *      hashes) and the parse time. With --repeat 2 every page is parsed twice; a page whose HTML differs
 *      between the two runs is marked non-deterministic and its HTML is not compared.
 *      "digests" are short hashes of the API-comparable sets (links, templates, categories, images,
 *      externallinks); verify-cloud.mjs recomputes them from action=parse in the cloud.
 *      No parser cache is read or written; a plain parse never stores Cargo data (CargoStore needs an origin).
 *
 * Compare mode (reads the four files, no database access):
 *   php render.php --compare --source-render a.json --target-render b.json \
 *     --source-counts c.json --target-counts d.json [--frozen 0|1] --out /out/reports/render-check.json
 *   Every finding is classified:
 *     fail    always stops the export: a page parsed on one side only, a parse that throws only on SQLite,
 *             and (frozen bundles) a page whose revision changed between the two parses;
 *     review  the bundle is written, but Upload-Bundle.ps1 refuses it without -AcceptReview:
 *             the two parses differ (link sets, properties or HTML: SQLite semantics), the target's link tables
 *             differ from the target's parse (rebuild), or Cargo rows of a page differ between the source's
 *             stored rows and the rebuilt ones;
 *     note    explained differences: the legacy wiki's own link tables did not match its parse (stale in the
 *             source, the cloud has them fresh), pages changed during an unfrozen export, parse errors that
 *             both sides share.
 *   Exit code 1 when there is at least one "fail".
 */

use MediaWiki\Maintenance\Maintenance;
use MediaWiki\Parser\ParserOptions;
use MediaWiki\Parser\ParserOutput;
use MediaWiki\Parser\ParserOutputLinkTypes;
use MediaWiki\Revision\RevisionRecord;

require_once ( getenv( 'MW_INSTALL_PATH' ) ?: '/var/www/html' ) . '/maintenance/Maintenance.php';

class WesternisRender extends Maintenance {
	/** Kinds compared between the two parses; [kind => link table key in counts.php "links"] for the rebuild check */
	private const KINDS = [ 'links', 'templates', 'categories', 'images', 'existence', 'external', 'interwiki', 'language', 'props' ];
	private const DB_KINDS = [ 'links' => 'pl', 'templates' => 'tl', 'images' => 'il', 'existence' => 'exl' ];
	/** API-comparable sets; verify-cloud.mjs builds the same strings from action=parse */
	private const DIGEST_KINDS = [ 'links', 'templates', 'categories', 'images', 'external' ];
	/** Volatile HTML comments (limit report, cache notes) */
	private const VOLATILE = '/<!--\s*(NewPP limit report|Saved in parser cache|Transclusion expansion time report|Parsed by |Cached time)[\s\S]*?-->\s*/';
	private const MAX_ITEMS = 12;

	public function __construct() {
		parent::__construct();
		$this->addDescription( 'Render every page (read-only) and write the results, or compare the two sides' );
		$this->addOption( 'out', 'Write the JSON result to this file', true, true );
		$this->addOption( 'timestamp', 'Fixed parser timestamp (YYYYMMDDHHMMSS) for {{CURRENT…}}', false, true );
		$this->addOption( 'repeat', 'Parse every page this many times to detect non-deterministic HTML (default 2)', false, true );
		$this->addOption( 'sample', 'Only every n-th page, evenly spread (default 0 = all pages)', false, true );
		$this->addOption( 'compare', 'Compare two render files instead of rendering' );
		$this->addOption( 'source-render', 'Source render file (compare mode)', false, true );
		$this->addOption( 'target-render', 'Target render file (compare mode)', false, true );
		$this->addOption( 'source-counts', 'Source counts file of counts.php (compare mode)', false, true );
		$this->addOption( 'target-counts', 'Target counts file of counts.php (compare mode)', false, true );
		$this->addOption( 'frozen', '1 if the source was frozen (compare mode)', false, true );
	}

	public function execute() {
		if ( $this->hasOption( 'compare' ) ) {
			$this->compareFiles();
			return;
		}
		$this->writeJson( $this->render() );
	}

	// ------------------------------------------------------------------------------------------------- render

	private function render(): array {
		$ts = (string)$this->getOption( 'timestamp', gmdate( 'YmdHis' ) );
		if ( !preg_match( '/^\d{14}$/', $ts ) ) {
			$this->fatalError( '--timestamp must be YYYYMMDDHHMMSS' );
		}
		$repeat = max( 1, min( 5, (int)$this->getOption( 'repeat', 2 ) ) );
		$services = $this->getServiceContainer();
		$revLookup = $services->getRevisionLookup();
		$renderer = $services->getRevisionRenderer();
		$db = $this->getDB( DB_REPLICA );

		$rows = iterator_to_array( $db->newSelectQueryBuilder()
			->select( [ 'page_id', 'page_namespace', 'page_title', 'page_latest' ] )
			->from( 'page' )
			->orderBy( 'page_id' )
			->caller( __METHOD__ )
			->fetchResultSet() );
		$total = count( $rows );
		$sample = max( 0, (int)$this->getOption( 'sample', 0 ) );
		if ( $sample > 0 && $sample < $total ) {
			$pick = [];
			for ( $i = 0; $i < $sample; $i++ ) {
				$pick[] = $rows[intdiv( $i * $total, $sample )];
			}
			$rows = $pick;
		}

		$pages = [];
		$t0 = hrtime( true );
		$n = 0;
		foreach ( $rows as $row ) {
			$id = (string)(int)$row->page_id;
			$entry = [
				'ns' => (int)$row->page_namespace,
				'title' => (string)$row->page_title,
				'rev' => (int)$row->page_latest,
				'error' => null,
			];
			$start = hrtime( true );
			try {
				$rev = $revLookup->getRevisionById( (int)$row->page_latest );
				if ( !$rev ) {
					throw new RuntimeException( 'revision ' . (int)$row->page_latest . ' cannot be loaded' );
				}
				$hashes = [];
				for ( $i = 0; $i < $repeat; $i++ ) {
					$popts = ParserOptions::newCanonical( 'canonical' );
					$popts->setTimestamp( $ts );
					$rendered = $renderer->getRenderedRevision( $rev, $popts, null, [ 'audience' => RevisionRecord::RAW ] );
					if ( !$rendered ) {
						throw new RuntimeException( 'the revision renderer returned nothing' );
					}
					$po = $rendered->getRevisionParserOutput();
					$html = $po->hasText() ? $po->getContentHolderText() : '';
					$hashes[] = hash( 'sha256', (string)preg_replace( self::VOLATILE, '', $html ) );
					if ( $i === 0 ) {
						$entry += $this->sets( $po );
					}
				}
				$entry['html'] = $hashes[0];
				$entry['deterministic'] = count( array_unique( $hashes ) ) === 1;
				$entry['digests'] = self::digests( $entry );
			} catch ( Throwable $e ) {
				$entry['error'] = get_class( $e ) . ': ' . strtok( $e->getMessage(), "\n" );
			}
			$entry['ms'] = (int)( ( hrtime( true ) - $start ) / 1e6 );
			$pages[$id] = $entry;
			if ( ++$n % 50 === 0 ) {
				$this->output( "  rendered $n of " . count( $rows ) . " pages\n" );
			}
		}
		$errors = count( array_filter( $pages, static fn ( $p ) => $p['error'] !== null ) );
		$this->output( sprintf( "Rendered %d pages (%d with errors) in %.1f s.\n", count( $pages ), $errors, ( hrtime( true ) - $t0 ) / 1e9 ) );
		return [
			'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'dbType' => $db->getType(),
			'parserTimestamp' => $ts,
			'repeat' => $repeat,
			'pagesInWiki' => $total,
			'sampled' => count( $rows ) < $total,
			'pages' => (object)$pages,
		];
	}

	/** The sets a parse yields, as sorted canonical strings ("ns:dbkey", "dbkey|prefix", URLs). */
	private function sets( ParserOutput $po ): array {
		$key = static fn ( $link ): string => $link->getNamespace() . ':' . $link->getDBkey();
		$list = static function ( ParserOutput $po, ParserOutputLinkTypes $type, callable $fmt ): array {
			$out = [];
			foreach ( $po->getLinkList( $type ) as $item ) {
				$out[] = $fmt( $item['link'] );
			}
			$out = array_values( array_unique( $out ) );
			sort( $out, SORT_STRING );
			return $out;
		};
		$categories = [];
		foreach ( $po->getCategoryMap() as $dbkey => $prefix ) {
			$categories[] = (string)$dbkey . '|' . (string)$prefix;
		}
		sort( $categories, SORT_STRING );
		$external = array_map( 'strval', array_keys( $po->getExternalLinks() ) );
		sort( $external, SORT_STRING );
		$props = [];
		foreach ( $po->getPageProperties() as $name => $value ) {
			$props[(string)$name] = substr( sha1( is_bool( $value ) ? (string)(int)$value : (string)$value ), 0, 16 );
		}
		ksort( $props, SORT_STRING );
		return [
			'links' => $list( $po, ParserOutputLinkTypes::LOCAL, $key ),
			'templates' => $list( $po, ParserOutputLinkTypes::TEMPLATE, $key ),
			'categories' => $categories,
			'images' => $list( $po, ParserOutputLinkTypes::MEDIA, $key ),
			'existence' => $list( $po, ParserOutputLinkTypes::EXISTENCE, $key ),
			'external' => $external,
			'interwiki' => $list( $po, ParserOutputLinkTypes::INTERWIKI,
				static fn ( $l ): string => $l->getInterwiki() . ':' . $l->getDBkey() ),
			'language' => $list( $po, ParserOutputLinkTypes::LANGUAGE,
				static fn ( $l ): string => $l->getInterwiki() . ':' . $l->getText() ),
			'props' => $props,
		];
	}

	/** First 16 hex of sha1(sorted strings joined by "\n"), the form verify-cloud.mjs rebuilds from action=parse. */
	private static function digests( array $entry ): array {
		$out = [];
		foreach ( self::DIGEST_KINDS as $k ) {
			$out[$k] = substr( sha1( implode( "\n", $entry[$k] ?? [] ) ), 0, 16 );
		}
		return $out;
	}

	// ------------------------------------------------------------------------------------------------ compare

	private function compareFiles(): void {
		$sR = $this->readJson( 'source-render' );
		$tR = $this->readJson( 'target-render' );
		$sC = $this->readJson( 'source-counts' )['content'] ?? [];
		$tC = $this->readJson( 'target-counts' )['content'] ?? [];
		$frozen = (string)$this->getOption( 'frozen', '0' ) === '1';

		$fail = [];
		$review = [];
		$notes = [];
		$stale = [];
		$stats = [ 'pages' => 0, 'compared' => 0, 'identical' => 0, 'htmlCompared' => 0, 'nonDeterministic' => 0,
			'changedDuringExport' => 0, 'parseErrorsBothSides' => 0, 'staleInSource' => 0, 'cargoPagesCompared' => 0 ];
		if ( ( $sR['parserTimestamp'] ?? null ) !== ( $tR['parserTimestamp'] ?? null ) ) {
			$notes[] = 'the two sides were parsed with different {{CURRENT…}} timestamps: HTML differences may come from that';
		}
		$sP = $sR['pages'] ?? [];
		$tP = $tR['pages'] ?? [];
		$sampled = ( $sR['sampled'] ?? false ) || ( $tR['sampled'] ?? false );
		$tCats = self::categoriesByPage( $tC['categories'] ?? [] );
		$sCats = self::categoriesByPage( $sC['categories'] ?? [] );

		$ids = array_unique( array_merge( array_map( 'strval', array_keys( $sP ) ), array_map( 'strval', array_keys( $tP ) ) ) );
		sort( $ids, SORT_NUMERIC );
		foreach ( $ids as $id ) {
			$stats['pages']++;
			$s = $sP[$id] ?? null;
			$t = $tP[$id] ?? null;
			$title = self::label( $s ?? $t );
			if ( $s === null || $t === null ) {
				if ( !$sampled ) {
					$fail[] = [ 'page' => (int)$id, 'title' => $title, 'what' => 'rendered on one side only ('
						. ( $s === null ? 'target' : 'source' ) . ')' ];
				}
				continue;
			}
			if ( $s['rev'] !== $t['rev'] ) {
				$what = "revision changed between the two parses (source {$s['rev']}, target {$t['rev']})";
				if ( $frozen ) {
					$fail[] = [ 'page' => (int)$id, 'title' => $title, 'what' => $what . ' although the source was frozen' ];
				} else {
					$stats['changedDuringExport']++;
					$notes[] = "$title: $what; edited during the unfrozen export, not compared";
				}
				continue;
			}
			if ( $s['error'] !== null || $t['error'] !== null ) {
				if ( $t['error'] !== null && $s['error'] === null ) {
					$fail[] = [ 'page' => (int)$id, 'title' => $title, 'what' => "the parse fails only on SQLite: {$t['error']}" ];
				} elseif ( $s['error'] !== null && $t['error'] === null ) {
					$notes[] = "$title: the parse fails only on the MariaDB side ({$s['error']}); SQLite renders it";
				} else {
					$stats['parseErrorsBothSides']++;
					$notes[] = "$title: the parse fails on both sides ({$t['error']})";
				}
				continue;
			}
			$stats['compared']++;

			// A: the two parses (same code, settings and files; only the database differs)
			$diffs = [];
			foreach ( self::KINDS as $k ) {
				$d = self::setDiff( $s[$k] ?? [], $t[$k] ?? [] );
				if ( $d ) {
					$diffs[$k] = $d;
				}
			}
			$htmlComparable = ( $s['deterministic'] ?? false ) && ( $t['deterministic'] ?? false );
			if ( $htmlComparable ) {
				$stats['htmlCompared']++;
				if ( $s['html'] !== $t['html'] ) {
					$diffs['html'] = $diffs ? 'differs as well' : 'differs although every link set and property matches';
				}
			} else {
				$stats['nonDeterministic']++;
			}

			// B: the target's link tables against the target's parse (refreshLinks must have stored exactly this)
			$rebuild = [];
			$tDb = $tC['links'][$id] ?? [];
			foreach ( self::DB_KINDS as $k => $dbKey ) {
				$d = self::setDiff( $tDb[$dbKey] ?? [], $t[$k] ?? [] );
				if ( $d ) {
					$rebuild[$k] = self::relabel( $d );
				}
			}
			$d = self::setDiff( $tCats[$id] ?? [], self::catNames( $t['categories'] ?? [] ) );
			if ( $d ) {
				$rebuild['categories'] = self::relabel( $d );
			}
			$missingProps = array_values( array_diff( array_keys( $t['props'] ?? [] ), array_keys( $tDb['pp'] ?? [] ) ) );
			if ( $missingProps ) {
				$rebuild['props'] = [ 'notStored' => array_slice( $missingProps, 0, self::MAX_ITEMS ) ];
			}

			if ( $diffs ) {
				$review[] = [ 'page' => (int)$id, 'title' => $title, 'what' => 'renders differently on SQLite', 'diff' => $diffs ];
			}
			if ( $rebuild ) {
				$review[] = [ 'page' => (int)$id, 'title' => $title, 'what' => 'link tables in the target differ from its parse', 'diff' => $rebuild ];
			}
			if ( !$diffs && !$rebuild ) {
				$stats['identical']++;
			}

			// C: the legacy wiki's own link tables against the legacy parse (stale tables are not a migration error)
			$sDb = $sC['links'][$id] ?? [];
			$staleKinds = [];
			foreach ( self::DB_KINDS as $k => $dbKey ) {
				if ( self::setDiff( $sDb[$dbKey] ?? [], $s[$k] ?? [] ) ) {
					$staleKinds[] = $k;
				}
			}
			if ( self::setDiff( $sCats[$id] ?? [], self::catNames( $s['categories'] ?? [] ) ) ) {
				$staleKinds[] = 'categories';
			}
			if ( $staleKinds ) {
				$stats['staleInSource']++;
				$stale[(int)$id] = [ 'title' => $title, 'kinds' => $staleKinds ];
			}
		}

		// Cargo rows per table and page: the source's stored rows against the rebuilt ones
		$sCargo = $sC['cargo'] ?? [];
		$tCargo = $tC['cargo'] ?? [];
		$cargoTables = array_unique( array_merge( array_keys( $sCargo ), array_keys( $tCargo ) ) );
		sort( $cargoTables, SORT_STRING );
		$cargoPages = [];
		$unser = static fn ( string $s ) => unserialize( $s, [ 'allowed_classes' => false ] );
		foreach ( $cargoTables as $table ) {
			$a = $sCargo[$table] ?? null;
			$b = $tCargo[$table] ?? null;
			if ( $a === null || $b === null ) {
				$review[] = [ 'page' => null, 'title' => null, 'what' => "Cargo table $table exists only in the "
					. ( $a === null ? 'target' : 'source' ) ];
				continue;
			}
			$pageIds = array_unique( array_merge( array_map( 'strval', array_keys( $a ) ), array_map( 'strval', array_keys( $b ) ) ) );
			sort( $pageIds, SORT_NUMERIC );
			foreach ( $pageIds as $pid ) {
				$cargoPages[$pid] = true;
				$ra = $a[$pid] ?? [];
				$rb = $b[$pid] ?? [];
				if ( $ra === $rb ) {
					continue;
				}
				$sa = array_map( 'serialize', $ra );
				$sb = array_map( 'serialize', $rb );
				$onlyS = array_values( array_diff( $sa, $sb ) );
				$onlyT = array_values( array_diff( $sb, $sa ) );
				$label = self::label( $tP[$pid] ?? $sP[$pid] ?? null ) ?? "page $pid";
				$item = [
					'page' => (int)$pid,
					'title' => $label,
					'what' => "Cargo rows of $table differ (source " . count( $ra ) . ', target ' . count( $rb ) . ')',
					'diff' => [
						'onlySource' => array_map( $unser, array_slice( $onlyS, 0, 3 ) ),
						'onlyTarget' => array_map( $unser, array_slice( $onlyT, 0, 3 ) ),
						'changedColumns' => self::changedColumns( $ra, $rb ),
					],
				];
				if ( isset( $stale[(int)$pid] ) ) {
					$item['hint'] = 'the legacy link tables of this page are stale as well: probably stale Cargo data in the source';
				}
				$review[] = $item;
			}
		}
		$stats['cargoPagesCompared'] = count( $cargoPages );

		if ( $stale ) {
			$notes[] = count( $stale ) . ' page(s) had link tables in the legacy wiki that did not match their own parse (stale in the source; '
				. 'the SQLite side was rebuilt from the parse): see "staleInSource"';
		}
		$result = [
			'ok' => !$fail,
			'reviewOk' => !$review,
			'checkedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'frozen' => $frozen,
			'sampled' => $sampled,
			'stats' => $stats,
			'fail' => $fail,
			'review' => $review,
			'notes' => $notes,
			'staleInSource' => (object)$stale,
		];
		$this->writeJson( $result );
		$this->output( sprintf( "Render check: %d pages compared, %d identical, %d fail, %d to review, %d stale in the source.\n",
			$stats['compared'], $stats['identical'], count( $fail ), count( $review ), count( $stale ) ) );
		foreach ( array_slice( $fail, 0, 20 ) as $f ) {
			$this->error( "FAIL {$f['title']}: {$f['what']}" );
		}
		foreach ( array_slice( $review, 0, 20 ) as $r ) {
			$this->output( 'REVIEW ' . ( $r['title'] ?? '-' ) . ": {$r['what']}\n" );
		}
		if ( $fail ) {
			$this->fatalError( count( $fail ) . ' render check failure(s): see reports/render-check.json' );
		}
	}

	/** page id -> sorted category names, from counts.php content.categories (cat -> type -> rows [from, ...]) */
	private static function categoriesByPage( array $cats ): array {
		$out = [];
		foreach ( $cats as $cat => $types ) {
			foreach ( $types as $rows ) {
				foreach ( $rows as $r ) {
					$out[(string)$r[0]][] = (string)$cat;
				}
			}
		}
		foreach ( $out as &$list ) {
			$list = array_values( array_unique( $list ) );
			sort( $list, SORT_STRING );
		}
		unset( $list );
		return $out;
	}

	/** "dbkey|prefix" -> sorted "dbkey" */
	private static function catNames( array $cats ): array {
		$out = array_values( array_unique( array_map( static fn ( $c ) => explode( '|', (string)$c, 2 )[0], $cats ) ) );
		sort( $out, SORT_STRING );
		return $out;
	}

	/** null when equal, else the elements only in a / only in b (lists) or the changed keys (maps) */
	private static function setDiff( array $a, array $b ): ?array {
		if ( $a === $b ) {
			return null;
		}
		if ( array_is_list( $a ) && array_is_list( $b ) ) {
			$onlyA = array_values( array_diff( $a, $b ) );
			$onlyB = array_values( array_diff( $b, $a ) );
			if ( !$onlyA && !$onlyB ) {
				return null;   // same elements, other order/duplicates
			}
			return [ 'onlySource' => array_slice( $onlyA, 0, self::MAX_ITEMS ), 'onlyTarget' => array_slice( $onlyB, 0, self::MAX_ITEMS ),
				'counts' => [ count( $onlyA ), count( $onlyB ) ] ];
		}
		$changed = [];
		foreach ( array_unique( array_merge( array_keys( $a ), array_keys( $b ) ) ) as $k ) {
			if ( ( $a[$k] ?? null ) !== ( $b[$k] ?? null ) ) {
				$changed[] = (string)$k;
			}
		}
		return $changed ? [ 'changedKeys' => array_slice( $changed, 0, self::MAX_ITEMS ) ] : null;
	}

	/** For the rebuild check the sides are "stored" (link table) and "parse" */
	private static function relabel( array $d ): array {
		return [ 'onlyStored' => $d['onlySource'] ?? [], 'onlyParse' => $d['onlyTarget'] ?? [] ];
	}

	/** Columns whose values differ when both sides have exactly one row (the usual infobox case) */
	private static function changedColumns( array $ra, array $rb ): array {
		if ( count( $ra ) !== 1 || count( $rb ) !== 1 ) {
			return [];
		}
		$out = [];
		foreach ( array_unique( array_merge( array_keys( $ra[0] ), array_keys( $rb[0] ) ) ) as $col ) {
			$x = $ra[0][$col] ?? null;
			$y = $rb[0][$col] ?? null;
			if ( $x !== $y ) {
				$out[$col] = [ 'source' => self::cut( $x ), 'target' => self::cut( $y ) ];
			}
		}
		return array_slice( $out, 0, self::MAX_ITEMS, true );
	}

	private static function cut( ?string $v ): ?string {
		return ( $v !== null && strlen( $v ) > 200 ) ? substr( $v, 0, 200 ) . '…' : $v;
	}

	private static function label( ?array $p ): ?string {
		return $p === null ? null : "{$p['ns']}:{$p['title']}";
	}

	private function readJson( string $opt ): array {
		$file = (string)$this->getOption( $opt, '' );
		$raw = $file !== '' ? @file_get_contents( $file ) : false;
		$data = $raw === false ? null : json_decode( $raw, true );
		if ( !is_array( $data ) ) {
			$this->fatalError( "Cannot read --$opt '$file'." );
		}
		return $data;
	}

	private function writeJson( array $data ): void {
		$json = json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
			| JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR ) . "\n";
		if ( file_put_contents( (string)$this->getOption( 'out' ), $json ) === false ) {
			$this->fatalError( 'Cannot write ' . $this->getOption( 'out' ) );
		}
	}
}

$maintClass = WesternisRender::class;
require_once RUN_MAINTENANCE_IF_MAIN;
