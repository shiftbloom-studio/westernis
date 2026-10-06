#!/usr/bin/env pwsh
#Requires -Version 7.1
<#
.SYNOPSIS
  THE one command the owner runs: sets the gate password and sends every secret to the Worker.

.DESCRIPTION
  1. Renders cloud/wrangler.jsonc (Init-Cloud.ps1) so the secrets go to the right Worker.
  2. Asks twice for the gate password (hidden input, at least 12 characters). If .env.cloud already has a
     GATE_PASSWORD_HASH, pressing Enter keeps the current password. The password is hashed by
     cloud/scripts/gate-hash.mjs (PBKDF2-SHA256, 100000 iterations, 16-byte random salt), which reads it
     from stdin; it is never stored, never on a command line and never printed.
  3. Creates SESSION_SECRET and API_TOKEN (32 random bytes each, base64url) unless .env.cloud has them
     (-Rotate makes new ones: every browser is signed out and the Forge token changes).
  4. Saves GATE_PASSWORD_HASH, SESSION_SECRET and API_TOKEN in .env.cloud and the same API token as
     WESTERNIS_API_TOKEN in .env (for the Forge MCP client and wst.ps1).
  5. Pipes all eight secrets as JSON over stdin to  wrangler secret bulk --config cloud/wrangler.jsonc:
     WIKI_SECRET_KEY (.env), R2_DB_ACCESS_KEY_ID, R2_DB_SECRET_ACCESS_KEY, R2_MEDIA_ACCESS_KEY_ID,
     R2_MEDIA_SECRET_ACCESS_KEY (.env.cloud, see Set-R2Keys.ps1), GATE_PASSWORD_HASH, SESSION_SECRET, API_TOKEN.
  Prints key names and one success or failure line, nothing else. Safe to run again at any time.
  Needs: .env, .env.cloud with the non-secret keys and the R2 keys, `npm ci` in cloud/, `wrangler login`
  done once, and the Worker deployed once (wst.ps1 deploy).

.PARAMETER Rotate
  Make a new SESSION_SECRET and API_TOKEN even if .env.cloud has them.

.EXAMPLE
  pwsh cloud/scripts/Set-Secrets.ps1

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#>
[CmdletBinding()]
param([switch]$Rotate)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WstCloud.psm1') -Force
$root = Get-WstRoot
$envCloudPath = Join-Path $root '.env.cloud'
$envPath = Join-Path $root '.env'
$config = Join-Path $root 'cloud\wrangler.jsonc'
$hashPattern = '^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$'
$tokenPattern = '^[A-Za-z0-9_-]{43,}$'

function Fail([string]$msg) {
  Write-Host "FAILED: $msg" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $envPath)) { Fail ".env not found in $root (the wiki's main settings; see .env.example)." }
if (-not (Test-Path -LiteralPath $envCloudPath)) { Fail ".env.cloud not found in $root (copy .env.cloud.example and fill in the non-secret values)." }

# ---- 1. wrangler.jsonc ------------------------------------------------------------------------------------
try { & (Join-Path $PSScriptRoot 'Init-Cloud.ps1') -Quiet } catch { Fail $_.Exception.Message }
try { $wrangler = Get-WstWrangler } catch { Fail $_.Exception.Message }

$cloud = Read-WstDotEnv $envCloudPath
$main = Read-WstDotEnv $envPath
$missing = @()
if (Test-WstUnset $main['WIKI_SECRET_KEY']) { $missing += 'WIKI_SECRET_KEY (.env)' }
foreach ($k in 'R2_DB_ACCESS_KEY_ID', 'R2_DB_SECRET_ACCESS_KEY', 'R2_MEDIA_ACCESS_KEY_ID', 'R2_MEDIA_SECRET_ACCESS_KEY') {
  if (Test-WstUnset $cloud[$k]) { $missing += "$k (.env.cloud)" }
}
if ($missing.Count) { Fail "missing values: $($missing -join ', '). R2 keys: run  pwsh cloud/scripts/Set-R2Keys.ps1  first." }

# ---- 2. gate password -------------------------------------------------------------------------------------
$hash = [string]$cloud['GATE_PASSWORD_HASH']
$canKeep = $hash -match $hashPattern
Write-Host 'Gate password for the wiki (at least 12 characters; you type it on the login page, no user name).'
$newHash = $null
for ($attempt = 1; -not $newHash; $attempt++) {
  if ($attempt -gt 3) { Fail 'no valid password after 3 attempts; nothing was changed.' }
  $prompt = if ($canKeep) { 'New gate password (Enter = keep the current one)' } else { 'Gate password' }
  $p1 = Read-Host -Prompt $prompt -MaskInput
  if ($p1 -eq '' -and $canKeep) { $newHash = $hash; Write-Host 'Keeping the current password.'; break }
  if ($p1.Length -lt 12) { Write-Host 'Too short: at least 12 characters.' -ForegroundColor Yellow; continue }
  if ($p1 -ne $p1.Trim()) { Write-Host 'The password must not start or end with a space.' -ForegroundColor Yellow; continue }
  if ($p1 -match '[\x00-\x1f\x7f]') { Write-Host 'The password must not contain control characters.' -ForegroundColor Yellow; continue }
  $p2 = Read-Host -Prompt 'Repeat the gate password' -MaskInput
  if ($p1 -cne $p2) { Write-Host 'The two entries differ, please try again.' -ForegroundColor Yellow; $p1 = $p2 = $null; continue }
  $r = Invoke-WstCapture -FilePath 'node' -ArgumentList @((Join-Path $PSScriptRoot 'gate-hash.mjs')) -InputText $p1
  $p1 = $p2 = $null
  $out = $r.StdOut.Trim()
  if ($r.ExitCode -ne 0 -or $out -notmatch $hashPattern) { Fail "hashing the password failed (node exit $($r.ExitCode))." }
  $newHash = $out
}

# ---- 3. session secret and API token ----------------------------------------------------------------------
$session = [string]$cloud['SESSION_SECRET']
$token = [string]$cloud['API_TOKEN']
$fresh = @()
if ($Rotate -or $session -notmatch $tokenPattern) { $session = New-WstToken 32; $fresh += 'SESSION_SECRET' }
if ($Rotate -or $token -notmatch $tokenPattern) { $token = New-WstToken 32; $fresh += 'API_TOKEN' }

# ---- 4. store locally (before the push: a failed push can simply be repeated) ----------------------------
try {
  Set-WstDotEnvValues -Path $envCloudPath -Values ([ordered]@{ GATE_PASSWORD_HASH = $newHash; SESSION_SECRET = $session; API_TOKEN = $token })
  Set-WstDotEnvValues -Path $envPath -Values ([ordered]@{ WESTERNIS_API_TOKEN = $token })
} catch { Fail "could not save .env.cloud / .env: $($_.Exception.Message)" }
if ($fresh.Count) { Write-Host "New: $($fresh -join ', ') (saved in .env.cloud; API token also in .env as WESTERNIS_API_TOKEN)." }

# ---- 5. wrangler secret bulk over stdin -------------------------------------------------------------------
$secrets = [ordered]@{
  WIKI_SECRET_KEY            = [string]$main['WIKI_SECRET_KEY']
  R2_DB_ACCESS_KEY_ID        = [string]$cloud['R2_DB_ACCESS_KEY_ID']
  R2_DB_SECRET_ACCESS_KEY    = [string]$cloud['R2_DB_SECRET_ACCESS_KEY']
  R2_MEDIA_ACCESS_KEY_ID     = [string]$cloud['R2_MEDIA_ACCESS_KEY_ID']
  R2_MEDIA_SECRET_ACCESS_KEY = [string]$cloud['R2_MEDIA_SECRET_ACCESS_KEY']
  GATE_PASSWORD_HASH         = $newHash
  SESSION_SECRET             = $session
  API_TOKEN                  = $token
}
$json = $secrets | ConvertTo-Json -Compress
Write-Host "Sending to the Worker: $($secrets.Keys -join ', ')"
$r = Invoke-WstCapture -FilePath 'node' -ArgumentList @($wrangler, 'secret', 'bulk', '--config', $config) -InputText $json -WorkingDirectory (Join-Path $root 'cloud')
$json = $null
# wrangler can exit 0 without having set anything (e.g. when it declined to create the Worker): require
# its confirmation line for every key.
$notConfirmed = @($secrets.Keys | Where-Object { $r.StdOut -notmatch "secret for key: $([regex]::Escape($_))(?![A-Za-z0-9_])" })
if ($r.ExitCode -ne 0 -or $notConfirmed.Count) {
  $detail = Hide-WstSecrets -Text ($r.StdErr + "`n" + $r.StdOut) -Secrets @($secrets.Values)
  $lines = @($detail -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 12)
  if ($lines.Count) { Write-Host ($lines -join "`n") -ForegroundColor DarkGray }
  $what = if ($r.ExitCode -ne 0) { "exited with $($r.ExitCode)" } else { "did not confirm: $($notConfirmed -join ', ')" }
  Fail ("wrangler secret bulk $what. No secret was printed. The values are saved locally: fix the cause " +
        '(not logged in: npx wrangler login in cloud/; Worker missing: pwsh cloud/scripts/wst.ps1 deploy) and run this script again (Enter keeps the password).')
}
Write-Host "OK: $($secrets.Count) secrets set on the Worker. Restart Claude Code so the Forge MCP picks up WESTERNIS_API_TOKEN." -ForegroundColor Green
