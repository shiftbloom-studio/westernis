// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// The gate's own pages (design 1.6): login, logout, and short messages (429, 503, 401 for a form POST).
// German, the Westernis look of waking.js, inline CSS only, no external assets, never indexed or framed.
import { escapeHtml } from "./http.js";
import { GOLD, NIGHT, htmlHeaders, renderPage } from "./waking.js";

const FORM_CSS = `
form { margin: 1.4rem auto 0.6rem; max-width: 20rem; display: flex; flex-direction: column; gap: 0.7rem; text-align: left; }
label { color: #a39985; font-size: 0.95rem; letter-spacing: 0.04em; }
input[type=password], input[type=text] {
  width: 100%; padding: 0.6rem 0.75rem; border-radius: 6px; font: inherit; color: #efe6d2;
  background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(227, 193, 111, 0.35); box-sizing: border-box;
}
input[type=password]:focus, input[type=text]:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; border-color: ${GOLD}; }
label .opt { color: #7d7564; font-size: 0.85rem; }
button {
  margin-top: 0.3rem; padding: 0.6rem 1rem; border-radius: 6px; cursor: pointer; font: inherit;
  font-family: "Cinzel", "Trajan Pro", "EB Garamond", Georgia, serif; letter-spacing: 0.08em;
  color: ${NIGHT}; background: ${GOLD}; border: 1px solid ${GOLD};
}
button:hover, button:focus-visible { filter: brightness(1.08); outline: 2px solid #f3dc9a; outline-offset: 2px; }
.error { color: #f0a58f; }
`;

/** Headers for every gate page: no caching, no indexing, no framing, nothing but inline CSS and same-origin forms. */
export const PAGE_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const page = (status, html, extra = {}) => new Response(html, { status, headers: htmlHeaders({ ...PAGE_HEADERS, ...extra }) });

/** The sign-in form. `next` must already be validated (gate.js safeNext). */
export function loginPage({ next = "/", days = 30, error = "", status = 200, name = "" } = {}) {
  const body = `${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>\n` : ""}<form method="post" action="/__wst/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="name">Name <span class="opt">(nur für Gäste)</span></label>
<input id="name" type="text" name="name" value="${escapeHtml(name)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64">
<label for="password">Passwort</label>
<input id="password" type="password" name="password" autocomplete="current-password" required autofocus maxlength="1024">
<button type="submit">Eintreten</button>
</form>`;
  const html = renderPage({
    title: "Westernis – Anmeldung",
    heading: "Westernis",
    lines: ["Sprich, Freund, und tritt ein."],
    body,
    hint: `Die Anmeldung gilt ${Number(days)} Tage auf diesem Gerät.`,
    css: FORM_CSS,
  });
  return page(status, html);
}

/** GET /__wst/logout: a button, because signing out is a POST (no cross-site logout by link or image). */
export function logoutPage() {
  const html = renderPage({
    title: "Westernis – Abmelden",
    heading: "Abmelden",
    lines: ["Danach fragt Westernis auf diesem Gerät wieder nach dem Passwort."],
    body: `<form method="post" action="/__wst/logout">\n<button type="submit">Abmelden</button>\n</form>`,
    css: FORM_CSS,
  });
  return page(200, html);
}

/** A short message page; `body` is trusted HTML, the rest is escaped. */
export function messagePage(status, { title, heading = title, lines = [], body = "", hint = "", headers = {} }) {
  return page(status, renderPage({ title, heading, lines, body, hint, mode: status >= 500 ? "fail" : "", css: FORM_CSS }), headers);
}
