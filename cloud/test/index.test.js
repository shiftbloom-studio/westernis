// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// index.js + gate.js end to end: host allowlist, fail-closed 503, login / logout, rate limit, session
// cookie, API token, 302 vs 401, header hygiene and SSO, PUBLIC_READ_HOSTS, /__wst/restart.
import "./helpers/workers-shim.mjs";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeBucket } from "./helpers/fake-r2.mjs";

const mod = await import("../src/index.js");
const gate = await import("../src/gate.js");
const worker = mod.default;
const INSTANCE = "westernis";

const READ = "wiki.example.org";
const EDIT = "edit.wiki.example.org";
const PASSWORD = "Sprich Freund 4711";
const HASH = await gate.hashPassword(PASSWORD, { salt: new Uint8Array(16).fill(7) });
const SECRET = "session-secret-".padEnd(48, "x");
const TOKEN = "api-token-".padEnd(43, "t");
const USER = "Admin";
const IP = "203.0.113.7";

function fakeLimiter(limit = 5) {
  const counts = new Map();
  return {
    keys: [],
    async limit({ key }) {
      this.keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

function setup(vars = {}) {
  const calls = { idFromName: [], fetch: [], restart: [] };
  let restartResult = { status: "stopped", exitCode: 0 };
  const stub = {
    async fetch(r) {
      calls.fetch.push(r);
      return new Response("from MediaWiki", { status: 200 });
    },
    async restart(opts) {
      calls.restart.push(opts);
      return restartResult;
    },
  };
  const env = {
    WIKI_SERVER: `https://${READ}`,
    WIKI_HOSTS: `${READ},${EDIT}`,
    WIKI_EDIT_HOST: EDIT,
    PUBLIC_READ_HOSTS: "",
    GATE_PASSWORD_HASH: HASH,
    SESSION_SECRET: SECRET,
    API_TOKEN: TOKEN,
    GATE_WIKI_USER: USER,
    SESSION_DAYS: "30",
    LOGIN_LIMIT: fakeLimiter(),
    MEDIA: fakeBucket({ "a/ab/Karte.png": { body: "png", contentType: "image/png", etag: "e1" } }),
    MEDIA_CACHE_CONTROL: "private, max-age=3600",
    WIKI: {
      idFromName(name) {
        calls.idFromName.push(name);
        return { name };
      },
      get(id) {
        assert.equal(id.name, INSTANCE);
        return stub;
      },
    },
    ...vars,
  };
  const call = (url, init = {}) => worker.fetch(new Request(url, init), env, {});
  return { env, calls, call, setRestartResult: (r) => (restartResult = r) };
}

const navHeaders = (extra = {}) => ({ "sec-fetch-mode": "navigate", "sec-fetch-site": "none", accept: "text/html", ...extra });
const form = (fields) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "cf-connecting-ip": IP },
  body: new URLSearchParams(fields).toString(),
});

/** Signs in through the real login endpoint and returns the "__Secure-wst=<value>" cookie pair. */
async function signIn(call, host = EDIT, next = "/") {
  const res = await call(`https://${host}/__wst/login`, form({ password: PASSWORD, next }));
  assert.equal(res.status, 303);
  return res.headers.get("set-cookie").split(";")[0];
}

before(() => {
  gate.timing.failDelayMs = 25;
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});
after(() => {
  gate.timing.failDelayMs = 750;
  mock.restoreAll();
});

describe("host allowlist", () => {
  test("unknown host: 404 before the gate or the container", async () => {
    const { call, calls } = setup();
    for (const url of ["https://evil.example.com/", "https://westernis.workers.dev/", `https://x.${READ}/__wst/login`]) {
      assert.equal((await call(url)).status, 404, url);
    }
    assert.equal(calls.fetch.length + calls.idFromName.length, 0);
  });
  test("missing WIKI_HOSTS: 404 for everything", async () => {
    const { call } = setup({ WIKI_HOSTS: undefined });
    assert.equal((await call(`https://${READ}/`)).status, 404);
  });
  test("the main module exports the handler, the Durable Object class and ContainerProxy only", () => {
    assert.deepEqual(Object.keys(mod).sort(), ["ContainerProxy", "WikiContainer", "default"]);
  });
});

describe("fail-closed: missing or malformed gate secrets", () => {
  const cases = {
    "no GATE_PASSWORD_HASH": { GATE_PASSWORD_HASH: undefined },
    "plain-text password instead of a hash": { GATE_PASSWORD_HASH: PASSWORD },
    "600000 iterations": { GATE_PASSWORD_HASH: HASH.replace("$100000$", "$600000$") },
    "no SESSION_SECRET": { SESSION_SECRET: undefined },
    "short SESSION_SECRET": { SESSION_SECRET: "kurz" },
  };
  for (const [name, vars] of Object.entries(cases)) {
    test(`${name}: 503 "noch nicht eingerichtet" for everything, also public reads and tokens`, async () => {
      const { call, calls } = setup({ ...vars, PUBLIC_READ_HOSTS: READ });
      const requests = [
        [`https://${READ}/wiki/Hauptseite`, {}],
        [`https://${READ}/wiki/Hauptseite`, { headers: navHeaders() }],
        [`https://${EDIT}/api.php`, { headers: { "x-westernis-token": TOKEN } }],
        [`https://${EDIT}/__wst/restart`, { method: "POST", headers: { "x-westernis-token": TOKEN } }],
        [`https://${EDIT}/__wst/login`, form({ password: PASSWORD })],
        [`https://${READ}/images/a/ab/Karte.png`, {}],
      ];
      for (const [url, init] of requests) {
        const res = await call(url, init);
        assert.equal(res.status, 503, url);
        assert.match(await res.text(), /Westernis ist noch nicht eingerichtet\./);
        assert.equal(res.headers.get("set-cookie"), null);
      }
      assert.equal(calls.fetch.length + calls.idFromName.length + calls.restart.length, 0);
    });
  }
});

describe("login page", () => {
  test("GET: German form, optional guest name + password, noindex, no external assets, strict headers", async () => {
    const { call } = setup();
    const res = await call(`https://${EDIT}/__wst/login?next=%2Fwiki%2FAragorn_II`, { headers: navHeaders() });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html lang="de">/);
    assert.match(html, /Passwort/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /#0b0a12/);
    assert.match(html, /#e3c16f/);
    assert.match(html, /name="next" value="\/wiki\/Aragorn_II"/);
    assert.equal((html.match(/<input /g) ?? []).length, 3, "hidden next + optional name + password");
    assert.match(html, /name="name"[^>]*autocomplete="username"/);
    assert.doesNotMatch(html, /name="name"[^>]*required/, "the name is optional (empty = owner)");
    assert.doesNotMatch(html, /<script|<link|src=|url\(|@import|https?:\/\//i);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
  });
  test("GET: a hostile next is replaced by / and escaped", async () => {
    const { call } = setup();
    const html = await (await call(`https://${EDIT}/__wst/login?next=${encodeURIComponent('//evil.example/"><script>')}`)).text();
    assert.match(html, /name="next" value="\/"/);
    assert.doesNotMatch(html, /<script/);
  });
  test("GET with a valid session: straight on to next", async () => {
    const { call } = setup();
    const cookie = await signIn(call);
    const res = await call(`https://${EDIT}/__wst/login?next=/wiki/X`, { headers: { cookie } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/wiki/X");
  });
  test("other methods: 405", async () => {
    const { call } = setup();
    assert.equal((await call(`https://${EDIT}/__wst/login`, { method: "PUT", body: "x" })).status, 405);
  });
});

describe("login POST", () => {
  test("success: signed cookie (Secure, HttpOnly, SameSite=Lax, Path=/, Domain=reading host, 30 days), 303 to next", async () => {
    const { call, calls } = setup();
    const res = await call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD, next: "/wiki/Aragorn_II?action=history" }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/wiki/Aragorn_II?action=history");
    const sc = res.headers.get("set-cookie");
    const parts = sc.split(";").map((s) => s.trim());
    assert.match(parts[0], /^__Secure-wst=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    for (const a of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", `Domain=${READ}`, "Max-Age=2592000"]) assert.ok(parts.includes(a), `${a} in ${sc}`);
    assert.equal(calls.fetch.length, 0, "the login never touches the container");
  });
  test("the cookie from one host works on the other (Domain = reading host)", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call, EDIT);
    assert.equal((await call(`https://${READ}/wiki/Hauptseite`, { headers: { cookie } })).status, 200);
    assert.equal(calls.fetch.length, 1);
  });
  test("edit host not below the reading host: host-only cookie", async () => {
    const { call } = setup({ WIKI_EDIT_HOST: "edit.example.org", WIKI_HOSTS: `${READ},edit.example.org` });
    const res = await call("https://edit.example.org/__wst/login", form({ password: PASSWORD }));
    assert.doesNotMatch(res.headers.get("set-cookie"), /Domain=/);
  });
  test("SESSION_DAYS sets Max-Age", async () => {
    const { call } = setup({ SESSION_DAYS: "7" });
    const res = await call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD }));
    assert.match(res.headers.get("set-cookie"), /Max-Age=604800/);
  });
  test("wrong password: 401 page after a fixed delay, no cookie, next kept", async () => {
    const { call } = setup();
    for (const password of ["falsch", "", PASSWORD + " ", PASSWORD.toUpperCase()]) {
      const t0 = Date.now();
      const res = await call(`https://${EDIT}/__wst/login`, form({ password, next: "/wiki/X" }));
      assert.ok(Date.now() - t0 >= 20, "fixed delay on failure");
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
      const html = await res.text();
      assert.match(html, /Name oder Passwort stimmt nicht\./);
      assert.match(html, /name="next" value="\/wiki\/X"/);
    }
  });
  test("no password field, wrong content type, oversized body: refused like a wrong password", async () => {
    const { call } = setup();
    const bodies = [
      form({ next: "/" }),
      { ...form({ password: PASSWORD }), headers: { "content-type": "application/json", "cf-connecting-ip": IP } },
      { ...form({ password: PASSWORD, pad: "x".repeat(9000) }) },
    ];
    for (const init of bodies) {
      const res = await call(`https://${EDIT}/__wst/login`, init);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });
  test("open redirects are impossible: every hostile next ends at /", async () => {
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example/", "/\t/evil.example", "/..//evil.example", "javascript:alert(1)", "/__wst/restart"]) {
      const { call } = setup();
      const res = await call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD, next }));
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/", JSON.stringify(next));
    }
  });
  test("cross-site POST (Sec-Fetch-Site or foreign Origin): 403, the password is not even checked", async () => {
    const { call, env } = setup();
    for (const extra of [{ "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }]) {
      const init = form({ password: PASSWORD });
      init.headers = { ...init.headers, ...extra };
      const res = await call(`https://${EDIT}/__wst/login`, init);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal(env.LOGIN_LIMIT.keys.length, 0);
  });
});

describe("brute-force brake", () => {
  test("5 attempts per IP and minute, then 429 (also for the right password); other IPs unaffected", async () => {
    const { call, env } = setup();
    for (let i = 0; i < 5; i++) assert.equal((await call(`https://${EDIT}/__wst/login`, form({ password: "falsch" }))).status, 401);
    const res = await call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD }));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.match(await res.text(), /Zu viele Versuche/);
    assert.deepEqual(new Set(env.LOGIN_LIMIT.keys), new Set([IP]), "keyed on CF-Connecting-IP");
    const other = form({ password: PASSWORD });
    other.headers = { ...other.headers, "cf-connecting-ip": "198.51.100.9" };
    assert.equal((await call(`https://${EDIT}/__wst/login`, other)).status, 303);
  });
  test("over the limit no PBKDF2 runs (no CPU for attackers)", async () => {
    const { call, env } = setup({ LOGIN_LIMIT: { limit: async () => ({ success: false }) } });
    const derive = mock.method(globalThis.crypto.subtle, "deriveBits");
    try {
      assert.equal((await call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD }))).status, 429);
      assert.equal(derive.mock.callCount(), 0);
    } finally {
      derive.mock.restore();
    }
    assert.ok(env.LOGIN_LIMIT);
  });
  test("a failing limiter refuses (fail-closed); a missing binding means 503", async () => {
    const broken = setup({ LOGIN_LIMIT: { limit: async () => { throw new Error("boom"); } } });
    assert.equal((await broken.call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD }))).status, 429);
    const missing = setup({ LOGIN_LIMIT: undefined });
    const res = await missing.call(`https://${EDIT}/__wst/login`, form({ password: PASSWORD }));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

describe("session cookie", () => {
  test("valid: the request reaches MediaWiki with X-Westernis-User, the gate cookie removed, other cookies kept", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call);
    const res = await call(`https://${EDIT}/wiki/Hauptseite`, {
      headers: { cookie: `westernis_session=abc; ${cookie}; westernisUserID=1`, "x-westernis-user": "Mallory", "x-westernis-other": "x" },
    });
    assert.equal(res.status, 200);
    const h = calls.fetch[0].headers;
    assert.equal(h.get("x-westernis-user"), USER, "client copy replaced");
    assert.equal(h.get("x-westernis-other"), null);
    assert.equal(h.get("x-westernis-token"), null);
    assert.equal(h.get("cookie"), "westernis_session=abc; westernisUserID=1");
  });
  test("only the gate cookie: no Cookie header at all reaches MediaWiki", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call);
    await call(`https://${EDIT}/wiki/X`, { headers: { cookie } });
    assert.equal(calls.fetch[0].headers.get("cookie"), null);
  });
  test("no or non-ASCII GATE_WIKI_USER: authenticated, but no SSO header", async () => {
    for (const GATE_WIKI_USER of [undefined, "", "Jörg"]) {
      const { call, calls } = setup({ GATE_WIKI_USER });
      const cookie = await signIn(call);
      await call(`https://${EDIT}/wiki/X`, { headers: { cookie, "x-westernis-user": "Mallory" } });
      assert.equal(calls.fetch[0].headers.get("x-westernis-user"), null, String(GATE_WIKI_USER));
    }
  });
  test("invalid cookies (forged, other secret, other password, expired) count as not signed in", async () => {
    const { call, calls, env } = setup();
    const good = (await signIn(call)).split("=")[1];
    const otherSecret = await gate.makeSession(gate.gateConfig({ ...env, SESSION_SECRET: "y".repeat(40) }), env);
    const otherHash = await gate.hashPassword("altes Passwort", { salt: new Uint8Array(16).fill(1) });
    const oldPassword = await gate.makeSession(gate.gateConfig({ ...env, GATE_PASSWORD_HASH: otherHash }), env);
    const expired = await gate.makeSession(gate.gateConfig(env), env, Date.now() - 31 * 86_400_000);
    gate.gateConfig(env); // back to the real configuration
    for (const value of [good.slice(0, -3) + "AAA", otherSecret, oldPassword, expired, "garbage"]) {
      const res = await call(`https://${EDIT}/api.php?action=query`, { headers: { cookie: `__Secure-wst=${value}` } });
      assert.equal(res.status, 401, value.slice(0, 20));
    }
    assert.equal(calls.fetch.length, 0);
  });
});

describe("unauthenticated requests never reach the container", () => {
  test("browser navigation: 302 to /__wst/login with next", async () => {
    const { call, calls } = setup();
    const res = await call(`https://${EDIT}/wiki/Aragorn_II?oldid=5`, { headers: navHeaders() });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/__wst/login?next=${encodeURIComponent("/wiki/Aragorn_II?oldid=5")}`);
    const root = await call(`https://${READ}/`, { headers: navHeaders() });
    assert.equal(root.headers.get("location"), "/__wst/login");
    const sneaky = await call(`https://${READ}//evil.example/x`, { headers: navHeaders() });
    assert.equal(sneaky.headers.get("location"), "/__wst/login");
    assert.equal(calls.fetch.length + calls.idFromName.length, 0);
  });
  test("API, assets, images, HEAD: 401 plain text", async () => {
    const { call, calls } = setup();
    for (const [url, init] of [
      [`https://${EDIT}/api.php?action=query`, { headers: { accept: "application/json" } }],
      [`https://${EDIT}/load.php?modules=site`, { headers: { "sec-fetch-mode": "no-cors" } }],
      [`https://${READ}/images/a/ab/Karte.png`, {}],
      [`https://${READ}/wiki/X`, { method: "HEAD" }],
      [`https://${EDIT}/api.php`, { method: "POST", body: "action=edit" }],
    ]) {
      const res = await call(url, init);
      assert.equal(res.status, 401, url);
      assert.match(res.headers.get("content-type"), /text\/plain/);
    }
    assert.equal(calls.fetch.length + calls.idFromName.length, 0);
  });
  test("a form POST navigation after the session ended: 401 page with a login link in a new tab", async () => {
    const { call } = setup();
    const res = await call(`https://${EDIT}/w/index.php?title=X&action=submit`, { method: "POST", body: "wpTextbox1=x", headers: navHeaders() });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /target="_blank"/);
    assert.match(html, /\/__wst\/login\?next=%2Fw%2Findex\.php%3Ftitle%3DX%26action%3Dsubmit/);
  });
});

describe("API token (Forge MCP, wst.ps1)", () => {
  test("valid: reaches MediaWiki without SSO header and without the token; MediaWiki cookies kept", async () => {
    const { call, calls } = setup();
    const res = await call(`https://${EDIT}/api.php?action=query`, {
      headers: { "x-westernis-token": TOKEN, "x-westernis-user": "Mallory", cookie: "westernis_session=bot; __Secure-wst=x" },
    });
    assert.equal(res.status, 200);
    const h = calls.fetch[0].headers;
    assert.equal(h.get("x-westernis-user"), null);
    assert.equal(h.get("x-westernis-token"), null);
    assert.equal(h.get("cookie"), "westernis_session=bot");
  });
  test("a token wins over a session cookie: still no SSO header", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call);
    await call(`https://${EDIT}/api.php`, { headers: { "x-westernis-token": TOKEN, cookie } });
    assert.equal(calls.fetch[0].headers.get("x-westernis-user"), null);
  });
  test("wrong token: 401 after the delay, even with a valid cookie; API_TOKEN unset or short: 503", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call);
    for (const t of ["", "falsch", TOKEN + "x", TOKEN.slice(1)]) {
      const t0 = Date.now();
      const res = await call(`https://${EDIT}/api.php`, { headers: { "x-westernis-token": t, cookie } });
      assert.equal(res.status, 401, JSON.stringify(t));
      assert.ok(Date.now() - t0 >= 20);
    }
    for (const API_TOKEN of [undefined, "zu-kurz"]) {
      const s = setup({ API_TOKEN });
      assert.equal((await s.call(`https://${EDIT}/api.php`, { headers: { "x-westernis-token": "zu-kurz" } })).status, 503);
      assert.equal(s.calls.fetch.length, 0);
    }
    assert.equal(calls.fetch.length, 0);
  });
});

describe("logout", () => {
  test("POST clears the cookie (Domain and host-only copies) and returns to the login page", async () => {
    const { call } = setup();
    const res = await call(`https://${EDIT}/__wst/logout`, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/__wst/login");
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const c of cookies) {
      assert.match(c, /^__Secure-wst=;/);
      assert.match(c, /Max-Age=0/);
      assert.match(c, /Secure/);
      assert.match(c, /Path=\//);
    }
    assert.ok(cookies.some((c) => c.includes(`Domain=${READ}`)));
    assert.ok(cookies.some((c) => !c.includes("Domain=")));
  });
  test("GET shows a button (no logout by link or image); cross-site POST is refused", async () => {
    const { call } = setup();
    const page = await call(`https://${EDIT}/__wst/logout`, { headers: navHeaders() });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null);
    assert.match(await page.text(), /<form method="post" action="\/__wst\/logout">/);
    const xs = await call(`https://${EDIT}/__wst/logout`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(xs.status, 403);
    assert.equal(xs.headers.get("set-cookie"), null);
  });
});

describe("PUBLIC_READ_HOSTS (later public phase)", () => {
  const vars = { PUBLIC_READ_HOSTS: READ };
  test("anonymous GET and HEAD on the reading host reach the wiki without any cookie or SSO header", async () => {
    const { call, calls } = setup(vars);
    const res = await call(`https://${READ}/wiki/Hauptseite`, { headers: { cookie: "westernis_session=abc; __Secure-wst=bogus", "x-westernis-user": USER } });
    assert.equal(res.status, 200);
    assert.equal((await call(`https://${READ}/wiki/Hauptseite`, { method: "HEAD" })).status, 200);
    assert.equal(calls.fetch.length, 2);
    assert.equal(calls.fetch[0].headers.get("cookie"), null);
    assert.equal(calls.fetch[0].headers.get("x-westernis-user"), null);
  });
  test("anonymous POST on the reading host and anything anonymous on the edit host: refused", async () => {
    const { call, calls } = setup({ PUBLIC_READ_HOSTS: `${READ},${EDIT}` });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await call(`https://${READ}/api.php`, { method, body: "x" })).status, 401, method);
    }
    assert.equal((await call(`https://${EDIT}/wiki/Hauptseite`)).status, 401);
    assert.equal((await call(`https://${EDIT}/wiki/Hauptseite`, { headers: navHeaders() })).status, 302);
    assert.equal(calls.fetch.length, 0);
  });
  test("a public host that is not in WIKI_HOSTS stays 404", async () => {
    const { call } = setup({ PUBLIC_READ_HOSTS: `${READ},other.example.org` });
    assert.equal((await call("https://other.example.org/")).status, 404);
  });
  test("anonymous login and edit URLs redirect to the edit host", async () => {
    const { call, calls } = setup(vars);
    const cases = [
      "/w/index.php?title=Aragorn_II&action=edit",
      "/w/index.php?title=Aragorn_II&action=submit",
      "/wiki/Aragorn_II?veaction=edit",
      "/wiki/Spezial:Anmelden",
      "/wiki/Special:UserLogin?returnto=Hauptseite",
      "/w/index.php?title=Spezial%3ABenutzerkonto_anlegen",
      "/wiki/Spezial:Formular_bearbeiten/Character/Aragorn",
    ];
    for (const path of cases) {
      const res = await call(`https://${READ}${path}`);
      assert.equal(res.status, 302, path);
      const u = new URL(path, "https://x");
      assert.equal(res.headers.get("location"), `https://${EDIT}${u.pathname}${u.search}`);
    }
    assert.equal(calls.fetch.length, 0);
  });
  test("a signed-in owner on the reading host is not redirected and gets SSO", async () => {
    const { call, calls } = setup(vars);
    const cookie = await signIn(call, READ);
    assert.equal((await call(`https://${READ}/w/index.php?title=X&action=edit`, { headers: { cookie } })).status, 200);
    assert.equal(calls.fetch[0].headers.get("x-westernis-user"), USER);
  });
  test("anonymous images on the reading host come from R2; on the edit host they are refused", async () => {
    const { call, calls } = setup(vars);
    const res = await call(`https://${READ}/images/a/ab/Karte.png`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "png");
    assert.equal((await call(`https://${EDIT}/images/a/ab/Karte.png`)).status, 401);
    assert.equal(calls.fetch.length, 0);
  });
  test("malformed escapes and harmless actions are read normally, not redirected or 500", async () => {
    const { call } = setup(vars);
    assert.equal((await call(`https://${READ}/wiki/%E0%A4%A`)).status, 200);
    assert.equal((await call(`https://${READ}/wiki/Hauptseite?action=history`)).status, 200);
  });
});

describe("forwarding", () => {
  test("client X-Forwarded-*, X-Real-IP replaced or stripped; Host kept", async () => {
    const { call, calls } = setup();
    await call(`https://${EDIT}/api.php?action=query`, {
      headers: {
        "x-westernis-token": TOKEN,
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
        "x-real-ip": "6.6.6.6",
        "cf-connecting-ip": IP,
      },
    });
    const h = calls.fetch[0].headers;
    assert.equal(h.get("x-forwarded-for"), IP);
    assert.equal(h.get("x-forwarded-proto"), "https");
    assert.equal(h.get("x-forwarded-host"), null);
    assert.equal(h.get("x-real-ip"), null);
    assert.equal(new URL(calls.fetch[0].url).host, EDIT); // MediaWiki picks $wgServer from the Host
  });
  test("without CF-Connecting-IP no X-Forwarded-For is invented", async () => {
    const { call, calls } = setup();
    await call(`https://${EDIT}/wiki/X`, { headers: { "x-westernis-token": TOKEN, "x-forwarded-for": "6.6.6.6" } });
    assert.equal(calls.fetch[0].headers.get("x-forwarded-for"), null);
  });
  test("POST bodies are forwarded", async () => {
    const { call, calls } = setup();
    await call(`https://${EDIT}/api.php`, { method: "POST", body: "action=edit&title=X", headers: { "x-westernis-token": TOKEN, "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(await calls.fetch[0].text(), "action=edit&title=X");
  });
  test("authenticated images come from R2 with the gate cookie never leaving the Worker", async () => {
    const { call, calls } = setup();
    const cookie = await signIn(call);
    const res = await call(`https://${READ}/images/a/ab/Karte.png`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(calls.fetch.length, 0);
  });
});

describe("internal paths and /__wst/restart", () => {
  test("/__ready and other /__wst/* paths are 404 even when signed in", async () => {
    const { call, calls } = setup();
    for (const path of ["/__ready", "/__wst/", "/__wst/status", "/__wst"]) {
      assert.equal((await call(`https://${EDIT}${path}`, { headers: { "x-westernis-token": TOKEN } })).status, 404, path);
    }
    assert.equal(calls.fetch.length + calls.restart.length, 0);
  });
  test("POST with the API token calls the DO's restart(); results map to status codes", async () => {
    const { call, calls, setRestartResult } = setup();
    const post = (q = "") => call(`https://${EDIT}/__wst/restart${q}`, { method: "POST", headers: { "x-westernis-token": TOKEN } });
    let res = await post();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /^Gestoppt\./);
    const expect = [
      [{ status: "stopping" }, 202],
      [{ status: "not-running" }, 200],
      [{ status: "killed", exitCode: 137 }, 200],
      [{ status: "failed", exitCode: 1 }, 500],
      [{ status: "timeout" }, 500],
      ["stopped", 200], // the plain-string form of an older Durable Object
    ];
    for (const [r, status] of expect) {
      setRestartResult(r);
      res = await post();
      assert.equal(res.status, status, JSON.stringify(r));
    }
    setRestartResult({ status: "failed", exitCode: 1 });
    assert.match(await (await post()).text(), /Exit-Code 1/);
    setRestartResult({ status: "timeout" });
    assert.match(await (await post()).text(), /force=1/);
    assert.deepEqual(calls.restart[0], { force: false });
    await post("?force=1");
    assert.deepEqual(calls.restart.at(-1), { force: true });
  });
  test("a session cookie is not enough (no CSRF); no credentials: 401; GET with the token: 405", async () => {
    const { call, calls } = setup({ PUBLIC_READ_HOSTS: READ });
    const cookie = await signIn(call);
    const viaCookie = await call(`https://${EDIT}/__wst/restart`, { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin" } });
    assert.equal(viaCookie.status, 403);
    assert.equal((await call(`https://${EDIT}/__wst/restart`, { method: "POST" })).status, 401);
    assert.equal((await call(`https://${READ}/__wst/restart`, { method: "POST" })).status, 401);
    assert.equal((await call(`https://${READ}/__wst/restart`)).status, 403, "anonymous public GET");
    assert.equal((await call(`https://${EDIT}/__wst/restart`, { headers: { "x-westernis-token": TOKEN } })).status, 405);
    assert.equal(calls.restart.length, 0);
  });
});

describe("guest accounts (GATE_USERS)", () => {
  const GUEST_PASSWORD = "Gast Passwort 2026 x";
  let GUEST_HASH;
  before(async () => {
    GUEST_HASH = await gate.hashPassword(GUEST_PASSWORD, { salt: new Uint8Array(16).fill(9) });
  });
  const users = (list) => ({ GATE_USERS: JSON.stringify(list) });
  const rimas = () => users([{ login: "rimas", user: "Rimas", hash: GUEST_HASH }]);
  const login = (call, fields) => call(`https://${EDIT}/__wst/login`, form({ next: "/", ...fields }));
  const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

  test("a guest signs in with name + own password and reaches MediaWiki as that user", async () => {
    const { call, calls } = setup(rimas());
    for (const name of ["rimas", "RIMAS", " Rimas "]) {
      const res = await login(call, { name, password: GUEST_PASSWORD });
      assert.equal(res.status, 303, name);
      const r = await call(`https://${READ}/wiki/Hauptseite`, { headers: { cookie: cookieOf(res) } });
      assert.equal(r.status, 200);
      assert.equal(calls.fetch.at(-1).headers.get("X-Westernis-User"), "Rimas");
    }
  });
  test("the owner still signs in with an empty name (or the owner's wiki name)", async () => {
    const { call, calls } = setup(rimas());
    for (const name of ["", USER, USER.toLowerCase()]) {
      const res = await login(call, { name, password: PASSWORD });
      assert.equal(res.status, 303, `name "${name}"`);
      await call(`https://${READ}/wiki/X`, { headers: { cookie: cookieOf(res) } });
      assert.equal(calls.fetch.at(-1).headers.get("X-Westernis-User"), USER);
    }
  });
  test("wrong combinations are refused: guest name + owner password, no name + guest password, unknown name", async () => {
    const { call } = setup(rimas());
    for (const fields of [
      { name: "rimas", password: PASSWORD },
      { name: "", password: GUEST_PASSWORD },
      { name: "gandalf", password: GUEST_PASSWORD },
      { name: "gandalf", password: PASSWORD },
    ]) {
      const res = await login(call, fields);
      assert.equal(res.status, 401, JSON.stringify(fields));
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });
  test("removing a guest or changing the guest's password ends the guest's sessions only", async () => {
    const a = setup(rimas());
    const guestCookie = cookieOf(await login(a.call, { name: "rimas", password: GUEST_PASSWORD }));
    const ownerCookie = cookieOf(await login(a.call, { name: "", password: PASSWORD }));
    const otherHash = await gate.hashPassword("ein ganz anderes Passwort", { salt: new Uint8Array(16).fill(3) });
    for (const vars of [users([]), users([{ login: "rimas", user: "Rimas", hash: otherHash }])]) {
      const b = setup(vars);
      assert.equal((await b.call(`https://${EDIT}/api.php`, { headers: { cookie: guestCookie } })).status, 401);
      assert.equal((await b.call(`https://${EDIT}/api.php`, { headers: { cookie: ownerCookie } })).status, 200);
    }
  });
  test("an entry that would sign in as the owner, malformed entries and bad JSON are ignored", async () => {
    for (const raw of [
      JSON.stringify([{ login: "boss", user: USER, hash: "x" }]),
      JSON.stringify([{ login: "evil", user: USER, hash: "" }]),
      JSON.stringify([{ login: "x y z?", user: "Bad", hash: "nope" }]),
      "{not json",
    ]) {
      const { call } = setup({ GATE_USERS: raw });
      assert.equal((await login(call, { name: "", password: PASSWORD })).status, 303, "owner unaffected");
      assert.equal(gate.gateUsers({ GATE_USERS: raw, GATE_WIKI_USER: USER }).length, 0, raw);
    }
    const hash = await gate.hashPassword("pw for boss", { salt: new Uint8Array(16).fill(5) });
    assert.equal(gate.gateUsers({ GATE_USERS: JSON.stringify([{ login: "boss", user: USER, hash }]), GATE_WIKI_USER: USER }).length, 0);
  });
  test("a client cannot pick the user: X-Westernis-User from the request is replaced by the session's own", async () => {
    const { call, calls } = setup(rimas());
    const cookie = cookieOf(await login(call, { name: "rimas", password: GUEST_PASSWORD }));
    await call(`https://${READ}/wiki/X`, { headers: { cookie, "x-westernis-user": USER } });
    assert.equal(calls.fetch.at(-1).headers.get("X-Westernis-User"), "Rimas");
  });
  test("the container gets every allowed wiki name (owner first), never a hash", async () => {
    const wc = await import("../src/wiki-container.js");
    const env = { GATE_WIKI_USER: USER, ...rimas() };
    const e = wc.containerEnv(env);
    assert.equal(e.WIKI_SSO_USERS, `${USER},Rimas`);
    assert.doesNotMatch(JSON.stringify(e), /pbkdf2/);
  });
});
