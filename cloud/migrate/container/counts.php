<?php
/**
 * Westernis — JSON counts and content fingerprints of a wiki database, and their comparison
 * (docs/cloudflare-design.md, section 2.9)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Runs only inside the migration container (MW_CONFIG_FILE=/opt/westernis/migrate/MigrationSettings.php).
 *
 * Count mode, read-only (source: WST_DB=mysql, target: WST_DB=sqlite):
 *   php counts.php --out /out/reports/source-counts.json
 *   -> exact row count of every table, pages per namespace, maximum IDs, site_stats, Cargo rows per
 *      table, image/oldimage/filearchive name -> SHA-1, the log entries (id, type, action, timestamp), and
 *      "content": fingerprints that row counts cannot give:
 *        pages        page_id -> [ns, title, latest, len, redirect, model, lang]
 *        archive      ar_id -> every archive field plus its slots (role, model, size, sha1, address,
 *                     SHA-1 of the raw text row and whether the text matches content_sha1/size)
 *        collation    the collation table; collationUse = categorylinks rows per collation name;
 *                     configuredCollation = $wgCategoryCollation
 *        categories   per category and type: members in stored sort order (cl_sortkey, cl_from), with
 *                     sort key prefix, timestamp (normalised to TS_MW) and sha1 of the binary sort key
 *        links        per page: pagelinks, templatelinks, imagelinks, existencelinks, page_props
 *                     (value hashes), as stored in the link tables
 *        cargo        per Cargo table and page: the normalised rows (_ID/_rowID left out, field tables
 *                     joined to their page through the main table)
 *        checks       SQLite only: rows whose cl_timestamp is not stored as INTEGER
 *
 * Compare mode (reads two count files, no database access):
 *   php counts.php --compare --source a.json --target b.json --out /out/reports/count-check.json
 *   -> exit code 1 on any mismatch. Rules:
 *      - caches, queues and rebuilt indexes (INFO_TABLES) are reported, never compared;
 *      - link tables, page_props, category and cargo_pages are rebuilt by refreshLinks/Cargo: their row
 *        counts are reported here and their content is checked per page by render.php --compare;
 *      - logging, log_search, recentchanges and comment may only grow (the Cargo rebuild logs its table
 *        (re)creation), and every source log entry must be identical in the target;
 *      - everything else must be equal: table counts, pages per namespace, maximum IDs, the file lists with
 *        SHA-1, size and timestamp, the page map, every archived revision with its text, the collation
 *        table, the stored order of every category's members (German collation), and the categorylinks
 *        timestamps of rows both sides share. The target's categorylinks must all use the configured
 *        collation and store cl_timestamp as INTEGER (TS_MW), as MediaWiki-on-SQLite does.
 *      Cargo row counts and contents are compared per page by render.php --compare ("review" class).
 */

use MediaWiki\Maintenance\Maintenance;
use Wikimedia\Rdbms\IDatabase;
use Wikimedia\Rdbms\IReadableDatabase;
use Wikimedia\Timestamp\ConvertibleTimestamp;

require_once ( getenv( 'MW_INSTALL_PATH' ) ?: '/var/www/html' ) . '/maintenance/Maintenance.php';

class WesternisCounts extends Maintenance {
	/** Rebuilt indexes, caches and bookkeeping: reported, never compared */
	private const INFO_TABLES = [ 'searchindex', 'objectcache', 'l10n_cache', 'job', 'querycache', 'querycachetwo',
		'querycache_info', 'updatelog', 'site_stats', 'cargo_backlinks' ];
	/** Rebuilt from the parse (refreshLinks, Cargo): counts reported, content compared per page by render.php */
	private const DERIVED_TABLES = [ 'pagelinks', 'templatelinks', 'categorylinks', 'imagelinks', 'existencelinks',
		'externallinks', 'iwlinks', 'langlinks', 'page_props', 'category', 'linktarget', 'cargo_pages' ];
	/** May only grow during the rebuild (Cargo writes a log entry, an RC row and a comment per table it creates) */
	private const GROW_TABLES = [ 'logging', 'log_search', 'recentchanges', 'comment' ];
	/** Maximum IDs: column => table */
	private const MAX_IDS = [
		'page_id' => 'page', 'rev_id' => 'revision', 'ar_id' => 'archive', 'ar_rev_id' => 'archive',
		'old_id' => 'text', 'content_id' => 'content', 'actor_id' => 'actor', 'user_id' => 'user',
		'comment_id' => 'comment', 'log_id' => 'logging', 'rc_id' => 'recentchanges',
	];
	private const GROW_MAX = [ 'comment_id', 'log_id', 'rc_id' ];
	/** Link tables in MW 1.46 (normalised through linktarget): key in "links" => [table, from column, target column] */
	private const LINK_TABLES = [
		'pl' => [ 'pagelinks', 'pl_from', 'pl_target_id' ],
		'tl' => [ 'templatelinks', 'tl_from', 'tl_target_id' ],
		'il' => [ 'imagelinks', 'il_from', 'il_target_id' ],
		'exl' => [ 'existencelinks', 'exl_from', 'exl_target_id' ],
	];
	private const BATCH = 500;
	/** At most this many lines per kind of mismatch in the report */
	private const MAX_LINES = 25;

	public function __construct() {
		parent::__construct();
		$this->addDescription( 'Write JSON counts and content fingerprints of the wiki database, or compare two count files' );
		$this->addOption( 'out', 'Write the JSON result to this file (default: stdout)', false, true );
		$this->addOption( 'compare', 'Compare --source with --target instead of counting' );
		$this->addOption( 'source', 'Source counts file (compare mode)', false, true );
		$this->addOption( 'target', 'Target counts file (compare mode)', false, true );
	}

	public function execute() {
		if ( $this->hasOption( 'compare' ) ) {
			$this->compareFiles();
			return;
		}
		$this->writeJson( $this->collect() );
	}

	// ------------------------------------------------------------------------------------------------ counting

	private function collect(): array {
		$db = $this->getDB( DB_REPLICA );
		$tables = [];
		foreach ( $db->listTables( null, __METHOD__ ) as $t ) {
			// Cargo data tables are counted through Cargo's own connection (own file on SQLite);
			// searchindex_* are the FTS3 shadow tables of the SQLite search index.
			if ( str_starts_with( $t, 'cargo__' ) || str_starts_with( $t, 'searchindex_' ) ) {
				continue;
			}
			$tables[$t] = $this->countRows( $db, $t );
		}
		ksort( $tables );

		$namespaces = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'ns' => 'page_namespace', 'n' => 'COUNT(*)' ] )
			->from( 'page' )
			->groupBy( 'page_namespace' )
			->orderBy( 'page_namespace' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$namespaces[(string)(int)$row->ns] = (int)$row->n;
		}

		$max = [];
		foreach ( self::MAX_IDS as $col => $t ) {
			$v = isset( $tables[$t] )
				? $db->newSelectQueryBuilder()->select( "MAX($col)" )->from( $t )->caller( __METHOD__ )->fetchField()
				: null;
			$max[$col] = ( $v === null || $v === false ) ? null : (int)$v;
		}

		$siteStats = [];
		if ( isset( $tables['site_stats'] ) ) {
			$row = $db->newSelectQueryBuilder()->select( '*' )->from( 'site_stats' )->caller( __METHOD__ )->fetchRow();
			foreach ( (array)( $row ?: [] ) as $k => $v ) {
				$siteStats[$k] = $v === null ? null : (int)$v;
			}
		}

		$images = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'img_name', 'img_sha1', 'img_size', 'img_timestamp' ] )
			->from( 'image' )
			->orderBy( 'img_name' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$images[(string)$row->img_name] = [
				'sha1' => (string)$row->img_sha1,
				'size' => (int)$row->img_size,
				'timestamp' => (string)$row->img_timestamp,
			];
		}

		$oldimages = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'oi_name', 'oi_archive_name', 'oi_sha1', 'oi_size', 'oi_timestamp' ] )
			->from( 'oldimage' )
			->orderBy( 'oi_archive_name' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$oldimages[(string)$row->oi_archive_name] = [
				'name' => (string)$row->oi_name,
				'sha1' => (string)$row->oi_sha1,
				'size' => (int)$row->oi_size,
				'timestamp' => (string)$row->oi_timestamp,
			];
		}

		$filearchive = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'fa_id', 'fa_name', 'fa_storage_group', 'fa_storage_key', 'fa_sha1', 'fa_size' ] )
			->from( 'filearchive' )
			->orderBy( 'fa_id' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$filearchive[(string)(int)$row->fa_id] = [
				'name' => (string)$row->fa_name,
				'group' => (string)$row->fa_storage_group,
				'key' => (string)$row->fa_storage_key,
				'sha1' => (string)$row->fa_sha1,
				'size' => (int)$row->fa_size,
			];
		}

		$logs = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'log_id', 'log_type', 'log_action', 'log_timestamp' ] )
			->from( 'logging' )
			->orderBy( 'log_id' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$logs[] = [ (int)$row->log_id, (string)$row->log_type, (string)$row->log_action, (string)$row->log_timestamp ];
		}

		return [
			'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'dbType' => $db->getType(),
			'mediawiki' => MW_VERSION,
			'tables' => $tables,
			// (object): numeric keys must stay a JSON object even when they happen to be 0..n
			'namespaces' => (object)$namespaces,
			'max' => $max,
			'siteStats' => $siteStats,
			'cargo' => $this->cargoCounts( $db, isset( $tables['cargo_tables'] ) ),
			'images' => (object)$images,
			'oldimages' => (object)$oldimages,
			'filearchive' => (object)$filearchive,
			'logs' => $logs,
			'content' => $this->content( $db, $tables ),
		];
	}

	/** Rows per Cargo table: "all" = every physical cargo__* table, "tables" = the declared main tables. */
	private function cargoCounts( IReadableDatabase $db, bool $haveCargoTables ): array {
		$out = [ 'tables' => [], 'all' => [] ];
		if ( !class_exists( \CargoUtils::class ) ) {
			return $out;
		}
		$cdb = \CargoUtils::getDB();
		foreach ( $this->cargoTableNames( $cdb ) as $t ) {
			// Raw SQL: the Cargo connection prefixes table names with cargo__ itself.
			$res = $cdb->query( 'SELECT COUNT(*) AS n FROM ' . $cdb->addIdentifierQuotes( $t ),
				__METHOD__, IDatabase::QUERY_CHANGE_NONE );
			$out['all'][$t] = (int)$res->fetchObject()->n;
		}
		ksort( $out['all'] );
		if ( $haveCargoTables ) {
			$main = $db->newSelectQueryBuilder()->select( 'main_table' )->from( 'cargo_tables' )
				->caller( __METHOD__ )->fetchFieldValues();
			foreach ( $main as $t ) {
				$out['tables'][(string)$t] = $out['all']['cargo__' . $t] ?? null;
			}
			ksort( $out['tables'] );
		}
		return $out;
	}

	/** @return string[] physical cargo__* tables (never the __NEXT replacement tables of a running rebuild) */
	private function cargoTableNames( IDatabase $cdb ): array {
		$out = [];
		foreach ( $cdb->listTables( 'cargo__', __METHOD__ ) as $t ) {
			if ( str_starts_with( $t, 'cargo__' ) && !str_ends_with( $t, '__NEXT' ) ) {
				$out[] = $t;
			}
		}
		sort( $out );
		return $out;
	}

	private function countRows( IReadableDatabase $db, string $t ): int {
		return (int)$db->newSelectQueryBuilder()->select( 'COUNT(*)' )->from( $t )->caller( __METHOD__ )->fetchField();
	}

	// --------------------------------------------------------------------------------- content fingerprints

	private function content( IReadableDatabase $db, array $tables ): array {
		$has = static fn ( string $t ): bool => array_key_exists( $t, $tables );
		$out = [
			'pages' => (object)$this->pageMap( $db ),
			'archive' => (object)( $has( 'archive' ) ? $this->archiveMap( $db ) : [] ),
			'collation' => (object)[],
			'collationUse' => (object)[],
			'configuredCollation' => (string)$this->getConfig()->get( 'CategoryCollation' ),
			'categories' => (object)[],
			'links' => (object)$this->linkMap( $db, $has ),
			'cargo' => (object)$this->cargoRows(),
			'checks' => [],
		];
		if ( $has( 'collation' ) ) {
			$coll = [];
			$res = $db->newSelectQueryBuilder()->select( [ 'collation_id', 'collation_name' ] )->from( 'collation' )
				->orderBy( 'collation_id' )->caller( __METHOD__ )->fetchResultSet();
			foreach ( $res as $row ) {
				$coll[(string)(int)$row->collation_id] = (string)$row->collation_name;
			}
			$out['collation'] = (object)$coll;
		}
		if ( $has( 'categorylinks' ) && $has( 'linktarget' ) ) {
			[ $out['categories'], $out['collationUse'] ] = $this->categoryMap( $db, $has( 'collation' ) );
			if ( $db->getType() === 'sqlite' ) {
				// MediaWiki-on-SQLite writes TS_MW into a NUMERIC-affinity column, i.e. an INTEGER
				$out['checks']['clTimestampNotInteger'] = (int)$db->newSelectQueryBuilder()
					->select( 'COUNT(*)' )->from( 'categorylinks' )
					->where( "typeof(cl_timestamp) <> 'integer'" )
					->caller( __METHOD__ )->fetchField();
			}
		}
		$out['checks'] = (object)$out['checks'];
		return $out;
	}

	/** page_id -> [ns, title, latest, len, redirect, model, lang] */
	private function pageMap( IReadableDatabase $db ): array {
		$out = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'page_id', 'page_namespace', 'page_title', 'page_latest', 'page_len', 'page_is_redirect',
				'page_content_model', 'page_lang' ] )
			->from( 'page' )
			->orderBy( 'page_id' )
			->caller( __METHOD__ )
			->fetchResultSet();
		foreach ( $res as $row ) {
			$out[(string)(int)$row->page_id] = [
				(int)$row->page_namespace, (string)$row->page_title, (int)$row->page_latest, (int)$row->page_len,
				(int)$row->page_is_redirect, $row->page_content_model === null ? null : (string)$row->page_content_model,
				$row->page_lang === null ? null : (string)$row->page_lang,
			];
		}
		return $out;
	}

	/**
	 * Every archived (deleted) revision with its slots, content rows and the raw text rows behind them.
	 * dumpBackup --full covers only live revisions; this is the content check for the deleted ones.
	 */
	private function archiveMap( IReadableDatabase $db ): array {
		$out = [];
		$res = $db->newSelectQueryBuilder()
			->select( [ 'ar_id', 'ar_rev_id', 'ar_namespace', 'ar_title', 'ar_timestamp', 'ar_actor', 'ar_comment_id',
				'ar_minor_edit', 'ar_deleted', 'ar_len', 'ar_page_id', 'ar_parent_id' ] )
			->from( 'archive' )
			->orderBy( 'ar_id' )
			->caller( __METHOD__ )
			->fetchResultSet();
		$byRev = [];
		foreach ( $res as $row ) {
			$id = (string)(int)$row->ar_id;
			$out[$id] = [
				'rev' => (int)$row->ar_rev_id,
				'ns' => (int)$row->ar_namespace,
				'title' => (string)$row->ar_title,
				'timestamp' => (string)$row->ar_timestamp,
				'actor' => (int)$row->ar_actor,
				'comment' => (int)$row->ar_comment_id,
				'minor' => (int)$row->ar_minor_edit,
				'deleted' => (int)$row->ar_deleted,
				'len' => $row->ar_len === null ? null : (int)$row->ar_len,
				'page' => $row->ar_page_id === null ? null : (int)$row->ar_page_id,
				'parent' => $row->ar_parent_id === null ? null : (int)$row->ar_parent_id,
				'slots' => [],
			];
			$byRev[(int)$row->ar_rev_id][] = $id;
		}
		foreach ( array_chunk( array_keys( $byRev ), self::BATCH ) as $revs ) {
			$slots = $db->newSelectQueryBuilder()
				->select( [ 'slot_revision_id', 'slot_origin', 'role_name', 'model_name', 'content_size', 'content_sha1',
					'content_address' ] )
				->from( 'slots' )
				->join( 'slot_roles', null, 'role_id = slot_role_id' )
				->join( 'content', null, 'content_id = slot_content_id' )
				->join( 'content_models', null, 'model_id = content_model' )
				->where( [ 'slot_revision_id' => $revs ] )
				->orderBy( [ 'slot_revision_id', 'role_name' ] )
				->caller( __METHOD__ )
				->fetchResultSet();
			$rows = [];
			$textIds = [];
			foreach ( $slots as $s ) {
				$rows[] = $s;
				if ( preg_match( '/^tt:(\d+)$/', (string)$s->content_address, $m ) ) {
					$textIds[] = (int)$m[1];
				}
			}
			$texts = [];
			foreach ( array_chunk( array_values( array_unique( $textIds ) ), self::BATCH ) as $ids ) {
				$tr = $db->newSelectQueryBuilder()->select( [ 'old_id', 'old_text', 'old_flags' ] )->from( 'text' )
					->where( [ 'old_id' => $ids ] )->caller( __METHOD__ )->fetchResultSet();
				foreach ( $tr as $t ) {
					$texts[(int)$t->old_id] = [ (string)$t->old_text, (string)$t->old_flags ];
				}
			}
			foreach ( $rows as $s ) {
				$addr = (string)$s->content_address;
				$text = null;
				if ( preg_match( '/^tt:(\d+)$/', $addr, $m ) ) {
					$text = $texts[(int)$m[1]] ?? false;
				}
				$check = 'not-a-text-row';
				$textSha1 = null;
				$flags = null;
				if ( $text === false ) {
					$check = 'text-row-missing';
				} elseif ( is_array( $text ) ) {
					[ $raw, $flags ] = $text;
					$textSha1 = sha1( $raw );
					$plain = array_diff( explode( ',', $flags ), [ '', 'utf-8' ] ) === [];
					if ( !$plain ) {
						$check = 'not-plain-text';
					} else {
						$b36 = \Wikimedia\base_convert( sha1( $raw ), 16, 36, 31 );
						$check = ( $b36 === (string)$s->content_sha1 && strlen( $raw ) === (int)$s->content_size ) ? 'ok' : 'mismatch';
					}
				}
				foreach ( $byRev[(int)$s->slot_revision_id] ?? [] as $arId ) {
					$out[$arId]['slots'][] = [
						'role' => (string)$s->role_name,
						'model' => (string)$s->model_name,
						'size' => (int)$s->content_size,
						'sha1' => (string)$s->content_sha1,
						'address' => $addr,
						'origin' => (int)$s->slot_origin,
						'textSha1' => $textSha1,
						'flags' => $flags,
						'textCheck' => $check,
					];
				}
			}
		}
		return $out;
	}

	/**
	 * categorylinks per category and type in stored sort order (cl_sortkey, cl_from), as category pages and
	 * the API list them, plus the rows per collation name.
	 * @return array{0:object,1:object}
	 */
	private function categoryMap( IReadableDatabase $db, bool $haveCollation ): array {
		$qb = $db->newSelectQueryBuilder()
			->select( [ 'cl_from', 'lt_title', 'cl_type', 'cl_sortkey', 'cl_sortkey_prefix', 'cl_timestamp', 'cl_collation_id' ] )
			->from( 'categorylinks' )
			->join( 'linktarget', null, 'lt_id = cl_target_id' )
			// = the cl_sortkey_id index (cl_target_id, cl_type, cl_sortkey, cl_from) that MediaWiki reads in
			->orderBy( [ 'cl_target_id', 'cl_type', 'cl_sortkey', 'cl_from' ] )
			->caller( __METHOD__ );
		$names = [];
		if ( $haveCollation ) {
			$res = $db->newSelectQueryBuilder()->select( [ 'collation_id', 'collation_name' ] )->from( 'collation' )
				->caller( __METHOD__ )->fetchResultSet();
			foreach ( $res as $row ) {
				$names[(int)$row->collation_id] = (string)$row->collation_name;
			}
		}
		$cats = [];
		$use = [];
		foreach ( $qb->fetchResultSet() as $row ) {
			$cat = (string)$row->lt_title;
			$type = (string)$row->cl_type;
			$cid = (int)$row->cl_collation_id;
			$cname = $names[$cid] ?? "(id $cid)";
			$use[$cname] = ( $use[$cname] ?? 0 ) + 1;
			$cats[$cat][$type][] = [
				(int)$row->cl_from,
				(string)$row->cl_sortkey_prefix,
				self::mwTimestamp( $row->cl_timestamp ),
				substr( sha1( (string)$row->cl_sortkey ), 0, 16 ),
			];
		}
		ksort( $cats, SORT_STRING );
		ksort( $use, SORT_STRING );
		return [ (object)$cats, (object)$use ];
	}

	/** Any MediaWiki/MariaDB timestamp form -> TS_MW ('YYYYMMDDHHMMSS'); unparsable values stay as they are, marked. */
	private static function mwTimestamp( $v ): ?string {
		if ( $v === null ) {
			return null;
		}
		$ts = ConvertibleTimestamp::convert( TS_MW, (string)$v );
		return $ts === false ? 'unparsable:' . (string)$v : (string)$ts;
	}

	/**
	 * Per page: the stored link sets ("ns:dbkey", sorted) and page_props (name -> first 16 hex of the value's sha1).
	 * @param callable(string):bool $has
	 */
	private function linkMap( IReadableDatabase $db, callable $has ): array {
		$out = [];
		if ( !$has( 'linktarget' ) ) {
			return $out;
		}
		foreach ( self::LINK_TABLES as $key => [ $table, $from, $target ] ) {
			if ( !$has( $table ) ) {
				continue;
			}
			$res = $db->newSelectQueryBuilder()
				->select( [ 'f' => $from, 'ns' => 'lt_namespace', 't' => 'lt_title' ] )
				->from( $table )
				->join( 'linktarget', null, "lt_id = $target" )
				->caller( __METHOD__ )
				->fetchResultSet();
			foreach ( $res as $row ) {
				$out[(string)(int)$row->f][$key][] = (int)$row->ns . ':' . (string)$row->t;
			}
		}
		if ( $has( 'page_props' ) ) {
			$res = $db->newSelectQueryBuilder()->select( [ 'pp_page', 'pp_propname', 'pp_value' ] )->from( 'page_props' )
				->caller( __METHOD__ )->fetchResultSet();
			foreach ( $res as $row ) {
				$out[(string)(int)$row->pp_page]['pp'][(string)$row->pp_propname] = substr( sha1( (string)$row->pp_value ), 0, 16 );
			}
		}
		foreach ( $out as &$kinds ) {
			foreach ( $kinds as $k => &$list ) {
				if ( $k === 'pp' ) {
					ksort( $list, SORT_STRING );
				} else {
					sort( $list, SORT_STRING );
				}
			}
			unset( $list );
			ksort( $kinds );
		}
		unset( $kinds );
		ksort( $out, SORT_NUMERIC );
		return $out;
	}

	/**
	 * Cargo rows per table and page, normalised so MariaDB and SQLite values compare: _ID and _rowID (assigned
	 * anew by every rebuild) are left out, field tables (_rowID) are joined to their page through the main
	 * table, numbers with a fraction or exponent are printed with 12 significant digits.
	 * @return array<string,array<string,list<array<string,?string>>>> table -> page id -> rows
	 */
	private function cargoRows(): array {
		if ( !class_exists( \CargoUtils::class ) ) {
			return [];
		}
		$cdb = \CargoUtils::getDB();
		$tables = $this->cargoTableNames( $cdb );
		$cols = [];
		foreach ( $tables as $t ) {
			$cols[$t] = $this->columnsOf( $cdb, $t );
		}
		$out = [];
		foreach ( $tables as $t ) {
			$c = $cols[$t];
			$q = static fn ( string $x ): string => $cdb->addIdentifierQuotes( $x );
			if ( in_array( '_pageID', $c, true ) ) {
				// main table (has _ID) or _files table (no _ID): keyed by its own _pageID
				$sel = array_values( array_diff( $c, [ '_ID' ] ) );
				$sql = 'SELECT ' . implode( ', ', array_map( $q, $sel ) ) . ' FROM ' . $q( $t );
				$pageCol = '_pageID';
			} elseif ( in_array( '_rowID', $c, true ) && preg_match( '/^(cargo__[^_].*?)__[^_]/', $t, $m )
				&& isset( $cols[$m[1]] ) && in_array( '_ID', $cols[$m[1]], true ) && in_array( '_pageID', $cols[$m[1]], true )
			) {
				// field table of a list field: page through the main table
				$sel = array_values( array_diff( $c, [ '_rowID' ] ) );
				$sql = 'SELECT m._pageID AS ' . $q( '__page' ) . ', '
					. implode( ', ', array_map( static fn ( $x ) => 'f.' . $q( $x ), $sel ) )
					. ' FROM ' . $q( $t ) . ' f JOIN ' . $q( $m[1] ) . ' m ON m._ID = f._rowID';
				$pageCol = '__page';
			} else {
				$out[$t] = [ '?' => [ [ '_unknownLayout' => implode( ',', $c ) ] ] ];
				continue;
			}
			$rows = [];
			foreach ( $cdb->query( $sql, __METHOD__, IDatabase::QUERY_CHANGE_NONE ) as $row ) {
				$r = (array)$row;
				$page = (string)(int)$r[$pageCol];
				unset( $r[$pageCol] );
				$norm = [];
				foreach ( $r as $k => $v ) {
					$norm[(string)$k] = self::normValue( $v );
				}
				ksort( $norm, SORT_STRING );
				$rows[$page][] = $norm;
			}
			foreach ( $rows as &$list ) {
				usort( $list, static fn ( $a, $b ) => strcmp( serialize( $a ), serialize( $b ) ) );
			}
			unset( $list );
			ksort( $rows, SORT_NUMERIC );
			$out[$t] = $rows;
		}
		return $out;
	}

	/** Column names of a table on either backend. @return string[] */
	private function columnsOf( IDatabase $db, string $t ): array {
		$names = [];
		if ( $db->getType() === 'sqlite' ) {
			foreach ( $db->query( 'SELECT name FROM pragma_table_info(' . $db->addQuotes( $t ) . ')', __METHOD__,
				IDatabase::QUERY_CHANGE_NONE ) as $row ) {
				$names[] = (string)$row->name;
			}
		} else {
			foreach ( $db->query( 'SHOW COLUMNS FROM ' . $db->addIdentifierQuotes( $t ), __METHOD__,
				IDatabase::QUERY_CHANGE_NONE ) as $row ) {
				$names[] = (string)$row->Field;
			}
		}
		return $names;
	}

	/** null stays null; "3.50" / "3.5" / "3.5e0" -> "3.5"; integers and text stay byte-identical. */
	private static function normValue( $v ): ?string {
		if ( $v === null ) {
			return null;
		}
		$s = (string)$v;
		if ( preg_match( '/^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d+)$/', $s ) ) {
			return sprintf( '%.12G', (float)$s );
		}
		return $s;
	}

	// ----------------------------------------------------------------------------------------------- comparing

	private function compareFiles(): void {
		$s = $this->readJson( (string)$this->getOption( 'source' ) );
		$t = $this->readJson( (string)$this->getOption( 'target' ) );
		$bad = [];
		$notes = [];

		foreach ( $s['tables'] ?? [] as $name => $n ) {
			$m = $t['tables'][$name] ?? null;
			if ( in_array( $name, self::INFO_TABLES, true ) ) {
				$notes[] = "$name: source $n, target " . ( $m ?? '-' ) . ' (rebuilt, not compared)';
			} elseif ( in_array( $name, self::DERIVED_TABLES, true ) ) {
				if ( $m !== $n ) {
					$notes[] = "$name: source $n, target " . ( $m ?? '-' ) . ' (rebuilt from the parse; content compared per page in render-check.json)';
				}
			} elseif ( $m === null ) {
				$bad[] = "table $name: missing in the target";
			} elseif ( in_array( $name, self::GROW_TABLES, true ) ? $m < $n : $m !== $n ) {
				$bad[] = "table $name: source $n rows, target $m rows";
			} elseif ( $m !== $n ) {
				$notes[] = "$name: source $n, target $m (may grow)";
			}
		}
		foreach ( $t['tables'] ?? [] as $name => $m ) {
			if ( !array_key_exists( $name, $s['tables'] ?? [] ) ) {
				$notes[] = "$name: only in the target ($m rows)";
			}
		}

		$this->compareMaps( 'pages in namespace', $s['namespaces'] ?? [], $t['namespaces'] ?? [], $bad );

		foreach ( $s['max'] ?? [] as $col => $v ) {
			$w = $t['max'][$col] ?? null;
			$grow = in_array( $col, self::GROW_MAX, true );
			if ( $grow ? ( $v !== null && ( $w === null || $w < $v ) ) : $w !== $v ) {
				$bad[] = "MAX($col): source " . json_encode( $v ) . ', target ' . json_encode( $w );
			}
		}

		// Cargo: counts are notes here; render.php --compare checks the rows per page ("review" class)
		foreach ( $s['cargo']['all'] ?? [] as $table => $n ) {
			$m = $t['cargo']['all'][$table] ?? null;
			if ( $m !== $n ) {
				$notes[] = "Cargo table $table: source $n rows, target " . json_encode( $m ) . ' (see render-check.json)';
			}
		}
		$this->compareMaps( 'image', $s['images'] ?? [], $t['images'] ?? [], $bad );
		$this->compareMaps( 'oldimage', $s['oldimages'] ?? [], $t['oldimages'] ?? [], $bad );
		$this->compareMaps( 'filearchive', $s['filearchive'] ?? [], $t['filearchive'] ?? [], $bad );

		$targetLogs = [];
		foreach ( $t['logs'] ?? [] as $e ) {
			$targetLogs[$e[0]] = $e;
		}
		$logDiffs = 0;
		foreach ( $s['logs'] ?? [] as $e ) {
			if ( ( $targetLogs[$e[0]] ?? null ) !== $e ) {
				if ( ++$logDiffs <= 20 ) {
					$bad[] = "log entry {$e[0]}: source " . json_encode( $e ) . ', target ' . json_encode( $targetLogs[$e[0]] ?? null );
				}
			}
		}
		if ( $logDiffs > 20 ) {
			$bad[] = ( $logDiffs - 20 ) . ' more log entries differ';
		}
		$added = count( $t['logs'] ?? [] ) - count( $s['logs'] ?? [] );
		if ( $added > 0 ) {
			$notes[] = "logging: $added entries added in the target (Cargo table creation during the rebuild)";
		}

		foreach ( $s['siteStats'] ?? [] as $k => $v ) {
			$notes[] = "site_stats.$k: source " . json_encode( $v ) . ', target ' . json_encode( $t['siteStats'][$k] ?? null )
				. ' (initSiteStats recounts)';
		}

		$this->compareContent( $s['content'] ?? null, $t['content'] ?? null, $bad, $notes );

		$result = [
			'ok' => !$bad,
			'checkedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'source' => [ 'dbType' => $s['dbType'] ?? null, 'generatedAt' => $s['generatedAt'] ?? null ],
			'target' => [ 'dbType' => $t['dbType'] ?? null, 'generatedAt' => $t['generatedAt'] ?? null ],
			'mismatches' => $bad,
			'notes' => $notes,
		];
		$this->writeJson( $result );
		foreach ( $bad as $line ) {
			$this->error( "MISMATCH $line" );
		}
		if ( $bad ) {
			$this->fatalError( count( $bad ) . ' count/content mismatch(es) between the MariaDB source and the SQLite target.' );
		}
		$this->output( "Counts and content: source and target agree.\n" );
	}

	/** The strict content checks (see the header). */
	private function compareContent( ?array $s, ?array $t, array &$bad, array &$notes ): void {
		if ( $s === null || $t === null ) {
			$bad[] = 'content fingerprints missing in ' . ( $s === null ? 'the source' : 'the target' ) . ' counts';
			return;
		}
		$add = static function ( array &$list, string $what, array $lines ): void {
			foreach ( array_slice( $lines, 0, self::MAX_LINES ) as $l ) {
				$list[] = "$what: $l";
			}
			if ( count( $lines ) > self::MAX_LINES ) {
				$list[] = "$what: " . ( count( $lines ) - self::MAX_LINES ) . ' more';
			}
		};

		// pages and archived revisions: exact
		$add( $bad, 'page', $this->mapDiff( $s['pages'] ?? [], $t['pages'] ?? [] ) );
		$add( $bad, 'archived revision', $this->mapDiff( $s['archive'] ?? [], $t['archive'] ?? [] ) );
		$textProblems = [];
		foreach ( $t['archive'] ?? [] as $arId => $a ) {
			foreach ( $a['slots'] ?? [] as $slot ) {
				if ( !in_array( $slot['textCheck'], [ 'ok', 'not-plain-text', 'not-a-text-row' ], true ) ) {
					$textProblems[] = "ar_id $arId (rev {$a['rev']}, {$slot['role']}): {$slot['textCheck']}";
				}
			}
			if ( !( $a['slots'] ?? [] ) ) {
				$textProblems[] = "ar_id $arId (rev {$a['rev']}): no slot/content rows";
			}
		}
		// The copy is exact (map above); text problems the source already had are reported, not blamed on the copy.
		$add( $notes, 'archived revision text (also in the source)', $textProblems );

		// collation
		$add( $bad, 'collation table', $this->mapDiff( $s['collation'] ?? [], $t['collation'] ?? [] ) );
		$want = (string)( $t['configuredCollation'] ?? '' );
		$use = $t['collationUse'] ?? [];
		$other = array_diff( array_keys( $use ), [ $want ] );
		if ( $want === '' ) {
			$bad[] = 'categorylinks: the target reports no configured collation';
		} elseif ( $other ) {
			$bad[] = "categorylinks: the target has rows sorted with another collation than $want: "
				. implode( ', ', array_map( static fn ( $k ) => "$k ({$use[$k]})", $other ) ) . ' (updateCollation --force?)';
		}
		if ( ( $s['configuredCollation'] ?? null ) !== $want ) {
			$notes[] = 'configured collation: source ' . json_encode( $s['configuredCollation'] ?? null ) . ", target $want";
		}
		$notInt = $t['checks']['clTimestampNotInteger'] ?? null;
		if ( $notInt === null ) {
			$bad[] = 'categorylinks: the target counts have no cl_timestamp type check';
		} elseif ( $notInt > 0 ) {
			$bad[] = "categorylinks: $notInt cl_timestamp value(s) are not stored as INTEGER (TS_MW) in SQLite";
		}

		// categories: order of shared members, timestamps of shared rows, sort key bytes
		$orderBad = [];
		$tsBad = [];
		$keyDiff = 0;
		$membership = 0;
		foreach ( $s['categories'] ?? [] as $cat => $types ) {
			foreach ( $types as $type => $srcRows ) {
				$tgtRows = $t['categories'][$cat][$type] ?? [];
				$srcBy = [];
				foreach ( $srcRows as $r ) {
					$srcBy[$r[0]] = $r;
				}
				$tgtBy = [];
				foreach ( $tgtRows as $r ) {
					$tgtBy[$r[0]] = $r;
				}
				$common = array_intersect_key( $srcBy, $tgtBy );
				$membership += count( $srcBy ) + count( $tgtBy ) - 2 * count( $common );
				$so = array_values( array_filter( array_column( $srcRows, 0 ), static fn ( $id ) => isset( $common[$id] ) ) );
				$to = array_values( array_filter( array_column( $tgtRows, 0 ), static fn ( $id ) => isset( $common[$id] ) ) );
				if ( $so !== $to ) {
					$orderBad[] = "$cat ($type): source order " . json_encode( array_slice( $so, 0, 12 ) )
						. ', target order ' . json_encode( array_slice( $to, 0, 12 ) );
				}
				foreach ( $common as $id => $sr ) {
					$tr = $tgtBy[$id];
					// Same sort key prefix = the row survived refreshLinks: its timestamp must have been copied exactly
					if ( $sr[1] === $tr[1] && $sr[2] !== $tr[2] ) {
						$tsBad[] = "$cat ($type) page $id: source {$sr[2]}, target {$tr[2]}";
					}
					if ( $sr[3] !== $tr[3] ) {
						$keyDiff++;
					}
				}
			}
		}
		$add( $bad, 'category order (German collation, members both sides have)', $orderBad );
		$add( $bad, 'categorylinks timestamp', $tsBad );
		if ( $keyDiff ) {
			$notes[] = "categorylinks: $keyDiff shared row(s) have other sort key bytes (another ICU version?); their order is the same";
		}
		if ( $membership ) {
			$notes[] = "categorylinks: $membership membership(s) differ between source and target (render-check.json explains them per page)";
		}
	}

	/** Lines describing the differences of two id-keyed maps (values compared strictly after JSON decoding). */
	private function mapDiff( array $a, array $b ): array {
		$lines = [];
		foreach ( $a as $k => $v ) {
			if ( !array_key_exists( $k, $b ) ) {
				$lines[] = "$k missing in the target";
			} elseif ( $b[$k] !== $v ) {
				$lines[] = "$k: source " . $this->short( $v ) . ', target ' . $this->short( $b[$k] );
			}
		}
		foreach ( $b as $k => $v ) {
			if ( !array_key_exists( $k, $a ) ) {
				$lines[] = "$k only in the target";
			}
		}
		return $lines;
	}

	private function short( $v ): string {
		$j = (string)json_encode( $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE );
		return strlen( $j ) > 300 ? substr( $j, 0, 300 ) . '…' : $j;
	}

	/** Both directions; values compared strictly (after JSON decoding). */
	private function compareMaps( string $what, array $a, array $b, array &$bad ): void {
		foreach ( $a as $k => $v ) {
			if ( !array_key_exists( $k, $b ) ) {
				$bad[] = "$what $k: missing in the target";
			} elseif ( $b[$k] !== $v ) {
				$bad[] = "$what $k: source " . json_encode( $v ) . ', target ' . json_encode( $b[$k] );
			}
		}
		foreach ( $b as $k => $v ) {
			if ( !array_key_exists( $k, $a ) ) {
				$bad[] = "$what $k: only in the target";
			}
		}
	}

	private function readJson( string $file ): array {
		$raw = $file !== '' ? @file_get_contents( $file ) : false;
		$data = $raw === false ? null : json_decode( $raw, true );
		if ( !is_array( $data ) ) {
			$this->fatalError( "Cannot read the counts file '$file'." );
		}
		return $data;
	}

	private function writeJson( array $data ): void {
		$json = json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
			| JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR ) . "\n";
		$out = $this->getOption( 'out' );
		if ( $out === null ) {
			echo $json;
		} elseif ( file_put_contents( $out, $json ) === false ) {
			$this->fatalError( "Cannot write $out" );
		}
	}
}

$maintClass = WesternisCounts::class;
require_once RUN_MAINTENANCE_IF_MAIN;
