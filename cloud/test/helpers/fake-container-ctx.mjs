// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// A fake DurableObjectState with a fake `ctx.container`, so the REAL @cloudflare/containers 0.3.7
// Container class can run in Node. The fake container "boots" for `bootMs`, then answers on its port;
// it can fail during boot with an exit code. On SIGTERM it stops listening at once (Apache's graceful
// stop) and exits `drainMs` later with `termExitCode` (unless ignoreSigterm). `platformSigterm()`
// simulates the platform's own SIGTERM (rollout, host maintenance), which the Durable Object never sees.
// Two WikiContainer objects built on the same ctx simulate a Durable Object restart (shared storage).

// workerd global used by Container.containerFetch to stream bodies
globalThis.IdentityTransformStream ??= class extends TransformStream {};

const NOT_LISTENING = "the container is not listening";

export function fakeContainerCtx({ bootMs = 30, failWith = null, drainMs = 30, ignoreSigterm = false, termExitCode = 0 } = {}) {
  const storage = new Map();
  const log = { starts: [], signals: [], platformSignals: [], pings: [], proxied: [], exits: [], destroys: 0 };
  let readyAt = Infinity;
  let exitMonitor;

  const terminate = () => {
    readyAt = Infinity; // graceful stop: the listener closes first
    if (container.running && !ignoreSigterm) setTimeout(() => container.running && exitMonitor(termExitCode), drainMs);
  };

  const container = {
    running: false,
    start(cfg) {
      if (this.running) throw new Error("start() cannot be called on a container that is already running.");
      this.running = true;
      log.starts.push({ cfg, at: Date.now() });
      readyAt = failWith === null ? Date.now() + bootMs : Infinity;
      const monitor = new Promise((resolve, reject) => {
        exitMonitor = (code) => {
          this.running = false;
          log.exits.push({ code, at: Date.now() });
          if (code === 0) resolve();
          else reject(new Error(`Container exited with unexpected exit code: ${code}`));
        };
      });
      monitor.catch(() => {}); // the class attaches its own handlers later; avoid Node's unhandled-rejection exit
      this._monitor = monitor;
      if (failWith !== null) setTimeout(() => exitMonitor(failWith), bootMs);
    },
    monitor() {
      return this._monitor;
    },
    signal(n) {
      log.signals.push({ n, at: Date.now() });
      if (n === 9 && this.running) exitMonitor(137);
      else if (n === 15) terminate();
    },
    platformSigterm() {
      log.platformSignals.push({ n: 15, at: Date.now() });
      terminate();
    },
    async destroy() {
      log.destroys++;
      if (this.running) exitMonitor(137);
    },
    getTcpPort(port) {
      return {
        fetch: async (url, init) => {
          if (!container.running || Date.now() < readyAt) throw new Error(NOT_LISTENING);
          const href = typeof url === "string" ? url : url.url;
          if (init instanceof Request) {
            log.proxied.push({ port, url: href, headers: init.headers });
          } else {
            log.pings.push({ port, url: href });
          }
          const res = new Response(`hello from :${port}`, { status: 200 });
          Object.defineProperty(res, "webSocket", { value: null });
          return res;
        },
      };
    },
  };

  const ctx = {
    id: { toString: () => "do-westernis" },
    container,
    // What the runtime fills from the main module (index.js re-exports ContainerProxy). The class needs it when a
    // Durable Object is constructed while its container already runs (applyOutboundInterception).
    exports: { ContainerProxy: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => void storage.set(k, v),
      delete: async (k) => storage.delete(k),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      sql: { exec: () => [] },
      kv: { get: (k) => storage.get(`kv:${k}`), put: (k, v) => void storage.set(`kv:${k}`, v) },
    },
    blockConcurrencyWhile: async (fn) => fn(),
    waitUntil: () => {},
  };
  return { ctx, container, log, storage };
}
