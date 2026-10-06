// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// media.js: /images/* from R2, private zones, conditional and range requests, thumbnail fallback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { serveMedia, mediaKey, CSP, CSP_PDF } from "../src/media.js";
import { fakeBucket } from "./helpers/fake-r2.mjs";

const PNG = "0123456789abcdefghij"; // 20 bytes
const objects = {
  "a/ab/Karte.png": { body: PNG, contentType: "image/png", etag: "png1" },
  "a/ab/Käse.png": { body: "cheese", contentType: "image/png", etag: "kaese" },
  "b/bc/Chronik.pdf": { body: "%PDF-1.7", contentType: "application/pdf", etag: "pdf1" },
  "archive/a/ab/20261001000000!Karte.png": { body: "old", contentType: "image/png", etag: "old1" },
  "thumb/a/ab/Karte.png/120px-Karte.png": { body: "thumb", contentType: "image/png", etag: "th1" },
  "deleted/x/y/zz/abc.png": { body: "secret", contentType: "image/png" },
  "temp/a/ab/stash.png": { body: "secret", contentType: "image/png" },
};

function setup(extraEnv = {}) {
  const MEDIA = fakeBucket(objects);
  const forwarded = [];
  const wiki = {
    async fetch(r) {
      forwarded.push(r);
      return new Response("rendered by MediaWiki", { status: 200, headers: { "x-from": "container" } });
    },
  };
  const env = { MEDIA, MEDIA_CACHE_CONTROL: "private, max-age=3600", ...extraEnv };
  const get = (path, init = {}) => serveMedia(new Request(`https://wiki.example.org${path}`, init), env, wiki);
  return { MEDIA, forwarded, env, get };
}

describe("key mapping and private zones", () => {
  test("percent-decoded key, no leading slash", () => {
    assert.equal(mediaKey("/images/a/ab/K%C3%A4se.png"), "a/ab/Käse.png");
    assert.equal(mediaKey("/images/thumb/a/ab/Karte.png/120px-Karte.png"), "thumb/a/ab/Karte.png/120px-Karte.png");
    assert.equal(mediaKey("/images/a/ab/%E0%A4%A.png"), undefined); // malformed escape
  });

  const blocked = [
    "/images/deleted/x/y/zz/abc.png",
    "/images/temp/a/ab/stash.png",
    "/images/transcoded/a/ab/Video.webm/Video.webm.480p.vp9.webm",
    "/images/lockdir/x",
    "/images/deleted",
    "/images/.htaccess",
    "/images/a/ab/.hidden.png",
    "/images/a/%2E%2E/deleted/x/y/zz/abc.png", // the URL parser folds %2E%2E: lands on deleted/
    "/images/a%2F..%2Fdeleted%2Fx%2Fy%2Fzz%2Fabc.png", // encoded slashes: caught after decoding
    "/images/a/ab%2F%2E%2E%2F%2E%2E%2Fdeleted/x",
    "/images/a/ab%5C..%5Cdeleted/x",
    "/images/",
    "/images//deleted/x/y/zz/abc.png",
    "/images/thumb/../deleted/x/y/zz/abc.png",
  ];
  for (const path of blocked) {
    test(`404 without touching R2 or the container: ${path}`, async () => {
      const { MEDIA, forwarded, get } = setup();
      const res = await get(path);
      assert.equal(res.status, 404);
      assert.equal(MEDIA.calls.length, 0);
      assert.equal(forwarded.length, 0);
    });
  }

  test("400 for malformed percent-encoding", async () => {
    const { MEDIA, get } = setup();
    assert.equal((await get("/images/a/ab/%E0%A4%A.png")).status, 400);
    assert.equal(MEDIA.calls.length, 0);
  });

  test("405 for anything but GET and HEAD", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { method: "POST", body: "x" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  });
});

describe("GET", () => {
  test("200 with metadata, ETag, CSP, nosniff, cache-control", async () => {
    const { get, MEDIA } = setup();
    const res = await get("/images/a/ab/Karte.png");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), PNG);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("etag"), '"png1"');
    assert.equal(res.headers.get("last-modified"), "Thu, 01 Oct 2026 10:00:00 GMT");
    assert.equal(res.headers.get("content-security-policy"), CSP);
    assert.match(CSP, /sandbox$/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(MEDIA.calls[0].key, "a/ab/Karte.png");
  });

  test("decoded key reaches R2; archive/ is served", async () => {
    const { get } = setup();
    assert.equal(await (await get("/images/a/ab/K%C3%A4se.png")).text(), "cheese");
    assert.equal(await (await get("/images/archive/a/ab/20261001000000!Karte.png")).text(), "old");
  });

  test("PDF gets the PDF upload CSP (object-src, no sandbox)", async () => {
    const { get } = setup();
    const res = await get("/images/b/bc/Chronik.pdf");
    assert.equal(res.headers.get("content-security-policy"), CSP_PDF);
    assert.doesNotMatch(CSP_PDF, /sandbox/);
    assert.match(CSP_PDF, /object-src 'self'/);
  });

  test("MEDIA_CACHE_CONTROL is honoured (public phase)", async () => {
    const { get } = setup({ MEDIA_CACHE_CONTROL: "public, max-age=3600" });
    assert.equal((await get("/images/a/ab/Karte.png")).headers.get("cache-control"), "public, max-age=3600");
  });

  test("missing original: 404 and the container is not woken", async () => {
    const { get, forwarded } = setup();
    assert.equal((await get("/images/c/cd/Fehlt.png")).status, 404);
    assert.equal(forwarded.length, 0);
  });

  test("missing thumbnail: forwarded to the container (thumb_handler), response passed through", async () => {
    const { get, forwarded } = setup();
    const res = await get("/images/thumb/a/ab/Karte.png/640px-Karte.png");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-from"), "container");
    assert.equal(forwarded.length, 1);
    assert.equal(new URL(forwarded[0].url).pathname, "/images/thumb/a/ab/Karte.png/640px-Karte.png");
  });

  test("existing thumbnail is served from R2 without the container", async () => {
    const { get, forwarded } = setup();
    assert.equal(await (await get("/images/thumb/a/ab/Karte.png/120px-Karte.png")).text(), "thumb");
    assert.equal(forwarded.length, 0);
  });
});

describe("conditional requests", () => {
  test("If-None-Match with the current ETag: 304 without body", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { "if-none-match": '"png1"' } });
    assert.equal(res.status, 304);
    assert.equal(res.body, null);
    assert.equal(res.headers.get("etag"), '"png1"');
  });
  test("If-None-Match with a stale ETag: 200", async () => {
    const { get } = setup();
    assert.equal((await get("/images/a/ab/Karte.png", { headers: { "if-none-match": '"old"' } })).status, 200);
  });
  test("If-Modified-Since not older than the upload: 304", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { "if-modified-since": "Thu, 01 Oct 2026 10:00:00 GMT" } });
    assert.equal(res.status, 304);
  });
  test("If-Match mismatch: 412", async () => {
    const { get } = setup();
    assert.equal((await get("/images/a/ab/Karte.png", { headers: { "if-match": '"other"' } })).status, 412);
  });
});

describe("ranges", () => {
  test("bytes=2-5: 206 with Content-Range", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=2-5" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 2-5/20");
    assert.equal(await res.text(), "2345");
  });
  test("open range bytes=15-: 206 to the end", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=15-" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 15-19/20");
    assert.equal(await res.text(), "fghij");
  });
  test("suffix range bytes=-3: 206 with the last 3 bytes", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=-3" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 17-19/20");
    assert.equal(await res.text(), "hij");
  });
  test("suffix longer than the object is clamped", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=-500" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 0-19/20");
  });
  test("unsatisfiable or multi-part range: Range ignored, 200 with everything", async () => {
    const { get } = setup();
    for (const range of ["bytes=999-", "bytes=0-1,4-5"]) {
      const res = await get("/images/a/ab/Karte.png", { headers: { range } });
      assert.equal(res.status, 200, range);
      assert.equal(res.headers.get("content-range"), null);
      assert.equal(await res.text(), PNG);
    }
  });
  test("If-Range with the current ETag keeps the range", async () => {
    const { get } = setup();
    const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=0-1", "if-range": '"png1"' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), "01");
  });
  test("If-Range with a stale ETag or an old date sends the whole object", async () => {
    const { get } = setup();
    for (const ifRange of ['"stale"', "Wed, 30 Sep 2026 10:00:00 GMT"]) {
      const res = await get("/images/a/ab/Karte.png", { headers: { range: "bytes=0-1", "if-range": ifRange } });
      assert.equal(res.status, 200, ifRange);
      assert.equal(await res.text(), PNG);
    }
  });
  test("Range on a missing thumbnail still goes to the container", async () => {
    const { get, forwarded } = setup();
    const res = await get("/images/thumb/a/ab/Karte.png/800px-Karte.png", { headers: { range: "bytes=0-1", "if-range": '"x"' } });
    assert.equal(res.headers.get("x-from"), "container");
    assert.equal(forwarded.length, 1);
  });
});

describe("HEAD", () => {
  test("200 with Content-Length and no body", async () => {
    const { get, MEDIA } = setup();
    const res = await get("/images/a/ab/Karte.png", { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "20");
    assert.equal(res.headers.get("etag"), '"png1"');
    assert.equal(res.body, null);
    assert.deepEqual(MEDIA.calls.map((c) => c.op), ["head"]);
  });
  test("If-None-Match: 304", async () => {
    const { get } = setup();
    assert.equal((await get("/images/a/ab/Karte.png", { method: "HEAD", headers: { "if-none-match": 'W/"png1"' } })).status, 304);
  });
  test("missing original: 404; missing thumbnail: container", async () => {
    const { get, forwarded } = setup();
    assert.equal((await get("/images/c/cd/Fehlt.png", { method: "HEAD" })).status, 404);
    assert.equal(forwarded.length, 0);
    await get("/images/thumb/c/cd/Fehlt.png/120px-Fehlt.png", { method: "HEAD" });
    assert.equal(forwarded.length, 1);
  });
});
