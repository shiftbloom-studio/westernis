// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Small HTTP helpers shared by the Worker (index.js, gate.js) and the Durable Object (wiki-container.js).

/** "a.example, B.example ," -> ["a.example", "b.example"] */
export const list = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** A plain-text answer that no cache keeps. */
export const text = (status, body, extra = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

/** A top-level browser navigation (gets a page) as opposed to API, assets, XHR, scripts (get a status). */
export function isNavigation(request) {
  if (request.method !== "GET") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** Text for an HTML attribute or element body. */
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
