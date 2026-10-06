#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
  Uploads a migration bundle to R2: <R2_DB_BUCKET>/import/<stamp>/ (docs/cloudflare-design.md, 2.9 and 4.4).

.DESCRIPTION
  Uses `wrangler r2 object put --remote --jurisdiction <R2_JURISDICTION>` with the owner's wrangler login
  (OAuth): no S3 keys on this PC. Before anything is sent, every file is checked against manifest.json
  (sha256, size) and the manifest's own checks must be ok. The three data files go first, manifest.json last,
  so a complete manifest in R2 means a complete bundle. -Verify downloads each object again and compares
  its sha256.

  First boot then imports it with WST_BOOTSTRAP=import:<stamp> (design 4.5). The bucket is private and its
  import/ prefix expires after 30 days; delete the prefix earlier once the import is verified (the database
  holds password hashes):
    npx wrangler r2 object delete <bucket>/import/<stamp>/<file> --remote --jurisdiction eu   (each of the 4 files)

.PARAMETER Stamp
  The bundle in cloud/migrate/out/<stamp>/ (from Export-Bundle.ps1).
.PARAMETER Verify
  Download every uploaded object again and compare its sha256.
.PARAMETER AllowUnfrozen
  Also upload a dry-run bundle (made without -Freeze). Only for tests: the real import needs a frozen bundle,
  and the container's first boot refuses an unfrozen one unless WST_ALLOW_UNFROZEN=1 is set as well.
.PARAMETER AcceptReview
  Upload although the render check recorded findings of the "review" class (manifest.json
  checks.render.reviewOk = false: a page renders differently on SQLite, or Cargo rows differ). Look at
  cloud/migrate/out/<stamp>/reports/render-check.json first; Export-Bundle.ps1 lists them at the end.

.EXAMPLE
  pwsh cloud/migrate/Upload-Bundle.ps1 20261006-120000 -Verify

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
  Reads only CF_ACCOUNT_ID, R2_DB_BUCKET (default westernis-db) and R2_JURISDICTION (default eu) from the
  untracked .env.cloud and prints none of them except the bucket name. Needs `npm ci` in cloud/ (wrangler).
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
  [string]$Stamp,
  [switch]$Verify,
  [switch]$AllowUnfrozen,
  [switch]$AcceptReview
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cloud = Join-Path $root 'cloud'
$dir = Join-Path $root "cloud\migrate\out\$Stamp"
$maxBytes = 315MB    # wrangler r2 object put limit
# Upload order: data first, manifest.json last
$files = [ordered]@{
  'westernis.sqlite'       = 'application/vnd.sqlite3'
  'westernis_cargo.sqlite' = 'application/vnd.sqlite3'
  'images.tar.gz'          = 'application/gzip'
  'manifest.json'          = 'application/json'
}

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Read-DotEnv([string]$path, [string[]]$keys) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=(.*)$' -and $keys -contains $Matches[1]) {
      $map[$Matches[1]] = $Matches[2].Trim().Trim('"')
    }
  }
  return $map
}
# Runs the project's wrangler (cloud/node_modules) and returns its exit code; its output goes to the console only.
function Invoke-Wrangler([string[]]$WranglerArgs) {
  Push-Location $cloud
  try { & npx --no wrangler @WranglerArgs | Out-Host } finally { Pop-Location }
  return $LASTEXITCODE
}

# ---- local checks -----------------------------------------------------------------------------------------
if (-not (Test-Path $dir)) { throw "No bundle at $dir (run Export-Bundle.ps1 first)." }
$manifest = Get-Content -Raw (Join-Path $dir 'manifest.json') | ConvertFrom-Json -AsHashtable
if ($manifest.stamp -ne $Stamp) { throw "manifest.json names bundle '$($manifest.stamp)', not '$Stamp'." }
if ($manifest.frozen -ne $true -and -not $AllowUnfrozen) {
  throw 'This is a dry-run bundle (made without -Freeze). The real import needs a frozen one; pass -AllowUnfrozen only for tests.'
}
if ($manifest.checks.counts.ok -ne $true -or $manifest.checks.xml.pages.identical -ne $true -or $manifest.checks.xml.logs.identical -ne $true) {
  throw 'manifest.json does not record passed count and XML checks.'
}
$render = $manifest.checks.render
if (-not $render -or $render.ok -ne $true) {
  throw 'manifest.json does not record a passed render check (bundle from an older export? Export it again).'
}
if ($render.reviewOk -ne $true) {
  $list = (@($render.review) | Select-Object -First 8 | ForEach-Object { "  $(if ($_.title) { $_.title } else { '-' }) - $($_.what)" }) -join [Environment]::NewLine
  if (-not $AcceptReview) {
    throw ("The render check left $($render.reviewCount) finding(s) to review (cloud/migrate/out/$Stamp/reports/render-check.json):" + [Environment]::NewLine + $list +
      [Environment]::NewLine + 'Look at them, fix the legacy pages if needed and export again, or pass -AcceptReview to upload anyway.')
  }
  Write-Warning "Uploading with $($render.reviewCount) accepted render finding(s) (-AcceptReview)."
}
Write-Step "Checking $dir against manifest.json"
foreach ($name in $files.Keys) {
  $path = Join-Path $dir $name
  if (-not (Test-Path $path)) { throw "Missing $path" }
  $len = (Get-Item $path).Length
  if ($len -gt $maxBytes) { throw "$name is $len bytes; wrangler uploads at most 315 MB per object." }
  if ($name -eq 'manifest.json') { continue }
  $want = $manifest.files[$name]
  $sha = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
  if (-not $want -or $sha -ne $want.sha256 -or $len -ne [long]$want.bytes) { throw "$name does not match manifest.json." }
  Write-Host ('    {0,-24} {1,12:N0} bytes  sha256 ok' -f $name, $len)
}
if (-not (Test-Path (Join-Path $cloud 'node_modules\wrangler'))) { throw "wrangler is not installed: run 'npm ci' in $cloud." }

$cfg = Read-DotEnv (Join-Path $root '.env.cloud') @('CF_ACCOUNT_ID', 'R2_DB_BUCKET', 'R2_JURISDICTION')
$bucket = if ($cfg['R2_DB_BUCKET']) { $cfg['R2_DB_BUCKET'] } else { 'westernis-db' }
$jurisdiction = if ($cfg['R2_JURISDICTION']) { $cfg['R2_JURISDICTION'] } else { 'eu' }
if ($bucket -notmatch '^[a-z0-9][a-z0-9-]{1,62}$') { throw 'R2_DB_BUCKET in .env.cloud is not a valid bucket name.' }
if ($jurisdiction -notmatch '^[a-z]+$') { throw 'R2_JURISDICTION in .env.cloud is not valid.' }
$prefix = "import/$Stamp"

# ---- upload -----------------------------------------------------------------------------------------------
$oldAccount = $env:CLOUDFLARE_ACCOUNT_ID
if ($cfg['CF_ACCOUNT_ID']) { $env:CLOUDFLARE_ACCOUNT_ID = $cfg['CF_ACCOUNT_ID'] }   # picks the account; not printed
try {
  Write-Step "Uploading to $bucket/$prefix/ (jurisdiction $jurisdiction)"
  foreach ($name in $files.Keys) {
    $key = "$bucket/$prefix/$name"
    if (-not $PSCmdlet.ShouldProcess($key, 'wrangler r2 object put')) { continue }
    $code = Invoke-Wrangler @('r2', 'object', 'put', $key, '--file', (Join-Path $dir $name), '--content-type', $files[$name],
      '--remote', '--jurisdiction', $jurisdiction)
    if ($code) { throw "Upload of $name failed (wrangler exit $code). Uploaded files stay in $bucket/$prefix/ until you rerun or delete them." }
  }

  if ($Verify -and -not $WhatIfPreference) {
    Write-Step 'Downloading every object again to compare sha256'
    $tmp = Join-Path $dir '.verify'
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
      foreach ($name in $files.Keys) {
        $copy = Join-Path $tmp $name
        $code = Invoke-Wrangler @('r2', 'object', 'get', "$bucket/$prefix/$name", '--file', $copy, '--remote', '--jurisdiction', $jurisdiction)
        if ($code) { throw "Download of $name failed (wrangler exit $code)." }
        $a = (Get-FileHash -Algorithm SHA256 -Path $copy).Hash
        $b = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $dir $name)).Hash
        if ($a -ne $b) { throw "$name in R2 differs from the local file." }
        Write-Host "    $name ok"
      }
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
} finally {
  $env:CLOUDFLARE_ACCOUNT_ID = $oldAccount
}

Write-Host ''
if ($WhatIfPreference) { Write-Host 'WhatIf: nothing was uploaded.' -ForegroundColor Yellow; return }
Write-Host "Bundle $Stamp is in $bucket/$prefix/ (private bucket; import/ expires after 30 days)." -ForegroundColor Green
Write-Host "Next (design 4.5): deploy with WST_BOOTSTRAP=import:$Stamp. After the verified import delete $prefix/ (it holds password hashes)."
