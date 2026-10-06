// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// render-config.mjs — renders the untracked cloud/wrangler.jsonc from cloud/wrangler.example.jsonc.
// The Node twin of Init-Cloud.ps1 (same checks), for Cloudflare Workers Builds, which has no PowerShell.
//
// Values come from the environment first (Workers Builds: Settings > Builds > Build variables), then from
// .env.cloud and .env next to the repository root (local use). Only non-secret values are rendered; secrets
// stay Worker secrets (Set-Secrets.ps1).
//
//   node cloud/scripts/render-config.mjs [--out <file>]
//
// Keys: CF_ACCOUNT_ID, WIKI_PUBLIC_HOST, WIKI_EDIT_HOST, R2_DB_BUCKET, R2_MEDIA_BUCKET, R2_JURISDICTION,
//       GATE_WIKI_USER (or WIKI_ADMIN_USER), SSH_PUBLIC_KEY (optional; empty = no SSH access).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const template = join(root, 'cloud', 'wrangler.example.jsonc');
const outArg = process.argv.indexOf('--out');
const outFile = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(root, 'cloud', 'wrangler.jsonc');

const readDotEnv = (file) => {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z0-9_]+\s*=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));
};
const cloud = readDotEnv(join(root, '.env.cloud'));
const main = readDotEnv(join(root, '.env'));
const unset = (v) => v === undefined || v === null || String(v).trim() === '' || /^<.*>$/.test(String(v).trim());
const pick = (k, ...more) => {
  for (const src of [process.env, cloud, main]) for (const key of [k, ...more]) if (!unset(src[key])) return String(src[key]).trim();
  return '';
};

const problems = [];
const required = (k, re, hint) => {
  const v = pick(k);
  if (!v) problems.push(`${k} is missing (${hint})`);
  else if (!re.test(v)) problems.push(`${k} is not valid (${hint})`);
  return v;
};
const host = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const bucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const values = {
  CF_ACCOUNT_ID: required('CF_ACCOUNT_ID', /^[0-9a-f]{32}$/, '32 hex characters'),
  WIKI_PUBLIC_HOST: required('WIKI_PUBLIC_HOST', host, 'a host name such as wiki.example.org, without https://'),
  WIKI_EDIT_HOST: required('WIKI_EDIT_HOST', host, 'a host name such as edit.wiki.example.org, without https://'),
  R2_DB_BUCKET: required('R2_DB_BUCKET', bucket, 'an R2 bucket name'),
  R2_MEDIA_BUCKET: required('R2_MEDIA_BUCKET', bucket, 'an R2 bucket name'),
  R2_JURISDICTION: required('R2_JURISDICTION', /^(eu|fedramp)$/, 'eu or fedramp'),
};
if (values.WIKI_PUBLIC_HOST && values.WIKI_EDIT_HOST) {
  if (values.WIKI_PUBLIC_HOST === values.WIKI_EDIT_HOST) problems.push('WIKI_EDIT_HOST must differ from WIKI_PUBLIC_HOST');
  else if (!values.WIKI_EDIT_HOST.endsWith(`.${values.WIKI_PUBLIC_HOST}`)) {
    problems.push('WIKI_EDIT_HOST must be a subdomain of WIKI_PUBLIC_HOST: the gate cookie is set for the reading host and must cover the edit host');
  }
}
if (values.R2_DB_BUCKET && values.R2_DB_BUCKET === values.R2_MEDIA_BUCKET) problems.push('R2_DB_BUCKET and R2_MEDIA_BUCKET must be two different buckets');

const ssh = pick('SSH_PUBLIC_KEY');
if (ssh && (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [\x20-\x7e]*)?$/.test(ssh) || /["\\]/.test(ssh))) {
  problems.push('SSH_PUBLIC_KEY must be one line "ssh-ed25519 AAAA... comment" (the PUBLIC key), or empty');
}
values.SSH_PUBLIC_KEY = ssh;

// The MediaWiki account the gate signs the owner in as (X-Westernis-User), in MediaWiki form, ASCII only.
let user = pick('GATE_WIKI_USER', 'WIKI_ADMIN_USER') || 'Admin';
user = user.replace(/_/g, ' ').trim().replace(/ {2,}/g, ' ');
if (user) user = user[0].toUpperCase() + user.slice(1);
if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,84}$/.test(user)) problems.push('the wiki user name (GATE_WIKI_USER or WIKI_ADMIN_USER) must be ASCII letters, digits, spaces, "." or "-"');
values.GATE_WIKI_USER = user;
values.WIKI_ADMIN_USER = user;

if (problems.length) {
  console.error(`render-config: cannot render wrangler.jsonc:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

let text = readFileSync(template, 'utf8').replace(/\r\n/g, '\n');
const used = new Set([...text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));
const unknown = [...used].filter((k) => !(k in values)).sort();
if (unknown.length) {
  console.error(`render-config: the template uses placeholders this script does not fill: ${unknown.join(', ')}`);
  process.exit(1);
}
if (!ssh) {
  text = text.replace(/^[ \t]*"authorized_keys"\s*:\s*\[[^\]]*\$\{SSH_PUBLIC_KEY\}[^\]]*\][ \t]*,?[ \t]*(\/\/[^\n]*)?\n/m, '');
  if (text.includes('${SSH_PUBLIC_KEY}')) { console.error('render-config: SSH_PUBLIC_KEY is empty, but the template uses it outside "authorized_keys"'); process.exit(1); }
}
for (const [k, v] of Object.entries(values)) text = text.split(`\${${k}}`).join(JSON.stringify(String(v)).slice(1, -1));

// check: valid JSONC (strip comments outside strings), account and jurisdictions rendered
let json = '', inStr = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (inStr) { json += c; if (c === '\\') { json += text[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
  if (c === '"') { inStr = true; json += c; continue; }
  if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; json += '\n'; continue; }
  if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
  json += c;
}
let cfg;
try { cfg = JSON.parse(json.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { console.error(`render-config: the rendered file is not valid JSONC: ${e.message}`); process.exit(1); }
if (cfg.account_id !== values.CF_ACCOUNT_ID) { console.error('render-config: account_id was not rendered'); process.exit(1); }
const bad = [...text.matchAll(/"jurisdiction"\s*:\s*"([^"]*)"/g)].map((m) => m[1]).filter((j) => j !== values.R2_JURISDICTION);
if (bad.length) { console.error(`render-config: the template binds R2 with jurisdiction '${bad[0]}' but R2_JURISDICTION is '${values.R2_JURISDICTION}'`); process.exit(1); }
if (text.includes('${')) { console.error('render-config: placeholders are left in the rendered file'); process.exit(1); }

const header = '// GENERATED by cloud/scripts/render-config.mjs (or Init-Cloud.ps1) from cloud/wrangler.example.jsonc.\n' +
  '// Do not edit and do not commit (it is in .gitignore): edit the template or the build variables / .env.cloud.\n';
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, header + text);
console.log(`render-config: wrote ${outFile} (${ssh ? 'ssh key set' : 'no SSH key: ssh access off'})`);
