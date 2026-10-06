#!/usr/bin/env pwsh
#Requires -Version 7.1
<#
.SYNOPSIS
  Westernis on Cloudflare: control script (docs/cloudflare-design.md, 2.10). Run from anywhere.

.EXAMPLE
  pwsh cloud/scripts/wst.ps1 deploy            # render wrangler.jsonc, build + push the image, deploy (container rollout)
  pwsh cloud/scripts/wst.ps1 deploy-worker     # Worker and vars only (--containers-rollout=none); the container keeps running
  pwsh cloud/scripts/wst.ps1 logs              # wrangler tail (Worker and Durable Object logs)
  pwsh cloud/scripts/wst.ps1 status            # container instances + a read-only API check (wakes the wiki)
  pwsh cloud/scripts/wst.ps1 ssh [<id>]        # wrangler containers ssh into the running instance (needs SSH_PUBLIC_KEY)
  pwsh cloud/scripts/wst.ps1 restart           # POST /__wst/restart: graceful stop, final sync; the next request starts it again
  pwsh cloud/scripts/wst.ps1 backup            # newest weekly XML dump + a Litestream restore of the databases into backups/
  pwsh cloud/scripts/wst.ps1 seed [--dry-run]  # import content/ through the API (tools/forge-mcp/src/seed.js)
  Extra arguments after the command go to wrangler (deploy, deploy-worker, logs, ssh) or to seed.js (seed).

.DESCRIPTION
  Non-browser requests (status, seed, restart) carry the gate token X-Westernis-Token from WESTERNIS_API_TOKEN
  in .env (or API_TOKEN in .env.cloud) and go to https://<WIKI_EDIT_HOST>. Nothing secret is printed.
  wrangler runs from cloud/node_modules (npm ci --prefix cloud), with your `wrangler login`.

  backup options:
    -Generation <g>   Litestream generation to restore (default: WST_DB_GENERATION from cloud/wrangler.jsonc)
    -Timestamp <t>    point-in-time restore target, RFC 3339 (e.g. 2026-11-02T10:00:00Z); default: latest
    -Image <tag>      local image with Litestream and /etc/litestream.yml
                      (default westernis/mediawiki-cloud:latest; built from cloud/image/Dockerfile if missing)
    -NoDb             only download the XML dump

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#>
# A plain (not advanced) script on purpose: options such as --dry-run or --verbose must reach seed.js and
# wrangler unchanged instead of being bound to PowerShell's common parameters. -Generation, -Timestamp,
# -Image and -NoDb are picked out of the remaining arguments below.
param([string]$Command)
$ErrorActionPreference = 'Stop'
$commands = 'deploy', 'deploy-worker', 'logs', 'status', 'ssh', 'restart', 'backup', 'seed'
if ($Command -notin $commands) { throw "usage: wst.ps1 <$($commands -join ' | ')> [arguments]   (see the comment at the top of the script)" }
$Rest = [Collections.Generic.List[string]]::new()
$Generation = $null; $Timestamp = $null; $Image = 'westernis/mediawiki-cloud:latest'; $NoDb = $false
$argv = @($args | ForEach-Object { [string]$_ })
for ($i = 0; $i -lt $argv.Count; $i++) {
  $a = $argv[$i]
  if ($a -in '-Generation', '-Timestamp', '-Image') {
    if ($i + 1 -ge $argv.Count) { throw "$a needs a value" }
    $v = $argv[++$i]
    switch ($a) { '-Generation' { $Generation = $v } '-Timestamp' { $Timestamp = $v } '-Image' { $Image = $v } }
  } elseif ($a -eq '-NoDb') { $NoDb = $true }
  else { $Rest.Add($a) }
}
$Rest = @($Rest)
Import-Module (Join-Path $PSScriptRoot 'WstCloud.psm1') -Force
$root = Get-WstRoot
$cloudDir = Join-Path $root 'cloud'
$config = Join-Path $cloudDir 'wrangler.jsonc'
$envCloudPath = Join-Path $root '.env.cloud'
if (-not (Test-Path -LiteralPath $envCloudPath)) { throw ".env.cloud not found in $root (copy .env.cloud.example)." }
$cloud = Read-WstDotEnv $envCloudPath
$main = Read-WstDotEnv (Join-Path $root '.env')
$editHost = ([string]$cloud['WIKI_EDIT_HOST']).Trim().ToLowerInvariant()

function Initialize-Config { & (Join-Path $PSScriptRoot 'Init-Cloud.ps1') -Quiet }

# wrangler from cloud/node_modules, attached to this console (prompts, tail and ssh stay interactive)
function Invoke-Wrangler([string[]]$Arguments) {
  $js = Get-WstWrangler
  Push-Location $cloudDir
  try { & node $js @Arguments } finally { Pop-Location }
  if ($LASTEXITCODE) { throw "wrangler $($Arguments[0]) failed (exit $LASTEXITCODE)." }
}

function Get-ApiToken {
  $t = [string]$main['WESTERNIS_API_TOKEN']
  if (Test-WstUnset $t) { $t = [string]$cloud['API_TOKEN'] }
  if (Test-WstUnset $t) { throw 'No API token: run  pwsh cloud/scripts/Set-Secrets.ps1  first (it writes WESTERNIS_API_TOKEN into .env).' }
  return $t
}

function Assert-EditHost {
  if (Test-WstUnset $editHost) { throw 'WIKI_EDIT_HOST is missing in .env.cloud.' }
}

# Runs a Forge script (status.js, seed.js) against the cloud edit host with the gate token. The token goes
# to the child through its environment, never on a command line.
function Invoke-Forge([string]$script, [string[]]$Arguments) {
  Assert-EditHost
  $saved = @{ WIKI_API = $env:WIKI_API; WESTERNIS_API_TOKEN = $env:WESTERNIS_API_TOKEN }
  try {
    $env:WIKI_API = "https://$editHost/api.php"
    $env:WESTERNIS_API_TOKEN = Get-ApiToken
    & node (Join-Path $root "tools\forge-mcp\src\$script") @Arguments
    if ($LASTEXITCODE) { throw "$script failed (exit $LASTEXITCODE)." }
  } finally {
    $env:WIKI_API = $saved.WIKI_API
    $env:WESTERNIS_API_TOKEN = $saved.WESTERNIS_API_TOKEN
  }
}

# The container application of this Worker and its instances, from `wrangler containers ... --json`.
function Get-ContainerInstances {
  $js = Get-WstWrangler
  $worker = (Get-Content -Raw $config | ConvertFrom-Json -Depth 64).name
  $list = Invoke-WstCapture -FilePath 'node' -ArgumentList @($js, 'containers', 'list', '--json', '--config', $config) -WorkingDirectory $cloudDir
  if ($list.ExitCode) { throw "wrangler containers list failed: $(($list.StdErr + $list.StdOut).Trim())" }
  $apps = @($list.StdOut | ConvertFrom-Json -Depth 64)
  $app = $apps | Where-Object { $_.name -eq "$worker-wikicontainer" } | Select-Object -First 1
  if (-not $app) { $app = $apps | Where-Object { $_.name -like "$worker-*" } | Select-Object -First 1 }
  if (-not $app) { return [pscustomobject]@{ App = $null; Instances = @() } }
  $inst = Invoke-WstCapture -FilePath 'node' -ArgumentList @($js, 'containers', 'instances', $app.id, '--json', '--config', $config) -WorkingDirectory $cloudDir
  if ($inst.ExitCode) { throw "wrangler containers instances failed: $(($inst.StdErr + $inst.StdOut).Trim())" }
  return [pscustomobject]@{ App = $app; Instances = @(($inst.StdOut | ConvertFrom-Json -Depth 64).instances) }
}

switch ($Command) {
  'deploy' {
    Initialize-Config
    Write-Host 'Deploying the Worker and the container image (Docker Desktop must be running; the first push takes minutes) ...' -ForegroundColor Cyan
    Invoke-Wrangler (@('deploy', '--config', $config) + $Rest)
    if (Test-WstUnset $cloud['GATE_PASSWORD_HASH']) {
      Write-Host 'Next: pwsh cloud/scripts/Set-Secrets.ps1  (until then the Worker answers 503 "noch nicht eingerichtet").' -ForegroundColor Yellow
    }
  }
  'deploy-worker' {
    Initialize-Config
    Invoke-Wrangler (@('deploy', '--config', $config, '--containers-rollout=none') + $Rest)
    Write-Host 'A running container keeps its old environment until its next start (sleep, or: wst.ps1 restart).' -ForegroundColor DarkGray
  }
  'logs' {
    Initialize-Config
    Invoke-Wrangler (@('tail', '--config', $config, '--format', 'pretty') + $Rest)
  }
  'status' {
    Initialize-Config
    $c = Get-ContainerInstances
    if (-not $c.App) { Write-Host 'Container application: not found (not deployed yet?)' -ForegroundColor Yellow }
    else {
      Write-Host "Container application: $($c.App.name) ($($c.App.state))"
      if (-not $c.Instances.Count) { Write-Host '  no instances' }
      foreach ($i in $c.Instances) { Write-Host ("  {0}  {1,-10} {2}  version {3}" -f $i.id, $i.state, $i.location, $i.version) }
    }
    Write-Host ''
    Invoke-Forge 'status.js' @()
  }
  'ssh' {
    Initialize-Config
    if (Test-WstUnset $cloud['SSH_PUBLIC_KEY']) { throw 'SSH_PUBLIC_KEY is empty in .env.cloud: add your public ed25519 key and run wst.ps1 deploy-worker once.' }
    $id = $null
    if ($Rest.Count -and $Rest[0] -notlike '-*') { $id = $Rest[0]; $Rest = @($Rest | Select-Object -Skip 1) }
    if (-not $id) {
      $c = Get-ContainerInstances
      $running = @($c.Instances | Where-Object { $_.state -match 'running|healthy|active' })
      if (-not $running.Count) { throw 'No running instance (the wiki sleeps). Open the wiki or run wst.ps1 status to wake it, then try again.' }
      $id = $running[0].id
    }
    Invoke-Wrangler (@('containers', 'ssh', $id, '--config', $config) + $Rest)
  }
  'restart' {
    Assert-EditHost
    $url = "https://$editHost/__wst/restart"
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(15)     # the Worker waits for the graceful stop (up to 12 min)
    try {
      $req = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $url)
      [void]$req.Headers.TryAddWithoutValidation('X-Westernis-Token', (Get-ApiToken))
      [void]$req.Headers.TryAddWithoutValidation('User-Agent', 'Westernis-wst.ps1')
      Write-Host "POST $url (graceful stop with final sync; this can take a few minutes) ..." -ForegroundColor Cyan
      $resp = $client.SendAsync($req).GetAwaiter().GetResult()
      $status = [int]$resp.StatusCode
      $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult().Trim()
      $location = if ($resp.Headers.Location) { $resp.Headers.Location.ToString() } else { '' }
    } finally { $client.Dispose() }
    if ($status -in 200, 202) { Write-Host "HTTP ${status}: $body" -ForegroundColor Green }
    elseif ($status -eq 401 -or ($status -in 301, 302, 303, 307, 308 -and $location -match '/__wst/login')) {
      throw "The gate refused the token (HTTP $status): WESTERNIS_API_TOKEN in .env does not match the Worker secret API_TOKEN. Run cloud/scripts/Set-Secrets.ps1."
    } else {
      $text = ($body -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim()
      throw "Restart failed: HTTP $status $($text.Substring(0, [Math]::Min(300, $text.Length)))"
    }
  }
  'backup' {
    Initialize-Config
    $bucket = [string]$cloud['R2_DB_BUCKET']
    $jur = [string]$cloud['R2_JURISDICTION']
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir = Join-Path $root "backups\cloud-$stamp"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $jurArgs = if (Test-WstUnset $jur) { @() } else { @('--jurisdiction', $jur) }

    # 1. the newest weekly XML dump (dumps/latest names it, with sha256 and size)
    Write-Host 'Downloading the newest XML dump ...' -ForegroundColor Cyan
    $latest = Join-Path $dir 'latest.json'
    Invoke-Wrangler (@('r2', 'object', 'get', "$bucket/dumps/latest", '--remote', '--file', $latest) + $jurArgs)
    $meta = Get-Content -Raw $latest | ConvertFrom-Json
    if ($meta.key -notmatch '^dumps/[0-9-]+\.xml\.gz$') { throw "dumps/latest names an unexpected key: $($meta.key)" }
    $dump = Join-Path $dir (Split-Path -Leaf $meta.key)
    Invoke-Wrangler (@('r2', 'object', 'get', "$bucket/$($meta.key)", '--remote', '--file', $dump) + $jurArgs)
    $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant()
    if ($sha -ne $meta.sha256 -or (Get-Item $dump).Length -ne [int64]$meta.bytes) { throw "$($meta.key): checksum or size differs from dumps/latest." }
    Write-Host "  $($meta.key) ($($meta.bytes) bytes, sha256 ok, written $($meta.at))"

    # 2. a Litestream restore of the two databases, in a throwaway container (no bind mount: docker cp)
    if (-not $NoDb) {
      if (-not $Generation) {
        $Generation = (Get-Content -Raw $config | ConvertFrom-Json -Depth 64).vars.WST_DB_GENERATION
      }
      if ($Generation -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid generation: $Generation" }
      if ($Timestamp -and $Timestamp -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$') { throw "Timestamp must be RFC 3339, e.g. 2026-11-02T10:00:00Z" }
      foreach ($k in 'CF_ACCOUNT_ID', 'R2_DB_ACCESS_KEY_ID', 'R2_DB_SECRET_ACCESS_KEY') { if (Test-WstUnset $cloud[$k]) { throw "$k is missing in .env.cloud." } }
      docker image inspect $Image *> $null
      if ($LASTEXITCODE) {
        Write-Host "Building $Image (once; takes several minutes) ..." -ForegroundColor Cyan
        docker build --platform linux/amd64 -f (Join-Path $cloudDir 'image\Dockerfile') -t $Image $root
        if ($LASTEXITCODE) { throw 'docker build failed (is Docker Desktop running?).' }
      }
      $name = "wst-backup-$stamp"
      $ts = if ($Timestamp) { "-timestamp $Timestamp" } else { '' }
      $sh = 'set -e; mkdir -p /tmp/wst-backup; for db in westernis westernis_cargo; do ' +
            "litestream restore -config /etc/litestream.yml -integrity-check quick $ts -o /tmp/wst-backup/`$db.sqlite /var/lib/westernis/db/`$db.sqlite; done"
      $vars = @{
        R2_ACCOUNT_ID = $cloud['CF_ACCOUNT_ID']; R2_DB_BUCKET = $bucket; WST_DB_GENERATION = $Generation
        LITESTREAM_ACCESS_KEY_ID = $cloud['R2_DB_ACCESS_KEY_ID']; LITESTREAM_SECRET_ACCESS_KEY = $cloud['R2_DB_SECRET_ACCESS_KEY']
      }
      $saved = @{}
      try {
        foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, [string]$vars[$k]) }
        Write-Host "Restoring generation $Generation$(if ($Timestamp) { " at $Timestamp" }) from R2 ..." -ForegroundColor Cyan
        # -e NAME without a value: docker takes the value from this process's environment, not from the command line
        docker run --name $name --platform linux/amd64 --entrypoint /bin/sh `
          -e R2_ACCOUNT_ID -e R2_DB_BUCKET -e WST_DB_GENERATION -e LITESTREAM_ACCESS_KEY_ID -e LITESTREAM_SECRET_ACCESS_KEY `
          $Image -c $sh
        if ($LASTEXITCODE) { throw 'litestream restore failed (see the output above).' }
        docker cp "${name}:/tmp/wst-backup/." (Join-Path $dir 'db')
        if ($LASTEXITCODE) { throw 'docker cp failed.' }
      } finally {
        foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
        docker rm -f $name *> $null
      }
      Get-ChildItem (Join-Path $dir 'db') | ForEach-Object { Write-Host "  db/$($_.Name) ($($_.Length) bytes)" }
    }
    Write-Host "Backup written to $dir (it holds password hashes: keep it private)." -ForegroundColor Green
  }
  'seed' {
    Invoke-Forge 'seed.js' $Rest
  }
}
