<?php
/**
 * Westernis — MediaWiki settings wrapper for the migration container (docs/cloudflare-design.md, section 2.9)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * migrate.sh points MW_CONFIG_FILE here for every MediaWiki run. It loads the normal LocalSettings.php
 * (which includes LocalSettings.cloud.php in the cloud image) and then enforces two guarantees:
 *
 *  - WST_DB=mysql (reading the legacy wiki): MediaWiki runs read-only, so no maintenance script can write
 *    to the live MariaDB database.
 *  - WST_DB=sqlite (building the bundle): the primary database MUST be the SQLite file in WST_SQLITE_DIR and
 *    Cargo MUST use its own file next to it. Anything else (for example a missing cloud layer, which would
 *    fall back to MariaDB) stops the script before it connects anywhere.
 *
 * Media must stay local (WST_MEDIA=local): the export never talks to R2.
 */
if ( !defined( 'MEDIAWIKI' ) ) {
	exit;
}

require_once "$IP/LocalSettings.php";

$wstMigrateFail = static function ( string $msg ): void {
	fwrite( STDERR, "[migrate] FATAL (MigrationSettings.php): $msg\n" );
	exit( 3 );
};

if ( PHP_SAPI !== 'cli' ) {
	$wstMigrateFail( 'only for maintenance scripts in the migration container' );
}
if ( getenv( 'WST_MEDIA' ) !== 'local' || ( $wgLocalFileRepo['backend'] ?? '' ) === 'AmazonS3' ) {
	$wstMigrateFail( 'WST_MEDIA must be "local": the export never writes to R2' );
}

$wstMigrateDb = getenv( 'WST_DB' ) ?: 'sqlite';
if ( $wstMigrateDb === 'mysql' ) {
	if ( $wgDBtype !== 'mysql' ) {
		$wstMigrateFail( "WST_DB=mysql but the primary database type is '$wgDBtype'" );
	}
	// Every write through MediaWiki's DB layer now fails with DBReadOnlyError
	$wgReadOnly = 'Westernis migration export: the legacy database is only read';
} elseif ( $wstMigrateDb === 'sqlite' ) {
	$wstMigrateDir = rtrim( (string)getenv( 'WST_SQLITE_DIR' ), '/' );
	if ( $wstMigrateDir === '' ) {
		$wstMigrateFail( 'WST_SQLITE_DIR is not set' );
	}
	if ( $wgDBtype !== 'sqlite' ) {
		$wstMigrateFail( "the primary database type is '$wgDBtype', not sqlite (is LocalSettings.cloud.php missing?)" );
	}
	if ( rtrim( (string)$wgSQLiteDataDir, '/' ) !== $wstMigrateDir ) {
		$wstMigrateFail( "\$wgSQLiteDataDir is not WST_SQLITE_DIR ($wstMigrateDir)" );
	}
	if ( ( $wgCargoDBtype ?? null ) !== 'sqlite' || dirname( (string)( $wgCargoDBfilePath ?? '' ) ) !== $wstMigrateDir ) {
		$wstMigrateFail( "Cargo must use its own SQLite file in $wstMigrateDir (\$wgCargoDBtype/\$wgCargoDBfilePath)" );
	}
} else {
	$wstMigrateFail( "WST_DB must be mysql or sqlite, not '$wstMigrateDb'" );
}

// The export is offline work: no jobs on page views, no copy uploads, no foreign file repos.
$wgJobRunRate = 0;
$wgAllowCopyUploads = false;
$wgUseInstantCommons = false;
$wgForeignFileRepos = [];
unset( $wstMigrateDb, $wstMigrateDir, $wstMigrateFail );
