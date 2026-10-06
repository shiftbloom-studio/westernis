// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// A small in-memory stand-in for an R2 bucket binding: head(), get(key, { onlyIf, range }) with Headers,
// R2Object vs R2ObjectBody (no `body` when a precondition fails), httpEtag, writeHttpMetadata, ranges.
// It follows the R2 Workers API semantics closely enough to test media.js, not R2 itself.

function meta(key, o) {
  return {
    key,
    size: o.bytes.length,
    etag: o.etag,
    httpEtag: `"${o.etag}"`,
    uploaded: o.uploaded,
    writeHttpMetadata(h) {
      if (o.contentType) h.set("content-type", o.contentType);
    },
  };
}

function preconditionFails(h, m) {
  const tags = (v) => v.split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (h.has("if-match") && !tags(h.get("if-match")).includes(m.httpEtag)) return true;
  if (h.has("if-unmodified-since") && m.uploaded > new Date(h.get("if-unmodified-since"))) return true;
  if (h.has("if-none-match")) {
    const v = h.get("if-none-match").trim();
    if (v === "*" || tags(v).includes(m.httpEtag)) return true;
  } else if (h.has("if-modified-since") && Math.floor(m.uploaded / 1000) <= Math.floor(new Date(h.get("if-modified-since")) / 1000)) {
    return true;
  }
  return false;
}

function parseRange(h, size) {
  const v = h?.get?.("range");
  if (!v) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(v.trim());
  if (!m || (m[1] === "" && m[2] === "")) throw new Error("get: Invalid range (10039)");
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (offset >= size) throw new Error("get: The requested range is not satisfiable (10039)");
  return m[2] === "" ? { offset } : { offset, length: Math.min(Number(m[2]), size - 1) - offset + 1 };
}

export function fakeBucket(objects = {}) {
  const store = new Map();
  const calls = [];
  for (const [key, o] of Object.entries(objects)) {
    store.set(key, {
      bytes: typeof o.body === "string" ? new TextEncoder().encode(o.body) : o.body,
      contentType: o.contentType,
      etag: o.etag ?? `etag-${key.length}-${store.size}`,
      uploaded: o.uploaded ?? new Date("2026-10-01T10:00:00Z"),
    });
  }
  return {
    calls,
    async head(key) {
      calls.push({ op: "head", key });
      const o = store.get(key);
      return o ? meta(key, o) : null;
    },
    async get(key, opts = {}) {
      calls.push({ op: "get", key, opts });
      const o = store.get(key);
      if (!o) return null;
      const m = meta(key, o);
      if (opts.onlyIf instanceof Headers && preconditionFails(opts.onlyIf, m)) return m; // R2Object, no body
      const range = parseRange(opts.range, o.bytes.length);
      let slice = o.bytes;
      if (range) {
        const start = range.suffix !== undefined ? Math.max(0, o.bytes.length - range.suffix) : range.offset;
        const end = range.length !== undefined ? start + range.length : o.bytes.length;
        slice = o.bytes.slice(start, end);
      }
      return { ...m, range, body: new Response(slice).body };
    },
  };
}
