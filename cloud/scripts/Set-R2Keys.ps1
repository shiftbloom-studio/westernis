#Requires -Version 7.1
<#
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio

  Asks for the two bucket-scoped R2 keys (hidden input), stores them in the untracked .env.cloud
  and tests them. Values are never printed or passed on a command line.
  Usage (from the repo root):  pwsh -File .\cloud\scripts\Set-R2Keys.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$file = Join-Path $root '.env.cloud'
if (-not (Test-Path $file)) { throw ".env.cloud not found in $root" }

$keys = [ordered]@{
  'R2_DB_ACCESS_KEY_ID'        = 'westernis-db     -> Access Key ID'
  'R2_DB_SECRET_ACCESS_KEY'    = 'westernis-db     -> Secret Access Key'
  'R2_MEDIA_ACCESS_KEY_ID'     = 'westernis-media  -> Access Key ID'
  'R2_MEDIA_SECRET_ACCESS_KEY' = 'westernis-media  -> Secret Access Key'
}
$values = @{}
foreach ($k in $keys.Keys) {
  do { $v = (Read-Host -Prompt $keys[$k] -MaskInput).Trim() } while (-not $v)
  $values[$k] = $v
}

$lines = Get-Content -LiteralPath $file
foreach ($k in $values.Keys) {
  $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]] { param($l) $l -match "^$k=" })
  if ($i -ge 0) { $lines[$i] = "$k=$($values[$k])" } else { $lines += "$k=$($values[$k])" }
}
[IO.File]::WriteAllText($file, (($lines -join "`n") + "`n"))
Write-Host 'Saved to .env.cloud. Testing the keys ...'
node (Join-Path $root 'cloud\scripts\check-r2-keys.mjs')
