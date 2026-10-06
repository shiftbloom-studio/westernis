<#
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio

  Shared helpers of the Westernis cloud scripts (Init-Cloud.ps1, Set-Secrets.ps1, wst.ps1).
  Nothing here prints a value read from .env or .env.cloud.
#>
Set-StrictMode -Version 3.0

function Get-WstRoot {
  (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

# KEY=value lines of a dotenv file (comments and blank lines skipped, surrounding quotes removed).
function Read-WstDotEnv {
  param([Parameter(Mandatory)][string]$Path)
  $map = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
      $v = $Matches[2].Trim()
      if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
      $map[$Matches[1]] = $v
    }
  }
  return $map
}

# Replaces KEY=... lines (or appends them) and writes the file back with LF endings, UTF-8 without BOM.
# Other lines, comments and their order stay as they are. Values must be single-line.
function Set-WstDotEnvValues {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][System.Collections.IDictionary]$Values)
  $lines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $Path) {
    $text = [IO.File]::ReadAllText($Path)
    if ($text.Length) { foreach ($l in ($text -replace "`r`n", "`n").TrimEnd("`n").Split("`n")) { $lines.Add($l) } }
  }
  foreach ($k in $Values.Keys) {
    $v = [string]$Values[$k]
    if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Invalid key name: $k" }
    if ($v -match "[`r`n]") { throw "Value for $k must be a single line" }
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*$([regex]::Escape($k))\s*=") {
        if ($done) { $lines.RemoveAt($i); $i-- } else { $lines[$i] = "$k=$v"; $done = $true }
      }
    }
    if (-not $done) { $lines.Add("$k=$v") }
  }
  $tmp = "$Path.tmp-$PID"
  [IO.File]::WriteAllText($tmp, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# True for an empty value or a "<...>" placeholder from an example file.
function Test-WstUnset {
  param([AllowNull()][AllowEmptyString()][string]$Value)
  return [string]::IsNullOrWhiteSpace($Value) -or $Value -match '^<.*>$'
}

# $Bytes random bytes from the OS CSPRNG as base64url without padding (32 bytes -> 43 characters).
function New-WstToken {
  param([int]$Bytes = 32)
  $buf = [Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)
  return [Convert]::ToBase64String($buf).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Path of the project-local wrangler CLI (cloud/node_modules); never an npx download.
function Get-WstWrangler {
  $js = Join-Path (Get-WstRoot) 'cloud\node_modules\wrangler\bin\wrangler.js'
  if (-not (Test-Path -LiteralPath $js)) { throw "wrangler is not installed in cloud/: run  npm ci --prefix cloud  first." }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not on PATH (Node.js 22 or newer is required).' }
  return $js
}

# Runs a program with optional stdin text (UTF-8, written exactly, then closed) and captures stdout and
# stderr. Nothing is echoed. Returns @{ ExitCode; StdOut; StdErr }.
function Invoke-WstCapture {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [AllowNull()][string]$InputText = $null,
    [string]$WorkingDirectory = (Get-WstRoot),
    [hashtable]$Environment = @{}
  )
  $psi = [Diagnostics.ProcessStartInfo]::new($FilePath)
  foreach ($a in $ArgumentList) { $psi.ArgumentList.Add($a) }
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  foreach ($k in $Environment.Keys) { $psi.Environment[$k] = [string]$Environment[$k] }
  $p = [Diagnostics.Process]::Start($psi)
  try {
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if ($null -ne $InputText) {
      $bytes = [Text.UTF8Encoding]::new($false).GetBytes($InputText)
      $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
      $p.StandardInput.BaseStream.Flush()
    }
    $p.StandardInput.Close()
    $p.WaitForExit()
    return @{ ExitCode = $p.ExitCode; StdOut = $out.GetAwaiter().GetResult(); StdErr = $err.GetAwaiter().GetResult() }
  } finally { $p.Dispose() }
}

# Removes every occurrence of the given secret values (8+ characters) from a text before it is shown.
function Hide-WstSecrets {
  param([AllowNull()][AllowEmptyString()][string]$Text, [string[]]$Secrets = @())
  if (-not $Text) { return '' }
  foreach ($s in ($Secrets | Where-Object { $_ -and $_.Length -ge 8 } | Sort-Object Length -Descending)) {
    $Text = $Text.Replace($s, '***')
  }
  return $Text
}

Export-ModuleMember -Function Get-WstRoot, Read-WstDotEnv, Set-WstDotEnvValues, Test-WstUnset, New-WstToken, Get-WstWrangler, Invoke-WstCapture, Hide-WstSecrets
