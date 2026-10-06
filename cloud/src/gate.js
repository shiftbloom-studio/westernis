// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// The password gate (design 1.6, 2.3). One user, one password, no Cloudflare Access:
//   - Browsers sign in at /__wst/login. The password is checked against the Worker secret
//     GATE_PASSWORD_HASH ("pbkdf2-sha256$100000$<salt_b64>$<hash_b64>", PBKDF2-HMAC-SHA256 via WebCrypto)
//     and answered with the signed session cookie "__Secure-wst" (HMAC-SHA256 with SESSION_SECRET).
//   - Scripts (Forge MCP, wst.ps1) send "X-Westernis-Token: <API_TOKEN>" instead.
//   - Fail-closed: without a well-formed GATE_PASSWORD_HASH and SESSION_SECRET nothing gets in (503).
// Every secret comparison runs through timingSafeEqual() on fixed-length digests.
// Runs unchanged in Node >= 22 (globalThis.crypto), so a script may import hashPassword() from here.
import { escapeHtml, isNavigation, list, sleep, text } from "./http.js";
import { loginPage, logoutPage, messagePage } from "./login.js";

export const PBKDF2_ITERATIONS = 100_000; // the Workers runtime refuses more than 100000 iterations
export const SALT_MIN_BYTES = 16;
export const HASH_BYTES = 32; // PBKDF2-HMAC-SHA256 output length stored in GATE_PASSWORD_HASH
export const MIN_SECRET_LENGTH = 32; // SESSION_SECRET and API_TOKEN
export const COOKIE = "__Secure-wst";
export const TOKEN_HEADER = "x-westernis-token";
export const USER_HEADER = "X-Westernis-User";
export const DEFAULT_SESSION_DAYS = 30;
export const LOGIN_PATH = "/__wst/login";
export const LOGOUT_PATH = "/__wst/logout";
const MAX_FORM_BYTES = 8192;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_COOKIE_LENGTH = 1024;
const CLOCK_SKEW_S = 300;

/** Tests shorten the failure delay; production uses 750 ms. */
export const timing = { failDelayMs: 750 };

const enc = new TextEncoder();
const dec = new TextDecoder();
const log = (o) => console.log(JSON.stringify(o));

// ------------------------------------------------------------------------------------------ encoding

/** Standard or URL-safe base64, padding optional. Returns a Uint8Array, or null when it is not base64. */
export function b64decode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  let t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (t.length % 4 === 1) return null;
  t += "=".repeat((4 - (t.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Standard base64 with padding (the format GATE_PASSWORD_HASH uses). */
export function b64encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const b64url = (bytes) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

// ------------------------------------------------------------------------------------------ crypto

/**
 * Constant-time equality of two byte arrays. Callers pass digests of a fixed, public length, so only a
 * length mismatch (a programming error) returns early. Uses the runtime's crypto.subtle.timingSafeEqual
 * (Workers) when present, else an XOR-accumulate loop over every byte.
 */
export function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) return false;
  const native = globalThis.crypto?.subtle?.timingSafeEqual;
  if (typeof native === "function") return native.call(crypto.subtle, a, b) === true;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password, salt, iterations, bytes) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, bytes * 8);
  return new Uint8Array(bits);
}

/**
 * "pbkdf2-sha256$100000$<salt_b64>$<hash_b64>" -> { iterations, salt, hash }, or null if malformed:
 * other algorithm or iteration count, salt shorter than 16 bytes, hash not 32 bytes, not base64.
 */
export function parsePasswordHash(value) {
  const m = /^pbkdf2-sha256\$(\d{1,7})\$([^$\s]+)\$([^$\s]+)$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const iterations = Number(m[1]);
  if (iterations !== PBKDF2_ITERATIONS) return null;
  const salt = b64decode(m[2]);
  const hash = b64decode(m[3]);
  if (!salt || salt.length < SALT_MIN_BYTES || !hash || hash.length !== HASH_BYTES) return null;
  return { iterations, salt, hash };
}

/**
 * The GATE_PASSWORD_HASH value for a password: PBKDF2-HMAC-SHA256, 100000 iterations, 16 random salt
 * bytes, 32-byte result, standard base64. The password is the UTF-8 encoding of the string exactly as
 * typed (no trimming, no Unicode normalisation).
 */
export async function hashPassword(password, { salt = crypto.getRandomValues(new Uint8Array(SALT_MIN_BYTES)) } = {}) {
  if (typeof password !== "string" || password.length === 0) throw new Error("empty password");
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, HASH_BYTES);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

/** true if `password` matches the parsed hash; the comparison is constant-time. */
export async function verifyPassword(password, parsed) {
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH || !parsed) return false;
  const got = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.hash.length);
  return timingSafeEqual(got, parsed.hash);
}

/** Compares a presented API token with the secret: both are hashed first, so length leaks nothing. */
export async function tokenMatches(given, expected) {
  const [a, b] = await Promise.all([sha256(String(given)), sha256(String(expected))]);
  return timingSafeEqual(a, b);
}

// ------------------------------------------------------------------------------------------ configuration

let cfgCache; // { hashRaw, secret, cfg } for the values of this isolate
let warned = false;

/**
 * The gate's configuration, or { ok: false, reason } when GATE_PASSWORD_HASH or SESSION_SECRET is
 * missing or malformed. Then the Worker answers 503 to everything: never open.
 */
export function gateConfig(env) {
  const hashRaw = env?.GATE_PASSWORD_HASH;
  const secret = env?.SESSION_SECRET;
  if (cfgCache && cfgCache.hashRaw === hashRaw && cfgCache.secret === secret) return cfgCache.cfg;
  let cfg;
  const password = parsePasswordHash(hashRaw);
  if (!password) cfg = { ok: false, reason: "GATE_PASSWORD_HASH is missing or malformed" };
  else if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH)
    cfg = { ok: false, reason: `SESSION_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters` };
  else cfg = { ok: true, password, secret, hashRaw: String(hashRaw).trim() };
  cfgCache = { hashRaw, secret, cfg };
  if (!cfg.ok && !warned) {
    warned = true;
    console.error(JSON.stringify({ evt: "gate-not-configured", reason: cfg.reason }));
  }
  return cfg;
}

/** Password version: the first 12 hex chars of SHA-256(GATE_PASSWORD_HASH). A new password ends all sessions. */
export async function passwordVersion(cfg) {
  cfg.pv ??= hex(await sha256(cfg.hashRaw)).slice(0, 12);
  return cfg.pv;
}

// ------------------------------------------------------------------------------------------ guest accounts

/** Login names of guest accounts: lower case, letters, digits, space, ".", "_", "-" (max 64). */
export const LOGIN_NAME_RE = /^[a-z0-9][a-z0-9 ._-]{0,63}$/;
const WIKI_USER_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
let usersCache; // { raw, owner, users }

/**
 * Guest accounts from the Worker secret GATE_USERS: a JSON array of { login, user, hash } (login name typed
 * on the login page, MediaWiki user name, GATE_PASSWORD_HASH-format hash). Invalid entries, and entries that
 * would sign in as the owner's wiki account, are skipped (logged); the owner's own login is never affected.
 */
export function gateUsers(env) {
  const raw = env?.GATE_USERS;
  const owner = (ssoUser(env) ?? "").toLowerCase();
  if (usersCache && usersCache.raw === raw && usersCache.owner === owner) return usersCache.users;
  const users = [];
  const skip = (reason) => console.error(JSON.stringify({ evt: "gate-users-invalid", reason }));
  if (typeof raw === "string" && raw.trim()) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) skip("GATE_USERS is not a JSON array");
    else {
      for (const e of parsed) {
        const login = String(e?.login ?? "").trim().toLowerCase();
        const user = String(e?.user ?? "").trim();
        const password = parsePasswordHash(e?.hash);
        if (!LOGIN_NAME_RE.test(login) || !WIKI_USER_RE.test(user) || !password) { skip(`entry "${login}" is malformed`); continue; }
        if (user.toLowerCase() === owner || login === owner) { skip(`entry "${login}" would sign in as the owner`); continue; }
        if (users.some((u) => u.login === login || u.user === user)) { skip(`entry "${login}" is a duplicate`); continue; }
        users.push({ login, user, password, hashRaw: String(e.hash).trim() });
      }
    }
  }
  usersCache = { raw, owner, users };
  return users;
}

/** The MediaWiki names the gate may sign in (owner first), for the container's WIKI_SSO_USERS. */
export function ssoUsers(env) {
  return [ssoUser(env), ...gateUsers(env).map((u) => u.user)].filter(Boolean);
}

/**
 * The account a login form names: empty (or the owner's wiki name) = the owner; otherwise a guest from
 * GATE_USERS by login name or wiki name (case-insensitive); null when there is none.
 */
export function findAccount(cfg, env, name) {
  const n = String(name ?? "").trim().toLowerCase();
  const ownerName = (ssoUser(env) ?? "").toLowerCase();
  if (!n || (ownerName && n === ownerName)) return { owner: true, user: ssoUser(env), password: cfg.password, hashRaw: cfg.hashRaw };
  return gateUsers(env).find((u) => u.login === n || u.user.toLowerCase() === n) ?? null;
}

/** Password version of an account (first 12 hex chars of SHA-256 of its hash): a new password ends its sessions. */
async function accountVersion(cfg, account) {
  if (!account || account.owner) return passwordVersion(cfg);
  account.pv ??= hex(await sha256(account.hashRaw)).slice(0, 12);
  return account.pv;
}

/** SESSION_DAYS as an integer 1..365, default 30. */
export function sessionDays(env) {
  const n = Number(String(env?.SESSION_DAYS ?? "").trim() || DEFAULT_SESSION_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_SESSION_DAYS;
}

/** API_TOKEN if it is usable (>= 32 characters), else "" (token logins are then refused with 503). */
export function apiToken(env) {
  const t = typeof env?.API_TOKEN === "string" ? env.API_TOKEN.trim() : "";
  return t.length >= MIN_SECRET_LENGTH ? t : "";
}

/** GATE_WIKI_USER for the SSO header, or null if unset or not printable ASCII (a header must stay byte-exact). */
export function ssoUser(env) {
  const u = String(env?.GATE_WIKI_USER ?? "").trim();
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(u) ? u : null;
}

/**
 * Cookie Domain: the reading host (hostname of WIKI_SERVER) when the edit host is a subdomain of it and
 * the request is on one of the two, so one sign-in covers both hosts. Otherwise undefined (host-only cookie).
 */
export function cookieDomain(env, host) {
  let read;
  try {
    read = new URL(String(env?.WIKI_SERVER ?? "")).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const edit = String(env?.WIKI_EDIT_HOST ?? "").trim().toLowerCase();
  if (!read || !edit.endsWith(`.${read}`) || !list(env?.WIKI_HOSTS).includes(read)) return undefined;
  return host === read || host.endsWith(`.${read}`) ? read : undefined;
}

// ------------------------------------------------------------------------------------------ session cookie

const hmacKeys = new Map();
async function hmac(secret, data) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.clear(); // one secret per isolate; a rotated secret replaces the old key
    hmacKeys.set(secret, key);
  }
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/**
 * "<base64url(JSON {v:1, iat, exp, pv[, u]})>.<base64url(HMAC-SHA256(SESSION_SECRET, first part))>";
 * `u` (the MediaWiki user) is set for guest accounts only, so owner sessions keep their old form.
 */
export async function makeSession(cfg, env, now = Date.now(), account = null) {
  const iat = Math.floor(now / 1000);
  const exp = iat + sessionDays(env) * 86_400;
  const body = { v: 1, iat, exp, pv: await accountVersion(cfg, account) };
  if (account && !account.owner) body.u = account.user;
  const payload = b64url(enc.encode(JSON.stringify(body)));
  return `${payload}.${b64url(await hmac(cfg.secret, payload))}`;
}

/**
 * The session payload (plus `wikiUser`, the MediaWiki user it signs in) if the cookie value is authentic,
 * unexpired and for the account's current password; null otherwise, also for a guest no longer in GATE_USERS.
 */
export async function verifySession(value, cfg, env, now = Date.now()) {
  if (typeof value !== "string" || value.length > MAX_COOKIE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  const sig = b64decode(parts[1]);
  if (!sig || sig.length !== 32) return null;
  if (!timingSafeEqual(await hmac(cfg.secret, parts[0]), sig)) return null;
  let p;
  try {
    p = JSON.parse(dec.decode(b64decode(parts[0])));
  } catch {
    return null;
  }
  if (!p || p.v !== 1 || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null;
  const t = Math.floor(now / 1000);
  const maxAge = sessionDays(env) * 86_400;
  if (p.exp <= t || p.iat > t + CLOCK_SKEW_S || p.exp - p.iat > maxAge || t - p.iat > maxAge) return null;
  if (p.u === undefined) {
    if (p.pv !== (await passwordVersion(cfg))) return null;
    return { ...p, wikiUser: ssoUser(env) };
  }
  if (typeof p.u !== "string") return null;
  const guest = gateUsers(env).find((g) => g.user === p.u);
  if (!guest || p.pv !== (await accountVersion(cfg, guest))) return null;
  return { ...p, wikiUser: guest.user };
}

/** All values of cookie `name` in a Cookie header (browsers may send two with different Domain). */
export function cookieValues(header, name) {
  const out = [];
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** The Cookie header without `name` (compared case-insensitively), or "" when nothing is left. */
export function stripCookie(header, name) {
  const lower = name.toLowerCase();
  return String(header ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && (s.includes("=") ? s.slice(0, s.indexOf("=")) : s).trim().toLowerCase() !== lower)
    .join("; ");
}

function setCookie(value, domain, maxAge) {
  return [`${COOKIE}=${value}`, domain && `Domain=${domain}`, "Path=/", `Max-Age=${maxAge}`, "Secure", "HttpOnly", "SameSite=Lax"]
    .filter(Boolean)
    .join("; ");
}

// ------------------------------------------------------------------------------------------ requests

/**
 * Validated target after a sign-in: a same-site relative path ("/…", never "//…" or "/\…"), at most
 * 2048 characters, no control characters or spaces (URL parsers drop tabs and newlines, so "/\t/x"
 * would turn into "//x"), not a /__wst/ path. Anything else becomes "/".
 */
export function safeNext(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (/[\u0000- \u007f]/.test(raw)) return "/";
  const cut = raw.search(/[?#]/);
  const path = cut < 0 ? raw : raw.slice(0, cut);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  let u;
  try {
    u = new URL(raw, "https://gate.invalid");
  } catch {
    return "/";
  }
  if (u.origin !== "https://gate.invalid") return "/";
  const out = u.pathname + u.search; // "/..//x" normalises to "//x": checked again below
  if (out.startsWith("//") || out.startsWith("/__wst/") || out === "/__wst") return "/";
  return out;
}

/**
 * Who sent this request:
 *   { kind: "token" }               valid X-Westernis-Token
 *   { kind: "token-invalid" }       a token header that does not match
 *   { kind: "token-unconfigured" }  a token header, but API_TOKEN is not set (or shorter than 32 chars)
 *   { kind: "session", session }    valid session cookie
 *   { kind: "none" }                nothing valid
 */
export async function authenticate(request, env, cfg) {
  const token = request.headers.get(TOKEN_HEADER);
  if (token !== null) {
    const expected = apiToken(env);
    if (!expected) return { kind: "token-unconfigured" };
    return (await tokenMatches(token, expected)) ? { kind: "token" } : { kind: "token-invalid" };
  }
  for (const value of cookieValues(request.headers.get("cookie"), COOKIE)) {
    const session = await verifySession(value, cfg, env);
    if (session) return { kind: "session", session };
  }
  return { kind: "none" };
}

/** Where an unauthenticated browser is sent: the login page, remembering the requested path. */
export function loginRedirect(url) {
  const next = safeNext(url.pathname + url.search);
  const location = next === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

/** 401 for an unauthenticated request that is not a GET navigation (API, assets, a form POST). */
export function unauthorized(request, url) {
  if (request.headers.get("sec-fetch-mode") === "navigate") {
    // A form POST after the session ended: sign in in a new tab, then resend the form from this one.
    const href = `${LOGIN_PATH}?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`;
    return messagePage(401, {
      title: "Anmeldung erforderlich",
      lines: ["Die Sitzung ist abgelaufen."],
      body: `<p><a href="${escapeHtml(href)}" target="_blank" rel="noopener">In einem neuen Tab anmelden</a>, dann das Formular hier noch einmal senden.</p>`,
    });
  }
  return text(401, "Anmeldung erforderlich.\n", { "www-authenticate": 'Westernis-Token realm="Westernis"' });
}

/** 503 while the gate secrets are missing: a page for browsers, plain text for everything else. */
export function notConfigured(request) {
  if (isNavigation(request)) {
    return messagePage(503, {
      title: "Westernis ist noch nicht eingerichtet.",
      heading: "Noch nicht eingerichtet",
      lines: ["Westernis ist noch nicht eingerichtet."],
      hint: "Es fehlen Worker-Secrets; Details stehen im Worker-Log.",
    });
  }
  return text(503, "Westernis ist noch nicht eingerichtet.\n");
}

function crossSite(request, env) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return !list(env.WIKI_HOSTS).includes(new URL(origin).hostname.toLowerCase());
  } catch {
    return true;
  }
}

async function readForm(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return null;
  if (!request.body) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new URLSearchParams(dec.decode(all));
}

/** true = within the limit, false = over it (or the limiter failed), null = no LOGIN_LIMIT binding. */
async function withinLimit(env, request) {
  const rl = env.LOGIN_LIMIT;
  if (!rl || typeof rl.limit !== "function") return null;
  const key = request.headers.get("cf-connecting-ip") || "unknown";
  try {
    const { success } = await rl.limit({ key });
    return success === true;
  } catch (e) {
    console.error(JSON.stringify({ evt: "gate-ratelimit-error", error: String(e?.message ?? e) }));
    return false; // fail closed: no brake, no attempt
  }
}

async function login(request, env, url, cfg, host) {
  if (request.method === "GET" || request.method === "HEAD") {
    const next = safeNext(url.searchParams.get("next") ?? "/");
    const auth = await authenticate(request, env, cfg);
    if (auth.kind === "session") return new Response(null, { status: 303, headers: { location: next, "cache-control": "no-store" } });
    return loginPage({ next, days: sessionDays(env) });
  }
  if (request.method !== "POST") return text(405, "Method not allowed\n", { allow: "GET, HEAD, POST" });
  if (crossSite(request, env)) return text(403, "Zugriff verweigert.\n");

  const within = await withinLimit(env, request);
  if (within === null) {
    console.error(JSON.stringify({ evt: "gate-not-configured", reason: "LOGIN_LIMIT rate limiting binding is missing" }));
    return messagePage(503, { title: "Westernis ist noch nicht eingerichtet.", heading: "Noch nicht eingerichtet", lines: ["Die Anmeldung ist noch nicht eingerichtet."] });
  }
  if (!within) {
    log({ evt: "gate-login", ok: false, reason: "rate-limited" });
    return messagePage(429, {
      title: "Zu viele Versuche",
      lines: ["Bitte warte eine Minute und versuche es dann noch einmal."],
      body: `<p><a href="${escapeHtml(LOGIN_PATH)}">Zur Anmeldung</a></p>`,
      headers: { "retry-after": "60" },
    });
  }

  const form = await readForm(request);
  const next = safeNext(form?.get("next") ?? "/");
  const name = String(form?.get("name") ?? "").slice(0, 128);
  const account = form !== null ? findAccount(cfg, env, name) : null;
  // An unknown name costs the same PBKDF2 work as a wrong password (no account enumeration by timing).
  const checked = await verifyPassword(form?.get("password") ?? "", account ? account.password : cfg.password);
  const ok = account !== null && checked;
  if (!ok) {
    await sleep(timing.failDelayMs);
    log({ evt: "gate-login", ok: false });
    return loginPage({ next, days: sessionDays(env), error: "Name oder Passwort stimmt nicht.", status: 401, name });
  }
  log({ evt: "gate-login", ok: true, user: account.owner ? "owner" : account.user });
  const value = await makeSession(cfg, env, Date.now(), account);
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": setCookie(value, cookieDomain(env, host), sessionDays(env) * 86_400),
      "cache-control": "no-store",
    },
  });
}

function logout(request, env, host) {
  if (request.method === "GET" || request.method === "HEAD") return logoutPage();
  if (request.method !== "POST") return text(405, "Method not allowed\n", { allow: "GET, HEAD, POST" });
  if (crossSite(request, env)) return text(403, "Zugriff verweigert.\n");
  // No Clear-Site-Data: it would wipe every cookie of the registrable domain, not just ours.
  const h = new Headers({ location: LOGIN_PATH, "cache-control": "no-store" });
  const domain = cookieDomain(env, host);
  if (domain) h.append("set-cookie", setCookie("", domain, 0));
  h.append("set-cookie", setCookie("", undefined, 0)); // a host-only copy from an earlier configuration
  return new Response(null, { status: 303, headers: h });
}

/** /__wst/login and /__wst/logout (both hosts), or null for any other path. */
export async function handleGatePath(request, env, url, cfg, host) {
  if (url.pathname === LOGIN_PATH) return login(request, env, url, cfg, host);
  if (url.pathname === LOGOUT_PATH) return logout(request, env, host);
  return null;
}

