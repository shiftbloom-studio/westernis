// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Worker "westernis" (design 1.1, 1.2, 1.6, 2.3): exact host allowlist, fail-closed password gate
// (gate.js), single sign-on into MediaWiki, /images/* from R2, POST /__wst/restart (API token only),
// everything else to the one WikiContainer Durable Object.
import { getContainer } from "@cloudflare/containers";
import {
  COOKIE,
  USER_HEADER,
  authenticate,
  gateConfig,
  handleGatePath,
  loginRedirect,
  notConfigured,
  ssoUser,
  stripCookie,
  timing,
  unauthorized,
} from "./gate.js";
import { isNavigation, list, sleep, text } from "./http.js";
import { serveMedia } from "./media.js";
// Only `default`, the Durable Object class and ContainerProxy are exported: the runtime treats every named
// export of the main module as an entrypoint, so helpers stay module-private. ContainerProxy is required by
// @cloudflare/containers 0.3.7: a WikiContainer constructed while its container runs (after a Worker deploy)
// calls applyOutboundInterception(), which needs ctx.exports.ContainerProxy (no interception is configured).
export { WikiContainer } from "./wiki-container.js";
export { ContainerProxy } from "@cloudflare/containers";

const INSTANCE = "westernis"; // exactly one DO = exactly one container = exactly one SQLite writer

// Client-supplied copies are never passed on: the Worker is the only source of these headers.
// Every "X-Westernis-*" header (the API token, the SSO user) is removed as well, see forward().
const STRIP = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip"];

/**
 * Anonymous GET/HEAD is allowed only on a host listed in PUBLIC_READ_HOSTS (empty until the public
 * switch, design 5.2) that is also in WIKI_HOSTS, and never on the always-private edit host.
 */
function anonymousReadAllowed(request, env, host) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (host === String(env.WIKI_EDIT_HOST ?? "").trim().toLowerCase()) return false;
  return list(env.PUBLIC_READ_HOSTS).includes(host) && list(env.WIKI_HOSTS).includes(host);
}

/** Login and edit URLs on the reading host; anonymous visitors are sent to the edit host (behind the gate). */
function wantsLoginOrEdit(url) {
  const action = (url.searchParams.get("action") ?? "").toLowerCase();
  if (["edit", "submit", "formedit", "visualedit"].includes(action) || url.searchParams.has("veaction")) return true;
  let target = `${url.pathname}|${url.searchParams.get("title") ?? ""}`;
  try {
    target = decodeURIComponent(target);
  } catch {
    // keep the raw form; a malformed escape must not turn into a 500
  }
  return /(Special|Spezial):(UserLogin|Anmelden|CreateAccount|Benutzerkonto_anlegen|FormEdit|Formular_bearbeiten)/i.test(target);
}

/**
 * The request as the container sees it: client X-Forwarded-*, X-Real-IP and every X-Westernis-* header
 * removed; the gate cookie removed (all cookies for anonymous readers); X-Westernis-User set only for
 * a gate session (never for API-token requests, which log into MediaWiki with their bot password).
 */
function forward(request, url, auth, env) {
  const fwd = new Request(request);
  for (const name of [...fwd.headers.keys()]) {
    if (name.startsWith("x-westernis-") || STRIP.includes(name)) fwd.headers.delete(name);
  }
  if (auth.kind === "none") {
    fwd.headers.delete("cookie"); // anonymous readers reach MediaWiki without any session
  } else {
    const rest = stripCookie(fwd.headers.get("cookie"), COOKIE);
    if (rest) fwd.headers.set("cookie", rest);
    else fwd.headers.delete("cookie");
  }
  if (auth.kind === "session") {
    // the session's own account (owner or a guest from GATE_USERS), as verified by verifySession
    const user = auth.session?.wikiUser ?? ssoUser(env);
    if (user) fwd.headers.set(USER_HEADER, user);
  }
  fwd.headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) fwd.headers.set("X-Forwarded-For", ip);
  return fwd;
}

/** DO answer -> HTTP answer. Accepts the old plain-string form too (a DO from before a deploy). */
function restartResponse(result) {
  const r = typeof result === "string" ? { status: result } : (result ?? {});
  switch (r.status) {
    case "stopped":
      return text(200, "Gestoppt. Die nächste Anfrage startet Westernis neu.\n");
    case "not-running":
      return text(200, "Westernis lief nicht. Die nächste Anfrage startet es.\n");
    case "stopping":
      return text(202, "Wird gestoppt (letzte Synchronisierung läuft). Die nächste Anfrage wartet darauf und startet Westernis dann neu.\n");
    case "killed":
      return text(200, "Hart beendet (SIGKILL). Die letzten Sekunden vor dem Hänger können fehlen. Die nächste Anfrage startet Westernis neu.\n");
    case "failed":
      return text(500, `Westernis ist beendet, aber mit Exit-Code ${r.exitCode}: die letzte Synchronisierung nach R2 ist vermutlich fehlgeschlagen. Erst das Container-Log prüfen, dann weiterarbeiten.\n`);
    default:
      return text(
        500,
        "Westernis hat sich nicht rechtzeitig beendet und hängt beim Herunterfahren. Details stehen im Container-Log. " +
          "Ist die Frist abgelaufen, beendet POST /__wst/restart?force=1 den Lauf hart.\n",
      );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (!list(env.WIKI_HOSTS).includes(host)) return text(404, "Not found\n");

    const cfg = gateConfig(env);
    if (!cfg.ok) return notConfigured(request); // fail-closed: no secrets, nobody gets in

    const gatePage = await handleGatePath(request, env, url, cfg, host);
    if (gatePage) return gatePage;

    const auth = await authenticate(request, env, cfg);
    if (auth.kind === "token-unconfigured") return text(503, "Das API-Token ist im Worker nicht eingerichtet.\n");
    if (auth.kind === "token-invalid") {
      await sleep(timing.failDelayMs);
      return text(401, "Ungültiges API-Token.\n");
    }
    if (auth.kind === "none") {
      if (!anonymousReadAllowed(request, env, host)) {
        return isNavigation(request) ? loginRedirect(url) : unauthorized(request, url); // never reaches the container
      }
      if (wantsLoginOrEdit(url) && env.WIKI_EDIT_HOST) {
        return Response.redirect(`https://${env.WIKI_EDIT_HOST}${url.pathname}${url.search}`, 302);
      }
    }

    if (url.pathname === "/__wst/restart") {
      // API token only: a browser session cannot be used for it, so no cross-site form can trigger it.
      if (auth.kind !== "token") return text(403, "Nur mit API-Token (X-Westernis-Token).\n");
      if (request.method !== "POST") return text(405, "Method not allowed\n", { allow: "POST" });
      const wiki = getContainer(env.WIKI, INSTANCE);
      return restartResponse(await wiki.restart({ force: url.searchParams.get("force") === "1" })); // DO RPC
    }
    if (url.pathname.startsWith("/__wst/") || url.pathname === "/__wst" || url.pathname === "/__ready") return text(404, "Not found\n");

    const fwd = forward(request, url, auth, env);
    const wiki = getContainer(env.WIKI, INSTANCE);
    if (url.pathname.startsWith("/images/")) return serveMedia(fwd, env, wiki);
    return wiki.fetch(fwd);
  },
};
