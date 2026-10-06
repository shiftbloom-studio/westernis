#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// seed.js: the API version of scripts/wiki-seed.sh, for a wiki that has no shell next to it (the
// Cloudflare deployment; it also works against the local Docker wiki). Imports content/** idempotently:
//   content/files/**                         -> File:<basename>, uploaded when missing or when the SHA-1 differs
//   content/pages/<Namespace>/<Title>.wiki   -> "Namespace:Title"  ("__" in the file name becomes "/")
//   content/pages/Main/<Title>.wiki          -> "Title"
//   content/pages/MediaWiki/Common.css       -> "MediaWiki:Common.css" (extension kept for css/js, and for json in MediaWiki/User)
//   content/pages/Module/<Name>.lua          -> "Module:Name"
// Only pages whose text differs are edited (as the Forge bot, bot flag, summary "Grundbestand eingespielt"),
// in the same namespace order as wiki-seed.sh. Then the Cargo tables of changed (or missing) templates are
// recreated through the cargorecreatetables / cargorecreatedata API modules, the job queue is given time to
// drain, and the seeded pages are purged.
//
//   node tools/forge-mcp/src/seed.js [--dry-run] [--content DIR] [--skip-files] [--cargo changed|all|none]
//                                    [--no-wait] [--no-purge] [--verbose]
//
// --dry-run reads the wiki and prints what would change; it never logs in and never writes.
// Connection: WIKI_API (default http://localhost:8088/api.php), WESTERNIS_API_TOKEN for the Cloudflare gate,
// bot password from .env (see wiki.js). Exit codes: 0 ok, 1 some writes failed, 2 usage or connection error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WikiClient, loadProjectEnv, connectionFromEnv } from './wiki.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['Module', 'Template', 'Form', 'MediaWiki', 'Category', 'Help', 'Project', 'Map', 'Main', 'Chronicle', 'Notes', 'File', 'User'];
const SUMMARY = 'Grundbestand eingespielt';
const FILE_COMMENT = 'Seed asset';
const BATCH = 50;                  // titles per query: the anonymous limit (a dry run does not log in)
const JOB_WAIT_MS = 180_000;

// ----------------------------------------------------------------------------------------------- arguments
function usage(msg) {
  if (msg) console.error(`seed: ${msg}`);
  console.error('usage: node tools/forge-mcp/src/seed.js [--dry-run] [--content DIR] [--skip-files] [--cargo changed|all|none] [--no-wait] [--no-purge] [--verbose]');
  process.exit(2);
}
export function parseArgs(argv) {
  const opts = { dryRun: false, content: path.resolve(here, '..', '..', '..', 'content'), files: true, cargo: 'changed', wait: true, purge: true, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--dry-run': case '-n': opts.dryRun = true; break;
      case '--content': opts.content = path.resolve(value()); break;
      case '--skip-files': opts.files = false; break;
      case '--cargo': opts.cargo = value(); if (!['changed', 'all', 'none'].includes(opts.cargo)) usage('--cargo takes changed, all or none'); break;
      case '--no-wait': opts.wait = false; break;
      case '--no-purge': opts.purge = false; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '-h': case '--help': usage(); break;
      default: usage(`unknown option ${a}`);
    }
  }
  return opts;
}

// ------------------------------------------------------------------------------------------- local content
/** Title for one file below content/pages/<ns>/, or null for files wiki-seed.sh ignores. */
export function titleFor(ns, base) {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1);
  const stem = base.slice(0, dot).replaceAll('__', '/');
  let title;
  switch (ext) {
    case 'wiki': case 'lua': title = stem; break;
    case 'json': title = ns === 'MediaWiki' || ns === 'User' ? `${stem}.${ext}` : stem; break;
    case 'css': case 'js': title = `${stem}.${ext}`; break;
    default: return null;
  }
  return ns === 'Main' ? title : `${ns}:${title}`;
}

/** Pages in wiki-seed.sh order: the listed namespaces first, then any other directory. */
export function collectPages(contentDir) {
  const root = path.join(contentDir, 'pages');
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const ordered = [...ORDER.filter((n) => dirs.includes(n)), ...dirs.filter((n) => !ORDER.includes(n)).sort()];
  const pages = [];
  for (const ns of ordered) {
    const dir = path.join(root, ns);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const title = titleFor(ns, ent.name);
      if (!title) continue;
      const file = path.join(dir, ent.name);
      pages.push({ ns, title, file, text: fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), json: ent.name.endsWith('.json') });
    }
  }
  return pages;
}

/** Every file below content/files (recursively, like importImages --search-recursively). */
export function collectFiles(contentDir) {
  const root = path.join(contentDir, 'files');
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && !ent.name.startsWith('.')) {
        out.push({ name: ent.name, file: p, sha1: crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex') });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** Templates that declare a Cargo table: [{ template: 'Infobox character', table: 'Characters' }]. */
export function cargoDeclarations(pages) {
  const out = [];
  for (const p of pages) {
    if (p.ns !== 'Template') continue;
    for (const m of p.text.matchAll(/cargo_declare:\s*_table\s*=\s*([A-Za-z0-9_]+)/g)) {
      out.push({ template: p.title.slice('Template:'.length), title: p.title, table: m[1] });
    }
  }
  return out;
}

/** MediaWiki's pre-save transform normalises line endings and trailing whitespace; JSON pages are re-serialised. */
export function sameText(local, remote, isJson) {
  if (remote === null || remote === undefined) return false;
  const norm = (s) => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (norm(local) === norm(remote)) return true;
  if (!isJson) return false;
  try { return JSON.stringify(JSON.parse(local)) === JSON.stringify(JSON.parse(remote)); } catch { return false; }
}

// ------------------------------------------------------------------------------------------------ wiki reads
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/** asked title -> { title (as the wiki names it), exists, content, sha1 } for pages or files. */
async function readRemote(wiki, titles, prop) {
  const out = new Map();
  for (const chunk of chunks(titles, BATCH)) {
    const base = prop === 'revisions'
      ? { action: 'query', titles: chunk.join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main' }
      : { action: 'query', titles: chunk.join('|'), prop: 'imageinfo', iiprop: 'sha1' };
    const pages = new Map();
    const normalized = new Map();
    let cont = {};
    for (let round = 0; round < 100; round++) {
      const r = await wiki.get({ ...base, ...cont });
      for (const n of r.query?.normalized ?? []) normalized.set(n.from, n.to);
      for (const p of r.query?.pages ?? []) {
        const prev = pages.get(p.title) ?? {};
        pages.set(p.title, { ...prev, ...p, revisions: p.revisions ?? prev.revisions, imageinfo: p.imageinfo ?? prev.imageinfo });
      }
      if (!r.continue) break;
      cont = r.continue;
    }
    for (const asked of chunk) {
      const t = normalized.get(asked) ?? asked;
      const p = pages.get(t);
      if (!p || p.invalid) { out.set(asked, { title: t, invalid: true, reason: p?.invalidreason ?? 'not returned by the API' }); continue; }
      out.set(asked, {
        title: p.title,
        exists: !p.missing,
        content: p.revisions?.[0]?.slots?.main?.content ?? null,
        sha1: p.imageinfo?.[0]?.sha1 ?? null,
      });
    }
  }
  return out;
}

async function cargoTables(wiki) {
  try { return new Set((await wiki.get({ action: 'cargotables' })).cargotables ?? []); } catch { return null; }
}

async function embeddedCount(wiki, title) {
  let n = 0;
  let cont = {};
  for (let round = 0; round < 1000; round++) {
    const r = await wiki.get({ action: 'query', list: 'embeddedin', eititle: title, eilimit: 'max', ...cont });
    n += r.query?.embeddedin?.length ?? 0;
    if (!r.continue) return n;
    cont = r.continue;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------------ main
export async function seed(opts, { wiki, log = console.log } = {}) {
  const pages = collectPages(opts.content);
  const files = opts.files ? collectFiles(opts.content) : [];
  if (!pages.length && !files.length) throw Object.assign(new Error(`nothing to seed in ${opts.content}`), { usage: true });
  log(`seed: ${files.length} files and ${pages.length} pages from ${opts.content} -> ${wiki.origin}${opts.dryRun ? ' (dry run: nothing is written)' : ''}`);
  const report = { files: { new: [], changed: [], unchanged: [] }, pages: { new: [], changed: [], unchanged: [], invalid: [] }, cargo: [], failed: [] };
  const say = (sign, what) => log(`  ${sign} ${what}`);

  // 1. files first, so seeded pages render with their images (wiki-seed.sh order)
  if (files.length) {
    const remote = await readRemote(wiki, files.map((f) => `File:${f.name}`), 'imageinfo');
    for (const f of files) {
      const r = remote.get(`File:${f.name}`);
      if (r.invalid) { report.failed.push(`File:${f.name}: invalid title (${r.reason})`); continue; }
      const state = !r.exists || !r.sha1 ? 'new' : r.sha1.toLowerCase() === f.sha1 ? 'unchanged' : 'changed';
      report.files[state].push(r.title);
      if (state !== 'unchanged' || opts.verbose) say(state === 'new' ? '+' : state === 'changed' ? '~' : '=', r.title);
      if (state === 'unchanged' || opts.dryRun) continue;
      try {
        const up = await wiki.upload({ filePath: f.file, filename: f.name, text: FILE_COMMENT, comment: FILE_COMMENT, ignorewarnings: true });
        if (up?.result !== 'Success') report.failed.push(`${r.title}: upload ${up?.result ?? 'failed'} ${JSON.stringify(up?.warnings ?? {})}`);
      } catch (e) { report.failed.push(`${r.title}: ${e.message}`); }
    }
    log(`files: ${report.files.new.length} new, ${report.files.changed.length} changed, ${report.files.unchanged.length} unchanged`);
  }

  // 2. pages in dependency order (modules and templates before articles)
  const remote = await readRemote(wiki, pages.map((p) => p.title), 'revisions');
  const touched = new Set();
  for (const p of pages) {
    const r = remote.get(p.title);
    if (r.invalid) { report.pages.invalid.push(p.title); report.failed.push(`${p.title}: invalid title (${r.reason})`); continue; }
    p.wikiTitle = r.title;
    const state = !r.exists ? 'new' : sameText(p.text, r.content, p.json) ? 'unchanged' : 'changed';
    report.pages[state].push(r.title);
    if (state !== 'unchanged' || opts.verbose) say(state === 'new' ? '+' : state === 'changed' ? '~' : '=', r.title);
    if (state === 'unchanged' || opts.dryRun) { if (state !== 'unchanged') touched.add(p.title); continue; }
    try {
      const e = await wiki.edit({ title: p.title, text: p.text, summary: SUMMARY, mode: 'overwrite', bot: true });
      if (!e.nochange) touched.add(p.title);
    } catch (e) { report.failed.push(`${r.title}: ${e.message}`); }
  }
  log(`pages: ${report.pages.new.length} new, ${report.pages.changed.length} changed, ${report.pages.unchanged.length} unchanged`
    + (report.pages.invalid.length ? `, ${report.pages.invalid.length} invalid` : ''));

  // 3. Cargo: recreate the tables of changed templates (and of tables the wiki does not have yet)
  if (opts.cargo !== 'none') {
    const decl = cargoDeclarations(pages);
    const existing = await cargoTables(wiki);
    const todo = decl.filter((d) => opts.cargo === 'all' || touched.has(d.title) || (existing && !existing.has(d.table)));
    for (const d of todo) {
      report.cargo.push(d.table);
      say(opts.dryRun ? '?' : '*', `Cargo table ${d.table} (Template:${d.template})`);
      if (opts.dryRun) continue;
      try {
        await wiki.write({ action: 'cargorecreatetables', template: d.template });
        const n = await embeddedCount(wiki, d.title);
        for (let offset = 0; offset === 0 || offset < n; offset += 500) {
          await wiki.write({ action: 'cargorecreatedata', template: d.template, table: d.table, offset: String(offset) });
        }
      } catch (e) { report.failed.push(`Cargo table ${d.table}: ${e.message}`); }
    }
    log(`cargo: ${todo.length ? `${opts.dryRun ? 'would recreate' : 'recreated'} ${todo.map((d) => d.table).join(', ')}` : 'no table to recreate'}`);
  }

  // 4. let the job loop store the Cargo rows and link updates, then re-render the seeded pages
  const changedAnything = touched.size > 0 || report.files.new.length + report.files.changed.length > 0 || report.cargo.length > 0;
  if (!opts.dryRun && changedAnything && opts.wait) {
    const until = Date.now() + JOB_WAIT_MS;
    let jobs = 0;
    try {
      for (;;) {
        jobs = (await wiki.get({ action: 'query', meta: 'siteinfo', siprop: 'statistics' })).query?.statistics?.jobs ?? 0;
        if (jobs <= 0 || Date.now() > until) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      log(jobs > 0 ? `jobs: about ${jobs} still queued; the wiki finishes them in the background` : 'jobs: queue empty');
    } catch (e) { log(`jobs: could not read the queue length (${e.message}); continuing`); }
  }
  if (opts.purge && changedAnything) {
    const titles = pages.filter((p) => p.wikiTitle).map((p) => p.wikiTitle);
    if (opts.dryRun) log(`purge: would purge ${titles.length} pages`);
    else {
      for (const chunk of chunks(titles, BATCH)) {
        try { await wiki.post({ action: 'purge', titles: chunk.join('|'), forcelinkupdate: '1' }); }
        catch (e) { report.failed.push(`purge: ${e.message}`); }
      }
      log(`purge: ${titles.length} pages`);
    }
  }

  if (report.failed.length) {
    log(`FAILED (${report.failed.length}):`);
    for (const f of report.failed) log(`  !! ${f}`);
  }
  log(opts.dryRun ? 'seed: dry run complete, nothing was written' : report.failed.length ? 'seed: finished with errors' : 'seed: complete');
  return report;
}

// --------------------------------------------------------------------------------------------- command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  loadProjectEnv();
  let wiki;
  try { wiki = new WikiClient(connectionFromEnv()); } catch (e) { usage(e.message); }
  try {
    const report = await seed(opts, { wiki });
    process.exitCode = report.failed.length ? 1 : 0;
  } catch (e) {
    console.error(`seed: ${e.message}`);
    process.exitCode = 2;
  }
}
