#!/usr/bin/env php
<?php
/**
 * wst-r2.php — tiny S3 helper for the cloud boot scripts (docs/cloudflare-design.md, section 2.6)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Works on the DB bucket (R2_DB_BUCKET, EU jurisdiction endpoint https://<R2_ACCOUNT_ID>.eu.r2.cloudflarestorage.com)
 * with the DB token LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY. Credentials are never printed.
 *
 *   exists <key>                 0 = the object exists, 1 = absent
 *   exists-prefix <prefix>       0 = at least one object starts with <prefix>, 1 = none
 *   get <key> <file>             download to <file> (written atomically); 1 = absent
 *   put <key> <file> [type]      upload <file> (Content-MD5 checked by R2; multipart above 100 MiB)
 *   put-json <key> <json>        upload a small JSON document
 *   cat <key>                    print a small object (at most 64 KiB, e.g. a state marker); 1 = absent
 *   list <prefix>                print every key that starts with <prefix>, one per line (0 even when none)
 *   age <key>                    print the object's age in whole seconds; 1 = absent
 *   verify-manifest <dir> [stamp]
 *                                check the migration bundle in <dir> against <dir>/manifest.json:
 *                                sha256 (and size) of every bundle file, page/revision counts of
 *                                westernis.sqlite; 1 = mismatch
 *
 * Exit codes: 0 = yes / ok, 1 = no / absent / mismatch, 2 = usage or configuration error,
 * 3 = R2, network or I/O error. Callers must never read an exit code >= 2 as "absent".
 * "Absent" is decided only from answers that carry an S3 error body or a listing (NoSuchKey, an empty
 * ListObjectsV2), never from a bare HTTP 404, which a wrong bucket or endpoint would also produce.
 *
 * Local staging: WST_R2_LOCAL_DIR=<absolute dir> replaces the bucket with a directory (no network, no keys).
 *
 * Runs as user wstsync (`wst-as sync`): the only side of the cloud image that holds the DB-bucket token.
 */

declare( strict_types=1 );

const WST_OK = 0;
const WST_NO = 1;
const WST_USAGE = 2;
const WST_ERROR = 3;
// The wiki's composer packages (Guzzle, PSR-7) first, then the AWS SDK installed for Extension:AWS
const WST_AUTOLOADERS = [ '/var/www/html/vendor/autoload.php', '/var/www/html/extensions/AWS/vendor/autoload.php' ];
const WST_BUNDLE_FILES = [ 'westernis.sqlite', 'westernis_cargo.sqlite', 'images.tar.gz' ];

function wstSay( string $msg ): void {
	fwrite( STDERR, "[wst-r2] $msg\n" );
}

function wstFail( int $code, string $msg ): never {
	wstSay( $msg );
	exit( $code );
}

function wstEnv( string $name ): string {
	$v = getenv( $name );
	return $v === false ? '' : trim( $v );
}

/** Object keys and prefixes: relative, no "." or ".." segments, no control characters, no backslashes. */
function wstKey( string $key ): string {
	if ( $key === '' || strlen( $key ) > 512 || $key[0] === '/'
		|| preg_match( '#(^|/)\.{1,2}(/|$)#', $key ) || preg_match( '/[\x00-\x1f\x7f\\\\]/', $key )
	) {
		wstFail( WST_USAGE, 'invalid key: ' . json_encode( $key ) );
	}
	return $key;
}

/** Short, credential-free description of an exception (the SDK's messages contain no secrets). */
function wstDescribe( Throwable $e ): string {
	$parts = [ get_class( $e ) ];
	if ( $e instanceof \Aws\Exception\AwsException ) {
		$parts[] = 'HTTP ' . ( $e->getStatusCode() ?? '-' );
		$parts[] = $e->getAwsErrorCode() ?? 'no error code';
		$msg = $e->getAwsErrorMessage();
	}
	$msg = ( $msg ?? '' ) !== '' ? $msg : $e->getMessage();
	$parts[] = substr( preg_replace( '/\s+/', ' ', (string)$msg ), 0, 300 );
	return implode( ': ', $parts );
}

interface WstStore {
	/** @return array{size:int,mtime:int}|null null = absent; throws on any error */
	public function stat( string $key ): ?array;

	public function hasPrefix( string $prefix ): bool;

	/** @return string[] every key starting with $prefix, sorted; throws on any error */
	public function listKeys( string $prefix ): array;

	/** @return string|null the object's body, null = absent; throws on any error or above $max bytes */
	public function read( string $key, int $max ): ?string;

	/** @return bool false = absent; throws on any error */
	public function download( string $key, string $file ): bool;

	public function upload( string $key, string $file, string $type ): void;

	public function uploadString( string $key, string $body, string $type ): void;

	public function describe(): string;
}

final class WstS3Store implements WstStore {
	private \Aws\S3\S3Client $s3;
	private string $bucket;
	private string $account;

	public function __construct() {
		$account = wstEnv( 'R2_ACCOUNT_ID' );
		$bucket = wstEnv( 'R2_DB_BUCKET' );
		$id = wstEnv( 'LITESTREAM_ACCESS_KEY_ID' );
		$secret = wstEnv( 'LITESTREAM_SECRET_ACCESS_KEY' );
		$missing = array_keys( array_filter( [ 'R2_ACCOUNT_ID' => $account, 'R2_DB_BUCKET' => $bucket,
			'LITESTREAM_ACCESS_KEY_ID' => $id, 'LITESTREAM_SECRET_ACCESS_KEY' => $secret ],
			static fn ( $v ) => $v === '' ) );
		if ( $missing ) {
			wstFail( WST_USAGE, 'not set: ' . implode( ', ', $missing ) );
		}
		if ( !preg_match( '/^[A-Za-z0-9-]{1,63}$/', $account ) ) {
			wstFail( WST_USAGE, 'R2_ACCOUNT_ID is not a valid account ID' );
		}
		if ( !preg_match( '/^[a-z0-9][a-z0-9-]{1,62}$/', $bucket ) ) {
			wstFail( WST_USAGE, 'R2_DB_BUCKET is not a valid bucket name' );
		}
		foreach ( WST_AUTOLOADERS as $autoload ) {
			if ( !is_readable( $autoload ) ) {
				wstFail( WST_USAGE, "missing $autoload (AWS SDK not installed?)" );
			}
			require_once $autoload;
		}
		$this->bucket = $bucket;
		$this->account = $account;
		$this->s3 = new \Aws\S3\S3Client( [
			'version' => '2006-03-01',
			'region' => 'auto',
			'endpoint' => "https://$account.eu.r2.cloudflarestorage.com",
			'use_path_style_endpoint' => true,
			'credentials' => [ 'key' => $id, 'secret' => $secret ],
			'request_checksum_calculation' => 'when_required',
			'response_checksum_validation' => 'when_required',
			'retries' => [ 'mode' => 'standard', 'max_attempts' => 5 ],
			'http' => [ 'connect_timeout' => 10, 'timeout' => 600 ],
		] );
	}

	public function describe(): string {
		return "r2://$this->bucket (EU jurisdiction endpoint)";
	}

	/** The listing entry for exactly $key: the shortest key with that prefix sorts first. */
	public function stat( string $key ): ?array {
		$r = $this->s3->listObjectsV2( [ 'Bucket' => $this->bucket, 'Prefix' => $key, 'MaxKeys' => 1 ] );
		foreach ( $r['Contents'] ?? [] as $o ) {
			if ( ( $o['Key'] ?? null ) === $key ) {
				return [ 'size' => (int)$o['Size'], 'mtime' => $o['LastModified']->getTimestamp() ];
			}
		}
		return null;
	}

	public function hasPrefix( string $prefix ): bool {
		$r = $this->s3->listObjectsV2( [ 'Bucket' => $this->bucket, 'Prefix' => $prefix, 'MaxKeys' => 1 ] );
		return count( $r['Contents'] ?? [] ) > 0;
	}

	public function listKeys( string $prefix ): array {
		$keys = [];
		$token = null;
		do {
			$args = [ 'Bucket' => $this->bucket, 'Prefix' => $prefix, 'MaxKeys' => 1000 ];
			if ( $token !== null ) {
				$args['ContinuationToken'] = $token;
			}
			$r = $this->s3->listObjectsV2( $args );
			foreach ( $r['Contents'] ?? [] as $o ) {
				$keys[] = (string)$o['Key'];
			}
			$token = !empty( $r['IsTruncated'] ) ? ( $r['NextContinuationToken'] ?? null ) : null;
		} while ( $token !== null );
		sort( $keys, SORT_STRING );
		return $keys;
	}

	public function read( string $key, int $max ): ?string {
		$st = $this->stat( $key );
		if ( $st === null ) {
			return null;
		}
		if ( $st['size'] > $max ) {
			throw new RuntimeException( "$key is larger than $max bytes" );
		}
		try {
			$r = $this->s3->getObject( [ 'Bucket' => $this->bucket, 'Key' => $key ] );
		} catch ( \Aws\S3\Exception\S3Exception $e ) {
			if ( $e->getAwsErrorCode() === 'NoSuchKey' ) {
				return null;
			}
			throw $e;
		}
		return (string)$r['Body'];
	}

	public function download( string $key, string $file ): bool {
		$tmp = $file . '.part';
		@unlink( $tmp );
		try {
			$r = $this->s3->getObject( [ 'Bucket' => $this->bucket, 'Key' => $key, 'SaveAs' => $tmp ] );
		} catch ( \Aws\S3\Exception\S3Exception $e ) {
			@unlink( $tmp );
			if ( $e->getAwsErrorCode() === 'NoSuchKey' ) {
				return false;
			}
			throw $e;
		}
		clearstatcache();
		if ( isset( $r['ContentLength'] ) && filesize( $tmp ) !== (int)$r['ContentLength'] ) {
			@unlink( $tmp );
			throw new RuntimeException( "short download of $key" );
		}
		if ( !rename( $tmp, $file ) ) {
			throw new RuntimeException( "cannot move the download to $file" );
		}
		return true;
	}

	public function upload( string $key, string $file, string $type ): void {
		$size = filesize( $file );
		if ( $size === false ) {
			throw new RuntimeException( "cannot read $file" );
		}
		if ( $size > 100 * 1024 * 1024 ) {
			( new \Aws\S3\MultipartUploader( $this->s3, $file, [
				'bucket' => $this->bucket, 'key' => $key, 'part_size' => 32 * 1024 * 1024,
				'before_initiate' => static function ( \Aws\CommandInterface $cmd ) use ( $type ): void {
					$cmd['ContentType'] = $type;
				},
			] ) )->upload();
			return;
		}
		$this->s3->putObject( [ 'Bucket' => $this->bucket, 'Key' => $key, 'SourceFile' => $file,
			'ContentType' => $type, 'ContentMD5' => base64_encode( md5_file( $file, true ) ) ] );
	}

	public function uploadString( string $key, string $body, string $type ): void {
		$this->s3->putObject( [ 'Bucket' => $this->bucket, 'Key' => $key, 'Body' => $body,
			'ContentType' => $type, 'ContentMD5' => base64_encode( md5( $body, true ) ) ] );
	}
}

/** Local staging stand-in for the bucket (WST_R2_LOCAL_DIR). */
final class WstDirStore implements WstStore {
	public function __construct( private string $root ) {
		if ( $root === '' || $root[0] !== '/' || !is_dir( $root ) ) {
			wstFail( WST_USAGE, 'WST_R2_LOCAL_DIR must be an existing absolute directory' );
		}
		$this->root = rtrim( $root, '/' );
	}

	public function describe(): string {
		return "local directory $this->root (staging)";
	}

	private function path( string $key ): string {
		return "$this->root/$key";
	}

	public function stat( string $key ): ?array {
		$p = $this->path( $key );
		clearstatcache();
		if ( !file_exists( $p ) ) {
			return null;
		}
		if ( !is_file( $p ) ) {
			throw new RuntimeException( "$key is not a file" );
		}
		return [ 'size' => (int)filesize( $p ), 'mtime' => (int)filemtime( $p ) ];
	}

	public function hasPrefix( string $prefix ): bool {
		return $this->listKeys( $prefix ) !== [];
	}

	public function listKeys( string $prefix ): array {
		$keys = [];
		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $this->root, FilesystemIterator::SKIP_DOTS ) );
		foreach ( $it as $f ) {
			$key = substr( $f->getPathname(), strlen( $this->root ) + 1 );
			if ( $f->isFile() && !str_ends_with( $key, '.part' ) && str_starts_with( $key, $prefix ) ) {
				$keys[] = $key;
			}
		}
		sort( $keys, SORT_STRING );
		return $keys;
	}

	public function read( string $key, int $max ): ?string {
		$st = $this->stat( $key );
		if ( $st === null ) {
			return null;
		}
		if ( $st['size'] > $max ) {
			throw new RuntimeException( "$key is larger than $max bytes" );
		}
		$body = file_get_contents( $this->path( $key ) );
		if ( $body === false ) {
			throw new RuntimeException( "cannot read $key" );
		}
		return $body;
	}

	public function download( string $key, string $file ): bool {
		if ( $this->stat( $key ) === null ) {
			return false;
		}
		$tmp = $file . '.part';
		if ( !copy( $this->path( $key ), $tmp ) || !rename( $tmp, $file ) ) {
			@unlink( $tmp );
			throw new RuntimeException( "cannot copy $key to $file" );
		}
		return true;
	}

	public function upload( string $key, string $file, string $type ): void {
		$p = $this->path( $key );
		if ( !is_dir( dirname( $p ) ) && !mkdir( dirname( $p ), 0775, true ) ) {
			throw new RuntimeException( "cannot create the directory for $key" );
		}
		if ( !copy( $file, "$p.part" ) || !rename( "$p.part", $p ) ) {
			throw new RuntimeException( "cannot write $key" );
		}
	}

	public function uploadString( string $key, string $body, string $type ): void {
		$tmp = tempnam( sys_get_temp_dir(), 'wst-r2' );
		if ( $tmp === false || file_put_contents( $tmp, $body ) === false ) {
			throw new RuntimeException( 'cannot write a temporary file' );
		}
		try {
			$this->upload( $key, $tmp, $type );
		} finally {
			@unlink( $tmp );
		}
	}
}

// ---------------------------------------------------------------------------------------------------------
// verify-manifest
// ---------------------------------------------------------------------------------------------------------

/**
 * Expected sha256/size per file. Accepted shapes of manifest.json "files":
 *   { "<name>": { "sha256": "...", "bytes": n } }, { "<name>": "<sha256>" } or [ { "name"|"file"|"path": "...", "sha256": "...", "bytes"|"size": n } ]
 * @return array<string,array{sha256:string,bytes:?int}>
 */
function wstManifestFiles( array $m ): array {
	$out = [];
	foreach ( (array)( $m['files'] ?? [] ) as $k => $v ) {
		if ( is_string( $v ) ) {
			$name = is_string( $k ) ? $k : null;
			$v = [ 'sha256' => $v ];
		} elseif ( is_array( $v ) ) {
			$name = is_string( $k ) ? $k : ( $v['name'] ?? $v['file'] ?? $v['path'] ?? null );
		} else {
			continue;
		}
		$sha = strtolower( (string)( $v['sha256'] ?? '' ) );
		if ( !is_string( $name ) || !preg_match( '/^[0-9a-f]{64}$/', $sha ) ) {
			continue;
		}
		$bytes = $v['bytes'] ?? $v['size'] ?? null;
		$out[basename( $name )] = [ 'sha256' => $sha, 'bytes' => is_numeric( $bytes ) ? (int)$bytes : null ];
	}
	return $out;
}

/** page/revision counts of the SQLite side, looked up in the places counts.php/manifest.php may put them. */
function wstManifestCounts( array $m ): ?array {
	$candidates = [
		[ 'target', 'tables' ], [ 'target' ], [ 'counts', 'target', 'tables' ], [ 'counts', 'target' ],
		[ 'targetCounts', 'tables' ], [ 'targetCounts' ], [ 'target_counts', 'tables' ], [ 'target_counts' ],
		[ 'counts', 'tables' ], [ 'counts' ], [ 'tables' ],
	];
	foreach ( $candidates as $path ) {
		$node = $m;
		foreach ( $path as $step ) {
			$node = is_array( $node ) ? ( $node[$step] ?? null ) : null;
		}
		if ( is_array( $node ) && is_numeric( $node['page'] ?? null ) && is_numeric( $node['revision'] ?? null ) ) {
			return [ 'page' => (int)$node['page'], 'revision' => (int)$node['revision'], 'from' => implode( '.', $path ) ];
		}
	}
	return null;
}

function wstVerifyManifest( string $dir, string $stamp ): int {
	$dir = rtrim( $dir, '/' );
	$raw = @file_get_contents( "$dir/manifest.json" );
	if ( $raw === false ) {
		wstFail( WST_ERROR, "cannot read $dir/manifest.json" );
	}
	$m = json_decode( $raw, true );
	if ( !is_array( $m ) ) {
		wstSay( 'manifest.json is not a JSON object' );
		return WST_NO;
	}
	$ok = true;
	if ( $stamp !== '' && isset( $m['stamp'] ) && (string)$m['stamp'] !== $stamp ) {
		wstSay( "manifest stamp {$m['stamp']} != requested $stamp" );
		$ok = false;
	}
	$expected = wstManifestFiles( $m );
	$present = array_values( array_filter( scandir( $dir ) ?: [], static fn ( $f ) => is_file( "$dir/$f" )
		&& $f !== 'manifest.json' && !str_ends_with( $f, '.part' ) ) );
	foreach ( array_unique( array_merge( WST_BUNDLE_FILES, $present ) ) as $f ) {
		if ( !is_file( "$dir/$f" ) ) {
			wstSay( "missing bundle file $f" );
			$ok = false;
			continue;
		}
		if ( !isset( $expected[$f] ) ) {
			wstSay( "manifest.json has no sha256 for $f" );
			$ok = false;
			continue;
		}
		$size = filesize( "$dir/$f" );
		$sha = hash_file( 'sha256', "$dir/$f" );
		if ( $sha === false || $size === false ) {
			wstFail( WST_ERROR, "cannot read $dir/$f" );
		}
		if ( $sha !== $expected[$f]['sha256'] || ( $expected[$f]['bytes'] !== null && $size !== $expected[$f]['bytes'] ) ) {
			wstSay( "$f: sha256/size mismatch" );
			$ok = false;
		} else {
			wstSay( "$f: sha256 ok ($size bytes)" );
		}
	}
	$want = wstManifestCounts( $m );
	if ( $want === null ) {
		wstSay( 'manifest.json has no page/revision counts (expected e.g. "target": {"tables": {"page": n, "revision": n}})' );
		return WST_NO;
	}
	if ( is_file( "$dir/westernis.sqlite" ) ) {
		try {
			$pdo = new PDO( "sqlite:$dir/westernis.sqlite", null, null, [
				PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
				PDO::SQLITE_ATTR_OPEN_FLAGS => PDO::SQLITE_OPEN_READONLY,
			] );
			foreach ( [ 'page', 'revision' ] as $t ) {
				$n = (int)$pdo->query( "SELECT COUNT(*) FROM $t" )->fetchColumn();
				if ( $n !== $want[$t] ) {
					wstSay( "$t: $n rows, manifest ({$want['from']}) says {$want[$t]}" );
					$ok = false;
				} else {
					wstSay( "$t: $n rows, as in the manifest" );
				}
			}
		} catch ( PDOException $e ) {
			wstSay( 'cannot count rows in westernis.sqlite: ' . $e->getMessage() );
			$ok = false;
		}
	}
	return $ok ? WST_OK : WST_NO;
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------

$args = array_slice( $argv, 1 );
$cmd = array_shift( $args ) ?? '';
$need = [ 'exists' => 1, 'exists-prefix' => 1, 'get' => 2, 'put' => 2, 'put-json' => 2, 'cat' => 1, 'list' => 1,
	'age' => 1, 'verify-manifest' => 1 ];
if ( !isset( $need[$cmd] ) || count( $args ) < $need[$cmd] ) {
	wstFail( WST_USAGE, 'usage: wst-r2.php exists|exists-prefix|cat|list|age <key> | get <key> <file> | put <key> <file> [type]'
		. ' | put-json <key> <json> | verify-manifest <dir> [stamp]' );
}

if ( $cmd === 'verify-manifest' ) {
	exit( wstVerifyManifest( $args[0], $args[1] ?? '' ) );
}

$key = wstKey( $args[0] );
try {
	$local = wstEnv( 'WST_R2_LOCAL_DIR' );
	$store = $local !== '' ? new WstDirStore( $local ) : new WstS3Store();
	switch ( $cmd ) {
		case 'exists':
			exit( $store->stat( $key ) !== null ? WST_OK : WST_NO );
		case 'exists-prefix':
			exit( $store->hasPrefix( $key ) ? WST_OK : WST_NO );
		case 'list':
			foreach ( $store->listKeys( $key ) as $k ) {
				echo $k, "\n";
			}
			exit( WST_OK );
		case 'cat':
			$body = $store->read( $key, 65536 );
			if ( $body === null ) {
				exit( WST_NO );
			}
			echo $body;
			exit( WST_OK );
		case 'age':
			$st = $store->stat( $key );
			if ( $st === null ) {
				exit( WST_NO );
			}
			echo max( 0, time() - $st['mtime'] ), "\n";
			exit( WST_OK );
		case 'get':
			if ( !$store->download( $key, $args[1] ) ) {
				wstSay( "$key: absent in " . $store->describe() );
				exit( WST_NO );
			}
			wstSay( "$key: downloaded (" . filesize( $args[1] ) . ' bytes)' );
			exit( WST_OK );
		case 'put':
			if ( !is_file( $args[1] ) || !is_readable( $args[1] ) ) {
				wstFail( WST_USAGE, "cannot read {$args[1]}" );
			}
			$store->upload( $key, $args[1], $args[2] ?? 'application/octet-stream' );
			wstSay( "$key: uploaded (" . filesize( $args[1] ) . ' bytes)' );
			exit( WST_OK );
		case 'put-json':
			$doc = json_decode( $args[1], true );
			if ( !is_array( $doc ) ) {
				wstFail( WST_USAGE, 'put-json needs a JSON object or array' );
			}
			$store->uploadString( $key, json_encode( $doc, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) . "\n", 'application/json' );
			wstSay( "$key: written" );
			exit( WST_OK );
	}
} catch ( Throwable $e ) {
	wstFail( WST_ERROR, "$cmd $key failed: " . wstDescribe( $e ) );
}
