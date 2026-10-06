<?php
/**
 * Westernis — manifest.json for the migration bundle (docs/cloudflare-design.md, section 2.9 step 9)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Plain PHP without the MediaWiki bootstrap, so the finished SQLite files are never reopened:
 *
 *   php manifest.php --bundle /out/bundle --reports /out/reports --media /out/work/tarcheck --stamp <stamp>
 *                    [--frozen 0|1] [--image <ref>] [--image-id <id>] [--schema-id <id>]
 *
 * Every check must pass before manifest.json is written into --bundle:
 *  - reports/count-check.json "ok" (counts and strict content), reports/render-check.json "ok" (no "fail"
 *    finding), reports/xml-check.json identical for pages and logs, reports/integrity.json "ok" for both
 *    databases;
 *  - the bundle holds westernis.sqlite, westernis_cargo.sqlite and images.tar.gz;
 *  - every image, oldimage and filearchive row of the target database has its file in the EXTRACTED
 *    images.tar.gz (--media) with the SHA-1 the database records:
 *      public/<a>/<ab>/<name>, public/archive/<a>/<ab>/<archive name>, deleted/<k>/<e>/<y>/<storage key>.
 *
 * manifest.json:
 *   "stamp", "frozen" (boolean, true only for Export-Bundle.ps1 -Freeze; wst-import.sh refuses anything but true
 *   unless WST_ALLOW_UNFROZEN=1), "files" (sha256 + bytes per bundle file), "source" and "target" (counts.php output without the
 *   log list and the content fingerprints; target.tables.page / target.tables.revision are what wst-r2.php
 *   verify-manifest checks), "logs" (the source's log entries for verify-cloud.mjs), "media", "copy",
 *   "checks" (counts, render: ok/reviewOk + the review findings, xml, integrity, media), and
 *   "verify": what verify-cloud.mjs compares the running cloud wiki with, all from the SQLite side:
 *     pages       page_id -> [ns, title, latest rev, len, redirect, model, lang]
 *     archive     ar_rev_id -> [sha1 hex of the revision (single-slot) or null, len, ns, title]
 *     categories  category -> type -> page ids in stored sort order
 *     cargo       Cargo table -> page id -> rows
 *     render      page_id -> [rev, {links, templates, categories, images, external}] digests of the parse
 *     reviewPages page ids with an open review finding (verify-cloud reports them as warnings)
 *   The full fingerprints and renders stay in reports/ (source-counts, target-counts, render-*.json).
 *
 * Exit codes: 0 = manifest written, 1 = a check failed (no manifest), 2 = usage error.
 */

declare( strict_types=1 );

const BUNDLE_FILES = [ 'westernis.sqlite', 'westernis_cargo.sqlite', 'images.tar.gz' ];

function say( string $msg ): void {
	fwrite( STDOUT, "[manifest] $msg\n" );
}

function usage( string $msg ): never {
	fwrite( STDERR, "[manifest] $msg\n" );
	exit( 2 );
}

function readJson( string $file ): array {
	$raw = @file_get_contents( $file );
	$data = $raw === false ? null : json_decode( $raw, true );
	if ( !is_array( $data ) ) {
		usage( "cannot read $file" );
	}
	return $data;
}

/** FileRepo::getHashPathForLevel(): md5 of the DB key, levels 2 -> "a/ab/" */
function hashPath( string $name, int $levels = 2 ): string {
	$h = md5( $name );
	$p = '';
	for ( $i = 1; $i <= $levels; $i++ ) {
		$p .= substr( $h, 0, $i ) . '/';
	}
	return $p;
}

/** FileRepo::getDeletedHashPath(): first three characters of the storage key -> "k/e/y/" */
function deletedHashPath( string $key, int $levels = 3 ): string {
	$p = '';
	for ( $i = 0; $i < $levels; $i++ ) {
		$p .= $key[$i] . '/';
	}
	return $p;
}

$opt = getopt( '', [ 'bundle:', 'reports:', 'media:', 'stamp:', 'frozen:', 'image:', 'image-id:', 'schema-id:' ] );
foreach ( [ 'bundle', 'reports', 'media', 'stamp' ] as $k ) {
	if ( !isset( $opt[$k] ) || !is_string( $opt[$k] ) || $opt[$k] === '' ) {
		usage( 'usage: manifest.php --bundle DIR --reports DIR --media DIR --stamp STAMP [--frozen 0|1] [--image REF] [--image-id ID] [--schema-id ID]' );
	}
}
$bundle = rtrim( $opt['bundle'], '/' );
$reports = rtrim( $opt['reports'], '/' );
$media = rtrim( $opt['media'], '/' );
if ( !preg_match( '/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $opt['stamp'] ) ) {
	usage( 'invalid --stamp' );
}

require_once '/var/www/html/vendor/autoload.php';   // wikimedia/base-convert (SHA-1 base 36 <-> hex)

$source = readJson( "$reports/source-counts.json" );
$target = readJson( "$reports/target-counts.json" );
$countCheck = readJson( "$reports/count-check.json" );
$xmlCheck = readJson( "$reports/xml-check.json" );
$integrity = readJson( "$reports/integrity.json" );
$copy = readJson( "$reports/copy-report.json" );
$renderCheck = readJson( "$reports/render-check.json" );
$renderTarget = readJson( "$reports/render-target.json" );
$problems = [];

// ---- earlier checks (migrate.sh aborts on them already; the manifest must never claim otherwise)
if ( ( $countCheck['ok'] ?? false ) !== true ) {
	$problems[] = 'count-check.json is not ok';
}
if ( ( $renderCheck['ok'] ?? false ) !== true ) {
	$problems[] = 'render-check.json has "fail" findings';
}
if ( ( $renderCheck['frozen'] ?? null ) !== ( ( $opt['frozen'] ?? '0' ) === '1' ) ) {
	$problems[] = 'render-check.json was made for another --frozen value';
}
foreach ( [ 'pages', 'logs' ] as $k ) {
	if ( ( $xmlCheck[$k]['identical'] ?? false ) !== true ) {
		$problems[] = "XML dump of $k differs";
	}
}
foreach ( [ 'westernis.sqlite', 'westernis_cargo.sqlite' ] as $k ) {
	if ( ( $integrity[$k] ?? '' ) !== 'ok' ) {
		$problems[] = "integrity_check of $k is not ok";
	}
}

// ---- bundle files
$files = [];
foreach ( BUNDLE_FILES as $f ) {
	$p = "$bundle/$f";
	if ( !is_file( $p ) ) {
		$problems[] = "missing bundle file $f";
		continue;
	}
	$files[$f] = [ 'sha256' => hash_file( 'sha256', $p ), 'bytes' => filesize( $p ) ];
}

// ---- media: every file the database knows must be in the archive, with the recorded SHA-1
foreach ( [ 'images', 'oldimages', 'filearchive' ] as $k ) {
	$target[$k] = is_array( $target[$k] ?? null ) ? $target[$k] : [];
}
$referenced = [];
$checkFile = static function ( string $rel, string $sha1b36, string $what ) use ( $media, &$problems, &$referenced ): ?string {
	$p = "$media/$rel";
	if ( !is_file( $p ) ) {
		$problems[] = "$what: $rel is missing from images.tar.gz";
		return null;
	}
	$referenced[$rel] = true;
	$hex = sha1_file( $p );
	$b36 = \Wikimedia\base_convert( $hex, 16, 36, 31 );
	if ( $sha1b36 !== '' && $b36 !== $sha1b36 ) {
		$problems[] = "$what: $rel has SHA-1 $b36, the database says $sha1b36";
	}
	return $hex;
};
foreach ( $target['images'] as $name => &$img ) {
	$img['path'] = 'public/' . hashPath( (string)$name ) . $name;
	$img['sha1hex'] = $checkFile( $img['path'], $img['sha1'], "image $name" );
}
unset( $img );
foreach ( $target['oldimages'] as $archiveName => &$img ) {
	$img['path'] = 'public/archive/' . hashPath( $img['name'] ) . $archiveName;
	$img['sha1hex'] = $checkFile( $img['path'], $img['sha1'], "old version $archiveName" );
}
unset( $img );
$faWithoutFile = 0;
foreach ( $target['filearchive'] as $id => &$fa ) {
	if ( $fa['key'] === '' || $fa['group'] !== 'deleted' || strlen( $fa['key'] ) < 3 ) {
		$faWithoutFile++;
		$fa['path'] = null;
		$fa['sha1hex'] = null;
		continue;
	}
	$fa['path'] = 'deleted/' . deletedHashPath( $fa['key'] ) . $fa['key'];
	$fa['sha1hex'] = $checkFile( $fa['path'], $fa['sha1'], "deleted file $id ({$fa['name']})" );
}
unset( $fa );

$all = 0;
$bytes = 0;
foreach ( [ 'public', 'deleted' ] as $zone ) {
	if ( !is_dir( "$media/$zone" ) ) {
		$problems[] = "images.tar.gz has no $zone/ folder";
		continue;
	}
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( "$media/$zone", FilesystemIterator::SKIP_DOTS ) );
	foreach ( $it as $f ) {
		if ( $f->isFile() ) {
			$all++;
			$bytes += $f->getSize();
		}
	}
}

if ( $problems ) {
	foreach ( $problems as $p ) {
		fwrite( STDERR, "[manifest] FAIL $p\n" );
	}
	file_put_contents( "$reports/manifest-problems.json",
		json_encode( $problems, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . "\n" );
	fwrite( STDERR, '[manifest] ' . count( $problems ) . " problem(s): no manifest.json written\n" );
	exit( 1 );
}

// ---- what verify-cloud.mjs compares the running cloud wiki with (all from the SQLite side)
$content = $target['content'] ?? [];
$verifyArchive = [];
foreach ( $content['archive'] ?? [] as $a ) {
	$slots = $a['slots'] ?? [];
	// RevisionRecord::getSha1() of a single-slot revision is that slot's content sha1; the API prints it in hex
	$hex = count( $slots ) === 1 && ( $slots[0]['sha1'] ?? '' ) !== ''
		? \Wikimedia\base_convert( $slots[0]['sha1'], 36, 16, 40 ) : null;
	$verifyArchive[(string)$a['rev']] = [ $hex, $a['len'] ?? null, $a['ns'], $a['title'] ];
}
$verifyCategories = [];
foreach ( $content['categories'] ?? [] as $cat => $types ) {
	foreach ( $types as $type => $rows ) {
		$verifyCategories[(string)$cat][(string)$type] = array_column( $rows, 0 );
	}
}
$verifyCargo = [];
foreach ( $content['cargo'] ?? [] as $table => $byPage ) {
	foreach ( $byPage as $pid => $rows ) {
		$verifyCargo[(string)$table][(string)$pid] = count( $rows );
	}
	$verifyCargo[(string)$table] = (object)( $verifyCargo[(string)$table] ?? [] );
}
$verifyRender = [];
foreach ( $renderTarget['pages'] ?? [] as $pid => $p ) {
	if ( ( $p['error'] ?? null ) === null && isset( $p['digests'] ) ) {
		$verifyRender[(string)$pid] = [ $p['rev'], $p['digests'] ];
	}
}
$review = $renderCheck['review'] ?? [];
$reviewPages = array_values( array_unique( array_filter( array_column( $review, 'page' ), static fn ( $p ) => $p !== null ) ) );
sort( $reviewPages );
$verify = [
	'pages' => (object)( $content['pages'] ?? [] ),
	'archive' => (object)$verifyArchive,
	'categories' => (object)$verifyCategories,
	'cargo' => (object)$verifyCargo,
	'render' => (object)$verifyRender,
	'renderSampled' => (bool)( $renderTarget['sampled'] ?? false ),
	'reviewPages' => $reviewPages,
];

$sourceLogs = $source['logs'] ?? [];
$manifest = [
	'format' => 'westernis-import-bundle',
	'formatVersion' => 2,
	'stamp' => $opt['stamp'],
	'createdAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
	// boolean; true only for a bundle exported from the frozen legacy wiki (Export-Bundle.ps1 -Freeze)
	'frozen' => ( $opt['frozen'] ?? '0' ) === '1',
	'mediawiki' => $target['mediawiki'] ?? null,
	'schemaId' => ( $opt['schema-id'] ?? '' ) !== '' ? $opt['schema-id'] : null,
	'image' => [ 'ref' => $opt['image'] ?? null, 'id' => $opt['image-id'] ?? null ],
	'files' => $files,
	'source' => array_diff_key( $source, [ 'logs' => true, 'content' => true ] ),
	'target' => array_diff_key( $target, [ 'logs' => true, 'content' => true ] ),
	'logs' => [
		'sourceCount' => count( $sourceLogs ),
		'sourceMaxId' => $source['max']['log_id'] ?? null,
		'targetCount' => count( $target['logs'] ?? [] ),
		'targetMaxId' => $target['max']['log_id'] ?? null,
		// [log_id, type, action, timestamp] of every source entry: verify-cloud.mjs checks them one by one
		'entries' => $sourceLogs,
	],
	'media' => [
		'files' => $all,
		'bytes' => $bytes,
		'referenced' => count( $referenced ),
		'unreferenced' => $all - count( $referenced ),
		'deletedRowsWithoutFile' => $faWithoutFile,
	],
	'checks' => [
		'counts' => $countCheck,
		'render' => [
			'ok' => true,
			// false = findings of the "review" class: Upload-Bundle.ps1 needs -AcceptReview
			'reviewOk' => !$review,
			'reviewCount' => count( $review ),
			'review' => array_slice( $review, 0, 100 ),
			'stats' => $renderCheck['stats'] ?? null,
			'notes' => array_slice( $renderCheck['notes'] ?? [], 0, 100 ),
			'staleInSource' => count( $renderCheck['staleInSource'] ?? [] ),
		],
		'xml' => $xmlCheck,
		'integrity' => $integrity,
		'media' => 'ok',
	],
	'copy' => $copy,
	'verify' => $verify,
];
// Maps with numeric keys stay JSON objects
foreach ( [ 'namespaces', 'images', 'oldimages', 'filearchive' ] as $k ) {
	foreach ( [ 'source', 'target' ] as $side ) {
		$manifest[$side][$k] = (object)( $manifest[$side][$k] ?? [] );
	}
}

$json = json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE );
if ( $json === false ) {
	usage( 'cannot encode manifest.json: ' . json_last_error_msg() );
}
$tmp = "$bundle/manifest.json.part";
if ( file_put_contents( $tmp, $json . "\n" ) === false || !rename( $tmp, "$bundle/manifest.json" ) ) {
	usage( "cannot write $bundle/manifest.json" );
}
foreach ( $files as $f => $info ) {
	say( sprintf( '%-24s %12d bytes  sha256 %s', $f, $info['bytes'], $info['sha256'] ) );
}
say( sprintf( 'media: %d files (%d referenced by the database, %d kept leftovers), %d bytes',
	$all, count( $referenced ), $all - count( $referenced ), $bytes ) );
say( $review
	? sprintf( 'render check: %d finding(s) to review (upload needs -AcceptReview)', count( $review ) )
	: 'render check: both sides render alike' );
say( 'manifest.json written (' . ( $manifest['frozen'] ? 'frozen' : 'not frozen: dry run' ) . ')' );
