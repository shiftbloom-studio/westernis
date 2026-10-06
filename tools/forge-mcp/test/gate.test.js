// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Offline tests of the WikiClient request path against a local stub HTTP server: the Westernis gate
// token header, the request timeout, and the clear errors when the gate refuses (redirect to its login
// page, or 401). Needs no wiki, no .env and no network beyond 127.0.0.1.
//   cd tools/forge-mcp && node --test test/gate.test.js
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WikiClient, GateError, TOKEN_HEADER, DEFAULT_TIMEOUT_MS, tokenAllowed, connectionFromEnv } from '../src/wiki.js';

/** Starts a stub on 127.0.0.1 with a handler(req, body, res); records every request. */
async function stub(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    api: `http://127.0.0.1:${port}/api.php`,
    seen,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}
const json = (res, obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const siteinfo = { batchcomplete: true, query: { general: { sitename: 'Westernis' }, statistics: { pages: 1 }, extensions: [], namespaces: {}, userinfo: { id: 0, name: '127.0.0.1' } } };

describe('gate token', () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => s.close())));

  test('every API request carries X-Westernis-Token from the client (GET and POST)', async () => {
    const s = await stub((req, body, res) => {
      if (body.includes('action=login')) return json(res, { login: { result: 'Success', lgusername: 'Admin' } });
      if (req.url.includes('type=login')) return json(res, { query: { tokens: { logintoken: 'lt+\\' } } });
      if (req.url.includes('type=csrf')) return json(res, { query: { tokens: { csrftoken: 'ct+\\' } } });
      return json(res, siteinfo);
    });
    servers.push(s);
    const wiki = new WikiClient({ api: s.api, user: 'Admin@Forge', password: 'x'.repeat(32), apiToken: 'tok-123' });
    await wiki.siteInfo();
    await wiki.login();
    assert.equal(s.seen.length, 4);
    for (const r of s.seen) assert.equal(r.headers[TOKEN_HEADER.toLowerCase()], 'tok-123', `${r.method} ${r.url}`);
    assert.ok(s.seen.some((r) => r.method === 'POST'));
  });

  test('no token configured: no header is sent', async () => {
    const s = await stub((req, body, res) => json(res, siteinfo));
    servers.push(s);
    await new WikiClient({ api: s.api }).siteInfo();
    assert.equal(s.seen[0].headers[TOKEN_HEADER.toLowerCase()], undefined);
  });

  test('a caller-supplied token header is replaced, and other origins never get the token', async () => {
    const a = await stub((req, body, res) => json(res, siteinfo));
    const b = await stub((req, body, res) => { res.writeHead(200); res.end('ok'); });
    servers.push(a, b);
    const wiki = new WikiClient({ api: a.api, apiToken: 'right' });
    await (await wiki.fetch(a.api, { headers: { [TOKEN_HEADER]: 'forged' } })).text();
    assert.equal(a.seen[0].headers[TOKEN_HEADER.toLowerCase()], 'right');
    await (await wiki.fetch(b.api.replace('/api.php', '/elsewhere'), { headers: { [TOKEN_HEADER]: 'forged' } })).text();
    assert.equal(b.seen[0].headers[TOKEN_HEADER.toLowerCase()], undefined);
  });

  test('the token goes only over https or to loopback hosts', () => {
    assert.equal(tokenAllowed('https://edit.wiki.example.org/api.php'), true);
    assert.equal(tokenAllowed('http://localhost:8787/api.php'), true);
    assert.equal(tokenAllowed('http://127.0.0.1:8090/api.php'), true);
    assert.equal(tokenAllowed('http://[::1]:8090/api.php'), true);
    assert.equal(tokenAllowed('http://10.0.0.20:8088/api.php'), false);
    assert.equal(tokenAllowed('http://wiki.example.org/api.php'), false);
  });

  test('connectionFromEnv reads WIKI_API and WESTERNIS_API_TOKEN', () => {
    const c = connectionFromEnv({ WIKI_API: 'https://edit.wiki.example.org/api.php', WESTERNIS_API_TOKEN: 't' });
    assert.equal(c.api, 'https://edit.wiki.example.org/api.php');
    assert.equal(c.apiToken, 't');
    const d = connectionFromEnv({ WIKI_HOST_PORT: '9000' });
    assert.equal(d.api, 'http://localhost:9000/api.php');
    assert.equal(d.apiToken, '');
    assert.equal(DEFAULT_TIMEOUT_MS, 200_000);
  });
});

describe('gate refusals and redirects', () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => s.close())));

  test('a redirect to /__wst/login is not followed and names WESTERNIS_API_TOKEN', async () => {
    const s = await stub((req, body, res) => {
      if (req.url.startsWith('/__wst/login')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<form>'); }
      res.writeHead(302, { location: '/__wst/login?next=%2Fapi.php' }); res.end();
    });
    servers.push(s);
    const wiki = new WikiClient({ api: s.api, apiToken: 'wrong' });
    await assert.rejects(wiki.siteInfo(), (e) => {
      assert.ok(e instanceof GateError);
      assert.equal(e.code, 'gate');
      assert.match(e.message, /login page/);
      assert.match(e.message, /does not match the Worker secret API_TOKEN/);
      assert.ok(!e.message.includes('wrong'), 'the token must never appear in an error');
      return true;
    });
    assert.equal(s.seen.length, 1, 'the login page must not be fetched');
  });

  test('without a token the error says it is not set', async () => {
    const s = await stub((req, body, res) => { res.writeHead(302, { location: `http://${req.headers.host}/__wst/login?next=%2F` }); res.end(); });
    servers.push(s);
    await assert.rejects(new WikiClient({ api: s.api }).siteInfo(), /WESTERNIS_API_TOKEN is not set/);
  });

  test('a 401 from the gate becomes a GateError', async () => {
    const s = await stub((req, body, res) => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Anmeldung erforderlich.\n'); });
    servers.push(s);
    await assert.rejects(new WikiClient({ api: s.api, apiToken: 'x' }).siteInfo(), (e) => e instanceof GateError && /HTTP 401/.test(e.message));
  });

  test('other redirects are refused instead of followed (the token must not leave the origin)', async () => {
    const s = await stub((req, body, res) => { res.writeHead(301, { location: 'https://elsewhere.example/api.php' }); res.end(); });
    servers.push(s);
    await assert.rejects(new WikiClient({ api: s.api, apiToken: 'x' }).siteInfo(), (e) => e.code === 'redirect' && /set WIKI_API to the final URL/.test(e.message));
    assert.equal(s.seen.length, 1);
  });

  test('a non-JSON 503 page is reported with its text, not its markup', async () => {
    const s = await stub((req, body, res) => { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<html><style>p{}</style><p>Westernis ist noch nicht eingerichtet.</p></html>'); });
    servers.push(s);
    await assert.rejects(new WikiClient({ api: s.api }).siteInfo(), (e) => e.status === 503 && /HTTP 503\): Westernis ist noch nicht eingerichtet\./.test(e.message));
  });
});

describe('timeout', () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => s.close())));

  test('a request without an answer fails after timeoutMs with code "timeout"', async () => {
    const s = await stub(() => { /* never answers */ });
    servers.push(s);
    const wiki = new WikiClient({ api: s.api, apiToken: 'x', timeoutMs: 300 });
    const t0 = Date.now();
    await assert.rejects(wiki.siteInfo(), (e) => e.code === 'timeout' && /within 0 s|within 1 s|cold start/.test(e.message));
    assert.ok(Date.now() - t0 < 5000, 'must not wait for the default timeout');
  });

  test('a body that stalls after the headers also times out', async () => {
    const s = await stub((req, body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"query":'); });
    servers.push(s);
    const wiki = new WikiClient({ api: s.api, timeoutMs: 300 });
    await assert.rejects(wiki.siteInfo(), (e) => e.code === 'timeout');
  });

  test('a refused connection is a clear network error', async () => {
    const s = await stub(() => {});
    const api = s.api;
    await s.close();
    await assert.rejects(new WikiClient({ api, timeoutMs: 2000 }).siteInfo(), (e) => e.code === 'network' && /Cannot reach/.test(e.message));
  });
});
