// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// gate.js on its own: PBKDF2 hash format, password and token checks, the constant-time compare,
// session cookie signature / expiry / password version, next-path validation, configuration parsing.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  PBKDF2_ITERATIONS,
  b64encode,
  b64decode,
  parsePasswordHash,
  hashPassword,
  verifyPassword,
  tokenMatches,
  timingSafeEqual,
  gateConfig,
  passwordVersion,
  sessionDays,
  apiToken,
  ssoUser,
  cookieDomain,
  makeSession,
  verifySession,
  cookieValues,
  stripCookie,
  safeNext,
  timing,
} from "../src/gate.js";

const SALT = new Uint8Array(16).map((_, i) => i + 1);
const PASSWORD = "Mellon & Mithril – Märchen 7"; // non-ASCII: NFD differs, so no normalisation is tested too
const HASH = await hashPassword(PASSWORD, { salt: SALT });
const SECRET = "s".repeat(32);
const env = (extra = {}) => ({
  GATE_PASSWORD_HASH: HASH,
  SESSION_SECRET: SECRET,
  WIKI_SERVER: "https://wiki.example.org",
  WIKI_HOSTS: "wiki.example.org,edit.wiki.example.org",
  WIKI_EDIT_HOST: "edit.wiki.example.org",
  ...extra,
});

describe("PBKDF2 hash format", () => {
  test("hashPassword: pbkdf2-sha256$100000$<salt>$<hash>, standard base64, 16-byte salt, 32-byte hash", async () => {
    assert.equal(PBKDF2_ITERATIONS, 100_000);
    const m = /^pbkdf2-sha256\$100000\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(HASH);
    assert.ok(m, HASH);
    assert.deepEqual(b64decode(m[1]), SALT);
    assert.equal(b64decode(m[2]).length, 32);
    const random = await hashPassword("x");
    assert.notEqual(random.split("$")[2], HASH.split("$")[2], "a fresh random salt per call");
  });
  test("matches an independent PBKDF2 implementation (node:crypto)", async () => {
    const { pbkdf2Sync } = await import("node:crypto");
    const ref = pbkdf2Sync(Buffer.from(PASSWORD, "utf8"), Buffer.from(SALT), 100_000, 32, "sha256").toString("base64");
    assert.equal(HASH.split("$")[3], ref);
  });
  test("parsePasswordHash accepts standard and URL-safe base64, padded or not, and surrounding whitespace", () => {
    const [, , s, h] = HASH.split("$");
    const url = (x) => x.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const v of [HASH, ` ${HASH}\n`, `pbkdf2-sha256$100000$${url(s)}$${url(h)}`]) {
      const p = parsePasswordHash(v);
      assert.ok(p, v);
      assert.equal(p.iterations, 100_000);
      assert.deepEqual(p.salt, SALT);
    }
  });
  test("parsePasswordHash rejects everything else (fail-closed)", () => {
    const [, , s, h] = HASH.split("$");
    const bad = [
      undefined,
      "",
      "geheim",
      `pbkdf2-sha1$100000$${s}$${h}`,
      `pbkdf2-sha256$600000$${s}$${h}`, // more than the Workers runtime allows
      `pbkdf2-sha256$10000$${s}$${h}`, // weaker than the contract
      `pbkdf2-sha256$100000$${b64encode(new Uint8Array(8))}$${h}`, // salt too short
      `pbkdf2-sha256$100000$${s}$${b64encode(new Uint8Array(16))}`, // hash not 32 bytes
      `pbkdf2-sha256$100000$${s}$not*base64`,
      `pbkdf2-sha256$100000$${s}`,
      `pbkdf2-sha256$100000$${s}$${h}$extra`,
      `bcrypt$100000$${s}$${h}`,
    ];
    for (const v of bad) assert.equal(parsePasswordHash(v), null, String(v));
  });
});

describe("password and token checks", () => {
  const parsed = parsePasswordHash(HASH);
  test("verifyPassword: exact UTF-8 string only", async () => {
    assert.equal(await verifyPassword(PASSWORD, parsed), true);
    for (const wrong of ["", " " + PASSWORD, PASSWORD + " ", PASSWORD.toLowerCase(), PASSWORD.normalize("NFD"), "x".repeat(2000)]) {
      assert.equal(await verifyPassword(wrong, parsed), false, JSON.stringify(wrong.slice(0, 40)));
    }
    assert.equal(await verifyPassword(PASSWORD, null), false);
    assert.equal(await verifyPassword(undefined, parsed), false);
  });
  test("tokenMatches: equal strings only, any length", async () => {
    const t = "t".repeat(43);
    assert.equal(await tokenMatches(t, t), true);
    assert.equal(await tokenMatches(t.slice(1), t), false);
    assert.equal(await tokenMatches(t + "x", t), false);
    assert.equal(await tokenMatches("", t), false);
  });
});

describe("constant-time compare", () => {
  const restore = [];
  after(() => restore.forEach((f) => f()));

  test("fallback loop: equal, unequal and length mismatch", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3, 4])), true);
    assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3, 5])), false);
    assert.equal(timingSafeEqual(a, new Uint8Array([0, 2, 3, 4])), false);
    assert.equal(timingSafeEqual(a, new Uint8Array([1, 2, 3])), false);
    assert.equal(timingSafeEqual(a, "1234"), false);
  });
  test("password, token and cookie checks all go through the runtime's crypto.subtle.timingSafeEqual when present", async () => {
    const calls = [];
    const subtle = globalThis.crypto.subtle;
    const had = Object.prototype.hasOwnProperty.call(subtle, "timingSafeEqual");
    subtle.timingSafeEqual = (a, b) => {
      calls.push(a.byteLength);
      let d = 0;
      for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
      return d === 0;
    };
    restore.push(() => (had ? null : delete subtle.timingSafeEqual));
    try {
      assert.equal(await verifyPassword(PASSWORD, parsePasswordHash(HASH)), true);
      assert.equal(await verifyPassword("falsch", parsePasswordHash(HASH)), false);
      assert.equal(await tokenMatches("a".repeat(40), "b".repeat(32)), false);
      const cfg = gateConfig(env());
      const cookie = await makeSession(cfg, env());
      assert.ok(await verifySession(cookie, cfg, env()));
      assert.deepEqual(calls, [32, 32, 32, 32], "PBKDF2 output x2, SHA-256 digests, HMAC");
    } finally {
      delete subtle.timingSafeEqual;
    }
  });
});

describe("configuration (fail-closed)", () => {
  test("missing or malformed secrets: not ok, with a reason", () => {
    assert.equal(gateConfig(env()).ok, true);
    for (const [extra, re] of [
      [{ GATE_PASSWORD_HASH: undefined }, /GATE_PASSWORD_HASH/],
      [{ GATE_PASSWORD_HASH: "plaintext-password" }, /GATE_PASSWORD_HASH/],
      [{ SESSION_SECRET: undefined }, /SESSION_SECRET/],
      [{ SESSION_SECRET: "short" }, /SESSION_SECRET/],
    ]) {
      const c = gateConfig(env(extra));
      assert.equal(c.ok, false);
      assert.match(c.reason, re);
    }
    assert.equal(gateConfig(undefined).ok, false);
  });
  test("password version: first 12 hex chars of SHA-256(GATE_PASSWORD_HASH)", async () => {
    const { createHash } = await import("node:crypto");
    const pv = await passwordVersion(gateConfig(env()));
    assert.equal(pv, createHash("sha256").update(HASH).digest("hex").slice(0, 12));
  });
  test("SESSION_DAYS: integer 1..365, default 30", () => {
    assert.equal(sessionDays({}), 30);
    assert.equal(sessionDays({ SESSION_DAYS: "7" }), 7);
    assert.equal(sessionDays({ SESSION_DAYS: 14 }), 14);
    for (const v of ["0", "-1", "1.5", "abc", "366", ""]) assert.equal(sessionDays({ SESSION_DAYS: v }), 30, v);
  });
  test("API_TOKEN must be at least 32 characters", () => {
    assert.equal(apiToken({ API_TOKEN: "x".repeat(32) }), "x".repeat(32));
    assert.equal(apiToken({ API_TOKEN: "x".repeat(31) }), "");
    assert.equal(apiToken({}), "");
  });
  test("SSO user: trimmed printable ASCII, else none", () => {
    assert.equal(ssoUser({ GATE_WIKI_USER: " Admin " }), "Admin");
    assert.equal(ssoUser({ GATE_WIKI_USER: "Fabian Zimber" }), "Fabian Zimber");
    for (const v of [undefined, "", "   ", "Jörg", "a\r\nX-Evil: 1", "a\tb"]) assert.equal(ssoUser({ GATE_WIKI_USER: v }), null, String(v));
  });
  test("cookie Domain: the reading host when the edit host is below it, else host-only", () => {
    assert.equal(cookieDomain(env(), "wiki.example.org"), "wiki.example.org");
    assert.equal(cookieDomain(env(), "edit.wiki.example.org"), "wiki.example.org");
    assert.equal(cookieDomain(env({ WIKI_EDIT_HOST: "edit.example.org" }), "edit.example.org"), undefined);
    assert.equal(cookieDomain(env({ WIKI_SERVER: "http://localhost:8787", WIKI_HOSTS: "localhost", WIKI_EDIT_HOST: "localhost" }), "localhost"), undefined);
    assert.equal(cookieDomain(env({ WIKI_SERVER: "not a url" }), "wiki.example.org"), undefined);
    assert.equal(cookieDomain(env(), "other.example.org"), undefined);
  });
});

describe("session cookie", () => {
  const cfg = gateConfig(env());
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const day = 86_400_000;

  test("round trip: {v:1, iat, exp, pv}, 30 days", async () => {
    const value = await makeSession(cfg, env(), now);
    assert.match(value, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const p = await verifySession(value, cfg, env(), now + day);
    assert.equal(p.v, 1);
    assert.equal(p.exp - p.iat, 30 * 86_400);
    assert.equal(p.pv, await passwordVersion(cfg));
  });
  test("expiry: valid until exp, invalid from then on", async () => {
    const value = await makeSession(cfg, env(), now);
    assert.ok(await verifySession(value, cfg, env(), now + 30 * day - 1000));
    assert.equal(await verifySession(value, cfg, env(), now + 30 * day), null);
  });
  test("a shorter SESSION_DAYS also shortens cookies issued before", async () => {
    const value = await makeSession(cfg, env(), now);
    assert.equal(await verifySession(value, cfg, env({ SESSION_DAYS: "7" }), now + day), null);
  });
  test("tampered payload, signature, other secret: invalid", async () => {
    const value = await makeSession(cfg, env(), now);
    const [p, s] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, iat: 1, exp: 9_999_999_999, pv: await passwordVersion(cfg) })).toString("base64url");
    for (const v of [`${forged}.${s}`, `${p}.${s.slice(0, -2)}AA`, `${p}x.${s}`, `${p}`, `${p}.${s}.x`, "", "a".repeat(2000)]) {
      assert.equal(await verifySession(v, cfg, env(), now + day), null, v.slice(0, 30));
    }
    const other = gateConfig(env({ SESSION_SECRET: "o".repeat(32) }));
    assert.equal(await verifySession(value, other, env({ SESSION_SECRET: "o".repeat(32) }), now + day), null);
  });
  test("password version mismatch: a new password ends every session", async () => {
    const value = await makeSession(cfg, env(), now);
    const newHash = await hashPassword("ein neues Passwort", { salt: SALT });
    const cfg2 = gateConfig(env({ GATE_PASSWORD_HASH: newHash }));
    assert.equal(await verifySession(value, cfg2, env({ GATE_PASSWORD_HASH: newHash }), now + day), null);
  });
  test("a signed payload with a wrong shape or a future iat is refused", async () => {
    const { createHmac } = await import("node:crypto");
    const sign = (obj) => {
      const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
      return `${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`;
    };
    const pv = await passwordVersion(cfg);
    const t = Math.floor(now / 1000);
    assert.ok(await verifySession(sign({ v: 1, iat: t, exp: t + 100, pv }), cfg, env(), now), "control: correctly signed");
    for (const obj of [
      { v: 2, iat: t, exp: t + 100, pv },
      { v: 1, iat: String(t), exp: t + 100, pv },
      { v: 1, iat: t + 3600, exp: t + 7200, pv }, // issued in the future
      { v: 1, iat: t - 10, exp: t + 400 * 86_400, pv }, // longer than SESSION_DAYS
      { v: 1, iat: t, exp: t + 100 },
    ]) {
      assert.equal(await verifySession(sign(obj), cfg, env(), now), null, JSON.stringify(obj));
    }
  });
  test("cookieValues and stripCookie", () => {
    const h = "a=1; __Secure-wst=one; b=2;__Secure-wst=two ; __secure-WST=three; c";
    assert.deepEqual(cookieValues(h, "__Secure-wst"), ["one", "two"]);
    assert.equal(stripCookie(h, "__Secure-wst"), "a=1; b=2; c");
    assert.equal(stripCookie("__Secure-wst=x", "__Secure-wst"), "");
    assert.equal(stripCookie(null, "__Secure-wst"), "");
  });
});

describe("next-path validation (no open redirect)", () => {
  test("relative same-site paths pass, normalised", () => {
    const ok = {
      "/": "/",
      "/wiki/Hauptseite": "/wiki/Hauptseite",
      "/w/index.php?title=X&action=edit": "/w/index.php?title=X&action=edit",
      "/wiki/Käse": "/wiki/K%C3%A4se",
      "/wiki/A#Abschnitt": "/wiki/A",
      "/wiki/a/../b": "/wiki/b",
      "/w/index.php?search=a\\b": "/w/index.php?search=a\\b",
    };
    for (const [input, out] of Object.entries(ok)) assert.equal(safeNext(input), out, input);
  });
  test("everything that could leave the site becomes /", () => {
    const bad = [
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/ /evil.example",
      "/..//evil.example",
      "/%2e%2e//evil.example",
      "https://evil.example/",
      "http:evil.example",
      "javascript:alert(1)",
      "evil.example",
      " /wiki/X",
      "",
      undefined,
      null,
      42,
      "/" + "a".repeat(2100),
      "/__wst/login",
      "/__wst/restart",
      "/__wst",
    ];
    for (const v of bad) assert.equal(safeNext(v), "/", JSON.stringify(v));
  });
});

test("production failure delay is 750 ms", () => {
  assert.equal(timing.failDelayMs, 750);
});
