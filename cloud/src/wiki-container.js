// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// WikiContainer: the one Durable Object (name "westernis") that owns the one MediaWiki container
// (design 1.3, 1.4, 1.7, 2.3). Written against @cloudflare/containers 0.3.7 (dist/lib/container.js):
//   - startAndWaitForPorts({ ports, cancellationOptions: { instanceGetTimeoutMS, portReadyTimeoutMS,
//     waitInterval } }) starts with `this.envVars` and polls `http://${pingEndpoint}` on each port;
//     on success the persisted state becomes "healthy".
//   - containerFetch(request, port) restarts a stopped container with the class defaults (8 s / 20 s),
//     so fetch() below always gets the container healthy first with our own, longer timeouts.
//   - stop(signal) only sends the signal; the class itself never sends SIGKILL on `sleepAfter`.
//   - alarm() calls onActivityExpired() once `sleepAfter` passed with no request in flight, and only
//     again after another full `sleepAfter`. alarm() is the class's scheduler: never override it.
//   - The exit code arrives through the monitor promise ("stopped_with_code") and then onStop().
//
// One SIGTERM per container run, as a property of the run, not of one call: the drain record
// ("wst:drain" in DO storage) is written BEFORE the signal and survives a Durable Object restart
// (Worker deploy, eviction). While it exists and the container still runs, nothing signals again,
// ready() is false and no new container may start (single writer). A drain that outlives its deadline
// stays "stuck" until the process exits or an admin forces it (POST /__wst/restart?force=1 -> SIGKILL).
import { Container } from "@cloudflare/containers";
import { isNavigation, sleep } from "./http.js";
import { ssoUsers } from "./gate.js";
import { wakingPage, failedPage, stuckPage } from "./waking.js";

export { isNavigation };

export const PORT = 8080; // Apache as www-data (unprivileged port)
// Class defaults are 8 s to get an instance and 20 s until the port answers; a cold start restores the
// SQLite files from R2 (and on first boot imports the bundle); a new host first pulls the ~2 GB image, and
// when the instance wait runs out the class aborts the Durable Object (which stops the container), so allow
// 5 min for the instance and 15 min until /__ready answers.
export const START = { instanceGetTimeoutMS: 300_000, portReadyTimeoutMS: 900_000, waitInterval: 1000 };
export const NAV_WAIT_MS = 6_000; // a browser navigation waits this long before it gets the waking page
export const MAX_STOP_WAIT_MS = 12 * 60_000; // < 15 min alarm wall time and < the platform's SIGKILL
export const RESTART_WAIT_MS = 50_000; // /__wst/restart answers before typical edge timeouts; the drain goes on
export const FAIL_COOLDOWN_MS = 60_000; // after a failed start, answer "konnte nicht starten" instead of retrying
// The platform SIGKILLs 15 min after its own SIGTERM (rollout, host maintenance). A container that has
// stopped answering /__ready for less than this is assumed to be in such a drain and is not signalled.
export const EXTERNAL_DRAIN_MS = 16 * 60_000;
const DRAIN_KEY = "wst:drain"; // { at, reason } of the one SIGTERM sent to the current run
const UNRESPONSIVE_KEY = "wst:unresponsive"; // first time the idle check found /__ready not answering

const log = (o) => console.log(JSON.stringify(o));

// Runs as root before the image's normal entrypoint (see the constructor).
// Images whose LocalSettings.cloud.php predates multi-user single sign-on get this override as
// LocalSettings.local.php (loaded last): every name in WIKI_SSO_USERS may be signed in, and is created as a
// normal user on its first sign-in. Same rules as LocalSettings.cloud.php otherwise (one header, hyphenated).
export const SSO_USERS_PHP = `<?php
// Written at container start by the Westernis Worker (image without multi-user single sign-on).
$wstSsoUsers = [];
foreach ( explode( ',', (string)getenv( 'WIKI_SSO_USERS' ) ) as $wstName ) {
	$wstName = str_replace( '_', ' ', trim( $wstName ) );
	if ( $wstName !== '' ) {
		$wstSsoUsers[] = $wstName;
	}
}
$wgAuthRemoteuserUserName = static function () use ( $wstSsoUsers ): string {
	if ( PHP_SAPI === 'cli' || !$wstSsoUsers ) {
		return '';
	}
	$value = $_SERVER['HTTP_X_WESTERNIS_USER'] ?? null;
	if ( !is_string( $value ) || $value === '' ) {
		return '';
	}
	if ( function_exists( 'getallheaders' ) ) {
		$names = [];
		foreach ( array_keys( getallheaders() ?: [] ) as $name ) {
			if ( strtolower( strtr( (string)$name, '_', '-' ) ) === 'x-westernis-user' ) {
				$names[] = (string)$name;
			}
		}
		if ( count( $names ) !== 1 || str_contains( $names[0], '_' ) ) {
			return '';
		}
	}
	$given = str_replace( '_', ' ', trim( $value ) );
	foreach ( $wstSsoUsers as $wstName ) {
		if ( hash_equals( $wstName, $given ) ) {
			return $wstName;
		}
	}
	return '';
};
// Only the names above can reach account creation (the callback returns nothing else).
$wgGroupPermissions['*']['autocreateaccount'] = true;
`;

const RUNTIME_PREP = [
  "install -d -m 1777 /run/lock && install -d -o www-data -g www-data -m 1777 /run/apache2 /run/lock/apache2",
  "if ! grep -q WIKI_SSO_USERS /var/www/html/LocalSettings.cloud.php 2>/dev/null; then",
  "cat > /var/www/html/LocalSettings.local.php <<'WSTPHP'",
  SSO_USERS_PHP.trimEnd(),
  "WSTPHP",
  "chmod 0644 /var/www/html/LocalSettings.local.php",
  "fi",
].join("\n");

// Diagnostics wrapper (see the constructor). Never prints secrets: the boot scripts do not, and the upload
// helper only reports its own errors.
const BOOTLOG_WRAPPER = [
  'L=/tmp/boot.log; : > "$L"',
  'up() { php /usr/local/bin/wst-r2.php put debug/boot.log "$L" text/plain >/dev/null 2>&1 || true; }',
  'echo "[wrapper] start $(date -u +%FT%TZ)" >> "$L"',
  '/usr/bin/tini -s -- /usr/local/bin/wst-start.sh >> "$L" 2>&1 & P=$!',
  'trap \'echo "[wrapper] SIGTERM from outside at $(date -u +%FT%TZ)" >> "$L"; kill -TERM $P\' TERM',
  'trap \'echo "[wrapper] SIGINT from outside at $(date -u +%FT%TZ)" >> "$L"; kill -INT $P\' INT',
  '( while kill -0 $P 2>/dev/null; do up; sleep 5; done ) &',
  'while kill -0 $P 2>/dev/null; do wait $P; done; wait $P; rc=$?',
  'echo "[wrapper] wst-start exited rc=$rc at $(date -u +%FT%TZ)" >> "$L"; up; exit $rc',
].join("\n");

class StuckError extends Error {}

/**
 * Environment of the container, passed on every start (the class's `envVars`). A running container keeps
 * the values it was started with until its next start. Unset bindings are left out rather than sent as
 * "undefined": the boot scripts must see a missing secret as missing (`${VAR:?}`). The gate secrets
 * (GATE_PASSWORD_HASH, SESSION_SECRET, API_TOKEN) never reach the container.
 */
export function containerEnv(env) {
  const all = {
    WIKI_SERVER: env.WIKI_SERVER,
    WIKI_HOSTS: env.WIKI_HOSTS,
    WIKI_EDIT_HOST: env.WIKI_EDIT_HOST,
    WIKI_DEBUG: env.WIKI_DEBUG ?? "0",
    // MediaWiki trusts "X-Westernis-User: <this name>" (set only by the Worker, for gate sessions); "" = no SSO
    WIKI_SSO_USER: String(env.GATE_WIKI_USER ?? "").trim(),
    // every MediaWiki name the gate may sign in (owner + GATE_USERS guests); names only, never hashes
    WIKI_SSO_USERS: ssoUsers(env).join(","),
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_DB_BUCKET: env.R2_DB_BUCKET,
    R2_MEDIA_BUCKET: env.R2_MEDIA_BUCKET,
    // Litestream reads LITESTREAM_*; never AWS_* (they would take precedence) [design 2.7]
    LITESTREAM_ACCESS_KEY_ID: env.R2_DB_ACCESS_KEY_ID,
    LITESTREAM_SECRET_ACCESS_KEY: env.R2_DB_SECRET_ACCESS_KEY,
    R2_MEDIA_ACCESS_KEY_ID: env.R2_MEDIA_ACCESS_KEY_ID,
    R2_MEDIA_SECRET_ACCESS_KEY: env.R2_MEDIA_SECRET_ACCESS_KEY,
    WIKI_SECRET_KEY: env.WIKI_SECRET_KEY,
    WST_DB_GENERATION: env.WST_DB_GENERATION,
    WST_BOOTSTRAP: env.WST_BOOTSTRAP ?? "",
    WST_RESTORE_FROM: env.WST_RESTORE_FROM ?? "",
  };
  return Object.fromEntries(
    Object.entries(all)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
}

export class WikiContainer extends Container {
  defaultPort = PORT;
  requiredPorts = [PORT];
  sleepAfter = "20m"; // billed idle tail; on expiry the class calls onActivityExpired() (below)
  enableInternet = true; // R2 S3 endpoint for Litestream and Extension:AWS
  pingEndpoint = "localhost/__ready"; // static file; the default "ping" would render the Main Page

  // Timings as instance fields so tests can shorten them; production uses the constants above.
  timing = {
    start: START,
    navWaitMs: NAV_WAIT_MS,
    maxStopWaitMs: MAX_STOP_WAIT_MS,
    restartWaitMs: RESTART_WAIT_MS,
    failCooldownMs: FAIL_COOLDOWN_MS,
    externalDrainMs: EXTERNAL_DRAIN_MS,
    stopPollMs: 1000,
    exitCodeWaitMs: 3000,
    probeTimeoutMs: 5000,
  };
  starting; // promise of the start in progress (one at a time)
  stopping; // promise of the drain wait in progress (one at a time)
  drain; // cached DRAIN_KEY record (undefined = not loaded, null = none)
  lastExit; // { exitCode, at } from onStop()
  lastFailure = 0; // Date.now() of the last failed start
  lastStopAt = 0; // Date.now() of the last stop request (a start it cut short is not a failure)

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
    // Cloudflare Containers start with an empty /run, so the runtime directories Apache needs are created
    // first (images built before wst-start.sh did this themselves need it). Diagnostics (var
    // WST_DEBUG_BOOTLOG=1): run under a wrapper that copies the boot output to the DB bucket
    // (debug/boot.log) every 5 s and records signals arriving from outside.
    const debug = String(env.WST_DEBUG_BOOTLOG ?? "") === "1";
    this.entrypoint = ["/bin/bash", "-c", `${RUNTIME_PREP}\n${debug ? BOOTLOG_WRAPPER : "exec /usr/bin/tini -s -- /usr/local/bin/wst-start.sh"}`];
  }

  async fetch(request) {
    // A request counts as activity at once, not only when it reaches containerFetch(): the idle alarm
    // must not pick the moment between ready() and the proxy call to send SIGTERM.
    this.renewActivityTimeout();
    if (!(await this.ready())) {
      if (await this.drainStuck()) return stuckPage();
      if (!this.starting && Date.now() - this.lastFailure < this.timing.failCooldownMs) return failedPage();
      const wake = this.wake();
      const outcome = wake.then(
        () => "ok",
        (e) => (e instanceof StuckError ? "stuck" : "failed"),
      );
      let r;
      if (isNavigation(request)) {
        r = await Promise.race([outcome, sleep(this.timing.navWaitMs).then(() => "wait")]);
        if (r === "wait") return wakingPage(); // the start goes on in this object; the page reloads itself
      } else {
        r = await outcome; // API, POST, load.php, Forge MCP: held until ready (<= ~180 s), never the waking page
      }
      if (r === "stuck") return stuckPage();
      if (r === "failed") return failedPage();
    }
    return this.containerFetch(request, PORT); // renews the activity timer and counts the request in flight
  }

  async ready() {
    if (this.stopping || this.starting || !this.ctx.container.running) return false;
    if (await this.drainRecord()) return false; // signalled once already: Apache is closing or closed
    return (await this.getState()).status === "healthy";
  }

  /** Starts the container once; concurrent callers share the promise. Never while the old process drains. */
  wake() {
    if (this.starting) return this.starting;
    const startedAt = Date.now();
    this.starting = (async () => {
      for (;;) {
        if (this.stopping) {
          await this.stopping; // single writer: the old process must have exited
          continue;
        }
        if ((await this.drainRecord()) && this.ctx.container.running) {
          // Signalled by an earlier object (before a DO restart) or past the deadline: wait, never resignal.
          const r = await this.drainAndStop("wake");
          if (r.status === "timeout") throw new StuckError("the previous run is past its drain deadline");
          continue;
        }
        break;
      }
      if (await this.drainRecord()) await this.setDrain(null); // that run has exited
      await this.ctx.storage.delete(UNRESPONSIVE_KEY); // a new run starts with a clean slate
      log({ evt: "wiki-start" });
      await this.startAndWaitForPorts({ ports: [PORT], cancellationOptions: { ...this.timing.start } });
    })()
      .then(
        () => {
          this.lastFailure = 0;
          log({ evt: "wiki-ready", ms: Date.now() - startedAt });
        },
        (e) => {
          if (!(e instanceof StuckError) && this.lastStopAt < startedAt) this.lastFailure = Date.now();
          console.error(JSON.stringify({ evt: "wiki-start-failed", ms: Date.now() - startedAt, error: String(e?.message ?? e) }));
          throw e;
        },
      )
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /**
   * Called by the class's alarm loop when `sleepAfter` passed with no request in flight. Signals only a
   * container that still answers /__ready: one that does not is most likely draining after the
   * platform's own SIGTERM (rollout, host maintenance), and a second SIGTERM would cut Litestream's
   * final sync short. Such a container is signalled only once it has stayed silent past EXTERNAL_DRAIN_MS.
   */
  async onActivityExpired() {
    if (!this.ctx.container.running) return;
    if (this.stopping || (await this.drainRecord())) {
      await this.drainAndStop("idle"); // waits for the drain in progress; never a second signal
      return;
    }
    if (await this.probe()) {
      await this.ctx.storage.delete(UNRESPONSIVE_KEY);
    } else {
      let since = await this.ctx.storage.get(UNRESPONSIVE_KEY);
      if (!since) {
        since = Date.now();
        await this.ctx.storage.put(UNRESPONSIVE_KEY, since);
      }
      if (Date.now() - since < this.timing.externalDrainMs) {
        log({ evt: "wiki-stop-skipped", reason: "idle", why: "not answering /__ready (platform drain?)", since });
        return;
      }
    }
    await this.drainAndStop("idle");
  }

  /** true if Apache answers /__ready now (short timeout). */
  async probe() {
    try {
      const res = await this.ctx.container
        .getTcpPort(PORT)
        .fetch(`http://${this.pingEndpoint}`, { signal: AbortSignal.timeout(this.timing.probeTimeoutMs) });
      await res.body?.cancel?.();
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * RPC from the Worker (POST /__wst/restart with the API token): graceful stop; the next request starts
   * a fresh container. `force` only escalates a drain that is already past its deadline (SIGKILL).
   * @returns {Promise<{status: "stopped"|"failed"|"stopping"|"not-running"|"timeout"|"killed", exitCode?: number|null}>}
   */
  async restart({ force = false } = {}) {
    if (force === true && this.ctx.container.running && (await this.drainStuck())) {
      const d = await this.drainRecord();
      log({ evt: "wiki-kill", reason: "admin-force", drainingSince: d?.at });
      await this.destroy();
      const t0 = Date.now();
      while (this.ctx.container.running && Date.now() - t0 < 30_000) await sleep(this.timing.stopPollMs);
      if (this.ctx.container.running) return { status: "timeout" };
      await this.setDrain(null);
      await this.ctx.storage.delete(UNRESPONSIVE_KEY);
      return { status: "killed", exitCode: await this.exitCodeSince(t0) };
    }
    const drained = this.drainAndStop("admin");
    return Promise.race([drained, sleep(this.timing.restartWaitMs).then(() => ({ status: "stopping" }))]);
  }

  /**
   * SIGTERM at most once per container run (recorded before it is sent), then wait until the process has
   * exited: wst-run.sh drains Apache and the jobs, exits 0, Litestream does its final sync. A non-zero
   * exit code after the signal means that final sync most likely failed ("failed").
   * @returns {Promise<{status: "stopped"|"failed"|"not-running"|"timeout", exitCode?: number|null}>}
   */
  drainAndStop(reason) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.ctx.container.running) {
        if (await this.drainRecord()) await this.setDrain(null);
        return { status: "not-running" };
      }
      let d = await this.drainRecord();
      if (!d) {
        d = { at: Date.now(), reason };
        await this.setDrain(d); // persisted first: no later call or restarted object can signal this run again
        this.lastStopAt = d.at;
        log({ evt: "wiki-stop", reason });
        await this.stop("SIGTERM");
      } else {
        this.lastStopAt = Math.max(this.lastStopAt, d.at);
      }
      while (this.ctx.container.running && Date.now() - d.at < this.timing.maxStopWaitMs) await sleep(this.timing.stopPollMs);
      if (this.ctx.container.running) {
        console.error(JSON.stringify({ evt: "wiki-stop-timeout", reason, signalledBy: d.reason, ms: Date.now() - d.at }));
        return { status: "timeout" };
      }
      const exitCode = await this.exitCodeSince(d.at);
      await this.setDrain(null);
      await this.ctx.storage.delete(UNRESPONSIVE_KEY);
      const failed = typeof exitCode === "number" && exitCode !== 0;
      log({ evt: failed ? "wiki-stop-failed" : "wiki-stop-exited", reason, exitCode, ms: Date.now() - d.at });
      return { status: failed ? "failed" : "stopped", exitCode };
    })()
      .catch((e) => {
        console.error(JSON.stringify({ evt: "wiki-stop-error", reason, error: String(e?.message ?? e) }));
        return { status: this.ctx.container.running ? "timeout" : "stopped", exitCode: null };
      })
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }

  /** The drain record of the current run (cached), or null. */
  async drainRecord() {
    if (this.drain === undefined) this.drain = (await this.ctx.storage.get(DRAIN_KEY)) ?? null;
    return this.drain;
  }

  async setDrain(d) {
    this.drain = d;
    if (d) await this.ctx.storage.put(DRAIN_KEY, d);
    else await this.ctx.storage.delete(DRAIN_KEY);
  }

  /** A signalled run that is still alive past the deadline (and no wait for it is in progress). */
  async drainStuck() {
    if (this.stopping || !this.ctx.container.running) return false;
    const d = await this.drainRecord();
    return Boolean(d) && Date.now() - d.at >= this.timing.maxStopWaitMs;
  }

  /** Exit code of the run that ended after `t0`, from onStop() or the class state; null if unknown. */
  async exitCodeSince(t0) {
    const until = Date.now() + this.timing.exitCodeWaitMs;
    for (;;) {
      if (this.lastExit && this.lastExit.at >= t0) return this.lastExit.exitCode;
      const s = await this.getState();
      if (s.status === "stopped_with_code") return s.exitCode ?? 0;
      if (Date.now() >= until) return null;
      await sleep(Math.min(100, this.timing.stopPollMs));
    }
  }

  onStop({ exitCode, reason }) {
    this.lastExit = { exitCode, at: Date.now() };
    log({ evt: "wiki-exited", exitCode, reason });
  }
}
