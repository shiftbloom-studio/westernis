// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// The pages a browser sees while the wiki container is not ready (design 1.4):
//   wakingPage()  503 "Westernis erwacht …"             Retry-After 5, reloads itself every 4 s
//   failedPage()  503 "Westernis konnte nicht starten"   no refresh (a FATAL boot guard must not loop)
//   stuckPage()   503 "Westernis lässt sich nicht beenden" the old run is past its drain deadline
// All are self-contained: inline CSS only, no fonts, images or scripts. Any asset request would go
// to the sleeping container and be held there until it is ready. The gate pages (login.js) reuse
// renderPage() and CSS so everything the Worker answers itself looks the same.
import { escapeHtml } from "./http.js";

export const NIGHT = "#0b0a12"; // theme surface (night)
export const GOLD = "#e3c16f"; // theme gilt

export const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  background: radial-gradient(ellipse at 50% 38%, #1a1626 0%, ${NIGHT} 62%) fixed, ${NIGHT};
  color: #d9cfbb; font-family: "EB Garamond", Garamond, "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 1.15rem; line-height: 1.6; text-align: center;
}
main { width: 100%; max-width: 34rem; }
.star { width: 64px; height: 64px; margin: 0 auto 1.6rem; position: relative; }
.star::before, .star::after {
  content: ""; position: absolute; inset: 0; margin: auto; background: ${GOLD};
  clip-path: polygon(50% 0, 56% 44%, 100% 50%, 56% 56%, 50% 100%, 44% 56%, 0 50%, 44% 44%);
}
.star::after { transform: rotate(45deg) scale(0.62); opacity: 0.7; }
.wake .star { animation: glow 3.2s ease-in-out infinite; }
.fail .star { filter: grayscale(0.6); opacity: 0.55; }
@keyframes glow {
  0%, 100% { opacity: 0.55; transform: scale(0.94); filter: drop-shadow(0 0 2px rgba(227, 193, 111, 0.3)); }
  50% { opacity: 1; transform: scale(1); filter: drop-shadow(0 0 14px rgba(227, 193, 111, 0.65)); }
}
h1 {
  margin: 0; color: ${GOLD}; font-family: "Cinzel", "Trajan Pro", "EB Garamond", Georgia, serif;
  font-weight: 500; font-size: clamp(1.7rem, 6vw, 2.5rem); letter-spacing: 0.08em;
  font-variant-caps: small-caps; text-shadow: 0 0 22px rgba(227, 193, 111, 0.25);
}
.rule { display: flex; align-items: center; gap: 0.7rem; margin: 1.1rem auto 1.3rem; max-width: 18rem; }
.rule::before, .rule::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, rgba(227, 193, 111, 0.55), transparent); }
.rule span { width: 7px; height: 7px; background: ${GOLD}; transform: rotate(45deg); opacity: 0.8; }
p { margin: 0.4rem 0; }
a { color: ${GOLD}; }
.hint { color: #a39985; font-size: 0.95rem; font-style: italic; }
@media (prefers-reduced-motion: reduce) { .wake .star { animation: none; opacity: 0.9; } }
`;

/**
 * A complete HTML page in the Westernis look. `body` is trusted HTML (callers escape their values);
 * `title`, `heading`, `lines` and `hint` are plain text and escaped here.
 */
export function renderPage({ title, heading = title, lines = [], hint = "", body = "", refresh = 0, mode = "", css = "" }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${NIGHT}">
${refresh ? `<meta http-equiv="refresh" content="${Number(refresh)}">\n` : ""}<title>${escapeHtml(title)}</title>
<style>${CSS}${css}</style>
</head>
<body class="${escapeHtml(mode)}">
<main role="main" aria-live="polite">
<div class="star" aria-hidden="true"></div>
<h1>${escapeHtml(heading)}</h1>
<div class="rule" aria-hidden="true"><span></span></div>
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n")}${body ? `\n${body}` : ""}
${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
</main>
</body>
</html>
`;
}

const WAKING_HTML = renderPage({
  title: "Westernis erwacht …",
  lines: ["Einen Augenblick."],
  hint: "Die Seite lädt sich von selbst neu, sobald das Wiki bereit ist.",
  refresh: 4,
  mode: "wake",
});

const FAILED_HTML = renderPage({
  title: "Westernis konnte nicht starten",
  lines: ["Details stehen im Container-Log."],
  hint: "Ein erneutes Laden versucht den Start in einer Minute noch einmal.",
  mode: "fail",
});

const STUCK_HTML = renderPage({
  title: "Westernis lässt sich nicht beenden",
  lines: ["Der vorige Lauf hängt beim Herunterfahren fest. Details stehen im Container-Log."],
  hint: "Ein erzwungener Neustart (POST /__wst/restart?force=1 mit dem API-Token) beendet ihn hart.",
  mode: "fail",
});

export function htmlHeaders(extra) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex",
    ...extra,
  };
}

/** 503 while the container starts: Retry-After 5, the page itself refreshes after 4 s. */
export function wakingPage() {
  return new Response(WAKING_HTML, { status: 503, headers: htmlHeaders({ "retry-after": "5" }) });
}

/** 503 after a failed start. No refresh: a FATAL boot guard would otherwise restart the container every few seconds. */
export function failedPage() {
  return new Response(FAILED_HTML, { status: 503, headers: htmlHeaders() });
}

/** 503 while an old container is past its drain deadline: no new start (single writer), no refresh. */
export function stuckPage() {
  return new Response(STUCK_HTML, { status: 503, headers: htmlHeaders() });
}
