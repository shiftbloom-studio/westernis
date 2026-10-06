#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
  Builds the Cloudflare migration bundle from the running legacy wiki (docs/cloudflare-design.md, 2.9, 4.2, 4.3).

.DESCRIPTION
  1. Builds the cloud image cloud/image/Dockerfile as westernis/mediawiki-cloud:<stamp> (+ :latest),
     unless -SkipBuild.
  2. -Freeze only: drains the legacy job queue, writes MediaWiki's read-only file images/lock_yBgMBwiR
     ("Umzug nach Cloudflare – Bearbeiten pausiert") and stops the jobrunner. Reading keeps working.
  3. Runs the migration container (cloud/migrate/container/migrate.sh) as www-data on the compose network
     westernis_default with --env-file .env. It reads MariaDB read-only and the uploads volume
     westernis_wiki_images read-only, and writes into the fresh named volume westernis_migrate.
  4. Copies the bundle to cloud/migrate/out/<stamp>/ (untracked: it holds password hashes), the reports to
     cloud/migrate/out/<stamp>/reports/, and checks every file's sha256 against manifest.json.
  Without -Freeze this is a dry run: the wiki stays fully usable; the bundle is for local staging (Phase A).
  Any count or content mismatch, render "fail" or XML difference makes migrate.sh fail; then only the reports
  are copied, to cloud/migrate/out/<stamp>-failed/reports/. Render findings of the "review" class (a page
  renders differently on SQLite, Cargo rows differ) do not stop the export: they are listed at the end and in
  reports/render-check.json, and Upload-Bundle.ps1 refuses the bundle until they are accepted (-AcceptReview).

.PARAMETER Freeze
  Final export (Phase B, owner-approved freeze window). Asks for confirmation; pass -Confirm:$false to skip it.
.PARAMETER SkipBuild
  Reuse an existing image (default westernis/mediawiki-cloud:latest, or -Image).
.PARAMETER Stamp
  Bundle name, default UTC yyyyMMdd-HHmmss. Becomes import/<stamp>/ in R2 and WST_BOOTSTRAP=import:<stamp>.
.PARAMETER Image
  Image reference to build or use.
.PARAMETER KeepVolume
  Keep the westernis_migrate volume afterwards (for debugging; it holds password hashes).

.EXAMPLE
  pwsh cloud/migrate/Export-Bundle.ps1                    # dry run (Phase A)
.EXAMPLE
  pwsh cloud/migrate/Export-Bundle.ps1 -SkipBuild         # dry run with the last built image
.EXAMPLE
  pwsh cloud/migrate/Export-Bundle.ps1 -Freeze            # final export (Phase B)

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
  Undo a freeze (rollback, design 4.8):
    docker exec -u www-data westernis-wiki rm -f /var/www/html/images/lock_yBgMBwiR
    docker compose start jobrunner
  The secrets in .env go into the migration container's environment only; this script never prints them.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [switch]$Freeze,
  [switch]$SkipBuild,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string]$Stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'),
  [string]$Image,
  [switch]$KeepVolume
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$repo = 'westernis/mediawiki-cloud'
$network = 'westernis_default'
$imagesVolume = 'westernis_wiki_images'
$volume = 'westernis_migrate'
$runner = 'westernis-migrate'
$helper = 'westernis-migrate-out'
$wiki = 'westernis-wiki'
$lockFile = '/var/www/html/images/lock_yBgMBwiR'
$lockText = 'Umzug nach Cloudflare – Bearbeiten pausiert'
$envFile = Join-Path $root '.env'
$outBase = Join-Path $root 'cloud\migrate\out'
$outDir = Join-Path $outBase $Stamp
$bundleFiles = 'westernis.sqlite', 'westernis_cargo.sqlite', 'images.tar.gz'

if ($WhatIfPreference) { throw '-WhatIf is not supported: this script drives Docker directly. Run without it for a dry run (no -Freeze).' }

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Assert-Ok([string]$what) { if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)." } }
# docker output as trimmed text; $null when the command fails (used for existence checks)
function Get-Docker {
  $out = & docker @args 2>$null
  if ($LASTEXITCODE) { return $null }
  return (($out | Out-String).Trim())
}
function Get-JobCount {
  $n = Get-Docker exec -u www-data $wiki php maintenance/run.php showJobs
  if ($null -eq $n -or $n -notmatch '(\d+)\s*$') { throw 'showJobs failed in the legacy wiki container.' }
  return [int]$Matches[1]
}

# ---- preflight ------------------------------------------------------------------------------------------
if ($null -eq (Get-Docker info --format '{{.ServerVersion}}')) { throw 'Docker is not reachable (is Docker Desktop running?).' }
if (-not (Test-Path $envFile)) { throw "Missing $envFile (the legacy stack's secrets)." }
if ($null -eq (Get-Docker network inspect $network --format '{{.Name}}')) { throw "Docker network $network is missing: is the legacy stack up?" }
if ($null -eq (Get-Docker volume inspect $imagesVolume --format '{{.Name}}')) { throw "Volume $imagesVolume is missing." }
if ((Get-Docker inspect -f '{{.State.Health.Status}}' westernis-db) -ne 'healthy') { throw 'Container westernis-db is not running/healthy.' }
if ($Freeze -and (Get-Docker inspect -f '{{.State.Running}}' $wiki) -ne 'true') { throw "Container $wiki is not running (needed for -Freeze)." }
if (Test-Path $outDir) { throw "$outDir exists already: choose another -Stamp." }
if ($null -ne (Get-Docker container inspect $runner --format '{{.Name}}')) { throw "A container named $runner exists (another export running?)." }
$dockerignore = Join-Path $root '.dockerignore'
if (-not $SkipBuild -and -not (Select-String -Path $dockerignore -Pattern '^cloud/migrate/out' -Quiet)) {
  Write-Warning '.dockerignore does not exclude cloud/migrate/out/: earlier bundles (password hashes) would be sent to the build context.'
}

# ---- 1. image ---------------------------------------------------------------------------------------------
if (-not $SkipBuild) {
  if (-not $Image) { $Image = "${repo}:$Stamp" }
  Write-Step "Building $Image from cloud/image/Dockerfile"
  Push-Location $root
  try {
    docker build --platform linux/amd64 -f cloud/image/Dockerfile -t $Image -t "${repo}:latest" .
    Assert-Ok 'docker build'
  } finally { Pop-Location }
} elseif (-not $Image) {
  $Image = "${repo}:latest"
}
$imageId = Get-Docker image inspect $Image --format '{{.Id}}'
if (-not $imageId) { throw "Image $Image not found (build it, or drop -SkipBuild)." }

# ---- 2. freeze (final export only) ------------------------------------------------------------------------
$frozen = $false
if ($Freeze) {
  if (-not $PSCmdlet.ShouldProcess('legacy wiki (westernis-wiki, westernis-jobrunner)', 'Freeze: drain jobs, write the read-only file, stop the jobrunner')) {
    throw 'Freeze not confirmed: nothing was changed.'
  }
  Write-Step 'Freezing the legacy wiki'
  for ($attempt = 1; $attempt -le 3 -and -not $frozen; $attempt++) {
    # runJobs refuses to work in read-only mode, so drain first, then lock, then make sure nothing slipped in.
    for ($i = 0; $i -lt 30 -and (Get-JobCount) -gt 0; $i++) {
      docker exec -u www-data $wiki php maintenance/run.php runJobs --maxtime 60 | Out-Null
      Assert-Ok 'runJobs in the legacy wiki'
    }
    docker exec -u www-data $wiki sh -c 'printf "%s\n" "$1" > "$2"' sh $lockText $lockFile
    Assert-Ok 'writing the read-only file'
    $left = Get-JobCount
    if ($left -eq 0) { $frozen = $true; break }
    Write-Warning "$left job(s) arrived while locking; unlocking and draining again (attempt $attempt of 3)"
    docker exec -u www-data $wiki rm -f $lockFile
    Assert-Ok 'removing the read-only file'
  }
  if (-not $frozen) { throw 'The job queue did not stay empty; the wiki is NOT frozen. Retry in a quiet moment.' }
  $si = Get-Docker exec $wiki curl -fsS 'http://localhost/api.php?action=query&meta=siteinfo&format=json&formatversion=2'
  if ($si -notmatch '"readonly"\s*:\s*true') { throw "The read-only file is in place, but MediaWiki does not report read-only. Check $lockFile." }
  docker compose --project-directory $root -f (Join-Path $root 'docker-compose.yml') stop jobrunner
  Assert-Ok 'docker compose stop jobrunner'
  Write-Host '    legacy wiki is read-only, job queue empty, jobrunner stopped' -ForegroundColor Green
}

# ---- 3. migration container -------------------------------------------------------------------------------
Write-Step "Preparing the volume $volume"
if ($null -ne (Get-Docker volume inspect $volume --format '{{.Name}}')) {
  docker volume rm $volume | Out-Null
  Assert-Ok "removing the old $volume volume (is a container still using it?)"
}
docker volume create $volume | Out-Null
Assert-Ok 'docker volume create'
# A new named volume belongs to root; the migration runs as www-data (the image's user).
docker run --rm -u 0 -v "${volume}:/out" --entrypoint /bin/chown $Image www-data:www-data /out
Assert-Ok 'preparing the volume'

Write-Step "Running the migration container ($Image, bundle $Stamp, frozen: $frozen)"
$runArgs = @(
  'run', '--rm', '--init', '--name', $runner, '-u', 'www-data',   # the image starts as root (supervisor); migrate.sh runs as www-data
  '--network', $network, '--env-file', $envFile,
  '-e', 'WST_DB=sqlite', '-e', 'WST_MEDIA=local', '-e', 'WST_SQLITE_DIR=/out/db', '-e', 'WIKI_CACHE_HOST=127.0.0.1',
  '-e', "WST_STAMP=$Stamp", '-e', "WST_FROZEN=$([int]$frozen)", '-e', "WST_IMAGE=$Image", '-e', "WST_IMAGE_ID=$imageId",
  '-v', "${imagesVolume}:/src-images:ro", '-v', "${volume}:/out",
  '--entrypoint', '/opt/westernis/migrate/migrate.sh', $Image
)
& docker @runArgs
$migrateExit = $LASTEXITCODE

# ---- 4. copy out ------------------------------------------------------------------------------------------
$copied = $null
try {
  docker create --name $helper -v "${volume}:/out" --entrypoint /bin/true $Image | Out-Null
  Assert-Ok 'docker create (copy helper)'
  if ($migrateExit -eq 0) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    docker cp "${helper}:/out/bundle/." $outDir
    Assert-Ok 'docker cp (bundle)'
    docker cp "${helper}:/out/reports" (Join-Path $outDir 'reports')
    Assert-Ok 'docker cp (reports)'
    $copied = $outDir
  } else {
    $failDir = "$outDir-failed"
    New-Item -ItemType Directory -Path $failDir -Force | Out-Null
    docker cp "${helper}:/out/reports" (Join-Path $failDir 'reports')
    if (-not $LASTEXITCODE) { $copied = $failDir }
  }
} finally {
  docker rm -f $helper 2>$null | Out-Null
  if (-not $KeepVolume) { docker volume rm $volume 2>$null | Out-Null }
}
if ($migrateExit) {
  $where = if ($copied) { "reports: $copied\reports" } else { 'no reports could be copied' }
  $hint = if ($frozen) { "`nThe legacy wiki is still FROZEN. Undo: docker exec -u www-data $wiki rm -f $lockFile; docker compose start jobrunner" } else { '' }
  throw "migrate.sh failed (exit $migrateExit); nothing is uploaded. $where$hint"
}

# ---- 5. verify the copy against manifest.json -------------------------------------------------------------
Write-Step "Checking $outDir against manifest.json"
$manifest = Get-Content -Raw (Join-Path $outDir 'manifest.json') | ConvertFrom-Json -AsHashtable
if ($manifest.stamp -ne $Stamp) { throw "manifest.json names bundle '$($manifest.stamp)', not '$Stamp'." }
foreach ($name in $bundleFiles) {
  $path = Join-Path $outDir $name
  $want = $manifest.files[$name]
  if (-not (Test-Path $path) -or -not $want) { throw "$name is missing from the bundle or the manifest." }
  $sha = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
  $len = (Get-Item $path).Length
  if ($sha -ne $want.sha256 -or $len -ne [long]$want.bytes) { throw "$name differs from manifest.json after docker cp." }
  Write-Host ('    {0,-24} {1,12:N0} bytes  sha256 ok' -f $name, $len)
}

$t = $manifest.target.tables
Write-Host ''
Write-Host ("Bundle $Stamp ({0}): {1} pages, {2} revisions, {3} archived, {4} log entries, {5} users, {6} files (+{7} old versions)" -f `
    ($(if ($manifest.frozen) { 'FROZEN, final' } else { 'dry run' })), $t.page, $t.revision, $t.archive, $t.logging, $t.user, $t.image, $t.oldimage) -ForegroundColor Green
Write-Host "Cargo: $(($manifest.target.cargo.tables.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', ')"
$render = $manifest.checks.render
$needsReview = -not ($render -and $render.reviewOk -eq $true)
if ($render) {
  $st = $render.stats
  Write-Host ("Render check: {0} pages compared on both sides, {1} identical, HTML compared for {2}" -f $st.compared, $st.identical, $st.htmlCompared)
}
if ($needsReview) {
  Write-Host "    $($render.reviewCount) finding(s) to REVIEW (full list: $outDir\reports\render-check.json):" -ForegroundColor Yellow
  foreach ($item in @($render.review) | Select-Object -First 12) {
    $where = if ($item.title) { $item.title } else { '-' }
    Write-Host "      $where - $($item.what)"
  }
  Write-Host '    Upload-Bundle.ps1 refuses this bundle until they are looked at and accepted with -AcceptReview.' -ForegroundColor Yellow
}
if ($render -and $render.staleInSource) {
  Write-Host "    note: $($render.staleInSource) page(s) had stale link tables in the legacy wiki; the bundle has them rebuilt from the parse"
}
Write-Host "Files: $outDir (untracked; contains password hashes - never commit, never share)"
if ($manifest.frozen) {
  $acceptHint = if ($needsReview) { ' -AcceptReview   (after reviewing the findings above)' } else { '' }
  Write-Host "Next:  pwsh cloud/migrate/Upload-Bundle.ps1 $Stamp$acceptHint" -ForegroundColor Yellow
  Write-Host "Legacy wiki stays read-only. Undo: docker exec -u www-data $wiki rm -f $lockFile; docker compose start jobrunner"
} else {
  Write-Host 'Dry run: use it for local staging (design 4.2). The final import needs a -Freeze bundle.' -ForegroundColor Yellow
}
