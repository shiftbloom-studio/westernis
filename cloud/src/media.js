// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// /images/* straight from the R2 binding MEDIA (design 1.2): ETag, conditional requests (304/412),
// single byte ranges (206), MediaWiki's upload CSP and nosniff. It never wakes the container, except
// for a thumbnail that is not in R2 yet: Apache rewrites that request to thumb_handler.php, MediaWiki
// renders the size, stores it in R2 and streams it back.

// MediaWiki file zones that must never be served: deleted files, upload stash, transcodes, lock files.
const PRIVATE = /^(deleted|temp|transcoded|lockdir)(\/|$)/;
// Kept in sync with MediaWiki's ContentSecurityPolicy::UPLOAD_CSP / UPLOAD_CSP_PDF (images/.htaccess, 1.46).
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline' data:; font-src data:; img-src data: 'self'; media-src data: 'self'; sandbox";
export const CSP_PDF = CSP.replace("; sandbox", "; object-src 'self'");
const DEFAULT_CACHE_CONTROL = "private, max-age=3600";

const notFound = () => new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * R2 key for an /images/... path, or null when the path must answer 404 (private zone, empty, "..",
 * dot files such as .htaccess, empty segments) and undefined when it is not valid percent-encoding.
 */
export function mediaKey(pathname) {
  if (!pathname.startsWith("/images/")) return null;
  let key;
  try {
    key = decodeURIComponent(pathname.slice("/images/".length));
  } catch {
    return undefined;
  }
  if (!key || PRIVATE.test(key)) return null;
  // Checked after decoding: %2F..%2F must not smuggle a traversal or a private prefix past the URL parser.
  if (key.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith(".") || s.includes("\\"))) return null;
  return key;
}

function objectHeaders(obj, key, env) {
  const h = new Headers();
  obj.writeHttpMetadata(h); // content-type etc. as stored by Extension:AWS
  if (!h.has("content-type")) h.set("content-type", "application/octet-stream");
  h.set("etag", obj.httpEtag);
  h.set("last-modified", obj.uploaded.toUTCString());
  h.set("cache-control", env.MEDIA_CACHE_CONTROL || DEFAULT_CACHE_CONTROL);
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", key.toLowerCase().endsWith(".pdf") ? CSP_PDF : CSP);
  h.set("accept-ranges", "bytes");
  return h;
}

/** If-None-Match: "*" or a list of (weak or strong) ETags; weak comparison as RFC 9110 prescribes for it. */
function noneMatch(header, etag) {
  if (header.trim() === "*") return true;
  const bare = (t) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
}

/** If-Range: a strong ETag must match exactly; an HTTP date must not be older than the object. */
function ifRangeHolds(value, obj) {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("W/")) return v === obj.httpEtag;
  const t = Date.parse(v);
  return Number.isFinite(t) && Math.floor(obj.uploaded.getTime() / 1000) <= Math.floor(t / 1000);
}

function contentRange(r, size) {
  let off;
  let len;
  if (r.suffix !== undefined) {
    len = Math.min(r.suffix, size);
    off = size - len;
  } else {
    off = r.offset ?? 0;
    len = Math.min(r.length ?? size - off, size - off);
  }
  return len > 0 ? `bytes ${off}-${off + len - 1}/${size}` : null;
}

/**
 * @param {Request} request  the already sanitised request (index.js strips client X-Forwarded-* etc.)
 * @param {{MEDIA: R2Bucket, MEDIA_CACHE_CONTROL?: string}} env
 * @param {{fetch(r: Request): Promise<Response>}} wiki  the WikiContainer stub (missing thumbnails only)
 */
export async function serveMedia(request, env, wiki) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const key = mediaKey(new URL(request.url).pathname);
  if (key === undefined) return new Response("Bad Request\n", { status: 400 });
  if (key === null) return notFound();
  const missing = () => (key.startsWith("thumb/") ? wiki.fetch(request) : notFound());
  const rh = request.headers;

  if (request.method === "HEAD") {
    const meta = await env.MEDIA.head(key);
    if (meta === null) return missing();
    const h = objectHeaders(meta, key, env);
    if (rh.has("if-none-match") && noneMatch(rh.get("if-none-match"), meta.httpEtag)) return new Response(null, { status: 304, headers: h });
    h.set("content-length", String(meta.size));
    return new Response(null, { headers: h });
  }

  let range = rh.has("range") ? rh : undefined;
  if (range && rh.has("if-range")) {
    const meta = await env.MEDIA.head(key);
    if (meta === null) return missing();
    if (!ifRangeHolds(rh.get("if-range"), meta)) range = undefined; // changed since: send the whole object
  }
  let obj;
  try {
    obj = await env.MEDIA.get(key, { onlyIf: rh, range });
  } catch (e) {
    if (!range) throw e;
    // Unsatisfiable or multi-part range: RFC 9110 lets a server ignore Range and answer 200 with everything.
    range = undefined;
    obj = await env.MEDIA.get(key, { onlyIf: rh });
  }
  if (obj === null) return missing();

  const h = objectHeaders(obj, key, env);
  if (!("body" in obj) || !obj.body) {
    // A precondition failed: R2 returns the metadata without a body.
    const status = rh.has("if-none-match") || rh.has("if-modified-since") ? 304 : 412;
    return new Response(null, { status, headers: h });
  }
  if (range && obj.range) {
    const cr = contentRange(obj.range, obj.size);
    if (cr) {
      h.set("content-range", cr);
      return new Response(obj.body, { status: 206, headers: h });
    }
  }
  return new Response(obj.body, { status: 200, headers: h });
}
