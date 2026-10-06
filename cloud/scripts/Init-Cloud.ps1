#!/usr/bin/env pwsh
#Requires -Version 7.1
<#
.SYNOPSIS
  Renders the untracked cloud/wrangler.jsonc from cloud/wrangler.example.jsonc and the NON-SECRET keys
  of .env.cloud (docs/cloudflare-design.md, 2.2). Safe to run any time; wst.ps1 deploy runs it itself.

.DESCRIPTION
  Fills these placeholders (written as dollar-brace NAME in the template):
    CF_ACCOUNT_ID, WIKI_PUBLIC_HOST, WIKI_EDIT_HOST, R2_DB_BUCKET, R2_MEDIA_BUCKET, R2_JURISDICTION  (.env.cloud, required)
    SSH_PUBLIC_KEY   (.env.cloud, optional: when empty, the "authorized_keys" entry is left out)
    GATE_WIKI_USER   (the MediaWiki user the gate signs browsers in as: GATE_WIKI_USER from .env.cloud if set,
                      else WIKI_ADMIN_USER from .env, else "Admin" as in scripts/wiki-bootstrap.sh;
                      the placeholder WIKI_ADMIN_USER gets the same value)
  Any other placeholder in the template is refused, so a secret can never end up in wrangler.jsonc.
  Refuses missing or placeholder ("<...>") values, an edit host that is not a subdomain of the reading host
  (the gate cookie is set for the reading host's domain), and a template that names another jurisdiction.
  Prints key names only. The output file is UTF-8 without BOM, LF.

.EXAMPLE
  pwsh cloud/scripts/Init-Cloud.ps1

.NOTES
  SPDX-License-Identifier: AGPL-3.0-or-later
  SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#>
[CmdletBinding()]
param(
  [string]$EnvCloud,
  [string]$EnvFile,
  [string]$Template,
  [string]$OutFile,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WstCloud.psm1') -Force
$root = Get-WstRoot
if (-not $EnvCloud) { $EnvCloud = Join-Path $root '.env.cloud' }
if (-not $EnvFile) { $EnvFile = Join-Path $root '.env' }
if (-not $Template) { $Template = Join-Path $root 'cloud\wrangler.example.jsonc' }
if (-not $OutFile) { $OutFile = Join-Path $root 'cloud\wrangler.jsonc' }

if (-not (Test-Path -LiteralPath $EnvCloud)) { throw ".env.cloud not found ($EnvCloud). Copy .env.cloud.example to .env.cloud and fill in the non-secret values." }
if (-not (Test-Path -LiteralPath $Template)) { throw "Template not found: $Template" }
$cloud = Read-WstDotEnv $EnvCloud
$main = Read-WstDotEnv $EnvFile

# ---- values and their checks ------------------------------------------------------------------------------
$problems = [Collections.Generic.List[string]]::new()
function Get-Required([string]$key, [string]$pattern, [string]$hint) {
  $v = [string]$cloud[$key]
  if (Test-WstUnset $v) { $problems.Add("$key is missing in .env.cloud"); return '' }
  $v = $v.Trim().ToLowerInvariant()
  if ($v -notmatch $pattern) { $problems.Add("$key is not valid ($hint)"); return '' }
  return $v
}
$hostPattern = '^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
$bucketPattern = '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
$values = [ordered]@{
  CF_ACCOUNT_ID    = Get-Required 'CF_ACCOUNT_ID' '^[0-9a-f]{32}$' '32 hex characters'
  WIKI_PUBLIC_HOST = Get-Required 'WIKI_PUBLIC_HOST' $hostPattern 'a host name such as wiki.example.org, without https://'
  WIKI_EDIT_HOST   = Get-Required 'WIKI_EDIT_HOST' $hostPattern 'a host name such as edit.wiki.example.org, without https://'
  R2_DB_BUCKET     = Get-Required 'R2_DB_BUCKET' $bucketPattern 'an R2 bucket name'
  R2_MEDIA_BUCKET  = Get-Required 'R2_MEDIA_BUCKET' $bucketPattern 'an R2 bucket name'
  R2_JURISDICTION  = Get-Required 'R2_JURISDICTION' '^(eu|fedramp)$' 'eu or fedramp'
}
if ($values.WIKI_PUBLIC_HOST -and $values.WIKI_EDIT_HOST) {
  if ($values.WIKI_PUBLIC_HOST -eq $values.WIKI_EDIT_HOST) { $problems.Add('WIKI_EDIT_HOST must differ from WIKI_PUBLIC_HOST') }
  elseif (-not $values.WIKI_EDIT_HOST.EndsWith(".$($values.WIKI_PUBLIC_HOST)")) {
    $problems.Add('WIKI_EDIT_HOST must be a subdomain of WIKI_PUBLIC_HOST (e.g. edit.wiki.example.org for wiki.example.org): the gate cookie is set for the reading host and must cover the edit host')
  }
}
if ($values.R2_DB_BUCKET -and $values.R2_DB_BUCKET -eq $values.R2_MEDIA_BUCKET) { $problems.Add('R2_DB_BUCKET and R2_MEDIA_BUCKET must be two different buckets') }

$ssh = ([string]$cloud['SSH_PUBLIC_KEY']).Trim()
if (Test-WstUnset $ssh) { $ssh = '' }
elseif ($ssh -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [\x20-\x7e]*)?$' -or $ssh -match '["\\]') {
  $problems.Add('SSH_PUBLIC_KEY must be one line "ssh-ed25519 AAAA... comment" (the PUBLIC key; wrangler accepts ed25519 only), or empty')
}
$values.SSH_PUBLIC_KEY = $ssh

# The MediaWiki account the gate signs the owner in as (sent as X-Westernis-User). MediaWiki form:
# underscores are spaces, first letter upper case. ASCII only, so the header value stays byte-exact.
$user = [string]$cloud['GATE_WIKI_USER']
if (Test-WstUnset $user) { $user = [string]$main['WIKI_ADMIN_USER'] }
if (Test-WstUnset $user) { $user = 'Admin' }
$user = ($user.Replace('_', ' ').Trim() -replace ' {2,}', ' ')
if ($user.Length) { $user = $user.Substring(0, 1).ToUpperInvariant() + $user.Substring(1) }
if ($user -notmatch '^[A-Za-z0-9][A-Za-z0-9 .\-]{0,84}$') {
  $problems.Add('the wiki user name (WIKI_ADMIN_USER in .env, or GATE_WIKI_USER in .env.cloud) must be ASCII letters, digits, spaces, "." or "-"')
}
$values.GATE_WIKI_USER = $user
$values.WIKI_ADMIN_USER = $user   # same value; the template may use either placeholder name

if ($problems.Count) { throw "Init-Cloud: cannot render wrangler.jsonc:`n  - $($problems -join "`n  - ")" }

# ---- render -----------------------------------------------------------------------------------------------
$text = [IO.File]::ReadAllText($Template) -replace "`r`n", "`n"
$used = [Collections.Generic.HashSet[string]]::new()
foreach ($m in [regex]::Matches($text, '\$\{([A-Za-z0-9_]+)\}')) { [void]$used.Add($m.Groups[1].Value) }
$unknown = @($used | Where-Object { -not $values.Contains($_) } | Sort-Object)
if ($unknown.Count) { throw "Init-Cloud: the template uses placeholders this script does not fill: $($unknown -join ', '). Secrets belong in Set-Secrets.ps1, not in wrangler.jsonc." }
foreach ($k in @('CF_ACCOUNT_ID', 'WIKI_PUBLIC_HOST', 'WIKI_EDIT_HOST', 'R2_DB_BUCKET', 'R2_MEDIA_BUCKET')) {
  if (-not $used.Contains($k)) { Write-Warning "The template has no `${$k} placeholder." }
}
if (-not ($used.Contains('GATE_WIKI_USER') -or $used.Contains('WIKI_ADMIN_USER'))) {
  Write-Warning 'The template has no ${GATE_WIKI_USER} (or ${WIKI_ADMIN_USER}) placeholder: the gate cannot sign the owner into MediaWiki.'
}

if (-not $ssh) {
  # drop the whole "authorized_keys": [ ... ] entry (one or more lines) that holds the placeholder
  $text = [regex]::Replace($text, '(?m)^[ \t]*"authorized_keys"\s*:\s*\[[^\]]*\$\{SSH_PUBLIC_KEY\}[^\]]*\][ \t]*,?[ \t]*(//[^\n]*)?\n', '')
  if ($text.Contains('${SSH_PUBLIC_KEY}')) { throw 'Init-Cloud: SSH_PUBLIC_KEY is empty, but the template uses it outside an "authorized_keys" entry.' }
}
foreach ($k in $values.Keys) {
  $json = ConvertTo-Json -InputObject ([string]$values[$k]) -Compress   # escaped for a JSON string
  $text = $text.Replace("`${$k}", $json.Substring(1, $json.Length - 2))
}

# CONTAINER_IMAGE (optional, .env.cloud): deploy an image already in a registry instead of building
# cloud/image/Dockerfile (no Docker needed), e.g. registry.cloudflare.com/<account>/westernis-wikicontainer:<tag>.
$image = ([string]$cloud['CONTAINER_IMAGE']).Trim()
if (-not (Test-WstUnset $image)) {
  if ($image -cnotmatch '^[a-z0-9.-]+(/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$') { throw 'Init-Cloud: CONTAINER_IMAGE must be an image reference with a tag or digest (registry/path:tag).' }
  if ($text -notmatch '"image"\s*:\s*"[^"]*"') { throw 'Init-Cloud: the template has no "image" entry.' }
  $text = [regex]::Replace($text, '"image"\s*:\s*"[^"]*"', ('"image": "' + $image + '"'), 1)
  $text = [regex]::Replace($text, '(?m)^[ \t]*"image_build_context"[^\n]*\n', '')
}

# ---- check the result -------------------------------------------------------------------------------------
try { $cfg = $text | ConvertFrom-Json -Depth 64 } catch { throw "Init-Cloud: the rendered file is not valid JSONC: $($_.Exception.Message)" }
if ($cfg.account_id -ne $values.CF_ACCOUNT_ID) { throw 'Init-Cloud: account_id was not rendered.' }
$jurisdictions = @([regex]::Matches($text, '"jurisdiction"\s*:\s*"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
$bad = @($jurisdictions | Where-Object { $_ -ne $values.R2_JURISDICTION })
if ($bad.Count) { throw "Init-Cloud: the template binds R2 with jurisdiction '$($bad[0])' but R2_JURISDICTION is '$($values.R2_JURISDICTION)'." }
if ($text -match '\$\{') { throw 'Init-Cloud: placeholders are left in the rendered file.' }

$header = "// GENERATED by cloud/scripts/Init-Cloud.ps1 from cloud/wrangler.example.jsonc and .env.cloud.`n" +
          "// Do not edit and do not commit (it is in .gitignore): edit the template or .env.cloud and run Init-Cloud.ps1 again.`n"
$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
[IO.File]::WriteAllText($OutFile, $header + $text, [Text.UTF8Encoding]::new($false))
if (-not $Quiet) {
  Write-Host "Rendered $([IO.Path]::GetRelativePath($root, $OutFile)) from: $(@($values.Keys | Where-Object { $used.Contains($_) }) -join ', ')$(if (-not $ssh) { ' (no SSH key: ssh access off)' })" -ForegroundColor Green
}
