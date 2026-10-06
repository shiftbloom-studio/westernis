<?php
/**
 * Westernis — copy the legacy MariaDB wiki into the fresh SQLite schema (docs/cloudflare-design.md, section 2.9)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 * Runs only inside the migration container, after installPreConfigured + update.php created the SQLite
 * schema with the same extension set (migrate.sh step 3):
 *
 *   MW_CONFIG_FILE=/opt/westernis/migrate/MigrationSettings.php WST_DB=sqlite \
 *     php /opt/westernis/migrate/CopyMysqlToSqlite.php --out /out/reports/copy-report.json
 *
 * Every non-derived table is copied through MediaWiki's DB layer, so values are stored exactly as
 * MediaWiki-on-SQLite stores them:
 *  - text.old_text and every other string column stay plain strings (DatabaseSqlite::addQuotes stores TEXT,
 *    and a hex BLOB only for values that contain a NUL byte, exactly like MediaWiki's own writes);
 *  - only the metadata columns MediaWiki core writes with encodeBlob() go through encodeBlob();
 *  - MariaDB TIMESTAMP/DATETIME columns (in MW 1.46: categorylinks.cl_timestamp) come back from mysqli as
 *    'YYYY-MM-DD HH:MM:SS'. They are converted to MediaWiki's TS_MW form ('YYYYMMDDHHMMSS') with
 *    $dst->timestamp(), which is what MediaWiki-on-SQLite writes; the DATETIME column's NUMERIC affinity then
 *    stores an INTEGER. A copied TEXT value would sort before every later INTEGER and break range queries
 *    (API categorymembers cmsort=timestamp, cmstart/cmend). The copy checks typeof() = 'integer' afterwards.
 *    The source session keeps MariaDB's default time zone, exactly as MediaWiki's own connections read them.
 *    Other temporal types (DATE, TIME, YEAR) are not used by MediaWiki and stop the copy;
 *  - IDs are copied explicitly, and sqlite_sequence is raised to MariaDB's AUTO_INCREMENT - 1, so IDs that
 *    were used once (deleted pages, archived revisions, purged rows) are never handed out again.
 * Derived tables (search index, caches, job queue, special-page caches, site_stats, Cargo) are rebuilt
 * afterwards instead. Any schema difference or count mismatch aborts with exit code 1.
 *
 * The source connection is read-only (SET SESSION TRANSACTION READ ONLY) and reads one consistent InnoDB
 * snapshot. The target must be the scratch SQLite database of a fresh install, or the script refuses.
 */

use MediaWiki\Maintenance\Maintenance;
use Wikimedia\Rdbms\IDatabase;
use Wikimedia\Rdbms\IMaintainableDatabase;

require_once ( getenv( 'MW_INSTALL_PATH' ) ?: '/var/www/html' ) . '/maintenance/Maintenance.php';

class CopyMysqlToSqlite extends Maintenance {
	/** Rebuilt afterwards (migrate.sh step 4) instead of copied */
	private const SKIP = '/^(searchindex|objectcache|l10n_cache|job|querycache|querycachetwo|querycache_info|updatelog|site_stats|cargo_.*)$/';
	/** Derived tables a fresh install may have filled: emptied in the target so nothing stale survives */
	private const CLEAR = [ 'job', 'objectcache', 'l10n_cache', 'querycache', 'querycachetwo', 'querycache_info' ];
	/** The only non-cache columns MediaWiki core writes with encodeBlob() (LocalFile, ArchivedFile, UploadStash) */
	private const BLOB_COLS = [
		'image' => [ 'img_metadata' ],
		'oldimage' => [ 'oi_metadata' ],
		'filearchive' => [ 'fa_metadata' ],
		'uploadstash' => [ 'us_props' ],
	];
	/** installPreConfigured creates exactly one page (the main page); more means this is not a scratch DB */
	private const MAX_PAGES_BEFORE_COPY = 1;
	/** MariaDB column types converted to TS_MW (MediaWiki-on-SQLite stores these as INTEGER) */
	private const TS_TYPES = [ 'timestamp', 'datetime' ];
	/** Temporal types MediaWiki does not use: a column of one of these means an unknown schema, so stop */
	private const UNSUPPORTED_TYPES = [ 'date', 'time', 'year' ];

	public function __construct() {
		parent::__construct();
		$this->addDescription( 'Copy every non-derived table of the legacy MariaDB wiki into the fresh SQLite database' );
		$this->addOption( 'out', 'Write the JSON copy report to this file', true, true );
		$this->setBatchSize( 200 );
	}

	public function execute() {
		$dst = $this->getDB( DB_PRIMARY );
		$this->assertScratchTarget( $dst );
		$src = $this->connectSource();
		$srcName = $src->getDBname();

		$srcTables = $src->listTables( null, __METHOD__ );
		sort( $srcTables );
		$tz = $src->query( 'SELECT @@session.time_zone AS tz_session, @@system_time_zone AS tz_system',
			__METHOD__, IDatabase::QUERY_CHANGE_NONE )->fetchObject();
		$report = [
			'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'source' => [
				'type' => $src->getType(),
				'server' => $src->getServerName(),
				// TIMESTAMP columns are read in this zone, as MediaWiki's own connections read them
				'timeZone' => [ 'session' => (string)( $tz->tz_session ?? '' ), 'system' => (string)( $tz->tz_system ?? '' ) ],
			],
			'target' => [ 'type' => $dst->getType() ],
			'tables' => [],
			'skipped' => [],
			'cleared' => [],
			'targetOnly' => [],
		];

		$temporal = $this->temporalColumns( $src, $srcName );
		foreach ( $srcTables as $t ) {
			if ( preg_match( self::SKIP, $t ) ) {
				$report['skipped'][] = $t;
				continue;
			}
			if ( !$dst->tableExists( $t, __METHOD__ ) ) {
				$this->fatalError( "The SQLite schema lacks table '$t': the image must have the same extensions as the legacy wiki." );
			}
			$this->assertSameColumns( $src, $dst, $t );
			$report['tables'][$t] = $this->copyTable( $src, $dst, $t, $srcName, $temporal[$t] ?? [] );
			$this->output( sprintf( "  %-28s %6d rows%s\n", $t, $report['tables'][$t]['rows'],
				isset( $temporal[$t] ) ? '  (TS_MW: ' . implode( ', ', $temporal[$t] ) . ')' : '' ) );
		}

		// The snapshot was read-only; nothing to commit on the source.
		$src->rollback( __METHOD__ );
		$src->close( __METHOD__ );

		foreach ( self::CLEAR as $t ) {
			if ( $dst->tableExists( $t, __METHOD__ ) ) {
				$n = $this->countRows( $dst, $t );
				if ( $n > 0 ) {
					$this->beginTransactionRound( __METHOD__ );
					$dst->newDeleteQueryBuilder()->deleteFrom( $t )->where( IDatabase::ALL_ROWS )->caller( __METHOD__ )->execute();
					$this->commitTransactionRound( __METHOD__ );
				}
				$report['cleared'][$t] = $n;
			}
		}

		// Tables only the SQLite side has must be empty (FTS3 shadow tables of searchindex are rebuilt anyway).
		$known = array_flip( $srcTables );
		$unexpected = [];
		foreach ( $dst->listTables( null, __METHOD__ ) as $t ) {
			if ( isset( $known[$t] ) || preg_match( self::SKIP, $t ) || str_starts_with( $t, 'searchindex_' ) ) {
				continue;
			}
			$n = $this->countRows( $dst, $t );
			$report['targetOnly'][$t] = $n;
			if ( $n > 0 ) {
				$unexpected[] = "$t ($n rows)";
			}
		}
		if ( $unexpected ) {
			$this->fatalError( 'Tables that exist only in SQLite contain rows the copy does not explain: ' . implode( ', ', $unexpected ) );
		}

		$json = json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR );
		if ( file_put_contents( $this->getOption( 'out' ), $json . "\n" ) === false ) {
			$this->fatalError( 'Cannot write ' . $this->getOption( 'out' ) );
		}
		$this->output( sprintf( "Copied %d tables, skipped %d derived ones.\n", count( $report['tables'] ), count( $report['skipped'] ) ) );
	}

	/** Refuse anything but the scratch SQLite database of a fresh install. */
	private function assertScratchTarget( IMaintainableDatabase $dst ): void {
		if ( $dst->getType() !== 'sqlite' ) {
			$this->fatalError( 'The target database is ' . $dst->getType() . ', not SQLite: refusing to touch it.' );
		}
		$dir = rtrim( (string)getenv( 'WST_SQLITE_DIR' ), '/' );
		$file = rtrim( (string)$this->getConfig()->get( 'SQLiteDataDir' ), '/' ) . '/' . $dst->getDBname() . '.sqlite';
		if ( $dir === '' || dirname( $file ) !== $dir || !is_file( $file ) ) {
			$this->fatalError( "The target is not the scratch database in WST_SQLITE_DIR ($file)." );
		}
		$pages = $this->countRows( $dst, 'page' );
		if ( $pages > self::MAX_PAGES_BEFORE_COPY ) {
			$this->fatalError( "The target already holds $pages pages: it is not a fresh installPreConfigured database." );
		}
	}

	/** Read-only connection to the legacy MariaDB (credentials from the container environment, never printed). */
	private function connectSource(): IMaintainableDatabase {
		$params = [
			'host' => getenv( 'WIKI_DB_HOST' ) ?: 'db',
			'user' => getenv( 'MARIADB_USER' ) ?: '',
			'password' => getenv( 'MARIADB_PASSWORD' ) ?: '',
			'dbname' => getenv( 'MARIADB_DATABASE' ) ?: '',
			'tablePrefix' => '',
		];
		if ( $params['user'] === '' || $params['dbname'] === '' ) {
			$this->fatalError( 'MARIADB_USER / MARIADB_DATABASE are not set (docker run --env-file .env).' );
		}
		$src = $this->getServiceContainer()->getDatabaseFactory()->create( 'mysql', $params );
		if ( !$src instanceof IMaintainableDatabase || $src->getType() !== 'mysql' ) {
			$this->fatalError( 'Cannot open the MariaDB source connection.' );
		}
		// Any write on this session now fails in MariaDB itself; BEGIN pins one consistent snapshot
		// (REPEATABLE READ) for all tables, so even a live (not frozen) wiki yields a coherent copy.
		$src->query( 'SET SESSION TRANSACTION READ ONLY', __METHOD__ );
		$src->begin( __METHOD__ );
		return $src;
	}

	/** Column names must match exactly (same MediaWiki version and extension set on both sides). */
	private function assertSameColumns( IMaintainableDatabase $src, IMaintainableDatabase $dst, string $t ): void {
		$a = $src->newSelectQueryBuilder()
			->select( 'column_name' )
			->from( 'information_schema.columns' )
			->where( [ 'table_schema' => $src->getDBname(), 'table_name' => $t ] )
			->caller( __METHOD__ )
			->fetchFieldValues();
		$b = [];
		$res = $dst->query( 'SELECT name FROM pragma_table_info(' . $dst->addQuotes( $t ) . ')',
			__METHOD__, IDatabase::QUERY_CHANGE_NONE );
		foreach ( $res as $row ) {
			$b[] = (string)$row->name;
		}
		$a = array_map( 'strval', $a );
		sort( $a );
		sort( $b );
		if ( $a !== $b ) {
			$this->fatalError( "Column mismatch in '$t': only in MariaDB [" . implode( ', ', array_diff( $a, $b ) )
				. '], only in SQLite [' . implode( ', ', array_diff( $b, $a ) ) . ']' );
		}
	}

	/**
	 * TIMESTAMP/DATETIME columns per table (copied as TS_MW); stops on DATE/TIME/YEAR columns, which
	 * MediaWiki does not use and which therefore mean a schema this script was not written for.
	 * Cargo tables are skipped: they are rebuilt, not copied.
	 * @return array<string,string[]>
	 */
	private function temporalColumns( IMaintainableDatabase $src, string $srcName ): array {
		$res = $src->newSelectQueryBuilder()
			->select( [ 'tbl' => 'table_name', 'col' => 'column_name', 'type' => 'data_type' ] )
			->from( 'information_schema.columns' )
			->where( [ 'table_schema' => $srcName, 'data_type' => array_merge( self::TS_TYPES, self::UNSUPPORTED_TYPES ) ] )
			->orderBy( [ 'table_name', 'column_name' ] )
			->caller( __METHOD__ )
			->fetchResultSet();
		$out = [];
		foreach ( $res as $row ) {
			$t = (string)$row->tbl;
			if ( preg_match( self::SKIP, $t ) ) {
				continue;
			}
			$type = strtolower( (string)$row->type );
			if ( !in_array( $type, self::TS_TYPES, true ) ) {
				$this->fatalError( "Column $t.{$row->col} has type $type, which MediaWiki does not use: refusing to guess its SQLite form." );
			}
			$out[$t][] = (string)$row->col;
		}
		return $out;
	}

	/**
	 * @param string[] $tsCols TIMESTAMP/DATETIME columns of this table (converted to TS_MW)
	 * @return array{rows:int, sequence:?int, timestampColumns?:string[]}
	 */
	private function copyTable( IMaintainableDatabase $src, IMaintainableDatabase $dst, string $t, string $srcName, array $tsCols ): array {
		$rows = [];
		$res = $src->newSelectQueryBuilder()->select( '*' )->from( $t )->caller( __METHOD__ )->fetchResultSet();
		foreach ( $res as $row ) {
			$rows[] = $this->prepare( $dst, $t, (array)$row, $tsCols );
		}

		$this->beginTransactionRound( __METHOD__ );
		// installPreConfigured's default rows (main page, interwiki, content_models, slot_roles, ...) go first,
		// so every ID below is the source's ID.
		$dst->newDeleteQueryBuilder()->deleteFrom( $t )->where( IDatabase::ALL_ROWS )->caller( __METHOD__ )->execute();
		foreach ( array_chunk( $rows, $this->getBatchSize() ) as $chunk ) {
			$dst->newInsertQueryBuilder()->insertInto( $t )->rows( $chunk )->caller( __METHOD__ )->execute();
		}
		$sequence = $this->syncSequence( $src, $dst, $t, $srcName );
		$this->commitTransactionRound( __METHOD__ );

		$n = $this->countRows( $dst, $t );
		if ( $n !== count( $rows ) ) {
			$this->fatalError( "$t: source " . count( $rows ) . " rows, target $n rows" );
		}
		$out = [ 'rows' => $n, 'sequence' => $sequence ];
		if ( $tsCols ) {
			// Stored as MediaWiki-on-SQLite stores them: TS_MW digits in a NUMERIC-affinity column = INTEGER
			foreach ( $tsCols as $c ) {
				$q = $dst->addIdentifierQuotes( $c );
				$bad = (int)$dst->newSelectQueryBuilder()
					->select( 'COUNT(*)' )
					->from( $t )
					->where( "$q IS NOT NULL AND typeof($q) <> 'integer'" )
					->caller( __METHOD__ )
					->fetchField();
				if ( $bad > 0 ) {
					$this->fatalError( "$t.$c: $bad value(s) are not stored as INTEGER (TS_MW) in SQLite." );
				}
			}
			$out['timestampColumns'] = $tsCols;
		}
		return $out;
	}

	/** @param string[] $tsCols */
	private function prepare( IMaintainableDatabase $dst, string $t, array $r, array $tsCols ): array {
		foreach ( self::BLOB_COLS[$t] ?? [] as $c ) {
			if ( array_key_exists( $c, $r ) && $r[$c] !== null ) {
				$r[$c] = $dst->encodeBlob( $r[$c] );
			}
		}
		foreach ( $tsCols as $c ) {
			if ( array_key_exists( $c, $r ) && $r[$c] !== null ) {
				$r[$c] = $this->toMwTimestamp( $dst, $t, $c, (string)$r[$c] );
			}
		}
		// Every other value stays the string (or NULL) mysqli returned: addQuotes stores it as TEXT,
		// as a hex BLOB only when it contains a NUL byte, and SQLite's column affinity turns numeric
		// strings into INTEGER/REAL where MediaWiki's schema says so.
		return $r;
	}

	/** 'YYYY-MM-DD HH:MM:SS' (mysqli) -> 'YYYYMMDDHHMMSS' as $dbw->timestamp() writes it; stops on anything else. */
	private function toMwTimestamp( IMaintainableDatabase $dst, string $t, string $c, string $v ): string {
		// MariaDB's zero date (from a lax sql_mode) has no TS_MW form; MediaWiki never writes it.
		if ( preg_match( '/^0000-00-00/', $v ) ) {
			$this->fatalError( "$t.$c holds the zero date '$v': fix the row in the legacy wiki first." );
		}
		try {
			$ts = (string)$dst->timestamp( $v );
		} catch ( Throwable $e ) {
			$this->fatalError( "$t.$c: cannot convert '$v' to a MediaWiki timestamp (" . $e->getMessage() . ')' );
		}
		if ( !preg_match( '/^\d{14}$/', $ts ) ) {
			$this->fatalError( "$t.$c: '$v' became '$ts', not a 14-digit MediaWiki timestamp." );
		}
		return $ts;
	}

	/**
	 * For AUTOINCREMENT tables: raise sqlite_sequence to MariaDB's AUTO_INCREMENT - 1 (never lower it).
	 * The explicit-ID inserts already lifted it to MAX(id); this also covers IDs used by rows that no
	 * longer exist (deleted pages, purged recent changes), as MariaDB does.
	 */
	private function syncSequence( IMaintainableDatabase $src, IMaintainableDatabase $dst, string $t, string $srcName ): ?int {
		$ddl = '';
		$res = $dst->query( "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = " . $dst->addQuotes( $t ),
			__METHOD__, IDatabase::QUERY_CHANGE_NONE );
		foreach ( $res as $row ) {
			$ddl = (string)$row->sql;
		}
		if ( stripos( $ddl, 'AUTOINCREMENT' ) === false ) {
			return null;
		}
		$ai = $src->newSelectQueryBuilder()
			->select( 'auto_increment' )
			->from( 'information_schema.tables' )
			->where( [ 'table_schema' => $srcName, 'table_name' => $t ] )
			->caller( __METHOD__ )
			->fetchField();
		$current = null;
		$res = $dst->query( 'SELECT seq FROM sqlite_sequence WHERE name = ' . $dst->addQuotes( $t ),
			__METHOD__, IDatabase::QUERY_CHANGE_NONE );
		foreach ( $res as $row ) {
			$current = (int)$row->seq;
		}
		$want = max( $ai === null || $ai === false ? 0 : (int)$ai - 1, $current ?? 0 );
		if ( $current === null && $want > 0 ) {
			$dst->query( 'INSERT INTO sqlite_sequence (name, seq) VALUES (' . $dst->addQuotes( $t ) . ", $want)", __METHOD__ );
		} elseif ( $current !== null && $want > $current ) {
			$dst->query( "UPDATE sqlite_sequence SET seq = $want WHERE name = " . $dst->addQuotes( $t ), __METHOD__ );
		}
		return $want > 0 ? $want : $current;
	}

	private function countRows( IMaintainableDatabase $db, string $t ): int {
		return (int)$db->newSelectQueryBuilder()->select( 'COUNT(*)' )->from( $t )->caller( __METHOD__ )->fetchField();
	}
}

$maintClass = CopyMysqlToSqlite::class;
require_once RUN_MAINTENANCE_IF_MAIN;
