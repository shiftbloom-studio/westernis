#Requires -Version 7.1
<#
.SYNOPSIS
  Gives a guest their own login for the Westernis wiki on Cloudflare (or removes it).
.DESCRIPTION
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio

  1. Creates a strong random password for the guest (or keeps the account and only removes it with -Remove).
  2. Stores only its PBKDF2 hash: in the untracked .env.cloud (GATE_USERS) and as the Worker secret GATE_USERS.
  3. Restarts the wiki container so MediaWiki accepts the new name (the account is created as a normal
     editor on the guest's first sign-in; no admin rights).
  4. Shows the password ONCE in this window, for you to pass on. It is not stored anywhere in plain text.

  Usage (from the repository root):
    pwsh -File .\cloud\scripts\Add-WikiUser.ps1 -Name Rimas            # new guest, or a new password
    pwsh -File .\cloud\scripts\Add-WikiUser.ps1 -Name Rimas -Remove    # take the login away again
#>
param(
  [Parameter(Mandatory)][string]$Name,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WstCloud.psm1') -Force
$root = Get-WstRoot
$envCloudPath = Join-Path $root '.env.cloud'
$envPath = Join-Path $root '.env'
function Fail([string]$msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath $envCloudPath)) { Fail ".env.cloud not found in $root." }
$cloud = Read-WstDotEnv $envCloudPath
$main = if (Test-Path -LiteralPath $envPath) { Read-WstDotEnv $envPath } else { @{} }

# ---- the names -------------------------------------------------------------------------------------------
$display = ($Name.Replace('_', ' ').Trim() -replace ' {2,}', ' ')
if ($display -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') { Fail 'the name may use letters, digits, spaces, ".", "_" and "-" (max 64 characters).' }
$wikiUser = $display.Substring(0, 1).ToUpperInvariant() + $display.Substring(1)   # MediaWiki form
$login = $display.ToLowerInvariant()
$owner = ([string]$main['WIKI_ADMIN_USER']).Trim()
if ($owner -and $wikiUser.ToLowerInvariant() -eq $owner.Replace('_', ' ').ToLowerInvariant()) { Fail "that is your own account; use Set-Secrets.ps1 for your password." }

# ---- the list --------------------------------------------------------------------------------------------
$users = [System.Collections.Generic.List[object]]::new()
$raw = [string]$cloud['GATE_USERS']
if (-not (Test-WstUnset $raw)) {
  try { foreach ($u in @($raw | ConvertFrom-Json)) { $users.Add($u) } } catch { Fail 'GATE_USERS in .env.cloud is not valid JSON; fix or remove that line.' }
}
$existing = @($users | Where-Object { $_.login -eq $login })
foreach ($u in $existing) { [void]$users.Remove($u) }

$password = $null
if ($Remove) {
  if (-not $existing.Count) { Fail "there is no guest login '$display'." }
} else {
  # 20 characters without look-alikes (no 0/O, 1/l/I): about 115 bits
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = [byte[]]::new(20)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $password = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  $r = Invoke-WstCapture -FilePath 'node' -ArgumentList @((Join-Path $PSScriptRoot 'gate-hash.mjs')) -InputText $password
  $hash = $r.StdOut.Trim()
  if ($r.ExitCode -ne 0 -or $hash -notmatch '^pbkdf2-sha256\$100000\$') { Fail "hashing the password failed (node exit $($r.ExitCode))." }
  $users.Add([ordered]@{ login = $login; user = $wikiUser; hash = $hash })
}
$json = ConvertTo-Json -InputObject @($users) -Compress -Depth 4
if ($users.Count -eq 0) { $json = '[]' }

# ---- store locally, then on the Worker -------------------------------------------------------------------
try { Set-WstDotEnvValues -Path $envCloudPath -Values ([ordered]@{ GATE_USERS = $json }) } catch { Fail "could not save .env.cloud: $($_.Exception.Message)" }
try { $wrangler = Get-WstWrangler } catch { Fail $_.Exception.Message }
$r = Invoke-WstCapture -FilePath 'node' -ArgumentList @($wrangler, 'secret', 'put', 'GATE_USERS', '--name', 'westernis') -InputText $json -WorkingDirectory (Join-Path $root 'cloud')
if ($r.ExitCode -ne 0 -or ($r.StdOut + $r.StdErr) -notmatch 'Success') {
  $detail = Hide-WstSecrets -Text ($r.StdErr + "`n" + $r.StdOut) -Secrets @($json)
  Write-Host (@($detail -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 8) -join "`n") -ForegroundColor DarkGray
  Fail 'wrangler secret put GATE_USERS failed (saved locally; run this script again).'
}
Write-Host 'Saved on the Worker (GATE_USERS).'

# ---- restart the container so MediaWiki gets the new list of names ---------------------------------------
$token = [string]$main['WESTERNIS_API_TOKEN']
$edit = [string]$cloud['WIKI_EDIT_HOST']
if (-not (Test-WstUnset $token) -and -not (Test-WstUnset $edit)) {
  Start-Sleep -Seconds 5   # the new Worker version must be live before the restart
  try {
    $resp = Invoke-WebRequest -Uri "https://$edit/__wst/restart" -Method Post -Headers @{ 'X-Westernis-Token' = $token } -SkipHttpErrorCheck -TimeoutSec 120
    Write-Host "Wiki restarted (HTTP $($resp.StatusCode)); the next page view wakes it with the new names."
  } catch { Write-Host "Could not restart the wiki automatically ($($_.Exception.Message)); it picks the change up after its next sleep (20 min idle)." -ForegroundColor Yellow }
}

$public = [string]$cloud['WIKI_PUBLIC_HOST']
if ($Remove) {
  Write-Host "Done: '$display' can no longer sign in (existing sessions end now)." -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "Login for $wikiUser - send this to them (shown only now):" -ForegroundColor Green
  Write-Host "  Adresse:  https://$public"
  Write-Host "  Name:     $display"
  Write-Host "  Passwort: $password"
  Write-Host ''
  Write-Host 'They type the name and the password on the login page; the wiki account is created on the first sign-in.'
}
$password = $null; $json = $null
