// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Minimal MediaWiki Action API client for Node 22: bot-password login, cookie jar,
// CSRF tokens, automatic re-login on expired sessions, edits, uploads, queries.
//
// Every HTTP request goes through WikiClient.fetch(), the single request path. On the Cloudflare
// deployment it carries the Westernis gate token (header X-Westernis-Token, from WESTERNIS_API_TOKEN),
// never follows redirects (the token must not travel to another origin) and waits at most 200 s,
// enough for a cold start of the wiki container (the Worker holds API requests up to 180 s).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Header the Worker gate checks (constant-time) against its API_TOKEN secret. */
export const TOKEN_HEADER = 'X-Westernis-Token';
/** Per request, including the response body: a cold start is held by the Worker for up to 180 s. */
export const DEFAULT_TIMEOUT_MS = 200_000;
/** Path of the gate's login page; a redirect there means the token is missing or wrong. */
export const GATE_LOGIN_PATH = '/__wst/login';

/** Thrown when the Westernis gate refuses a request (missing or wrong token). `code` is 'gate'. */
export class GateError extends Error {
  constructor(message) { super(message); this.name = 'GateError'; this.code = 'gate'; }
}

/**
 * The token is sent only over https, or over plain http to a loopback host (wrangler dev, local
 * staging), so it never crosses a network in clear text (e.g. the legacy LAN wiki on port 8088).
 */
export function tokenAllowed(url) {
  const u = new URL(url);
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Read KEY=VALUE pairs from the project .env when the variables are not in the environment. */
export function loadProjectEnv() {
  const candidates = [
    process.env.WESTERNIS_ENV,
    path.resolve(here, '..', '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
      }
      return file;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Connection settings for the Forge bot, from the environment (call loadProjectEnv() first).
 * The defaults match scripts/wiki-bootstrap.sh, which creates the bot password for
 * WIKI_ADMIN_USER (default Admin) with the app id WIKI_BOT_APPID (default Forge).
 * WIKI_API overrides the local default (cloud: https://<edit host>/api.php); WESTERNIS_API_TOKEN is
 * the gate token that cloud/scripts/Set-Secrets.ps1 writes into .env.
 */
export function connectionFromEnv(env = process.env) {
  const port = env.WIKI_HOST_PORT || '8088';
  return {
    api: env.WIKI_API || `http://localhost:${port}/api.php`,
    user: env.WIKI_BOT_USER || `${env.WIKI_ADMIN_USER || 'Admin'}@${env.WIKI_BOT_APPID || 'Forge'}`,
    password: env.WIKI_BOT_PASSWORD,
    apiToken: env.WESTERNIS_API_TOKEN || '',
  };
}

export class WikiClient {
  constructor({ api, user, password, apiToken = '', timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = 'Westernis-Forge-MCP/1.1' }) {
    if (!api) throw new Error('WIKI_API is not set');
    let parsed;
    try { parsed = new URL(api); } catch { throw new Error(`WIKI_API is not a URL: ${api}`); }
    this.api = api;
    this.origin = parsed.origin;
    this.user = user;
    this.password = password;
    this.apiToken = apiToken || '';
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.cookies = new Map();
    this.csrf = null;
    this.loggedIn = false;
  }

  /** Why the gate refused: names the variable to fix without ever printing the token. */
  _gateHint() {
    if (!this.apiToken) return 'WESTERNIS_API_TOKEN is not set (cloud/scripts/Set-Secrets.ps1 writes it into .env; restart Claude Code afterwards)';
    if (!tokenAllowed(this.api)) return `WESTERNIS_API_TOKEN is set but only sent over https; WIKI_API is ${this.origin}`;
    return 'WESTERNIS_API_TOKEN in .env does not match the Worker secret API_TOKEN (run cloud/scripts/Set-Secrets.ps1 again, then restart Claude Code)';
  }

  /**
   * The single request path: every API call, login and upload passes here. Adds the gate token
   * (same origin as WIKI_API only, see tokenAllowed), never follows redirects, and aborts after
   * timeoutMs. Returns the Response; the body must be read before the timeout as well.
   * Also usable for other same-origin URLs (e.g. /images/... or POST /__wst/restart).
   */
  async fetch(url, { method = 'GET', headers = {}, body = undefined, timeoutMs = this.timeoutMs, signal = undefined } = {}) {
    const target = new URL(url, this.api);
    const h = new Headers(headers);
    h.delete(TOKEN_HEADER);
    if (!h.has('user-agent')) h.set('User-Agent', this.userAgent);
    if (this.apiToken && target.origin === this.origin && tokenAllowed(target)) h.set(TOKEN_HEADER, this.apiToken);
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await globalThis.fetch(target, {
        method, headers: h, body, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw this._transportError(e, target, timeoutMs);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      await res.body?.cancel().catch(() => {});
      let to = null;
      try { to = new URL(location, target); } catch { /* unparsable Location */ }
      if (to && to.origin === target.origin && to.pathname === GATE_LOGIN_PATH) {
        throw new GateError(`The Westernis gate at ${target.origin} sent its login page instead of an answer: ${this._gateHint()}.`);
      }
      const err = new Error(`Unexpected redirect (HTTP ${res.status}) from ${target.origin}${target.pathname} to ${location || '(no Location)'}. `
        + 'Redirects are not followed so the API token never leaves this origin: set WIKI_API to the final URL.');
      err.code = 'redirect';
      throw err;
    }
    if (res.status === 401 && !/json/i.test(res.headers.get('content-type') || '')) {
      await res.body?.cancel().catch(() => {});
      throw new GateError(`The Westernis gate at ${target.origin} refused the request (HTTP 401): ${this._gateHint()}.`);
    }
    return res;
  }

  _transportError(e, target, timeoutMs) {
    if (e?.name === 'TimeoutError' || (e?.name === 'AbortError' && e?.cause?.name === 'TimeoutError')) {
      const err = new Error(`No answer from ${target.origin} within ${Math.round(timeoutMs / 1000)} s `
        + '(a cold start of the wiki can take up to about 3 minutes; try again).');
      err.code = 'timeout';
      return err;
    }
    const err = new Error(`Cannot reach ${target.origin}: ${e?.cause?.code || e?.cause?.message || e?.message || e}`);
    err.code = 'network';
    return err;
  }

  /** Reads the body as text under the same timeout as the request. */
  async _text(res, target, timeoutMs) {
    try { return await res.text(); } catch (e) { throw this._transportError(e, target, timeoutMs); }
  }

  get base() {
    return this.api.replace(/\/api\.php$/, '');
  }

  pageUrl(title) {
    return `${this.base}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2F/g, '/')}`;
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _storeCookies(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (/^deleted$/i.test(value)) this.cookies.delete(name); else this.cookies.set(name, value);
      }
    }
  }

  async _request(params, { method = 'GET', body = null } = {}) {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const headers = { Accept: 'application/json' };
    if (this.cookies.size) headers.Cookie = this._cookieHeader();
    let url = this.api;
    const init = { method, headers };
    if (method === 'GET') {
      url = `${this.api}?${query}`;
    } else if (body) {
      url = `${this.api}?format=json&formatversion=2`;
      init.body = body; // FormData
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = query.toString();
    }
    let res, text;
    // The zone's bot protection occasionally answers an API call with a "Just a moment..." challenge page;
    // the same request usually passes a moment later, so retry that case (only that one) a few times.
    for (let attempt = 0; ; attempt++) {
      res = await this.fetch(url, init);
      this._storeCookies(res);
      text = await this._text(res, new URL(url), this.timeoutMs);
      const challenged = (res.status === 403 || res.status === 503) && /_cf_chl_opt|Just a moment\.\.\./.test(text);
      if (!challenged || attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    let json;
    try { json = JSON.parse(text); } catch {
      // e.g. the Worker's "noch nicht eingerichtet" (503) or "konnte nicht starten" page: show its text, not its markup
      const plain = text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const err = new Error(`Non-JSON response from ${this.api} (HTTP ${res.status}): ${plain.slice(0, 300)}`);
      err.code = 'http';
      err.status = res.status;
      throw err;
    }
    if (json.error) {
      const err = new Error(`${json.error.code}: ${json.error.info}`);
      err.code = json.error.code;
      throw err;
    }
    return json;
  }

  async get(params) { return this._request(params, { method: 'GET' }); }
  async post(params) { return this._request(params, { method: 'POST' }); }

  async login() {
    if (!this.user || !this.password) throw new Error('WIKI_BOT_USER / WIKI_BOT_PASSWORD are not set');
    const t = await this.get({ action: 'query', meta: 'tokens', type: 'login' });
    const r = await this.post({ action: 'login', lgname: this.user, lgpassword: this.password, lgtoken: t.query.tokens.logintoken });
    if (r.login?.result !== 'Success') throw new Error(`Login failed: ${JSON.stringify(r.login)}`);
    const c = await this.get({ action: 'query', meta: 'tokens', type: 'csrf' });
    this.csrf = c.query.tokens.csrftoken;
    this.loggedIn = true;
    return r.login;
  }

  async ensureLogin() {
    if (!this.loggedIn) await this.login();
  }

  /** POST a write action; re-login once if the session died. */
  async write(params, { body = null } = {}) {
    await this.ensureLogin();
    const attempt = async () => {
      if (body) {
        body.set('token', this.csrf); // token must be last for uploads
        return this._request({}, { method: 'POST', body });
      }
      return this.post({ ...params, assert: 'user', token: this.csrf });
    };
    try {
      return await attempt();
    } catch (e) {
      if (['assertuserfailed', 'badtoken', 'notloggedin'].includes(e.code)) {
        this.loggedIn = false;
        await this.login();
        return attempt();
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ reads
  async siteInfo() {
    const r = await this.get({ action: 'query', meta: 'siteinfo|userinfo', siprop: 'general|statistics|extensions|namespaces' });
    return r.query;
  }

  async search(query, { limit = 10, namespaces = '*' } = {}) {
    const r = await this.get({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: namespaces, srprop: 'snippet|titlesnippet|size|wordcount|timestamp|categorysnippet', srwhat: 'text' });
    return r.query.search.map((s) => ({ title: s.title, snippet: s.snippet.replace(/<[^>]+>/g, ''), size: s.size, wordcount: s.wordcount, timestamp: s.timestamp }));
  }

  async prefixSearch(prefix, limit = 10) {
    const r = await this.get({ action: 'query', list: 'prefixsearch', pssearch: prefix, pslimit: String(limit) });
    return r.query.prefixsearch.map((p) => p.title);
  }

  async getPage(title) {
    const r = await this.get({
      action: 'query', titles: title, prop: 'revisions|categories|templates|info|pageimages|description|links',
      rvslots: 'main', rvprop: 'content|timestamp|user|comment', cllimit: 'max', tllimit: 'max', pllimit: 'max', inprop: 'url|displaytitle', redirects: '1',
    });
    const page = r.query.pages[0];
    if (!page || page.missing) return { title, exists: false };
    const rev = page.revisions?.[0];
    return {
      title: page.title,
      exists: true,
      displaytitle: page.displaytitle,
      description: page.description,
      url: page.fullurl,
      lastmod: rev?.timestamp,
      lastuser: rev?.user,
      length: page.length,
      wikitext: rev?.slots?.main?.content ?? '',
      categories: (page.categories || []).map((c) => c.title.slice(c.title.indexOf(':') + 1)),   // ns 14, any language prefix
      templates: (page.templates || []).map((t) => t.title),
      links: (page.links || []).map((l) => l.title),
      image: page.pageimage || null,
    };
  }

  /** Existence of many titles; `canonical` maps the asked title to the normalised/redirect target title. */
  async pagesExist(titles) {
    const exists = new Map();
    const canonical = new Map();
    for (let i = 0; i < titles.length; i += 50) {
      const chunk = titles.slice(i, i + 50);
      const r = await this.get({ action: 'query', titles: chunk.join('|'), prop: 'info', redirects: '1' });
      const pageExists = new Map(r.query.pages.map((p) => [p.title, !p.missing]));
      const redirect = new Map((r.query.redirects || []).map((rd) => [rd.from, rd.to]));
      const normalized = new Map((r.query.normalized || []).map((n) => [n.from, n.to]));
      for (const asked of chunk) {
        let t = normalized.get(asked) || asked;
        if (redirect.has(t)) t = redirect.get(t);
        exists.set(asked, pageExists.get(t) === true);
        canonical.set(asked, t);
      }
    }
    return { exists, canonical };
  }

  async getSection(title, index) {
    const r = await this.get({ action: 'query', titles: title, prop: 'revisions', rvslots: 'main', rvprop: 'content', rvsection: String(index), redirects: '1' });
    return r.query.pages[0]?.revisions?.[0]?.slots?.main?.content ?? '';
  }

  async linksHere(title, limit = 50) {
    const r = await this.get({ action: 'query', titles: title, prop: 'linkshere', lhlimit: String(limit), lhshow: '!redirect' });
    return (r.query.pages[0]?.linkshere || []).map((l) => l.title);
  }

  async categoryMembers(category, limit = 100) {
    const r = await this.get({ action: 'query', list: 'categorymembers', cmtitle: `Category:${category.replace(/^\s*(category|kategorie)\s*:/i, '')}`, cmlimit: String(limit), cmprop: 'title|type|timestamp' });
    return r.query.categorymembers;
  }

  async queryPage(name, limit = 50) {
    const r = await this.get({ action: 'query', list: 'querypage', qppage: name, qplimit: String(limit) });
    return r.query.querypage.results.map((x) => ({ title: x.title, value: x.value, ns: x.ns }));
  }

  async recentChanges(limit = 30) {
    const r = await this.get({ action: 'query', list: 'recentchanges', rclimit: String(limit), rcprop: 'title|timestamp|user|comment|sizes|flags', rctype: 'edit|new|log' });
    return r.query.recentchanges.map((c) => ({ title: c.title, type: c.type, user: c.user, timestamp: c.timestamp, comment: c.comment, delta: (c.newlen ?? 0) - (c.oldlen ?? 0) }));
  }

  async parse(text, title = 'Preview') {
    const r = await this.get({ action: 'parse', text, title, contentmodel: 'wikitext', prop: 'text|links|categories|templates|warnings|sections', disablelimitreport: '1', pst: '1' });
    return r.parse;
  }

  async parsePage(title) {
    const r = await this.get({ action: 'parse', page: title, prop: 'text|sections|links|categories', disablelimitreport: '1', redirects: '1' });
    return r.parse;
  }

  async templateData(titles) {
    const r = await this.get({ action: 'templatedata', titles: titles.join('|'), includeMissingTitles: '1', lang: 'en' });
    return r.pages;
  }

  async cargoQuery({ tables, fields, where, order_by, group_by, having, join_on, limit = 100 }) {
    // The API refuses aliases that start with "_" — give _pageName & co. a plain alias automatically.
    const safeFields = String(fields || '_pageName').split(',').map((f) => {
      const t = f.trim();
      if (!t || t.includes('=')) return t;
      const bare = t.includes('.') ? t.split('.').pop() : t;
      return bare.startsWith('_') ? `${t}=${bare.slice(1)}` : t;
    }).filter(Boolean).join(',');
    const params = { action: 'cargoquery', tables, fields: safeFields, limit: String(limit) };
    if (where) params.where = where;
    if (order_by) params.order_by = order_by;
    if (group_by) params.group_by = group_by;
    if (having) params.having = having;
    if (join_on) params.join_on = join_on;
    const r = await this.get(params);
    return r.cargoquery.map((row) => row.title);
  }

  // ----------------------------------------------------------------- writes
  async edit({ title, text, summary, mode = 'overwrite', section = null, sectiontitle = null, bot = true, minor = false, baseTimestamp = null }) {
    const params = { action: 'edit', title, summary: summary || 'Edited via Forge', bot: bot ? '1' : undefined, minor: minor ? '1' : undefined };
    if (mode === 'create') params.createonly = '1';
    if (mode === 'update') params.nocreate = '1';
    if (mode === 'append') params.appendtext = text;
    else if (mode === 'prepend') params.prependtext = text;
    else params.text = text;
    if (section !== null) params.section = String(section);
    if (sectiontitle) params.sectiontitle = sectiontitle;
    // Edit-conflict detection: MediaWiki merges or refuses when the page changed after baseTimestamp.
    if (baseTimestamp) { params.basetimestamp = baseTimestamp; params.starttimestamp = new Date().toISOString(); }
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    const r = await this.write(params);
    if (!r.edit || r.edit.result !== 'Success') {
      const err = new Error(`Edit of "${title}" failed: ${JSON.stringify(r.edit || r)}`);
      err.code = r.edit?.code || 'editfailed';
      throw err;
    }
    return r.edit;
  }

  async upload({ filePath, filename, text = '', comment = 'Uploaded via Forge', ignorewarnings = true }) {
    await this.ensureLogin();
    const data = fs.readFileSync(filePath);
    const form = new FormData();
    form.set('action', 'upload');
    form.set('filename', filename);
    form.set('comment', comment);
    form.set('text', text);
    if (ignorewarnings) form.set('ignorewarnings', '1');
    form.set('file', new Blob([data]), filename);
    const r = await this.write({}, { body: form });
    return r.upload;
  }

  async purge(titles) {
    const r = await this.post({ action: 'purge', titles: titles.join('|'), forcelinkupdate: '1' });
    return r.purge;
  }
}
