# Westernis auf Cloudflare: Architektur und Umzugsplan

Status: **design only** (research phase, 2026-10-06). Nothing has been deployed, no Cloudflare
resource exists yet, no project file was changed. Every fact the design depends on cites a source
from section 9 as `[Sn]`. **UNVERIFIED** marks what could not be checked; section 9.2 collects them.
Personal values (account ID, e-mail, team name, keys) are placeholders: this file lives in the repo,
and the repo is being prepared for publication (AGPL headers were added while this was written).

Target: `https://wiki.example.org` (placeholder; the real hostnames live in the untracked `.env.cloud`), fully on Cloudflare. Nothing runs on the owner's PC
afterwards (no tunnel); the PC is only used once for the migration and, in v1, to run `wrangler deploy`.

**Owner decisions (2026-10-06), these override the proposals below where they differ:**

| Topic | Decision |
|---|---|
| Hostnames | Two hosts: a reading host and an always-private edit host (D10 as proposed). |
| Login | **No Cloudflare Access / Zero Trust** (2026-10-06, replaces the earlier one-time-PIN choice): a password gate in the Worker. One password, no user name, no 2FA; a signed session cookie for 30 days; single sign-on into MediaWiki as the owner's account; scripts use an API token header (section 1.6, D18). |
| Instance size | Custom **2 vCPU / 6144 MiB / 12000 MB** ("one step up"; budget about $10–15/month). |
| Data location | **EU jurisdiction** for both R2 buckets (`--jurisdiction eu`, S3 endpoint `https://<account>.eu.r2.cloudflarestorage.com`, Worker binding `"jurisdiction": "eu"`, bucket-scoped tokens for the EU buckets); container placement `WEUR`. |
| Everything else in section 8 | The proposed defaults (95 MB uploads, `sleepAfter` 20 min, 30 days point-in-time restore, weekly dumps for 180 days, SQLite trade-offs accepted, trial period 7–14 days). |

---

## 0. Kurzfassung und Entscheidungen

**Architecture in one paragraph.** One Worker owns both custom domains
(`wiki.example.org` for reading, `edit.wiki.example.org` for editing and the
Forge MCP). A password gate in the Worker protects all of it now: one password, a signed session
cookie, single sign-on into MediaWiki, an API token for scripts (section 1.6). The Worker serves
`/images/*` directly from an R2 bucket, so images never wake the wiki. Every other request goes to
**one** Durable Object (`WikiContainer`, fixed name `westernis`), which starts and proxies **one**
Cloudflare Container (`max_instances: 1`) running the existing MediaWiki 1.46 image plus Litestream,
memcached and an in-container job loop. The database is SQLite on the container's ephemeral disk:
restored from R2 at every start and streamed back to R2 by Litestream about every second. Uploads
live in R2 through Extension:AWS (S3 API). The container sleeps 20 minutes after the last request.

**Conflicts between the six research reports, and how they were resolved:**

| # | Question | Options in the reports | Decision | Why (source) |
|---|---|---|---|---|
| D1 | Where uploads live | Extension:AWS + Worker serves `/images` from R2 (r2-uploads) vs. tigrisfs FUSE mount (migration) | **Extension:AWS**, Worker serves `/images` | Cloudflare says FUSE "does not provide local-disk performance or full POSIX filesystem semantics" [S50]; images must not wake the container. |
| D2 | File URLs with Extension:AWS | `$wgAWSBucketDomain = https://host/images` (r2-uploads) | **Leave `$wgAWSBucketName` unset** and configure `$wgLocalFileRepo` ourselves | Verified in `AmazonS3Hooks.php` (master): with no bucket name the extension only registers its backend "to customize `$wgLocalFileRepo` in LocalSettings.php" [S35]. URLs stay root-relative `/images/...`, so they work on both hosts and do not depend on `*` read. The extension otherwise always prefixes `https://` and switches to `img_auth.php` on non-public wikis [S35]. |
| D3 | Migration method | XML import (extensions) vs. table copy (migration) | **Table copy through MediaWiki's DB layer**, XML dumps as a diff check and fallback | XML dumps lack "user accounts, images, edit logs" [S41]. Correction to the migration report: `text.old_text` must **not** be `encodeBlob()`ed. MediaWiki writes it as a plain string (`SqlBlobStore.php:196`), and only `img_metadata`, `oi_metadata`, `fa_metadata`, `us_props` (and caches) go through `encodeBlob` [S38]. A BLOB copy would break ReplaceText, because the image's SQLite is built with `LIKE_DOESNT_MATCH_BLOBS` (extensions report). |
| D4 | Cargo storage | Same file, fix only if needed (migration) vs. own file (sqlite, extensions) | **Own file from day one**: `$wgCargoDBfilePath` | Cargo opens a second connection to `$dbr->getDbFilePath()` unless the path is set (verified, `CargoUtils.php:23-90`) [S39]. The extensions report reproduced the resulting lock in a simulation. |
| D5 | Job queue | Own SQLite file (extensions) vs. main DB (sqlite, migration) | **Main DB** (MediaWiki default JobQueueDB) | Pending jobs then survive sleep through the same replica; there is one editor, so write contention is low. |
| D6 | Caches | Non-replicated `wikicache.sqlite` (sqlite) vs. memcached only (migration) | memcached on 127.0.0.1 for main, message and parser cache; **`CACHE_DB` = `wikicache.sqlite`, replicated** | `MainStash` defaults to `CACHE_DB` [S38]. It also holds VisualEditor's Parsoid stash, and sessions use `CACHE_DB`. Replicating it keeps logins and unsaved VE state across the 20-minute sleep. The parser cache stays out of it, so its write volume is small. |
| D7 | Apache user and port | Port 80 as root (containers) vs. 8080 as www-data (sqlite) | **Everything as www-data, Apache on 8080** | No root-owned `-wal`/`-shm` files can appear. The php image documents unprivileged ports for non-root Apache [S42]. Run, lock and log dirs are www-data 1777 in the image (checked). |
| D8 | Container API | Container class (containers) vs. `ctx.container`, which the docs recommend for new apps [S3] | **Container class 0.3.7** on the GA `default` policy | The class sends **SIGTERM only** on `sleepAfter` ("won't get a SIGKILL"), stops only with zero in-flight requests, and deduplicates starts (read in source) [S2]. The direct API stops "shortly after" SIGTERM, which is unsafe for Litestream's final sync (containers report). A migration guide to the direct API exists [S3]. |
| D9 | Flush before stop | `exec litestream sync` from the DO (containers) vs. signal chain (sqlite) | **Signal chain only**; the DO waits for the process to exit before it allows a restart | The signal path is verified in Litestream's source [S30]. `exec` on the default policy is UNVERIFIED. |
| D10 | Hostnames | One host (migration) vs. read host + edit host (access) | **Two hosts from day one** | D2 makes both hosts work. Going public later then exposes only anonymous GET on the read host, while logins, the API for writes and the MCP stay behind the gate on the edit host. |
| D11 | `*` read in MediaWiki | `WIKI_ANON_READ=0` (migration) vs. keep `true` (r2-uploads) | **Keep `true`** | The Worker's password gate is the gate (fail-closed). With D2 it no longer affects image URLs, and the public switch stays a Worker-only change. |
| D12 | Instance size | `basic` (migration, sqlite) vs. custom 1 vCPU / 3 GiB / 8 GB (containers) | **Custom 1 vCPU / 3072 MiB / 8000 MB** | 1/4 vCPU is slow for cold starts, Scribunto and Cargo pages. Custom needs at least 1 vCPU and 3 GiB per vCPU [S7]. Cost: section 7. |
| D13 | Seeding the replica | Litestream `-once` from the PC (migration) vs. bundle in R2 + first-boot import | **Bundle in R2, imported on first boot** | No S3 keys on the PC (upload with `wrangler r2 object put` over OAuth [S23]). The production code path is exercised on day one. |
| D14 | Buckets | 3 buckets (r2-uploads) vs. 2 (migration) | **2 buckets**: `westernis-db` (replica, state, import bundle, dumps) and `westernis-media` | R2 tokens scope per bucket, not per prefix [S25]. The import bundle is read with the DB token the container already has. |
| D15 | When `update.php` runs | Build ID (sqlite) vs. image version (migration) | **Content hash** of all `extension.json`/`skin.json`, `Defines.php` and the LocalSettings files, recorded in `updatelog` | Runs exactly when the schema-relevant code changed, with no manual bumping. |
| D16 | LocalSettings integration | Use `LocalSettings.local.php` (several reports) | **New `LocalSettings.cloud.php`**, plus a 3-line guarded include in `LocalSettings.php` before the `.local.php` include | During this research `LocalSettings.local.php` became the documented per-install override slot (untracked) [S45]; the cloud layer must not occupy it. |
| D17 | Deploy path | Workers Builds from Git (migration) vs. `wrangler deploy` with Docker Desktop (containers) | **v1: `wrangler deploy` from the PC**; Workers Builds later (open question Q5) | Docker is needed for the migration anyway. The per-install config is untracked (section 2.2), which a public Git build cannot see. |
| D18 | Login gate | Cloudflare Access (Worker-level app, one-time PIN, service token) vs. a password gate in the Worker | **Password gate in the Worker** (owner decision 2026-10-06) | No Zero Trust organisation, Access application or service token to set up and renew. The Worker is already the only path to the container [S11], so it can authenticate and pass the owner's identity on (SSO header). PBKDF2 hash and HMAC secret as Worker secrets, Workers Rate Limiting as the brute-force brake [S53][S54]. |

---

## 1. Architektur

### 1.1 Komponenten

```
Browser / Forge MCP (Node)
   │  https://wiki.example.org        (reading; public later)
   │  https://edit.wiki.example.org   (always behind the gate: editing, API, MCP)
   ▼
Cloudflare edge (custom domains, TLS; no Access / Zero Trust)
   ▼
Worker "westernis" (cloud/src/index.js)
   ├─ password gate (gate.js), fail-closed: cookie "__Secure-wst" or header X-Westernis-Token, else
   │    302 to /__wst/login (browser) or 401 (anything else); anonymous GET only on PUBLIC_READ_HOSTS
   ├─ /__wst/login, /__wst/logout   ──► gate pages (login.js); never reach the container
   ├─ GET/HEAD /images/*  ──► R2 binding MEDIA (bucket westernis-media); a missing thumb/* goes to the container
   └─ everything else     ──► Durable Object WikiContainer("westernis")    (Container class, default policy)
                                  └─ Container (2 vCPU / 6 GiB / 12 GB, max_instances 1, WEUR)
                                       tini (PID 1, www-data)
                                       └─ wst-start.sh: litestream restore ×3 → [first boot: import bundle]
                                          └─ exec litestream replicate  (exec: wst-run.sh)
                                               └─ wst-run.sh: memcached · update.php if schema changed ·
                                                  job loop · weekly XML dump · apache2 (:8080, PHP 8.3)
                                       SQLite on local disk /var/lib/westernis/db:
                                         westernis.sqlite · westernis_cargo.sqlite · wikicache.sqlite
                                       ──S3 API──► R2 westernis-db    (Litestream LTX + snapshots, state/, import/, dumps/)
                                       ──S3 API──► R2 westernis-media (Extension:AWS: originals, archive, thumbs, deleted, temp)
```

### 1.2 Request flow

| Request | Path |
|---|---|
| Page view, `load.php`, `api.php`, `/assets/*` | Edge → Worker gate (session cookie or API token) → DO `fetch` → container `:8080` Apache → MediaWiki. Worker sets `X-Forwarded-Proto` and `X-Forwarded-For` (= `CF-Connecting-IP`; client copies are stripped). For a gate session it also sets `X-Westernis-User: <GATE_WIKI_USER>` (single sign-on); every client-supplied `X-Westernis-*` header and the `__Secure-wst` cookie are removed first. MediaWiki detects https from `X-Forwarded-Proto` natively (`WebRequest::detectProtocol`) [S38]. |
| `GET`/`POST /__wst/login`, `GET`/`POST /__wst/logout` | Worker only (`gate.js`, `login.js`): German login page, password check against `GATE_PASSWORD_HASH`, rate limit `LOGIN_LIMIT`, cookie `__Secure-wst`, 303 to a validated relative `next`. Logout is a POST (the GET shows a button). Never reaches the container. |
| `/images/<a>/<ab>/File.png`, `/images/archive/...`, `/images/thumb/...` | Worker → `env.MEDIA.get(key, {onlyIf, range})` [S27]. ETag, Range, 304, MediaWiki's upload CSP and `nosniff` headers. Private prefixes `deleted/`, `temp/` → 404. **Does not wake the container.** |
| Missing thumbnail (new size, purged) | Worker finds no R2 object under `thumb/` → forwards to the container → Apache rewrites to `thumb_handler.php` → MediaWiki renders, stores in R2, streams the result (r2-uploads report; `Thumbnail404EntryPoint`). UNVERIFIED end to end. |
| Upload (form, VisualEditor, MsUpload, Forge `wiki_upload_file`) | → container → PHP → Extension:AWS `PutObject` to R2 (ACL `private`), synchronous. A sleeping container cannot lose an upload. Body cap 100 MB on Free/Pro zones [S21] → `$wgMaxUploadSize` 95 MB. |
| `POST /__wst/restart` (API token only; a browser session gets 403, so no cross-site form can trigger it) | Worker → DO RPC `restart()` → graceful stop, one SIGTERM per container run. `?force=1` additionally kills (SIGKILL) a run that is already past its 12-minute drain deadline. Used for the restart drill and after env changes. |
| Anything without a valid session or token | Browser navigation (`GET`, `Sec-Fetch-Mode: navigate`): 302 to `/__wst/login?next=…`. Everything else: 401. Neither reaches the container (cost, privacy). Exception: anonymous GET/HEAD on a host listed in `PUBLIC_READ_HOSTS` (empty until the public switch, section 5.2), with all cookies stripped; never on the edit host. |

`/assets/*` (fonts, theme JS) stays in the image for v1, as today. Serving it as Workers Static Assets
would cut a few container requests; it is a later, optional step and needs `run_worker_first`, so that
the gate still sees every request (UNVERIFIED in this setup).

### 1.3 Container lifecycle

**Start** (`wst-start.sh`, section 2.6):
1. `litestream restore -if-db-not-exists -if-replica-exists -integrity-check quick` for each of the
   3 files from `litestream/<generation>/…`. Any network or credential error is fatal (non-zero exit);
   only an empty replica returns 0 [S31]. A failed `wikicache` restore alone is tolerated (cache).
2. If no main DB exists afterwards, the script **never installs a wiki on its own**:
   - `state/<gen>.json` exists → **FATAL** (the replica of an initialised generation vanished).
   - `WST_RESTORE_FROM=<oldgen>[@<RFC3339>]` → point-in-time restore from an older generation, then write the marker.
   - `WST_BOOTSTRAP=import:<stamp>` and no `state/*` marker at all → import the migration bundle (section 4), then write the marker.
   - Otherwise **FATAL**.

   This closes Litestream's "fresh DB becomes the newest replica state" trap (sqlite report, `db.go` `checkDatabaseBehindReplica`).
3. `exec litestream replicate` (config has `exec: wst-run.sh`), which streams every commit (about 1 s sync interval).
4. `wst-run.sh` drops the DB-bucket keys from the environment before PHP starts. It starts memcached,
   runs `update.php` once per schema hash, starts the job loop, then `apache2-foreground`.
5. The DO's `startAndWaitForPorts` polls `http://localhost/__ready` (a static file) on port 8080 with
   **30 s / 180 s** timeouts instead of the class defaults of 8 s / 20 s [S1][S2].

**Stop** (sleep after 20 min, `/__wst/restart`, rollout, host maintenance):

| Step | Who | Bound |
|---|---|---|
| SIGTERM to PID 1 (tini) | Container class `stop()` [S2] or platform [S10][S11] | platform: SIGKILL after 15 min [S10] |
| tini → Litestream → `wst-run.sh` (Litestream forwards the same signal and waits for the child) | [S30] | |
| Apache graceful stop (`kill -WINCH`, `GracefulShutdownTimeout 30`); job loop finishes its batch; `runJobs` drain | `wst-run.sh` | ≤ 30 s + 50 s + 120 s |
| `exit 0` — **must** be 0: after a signal, Litestream returns *before* `Close()` (no final sync) if the child exits non-zero and not by a signal (`main.go` ~L182) | [S30] | |
| Litestream `Close()`: final sync with retries up to `shutdown-sync-timeout: 2m` | [S30][S32] | ≤ 2 min |
| DO polls `ctx.container.running` until false; only then may a new start happen | `drainAndStop()` | ≤ 12 min (alarm wall limit 15 min) |

The class re-fires `onActivityExpired` only after another full `sleepAfter` period [S2], and the DO
sends SIGTERM only once per stop. This matters because a **second** signal aborts Litestream's retry loop [S30].

### 1.4 Kaltstart: technisch und für Lesende

- **Platform:** "cold starts can often be in the 1-3 second range, but this is dependent on image size" [S12].
  The image is about 2 GB (1.84 GB measured today plus the AWS SDK). The first deploy can take "several minutes" to provision [S13].
- **Ours:** restore of about 20 MB from R2, memcached, the schema-hash check (one SQLite query), Apache.
  The l10n cache is prebuilt in the image: `rebuildLocalisationCache --no-database --lang=de,en` works offline (tested 2026-10-06 in a throwaway container with `--network none`) [S44].
  Expected total **≈ 5–20 s** (**UNVERIFIED**, to be measured in the restart drill). The first page after a cold start is reparsed (parser cache is in memcached) and takes about 1–3 s more.
- **What a reader sees:**
  1. If the gate session has expired (after `SESSION_DAYS`, default 30, or after a password change): the Westernis login page, then back to the requested page.
  2. Browser navigations (`GET`, `Sec-Fetch-Mode: navigate`) wait up to **6 s**. If the wiki is not ready by then, the Worker returns a small German page "Westernis erwacht …" (HTTP 503, `Retry-After: 5`, `<meta http-equiv="refresh" content="4">`, no external assets, brand colours). Start-up continues in the DO; the page reloads by itself until the wiki answers.
  3. Images already linked (bookmarks, other tabs) load immediately from R2.
  4. If start-up fails (for example a FATAL guard), a 503 page "Westernis konnte nicht starten" appears instead of an endless refresh. The cause is in the container logs.
- **API, POST, Forge MCP:** these requests are **held** until ready (≤ 180 s), never answered with the waking page. A POST therefore survives a cold start; sessions and edit tokens survive because `wikicache` is replicated (D6). Forge should allow at least 200 s per request.

### 1.5 Daten: Dateien, Buckets, Präfixe, Tokens

| SQLite file (`/var/lib/westernis/db`) | Contents | Replicated |
|---|---|---|
| `westernis.sqlite` | All wiki data incl. users, bot passwords, `job`, `cargo_tables`/`cargo_pages`, FTS3 `searchindex` | yes, `litestream/<gen>/westernis` |
| `westernis_cargo.sqlite` | `cargo__*` data tables (`$wgCargoDBfilePath`) | yes, `litestream/<gen>/westernis_cargo` (derived data, can be rebuilt with `cargoRecreateData`) |
| `wikicache.sqlite` | `CACHE_DB` = sessions, MainStash (VE stash, ResourceLoader deps) | yes, `litestream/<gen>/wikicache` (restore failure tolerated) |
| `locks/`, `-wal`, `-shm` | SQLite locks and WAL | no (local) |

| Bucket (EU jurisdiction) | Keys | Access | Lifecycle |
|---|---|---|---|
| `westernis-db` | `litestream/<gen>/<db>/…` (Litestream-managed), `state/<gen>.json` (init marker), `import/<stamp>/…` (migration bundle), `dumps/YYYY-MM-DD.xml.gz` (weekly XML) | token **westernis-db-rw** (Object Read & Write, this bucket only) → Litestream and boot scripts only; **no Worker binding** | `import/` 30 d, `dumps/` 180 d, abort multipart 1 d. **Never** a rule on `litestream/` |
| `westernis-media` | MediaWiki zones at the root: `a/ab/File`, `archive/…`, `thumb/…`, `deleted/…`, `temp/…` | token **westernis-media-rw** (Object R&W, this bucket only) → PHP; Worker binding `MEDIA` (read) | `temp/` 2 d, abort multipart 1 d |

Object-scoped R2 tokens work only through the S3 API [S25]; region `auto` [S24]. Litestream sets
`sign-payload` and `concurrency=2` for R2 on its own (v0.5.8+) [S33]. Leave r2.dev and bucket custom
domains **off**, otherwise files bypass the gate (r2-uploads report).

### 1.6 Schutzschichten

1. **Password gate in the Worker, fail-closed** (`cloud/src/gate.js`). Every request on both hosts needs the session cookie `__Secure-wst` or the header `X-Westernis-Token`. Without a well-formed `GATE_PASSWORD_HASH` and `SESSION_SECRET` the Worker answers 503 "Westernis ist noch nicht eingerichtet." to everything, public reads included: never open.
   - **Login** at `/__wst/login`, password only (no user name, no 2FA). `GATE_PASSWORD_HASH` = `pbkdf2-sha256$100000$<salt_b64>$<hash_b64>`: PBKDF2-HMAC-SHA256 through WebCrypto, exactly 100000 iterations (the Workers runtime refuses more [S54]), salt ≥ 16 bytes, 32-byte hash, compared in constant time.
   - **Brute-force brake:** Workers Rate Limiting binding `LOGIN_LIMIT`, 5 attempts per 60 s per `CF-Connecting-IP` (counted per Cloudflare location and eventually consistent [S53]), checked before any PBKDF2 work, plus a fixed 750 ms delay on every failure. Over the limit: 429 page. A failing limiter refuses; a missing binding disables the login form (503). Cross-site login and logout POSTs (`Sec-Fetch-Site: cross-site` or a foreign `Origin`) get 403.
   - **Session cookie** `__Secure-wst` = base64url(`{v:1, iat, exp, pv}`) `.` base64url(HMAC-SHA256 with `SESSION_SECRET`). `pv` is the first 12 hex characters of SHA-256(`GATE_PASSWORD_HASH`), so a new password ends every session. Attributes `Secure; HttpOnly; SameSite=Lax; Path=/; Domain=<reading host>` (the edit host is a subdomain of it, so one sign-in covers both; otherwise host-only), `Max-Age` = `SESSION_DAYS` days (default 30). After the login: 303 to a validated same-site relative `next` (no `//`, `/\`, control characters, absolute URLs or `/__wst/` paths). `POST /__wst/logout` clears it.
   - **Scripts** (Forge MCP, `wst.ps1 restart`) send `X-Westernis-Token`, compared in constant time with the secret `API_TOKEN` (≥ 32 characters; unset → 503 for token requests). Token requests never get the SSO header: Forge logs into MediaWiki with its bot password as before. `/__wst/restart` accepts only the token.
   - **Unauthenticated** requests: browser navigations get a 302 to `/__wst/login?next=…`, everything else 401. They never reach the container.
2. **Single sign-on:** for a gate session the Worker sets `X-Westernis-User: <GATE_WIKI_USER>` (a Worker var: the owner's MediaWiki user name, rendered from `.env` `WIKI_ADMIN_USER`; only printable ASCII is sent). The container gets the same name as `WIKI_SSO_USER` and treats a request whose header equals it as that user. The Worker removes every client-supplied `X-Westernis-*` header and the `__Secure-wst` cookie before forwarding, and the container is reachable only through the Worker [S11], so the header cannot be forged from outside.
3. `workers_dev: false`, `preview_urls: false`, and an exact host allowlist in the Worker.
4. The container is reachable only through the Worker [S11]. SSH works only through `wrangler containers ssh` with an ed25519 key from `authorized_keys` [S14].
5. Least privilege: two bucket-scoped tokens. The DB token is removed from the environment before PHP and Apache start; the media token is limited to `westernis-media`.

### 1.7 Ein einziger Schreiber (split-brain)

- One DO name (`westernis`) means one DO instance. The class's `start()` refuses while a container runs (containers report).
- `max_instances: 1`: "If a request to start a container will exceed this limit, that request will error" [S5].
- The DO waits for the old process to exit (`drainAndStop`) before `wake()` may start again. Rollouts stop the old instance before starting the new one [S10].
- **Residual risk (UNVERIFIED):** whether a container that is still draining after a host-maintenance SIGTERM counts toward `max_instances`. A v1.1 hardening is a lease object `state/lease.json`, refreshed with conditional PUT every 30 s and released after the final sync. R2 supports conditional writes (containers report). It is not in v1.

---

## 2. Dateiplan `cloud/`

### 2.1 Baum

```
cloud/
  wrangler.example.jsonc        tracked template (placeholders)
  wrangler.jsonc                UNTRACKED, rendered from the template + .env.cloud (account ID, hosts, buckets) + .env (wiki user)
  package.json                  "@cloudflare/containers": "0.3.7", devDep "wrangler": "^4.147.0"; `npm test`, `npm run dev`
  .dev.vars.example             local `wrangler dev` values (dev-only gate password and secrets, WIKI_HOSTS=localhost …)
  src/
    index.js                    Worker: host allowlist, password gate, SSO header, routing, /__wst/restart
    gate.js                     gate: PBKDF2 check, session cookie, API token, rate limit, next validation
    login.js                    the gate's German pages (login, logout, 429 / 503 / 401)
    http.js                     small shared helpers
    media.js                    /images/* from the R2 binding (+ missing thumbnails → container)
    wiki-container.js           WikiContainer extends Container (readiness, waking page, one-SIGTERM drain)
    waking.js                   German 503 pages ("erwacht", "konnte nicht starten", "lässt sich nicht beenden")
  test/                         node --test: gate, Worker, media, WikiContainer against the real Container class
  image/
    Dockerfile                  the cloud image (build context = repo root)
    LocalSettings.cloud.php     cloud overrides (SQLite, Cargo file, caches, R2 media, hosts)
    litestream.yml              R2 replica config (3 DBs, generation in the path)
    litestream.file.yml         same, `type: file` replicas, for local staging only
    apache-cloud.conf           Listen 8080 vhost, prefork caps, graceful stop, thumb rewrite
    php-cloud.ini               upload 95M, opcache.validate_timestamps=0
    bin/wst-start.sh            restore / guard / import, then exec litestream
    bin/wst-run.sh              child of litestream: memcached, update.php, jobs, dumps, apache, SIGTERM handling
    bin/wst-import.sh           first boot: fetch + verify + place the bundle
    bin/wst-dump.sh             weekly dumpBackup → R2 dumps/
    bin/wst-r2.php              tiny S3 helper (exists / get / put / list / age / verify-manifest), AWS SDK
  migrate/
    Export-Bundle.ps1           PC: build image, freeze (optional), run the migration container, copy the bundle out
    Upload-Bundle.ps1           PC: wrangler r2 object put … --remote (OAuth, no S3 keys on the PC)
    verify-cloud.mjs            PC: API checks against manifest.json through the Forge WikiClient (+ Access headers)
    container/migrate.sh        inside the migration container: schema, copy, rebuild, checks, bundle
    container/CopyMysqlToSqlite.php
    container/counts.php        JSON counts (tables, namespaces, max IDs, Cargo rows, image SHA-1)
    container/manifest.php      sha256 + counts + diff results → manifest.json
    out/                        UNTRACKED (gitignore + dockerignore): bundles contain password hashes
  scripts/
    Init-Cloud.ps1              renders wrangler.jsonc from the template + .env.cloud (non-secret keys)
    Push-Secrets.ps1            .env + .env.cloud → `wrangler secret bulk` over stdin, prints key names only
    wst.ps1                     control: deploy | deploy-worker | logs | status | ssh | restart | backup | seed
```

**Changes outside `cloud/`** (implementation phase):
- `wiki/LocalSettings.php`: add a guarded `require_once "$IP/LocalSettings.cloud.php"` **before** the `LocalSettings.local.php` include (D16).
- `.gitignore`: `cloud/wrangler.jsonc`, `cloud/migrate/out/`, `cloud/.dev.vars`. `.env.cloud` is already covered by `.env.*` [S45].
- `.dockerignore`: `cloud/migrate/out/`, `cloud/node_modules/`. Do **not** exclude `cloud/` as a whole: the image needs `cloud/image/` and `cloud/migrate/container/`.
- `content/pages/Main/Third_Age.wiki:25`: `where=type="Realm"` → `where=type='Realm'`. On SQLite, `"Realm"` resolves to the `realm` column of `Locations` (entities.js:76) and silently returns wrong rows (extensions report; collision confirmed in the files).
- `tools/forge-mcp/src/wiki.js`: Access service-token headers in `_request()` (the one place every GET, POST and upload passes, currently around line 68), `redirect: 'manual'`, a clear Access error, and a 200 s request timeout. `index.js`/`smoke.js`: pass `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`. The `wiki_cargo_query` description gets the SQLite dialect (case- and accent-sensitive `=`, no `YEAR/MONTH/DATE_FORMAT/IF/NOW/REGEXP`, `LOG` is base 10). `wiki_lore_context` skips Cargo lookups whose value equals a field name.
- `tools/forge-mcp/src/seed.js` (new, before the first `generate.js` run after cut-over): the API version of `wiki-seed.sh`. It uses the same title mapping, edits only changed pages (bot), uploads files whose SHA-1 differs, and calls the `cargorecreatetables`/`cargorecreatedata` API modules (they exist in Cargo 3.9.4, checked) and `purge`.
- `.env` (owner): `WIKI_API=https://edit.wiki.example.org/api.php`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. `.mcp.json` no longer sets `WIKI_API` [S45], so `.env` wins.
- After cut-over: README/CLAUDE.md (deploy, `seed.js`, `wrangler containers ssh`, no 8088/LAN); `docker-compose.yml` and `docker/` stay as the legacy stack until the volumes are deleted. `cloud/image/Dockerfile` reuses `docker/mediawiki/wiki.conf` and `zz-wiki.ini`; move them before deleting `docker/`.

### 2.2 `cloud/wrangler.example.jsonc` (rendered to the untracked `wrangler.jsonc`)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "westernis",
  "account_id": "${CF_ACCOUNT_ID}",
  "main": "src/index.js",
  "compatibility_date": "2026-10-06",
  "workers_dev": false,                       // never a *.workers.dev bypass (redeploys keep it off)
  "preview_urls": false,
  "routes": [
    { "pattern": "${WIKI_PUBLIC_HOST}", "custom_domain": true },   // wiki.example.org
    { "pattern": "${WIKI_EDIT_HOST}",   "custom_domain": true }    // edit.wiki.example.org (own cert covers 2nd level) [S20]
  ],
  "observability": { "enabled": true },
  "containers": [{
    "class_name": "WikiContainer",
    "scheduling_policy": "default",           // GA; immutable once created [S4]
    "image": "./image/Dockerfile",            // a Dockerfile path: wrangler builds with local Docker and pushes [S13]
    "image_build_context": "..",              // repo root, as in docker-compose [S5]
    "instance_type": { "vcpu": 2, "memory_mib": 6144, "disk_mb": 12000 },  // custom type, owner decision [S7][S8]
    "max_instances": 1,                       // single SQLite writer [S5]
    "constraints": { "regions": ["WEUR"] },   // near the owner and the EU buckets [S15]
    "authorized_keys": [{ "name": "owner", "public_key": "${SSH_PUBLIC_KEY}" }]   // dropped while empty [S14]
  }],
  "durable_objects": { "bindings": [{ "name": "WIKI", "class_name": "WikiContainer" }] },
  "exports": { "WikiContainer": { "type": "durable-object", "storage": "sqlite" } },   // not `migrations` [S6][S28]
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "${R2_MEDIA_BUCKET}", "jurisdiction": "eu" }],
  "ratelimits": [                             // brute-force brake for POST /__wst/login [S53]
    { "name": "LOGIN_LIMIT", "namespace_id": "73519", "simple": { "limit": 5, "period": 60 } }
  ],
  "vars": {
    "WIKI_SERVER": "https://${WIKI_PUBLIC_HOST}",
    "WIKI_HOSTS": "${WIKI_PUBLIC_HOST},${WIKI_EDIT_HOST}",
    "WIKI_EDIT_HOST": "${WIKI_EDIT_HOST}",
    "PUBLIC_READ_HOSTS": "",                  // section 5.2
    "GATE_WIKI_USER": "${WIKI_ADMIN_USER}",   // MediaWiki user of a gate session (SSO); "" = no SSO
    "SESSION_DAYS": "30",                     // gate cookie lifetime (1..365)
    "R2_ACCOUNT_ID": "${CF_ACCOUNT_ID}",
    "R2_DB_BUCKET": "${R2_DB_BUCKET}",
    "R2_MEDIA_BUCKET": "${R2_MEDIA_BUCKET}",
    "WST_DB_GENERATION": "g1",
    "WST_BOOTSTRAP": "",                      // "import:<stamp>" for the first boot only
    "WST_RESTORE_FROM": "",                   // "<gen>[@<RFC3339>]" for point-in-time restores
    "WIKI_DEBUG": "1",                        // honoured only on the edit host (LocalSettings.cloud.php)
    "MEDIA_CACHE_CONTROL": "private, max-age=3600"
  }
}
```

Placeholders: `CF_ACCOUNT_ID`, `WIKI_PUBLIC_HOST`, `WIKI_EDIT_HOST`, `R2_DB_BUCKET`, `R2_MEDIA_BUCKET`, `SSH_PUBLIC_KEY`
from `.env.cloud`, and `WIKI_ADMIN_USER` from `.env`. `namespace_id` only has to be a positive integer that no
other rate limiter of the account uses [S53].

Worker secrets (never in the file; set with `wrangler secret bulk`, section 2.10):

| Secret | Used by | Content |
|---|---|---|
| `GATE_PASSWORD_HASH` | Worker (gate) | `pbkdf2-sha256$100000$<salt_b64>$<hash_b64>` of the gate password (1.6, 5.1) |
| `SESSION_SECRET` | Worker (gate) | ≥ 32 random characters; HMAC key of the cookie `__Secure-wst` |
| `API_TOKEN` | Worker (gate) | ≥ 32 random characters; scripts send it as `X-Westernis-Token` (also in the untracked `.env`) |
| `WIKI_SECRET_KEY` | container | MediaWiki `$wgSecretKey` (from `.env`) |
| `R2_DB_ACCESS_KEY_ID`, `R2_DB_SECRET_ACCESS_KEY` | container (Litestream, boot scripts) | bucket-scoped token for `westernis-db` |
| `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY` | container (Extension:AWS) | bucket-scoped token for `westernis-media` |

The three gate secrets never reach the container. Without a well-formed `GATE_PASSWORD_HASH` and
`SESSION_SECRET` the Worker answers 503 to everything, which is what a "dark" first deploy relies on.
A Worker deploy that changes only vars starts **no** container rollout [S10]. A running container
keeps its old environment until its next start (sleep or `/__wst/restart`).

### 2.3 `cloud/src/` (Worker)

The code in `cloud/src/` is the reference, with unit tests in `cloud/test/` (`npm test`; the
WikiContainer tests run the real `@cloudflare/containers` 0.3.7 class against a fake container).
This section summarises it.

| File | Role |
|---|---|
| `index.js` | The fetch handler (order below). Exports only `default`, `WikiContainer` and `ContainerProxy`: the class needs `ctx.exports.ContainerProxy` when a Durable Object is constructed while its container runs (after a Worker deploy), although no outbound interception is configured. |
| `gate.js` | Configuration check (fail-closed), PBKDF2 verification, constant-time compare (`crypto.subtle.timingSafeEqual` in Workers, an XOR loop elsewhere), session cookie, API token, rate limit, `next` validation, `/__wst/login` and `/__wst/logout`. Runs unchanged in Node ≥ 22; `hashPassword(password)` produces the `GATE_PASSWORD_HASH` value. |
| `login.js` | The gate's pages: login form (password only), logout button, 429 / 503 / 401 messages. German, inline CSS in the theme colours `#0b0a12` / `#e3c16f`, serif font names only, no external assets, `noindex`, `X-Frame-Options: DENY`, CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`. |
| `http.js` | Small shared helpers (`isNavigation`, plain-text responses, HTML escaping). |
| `media.js` | `/images/*` straight from the R2 binding: ETag, conditional requests (304/412), single byte ranges (206), MediaWiki's upload CSP and `nosniff`; private zones (`deleted/`, `temp/`, `transcoded/`, `lockdir/`), dot files and traversal → 404; a missing `thumb/…` goes to the container. |
| `wiki-container.js` | `WikiContainer extends Container`: readiness via `/__ready` on 8080 (30 s / 180 s), the waking page for navigations after 6 s, held API requests, failure cooldown, the graceful stop (below), and the container environment (`containerEnv()`, including `WIKI_SSO_USER`). |
| `waking.js` | The 503 pages "Westernis erwacht …" (refresh 4 s), "Westernis konnte nicht starten" and "Westernis lässt sich nicht beenden" (no refresh), plus the shared page layout. |

**Request order in `index.js`:**

1. Host not in `WIKI_HOSTS` → 404.
2. Gate not configured (`GATE_PASSWORD_HASH` or `SESSION_SECRET` missing or malformed) → 503 for everything.
3. `/__wst/login`, `/__wst/logout` → the gate's pages (never the container).
4. Authenticate: a `X-Westernis-Token` header decides alone (valid → token; wrong → 401 after 750 ms; `API_TOKEN` unset or shorter than 32 characters → 503). Otherwise a valid `__Secure-wst` cookie → session. Otherwise anonymous.
5. Anonymous: GET/HEAD on a `PUBLIC_READ_HOSTS` host that is not the edit host passes (login and edit URLs → 302 to the edit host); otherwise a browser navigation → 302 to `/__wst/login?next=…`, anything else → 401.
6. `/__wst/restart`: API token and POST only (a session → 403, other methods → 405). `?force=1` passes `{ force: true }`.
7. Any other `/__wst/*` and `/__ready` → 404.
8. Forward: remove client `X-Forwarded-*`, `X-Real-IP` and every `X-Westernis-*` header; remove the `__Secure-wst` cookie (all cookies for anonymous readers); set `X-Forwarded-Proto`, `X-Forwarded-For` (= `CF-Connecting-IP`) and, for a session only, `X-Westernis-User: <GATE_WIKI_USER>`.
9. `/images/*` → `media.js`; everything else → the DO `westernis`.

**Graceful stop (`wiki-container.js`, review fixes of 2026-10-06):**

- One SIGTERM per container **run**, not per call: the drain record `wst:drain` (`{at, reason}`) is written to DO storage *before* the signal and survives a Durable Object restart. While it exists and the container runs, nothing signals again, `ready()` is false and no new container may start (single writer); requests wait for the exit.
- After `MAX_STOP_WAIT_MS` (12 min) the run counts as stuck: requests get the 503 page "Westernis lässt sich nicht beenden", idle expiry and further restarts send nothing. Only `POST /__wst/restart?force=1` (an explicit admin action) escalates, and only for a run past that deadline: `destroy()` (SIGKILL), then the next request starts fresh. On a healthy container `force` is an ordinary graceful restart.
- A non-zero exit code after the SIGTERM means Litestream's final sync most likely failed: `restart()` reports `failed` and the Worker answers 500 with the code.
- Idle expiry signals only a container that still answers `/__ready`. One that does not is most likely already draining after the platform's own SIGTERM (rollout, host maintenance), and a second signal would cut the final sync short; it is signalled only after staying silent for 16 minutes (longer than the platform's 15-minute SIGKILL window [S10]).
- The container side of the same review finding (signal handling in `wst-start.sh` and `wst-run.sh`) belongs to the image, section 2.6.

`/__wst/restart` answers:

| DO result | HTTP | Meaning |
|---|---|---|
| `stopped` | 200 | exited with code 0; the next request starts Westernis |
| `not-running` | 200 | nothing was running |
| `stopping` | 202 | still draining after 50 s; the next request waits for the exit |
| `failed` | 500 | exited with a non-zero code: check the container log before working on |
| `timeout` | 500 | past the 12-minute deadline; `?force=1` kills the run |
| `killed` | 200 | SIGKILL after `?force=1`; the last seconds before the hang may be missing |

Do not override the class's `alarm()`: the class uses it for `sleepAfter` [S2].

### 2.4 `cloud/image/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
# Westernis cloud image for Cloudflare Containers (linux/amd64). Build context = repo root.
FROM mediawiki:1.46.0
WORKDIR /var/www/html

# ---- 1. Skin + extensions: copied VERBATIM from docker/mediawiki/Dockerfile (same pins!) -------------
#      Identical extension versions are required so the table copy (section 4) maps 1:1.
ARG PORTABLEINFOBOX_SHA=60c09a75d023eac1da3a63945d0a4a9678fc86db
ARG SHORTDESCRIPTION_SHA=8d348a84a2e337b777525daeea2ff01707785171
ARG DATAMAPS_SHA=e95f4251d5e3074d9ba42e03bc6b37e712296dcc
# … the Citizen / Cargo / PageForms / … RUN blocks and the extension.json check, unchanged …

# ---- 2. Cloud runtime packages (Debian 13: tini 0.19.0, memcached 1.6.38, sqlite3 3.46.1 — checked) [S44]
RUN set -eux; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      poppler-utils ghostscript python3 diffutils tini memcached sqlite3 unzip; rm -rf /var/lib/apt/lists/*

# ---- 3. Litestream v0.5.17 (2026-08-31), checksum from the release's checksums.txt [S29]
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
RUN set -eux; cd /tmp; f="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; \
    curl -fsSLO "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$f"; \
    echo "${LITESTREAM_SHA256}  $f" | sha256sum -c -; tar -xzf "$f" -C /usr/local/bin litestream; rm -f "$f"; litestream version

# ---- 4. Extension:AWS, pinned master ("Added support for MediaWiki 1.46", 2026-09-17) [S35]
#      Own vendor/ inside the extension (its loader falls back to it), so core's vendor/ stays untouched.
ARG AWS_EXT_SHA=b79432133e076b3c1771834576b8d574f2432b0b
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
RUN set -eux; git init -q extensions/AWS; \
    git -C extensions/AWS fetch -q --depth 1 https://github.com/edwardspec/mediawiki-aws-s3 "$AWS_EXT_SHA"; \
    git -C extensions/AWS checkout -q FETCH_HEAD; rm -rf extensions/AWS/.git; \
    COMPOSER_ALLOW_SUPERUSER=1 composer install -d extensions/AWS --no-dev --no-interaction --no-progress --optimize-autoloader; \
    rm /usr/local/bin/composer; \
    php -r 'require "extensions/AWS/vendor/autoload.php"; exit(class_exists("Aws\\S3\\S3Client") ? 0 : 1);'

# ---- 5. Guard: Cargo where= clauses rely on SQLite accepting double-quoted string literals (DQS)
RUN php -r '$d=new PDO("sqlite::memory:"); $d->exec("CREATE TABLE t(a)"); exit($d->query("SELECT 1 FROM t WHERE a=\"x\"")===false?1:0);'

# ---- 6. Apache :8080 as www-data, PHP limits
COPY docker/mediawiki/wiki.conf /etc/apache2/conf-available/wiki.conf
COPY docker/mediawiki/zz-wiki.ini /usr/local/etc/php/conf.d/zz-wiki.ini
COPY cloud/image/apache-cloud.conf /etc/apache2/conf-available/westernis-cloud.conf
COPY cloud/image/php-cloud.ini /usr/local/etc/php/conf.d/zzz-cloud.ini
RUN set -eux; a2enmod rewrite headers expires; a2enconf wiki westernis-cloud; \
    echo 'Listen 8080' > /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    mkdir -p /var/lib/westernis/db /var/www/html/cache; echo ok > /var/www/html/__ready; \
    chown -R www-data:www-data /var/lib/westernis /var/www/html/cache /var/www/html/images

# ---- 7. Cloud scripts + project files (thin layers last)
COPY cloud/image/litestream.yml cloud/image/litestream.file.yml /etc/
COPY cloud/image/bin/ /usr/local/bin/
COPY cloud/migrate/container/ /opt/westernis/migrate/
COPY scripts/ /scripts/
COPY content/ /content/
COPY wiki/assets/ /var/www/html/assets/
COPY wiki/LocalSettings*.php /var/www/html/
COPY cloud/image/LocalSettings.cloud.php /var/www/html/LocalSettings.cloud.php
RUN set -eux; \
    sed -i 's/\r$//' /scripts/*.sh /usr/local/bin/wst-* /opt/westernis/migrate/* /var/www/html/LocalSettings*.php /etc/litestream*.yml; \
    chmod +x /scripts/*.sh /usr/local/bin/wst-* /opt/westernis/migrate/*.sh; chown -R www-data:www-data /var/www/html/assets; \
    for f in /var/www/html/LocalSettings*.php; do php -l "$f"; done; \
    su -s /bin/sh www-data -c 'WIKI_SECRET_KEY=build php maintenance/run.php rebuildLocalisationCache --no-database --force --lang=de,en'; \
    { find extensions skins -maxdepth 2 \( -name extension.json -o -name skin.json \) | sort | xargs sha1sum; \
      sha1sum includes/Defines.php LocalSettings*.php; } | sha1sum | cut -c1-12 > /etc/wst-schema-id
#      (WIKI_SECRET_KEY is required by LocalSettings.php since it throws when unset; the dummy value never leaves the build)

ENV WIKI_CACHE_HOST=127.0.0.1 WST_MEDIA=r2 WST_DB=sqlite WST_SQLITE_DIR=/var/lib/westernis/db
EXPOSE 8080
STOPSIGNAL SIGTERM
USER www-data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wst-start.sh"]
```

Notes:
- **Image size:** 1.84 GB today [S44]; the image size limit equals the instance disk (8 GB) [S8].
  Optional slimming such as `rm -rf tests/ extensions/*/tests` cuts cold-start pull time; measure first.
- The image ships **no** MediaWiki memcached PHP extension. `CACHE_MEMCACHED` uses MediaWiki's
  pure-PHP client, exactly as today (checked: `php -m` shows apcu, mysqli, pdo_sqlite, sqlite3) [S44].
- `wrangler dev` builds this Dockerfile locally and runs Worker + container together [S13].
  `max_instances` is not enforced locally (containers report).

### 2.5 `cloud/image/LocalSettings.cloud.php`

Loaded by `LocalSettings.php` right before the optional `LocalSettings.local.php`, so per-install
overrides still win (D16).

```php
<?php
// Westernis — Cloudflare overrides. Copied to /var/www/html/LocalSettings.cloud.php by cloud/image/Dockerfile only.
/** @var callable $wstEnv defined in LocalSettings.php */

// ---- Hosts: reading host + always-private edit host; TLS ends at Cloudflare, the Worker sets X-Forwarded-Proto
$wgCanonicalServer = $wstEnv( 'WIKI_SERVER', 'https://wiki.example.org' );
$wstHosts = array_values( array_filter( array_map( 'trim', explode( ',', strtolower( (string)$wstEnv( 'WIKI_HOSTS', '' ) ) ) ) ) );
$wstHost = strtolower( $_SERVER['HTTP_HOST'] ?? '' );
$wstProto = ( $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? 'https' ) === 'http' ? 'http' : 'https';
$wgServer = ( PHP_SAPI !== 'cli' && in_array( $wstHost, $wstHosts, true ) ) ? "$wstProto://$wstHost" : $wgCanonicalServer;
$wstOnEditHost = PHP_SAPI === 'cli' || $wstHost === $wstEnv( 'WIKI_EDIT_HOST', '' );
$wgShowExceptionDetails = $wgShowExceptionDetails && $wstOnEditHost;   // WIKI_DEBUG never applies on the reading host
if ( !$wstOnEditHost ) {
	$wgRateLimits = \MediaWiki\MainConfigSchema::RateLimits['default'];   // anon throttles back on the reading host
}
// The container is reachable only via the Worker, which overwrites X-Forwarded-For with CF-Connecting-IP.
$wgUsePrivateIPs = true;
$wgCdnServersNoPurge = [ '0.0.0.0/0', '::/0' ];   // UNVERIFIED which source IP the container sees; narrow later
$wgEmergencyContact = $wgPasswordSender = 'wiki@wiki.example.org';   // cosmetic: e-mail stays off

// ---- Database: SQLite on local disk, streamed to R2 by Litestream (WST_DB=mysql only inside the migration container)
if ( $wstEnv( 'WST_DB', 'sqlite' ) === 'sqlite' ) {
	$wgDBtype = 'sqlite';
	$wgDBname = 'westernis';                                          // -> westernis.sqlite
	$wgSQLiteDataDir = $wstEnv( 'WST_SQLITE_DIR', '/var/lib/westernis/db' );   // outside the docroot [S40]
	$wgDBserver = $wgDBuser = $wgDBpassword = '';
	// Installer layout for hot cache tables: own file, BEGIN IMMEDIATE (SqliteInstaller::getLocalSettings) [S38]
	$wgObjectCaches[CACHE_DB] = [
		'class' => \MediaWiki\ObjectCache\SqlBagOStuff::class, 'loggroup' => 'SQLBagOStuff',
		'server' => [ 'type' => 'sqlite', 'dbname' => 'wikicache', 'tablePrefix' => '',
			'variables' => [ 'synchronous' => 'NORMAL' ], 'dbDirectory' => $wgSQLiteDataDir,
			'trxMode' => 'IMMEDIATE', 'flags' => 0 ],
	];
	// Cargo MUST have its own file, otherwise its second connection locks the main file on every infobox save [S39]
	$wgCargoDBtype = 'sqlite';
	$wgCargoDBfilePath = "$wgSQLiteDataDir/westernis_cargo.sqlite";
	// $wgJobTypeConf untouched: JobQueueDB in the main (replicated) DB. Main/message/parser cache: memcached 127.0.0.1.
} else {
	$wgMainCacheType = $wgMessageCacheType = $wgParserCacheType = CACHE_NONE;   // migration container, MariaDB side
}

// ---- Uploads: R2 via Extension:AWS; browsers read /images/* from the Worker's R2 binding
$wgMaxUploadSize = 95 * 1024 * 1024;                 // Cloudflare body cap: 100 MB on Free/Pro [S21]
$wgMSU_uploadsize = '95mb';
if ( $wstEnv( 'WST_MEDIA', 'r2' ) === 'r2' ) {
	wfLoadExtension( 'AWS' );
	putenv( 'AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED' );       // extension README advice for S3-compatible stores [S36]
	putenv( 'AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED' );
	$wgAWSCredentials = [ 'key' => $wstEnv( 'R2_MEDIA_ACCESS_KEY_ID' ), 'secret' => $wstEnv( 'R2_MEDIA_SECRET_ACCESS_KEY' ), 'token' => false ];
	$wgAWSRegion = 'auto';                                            // [S24]
	// $wgAWSBucketName stays UNSET on purpose: the extension then only registers its backend and leaves
	// $wgLocalFileRepo to us (AmazonS3Hooks::installBackend) [S35] -> root-relative /images URLs on every host.
	$wstBucket = $wstEnv( 'R2_MEDIA_BUCKET', 'westernis-media' );
	$wgFileBackends['s3'] = [
		'endpoint' => 'https://' . $wstEnv( 'R2_ACCOUNT_ID', '' ) . '.eu.r2.cloudflarestorage.com',   // EU jurisdiction buckets
		'use_path_style_endpoint' => true,
		'privateWiki' => true,                                        // ACL=private on every write; R2 rejects public-read [S35][S37]
		'containerPaths' => [                                         // same key layout as images/ today (hash levels 2/3)
			"$wgDBname-local-public" => $wstBucket,
			"$wgDBname-local-thumb" => "$wstBucket/thumb",
			"$wgDBname-local-deleted" => "$wstBucket/deleted",
			"$wgDBname-local-temp" => "$wstBucket/temp",
		],
	];
	$wgLocalFileRepo['backend'] = 'AmazonS3';      // url stays $wgUploadPath (/images); other keys filled by SetupDynamicConfig [S38]
	$wgLocalFileRepo['transformVia404'] = false;   // thumbnails are rendered while parsing and stored in R2
	if ( getenv( 'WST_IMPORT_DIR' ) ) {            // first boot only: local source for copyFileBackend
		$wgFileBackends[] = [ 'name' => 'westernis-import', 'class' => \Wikimedia\FileBackend\FSFileBackend::class,
			'lockManager' => 'nullLockManager', 'containerPaths' => [
				"$wgDBname-local-public" => getenv( 'WST_IMPORT_DIR' ) . '/public',
				"$wgDBname-local-deleted" => getenv( 'WST_IMPORT_DIR' ) . '/deleted' ] ];
	}
}
```

The extension sets `name`/`class`/`lockManager` (nullLockManager) on `$wgFileBackends['s3']` itself
[S35]. Whether the hand-built repo works end to end is **UNVERIFIED** until the first upload test
(section 4.6): `$wgAWSBucketName` unset, `$wgLocalFileRepo['backend']` set, and the remaining keys
filled by `SetupDynamicConfig.php:136-151` [S38]. Fallback: set `$wgAWSBucketName` and
`$wgAWSBucketDomain = "https://<host>/images"` (the r2-uploads variant), which accepts absolute
image URLs on the canonical host.

### 2.6 Boot scripts (`cloud/image/bin/`)

```sh
#!/bin/sh
# wst-start.sh — tini's child. Restores the wiki from R2 and NEVER invents an empty one.
set -eu
CFG="${WST_LITESTREAM_CONFIG:-/etc/litestream.yml}"
DB=/var/lib/westernis/db
GEN="${WST_DB_GENERATION:?}"
log() { echo "[wst-start] $*"; }
# wst-r2.php exit codes: 0 = yes/ok, 1 = no, >=2 = error (an error must never be read as "absent")
r2q() { set +e; php /usr/local/bin/wst-r2.php "$@"; rc=$?; set -e; [ $rc -ge 2 ] && { log "FATAL: R2 error ($*)"; exit 75; }; return $rc; }
restore() { # gen, timestamp-or-empty, db
  WST_DB_GENERATION="$1" litestream restore -config "$CFG" -if-db-not-exists -if-replica-exists \
    -integrity-check quick ${2:+-timestamp "$2"} "$DB/$3.sqlite"
}

mkdir -p "$DB"
restore "$GEN" "" westernis
restore "$GEN" "" westernis_cargo
restore "$GEN" "" wikicache || { log "wikicache restore failed: starting with an empty cache"; rm -f "$DB"/wikicache.sqlite*; }

if [ ! -s "$DB/westernis.sqlite" ]; then
  if r2q exists "state/$GEN.json"; then log "FATAL: generation $GEN was initialised but its replica is gone"; exit 70; fi
  if [ -n "${WST_RESTORE_FROM:-}" ]; then                     # "<gen>" or "<gen>@<RFC3339>"
    FROM="${WST_RESTORE_FROM%%@*}"; TS=""; case "$WST_RESTORE_FROM" in *@*) TS="${WST_RESTORE_FROM#*@}";; esac
    for d in westernis westernis_cargo wikicache; do
      WST_DB_GENERATION="$FROM" litestream restore -config "$CFG" ${TS:+-timestamp "$TS"} -integrity-check quick "$DB/$d.sqlite" \
        || [ "$d" = wikicache ]
    done
    [ -s "$DB/westernis.sqlite" ] || { log "FATAL: nothing restored from $WST_RESTORE_FROM"; exit 72; }
    php /usr/local/bin/wst-r2.php put-json "state/$GEN.json" "{\"generation\":\"$GEN\",\"restoredFrom\":\"$WST_RESTORE_FROM\"}"
  else
    case "${WST_BOOTSTRAP:-}" in
      import:*)
        if r2q exists-prefix state/; then log "FATAL: wiki already initialised; use WST_RESTORE_FROM"; exit 71; fi
        /usr/local/bin/wst-import.sh "${WST_BOOTSTRAP#import:}"
        php /usr/local/bin/wst-r2.php put-json "state/$GEN.json" "{\"generation\":\"$GEN\",\"importedFrom\":\"${WST_BOOTSTRAP#import:}\"}"
        export WST_IMPORT_MEDIA=1 ;;
      *) log "FATAL: no replica for $GEN and neither WST_BOOTSTRAP nor WST_RESTORE_FROM is set"; exit 73 ;;
    esac
  fi
fi
for d in westernis_cargo wikicache; do [ -e "$DB/$d.sqlite" ] || sqlite3 "$DB/$d.sqlite" 'PRAGMA journal_mode=WAL;' >/dev/null; done
exec litestream replicate -config "$CFG"
```

```bash
#!/bin/bash
# wst-run.sh — started by `litestream replicate` (exec:). Litestream forwards SIGTERM here, waits, then final-syncs.
# RULE: exit 0 after a signal. Litestream v0.5.17 skips the final sync when this exits non-zero (main.go) [S30].
set -u
cd /var/www/html
MW="php maintenance/run.php"; DB=/var/lib/westernis/db/westernis.sqlite; STOP=/tmp/wst-stop; rm -f "$STOP"
DBKEY="${LITESTREAM_ACCESS_KEY_ID:-}"; DBSECRET="${LITESTREAM_SECRET_ACCESS_KEY:-}"   # kept for the dump upload only
unset LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY                          # PHP/Apache never see the DB token
log() { echo "[wst-run] $*"; }

memcached -l 127.0.0.1 -p 11211 -m 64 -I 4m & MEMC=$!

SCHEMA="wst-schema-$(cat /etc/wst-schema-id)"
if [ -z "$(sqlite3 -cmd '.timeout 30000' "$DB" "SELECT 1 FROM updatelog WHERE ul_key='$SCHEMA'")" ]; then
  log "running update.php for $SCHEMA (point-in-time restore target before it: $(date -u +%FT%TZ))"
  if ! $MW update --quick --skip-external-dependencies; then log "update.php FAILED"; kill "$MEMC"; exit 1; fi  # self-exit: Litestream still closes
  sqlite3 -cmd '.timeout 30000' "$DB" "INSERT OR IGNORE INTO updatelog(ul_key) VALUES('$SCHEMA')"
fi
if [ "${WST_IMPORT_MEDIA:-0}" = 1 ]; then
  WST_IMPORT_DIR=/var/lib/westernis/import/media $MW copyFileBackend --src westernis-import --dst AmazonS3 \
     --containers 'local-public|local-deleted' --missingonly || log "MEDIA IMPORT FAILED: rerun via wrangler containers ssh"
fi
if [ "$(sqlite3 /var/lib/westernis/db/westernis_cargo.sqlite 'SELECT COUNT(*) FROM sqlite_master')" = 0 ]; then
  ( $MW Cargo:cargoRecreateData --create-missing-tables-only; for t in $(grep -ho 'cargo_declare:_table=[A-Za-z0-9_]*' /content/pages/Template/*.wiki | sed 's/.*=//' | sort -u); do $MW Cargo:cargoRecreateData --table "$t"; done ) >/dev/null 2>&1 &
fi

( while [ ! -e "$STOP" ]; do $MW runJobs --maxjobs 100 --maxtime 50 --wait >/dev/null 2>&1 || sleep 10; sleep 2; done ) & JOBS=$!
( sleep 600; [ -e "$STOP" ] || LITESTREAM_ACCESS_KEY_ID="$DBKEY" LITESTREAM_SECRET_ACCESS_KEY="$DBSECRET" nice /usr/local/bin/wst-dump.sh ) & DUMP=$!
apache2-foreground & HTTPD=$!
log "ready ($SCHEMA)"

shutdown() {
  trap '' TERM INT
  log "stopping"; touch "$STOP"
  kill -WINCH "$HTTPD" 2>/dev/null; wait "$HTTPD"        # graceful-stop: in-flight saves finish [S43]
  kill "$DUMP" 2>/dev/null; wait "$JOBS"                  # never kill a claimed job
  timeout 120 $MW runJobs --maxtime 100 >/dev/null 2>&1   # drain while Litestream still streams
  kill "$MEMC" 2>/dev/null
  log "stopped cleanly"; exit 0
}
trap shutdown TERM INT
wait "$HTTPD"; shutdown                                   # Apache died on its own: still exit 0 so Litestream syncs
```

- `wst-import.sh <stamp>`: `wst-r2.php get import/<stamp>/{manifest.json,westernis.sqlite,westernis_cargo.sqlite,images.tar.gz}`
  into `/var/lib/westernis/import/`. Then `wst-r2.php verify-manifest` checks the sha256 of each file
  and that `page`/`revision` counts equal the manifest, and `PRAGMA integrity_check` must return `ok`
  for both DBs. The DB files are moved into `/var/lib/westernis/db/` and `images.tar.gz` is
  extracted to `import/media/{public,deleted}`. Any failure is `exit 1`, so the marker is not written.
- `wst-dump.sh`: if `wst-r2.php age dumps/latest` is older than 7 days, run `dumpBackup --full --quiet | gzip`,
  then `put dumps/YYYY-MM-DD.xml.gz` and `dumps/latest`. This independent, portable backup is about 1 MB.
- `wst-r2.php`: AWS SDK from `extensions/AWS/vendor`, endpoint `https://<acct>.eu.r2.cloudflarestorage.com`,
  path-style, region `auto`, `request_checksum_calculation => when_required`. It uses the LITESTREAM_* key on bucket `R2_DB_BUCKET`.
  Commands: `exists`, `exists-prefix`, `get`, `put`, `put-json`, `age`, `verify-manifest`. Exit codes 0/1 answer, ≥ 2 error. It never prints credentials.

### 2.7 `cloud/image/litestream.yml`

```yaml
# Litestream v0.5.17 → R2 bucket westernis-db. Credentials from LITESTREAM_ACCESS_KEY_ID/_SECRET_ACCESS_KEY
# (do NOT set AWS_* variables: they take precedence over LITESTREAM_* [S32]).
exec: /usr/local/bin/wst-run.sh
bucket: ${R2_DB_BUCKET}                               # global replica defaults (v0.5.3+) [S32]
endpoint: ${R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com   # no scheme [S33]; EU jurisdiction endpoint
region: auto
shutdown-sync-timeout: 2m                             # default 30s; platform allows 15 min [S10][S32]
shutdown-sync-interval: 1s
snapshot:
  interval: 24h
  retention: 720h                                     # 30 days of point-in-time restore
logging:
  level: info
dbs:
  - path: /var/lib/westernis/db/westernis.sqlite
    replica: { type: s3, path: litestream/${WST_DB_GENERATION}/westernis }
  - path: /var/lib/westernis/db/westernis_cargo.sqlite
    replica: { type: s3, path: litestream/${WST_DB_GENERATION}/westernis_cargo }
  - path: /var/lib/westernis/db/wikicache.sqlite
    replica: { type: s3, path: litestream/${WST_DB_GENERATION}/wikicache }
```

`sync-interval` stays at its 1 s default. Litestream switches files to WAL and takes over
checkpointing (sqlite report, litestream.io/tips) [S34]. Environment expansion with `${VAR}` is on by
default [S32]; the per-call `WST_DB_GENERATION=…` override in `wst-start.sh` relies on that.
`litestream.file.yml` is identical but uses `type: file` and `path: /var/lib/westernis/replica/…`
for local staging (`WST_LITESTREAM_CONFIG`).

### 2.8 Apache / PHP

```apache
# cloud/image/apache-cloud.conf
<IfModule mpm_prefork_module>
    StartServers 2
    MinSpareServers 2
    MaxSpareServers 4
    ServerLimit 6
    MaxRequestWorkers 6          # default 150 × memory_limit 512M could OOM 3 GiB; OOM = no final sync
    MaxConnectionsPerChild 1000
</IfModule>
GracefulShutdownTimeout 30
# A thumbnail the Worker did not find in R2 -> MediaWiki renders it, stores it in R2 and streams it
RewriteEngine On
RewriteRule ^/?images/thumb/(archive/)?[0-9a-f]/[0-9a-f][0-9a-f]/[^/]+/[^/]+$ %{DOCUMENT_ROOT}/thumb_handler.php [L,QSA]
```

`php-cloud.ini`: `upload_max_filesize = 95M`, `post_max_size = 100M`, `opcache.validate_timestamps = 0`
(the code never changes inside a running container).

### 2.9 Migration scripts (`cloud/migrate/`)

`container/CopyMysqlToSqlite.php` (MediaWiki maintenance script, runs in the migration container):

```php
<?php
use MediaWiki\Maintenance\Maintenance;
use Wikimedia\Rdbms\IDatabase;
require_once '/var/www/html/maintenance/Maintenance.php';

/** Copies every non-derived table from the live MariaDB wiki into the fresh SQLite schema, through MediaWiki's
 *  DB layer, so values are stored exactly as MediaWiki-on-SQLite stores them (text as TEXT, not BLOB). */
class CopyMysqlToSqlite extends Maintenance {
	// rebuilt afterwards instead of copied
	private const SKIP = '/^(searchindex|objectcache|l10n_cache|job|querycache|querycachetwo|querycache_info|updatelog|site_stats|cargo_.*)$/';
	// the only non-cache columns MediaWiki core writes with encodeBlob() (LocalFile, ArchivedFile, UploadStash) [S38]
	private const BLOB_COLS = [ 'image' => [ 'img_metadata' ], 'oldimage' => [ 'oi_metadata' ],
		'filearchive' => [ 'fa_metadata' ], 'uploadstash' => [ 'us_props' ] ];

	public function execute() {
		$src = $this->getServiceContainer()->getDatabaseFactory()->create( 'mysql', [
			'host' => getenv( 'WIKI_DB_HOST' ) ?: 'db', 'user' => getenv( 'MARIADB_USER' ),
			'password' => getenv( 'MARIADB_PASSWORD' ), 'dbname' => getenv( 'MARIADB_DATABASE' ), 'tablePrefix' => '' ] );
		$dst = $this->getPrimaryDB();                                  // SQLite (LocalSettings.cloud.php, WST_DB=sqlite)
		$report = [];
		foreach ( $src->query( 'SHOW TABLES', __METHOD__ ) as $row ) {
			$t = array_values( (array)$row )[0];
			if ( preg_match( self::SKIP, $t ) ) { continue; }
			if ( !$dst->tableExists( $t, __METHOD__ ) ) { $this->fatalError( "SQLite schema lacks $t" ); }
			$this->assertSameColumns( $src, $dst, $t );            // SHOW COLUMNS vs PRAGMA table_info; abort on any difference
			$rows = iterator_to_array( $src->newSelectQueryBuilder()->select( '*' )->from( $t )->caller( __METHOD__ )->fetchResultSet() );
			$dst->begin( __METHOD__ );
			$dst->newDeleteQueryBuilder()->deleteFrom( $t )->where( IDatabase::ALL_ROWS )->caller( __METHOD__ )->execute();
			foreach ( array_chunk( $rows, 200 ) as $chunk ) {
				$chunk = array_map( fn ( $r ) => $this->prepare( $dst, $t, (array)$r ), $chunk );
				$dst->newInsertQueryBuilder()->insertInto( $t )->rows( $chunk )->caller( __METHOD__ )->execute();
			}
			$dst->commit( __METHOD__ );
			$n = (int)$dst->newSelectQueryBuilder()->from( $t )->caller( __METHOD__ )->fetchRowCount();
			if ( $n !== count( $rows ) ) { $this->fatalError( "$t: source " . count( $rows ) . " != target $n" ); }
			$report[$t] = $n;
		}
		file_put_contents( $this->getOption( 'out' ), json_encode( $report, JSON_PRETTY_PRINT ) );
	}
	private function prepare( $dst, string $t, array $r ): array {
		foreach ( self::BLOB_COLS[$t] ?? [] as $c ) { if ( $r[$c] !== null ) { $r[$c] = $dst->encodeBlob( $r[$c] ); } }
		return $r;       // other strings: DatabaseSqlite::addQuotes stores TEXT (hex BLOB only for values containing NUL) [S38]
	}
	// assertSameColumns(): compare column name sets; fatalError on mismatch.
}
$maintClass = CopyMysqlToSqlite::class;
require_once RUN_MAINTENANCE_IF_MAIN;
```

All tables fit in memory (largest: `text`, 663 rows, 3 MB). Explicit IDs keep `sqlite_sequence`
correct: the migration report tested insert 653 → next 654 in the image's SQLite 3.46.1.
`installPreConfigured`'s default rows are deleted before the insert, so `content_models`/`slot_roles` IDs match the source.

`container/migrate.sh` (outline; runs with `WST_DB=sqlite WST_MEDIA=local WST_SQLITE_DIR=/out/db`):
1. `memcached -d -l 127.0.0.1`; source counts via `WST_DB=mysql php …/counts.php > /out/source-counts.json`.
2. `installPreConfigured`, then `update --quick --skip-external-dependencies` (the same extension set creates the same tables).
3. `CopyMysqlToSqlite.php --out /out/copy-report.json`.
4. Rebuild derived data, exactly as `scripts/wiki-seed.sh` does it:
   - `Cargo:cargoRecreateData --create-missing-tables-only`, then `--table T` for each `_table=` in `/content/pages/Template/*.wiki`;
   - `refreshLinks`, `rebuildtextindex`, `updateCollation --force` (the category sort keys are recomputed by PHP);
   - `initSiteStats --update`, `updateSpecialPages`, `runJobs`.
5. Target counts: `counts.php > /out/target-counts.json`.
6. XML equality (IDs are preserved):
   - `WST_DB=mysql … dumpBackup --full` vs. `dumpBackup --full`, and `--logs` vs. `--logs --end <source max log_id + 1>`;
   - strip `<siteinfo>…</siteinfo>` and the root tag, then `cmp`;
   - any difference **aborts**.
7. For both DBs: `PRAGMA integrity_check` = `ok`, then `wal_checkpoint(TRUNCATE)`, `VACUUM`, `journal_mode=DELETE`, which leaves a single file each.
8. `images.tar.gz` with two folders:
   - `public/` = the `images/` tree without `thumb/ temp/ lockdir/ deleted/ lock_* .htaccess README`, so the 38 `archive/` leftovers are kept;
   - `deleted/` = `images/deleted/`, if present.
9. `manifest.php` → `manifest.json` (sha256 and bytes per file, the counts from steps 1 and 5, namespaces, `MAX(rev_id)`, `MAX(log_id)`, Cargo rows per table, image name → SHA-1, diff results).

`Export-Bundle.ps1 [-Freeze]`:
1. `docker build -f cloud/image/Dockerfile -t westernis/mediawiki-cloud:<stamp> .`
2. With `-Freeze`, freeze the legacy wiki:
   - `runJobs` until the queue is empty;
   - write MediaWiki's read-only file `images/lock_yBgMBwiR` with the text "Umzug nach Cloudflare – Bearbeiten pausiert". `$wgReadOnlyFile` defaults to that path [S38];
   - `docker compose stop jobrunner`.
3. `docker run --rm --network westernis_default --env-file .env -e WST_DB=sqlite -e WST_MEDIA=local -e WST_SQLITE_DIR=/out/db -e WST_STAMP=<stamp> -v westernis_wiki_images:/src-images:ro -v westernis_migrate:/out --entrypoint /opt/westernis/migrate/migrate.sh westernis/mediawiki-cloud:<stamp>`.
   Named volumes only (no bind mounts) [S45]. The `.env` values stay inside the container and are never printed.
4. `docker cp` the bundle to `cloud/migrate/out/<stamp>/` (untracked). The bundle never contains `.env`: `wiki.ps1 backup` copies `.env` into backup folders, so never upload a backup folder.

`Upload-Bundle.ps1 <stamp>`: `npx wrangler r2 object put westernis-db/import/<stamp>/<file> --file … --remote`
for the 4 files (Wrangler accepts up to 315 MB per object [S23]).

`verify-cloud.mjs <stamp>`: see section 4.6.

### 2.10 Secret push and control

`Push-Secrets.ps1` (run by the owner):

```powershell
#Requires -Version 7.0
# Reads .env (WIKI_SECRET_KEY) and .env.cloud (R2 keys), pipes JSON to `wrangler secret bulk` on stdin [S22].
# Prints key NAMES only; no temp file, nothing on the command line.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
function Read-DotEnv($p) { $m = @{}; Get-Content $p | ? { $_ -match '^\s*[A-Z0-9_]+\s*=' } | % { $k, $v = $_ -split '=', 2; $m[$k.Trim()] = $v.Trim() }; $m }
$main = Read-DotEnv (Join-Path $root '.env'); $cloud = Read-DotEnv (Join-Path $root '.env.cloud')
$s = [ordered]@{ WIKI_SECRET_KEY = $main['WIKI_SECRET_KEY'] }
foreach ($k in 'R2_DB_ACCESS_KEY_ID','R2_DB_SECRET_ACCESS_KEY','R2_MEDIA_ACCESS_KEY_ID','R2_MEDIA_SECRET_ACCESS_KEY') { $s[$k] = $cloud[$k] }
$missing = @($s.GetEnumerator() | ? { -not $_.Value } | % Key)
if ($missing) { throw "Missing values for: $($missing -join ', ')" }
$s | ConvertTo-Json -Compress | npx wrangler secret bulk --config (Join-Path $root 'cloud\wrangler.jsonc')
if ($LASTEXITCODE) { throw 'wrangler secret bulk failed' }
Write-Host "Secrets set: $($s.Keys -join ', ')"
```

`wst.ps1` subcommands:

| Subcommand | Runs |
|---|---|
| `deploy` | `wrangler deploy` (image changes → rollout) |
| `deploy-worker` | `--containers-rollout=none` [S10] |
| `logs` | `wrangler tail` |
| `status` | siteinfo via Forge, plus `wrangler containers instances` |
| `ssh` | `wrangler containers ssh <id>` [S14] |
| `restart` | `POST /__wst/restart` with the service token |
| `backup` | download `dumps/latest` with `wrangler r2 object get`, plus `litestream restore -o` in a throwaway Docker container (keys from `.env.cloud`) into `backups/` |
| `seed` | `node tools/forge-mcp/src/seed.js` |

---

## 3. Erweiterungen und SQLite

Basis: all 41 skins/extensions loaded by `LocalSettings.php`, read in the pinned code of
`westernis/mediawiki:1.46` (extensions report), plus the checks above. **No MediaWiki was installed
on SQLite**. The local staging run in section 4.2 is the go/no-go gate (UNVERIFIED until then).
Manual:SQLite (2026-07-18) calls SQLite support "second-class" and lists AbuseFilter, Echo, Flow and
LiquidThreads as incompatible [S40]. None of them is used.

| Component (pin) | DB footprint | Verdict | Decision |
|---|---|---|---|
| **MediaWiki core 1.46.0** | all core tables | works with config | `$wgSQLiteDataDir` outside the docroot; `wikicache` own file with IMMEDIATE transactions [S38]; l10n `store=files` prebuilt in the image; jobs in the main DB. Search: `SearchSqlite`, FTS3 (compiled in; no stemming, same as today) → `rebuildtextindex` after the import. |
| **Cargo 3.9.4** | own tables + `cargo_tables/pages/backlinks` | **broken without config → works with config**. Upstream: SQLite support "has not been well-tested … may not work" [S39] | (1) `$wgCargoDBfilePath` own file (D4). (2) Fix `Third_Age.wiki` → `type='Realm'`. (3) Keep double-quoted values (the only quoting that survives HOLDS + apostrophes); build-time DQS guard (2.4 step 5). (4) Accept byte-order sorting and case/accent-sensitive matching, or approve a `sortkey` field (Q7). (5) MySQL-only functions (`YEAR`, `MONTH`, `DATE_FORMAT`, `IF`, `NOW`, `REGEXP`) are unavailable; no template uses them; documented in the `wiki_cargo_query` description. (6) Drilldown date filters use `YEAR()`: there are no Date fields (entities.js) → no impact. |
| **PageForms 6.0.11** | none | works (minor) | Autocomplete `LOWER()` folds only ASCII beyond 100 local values → accept. |
| **DynamicPageList4 4.0.6** | core tables | works (limits) | `*regexp` parameters fail; `ordercollation` only BINARY/NOCASE/RTRIM; Main_Page uses neither → accept. |
| **ReplaceText 1.8** | reads `text.old_text` | works with a limitation | No regex checkbox on SQLite → regex replacements through the Forge MCP (get, JS regex, save). Requires `old_text` stored as TEXT (D3). |
| **Extension:AWS** (master b794321) — new | none | expected to work, UNVERIFIED end to end | Pinned SHA; ACL `private`; checksum env vars; smoke test (4.6). Fallback if R2 ever rejects `x-amz-acl: private`: a Dockerfile `sed` that drops the `ACL` keys in `AmazonS3FileBackend.php` [S35][S37]. |
| TemplateData, Math, Nuke | page_props / schema hooks | works | Math's schema hook names `sqlite` explicitly; TemplateData stores uncompressed JSON. |
| MsUpload, SimpleBatchUpload | none | works | Upload size 95 MB (2.5). |
| VisualEditor (Parsoid in core) | none | works | In-process `DirectParsoidClient`: no HTTP loopback that the gate could block (containers report). Its stash lives in MainStash → `wikicache` (D6). |
| Citizen 3.24.0, Vector, CategoryTree, Cite, CodeEditor, Gadgets, ImageMap, InputBox, MultimediaViewer, PageImages, ParserFunctions, PdfHandler, Poem, Scribunto (luasandbox), SyntaxHighlight, TemplateStyles, TextExtracts, WikiEditor, PortableInfobox, DisplayTitle, LabeledSectionTransclusion, TabberNeue, ShortDescription, Popups, RelatedArticles, Lingo, DataMaps, Mermaid, Network, CodeMirror, CharInsert | none or core tables via QueryBuilder | works | No change. `$wgRunJobsAsync` stays false: async jobs would call back through the public hostname, which the gate blocks (401). |

---

## 4. Migration, Cut-over, Rollback

The local Docker wiki stays intact (volumes `westernis_db_data`, `westernis_wiki_images`) until the
owner confirms. The live state measured on 2026-10-06:

| Table / item | Count |
|---|---|
| page | 276 |
| revision | 653 |
| archive | 11 |
| logging | 529 |
| user | 3 |
| bot_passwords | 1 |
| image | 5 |
| oldimage | 1 |
| filearchive | 0 |
| cargo_tables | 11 |
| `MAX(rev_id)` | 664 |
| uploads | 2.1 MB |

### 4.1 Voraussetzungen
Section 6, steps O1–O6 done: plan, `wrangler login`, buckets, tokens, `.env.cloud`, DNS free.

### 4.2 Phase A — Build and local staging (no freeze, agent)
1. Implement section 2. Run `Export-Bundle.ps1` **without** `-Freeze`, which produces a dry-run bundle while the wiki stays usable.
2. Staging container: the cloud image with `WST_LITESTREAM_CONFIG=/etc/litestream.file.yml`, `WST_MEDIA=local`, the dry-run DB files placed in a named volume, a free host port such as 8090. Checklist (from the extensions and sqlite reports):
   - Save an infobox page three ways (source editor, VisualEditor, Form:Character): no 60 s stall, no "database is locked"; rows appear in `Special:CargoTables/Characters`.
   - Main_Page (DPL4 lastedit/randomcount, Timeline join), Third_Age realms list (after the quote fix), Aragorn II (`{{Relationships}}`, `{{Appearances}}`, `Module:Family`), Weltkarte (DataMaps), `Special:Drilldown/Characters`, `Special:Search`, Special:ReplaceText (plain).
   - `node tools/forge-mcp/src/smoke.js` and `test-tools.js` against the staging URL (test-tools overwrites the sample page Halbarad, which is fine on staging).
   - Job loop and a web edit at the same time: watch the logs for `database is locked` and `SQLITE_BUSY`.
   - `docker stop` (SIGTERM) → the log must show `stopped cleanly` and then Litestream's `litestream shut down`. Restart → data intact.
   - `docker kill -s KILL` during an edit → restart → compare `MAX(rev_id)`; loss ≤ the last ~1–2 s.
   - Measure the cold-start time (container start → `/__ready`).
3. Optional: `npm run dev` in `cloud/` (`wrangler dev --local-upstream localhost`) with `.dev.vars` (dev-only gate password, `WIKI_HOSTS=localhost`) to exercise the gate, the waking page and `/images` against the local R2 and rate-limit simulations [S13].
4. **Go/no-go:** a Cargo failure that is not fixable by config stops the migration. MariaDB is not available in-platform, and an external DB would break the "fully Cloudflare" goal.

### 4.3 Phase B — Freeze and export (owner approves the freeze, agent runs it)
`Export-Bundle.ps1 -Freeze` (2.9): queue drained, read-only lock file, jobrunner stopped, then the final
bundle. Any count or diff mismatch aborts before anything is uploaded. Expected duration ≈ 10 min.

### 4.4 Phase C — Upload
`Upload-Bundle.ps1 <stamp>` → `westernis-db/import/<stamp>/{manifest.json,westernis.sqlite,westernis_cargo.sqlite,images.tar.gz}`.
The bucket is private, and its `import/` prefix expires after 30 days. Delete the prefix earlier once the import is verified: the DB holds password hashes.

### 4.5 Phase D — Deploy and first boot
1. **Deploy 1, "dark"**: no gate secrets yet, `WST_BOOTSTRAP=""` → `npx wrangler deploy`.
   - Both custom domains, their DNS records and certificates are created [S20].
   - The image is pushed and the container application is created. The first deploy can take minutes [S13].
   - Without gate secrets the Worker answers 503 to everything (fail-closed), so no container is started yet.
2. Owner: the secret script (2.10) sets the gate secrets together with the others (5.1). From now on the gate is active.
3. **Deploy 2**: set `WST_BOOTSTRAP=import:<stamp>` → `npx wrangler deploy --containers-rollout=none`.
4. First request (the owner in the browser after the gate password, or the agent with `smoke.js` and the API token). In the container:
   - `wst-start.sh` finds no replica and no marker, imports the bundle, writes `state/g1.json`;
   - Litestream seeds `litestream/g1/…` with fresh snapshots;
   - `wst-run.sh` sees an unchanged schema hash (the bundle was built with the same image, so `update.php` is skipped), copies the media with `copyFileBackend` (about 45 objects), then starts Apache.

   The browser sees the waking page for ≈ 1–2 min (estimate).
5. **Deploy 3**: `WST_BOOTSTRAP=""` (leaving it set is harmless; the guard refuses a second import) → `deploy --containers-rollout=none`.

### 4.6 Phase E — Verification (agent, `verify-cloud.mjs` with the service token)

| Check | Expected (from manifest.json) |
|---|---|
| `meta=siteinfo` statistics | pages 276; images 5; users 3. Edits may differ: `initSiteStats` recounts, so this is explained, not "fixed". |
| `list=allpages` per namespace | 0:32, 4:4, 6:5, 8:88, 10:48, 12:1, 14:82, 106:11, 828:3, 2900:1, 3000:1 |
| `list=allrevisions` count / newest revid | 653 / 664 |
| `list=alldeletedrevisions` (bot has viewdeleted) | 11 |
| `list=logevents` | ≥ 529, and the first 529 identical to the source dump |
| `list=allusers`, bot login | 3 users; the Forge bot password works unchanged (hash copied; restrictions 0.0.0.0/0, ::/0) |
| `cargoquery COUNT(*)` per table (11) | = source counts (e.g. Characters 5, Locations 5, Events 3, Eras 3) |
| `list=allimages&aiprop=sha1\|url` + `HEAD` of every URL through the Worker | SHA-1 = manifest; HTTP 200 with CSP + nosniff headers |
| `list=search srsearch=Gondor` | > 0 hits |
| `action=parse` Main_Page, Third_Age, Aragorn II | no Lua or Cargo errors, no "database is locked" |
| Upload smoke | Upload a PNG and an SVG (the object has `x-amz-meta-sha1base36`, the thumb appears under `thumb/`). Re-upload (→ `archive/`). Delete (→ `deleted/`, URL 404 through the Worker). Range request on the WebP. |
| `smoke.js` | Edit round trip on `Notes:Forge smoke test` |
| **Restart drill** | `POST /__wst/restart` → logs show `stopped cleanly` + Litestream shut down → next request cold-starts **from R2** → the smoke edit is still there; record the cold-start time. |
| Public exposure | Without session or token: 302 to `/__wst/login` (navigations) or 401 on both hosts; a wrong token 401; `*.workers.dev` unreachable; `/images/deleted/...` 404. |

### 4.7 Cut-over
1. Owner: `.env` → `WIKI_API=https://edit.wiki.example.org/api.php`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`; restart Claude Code (the MCP server reloads `.env`).
2. The local wiki stays frozen (read-only file) and can be stopped with `docker compose stop`. Volumes are kept.
3. Trial period (suggested 7–14 days), then the owner confirms: `docker compose down` (volumes stay). Delete the volumes after 30 more days (owner).

### 4.8 Rollback
- **Before confirmation (cloud unusable):**
  1. Remove `images/lock_yBgMBwiR` in the local wiki, run `docker compose start`, and drop `WIKI_API` from `.env`.
  2. Edits made in the cloud meanwhile: export them via the API (`list=recentchanges` since the cut-over → `action=query&export`), then `importDump` locally.
  3. The cloud Worker can stay dark (without `GATE_PASSWORD_HASH` it answers 503 to everything) or be deleted by the owner.
- **In the cloud (bad edit, failed `update.php`, corruption):** point-in-time restore into a **new generation**, which leaves the old replica untouched:
  1. Set `WST_DB_GENERATION=g2` and `WST_RESTORE_FROM=g1@2026-11-02T10:00:00Z` (any time inside the 30-day retention; the boot log prints the pre-`update.php` timestamp).
  2. `deploy --containers-rollout=none`, then `POST /__wst/restart`.
  3. Once it works, clear `WST_RESTORE_FROM`.

  Uploads newer than the restore point remain as harmless orphans in R2 (`findMissingFiles`/`checkImages`).
- **Independent of Litestream:** the weekly `dumps/*.xml.gz` (180 days) plus R2 media allow a rebuild through `importDump` in the worst case.

---

## 5. Zugang: jetzt und später öffentlich

No Cloudflare Access and no Zero Trust organisation (D18): the Worker's password gate (1.6) is the
only login. There is nothing to set up for it in the Cloudflare dashboard.

### 5.1 Jetzt (privat) — owner: one password

1. **Choose the gate password**: a long passphrase (there is no user name and no second factor). It is
   typed only into the local secret script (2.10), never into chat or a file; the Worker stores only its hash.
2. **Secrets** (secret script, together with the others in 2.2):
   - `GATE_PASSWORD_HASH` = `pbkdf2-sha256$100000$<salt_b64>$<hash_b64>`: PBKDF2-HMAC-SHA256 over the UTF-8
     bytes of the password exactly as typed (no trimming, no Unicode normalisation), 100000 iterations,
     16 random salt bytes, 32-byte result, standard base64. `cloud/src/gate.js` exports `hashPassword()`
     for Node ≥ 22.
   - `SESSION_SECRET` and `API_TOKEN`: at least 32 random characters each (for example 32 random bytes as base64url).
   - `API_TOKEN` also goes into the untracked `.env`, for the Forge MCP and `wst.ps1`.
3. **Single sign-on:** the var `GATE_WIKI_USER` is rendered from `WIKI_ADMIN_USER` in `.env`. After the gate
   password the wiki opens already signed in as that MediaWiki account; the container learns the same
   name as `WIKI_SSO_USER`. An empty value turns SSO off (sign in to MediaWiki separately).
4. **Test:** a private browser window gets the Westernis login page on both hosts; after the password the
   wiki opens signed in; `curl` without headers gets 401; Forge `smoke.js` works with the token; six wrong
   passwords within a minute give 429.
5. Check **Bot Fight Mode** (Security → Bots) on the zone. If Forge requests get challenged, turn it off
   (UNVERIFIED whether it affects requests with `X-Westernis-Token`).

**Changing the password:** run the secret script again. The new hash changes `pv`, so every session on
every device ends. A new `SESSION_SECRET` has the same effect. A new `API_TOKEN` must go into `.env` too.

**Failure modes:** a missing or malformed `GATE_PASSWORD_HASH` or `SESSION_SECRET` means 503 "Westernis ist
noch nicht eingerichtet." for everyone: an outage, never a leak. A missing `LOGIN_LIMIT` binding
disables only the login form (503); sessions and the token keep working. A forgotten password: set a new
one with the script.

### 5.2 Später: öffentliches Lesen (no rebuild, no container rollout)
1. Var `PUBLIC_READ_HOSTS=wiki.example.org` (optionally `MEDIA_CACHE_CONTROL=public, max-age=3600`) → `wst.ps1 deploy-worker`. Effect on the reading host:
   - anonymous GET/HEAD reaches MediaWiki without any cookie and without the SSO header;
   - every other anonymous method gets 401; login and edit URLs redirect to the edit host, where the gate asks for the password;
   - MediaWiki already shows no exception details and applies its default anonymous rate limits there (2.5);
   - the owner, signed in through the gate, keeps single sign-on on the reading host.

   The edit host never serves anonymous requests, even if it is listed by mistake.
2. Recommended:
   - one WAF rate-limiting rule on the reading host;
   - edge caching of anonymous HTML in the Worker (Cache API, short TTL), so crawlers do not keep the container awake (cost, section 7).
3. **Revert:** clear `PUBLIC_READ_HOSTS` and deploy the Worker again.

The read/write split lives in the Worker because MediaWiki reads and writes share URLs
(`index.php?action=edit`, `api.php`); only the Worker sees method, query string and session together.

---

## 6. Checkliste: Owner vs. Agent (in Reihenfolge)

**Owner only** (logins, payments, secrets, dashboard):

| # | Action |
|---|---|
| O1 | Confirm **Workers Paid** ($5/month) is active (Containers need it [S9]). Check the plan of the `example.org` zone: Free/Pro → 100 MB upload cap [S21]. |
| O2 | `npx wrangler login` once on the PC (browser OAuth). Docker Desktop must run for image deploys [S13]. |
| O3 | DNS: make sure no record exists for `westernis` or `edit.westernis` (a CNAME blocks custom domains [S20]). |
| O4 | Create R2 buckets `westernis-db` and `westernis-media` (EU jurisdiction), or approve that the agent creates them with `wrangler r2 bucket create <name> --jurisdiction eu`. Leave r2.dev and custom domains **off**. Lifecycle rules as in 1.5 (the agent may add them via `wrangler r2 bucket lifecycle add` [S23]). |
| O5 | Create 2 R2 **Account API tokens** (Object Read & Write, *specific bucket*: one for each bucket) [S25]. Put the Access Key IDs and secrets into the untracked `.env.cloud`, together with `CF_ACCOUNT_ID`, the hostnames and the bucket names. Never paste them into chat. |
| O6 | Optional: `ssh-keygen -t ed25519`; put the **public** key into `.env.cloud` (`SSH_PUBLIC_KEY`). |
| O7 | Approve the staging result (go/no-go, 4.2) and the freeze window (4.3). |
| O8 | Run `cloud/scripts/Push-Secrets.ps1` after deploy 1. |
| O9 | Choose the gate password and type it once into the local secret script (5.1). Nothing to set up in the Cloudflare dashboard for logins. |
| O10 | Cut-over in `.env` (4.7), trial period, then confirm → `docker compose down`; after 30 days delete the volumes. |
| O11 | Later: public switch (5.2). Optional: change the gate password now and then (ends all sessions). |

**Agent** (after the owner's go for each side-effecting step):

| # | Action |
|---|---|
| A1 | Implement section 2, the changes outside `cloud/`, and `seed.js`. |
| A2 | Build the image locally; dry-run export; staging checklist (4.2); report measurements. |
| A3 | Render `wrangler.jsonc` (`Init-Cloud.ps1`), `npm ci`, deploy 1 (dark). |
| A4 | Final export with freeze (4.3), upload (4.4), deploy 2 + first boot (4.5). |
| A5 | Verification + restart drill (4.6); write the results into the cut-over note. |
| A6 | Deploy 3 (clear `WST_BOOTSTRAP`); delete `import/<stamp>/` after the owner's OK; update README.md and CLAUDE.md. |

---

## 7. Kosten und Risiken

### 7.1 Kosten (Workers Paid; rates from [S9], R2 [S26])

| Item | 2 h/day (≈ 60 h/month incl. idle tail) | 4 h/day (≈ 120 h) | 8 h/day (≈ 240 h) |
|---|---|---|---|
| Workers Paid plan | $5.00 | $5.00 | $5.00 |
| Container memory: 3 GiB × $0.0000025/GiB-s, 25 GiB-h included | $1.40 | $3.02 | $6.26 |
| Container disk: 8 GB × $0.00000007/GB-s, 200 GB-h included | $0.07 | $0.19 | $0.43 |
| Container CPU: active only, assumed 10 % of 1 vCPU; 375 vCPU-min included (UNVERIFIED utilisation) | $0.00 | $0.41 | $1.28 |
| DO, Worker requests, container egress (1 TB included NA/EU), R2 (< 1 GB, ops in the free tier), login rate limiting | ≈ $0 | ≈ $0 | ≈ $0 |
| **Total** | **≈ $6.5** | **≈ $8.6** | **≈ $13** |

- The `sleepAfter` tail (20 min) is billed after every session. Shorter means cheaper but more cold starts (Q2).
- `basic` (1/4 vCPU, 1 GiB) would save about $2–5/month at the price of slower pages (Q3). Switching instance types later is only a config change and a rollout, with no rebuild.
- From **2026-12-01**, container logs are billed under Observability pricing; the amount is small and not quantified (containers report).
- **Public phase:** crawlers waking the container are the main cost risk → mitigations in 5.2 step 3.
- R2 Class A operations: about one LTX upload per changed second per DB while editing, plus compactions. Estimated well under 1 M/month (UNVERIFIED; check the R2 metrics after a week).

### 7.2 Risiken

| Risk | Impact | Mitigation |
|---|---|---|
| **Cargo on SQLite** ("not well-tested" [S39]); other SQLite-only bugs | infoboxes, queries, MCP | Own file (D4); staging gate (4.2); Third_Age fix; DQS build guard; dialect notes in the MCP |
| **Data-loss window** | lost edits | Graceful stops (sleep, rollout, maintenance, restart): **0** if R2 is reachable within 2 min. OOM, host crash or `destroy()`: last **~1–2 s** (sync-interval). R2 unreachable for the whole shutdown window: everything since the last sync. Mitigations: `exit 0` rule [S30], prefork cap (OOM), 3 GiB, weekly XML dumps |
| **Empty wiki overwrites history** (fresh DB against an existing replica) | catastrophic | No automatic install; `state/<gen>.json` marker; R2 errors are never read as "absent"; generations for restores |
| **Split-brain** (two writers) | replica diverges | One DO name, `max_instances: 1`, the DO waits for exit, rollouts stop before start [S5][S10]. Residual UNVERIFIED case → v1.1 lease (1.7) |
| **Cold starts** exceed timeouts | 500s, failed MCP calls | 30 s / 180 s timeouts, waking page, Forge timeout 200 s; measure in the drill |
| **Image ≈ 2 GB** (pull time on a new host) | slower cold starts | Measure; strip `tests/`; WEUR placement keeps the image on few hosts |
| **Extension:AWS** only on untagged master; hand-built repo config (D2) | uploads fail | Pinned SHA; upload smoke (4.6); fallback to `$wgAWSBucketDomain`; ACL `sed` patch if R2 ever rejects `private` (UNVERIFIED today [S37]) |
| **Container class** documented "for existing applications" [S3] | future deprecation | Pinned 0.3.7; documented migration path to `ctx.container` (then own idle timer + flush) |
| **`update.php` breaks the DB on an image upgrade** | outage | Runs once per schema hash, logs a restore timestamp; generation-based point-in-time restore (4.8) |
| **Gate misconfiguration or a guessable password** | leak or lock-out | Fail-closed Worker (503 without well-formed secrets), exact host allowlist, `workers_dev`/`preview_urls` off; PBKDF2 with 100000 iterations, 5 attempts per minute and IP, 750 ms delay per failure; use a long passphrase; a new password ends every session. A broken configuration means an outage, never a leak |
| **API token leaks** (it sits in `.env`) | read access to the wiki | Untracked `.env` and a Worker secret only; never the SSO identity: without the bot password a token request is anonymous in MediaWiki. Rotate it with the secret script (and `.env`) |
| **Forged single sign-on** | impersonation | Only the Worker sets `X-Westernis-User`, after removing every client `X-Westernis-*` header; token requests never carry it; the container is reachable only through the Worker [S11] |
| **Secrets in the container env** | PHP RCE could read the media token | Bucket-scoped tokens; DB token unset before PHP; no AWS_* vars |
| **Worker deploy restarts the DO** and cuts in-flight requests (containers report) | an edit request fails | Deploy in quiet times; `--containers-rollout=none` for Worker-only changes |
| **Rollout**: new Worker live before the new image [S10] | brief mixed versions | Keep Worker ↔ container contract stable (ports, env names) |
| **SQLite behaviour**: byte-order sorting, case/accent-sensitive Cargo `=`, no ReplaceText regex | UX | Accept or add a `sortkey` field (Q7) |
| **100 MB upload cap** [S21] | large uploads fail | `$wgMaxUploadSize` 95 MB; Business plan would allow 200 MB |
| **Bundle contains password hashes** | exposure if leaked | Private bucket, 30-day lifecycle, delete after verification, never `.env` |
| **Public repo leaks install data** | privacy | `wrangler.jsonc`, `.env*`, `migrate/out/` untracked; this doc uses placeholders |
| Logs kept 7 days only (containers report) | forensics | Weekly dumps; copy important log excerpts into the cut-over note |

---

## 8. Offene Fragen an den Owner

1. **Edit host name:** `edit.wiki.example.org` (logins, editing, MCP; always private), or one host only (simpler, but going public later also exposes the login page)?
2. **Idle timeout:** `sleepAfter` 20 min. Shorter is cheaper, longer gives fewer cold starts.
3. **Instance size:** custom 1 vCPU / 3 GiB (≈ $3.6/month container at 4 h/day), or try `basic` (1/4 vCPU, 1 GiB) first?
4. **Placement / data location:** `WEUR` + R2 location hint `weur` (proposed), or the EU jurisdiction (stricter; the endpoint changes to `.eu.`)?
5. **Build path:** v1 deploys from the PC with Docker Desktop. Later: Workers Builds from a **private** repo (GitHub or Cloudflare Artifacts)? Does the planned public repo get a separate private deploy config?
6. **Zone plan** of `example.org`: is a 95 MB upload limit acceptable?
7. **SQLite trade-offs:** accept byte-order sorting and case/accent-sensitive Cargo matching, or approve an ASCII `sortkey` field in `entities.js`? Accept ReplaceText without regex?
8. ~~**Login method**~~ — decided 2026-10-06: no Cloudflare Access; a password gate in the Worker with single sign-on (D18, 1.6).
9. **Retention:** 30 days of point-in-time restore, weekly XML dumps kept 180 days. OK?
10. ~~**Zero Trust**~~ — not needed any more (D18).
11. **Trial period** before `docker compose down`: 7–14 days? Volume deletion after 30 more days?

---

## 9. Quellen und Unverifiziertes

### 9.1 Quellen (read 2026-10-06; dates are the docs' "last updated")

- [S1] Container class API — https://developers.cloudflare.com/containers/api/container-class/ (2026-09-30): `startAndWaitForPorts` defaults 8 s / 20 s, `envVars` on every start, `sleepAfter` default 10m, `enableInternet` default true.
- [S2] `@cloudflare/containers` 0.3.7 (npm, 2026-06-29), `dist/lib/container.js`, read locally: `sleepAfter` "The container won't get a SIGKILL"; `onActivityExpired()` default `stop()`; in-flight counter; `pingEndpoint = 'ping'`; `containerFetch` auto-start; `stop()` sends the signal only.
- [S3] Containers API overview — https://developers.cloudflare.com/containers/api/ (2026-09-29): the DO Container API is recommended for new apps; the Container class "remains documented for existing applications"; migration guide.
- [S4] Scheduling policy — https://developers.cloudflare.com/containers/configuration/scheduling-policy/ (2026-09-30): `default` is GA, `durable_object` is beta, immutable.
- [S5] Wrangler configuration, containers — https://developers.cloudflare.com/workers/wrangler/configuration/#containers: `max_instances` (default 20; exceeding it errors), `image_build_context`, `constraints.regions`, custom instance types, SSH `enabled` default true.
- [S6] Containers Wrangler configuration — https://developers.cloudflare.com/containers/configuration/wrangler/ (2026-09-29): `containers` + `durable_objects.bindings` + `exports`; do not combine with `migrations`.
- [S7] Limits — https://developers.cloudflare.com/containers/platform/limits/ (2026-09-30): instance types; custom: min 1 vCPU, ≥ 3 GiB/vCPU, max 12 GiB / 20 GB.
- [S8] Changelog 2026-09-29 "Custom Container instance types no longer have a disk to memory ratio limit": image size = disk.
- [S9] Containers pricing — https://developers.cloudflare.com/containers/platform/pricing/ (2026-10-05).
- [S10] Rollouts — https://developers.cloudflare.com/containers/configuration/rollouts/ (2026-09-30): SIGTERM → up to 15 min → SIGKILL; Worker active first; no rollout without container changes; `--containers-rollout`.
- [S11] Architecture — https://developers.cloudflare.com/containers/concepts/architecture/ (2026-09-30): platform stop sequence; all container requests pass through a Worker.
- [S12] FAQ — https://developers.cloudflare.com/containers/faq/ (2026-10-05): cold starts "often 1-3 seconds"; disk ephemeral; OOM restarts; FUSE is not SSD-like.
- [S13] Deploy guide — https://developers.cloudflare.com/containers/guides/deploy/ (2026-09-22): Docker needed for Dockerfile images; not transactional; first deploy takes minutes; Workers Builds; `wrangler dev`.
- [S14] SSH — https://developers.cloudflare.com/containers/guides/ssh/ (2026-08-28); changelog 2026-05-12 (SSH on by default; ed25519 only).
- [S15] Placement — https://developers.cloudflare.com/containers/concepts/placement/ (2026-10-01).
- [S16] Cloudflare Access for Workers — https://developers.cloudflare.com/workers/configuration/cloudflare-access/ (2026-08-18): Worker-level app, hierarchy (hostname > Worker > account), `ctx.access`, no WebSockets, Static Assets caveat, `access.dev`.
- [S17] Changelog 2025-10-03 "One-click Access for Workers": jose JWT validation, `POLICY_AUD`/`TEAM_DOMAIN`.
- [S18] Service tokens — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ (2026-10-02) and changelog 2026-10-02: strict mode, forced for orgs created on/after 2026-10-05.
- [S19] Application token claims — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ (`aud`, `common_name`, `iss`).
- [S20] Custom Domains — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ (2026-09-29): automatic DNS + Advanced Certificate incl. multi-level subdomains; not on a hostname with an existing CNAME.
- [S21] Workers limits — https://developers.cloudflare.com/workers/platform/limits/: request body 100 MB Free/Pro, 200 MB Business.
- [S22] Secrets — https://developers.cloudflare.com/workers/configuration/secrets/ and `wrangler secret bulk` (stdin, JSON) — https://developers.cloudflare.com/workers/wrangler/commands/workers/
- [S23] Wrangler R2 commands — https://developers.cloudflare.com/workers/wrangler/commands/r2/ (lifecycle add, object put `--remote`); upload limit 315 MB — https://developers.cloudflare.com/r2/objects/upload-objects/
- [S24] R2 S3 compatibility — https://developers.cloudflare.com/r2/api/s3/api/ (2026-07-31): region `auto`.
- [S25] R2 tokens — https://developers.cloudflare.com/r2/api/tokens/ (2026-10-01): Object Read & Write scoped to buckets; object tokens only via the S3 API.
- [S26] R2 pricing — https://developers.cloudflare.com/r2/pricing/ (2026-10-01).
- [S27] R2 Workers API — https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (2026-07-31): `get` with `onlyIf`/`range`, `writeHttpMetadata`, `httpEtag`.
- [S28] Changelog 2026-06-30 "Declare Durable Object class lifecycle with `exports`".
- [S29] Litestream v0.5.17 release (2026-08-31), `checksums.txt`: `litestream-0.5.17-linux-x86_64.tar.gz` sha256 `cfb37117…9c006d` (fetched).
- [S30] Litestream `cmd/litestream/main.go` @ v0.5.17 (fetched): the signal is forwarded to the exec child; a non-signal error from the child returns before `Close()`; `Close()` performs the shutdown sync; a second signal closes `done`.
- [S31] Litestream `cmd/litestream/restore.go` @ v0.5.17: flags `-if-db-not-exists`, `-if-replica-exists`, `-timestamp`, `-integrity-check`; `-if-replica-exists` returns 0 only for `ErrTxNotAvailable`.
- [S32] https://litestream.io/reference/config/: `LITESTREAM_*` / `AWS_*` credentials (precedence), `${VAR}` expansion, defaults (shutdown-sync-timeout 30s, snapshot 24h/24h, socket off, l0-retention 5m), global bucket/endpoint/region.
- [S33] https://litestream.io/guides/s3-compatible/ (R2: endpoint without scheme, region auto, automatic concurrency 2 + sign-payload since v0.5.8).
- [S34] https://litestream.io/tips/, https://litestream.io/guides/s3-advanced/ (single replicator; leasing only through the Go library), as cited by the sqlite report.
- [S35] Extension:AWS master `b79432133e076b3c1771834576b8d574f2432b0b` (2026-09-17), fetched: `ChangeLog` "Added support for MediaWiki 1.46"; `extension.json` 0.14.0, MW ≥ 1.43; `includes/AmazonS3Hooks.php` (no bucket name → backend only, `$wgLocalFileRepo` left to the admin; `https://` prefixing; `img_auth` on private wikis); `s3/AmazonS3FileBackend.php` (`privateWiki` → ACL `private`, `endpoint`, `use_path_style_endpoint`, vendor autoload fallback). Latest tag v0.14.0.
- [S36] Extension:AWS issues #75, #80, #88 (as cited by the r2-uploads report).
- [S37] Community reports that R2 answers 501 to `x-amz-acl: public-read` but accepts `private`: pixelfed #3775 (2022), rclone forum (2022), Mastodon PR #20510. **No Cloudflare doc; UNVERIFIED today.**
- [S38] MediaWiki 1.46.0 source in the running image (read-only `docker exec`, 2026-10-06):
  - `DatabaseSqlite::addQuotes` (L654–684);
  - `SqlBlobStore.php:196` (`old_text` written as a plain string);
  - `encodeBlob` callers (`SqlBagOStuff`, `LocalFile`, `ArchivedFile`, `LCStoreDB`, `UploadStash`);
  - `SqliteInstaller::getLocalSettings` (L125–167);
  - `SetupDynamicConfig.php` L136–151;
  - `MainConfigSchema` (`MainStash` = `CACHE_DB`, `ReadOnlyFile`, `CookieSecure`);
  - `WebRequest::detectProtocol` (`X-Forwarded-Proto`);
  - `copyFileBackend.php` and `dumpBackup.php` options.
- [S39] Cargo 3.9.4: `includes/CargoUtils.php` `getDB()` (in the image); https://www.mediawiki.org/wiki/Extension:Cargo ("not been well-tested with SQLite and may not work"); https://www.mediawiki.org/wiki/Extension:Cargo/Download_and_installation (`$wgCargoDBfilePath`).
- [S40] https://www.mediawiki.org/wiki/Manual:SQLite (2026-07-18).
- [S41] https://www.mediawiki.org/wiki/Manual:Importing_XML_dumps.
- [S42] docker-library php docs, "Running as an arbitrary user" — https://github.com/docker-library/docs/blob/master/php/content.md (unprivileged port > 1024).
- [S43] https://httpd.apache.org/docs/2.4/stopping.html (WINCH = graceful-stop, `GracefulShutdownTimeout`).
- [S44] Local read-only checks (2026-10-06):
  - Debian 13.7 candidates `tini 0.19.0-3+b8`, `memcached 1.6.38-1`, `sqlite3 3.46.1-7+deb13u2`, `unzip`;
  - PHP 8.3.35 modules;
  - `rebuildLocalisationCache --no-database --lang=de,en` succeeds with `--network none`;
  - live counts in section 4;
  - `images/` 2.1 MB;
  - image 1.84 GB (containers report).
- [S45] Project files (as of 2026-10-06 07:5x, edited concurrently during this research):
  - `wiki/LocalSettings.php` (`LocalSettings.local.php` per-install slot, `WIKI_SECRET_KEY` required, `WIKI_DEBUG`);
  - `docker/mediawiki/Dockerfile`, `docker-compose.yml`;
  - `.dockerignore`, `.gitignore`, `.mcp.json` (no `WIKI_API` any more), `.env.example`;
  - `scripts/*`, `tools/forge-mcp/src/*`, `content/pages/Main/Third_Age.wiki:25`, `tools/gen-entities/entities.js:76`;
- [S46] Access policies / app paths (query strings unsupported), as cited by the access report.
- [S47] Zero Trust Free plan (50 users) and seat management, as cited by the access report.
- [S48] Durable Objects and Workers pricing, as cited by the containers report.
- [S49] Outbound traffic — https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- [S50] R2 FUSE example — https://developers.cloudflare.com/containers/examples/r2-fuse-mount/ (2026-10-02): FUSE "does not provide local-disk performance or full POSIX filesystem semantics".
- [S51] Snapshots — https://developers.cloudflare.com/containers/guides/snapshots/ (durable_object policy only, 30-day TTL). Rejected as the persistence layer.
- [S52] jose v6 — https://github.com/panva/jose (Workers supported).
- [S53] Workers Rate Limiting — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ (2026-04-23): config `ratelimits: [{ name, namespace_id, simple: { limit, period: 10 | 60 } }]`; `namespace_id` is a positive integer string, unique in the account (bindings that share it share counters); `limit({ key })` → `{ success }`; counters per Cloudflare location, "permissive, eventually consistent". Schema checked in wrangler 4.147.0 (`config-schema.json`).
- [S54] workerd 4.147 (local check, 2026-10-06): the runtime contains "Pbkdf2 failed: iteration counts above <max> are not supported"; PBKDF2-SHA256 with 100000 iterations ran in `wrangler dev` (about 35 ms per check).

[S16]–[S19], [S46], [S47] and [S52] describe Cloudflare Access and jose; they are kept for the record, but Access was dropped on 2026-10-06 (D18).

Research reports used: containers, sqlite-litestream, extensions-sqlite, r2-uploads, access, migration
(2026-10-06). Their findings are adopted where cited "(… report)". Load-bearing claims were rechecked
against [S1]–[S45].

### 9.2 UNVERIFIED (must be confirmed during implementation)

1. MediaWiki 1.46 with this extension set **running on SQLite end to end**: Cargo table creation, `cargoRecreateData`, Drilldown, update.php skipping Cargo's MySQL-only patches → staging (4.2).
2. The hand-built `$wgLocalFileRepo` with Extension:AWS (D2): uploads, thumbs, archive, delete, `copyFileBackend` into `AmazonS3`; R2 still accepting `x-amz-acl: private`; the dual autoloader (extension `vendor/` beside core `vendor/`).
3. ~~Worker-level Access sending `Cf-Access-Jwt-Assertion`~~ — obsolete (no Access, D18). New: the rate limiter's per-location counting in practice (5 per minute and IP is a brake, not an exact count) [S53].
4. Whether a draining container (host maintenance) counts toward `max_instances`, and whether a replacement can start meanwhile.
5. `image`/`image_build_context` path resolution relative to `cloud/wrangler.jsonc` for the default policy.
6. Cold-start duration for the ≈ 2 GB image + restore + Apache; whether the Worker → DO → container request may be held for 180 s without an edge timeout.
7. The container's view of the client source IP (`$wgCdnServersNoPurge` breadth).
8. Litestream: R2 Class A volume in practice; a full snapshot upload after every cold start (`checkDatabaseBehindReplica`, inferred); `tar` member name `litestream` at the archive root.
9. `ctx.container.running` updating promptly when the process exits (used by `drainAndStop`).
10. Apache as non-root in this image, beyond the documented port rule (prefork `User`/`Group` directives ignored with a warning).
11. CPU utilisation behind the cost table (assumed 10 %).
12. Bot Fight Mode's interaction with script requests (`X-Westernis-Token`).
13. ~~The Node fetch `redirect: 'manual'` behaviour with Access~~ — obsolete (no Access); the gate answers scripts with 401, never with a redirect.
