<?php
/**
 * Westernis — Cloudflare overrides (docs/cloudflare-design.md, section 2.5)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Copied to /var/www/html/LocalSettings.cloud.php by cloud/image/Dockerfile only; the local Docker stack
 * never sees this file. LocalSettings.php includes it right before the optional LocalSettings.local.php,
 * so per-install overrides still win. Every value comes from the container environment, which the Worker
 * passes on each start (cloud/src/wiki-container.js); nothing install-specific belongs in this file.
 *
 * Environment: WIKI_SERVER, WIKI_HOSTS, WIKI_EDIT_HOST, WIKI_SSO_USER, R2_ACCOUNT_ID, R2_MEDIA_BUCKET,
 * R2_MEDIA_ACCESS_KEY_ID, R2_MEDIA_SECRET_ACCESS_KEY; from the image: WST_DB, WST_MEDIA, WST_SQLITE_DIR.
 * PHP runs as www-data and never sees the DB-bucket token (cloud/image/bin/wst-as).
 */
if ( !defined( 'MEDIAWIKI' ) ) {
	exit;
}
/** @var callable $wstEnv defined in LocalSettings.php */

// ---------------------------------------------------------------------------
// Hosts: a reading host and an always-private edit host. TLS ends at Cloudflare; the Worker overwrites
// X-Forwarded-Proto and X-Forwarded-For (= CF-Connecting-IP) on every request it forwards.
// ---------------------------------------------------------------------------
$wgCanonicalServer = $wstEnv( 'WIKI_SERVER', 'https://wiki.example.org' );
$wstHosts = array_values( array_filter( array_map( 'trim',
	explode( ',', strtolower( (string)$wstEnv( 'WIKI_HOSTS', '' ) ) ) ) ) );
$wstHost = strtolower( (string)( $_SERVER['HTTP_HOST'] ?? '' ) );
$wstProto = ( $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? 'https' ) === 'http' ? 'http' : 'https';
$wgServer = ( PHP_SAPI !== 'cli' && in_array( $wstHost, $wstHosts, true ) )
	? "$wstProto://$wstHost"
	: $wgCanonicalServer;
$wstEditHost = strtolower( (string)$wstEnv( 'WIKI_EDIT_HOST', '' ) );
$wstOnEditHost = PHP_SAPI === 'cli' || ( $wstEditHost !== '' && $wstHost === $wstEditHost );
// WIKI_DEBUG (LocalSettings.php) never applies on the reading host
$wgShowExceptionDetails = $wgShowExceptionDetails && $wstOnEditHost;
if ( !$wstOnEditHost ) {
	// LocalSettings.php switches throttling off for the single author; the reading host gets the defaults back
	$wgRateLimits = \MediaWiki\MainConfigSchema::RateLimits['default'];
}
// Re-asserted after every settings file has run, so no later override can lift the reading-host limits.
$wgExtensionFunctions[] = static function () use ( $wstOnEditHost ): void {
	if ( !$wstOnEditHost ) {
		$GLOBALS['wgShowExceptionDetails'] = false;
		$GLOBALS['wgDebugToolbar'] = false;
		if ( empty( $GLOBALS['wgRateLimits'] ) ) {
			$GLOBALS['wgRateLimits'] = \MediaWiki\MainConfigSchema::RateLimits['default'];
		}
	}
};
// The container is reachable only through the Worker, which sets X-Forwarded-For itself.
$wgUsePrivateIPs = true;
// UNVERIFIED which source address the container sees (design 9.2 item 7); narrow this once it is known.
$wgCdnServersNoPurge = [ '0.0.0.0/0', '::/0' ];
// Cosmetic: e-mail stays off (LocalSettings.php)
$wgEmergencyContact = 'wiki@wiki.example.org';
$wgPasswordSender = 'wiki@wiki.example.org';

// ---------------------------------------------------------------------------
// Single sign-on: the Worker's password gate signs the owner in (docs/cloudflare-design.md, sections 1.2, 1.6).
// For a request with a valid gate session the Worker removes every client X-Westernis-* header and sets
// "X-Westernis-User: <GATE_WIKI_USER>"; WIKI_SSO_USER is the same name, passed to the container on start.
// Extension:Auth_remoteuser (pinned in cloud/image/Dockerfile) then logs that one existing account in.
//  - The name is taken ONLY from that header and only when it equals WIKI_SSO_USER (non-empty); anything
//    else (no header, another name, a header spelled with underscores, the header twice) is ignored, and
//    the request continues with MediaWiki's normal sessions.
//  - API-token clients (Forge MCP) never get the header from the Worker: their requests have no SSO session,
//    so action=login with a bot password and the normal cookie session work exactly as before.
//  - For SSO sessions the extension removes Special:UserLogin/UserLogout/CreateAccount and the
//    login/logout links (logging out happens at the gate: POST /__wst/logout). No user switching,
//    no account creation: an unknown name stays anonymous.
//  - CLI (maintenance scripts, the job loop) never uses it.
// The container is reachable only through the Worker; in local staging leave WIKI_SSO_USER empty unless the
// port is bound to 127.0.0.1, because there anyone who can reach the port could send the header.
// ---------------------------------------------------------------------------
wfLoadExtension( 'Auth_remoteuser' );
$wstSsoUser = str_replace( '_', ' ', trim( (string)getenv( 'WIKI_SSO_USER' ) ) );
$wgAuthRemoteuserUserName = static function () use ( $wstSsoUser ): string {
	if ( PHP_SAPI === 'cli' || $wstSsoUser === '' ) {
		return '';
	}
	$value = $_SERVER['HTTP_X_WESTERNIS_USER'] ?? null;
	if ( !is_string( $value ) || $value === '' ) {
		return '';
	}
	// Exactly one header, spelled with hyphens (Apache drops underscore spellings from $_SERVER, but a
	// second spelling next to the real one means the request did not come from the Worker unaltered).
	if ( function_exists( 'getallheaders' ) ) {
		$names = [];
		foreach ( array_keys( getallheaders() ?: [] ) as $name ) {
			if ( strtolower( strtr( (string)$name, '_', '-' ) ) === 'x-westernis-user' ) {
				$names[] = (string)$name;
			}
		}
		if ( count( $names ) !== 1 || str_contains( $names[0], '_' ) ) {
			return '';
		}
	}
	return hash_equals( $wstSsoUser, str_replace( '_', ' ', trim( $value ) ) ) ? $wstSsoUser : '';
};
$wgAuthRemoteuserAllowUserSwitch = false;
$wgAuthRemoteuserRemoveAuthPagesAndLinks = true;
// Never create an account from a remote name (LocalSettings.php already forbids createaccount).
$wgGroupPermissions['*']['autocreateaccount'] = false;

// ---------------------------------------------------------------------------
// Database: SQLite on the container's local disk, streamed to R2 by Litestream.
// WST_DB=mysql is used only inside the migration container (reading the MariaDB side).
// ---------------------------------------------------------------------------
if ( $wstEnv( 'WST_DB', 'sqlite' ) === 'sqlite' ) {
	$wgDBtype = 'sqlite';
	// -> westernis.sqlite
	$wgDBname = 'westernis';
	$wgDBprefix = '';
	// Outside the document root
	$wgSQLiteDataDir = $wstEnv( 'WST_SQLITE_DIR', '/var/lib/westernis/db' );
	$wgDBserver = '';
	$wgDBuser = '';
	$wgDBpassword = '';
	// Installer layout for the hot cache tables (SqliteInstaller::getLocalSettings): own file, BEGIN IMMEDIATE.
	// Holds sessions and the MainStash (VisualEditor stash); replicated, so logins survive the idle sleep.
	$wgObjectCaches[CACHE_DB] = [
		'class' => \MediaWiki\ObjectCache\SqlBagOStuff::class,
		'loggroup' => 'SQLBagOStuff',
		'server' => [
			'type' => 'sqlite',
			'dbname' => 'wikicache',
			'tablePrefix' => '',
			'variables' => [ 'synchronous' => 'NORMAL' ],
			'dbDirectory' => $wgSQLiteDataDir,
			'trxMode' => 'IMMEDIATE',
			'flags' => 0,
		],
	];
	// Cargo MUST use its own file: otherwise its second connection locks the main file on every infobox save
	$wgCargoDBtype = 'sqlite';
	$wgCargoDBfilePath = "$wgSQLiteDataDir/westernis_cargo.sqlite";
	// $wgJobTypeConf stays untouched: JobQueueDB in the main (replicated) DB.
	// Main, message and parser cache: memcached on 127.0.0.1 (WIKI_CACHE_HOST from the image).
} else {
	$wgMainCacheType = CACHE_NONE;
	$wgMessageCacheType = CACHE_NONE;
	$wgParserCacheType = CACHE_NONE;
}

// ---------------------------------------------------------------------------
// Uploads: R2 through Extension:AWS. Browsers read /images/* from the Worker's R2 binding.
// ---------------------------------------------------------------------------
// Cloudflare's request body cap is 100 MB on Free/Pro zones
$wgMaxUploadSize = 95 * 1024 * 1024;
$wgMSU_uploadsize = '95mb';
if ( $wstEnv( 'WST_MEDIA', 'r2' ) === 'r2' ) {
	wfLoadExtension( 'AWS' );
	// Extension README advice for S3-compatible stores: send checksums only where the API requires them
	putenv( 'AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED' );
	putenv( 'AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED' );
	$wgAWSCredentials = [
		'key' => $wstEnv( 'R2_MEDIA_ACCESS_KEY_ID' ),
		'secret' => $wstEnv( 'R2_MEDIA_SECRET_ACCESS_KEY' ),
		'token' => false,
	];
	$wgAWSRegion = 'auto';
	// $wgAWSBucketName stays UNSET on purpose: the extension then only registers its backend and leaves
	// $wgLocalFileRepo to us (AmazonS3Hooks::installBackend), so file URLs stay root-relative /images/...
	// on both hosts. The extension adds name, class and lockManager to $wgFileBackends['s3'] itself.
	$wstBucket = $wstEnv( 'R2_MEDIA_BUCKET', 'westernis-media' );
	$wgFileBackends['s3'] = [
		// EU jurisdiction buckets have their own S3 endpoint
		'endpoint' => 'https://' . $wstEnv( 'R2_ACCOUNT_ID', 'account-id-missing' ) . '.eu.r2.cloudflarestorage.com',
		'use_path_style_endpoint' => true,
		// ACL "private" on every write (R2 does not do public-read; access goes through the Worker)
		'privateWiki' => true,
		// Same key layout as images/ today (hash levels 2, deleted 3)
		'containerPaths' => [
			"$wgDBname-local-public" => $wstBucket,
			"$wgDBname-local-thumb" => "$wstBucket/thumb",
			"$wgDBname-local-deleted" => "$wstBucket/deleted",
			"$wgDBname-local-temp" => "$wstBucket/temp",
		],
	];
	// url stays $wgUploadPath (/images); the remaining keys are filled in by SetupDynamicConfig.php
	$wgLocalFileRepo['backend'] = 'AmazonS3';
	// Thumbnails are rendered while parsing and stored in R2; a missing one goes Worker -> thumb_handler.php
	$wgLocalFileRepo['transformVia404'] = false;
	// First start: wst-import-media.php copies the bundle's uploads into this repo's backend (no extra backend).
}
