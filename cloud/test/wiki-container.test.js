// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// wiki-container.js against the REAL @cloudflare/containers 0.3.7 Container class, driven by a fake
// ctx.container (helpers/fake-container-ctx.mjs) and shortened timings.
import "./helpers/workers-shim.mjs";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeContainerCtx } from "./helpers/fake-container-ctx.mjs";

const { WikiContainer, containerEnv, isNavigation, PORT, START, MAX_STOP_WAIT_MS, EXTERNAL_DRAIN_MS } = await import("../src/wiki-container.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  WIKI_SERVER: "https://wiki.example.org",
  WIKI_HOSTS: "wiki.example.org,edit.wiki.example.org",
  WIKI_EDIT_HOST: "edit.wiki.example.org",
  R2_ACCOUNT_ID: "acct",
  R2_DB_BUCKET: "westernis-db",
  R2_MEDIA_BUCKET: "westernis-media",
  R2_DB_ACCESS_KEY_ID: "db-key",
  R2_DB_SECRET_ACCESS_KEY: "db-secret",
  R2_MEDIA_ACCESS_KEY_ID: "media-key",
  R2_MEDIA_SECRET_ACCESS_KEY: "media-secret",
  WIKI_SECRET_KEY: "wiki-secret",
  WST_DB_GENERATION: "g1",
  WST_BOOTSTRAP: "",
  GATE_WIKI_USER: " Admin ",
  GATE_PASSWORD_HASH: "must-not-reach-the-container",
  SESSION_SECRET: "must-not-reach-the-container",
  API_TOKEN: "must-not-reach-the-container",
  SESSION_DAYS: "30",
};

const TIMING = {
  start: { instanceGetTimeoutMS: 500, portReadyTimeoutMS: 3000, waitInterval: 10 },
  navWaitMs: 80,
  maxStopWaitMs: 2000,
  restartWaitMs: 1000,
  failCooldownMs: 300,
  externalDrainMs: 5000,
  stopPollMs: 5,
  exitCodeWaitMs: 200,
  probeTimeoutMs: 200,
};

function make(opts) {
  const fake = fakeContainerCtx(opts);
  const wc = new WikiContainer(fake.ctx, env);
  wc.timing = { ...TIMING, start: { ...TIMING.start } };
  return { wc, ...fake };
}

/** A second object on the same state: what the runtime does after a deploy or an eviction. */
function reincarnate(fake) {
  const wc = new WikiContainer(fake.ctx, env);
  wc.timing = { ...TIMING, start: { ...TIMING.start } };
  return wc;
}

const api = () => new Request("https://edit.wiki.example.org/api.php?action=query&meta=siteinfo", { headers: { accept: "*/*" } });
const nav = () =>
  new Request("https://wiki.example.org/wiki/Hauptseite", { headers: { "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml" } });

before(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});
after(() => mock.restoreAll());

describe("helpers", () => {
  test("containerEnv: DB token as LITESTREAM_*, no AWS_*, no gate secrets, SSO user, unset values left out", () => {
    const e = containerEnv({ ...env, R2_MEDIA_SECRET_ACCESS_KEY: undefined });
    assert.equal(e.LITESTREAM_ACCESS_KEY_ID, "db-key");
    assert.equal(e.LITESTREAM_SECRET_ACCESS_KEY, "db-secret");
    assert.equal(e.R2_MEDIA_ACCESS_KEY_ID, "media-key");
    assert.equal("R2_MEDIA_SECRET_ACCESS_KEY" in e, false);
    assert.equal(e.WIKI_DEBUG, "0");
    assert.equal(e.WST_RESTORE_FROM, "");
    assert.equal(e.WIKI_SSO_USER, "Admin");
    assert.equal(Object.keys(e).some((k) => k.startsWith("AWS_")), false);
    for (const k of ["GATE_PASSWORD_HASH", "SESSION_SECRET", "API_TOKEN", "GATE_WIKI_USER", "SESSION_DAYS", "R2_DB_ACCESS_KEY_ID"]) {
      assert.equal(k in e, false, k);
    }
    assert.ok(!Object.values(e).includes("must-not-reach-the-container"));
    assert.ok(Object.values(e).every((v) => typeof v === "string"));
    assert.equal(containerEnv({ ...env, GATE_WIKI_USER: undefined }).WIKI_SSO_USER, "", "no user: SSO off, but the variable exists");
  });
  test("isNavigation: Sec-Fetch-Mode wins, Accept is the fallback, only GET", () => {
    assert.equal(isNavigation(nav()), true);
    assert.equal(isNavigation(new Request("https://x/", { headers: { "sec-fetch-mode": "cors", accept: "text/html" } })), false);
    assert.equal(isNavigation(new Request("https://x/", { headers: { accept: "text/html" } })), true);
    assert.equal(isNavigation(api()), false);
    assert.equal(isNavigation(new Request("https://x/", { method: "POST", headers: { "sec-fetch-mode": "navigate" }, body: "x" })), false);
  });
  test("production timings: 5 min / 15 min start, 12 min drain, 16 min external drain", () => {
    assert.deepEqual(START, { instanceGetTimeoutMS: 300_000, portReadyTimeoutMS: 900_000, waitInterval: 1000 });
    assert.equal(PORT, 8080);
    assert.equal(MAX_STOP_WAIT_MS, 12 * 60_000);
    assert.ok(EXTERNAL_DRAIN_MS > 15 * 60_000, "longer than the platform's SIGTERM -> SIGKILL window");
  });
});

describe("cold start", () => {
  test("API request is held until ready, then proxied; one start with our env; readiness via /__ready on :8080", async () => {
    const { wc, log } = make({ bootMs: 60 });
    assert.equal(wc.pingEndpoint, "localhost/__ready");
    assert.equal(wc.sleepAfter, "20m");
    const res = await wc.fetch(api());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `hello from :${PORT}`);
    assert.equal(log.starts.length, 1);
    assert.equal(log.starts[0].cfg.enableInternet, true);
    assert.equal(log.starts[0].cfg.env.LITESTREAM_ACCESS_KEY_ID, "db-key");
    assert.equal(log.starts[0].cfg.env.WIKI_SSO_USER, "Admin");
    assert.ok(log.pings.some((p) => p.url === "http://localhost/__ready" && p.port === PORT));
    assert.equal((await wc.getState()).status, "healthy");
    await wc.fetch(api());
    assert.equal(log.starts.length, 1);
    assert.equal(log.proxied.length, 2);
  });

  test("concurrent requests share one start", async () => {
    const { wc, log } = make({ bootMs: 60 });
    const all = await Promise.all([wc.fetch(api()), wc.fetch(api()), wc.fetch(nav())]);
    assert.deepEqual(all.map((r) => r.status), [200, 200, 200]);
    assert.equal(log.starts.length, 1);
  });

  test("navigation gets the waking page while the boot takes longer, then the wiki", async () => {
    const { wc, log } = make({ bootMs: 300 });
    const first = await wc.fetch(nav());
    assert.equal(first.status, 503);
    assert.equal(first.headers.get("retry-after"), "5");
    assert.equal(first.headers.get("cache-control"), "no-store");
    const html = await first.text();
    assert.match(html, /Westernis erwacht/);
    assert.match(html, /http-equiv="refresh" content="4"/);
    assert.doesNotMatch(html, /<script|<link|src=/i, "no external assets");
    assert.equal((await wc.fetch(nav())).status, 503); // still booting: same start, no second one
    await sleep(350);
    const later = await wc.fetch(nav());
    assert.equal(later.status, 200);
    assert.equal(log.starts.length, 1);
  });
});

describe("failed start", () => {
  test("failure page without refresh, cooldown without new starts, then a new attempt", async () => {
    const { wc, log } = make({ bootMs: 20, failWith: 73 });
    const res = await wc.fetch(api());
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /Westernis konnte nicht starten/);
    assert.doesNotMatch(html, /http-equiv="refresh"/);
    assert.equal(log.starts.length, 1);
    // within the cooldown: no restart loop, also not for navigations
    assert.match(await (await wc.fetch(nav())).text(), /konnte nicht starten/);
    assert.equal(log.starts.length, 1);
    await sleep(350);
    await wc.fetch(api());
    assert.equal(log.starts.length, 2);
  });
});

describe("graceful stop", () => {
  async function running(opts) {
    const m = make(opts);
    assert.equal((await m.wc.fetch(api())).status, 200);
    return m;
  }

  test("restart(): exactly one SIGTERM, waits for the exit, answers 'stopped' with exit code 0", async () => {
    const { wc, log, container, storage } = await running({ drainMs: 50 });
    assert.deepEqual(await wc.restart(), { status: "stopped", exitCode: 0 });
    assert.deepEqual(log.signals.map((s) => s.n), [15]);
    assert.equal(container.running, false);
    assert.equal(storage.has("wst:drain"), false, "the drain record is cleared once the run has exited");
  });

  test("a non-zero exit after SIGTERM is reported as 'failed' (final sync most likely failed)", async () => {
    const { wc, log } = await running({ drainMs: 30, termExitCode: 1 });
    assert.deepEqual(await wc.restart(), { status: "failed", exitCode: 1 });
    assert.equal(log.signals.length, 1);
  });

  test("the drain record is written before the signal is sent", async () => {
    const { wc, container, storage } = await running({ drainMs: 30 });
    const orig = container.signal.bind(container);
    let recordAtSignal;
    container.signal = (n) => {
      recordAtSignal = storage.get("wst:drain");
      orig(n);
    };
    await wc.restart();
    assert.equal(recordAtSignal?.reason, "admin");
    assert.equal(typeof recordAtSignal?.at, "number");
  });

  test("a request during the drain waits for the exit, then starts a new container", async () => {
    const { wc, log } = await running({ drainMs: 80 });
    const drain = wc.restart();
    await sleep(5);
    const res = await wc.fetch(api());
    assert.equal(res.status, 200);
    assert.equal((await drain).status, "stopped");
    assert.equal(log.starts.length, 2);
    assert.ok(log.starts[1].at >= log.exits[0].at, "second start only after the old process exited");
    assert.equal(log.signals.length, 1);
  });

  test("concurrent restarts and idle expiry share one drain and one signal", async () => {
    const { wc, log } = await running({ drainMs: 60 });
    const results = await Promise.all([wc.restart(), wc.restart(), wc.onActivityExpired()]);
    assert.deepEqual(results.slice(0, 2).map((r) => r.status), ["stopped", "stopped"]);
    assert.equal(log.signals.length, 1);
  });

  test("restart() returns 'stopping' when the drain outlasts restartWaitMs; the drain still completes", async () => {
    const { wc, log, container } = await running({ drainMs: 200 });
    wc.timing.restartWaitMs = 30;
    assert.deepEqual(await wc.restart(), { status: "stopping" });
    assert.equal(container.running, true);
    await sleep(250);
    assert.equal(container.running, false);
    assert.equal(log.signals.length, 1);
  });

  test("onActivityExpired (sleepAfter) drains with one SIGTERM", async () => {
    const { wc, log, container } = await running({ drainMs: 20 });
    await wc.onActivityExpired();
    assert.equal(container.running, false);
    assert.deepEqual(log.signals.map((s) => s.n), [15]);
  });

  test("restart() when nothing runs: 'not-running', no signal", async () => {
    const { wc, log } = make();
    assert.deepEqual(await wc.restart(), { status: "not-running" });
    assert.equal(log.signals.length, 0);
  });
});

describe("a drain that hangs (review finding: no second SIGTERM, no requests to a closed Apache)", () => {
  async function hung() {
    const m = make({ ignoreSigterm: true });
    assert.equal((await m.wc.fetch(api())).status, 200);
    m.wc.timing.maxStopWaitMs = 60;
    assert.deepEqual(await m.wc.restart(), { status: "timeout" });
    return m;
  }

  test("after the deadline: ready() stays false and requests get the 'stuck' page, never the closed Apache", async () => {
    const { wc, log } = await hung();
    assert.equal(await wc.ready(), false);
    const proxiedBefore = log.proxied.length;
    for (const req of [api(), nav()]) {
      const res = await wc.fetch(req);
      assert.equal(res.status, 503);
      assert.match(await res.text(), /lässt sich nicht beenden/);
    }
    assert.equal(log.proxied.length, proxiedBefore);
    assert.equal(log.starts.length, 1, "no second writer");
  });

  test("idle expiry and further restarts never send a second signal", async () => {
    const { wc, log } = await hung();
    await wc.onActivityExpired();
    assert.equal((await wc.restart()).status, "timeout");
    await wc.onActivityExpired();
    assert.deepEqual(log.signals.map((s) => s.n), [15]);
    assert.equal(log.destroys, 0);
  });

  test("a restarted Durable Object remembers the signal (persisted drain record)", async () => {
    const m = await hung();
    const wc2 = reincarnate(m);
    await wc2.onActivityExpired();
    assert.equal((await wc2.restart()).status, "timeout");
    assert.equal((await wc2.fetch(api())).status, 503);
    assert.deepEqual(m.log.signals.map((s) => s.n), [15]);
  });

  test("restart({ force: true }) escalates only a drain past its deadline: SIGKILL, then a fresh start", async () => {
    const { wc, log, container } = await hung();
    assert.equal((await wc.restart({ force: true })).status, "killed");
    assert.equal(log.destroys, 1);
    assert.equal(container.running, false);
    assert.equal((await wc.fetch(api())).status, 200);
    assert.equal(log.starts.length, 2);
  });

  test("force on a healthy container is an ordinary graceful restart (no SIGKILL)", async () => {
    const m = make({ drainMs: 20 });
    assert.equal((await m.wc.fetch(api())).status, 200);
    assert.equal((await m.wc.restart({ force: true })).status, "stopped");
    assert.equal(m.log.destroys, 0);
    assert.deepEqual(m.log.signals.map((s) => s.n), [15]);
  });
});

describe("a Durable Object restart during a drain", () => {
  test("the new object waits for the signalled run instead of signalling or starting a second one", async () => {
    const m = make({ drainMs: 150 });
    assert.equal((await m.wc.fetch(api())).status, 200);
    m.wc.timing.restartWaitMs = 10;
    assert.equal((await m.wc.restart()).status, "stopping");
    const wc2 = reincarnate(m); // the old object's in-memory promise is gone
    assert.equal(await wc2.ready(), false);
    await wc2.onActivityExpired();
    assert.equal(m.log.signals.length, 1);
    const res = await wc2.fetch(api());
    assert.equal(res.status, 200);
    assert.equal(m.log.starts.length, 2);
    assert.ok(m.log.starts[1].at >= m.log.exits[0].at);
  });
});

describe("the platform's own SIGTERM (rollout, host maintenance)", () => {
  test("idle expiry does not add a second SIGTERM to a container that no longer answers /__ready", async () => {
    const m = make({ drainMs: 120 });
    assert.equal((await m.wc.fetch(api())).status, 200);
    m.container.platformSigterm();
    await m.wc.onActivityExpired();
    assert.equal(m.log.signals.length, 0, "the DO sent nothing");
    await sleep(150);
    assert.equal(m.container.running, false);
  });

  test("a container silent for longer than the platform's kill window is signalled after all", async () => {
    const m = make({ ignoreSigterm: true });
    assert.equal((await m.wc.fetch(api())).status, 200);
    m.container.platformSigterm(); // stops listening, never exits (hung)
    m.wc.timing.externalDrainMs = 40;
    m.wc.timing.maxStopWaitMs = 30;
    await m.wc.onActivityExpired();
    assert.equal(m.log.signals.length, 0);
    await sleep(60);
    await m.wc.onActivityExpired();
    assert.deepEqual(m.log.signals.map((s) => s.n), [15]);
  });
});
