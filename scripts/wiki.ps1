#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
  Westernis wiki control script (PowerShell 7 / pwsh). Run from anywhere.

.EXAMPLE
  .\scripts\wiki.ps1 init        # first run: create .env from .env.example with fresh random secrets
  .\scripts\wiki.ps1 up          # build if needed, start, bootstrap on first run
  .\scripts\wiki.ps1 down        # stop containers (data stays in Docker volumes)
  .\scripts\wiki.ps1 seed        # re-import ./content (templates, pages); add -ForceFiles to re-upload artwork
  .\scripts\wiki.ps1 sync        # push edited LocalSettings/assets/scripts/content into the running containers
  .\scripts\wiki.ps1 update      # run update.php after changing extensions
  .\scripts\wiki.ps1 backup      # dump DB + uploads + XML into ./backups/<timestamp>
  .\scripts\wiki.ps1 restore .\backups\20261005-120000
  .\scripts\wiki.ps1 logs        # follow container logs
  .\scripts\wiki.ps1 shell       # bash inside the wiki container

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'up', 'down', 'restart', 'seed', 'update', 'backup', 'restore', 'logs', 'shell', 'status', 'rebuild', 'purge-cache', 'bootstrap', 'sync')]
  [string]$Command = 'status',
  [Parameter(Position = 1)]
  [string]$Arg,
  [switch]$ForceFiles
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  function Read-DotEnv {
    $map = @{}
    Get-Content .env | Where-Object { $_ -match '^\s*[^#\s][^=]*=' } | ForEach-Object {
      $k, $v = $_ -split '=', 2
      $map[$k.Trim()] = $v.Trim()
    }
    return $map
  }
  function Assert-Ok([string]$what) {
    if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)." }
  }
  # Hex string from a cryptographic RNG ($bytes random bytes -> 2 * $bytes characters).
  function New-Secret([int]$bytes) {
    $buf = [byte[]]::new($bytes)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return -join ($buf | ForEach-Object { $_.ToString('x2') })
  }
  # Refuse to start with a missing or half-filled .env (placeholders would become real passwords).
  function Assert-DotEnv {
    if (-not (Test-Path '.env')) { throw 'Missing .env - run  pwsh ./scripts/wiki.ps1 init  (or copy .env.example to .env and fill in the passwords; see README).' }
    $cfg = Read-DotEnv
    $todo = @($cfg.Keys | Where-Object { $cfg[$_] -match '^<.*>$' } | Sort-Object)
    if ($todo.Count) { throw "Fill in .env first, these values are still placeholders: $($todo -join ', ')" }
    if (-not $cfg['WIKI_SECRET_KEY']) { throw 'WIKI_SECRET_KEY is missing in .env (see .env.example).' }
    $bot = $cfg['WIKI_BOT_PASSWORD']
    if ($bot -and $bot.Length -lt 32) { throw 'WIKI_BOT_PASSWORD in .env must be at least 32 characters (MediaWiki rule), e.g. openssl rand -hex 16.' }
  }
  # Maintenance scripts run as www-data so everything they create in images/ and cache/ stays writable for Apache.
  function Invoke-Wiki([string]$cmd) { docker compose exec -T -u www-data wiki sh -c $cmd; Assert-Ok "wiki command" }
  function Invoke-WikiRoot([string]$cmd) { docker compose exec -T wiki sh -c $cmd; Assert-Ok "wiki command (root)" }
  function Wait-Running([string]$container, [int]$tries = 40) {
    for ($i = 0; $i -lt $tries; $i++) {
      Start-Sleep -Seconds 3
      $state = (docker inspect --format '{{.State.Running}}' $container 2>&1) | Out-String
      if ($state.Trim() -eq 'true') { return $true }
    }
    return $false
  }

  switch ($Command) {
    'init' {
      if (Test-Path '.env') { throw '.env already exists; init never overwrites it. Edit it by hand, or move it away first.' }
      $lines = Get-Content '.env.example' | ForEach-Object {
        if ($_ -match '^(\s*[A-Za-z0-9_]+)=<openssl rand -hex (\d+)>\s*$') { '{0}={1}' -f $Matches[1], (New-Secret ([int]$Matches[2])) } else { $_ }
      }
      # LF line endings, no BOM (like every other file in the project)
      [IO.File]::WriteAllText((Join-Path $root '.env'), (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
      Write-Host '.env created with fresh random secrets. Review WIKI_SERVER and WIKI_ADMIN_USER, then run: pwsh ./scripts/wiki.ps1 up' -ForegroundColor Green
    }
    'up' {
      Assert-DotEnv
      docker compose up -d --build
      Assert-Ok 'docker compose up (is Docker Desktop running?)'
      Write-Host 'Waiting for the web container...' -ForegroundColor Cyan
      if (-not (Wait-Running 'westernis-wiki')) { throw 'westernis-wiki did not start; run .\scripts\wiki.ps1 logs' }
      Invoke-Wiki 'sh /scripts/wiki-bootstrap.sh'
      docker compose up -d   # (re)starts anything that waited on the first bootstrap
      Assert-Ok 'docker compose up (second pass)'
      $env = Read-DotEnv
      Write-Host "`nWesternis is up:  $($env['WIKI_SERVER'])   (also http://localhost:$($env['WIKI_HOST_PORT']))" -ForegroundColor Green
      Write-Host "Login:            $($env['WIKI_ADMIN_USER'])  /  password in .env (WIKI_ADMIN_PASSWORD)" -ForegroundColor Green
    }
    'bootstrap'   { Invoke-Wiki 'sh /scripts/wiki-bootstrap.sh' }
    'sync' {
      # Fast path: push edited files into the running containers without rebuilding.
      # Run `up` later to bake them into the image (otherwise a recreated container loses them).
      foreach ($c in 'westernis-wiki', 'westernis-jobrunner') {
        docker cp wiki/LocalSettings.php "${c}:/var/www/html/LocalSettings.php"
        if (Test-Path 'wiki/LocalSettings.local.php') { docker cp wiki/LocalSettings.local.php "${c}:/var/www/html/LocalSettings.local.php" }   # optional, untracked
        docker cp wiki/assets/. "${c}:/var/www/html/assets/"
        docker cp scripts/. "${c}:/scripts/"
        docker cp content/. "${c}:/content/"
        docker exec -u root $c sh -c "sed -i 's/\r$//' /scripts/*.sh /var/www/html/LocalSettings*.php; chown -R www-data:www-data /var/www/html/assets"   # jobrunner runs as www-data
      }
      Invoke-Wiki 'for f in /var/www/html/LocalSettings*.php; do php -l $f || exit 1; done; rm -rf /var/www/html/cache/* && php maintenance/run.php rebuildLocalisationCache --force --lang=de,en >/dev/null'
      Write-Host 'Synced into running containers (opcache picks LocalSettings up within 2 s).' -ForegroundColor Green
    }
    'down'        { docker compose down }
    'restart'     { docker compose restart wiki jobrunner }
    'rebuild'     { docker compose build --no-cache wiki; Assert-Ok 'build'; docker compose up -d; Invoke-Wiki 'php maintenance/run.php update --quick' }
    'seed' {
      $flag = if ($ForceFiles) { 'SEED_FORCE_FILES=1 ' } else { '' }
      Invoke-Wiki "${flag}sh /scripts/wiki-seed.sh"
    }
    'update'      { Invoke-Wiki 'php maintenance/run.php update --quick' }
    'purge-cache' {
      Invoke-Wiki 'rm -rf /var/www/html/cache/*; php maintenance/run.php rebuildLocalisationCache --force --lang=de,en >/dev/null; php maintenance/run.php purgeParserCache --age 1 >/dev/null; echo purged'
      docker compose restart cache
      Write-Host 'Server caches purged. In the browser use Ctrl+F5, or append ?action=purge to a page URL.'
    }
    'logs'   { docker compose logs -f --tail 100 }
    'shell'  { docker compose exec wiki bash }
    'status' { docker compose ps }
    'backup' {
      $env = Read-DotEnv
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $dir = Join-Path $root "backups\$stamp"
      New-Item -ItemType Directory -Force $dir | Out-Null
      Write-Host 'Dumping database...' -ForegroundColor Cyan
      # the password never touches the host command line: the db container reads its own environment
      cmd /c "docker compose exec -T db sh -c ""exec mariadb-dump --single-transaction --quick --routines --events -u root -p`"`$MARIADB_ROOT_PASSWORD`" `"`$MARIADB_DATABASE`""" > `"$dir\database.sql`""
      Assert-Ok 'database dump'
      Write-Host 'Archiving uploads...' -ForegroundColor Cyan
      cmd /c "docker compose exec -T wiki tar -C /var/www/html --exclude=images/thumb --exclude=images/temp -czf - images > `"$dir\images.tar.gz`""
      Assert-Ok 'uploads archive'
      Write-Host 'Writing XML content dump...' -ForegroundColor Cyan
      cmd /c "docker compose exec -T -u www-data wiki php maintenance/run.php dumpBackup --full --quiet > `"$dir\pages.xml`""
      Assert-Ok 'XML dump'
      Copy-Item .env, docker-compose.yml $dir
      Copy-Item wiki (Join-Path $dir 'wiki') -Recurse
      Copy-Item content (Join-Path $dir 'content') -Recurse
      Get-ChildItem (Join-Path $root 'backups') -Directory | Sort-Object Name -Descending | Select-Object -Skip 10 | Remove-Item -Recurse -Force
      Write-Host "Backup written to $dir" -ForegroundColor Green
    }
    'restore' {
      if (-not $Arg) { throw 'Usage: .\scripts\wiki.ps1 restore <backup-folder>' }
      if (-not (Test-Path (Join-Path $Arg 'database.sql'))) { throw "No database.sql in $Arg" }
      docker compose stop jobrunner          # no worker may touch tables while they are re-created
      try {
        Write-Host "Restoring database from $Arg\database.sql ..." -ForegroundColor Cyan
        cmd /c "docker compose exec -T db sh -c ""exec mariadb -u root -p`"`$MARIADB_ROOT_PASSWORD`" `"`$MARIADB_DATABASE`""" < `"$Arg\database.sql`""
        Assert-Ok 'database import'
        if (Test-Path (Join-Path $Arg 'images.tar.gz')) {
          Write-Host 'Restoring uploads...' -ForegroundColor Cyan
          cmd /c "docker compose exec -T wiki tar -C /var/www/html -xzf - < `"$Arg\images.tar.gz`""
          Assert-Ok 'uploads restore'
          Invoke-WikiRoot 'chown -R www-data:www-data /var/www/html/images'
        }
        docker compose restart cache          # memcached is RAM-only: a restart is a complete flush
        Invoke-Wiki 'php maintenance/run.php update --quick >/dev/null; php maintenance/run.php refreshLinks --quiet >/dev/null; rm -rf /var/www/html/cache/*'
      } finally {
        docker compose start jobrunner
      }
      Write-Host 'Restore complete.' -ForegroundColor Green
    }
  }
} finally {
  Pop-Location
}
