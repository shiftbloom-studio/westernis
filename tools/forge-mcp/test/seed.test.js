// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Offline test of src/seed.js: runs `seed.js --dry-run` as a child process against a local stub wiki and a
// throwaway content folder. Checks the title mapping, the change detection (text, JSON, SHA-1), the gate
// token on every request, and that a dry run never logs in and never POSTs.
//   cd tools/forge-mcp && node --test test/seed.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleFor, sameText, cargoDeclarations, collectPages } from '../src/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedJs = path.resolve(here, '..', 'src', 'seed.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-seed-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (rel, text) => { const p = path.join(tmp, 'content', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
write('pages/Template/Infobox_test.wiki', '<includeonly>{{#cargo_declare:_table=Tests|name=String}}</includeonly>');
write('pages/Main/Aragorn_II.wiki', "'''Aragorn II''' is unchanged.\r\n");
write('pages/Main/Neue_Seite.wiki', 'Brand new page.');
write('pages/Help/Sub__Page.wiki', 'Changed text.');
write('pages/MediaWiki/Common.css', 'body { color: #e3c16f; }\n');
write('pages/Map/Westernis.json', '{"a": 1, "b": [1, 2]}');
write('pages/Module/Family.lua', 'return {}');
write('pages/Main/notes.txt', 'ignored by wiki-seed.sh');
write('files/Marker_city.svg', '<svg/>');
write('files/sub/Westernis_map.webp', 'WEBP');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// What the stub wiki has: canonical English titles are normalised to German namespace names like the real wiki.
const NS_DE = { Template: 'Vorlage', Help: 'Hilfe', Module: 'Modul', File: 'Datei' };
const wikiTitle = (t) => { const [ns, ...rest] = t.split(':'); return rest.length && NS_DE[ns] ? `${NS_DE[ns]}:${rest.join(':')}` : t; };
const REMOTE_PAGES = {
  'Vorlage:Infobox test': '<includeonly>{{#cargo_declare:_table=Tests|name=String}}</includeonly>',
  'Aragorn II': "'''Aragorn II''' is unchanged.",
  'Hilfe:Sub/Page': 'Old text.',
  'MediaWiki:Common.css': 'body { color: #e3c16f; }',
  'Map:Westernis': '{\n    "a": 1,\n    "b": [\n        1,\n        2\n    ]\n}',
  'Modul:Family': 'return {}',
};
const REMOTE_FILES = { 'Datei:Marker city.svg': sha1('<svg/>'), 'Datei:Westernis map.webp': sha1('OLD') };

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-westernis-token'], body });
    const q = new URL(req.url, 'http://stub').searchParams;
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'GET') { res.writeHead(500); return res.end('dry run must not POST'); }
    if (q.get('action') === 'cargotables') return reply({ cargotables: ['Characters'] });
    if (q.get('action') === 'query' && q.get('titles')) {
      const normalized = [];
      const pages = q.get('titles').split('|').map((asked) => {
        const t = wikiTitle(asked.replaceAll('_', ' '));
        if (t !== asked) normalized.push({ from: asked, to: t });
        if (q.get('prop') === 'imageinfo') {
          return REMOTE_FILES[t] ? { title: t, ns: 6, imageinfo: [{ sha1: REMOTE_FILES[t] }] } : { title: t, ns: 6, missing: true };
        }
        return t in REMOTE_PAGES ? { title: t, revisions: [{ slots: { main: { content: REMOTE_PAGES[t] } } }] } : { title: t, missing: true };
      });
      return reply({ batchcomplete: true, query: { normalized, pages } });
    }
    res.writeHead(400); res.end('unexpected request');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => server.close(r)));
const api = `http://127.0.0.1:${server.address().port}/api.php`;

function runSeed(args) {
  const emptyEnv = path.join(tmp, 'empty.env');
  fs.writeFileSync(emptyEnv, '');
  const env = { WIKI_API: api, WESTERNIS_API_TOKEN: 'seed-token', WESTERNIS_ENV: emptyEnv };
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [seedJs, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('title mapping follows wiki-seed.sh', () => {
  assert.equal(titleFor('Main', 'Aragorn_II.wiki'), 'Aragorn_II');
  assert.equal(titleFor('Help', 'Sub__Page.wiki'), 'Help:Sub/Page');
  assert.equal(titleFor('MediaWiki', 'Common.css'), 'MediaWiki:Common.css');
  assert.equal(titleFor('MediaWiki', 'Gadgets.json'), 'MediaWiki:Gadgets.json');
  assert.equal(titleFor('Map', 'Westernis.json'), 'Map:Westernis');
  assert.equal(titleFor('Module', 'Family.lua'), 'Module:Family');
  assert.equal(titleFor('Main', 'notes.txt'), null);
  const order = collectPages(path.join(tmp, 'content')).map((p) => p.ns);
  assert.deepEqual([...new Set(order)], ['Module', 'Template', 'MediaWiki', 'Help', 'Map', 'Main']);
});

test('change detection ignores line endings, trailing whitespace and JSON formatting', () => {
  assert.equal(sameText('a\r\nb\n\n', 'a\nb', false), true);
  assert.equal(sameText('a', 'b', false), false);
  assert.equal(sameText('{"a":1}', '{\n    "a": 1\n}', true), true);
  assert.equal(sameText('{"a":1}', '{"a":2}', true), false);
  assert.equal(sameText('x', null, false), false);
  const decl = cargoDeclarations([{ ns: 'Template', title: 'Template:Infobox character', text: '{{#cargo_declare:_table=Characters|race=String}}' }]);
  assert.deepEqual(decl, [{ template: 'Infobox character', title: 'Template:Infobox character', table: 'Characters' }]);
});

test('seed.js --dry-run reports the plan, sends the token and writes nothing', async () => {
  const r = await runSeed(['--dry-run', '--content', path.join(tmp, 'content')]);
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /dry run: nothing is written/);
  assert.match(out, /files: 0 new, 1 changed, 1 unchanged/);
  assert.match(out, /~ Datei:Westernis map\.webp/);
  assert.match(out, /pages: 1 new, 1 changed, 5 unchanged/);
  assert.match(out, /\+ Neue Seite/);
  assert.match(out, /~ Hilfe:Sub\/Page/);
  assert.doesNotMatch(out, /Aragorn II/, 'unchanged pages are listed only with --verbose');
  assert.match(out, /cargo: would recreate Tests/);
  assert.match(out, /purge: would purge 7 pages/);
  assert.match(out, /dry run complete, nothing was written/);
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((s) => s.method === 'GET'), 'a dry run only reads');
  assert.ok(seen.every((s) => s.token === 'seed-token'), 'every request carries the gate token');
  assert.ok(!seen.some((s) => /action=login|type=login|type=csrf/.test(s.url)), 'a dry run never logs in');
  assert.ok(!out.includes('seed-token'), 'the token is never printed');
});

test('seed.js refuses unknown options and an empty content folder', async () => {
  assert.equal((await runSeed(['--bogus'])).code, 2);
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  const r = await runSeed(['--dry-run', '--content', path.join(tmp, 'empty')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nothing to seed/);
});
