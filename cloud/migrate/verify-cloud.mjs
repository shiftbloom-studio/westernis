#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// verify-cloud.mjs — checks a running Westernis wiki against a migration bundle's manifest.json
// (docs/cloudflare-design.md, section 4.6), through the Forge MCP's WikiClient.
//
//   node cloud/migrate/verify-cloud.mjs <stamp> [options]
//
// Target, first match: --api <url> | WIKI_API (environment or .env) | https://<WIKI_EDIT_HOST>/api.php (.env.cloud).
// Westernis gate: WESTERNIS_API_TOKEN (environment or .env) goes out as the X-Westernis-Token header on every
// request to the target's origin (https, or plain http to localhost only). A local staging URL needs none.
// Bot login: Forge's bot password from .env (WIKI_ADMIN_USER@WIKI_BOT_APPID, WIKI_BOT_PASSWORD).
//
// Options:
//   --api <url>          target api.php (e.g. http://localhost:8090/api.php for local staging)
//   --manifest <file>    default: cloud/migrate/out/<stamp>/manifest.json
//   --staging            plain staging URL: skip the Worker-only checks (R2 headers, gate exposure)
//   --since-cutover      the wiki has been used since the import: compare with the bundle only up to its
//                        high-water marks (rev_id, page_id, user_id, log_id); later edits, uploads, deletions
//                        and moves are reported as notes, not failures. Without it every difference fails.
//   --render <n|all>     pages whose parse (action=parse) is compared with the bundle's render digests
//                        (default 40, spread over the wiki, plus every page with a review finding)
//   --write              also run the upload smoke test (uploads, re-uploads and deletes two test files)
//   --restart-drill      also edit Notes:Forge smoke test, POST /__wst/restart and time the cold start (Worker only)
//   --public-read        the reading host is public (PUBLIC_READ_HOSTS): anonymous GET there is expected
//   --search <term>      search check (default: Gondor)
//   --parse <A|B|C>      pages to parse for Lua/Cargo/database errors (default: main page|Third Age|Aragorn II)
//   --report <file>      JSON report (default: next to the manifest, verify-<time>.json)
//   --skip-exposure      do not check that requests without the token are refused
//
// --write and --restart-drill write to the wiki: run the checks without them first, or use --since-cutover
// for every later run. Exit codes: 0 = every check passed (warnings allowed), 1 = a check failed,
// 2 = usage or configuration error. Nothing secret is printed: neither the token nor the bot password.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as forge from '../../tools/forge-mcp/src/wiki.js';

const { WikiClient, loadProjectEnv, connectionFromEnv } = forge;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const REQUEST_TIMEOUT_MS = 210_000;            // the Worker holds API requests up to 180 s during a cold start
const TOKEN_HEADER = forge.TOKEN_HEADER ?? 'X-Westernis-Token';
const GATE_LOGIN_PATH = forge.GATE_LOGIN_PATH ?? '/__wst/login';
const SSO_HEADER = 'X-Westernis-User';
const SESSION_COOKIE = '__Secure-wst';

// ------------------------------------------------------------------------------------------------ arguments
function usage(msg) {
  if (msg) console.error(`verify-cloud: ${msg}`);
  console.error('usage: node cloud/migrate/verify-cloud.mjs <stamp> [--api URL] [--manifest FILE] [--staging] [--since-cutover]'
    + ' [--render N|all] [--write] [--restart-drill] [--public-read] [--search TERM] [--parse "A|B"] [--report FILE] [--skip-exposure]');
  process.exit(2);
}
const opts = {
  staging: false, sinceCutover: false, write: false, restartDrill: false, publicRead: false, skipExposure: false,
  search: 'Gondor', render: 40,
};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
  switch (a) {
    case '--api': opts.api = value(); break;
    case '--manifest': opts.manifest = value(); break;
    case '--staging': opts.staging = true; break;
    case '--since-cutover': opts.sinceCutover = true; break;
    case '--render': {
      const v = value();
      if (v === 'all') opts.render = Infinity;
      else if (/^\d+$/.test(v)) opts.render = Number(v);
      else usage('--render takes a number or "all"');
      break;
    }
    case '--write': opts.write = true; break;
    case '--restart-drill': opts.restartDrill = true; break;
    case '--public-read': opts.publicRead = true; break;
    case '--search': opts.search = value(); break;
    case '--parse': opts.parse = value(); break;
    case '--report': opts.report = value(); break;
    case '--skip-exposure': opts.skipExposure = true; break;
    case '-h': case '--help': usage(); break;
    default:
      if (a.startsWith('-')) usage(`unknown option ${a}`);
      positional.push(a);
  }
}
const stamp = positional[0];
if (!stamp || positional.length > 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stamp)) usage('give exactly one bundle stamp');
if (opts.restartDrill && opts.staging) usage('--restart-drill needs the Worker (not --staging)');

// ---------------------------------------------------------------------------------------- manifest and env
const manifestFile = path.resolve(opts.manifest ?? path.join(here, 'out', stamp, 'manifest.json'));
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { usage(`cannot read ${manifestFile}: ${e.message}`); }
if (manifest.stamp !== stamp) usage(`${manifestFile} belongs to bundle ${manifest.stamp}, not ${stamp}`);
const T = manifest.target ?? {};
if (!T.tables) usage('manifest.json has no target counts');
const V = manifest.verify ?? null;             // formatVersion 2+: content to compare (pages, archive, categories, Cargo, render)
// High-water marks of the bundle: everything above was written in the cloud after the import
const HW = {
  rev: T.max?.rev_id ?? 0,
  page: T.max?.page_id ?? 0,
  user: T.max?.user_id ?? 0,
  log: manifest.logs?.targetMaxId ?? T.max?.log_id ?? 0,
};

loadProjectEnv();                              // .env: bot password, WIKI_API, WESTERNIS_API_TOKEN (never printed)
const cloudEnv = readHostsFromEnvCloud();      // only the two hostnames are read from .env.cloud
const api = opts.api ?? process.env.WIKI_API ?? (cloudEnv.WIKI_EDIT_HOST ? `https://${cloudEnv.WIKI_EDIT_HOST}/api.php` : null);
if (!api) usage('no target: pass --api, set WIKI_API, or fill WIKI_EDIT_HOST in .env.cloud');
let target;
try { target = new URL(api); } catch { usage(`not a URL: ${api}`); }
const origin = target.origin;

// The legacy wiki must never receive the write tests.
const legacy = new Set([`http://localhost:${process.env.WIKI_HOST_PORT || '8088'}`, `http://127.0.0.1:${process.env.WIKI_HOST_PORT || '8088'}`]);
try { if (process.env.WIKI_SERVER) legacy.add(new URL(process.env.WIKI_SERVER).origin); } catch { /* ignore */ }
if ((opts.write || opts.restartDrill) && legacy.has(origin)) usage(`${origin} is the legacy wiki: --write/--restart-drill refused`);

function readHostsFromEnvCloud() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(root, '.env.cloud'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(WIKI_PUBLIC_HOST|WIKI_EDIT_HOST)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch { /* no .env.cloud: fine for staging */ }
  return out;
}

// ------------------------------------------------------------ requests through the Westernis gate (token)
const apiToken = process.env.WESTERNIS_API_TOKEN || '';
const rawFetch = globalThis.fetch.bind(globalThis);
class GateError extends Error {}
/** The token travels only over https, or plain http to loopback (staging, wrangler dev); never elsewhere. */
function tokenAllowed(u) {
  if (typeof forge.tokenAllowed === 'function') return forge.tokenAllowed(u);
  const x = new URL(u);
  if (x.protocol === 'https:') return true;
  const h = x.hostname.toLowerCase();
  return x.protocol === 'http:' && (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h));
}
/** fetch for the target: adds the gate token (same origin only), never follows redirects, recognises the login page. */
async function gateFetch(input, init = {}) {
  const url = new URL(String(input), origin);
  const headers = new Headers(init.headers ?? {});
  headers.delete(TOKEN_HEADER);
  if (apiToken && url.origin === origin && tokenAllowed(url)) headers.set(TOKEN_HEADER, apiToken);
  const res = await rawFetch(url, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const location = res.headers.get('location') ?? '';
  if (res.status >= 300 && res.status < 400 && isLoginRedirect(location, url)) {
    throw new GateError(`the Westernis gate answered with its login page: ${gateHint()}`);
  }
  return res;
}
function isLoginRedirect(location, base) {
  try { return new URL(location, base).pathname === GATE_LOGIN_PATH; } catch { return false; }
}
function gateHint() {
  if (!apiToken) return 'WESTERNIS_API_TOKEN is not set (.env)';
  if (!tokenAllowed(api)) return `the token is only sent over https (target ${origin})`;
  return 'WESTERNIS_API_TOKEN does not match the Worker secret API_TOKEN';
}

const conn = connectionFromEnv();
const wiki = new WikiClient({ ...conn, api, apiToken, timeoutMs: REQUEST_TIMEOUT_MS });

// ----------------------------------------------------------------------------------------------- helpers
const results = [];
const LABEL = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', skip: '[SKIP]' };
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${LABEL[status]} ${name}${detail ? ` - ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'status' in r) record(name, r.status, r.detail);
    else record(name, 'ok', r ?? '');
  } catch (e) {
    const gate = e instanceof GateError || e?.name === 'GateError' || e?.code === 'gate';
    record(name, 'fail', gate ? e.message : `${e.code ? `${e.code}: ` : ''}${e.message}`);
  }
}
const ok = (detail) => ({ status: 'ok', detail });
const warn = (detail) => ({ status: 'warn', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });
/** Since the cut-over a difference is a note (ok/warn), before it a failure. */
const strict = (detail) => (opts.sinceCutover ? warn(detail) : fail(detail));
const brief = (lines, n = 10) => lines.slice(0, n).join('; ') + (lines.length > n ? `; ${lines.length - n} more` : '');

/** Every result of a query module (list= or generator=), following "continue". */
async function queryAll(params, pick) {
  const out = [];
  let cont = {};
  for (let page = 0; page < 2000; page++) {
    const r = await wiki.get({ action: 'query', ...params, ...cont });
    out.push(...(pick(r) ?? []));
    if (!r.continue) return out;
    cont = r.continue;
  }
  throw new Error(`${JSON.stringify(params).slice(0, 80)}: too many pages`);
}
const listAll = (list, params, key = list) => queryAll({ list, ...params }, (r) => r.query?.[key]);
/** URLs from the API may carry the canonical host: always fetch through the target's origin. */
const viaTarget = (u) => { const x = new URL(u, origin); return new URL(x.pathname + x.search, origin).toString(); };
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const iso = (ts14) => `${ts14.slice(0, 4)}-${ts14.slice(4, 6)}-${ts14.slice(6, 8)}T${ts14.slice(8, 10)}:${ts14.slice(10, 12)}:${ts14.slice(12, 14)}Z`;
async function getBytes(url, init = {}) {
  const res = await gateFetch(viaTarget(url), init);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}
function diffSummary(want, got) {
  const lines = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[k] !== got[k]) lines.push(`${k}: expected ${want[k] ?? '-'}, got ${got[k] ?? '-'}`);
  }
  return lines;
}
/** API title ("Vorlage:Foo bar") -> MediaWiki DB key without namespace ("Foo_bar"). */
const dbkey = (title, ns) => (ns === 0 ? title : title.slice(title.indexOf(':') + 1)).replace(/ /g, '_');
/** render.php's digest: first 16 hex of sha1 over the byte-sorted strings joined by "\n". */
function digest(list) {
  const sorted = [...new Set(list)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha1(Buffer.from(sorted.join('\n'), 'utf8')).slice(0, 16);
}

// ------------------------------------------------------------------------------------------------- checks
console.log(`verify-cloud: bundle ${stamp} (${manifest.frozen === true ? 'frozen' : 'dry run'}) against ${origin}`
  + `${opts.staging ? ' (staging)' : ''}${opts.sinceCutover ? ', since the cut-over' : ''}`);
console.log(`              gate token: ${apiToken ? 'yes' : 'no'}; bot: ${conn.user ?? '-'}; `
  + `bundle high-water marks: rev ${HW.rev}, page ${HW.page}, user ${HW.user}, log ${HW.log}`);
if (!V) console.log('              (manifest formatVersion 1: the content checks are skipped; export the bundle again for them)');
const startedAt = new Date();
let site;

await check('reachable through the gate', async () => {
  const res = await gateFetch(`${api}?action=query&meta=siteinfo&format=json&formatversion=2`);
  const text = await res.text();
  if (res.status === 401 || res.status === 403) return fail(`HTTP ${res.status}: ${gateHint()}`);
  if (!res.ok) return fail(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  JSON.parse(text);
  return ok(`HTTP ${res.status}`);
});

await check('siteinfo', async () => {
  site = await wiki.siteInfo();
  const g = site.general;
  if (g.dbtype !== 'sqlite') return fail(`database type ${g.dbtype}: this is not the SQLite (cloud) wiki`);
  const detail = `${g.generator}, ${g.dbtype}${g.readonly ? ', READ-ONLY' : ''}`;
  return g.readonly ? warn(`${detail} (${g.readonlyreason ?? ''})`) : ok(detail);
});

await check('bot login', async () => {
  const r = await wiki.login();
  return ok(`${r?.lgusername ?? conn.user} (bot password copied with the user table)`);
});

// What happened after the import: revisions and log entries above the bundle's high-water marks
let liveRevs = [];
let logs = [];
const later = { revs: [], logs: [], deletedTitles: new Set(), movedFrom: new Set(), uploaded: new Set() };
await check('activity since the import', async () => {
  const revs = await listAll('allrevisions', { arvprop: 'ids', arvlimit: 'max' });
  liveRevs = revs.flatMap((p) => (p.revisions ?? []).map((r) => ({ revid: r.revid, pageid: p.pageid, title: p.title })));
  logs = await listAll('logevents', { leprop: 'ids|type|title|timestamp', ledir: 'newer', lelimit: 'max' });
  later.revs = liveRevs.filter((r) => r.revid > HW.rev);
  later.logs = logs.filter((e) => e.logid > HW.log);
  for (const e of later.logs) {
    if (e.type === 'delete') later.deletedTitles.add(e.title);
    if (e.type === 'move') later.movedFrom.add(e.title);
    if (e.type === 'upload') later.uploaded.add(e.title);
  }
  const detail = `${later.revs.length} revision(s) and ${later.logs.length} log entr${later.logs.length === 1 ? 'y' : 'ies'} after the bundle`;
  if (!later.revs.length && !later.logs.length) return ok('none: the wiki is exactly the bundle');
  return opts.sinceCutover ? ok(`${detail} (compared up to the high-water marks)`)
    : fail(`${detail}: pass --since-cutover to compare only up to the bundle's high-water marks`);
});
const changedAfter = later.revs.length > 0 || later.logs.length > 0;

await check('statistics', () => {
  if (!site) return skip('no siteinfo');
  const s = site.statistics;
  const ss = T.siteStats ?? {};
  const want = { pages: ss.ss_total_pages, articles: ss.ss_good_articles, images: ss.ss_images, users: ss.ss_users };
  const got = { pages: s.pages, articles: s.articles, images: s.images, users: s.users };
  const d = diffSummary(want, got);
  const edits = `edits ${s.edits} (bundle ${ss.ss_total_edits ?? '-'}; initSiteStats recounted, not compared)`;
  if (d.length && opts.sinceCutover && changedAfter) return ok(`not compared (the wiki changed since the import): ${d.join('; ')}`);
  return d.length ? fail(`${d.join('; ')}; ${edits}`) : ok(`pages ${s.pages}, articles ${s.articles}, images ${s.images}, users ${s.users}; ${edits}`);
});

/** Live pages: id -> {ns, title (DB key), latest, len, redirect, model, lang} */
let livePages = new Map();
await check('pages (ids, titles, latest revision, size)', async () => {
  const nsIds = [...new Set([
    ...Object.keys(T.namespaces ?? {}).map(Number),
    ...Object.values(site?.namespaces ?? {}).map((n) => n.id).filter((id) => id >= 0),
  ])].sort((a, b) => a - b);
  for (const ns of nsIds) {
    const items = await queryAll(
      { generator: 'allpages', gapnamespace: ns, gaplimit: 'max', gapfilterredir: 'all', prop: 'info' },
      (r) => r.query?.pages,
    );
    for (const p of items) {
      livePages.set(p.pageid, {
        ns: p.ns, title: dbkey(p.title, p.ns), latest: p.lastrevid, len: p.length,
        redirect: p.redirect ? 1 : 0, model: p.contentmodel, lang: p.pagelanguage,
      });
    }
  }
  const perNs = {};
  for (const p of livePages.values()) perNs[p.ns] = (perNs[p.ns] ?? 0) + 1;
  const nsLine = Object.entries(perNs).map(([k, v]) => `${k}:${v}`).join(' ');
  if (!V) {
    const want = Object.fromEntries(Object.entries(T.namespaces ?? {}).map(([k, v]) => [String(k), v]));
    const got = Object.fromEntries(Object.entries(perNs).map(([k, v]) => [String(k), v]));
    const d = diffSummary(want, got);
    return d.length ? strict(`per namespace: ${d.join('; ')}`) : ok(nsLine);
  }
  const bad = [];
  const notes = [];
  for (const [id, [ns, title, latest, len, redirect, model, lang]] of Object.entries(V.pages ?? {})) {
    const live = livePages.get(Number(id));
    const name = `${ns}:${title}`;
    const wasDeleted = [...later.deletedTitles].some((t) => dbkey(t, ns) === title);
    if (!live) {
      if (opts.sinceCutover && (wasDeleted || [...later.movedFrom].some((t) => dbkey(t, ns) === title))) notes.push(`${name} deleted or moved later`);
      else bad.push(`${name} (page ${id}) missing`);
      continue;
    }
    if (live.ns !== ns || live.title !== title) {
      if (opts.sinceCutover && later.movedFrom.size) notes.push(`${name} is now ${live.ns}:${live.title}`);
      else bad.push(`page ${id}: ${name} is ${live.ns}:${live.title}`);
    }
    if (live.latest !== latest) {
      if (opts.sinceCutover && live.latest > HW.rev) notes.push(`${name} edited later`);
      else bad.push(`${name}: latest revision ${live.latest}, bundle ${latest}`);
      continue;
    }
    if (live.len !== len || live.redirect !== redirect) bad.push(`${name}: size/redirect ${live.len}/${live.redirect}, bundle ${len}/${redirect}`);
    if (model !== null && live.model !== model) bad.push(`${name}: content model ${live.model}, bundle ${model}`);
    if (lang !== null && live.lang !== lang) bad.push(`${name}: page language ${live.lang}, bundle ${lang}`);
  }
  const added = [...livePages.keys()].filter((id) => !(String(id) in (V.pages ?? {})));
  if (added.length) {
    const msg = `${added.length} page(s) not in the bundle`;
    if (opts.sinceCutover && added.every((id) => id > HW.page)) notes.push(`${msg} (created later)`);
    else bad.push(`${msg}: ${added.slice(0, 5).join(', ')}`);
  }
  if (bad.length) return fail(brief(bad));
  return ok(`${Object.keys(V.pages ?? {}).length} bundle pages checked (${nsLine})${notes.length ? `; notes: ${brief(notes, 5)}` : ''}`);
});

let deleted = null;            // [{revid, sha1, size, ns, title}] or null when the bot may not list them
await check('revisions', async () => {
  const old = liveRevs.filter((r) => r.revid <= HW.rev);
  const max = old.reduce((m, r) => Math.max(m, r.revid), 0);
  const wantN = T.tables.revision;
  if (old.length === wantN && (max === HW.rev || opts.sinceCutover)) {
    return ok(`${old.length} revisions up to rev_id ${HW.rev}${later.revs.length ? `; ${later.revs.length} newer (since the import)` : ''}`);
  }
  if (opts.sinceCutover) {
    // Pages deleted after the import moved their revisions into the archive
    try {
      deleted ??= await listDeleted();
      const known = new Set(Object.keys(V?.archive ?? {}).map(Number));
      const movedToArchive = deleted.filter((d) => d.revid <= HW.rev && !known.has(d.revid)).length;
      if (old.length + movedToArchive === wantN) {
        return ok(`${old.length} live + ${movedToArchive} deleted after the import = ${wantN} bundle revisions`);
      }
      return fail(`${old.length} live + ${movedToArchive} deleted after the import, bundle ${wantN}`);
    } catch (e) {
      return warn(`${old.length} revisions up to rev_id ${HW.rev}, bundle ${wantN}; cannot list deleted revisions (${e.code ?? e.message})`);
    }
  }
  return fail(`${old.length} revisions (newest ${max}), expected ${wantN} / ${HW.rev}`);
});

async function listDeleted() {
  const items = await listAll('alldeletedrevisions', { adrprop: 'ids|sha1|size', adrlimit: 'max' });
  return items.flatMap((p) => (p.revisions ?? []).map((r) => ({
    revid: r.revid, sha1: r.sha1 ?? null, size: r.size ?? null, ns: p.ns, title: dbkey(p.title, p.ns),
  })));
}

await check('deleted revisions (content)', async () => {
  try {
    deleted ??= await listDeleted();
  } catch (e) {
    if (/permission|denied/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) {
      return warn(`the bot may not list deleted revisions (${e.code}); expected ${T.tables.archive}`);
    }
    throw e;
  }
  if (!V) return deleted.length === T.tables.archive ? ok(`${deleted.length} archived revisions`) : strict(`${deleted.length} archived revisions, expected ${T.tables.archive}`);
  const live = new Set(liveRevs.map((r) => r.revid));
  const byRev = new Map(deleted.map((d) => [d.revid, d]));
  const bad = [];
  const notes = [];
  let sha1Checked = 0;
  for (const [rev, [hex, len, ns, title]] of Object.entries(V.archive ?? {})) {
    const d = byRev.get(Number(rev));
    if (!d) {
      if (opts.sinceCutover && live.has(Number(rev))) notes.push(`rev ${rev} (${ns}:${title}) undeleted later`);
      else bad.push(`rev ${rev} (${ns}:${title}) missing`);
      continue;
    }
    if (len !== null && d.size !== null && d.size !== len) bad.push(`rev ${rev}: size ${d.size}, bundle ${len}`);
    if (hex && d.sha1) {
      sha1Checked++;
      if (d.sha1 !== hex) bad.push(`rev ${rev} (${ns}:${title}): content SHA-1 differs`);
    }
  }
  const extra = deleted.filter((d) => !(String(d.revid) in (V.archive ?? {})));
  if (extra.length) {
    const msg = `${extra.length} deleted revision(s) not in the bundle`;
    if (opts.sinceCutover) notes.push(`${msg} (deleted after the import)`);
    else bad.push(msg);
  }
  if (bad.length) return fail(brief(bad));
  const n = Object.keys(V.archive ?? {}).length;
  return ok(`${n} bundle revision(s) in the archive, ${sha1Checked} with matching content SHA-1${notes.length ? `; ${brief(notes, 5)}` : ''}`
    + (sha1Checked < n ? ' (SHA-1 hidden from the bot for the rest: sizes compared)' : ''));
});

await check('log entries', async () => {
  const byId = new Map(logs.map((e) => [e.logid, e]));
  const entries = manifest.logs?.entries ?? [];
  const bad = [];
  for (const [id, type, action, ts] of entries) {
    const e = byId.get(id);
    if (!e || e.type !== type || e.action !== action || e.timestamp !== iso(ts)) {
      bad.push(`${id} ${type}/${action} ${iso(ts)} -> ${e ? `${e.type}/${e.action} ${e.timestamp}` : 'missing'}`);
    }
  }
  return bad.length ? fail(brief(bad))
    : ok(`${logs.length} entries; all ${entries.length} source entries identical (id, type, action, timestamp)`);
});

await check('users', async () => {
  const users = await listAll('allusers', { aulimit: 'max' });
  const old = users.filter((u) => u.userid <= HW.user).length;
  const newer = users.length - old;
  if (old !== T.tables.user) return fail(`${old} users up to user_id ${HW.user}, expected ${T.tables.user}`);
  if (newer && !opts.sinceCutover) return fail(`${newer} user(s) newer than the bundle`);
  return ok(`${old} users${newer ? ` (+${newer} created since the import)` : ''}`);
});

await check('category order (German collation)', async () => {
  if (!V) return skip('manifest without content fingerprints');
  const cats = Object.entries(V.categories ?? {});
  const bad = [];
  const notes = [];
  let pairs = 0;
  for (const [cat, types] of cats) {
    const members = await listAll('categorymembers', {
      cmtitle: `Category:${cat}`, cmprop: 'ids|type', cmtype: 'page|subcat|file', cmsort: 'sortkey', cmlimit: 'max',
    });
    const got = {};
    for (const m of members) (got[m.type] ??= []).push(m.pageid);
    for (const [type, want] of Object.entries(types)) {
      const have = got[type] ?? [];
      pairs++;
      if (JSON.stringify(have) === JSON.stringify(want)) continue;
      const wantSet = new Set(want);
      const haveSet = new Set(have);
      const a = want.filter((id) => haveSet.has(id));
      const b = have.filter((id) => wantSet.has(id));
      const membership = want.length !== a.length || have.length !== b.length;
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${cat} (${type}): order differs`);
      else if (membership) {
        const touched = [...want, ...have].filter((id) => !(wantSet.has(id) && haveSet.has(id)));
        const explained = opts.sinceCutover && touched.every((id) => {
          const p = livePages.get(id);
          return !p || p.latest > HW.rev || id > HW.page;
        });
        (explained ? notes : bad).push(`${cat} (${type}): members ${want.length} -> ${have.length}`);
      }
    }
  }
  if (bad.length) return fail(brief(bad));
  return ok(`${cats.length} categories, ${pairs} member lists in the bundle's order${notes.length ? `; changed later: ${brief(notes, 5)}` : ''}`);
});

await check('Cargo rows per table and page', async () => {
  if (!V) {
    const want = T.cargo?.tables ?? {};
    const bad = [];
    for (const [table, n] of Object.entries(want)) {
      const rows = await wiki.get({ action: 'cargoquery', tables: table, fields: 'COUNT(*)=n', limit: 1 });
      const got = Number(rows.cargoquery?.[0]?.title?.n ?? NaN);
      if (got !== n) bad.push(`${table} ${got} (expected ${n})`);
    }
    return bad.length ? strict(bad.join(', ')) : ok(`${Object.keys(want).length} tables`);
  }
  // Main tables only: the API queries tables by their declared name (cargo__<Name>)
  const mains = Object.keys(V.cargo ?? {}).filter((t) => /^cargo__[^_]/.test(t) && !t.slice(7).includes('__'));
  const bad = [];
  const notes = [];
  let pagesChecked = 0;
  for (const physical of mains) {
    const table = physical.slice(7);
    const want = V.cargo[physical] ?? {};
    const rows = [];
    for (let offset = 0; ; offset += 5000) {
      const r = await wiki.get({ action: 'cargoquery', tables: table, fields: '_pageID=pid,COUNT(*)=n', group_by: '_pageID', limit: 5000, offset });
      const chunk = (r.cargoquery ?? []).map((x) => x.title ?? x);
      rows.push(...chunk);
      if (chunk.length < 5000) break;
    }
    const got = Object.fromEntries(rows.map((x) => [String(x.pid), Number(x.n)]));
    for (const pid of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if ((want[pid] ?? 0) === (got[pid] ?? 0)) { pagesChecked++; continue; }
      const p = livePages.get(Number(pid));
      const editedLater = !p || p.latest > HW.rev || Number(pid) > HW.page;
      const line = `${table} page ${pid}${p ? ` (${p.ns}:${p.title})` : ''}: ${got[pid] ?? 0} row(s), bundle ${want[pid] ?? 0}`;
      if (opts.sinceCutover && (editedLater || changedAfter)) notes.push(line);     // also template edits after the import
      else bad.push(line);
    }
  }
  if (bad.length) return fail(brief(bad));
  return ok(`${mains.length} tables, ${pagesChecked} page(s) with the bundle's row counts${notes.length ? `; changed later: ${brief(notes, 5)}` : ''}`);
});

let images = [];
await check('files: SHA-1 and size', async () => {
  images = await listAll('allimages', { aiprop: 'sha1|url|size|timestamp', ailimit: 'max' });
  const want = T.images ?? {};
  const got = new Map(images.map((i) => [i.name, i]));
  const bad = [];
  const notes = [];
  for (const [name, w] of Object.entries(want)) {
    const g = got.get(name);
    const touched = later.deletedTitles.size || later.uploaded.size || later.movedFrom.size
      ? [...later.deletedTitles, ...later.uploaded, ...later.movedFrom].some((t) => dbkey(t, 6) === name) : false;
    if (!g) (opts.sinceCutover && touched ? notes : bad).push(`${name} missing`);
    else if (g.sha1 !== w.sha1hex || g.size !== w.size) (opts.sinceCutover && touched ? notes : bad).push(`${name}: sha1/size differ`);
  }
  for (const name of got.keys()) {
    if (!(name in want)) (opts.sinceCutover ? notes : bad).push(`${name} not in the bundle`);
  }
  if (bad.length) return fail(brief(bad));
  return ok(`${Object.keys(want).length} bundle files match${notes.length ? `; since the import: ${brief(notes, 5)}` : ''}`);
});

await check('files: served bytes and headers', async () => {
  const want = T.images ?? {};
  const bad = [];
  let n = 0;
  for (const img of images) {
    const head = await gateFetch(viaTarget(img.url), { method: 'HEAD' });
    if (head.status !== 200) { bad.push(`${img.name}: HEAD ${head.status}`); continue; }
    if (!opts.staging) {
      const csp = head.headers.get('content-security-policy') ?? '';
      const nosniff = (head.headers.get('x-content-type-options') ?? '').toLowerCase();
      if (!csp.includes("default-src 'none'") || nosniff !== 'nosniff') bad.push(`${img.name}: CSP/nosniff headers missing`);
    }
    const { res, body } = await getBytes(img.url);
    n++;
    if (res.status !== 200) bad.push(`${img.name}: GET ${res.status}`);
    else if (sha1(body) !== img.sha1) bad.push(`${img.name}: served bytes have another SHA-1 than the wiki records`);
    else if (want[img.name] && want[img.name].sha1hex !== img.sha1 && !opts.sinceCutover) bad.push(`${img.name}: differs from the bundle`);
  }
  return bad.length ? fail(brief(bad)) : ok(`${n} files: HEAD 200${opts.staging ? '' : ' with CSP + nosniff'}, GET bytes = SHA-1`);
});

await check('old file versions', async () => {
  const old = Object.entries(T.oldimages ?? {});
  if (!old.length) return ok('none in the bundle');
  const bad = [];
  const notes = [];
  const byName = new Map();
  for (const [archiveName, o] of old) byName.set(o.name, [...(byName.get(o.name) ?? []), [archiveName, o]]);
  for (const [name, versions] of byName) {
    const r = await wiki.get({ action: 'query', titles: `File:${name}`, prop: 'imageinfo', iiprop: 'sha1|url|archivename|size', iilimit: 'max' });
    const info = r.query.pages[0]?.imageinfo ?? [];
    for (const [archiveName, o] of versions) {
      const v = info.find((i) => i.archivename === archiveName);
      if (!v) {
        const gone = [...later.deletedTitles].some((t) => dbkey(t, 6) === name);
        (opts.sinceCutover && gone ? notes : bad).push(`${archiveName} missing`);
        continue;
      }
      if (v.sha1 !== o.sha1hex) { bad.push(`${archiveName}: sha1 differs`); continue; }
      const { res, body } = await getBytes(v.url);
      if (res.status !== 200 || sha1(body) !== o.sha1hex) bad.push(`${archiveName}: GET ${res.status}`);
    }
  }
  if (bad.length) return fail(brief(bad));
  return ok(`${old.length} archived version(s) listed and served${notes.length ? `; ${brief(notes, 5)}` : ''}`);
});

await check('range request', async () => {
  const img = images.find((i) => /\.webp$/i.test(i.name)) ?? images[0];
  if (!img) return skip('no files');
  const { res, body } = await getBytes(img.url, { headers: { Range: 'bytes=0-99' } });
  const want = Math.min(100, img.size);
  const range = res.headers.get('content-range') ?? '';
  if (res.status !== 206 || body.length !== want || !range.startsWith(`bytes 0-${want - 1}/`)) {
    return fail(`${img.name}: HTTP ${res.status}, ${body.length} bytes, content-range "${range}"`);
  }
  return ok(`${img.name}: 206, ${range}`);
});

await check('private media prefixes', async () => {
  const bad = [];
  const seen = [];
  for (const p of ['/images/deleted/a/b/c/verify-cloud-probe.png', '/images/temp/verify-cloud-probe.png']) {
    const res = await gateFetch(new URL(p, origin));
    seen.push(res.status);
    // The Worker must answer 404 itself; plain Apache (staging) only must not serve anything.
    const served = opts.staging ? res.status >= 200 && res.status < 300 : res.status !== 404;
    if (served) bad.push(`${p}: HTTP ${res.status}`);
  }
  return bad.length ? fail(bad.join('; ')) : ok(opts.staging ? `not served (HTTP ${seen.join(', ')})` : '404 through the Worker');
});

await check(`search "${opts.search}"`, async () => {
  const hits = await wiki.search(opts.search, { limit: 5 });
  return hits.length ? ok(`${hits.length}${hits.length === 5 ? '+' : ''} hit(s)`) : fail('no hits (rebuildtextindex?)');
});

// Rendering: the cloud's parse of a page must yield the link sets the migration container's SQLite parse had
await check('rendering like the bundle (links, templates, categories, files, external links)', async () => {
  if (!V?.render) return skip('manifest without render digests');
  const all = Object.keys(V.render).map(Number).sort((a, b) => a - b);
  const reviewPages = new Set(V.reviewPages ?? []);
  const n = Math.min(all.length, opts.render);
  const pick = new Set();
  for (let i = 0; i < n; i++) pick.add(all[Math.floor((i * all.length) / n)]);
  for (const id of reviewPages) if (V.render[id]) pick.add(id);
  const bad = [];
  const notes = [];
  let same = 0;
  for (const id of [...pick].sort((a, b) => a - b)) {
    const [rev, want] = V.render[id];
    const live = livePages.get(id);
    if (!live) { (opts.sinceCutover ? notes : bad).push(`page ${id} missing`); continue; }
    if (live.latest !== rev) { (opts.sinceCutover ? notes : bad).push(`${live.ns}:${live.title} has revision ${live.latest}, bundle ${rev}`); continue; }
    const r = await wiki.get({
      action: 'parse', pageid: id, prop: 'links|templates|categories|images|externallinks|revid', disablelimitreport: 1,
    });
    const p = r.parse ?? {};
    const got = {
      links: digest((p.links ?? []).map((l) => `${l.ns}:${dbkey(l.title, l.ns)}`)),
      templates: digest((p.templates ?? []).map((l) => `${l.ns}:${dbkey(l.title, l.ns)}`)),
      categories: digest((p.categories ?? []).map((c) => `${c.category ?? c['*']}|${c.sortkey ?? ''}`)),
      images: digest((p.images ?? []).map((name) => `6:${name}`)),
      external: digest((p.externallinks ?? []).map(String)),
    };
    const differs = Object.keys(want).filter((k) => want[k] !== got[k]);
    if (!differs.length) { same++; continue; }
    const line = `${live.ns}:${live.title}: ${differs.join(', ')}`;
    if (reviewPages.has(id)) notes.push(`${line} (known review finding of the export)`);
    else if (opts.sinceCutover && changedAfter) notes.push(`${line} (templates or data may have changed since the import)`);
    else bad.push(line);
  }
  if (bad.length) return fail(`${bad.length} of ${pick.size} page(s) render other link sets than in the migration: ${brief(bad)}`);
  const detail = `${same} of ${pick.size} sampled page(s) render the bundle's link sets`;
  return notes.length ? warn(`${detail}; ${brief(notes, 6)}`) : ok(detail);
});

const PARSE_ERRORS = [
  [/class="[^"]*\b(?:error|scribunto-error)\b/i, 'error element'],
  [/database is locked|SQLITE_BUSY/i, 'database is locked'],
  [/DBQueryError|SQLSTATE|Wikimedia\\Rdbms/i, 'database error'],
  [/Lua-Fehler|Lua error|Skriptfehler|Script error/i, 'Lua error'],
];
for (const title of (opts.parse ?? `${site?.general?.mainpage ?? 'Main Page'}|Third Age|Aragorn II`).split('|').map((s) => s.trim()).filter(Boolean)) {
  await check(`parse ${title}`, async () => {
    const t0 = Date.now();
    const r = await wiki.get({ action: 'parse', page: title, prop: 'text', disablelimitreport: 1 });
    const html = typeof r.parse?.text === 'string' ? r.parse.text : (r.parse?.text?.['*'] ?? '');
    for (const [re, what] of PARSE_ERRORS) {
      const m = html.match(re);
      if (m) {
        const at = html.slice(Math.max(0, m.index - 60), m.index + 140).replace(/\s+/g, ' ');
        return fail(`${what}: ...${at}...`);
      }
    }
    return ok(`${html.length} bytes of HTML in ${Date.now() - t0} ms, no Lua/Cargo/database errors`);
  });
}

// ------------------------------------------------------------------------------ the gate, seen from outside
const adminName = (process.env.WIKI_ADMIN_USER || 'Admin').trim();
/** meta=userinfo for a request with a forged SSO header: MediaWiki must still see an anonymous user. */
async function userinfoWithForgedSso(fetcher, url) {
  const res = await fetcher(`${url}?action=query&meta=userinfo&format=json&formatversion=2`, {
    headers: { [SSO_HEADER]: adminName }, signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 200) return { status: res.status };
  const j = await res.json().catch(() => null);
  return { status: 200, anon: Boolean(j?.query?.userinfo?.anon) || j?.query?.userinfo?.id === 0, name: j?.query?.userinfo?.name };
}
const refused = (res) => [401, 403].includes(res.status)
  || (res.status >= 300 && res.status < 400 && isLoginRedirect(res.headers.get('location') ?? '', res.url || origin));

if (opts.staging) {
  await check('X-Westernis-User from a client (staging)', async () => {
    const r = await userinfoWithForgedSso(gateFetch, api);
    if (r.status !== 200) return warn(`HTTP ${r.status}`);
    return r.anon ? ok('ignored: MediaWiki stays anonymous')
      : warn(`MediaWiki logged the request in as ${r.name}: the container trusts the header, so keep the staging port bound to localhost`);
  });
}
if (opts.staging || opts.skipExposure) {
  record('gate: refused without the token', 'skip', opts.staging ? 'staging' : '--skip-exposure');
} else {
  const hosts = [...new Set([target.host, cloudEnv.WIKI_PUBLIC_HOST, cloudEnv.WIKI_EDIT_HOST].filter(Boolean))];
  const publicHost = opts.publicRead ? cloudEnv.WIKI_PUBLIC_HOST : null;
  await check('gate: refused without the token', async () => {
    const bad = [];
    const variants = [
      ['no credentials', {}],
      ['a wrong token', { [TOKEN_HEADER]: crypto.randomBytes(24).toString('base64url') }],
      ['a forged session cookie', { Cookie: `${SESSION_COOKIE}=${crypto.randomBytes(48).toString('base64url')}` }],
    ];
    for (const host of hosts) {
      for (const p of ['/wiki/', '/api.php?action=query&meta=siteinfo&format=json', '/images/', '/load.php?modules=startup&only=scripts']) {
        for (const [label, headers] of variants) {
          const res = await rawFetch(`https://${host}${p}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
          await res.body?.cancel().catch(() => {});
          // A public reading host may answer anonymous GETs (any token or cookie is then ignored, never trusted)
          const anonymousOk = host === publicHost && res.status === 200;
          if (!refused(res) && !anonymousOk) bad.push(`${host}${p} with ${label}: HTTP ${res.status}`);
        }
      }
      // A browser navigation is sent to the login page, never to the wiki
      const nav = await rawFetch(`https://${host}/wiki/`, {
        headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' },
        redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
      await nav.body?.cancel().catch(() => {});
      if (host !== publicHost && !refused(nav)) bad.push(`${host}/wiki/ as a browser navigation: HTTP ${nav.status}`);
      // Restart without the token: never accepted (no cookie, no CSRF)
      const rs = await rawFetch(`https://${host}/__wst/restart`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      await rs.body?.cancel().catch(() => {});
      if (rs.status >= 200 && rs.status < 300) bad.push(`${host}/__wst/restart (GET, no token): HTTP ${rs.status}`);
    }
    return bad.length ? fail(`reachable without the gate: ${brief(bad)}`)
      : ok(`${hosts.length} host(s) refuse requests without a valid token or session (401, or 302 to ${GATE_LOGIN_PATH})`);
  });
  await check('gate: login page', async () => {
    const res = await rawFetch(`https://${target.host}${GATE_LOGIN_PATH}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const html = await res.text();
    if (res.status !== 200) return fail(`HTTP ${res.status}`);
    const noindex = /noindex/i.test(res.headers.get('x-robots-tag') ?? '') || /<meta[^>]+noindex/i.test(html);
    const external = /<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html);
    const problems = [];
    if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) problems.push('not text/html');
    if (!noindex) problems.push('no noindex');
    if (external) problems.push('loads external assets');
    if (!/type=["']password["']/i.test(html)) problems.push('no password field');
    return problems.length ? warn(problems.join(', ')) : ok('HTML login page with a password field, noindex, no external assets');
  });
  await check('gate: X-Westernis-User from a client is never trusted', async () => {
    const bad = [];
    const r = await userinfoWithForgedSso(gateFetch, api);
    if (r.status !== 200) bad.push(`token request: HTTP ${r.status}`);
    else if (!r.anon) bad.push(`a token request with a forged ${SSO_HEADER} was logged in as ${r.name}`);
    if (publicHost) {
      const a = await userinfoWithForgedSso(rawFetch, `https://${publicHost}/api.php`);
      if (a.status === 200 && !a.anon) bad.push(`an anonymous request on ${publicHost} was logged in as ${a.name}`);
    }
    return bad.length ? fail(bad.join('; ')) : ok('token requests and anonymous readers stay anonymous; only the session cookie signs in');
  });
}

// ------------------------------------------------------------------------------------------ write checks
// Writes only ever go to the SQLite (cloud or staging) wiki, never to MariaDB, whatever its URL.
const writable = site?.general?.dbtype === 'sqlite';
if (opts.write && !writable) {
  record('upload smoke', 'fail', 'refused: the target is not the SQLite wiki (see siteinfo)');
} else if (opts.write) {
  await check('upload smoke (upload, thumbnail, re-upload, delete)', uploadSmoke);
} else {
  record('upload smoke', 'skip', 'pass --write');
}
if (opts.restartDrill && !writable) {
  record('restart drill', 'fail', 'refused: the target is not the SQLite wiki (see siteinfo)');
} else if (opts.restartDrill) {
  await check('restart drill', restartDrill);
} else {
  record('restart drill', 'skip', opts.staging ? 'staging: use docker stop/start' : 'pass --restart-drill');
}
if (opts.write || opts.restartDrill) {
  console.log('              (this run wrote to the wiki: use --since-cutover for the next one)');
}

async function uploadSmoke() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-verify-'));
  const tag = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const pngName = `Westernis_verify_${tag}.png`;
  const svgName = `Westernis_verify_${tag}.svg`;
  const steps = [];
  try {
    const png1 = makePng(32, 32, [0xe3, 0xc1, 0x6f]);
    const png2 = makePng(32, 32, [0x0b, 0x0a, 0x12]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e3c16f"/></svg>\n');
    const upload = async (name, buf) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, buf);
      const r = await wiki.upload({ filePath: file, filename: name, comment: 'verify-cloud upload smoke test' });
      if (r?.result !== 'Success') throw new Error(`upload of ${name}: ${JSON.stringify(r)}`);
    };
    const info = async (name, extra = {}) => {
      const r = await wiki.get({ action: 'query', titles: `File:${name}`, prop: 'imageinfo', iiprop: 'sha1|url|size|archivename', iilimit: 'max', ...extra });
      return r.query.pages[0]?.imageinfo ?? [];
    };
    const expectServed = async (url, wantSha1, what) => {
      const { res, body } = await getBytes(url);
      if (res.status !== 200) throw new Error(`${what}: GET ${res.status}`);
      if (wantSha1 && sha1(body) !== wantSha1) throw new Error(`${what}: served bytes differ`);
      return res;
    };
    const expectGone = async (url, what) => {
      const { res } = await getBytes(url);
      if (res.status !== 404) throw new Error(`${what}: HTTP ${res.status} after delete (expected 404)`);
    };

    await upload(pngName, png1);
    const [cur] = await info(pngName, { iiurlwidth: 16 });
    if (cur?.sha1 !== sha1(png1)) throw new Error('PNG: SHA-1 differs after upload');
    await expectServed(cur.url, sha1(png1), 'PNG');
    const thumb = await expectServed(cur.thumburl, null, 'PNG thumbnail');
    steps.push(`PNG uploaded and served, thumbnail ${thumb.headers.get('content-type')}`);

    await upload(svgName, svg);
    const [svgInfo] = await info(svgName, { iiurlwidth: 24 });
    await expectServed(svgInfo.url, sha1(svg), 'SVG');
    await expectServed(svgInfo.thumburl, null, 'SVG rendering');
    steps.push('SVG uploaded, served and rendered');

    await upload(pngName, png2);
    const versions = await info(pngName);
    const old = versions.find((v) => v.archivename);
    if (versions[0]?.sha1 !== sha1(png2) || !old || old.sha1 !== sha1(png1)) throw new Error('re-upload: versions do not match');
    await expectServed(versions[0].url, sha1(png2), 'new version');
    await expectServed(old.url, sha1(png1), 'archived version');
    steps.push('re-upload archived the old version');

    for (const name of [pngName, svgName]) {
      await wiki.write({ action: 'delete', title: `File:${name}`, reason: 'verify-cloud upload smoke test' });
    }
    await expectGone(versions[0].url, 'deleted PNG');
    await expectGone(old.url, 'deleted archived PNG');
    await expectGone(svgInfo.url, 'deleted SVG');
    steps.push('delete moved both files out of the public prefix (404)');
    return ok(steps.join('; '));
  } catch (e) {
    return fail(`${steps.join('; ')}${steps.length ? '; then ' : ''}${e.message} (test files: ${pngName}, ${svgName})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function restartDrill() {
  const title = 'Notes:Forge smoke test';
  const marker = `verify-cloud restart drill ${new Date().toISOString()}`;
  await wiki.edit({ title, text: marker, summary: 'verify-cloud restart drill', mode: 'overwrite' });
  // The restart needs the API token (a session cookie is not enough), so a cross-site form cannot trigger it.
  const res = await gateFetch(new URL('/__wst/restart', origin), { method: 'POST' });
  await res.body?.cancel().catch(() => {});
  if (res.status !== 200 && res.status !== 202) return fail(`POST /__wst/restart: HTTP ${res.status}`);
  const t0 = Date.now();
  let up = false;
  while (!up && Date.now() - t0 < 600_000) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await gateFetch(`${api}?action=query&meta=siteinfo&format=json&formatversion=2`);
      up = r.status === 200 && Boolean((await r.json()).query?.general);
    } catch { /* still starting */ }
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (!up) return fail(`the wiki did not answer within ${seconds} s after the restart`);
  const page = await wiki.getPage(title);
  if (page.wikitext.trim() !== marker) return fail(`after the cold start (${seconds} s) ${title} lost the edit made before the restart`);
  return ok(`cold start from R2 in ${seconds} s (restart answered HTTP ${res.status}); the edit made before the restart survived`);
}

/** A tiny solid-colour RGB PNG (no dependencies). */
function makePng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------------- report
const failed = results.filter((r) => r.status === 'fail').length;
const warned = results.filter((r) => r.status === 'warn').length;
const reportFile = path.resolve(opts.report ?? path.join(path.dirname(manifestFile), `verify-${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}.json`));
try {
  fs.writeFileSync(reportFile, JSON.stringify({
    stamp, target: origin, staging: opts.staging, sinceCutover: opts.sinceCutover, highWater: HW,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    passed: failed === 0, failed, warnings: warned, results,
  }, null, 2) + '\n');
} catch (e) {
  console.error(`verify-cloud: cannot write ${reportFile}: ${e.message}`);
}
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${results.length} checks, ${failed} failed, ${warned} warning(s). Report: ${reportFile}`);
process.exit(failed ? 1 : 0);
