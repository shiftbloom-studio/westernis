<?php
/**
 * wst-import-media.php — first boot only: copy the uploads of the migration bundle into the wiki's file
 * backend and verify every file (docs/cloudflare-design.md, sections 2.6 and 4.5).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
 *
 *   php maintenance/run.php /usr/local/bin/wst-import-media.php --dir /var/lib/westernis/import/media
 *
 * Runs as www-data (`wst-as wiki`, the media token comes from LocalSettings.cloud.php) and is started by
 * wst-start.sh BEFORE Litestream, so the wiki never counts as initialised while uploads are missing.
 * <dir>/public is the bundle's copy of images/ (originals and archive/), <dir>/deleted that of
 * images/deleted/. Each file goes to the same relative path in the local repo's "public" or "deleted" zone
 * of whatever backend the wiki uses (Extension:AWS on R2 in the cloud, the local disk in staging).
 * A file that already exists with the same size and SHA-1 is skipped, so a retry only copies what is missing.
 * After the copy every file is read back (size and SHA-1); any difference or error exits 1.
 */

use MediaWiki\Maintenance\Maintenance;
use Wikimedia\FileBackend\FSFile\FSFile;

require_once ( getenv( 'MW_INSTALL_PATH' ) ?: '/var/www/html' ) . '/maintenance/Maintenance.php';

class WstImportMedia extends Maintenance {
	public function __construct() {
		parent::__construct();
		$this->addDescription( 'Copy the uploads of the Westernis migration bundle into the file backend and verify them' );
		$this->addOption( 'dir', 'Extracted bundle media directory (with public/ and deleted/)', true, true );
	}

	public function execute() {
		$dir = rtrim( (string)$this->getOption( 'dir' ), '/' );
		if ( $dir === '' || !is_dir( $dir ) ) {
			$this->fatalError( "no such directory: $dir" );
		}
		$repo = $this->getServiceContainer()->getRepoGroup()->getLocalRepo();
		$backend = $repo->getBackend();
		$this->output( 'backend: ' . $backend->getName() . "\n" );

		$copied = 0;
		$same = 0;
		$failed = 0;
		foreach ( [ 'public', 'deleted' ] as $zone ) {
			$src = "$dir/$zone";
			if ( !is_dir( $src ) ) {
				continue;
			}
			$root = $repo->getZonePath( $zone );
			if ( !$root ) {
				$this->error( "the local repo has no '$zone' zone" );
				$failed++;
				continue;
			}
			$it = new RecursiveIteratorIterator(
				new RecursiveDirectoryIterator( $src, FilesystemIterator::SKIP_DOTS ),
				RecursiveIteratorIterator::LEAVES_ONLY
			);
			foreach ( $it as $file ) {
				/** @var SplFileInfo $file */
				$path = $file->getPathname();
				$rel = str_replace( DIRECTORY_SEPARATOR, '/', substr( $path, strlen( $src ) + 1 ) );
				if ( $file->isLink() || !$file->isFile() ) {
					$this->error( "$zone/$rel: not a regular file" );
					$failed++;
					continue;
				}
				$dst = "$root/$rel";
				$size = $file->getSize();
				$sha1 = FSFile::getSha1Base36FromPath( $path );
				if ( $sha1 === false ) {
					$this->error( "$zone/$rel: cannot read the source file" );
					$failed++;
					continue;
				}
				if ( $this->matches( $backend, $dst, $size, $sha1 ) ) {
					$same++;
					continue;
				}
				$status = $backend->prepare( [ 'dir' => dirname( $dst ) ] );
				if ( $status->isOK() ) {
					$status->merge( $backend->store( [ 'src' => $path, 'dst' => $dst, 'overwrite' => true ] ) );
				}
				if ( !$status->isOK() ) {
					$this->error( "$zone/$rel: store failed: " . $this->describe( $status ) );
					$failed++;
					continue;
				}
				if ( !$this->matches( $backend, $dst, $size, $sha1 ) ) {
					$this->error( "$zone/$rel: stored, but the copy reads back with another size or SHA-1" );
					$failed++;
					continue;
				}
				$copied++;
			}
		}
		$this->output( "media import: $copied copied, $same already present, $failed failed\n" );
		if ( $failed > 0 ) {
			$this->fatalError( "media import FAILED for $failed file(s)" );
		}
	}

	/** True when $dst exists with this size and SHA-1 (read from the primary, never a cache). */
	private function matches( $backend, string $dst, int $size, string $sha1 ): bool {
		$stat = $backend->getFileStat( [ 'src' => $dst, 'latest' => true ] );
		if ( !is_array( $stat ) || (int)( $stat['size'] ?? -1 ) !== $size ) {
			return false;
		}
		return $backend->getFileSha1Base36( [ 'src' => $dst, 'latest' => true ] ) === $sha1;
	}

	private function describe( $status ): string {
		$msgs = [];
		foreach ( $status->getMessages() as $m ) {
			$msgs[] = wfMessage( $m )->inLanguage( 'en' )->plain();
		}
		return $msgs ? implode( '; ', $msgs ) : 'unknown error';
	}
}

$maintClass = WstImportMedia::class;
require_once RUN_MAINTENANCE_IF_MAIN;
