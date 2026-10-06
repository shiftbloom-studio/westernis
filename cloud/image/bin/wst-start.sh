#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# wst-start.sh — the supervisor of the cloud image (docs/cloudflare-design.md, sections 1.3, 1.6 and 2.6).
# tini (PID 1) starts it as root; it is the only process that holds every secret. It never runs PHP, SQLite
# or Litestream itself: every step goes through wst-as, either to the sync side (user wstsync: Litestream,
# R2 markers, the bundle import; it alone gets the DB-bucket token) or to the wiki side (user www-data:
# memcached, update.php, jobs, Apache; it never gets the DB-bucket token).
#
# Start:
#   1. restore the three SQLite files of generation WST_DB_GENERATION from the replica (wstsync)
#   2. guards: never install an empty wiki, never read an R2 error as "absent", never import or restore over
#      an initialised generation; first start of a generation = import (WST_BOOTSTRAP) or restore
#      (WST_RESTORE_FROM), recorded as state/<gen>.pending.json
#   3. first start of an import: copy and verify the uploads (www-data), before anything is replicated
#   4. update.php when the image's schema id is new (www-data), BEFORE Litestream starts: a failed or
#      interrupted update never reaches the replica; the first attempt's time is kept in R2
#   5. `litestream replicate` (wstsync, no exec)
#   6. first start of a generation: confirm the first sync through the control socket and restore the
#      replica once as a test; only then write the marker state/<gen>.json
#   7. Cargo rebuild if needed, job loop, weekly dump, Apache on :8080 (www-data)
# Stop (SIGTERM or SIGINT, any number of times; only the first counts):
#   before step 5: end the running step and exit 0 (nothing was replicated, the replica is unchanged)
#   afterwards: Apache graceful stop, job loop ends after its batch, drain, memcached, then a confirmed flush
#   (`litestream sync -wait`) while Litestream still runs, then exactly ONE SIGTERM to Litestream, which
#   does its own final sync and exits. Everything is bounded: the container exits at most 11.5 minutes after
#   the first signal (the Durable Object waits 12 minutes, the platform kills after 15).
#
# Environment: WST_DB_GENERATION (required), WST_BOOTSTRAP ("import:<stamp>", first start only),
# WST_RESTORE_FROM ("<gen>" or "<gen>@<RFC3339>", into a NEW generation), WST_ALLOW_UNFROZEN (staging only),
# R2_ACCOUNT_ID, R2_DB_BUCKET, LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY, R2_MEDIA_*, WIKI_*;
# staging: WST_LITESTREAM_CONFIG=/etc/litestream.file.yml, WST_R2_LOCAL_DIR, WST_KEEP_LOCAL_DB.
#
# Exit codes (the container stops; the Worker shows "Westernis konnte nicht starten" for a failed start):
#    0 stopped cleanly (or before anything was replicated)
#    1 replication NOT confirmed: the final sync of the main database at the stop, or the first sync at the
#      start (the wiki then never served a request)
#    2 stopped after Apache or Litestream ended on their own (final sync confirmed)
#   64 configuration missing or invalid
#   70 generation already initialised (state/<gen>.json) but its replica is gone
#   71 WST_BOOTSTRAP refused: some generation is initialised, or this one has a database from another bundle
#   72 point-in-time restore failed, or WST_RESTORE_FROM is set while this generation already has a database
#   73 no replica, and neither WST_BOOTSTRAP nor WST_RESTORE_FROM is set
#   74 litestream restore failed (R2 unreachable, credentials, corrupt replica)
#   75 R2 error in wst-r2.php (an error is never read as "absent")
#   76 bundle import or upload copy failed (nothing was marked as initialised)
#   77 the replica of this generation has no state marker (state/<gen>.json or .pending.json)
#   78 update.php failed (the replica keeps the state before it)
set -u -o pipefail
umask 0007

CFG="${WST_LITESTREAM_CONFIG:-/etc/litestream.yml}"
BASE=/var/lib/westernis
DB="$BASE/db"
IMP="$BASE/import"
RUN=/run/westernis
STOPFILE="$RUN/stop"
SOCKDIR=/run/wst-sync
AS=/usr/local/bin/wst-as
R2=/usr/local/bin/wst-r2.php
SCHEMA_ID="$(cat /etc/wst-schema-id 2>/dev/null || echo unknown)"
STOP_BUDGET=690        # seconds from the first signal to the exit
FLUSH_UNTIL=540        # the confirmed flush may be retried until this many seconds after the first signal
FIRST_SYNC_WAIT=150    # first start of a generation: how long to try to confirm the first sync
UPDATE_ATTEMPTS=3      # update.php attempts per schema id before the start refuses (exit 78)

STOP_REQ=0
STOP_AT=0
PHASE=configure
EXIT_CODE=0
STEP_PID=""
LS_PID=""
MEMC_PID=""
HTTPD_PID=""
JOBS_PID=""
CARGO_PID=""
DUMP_PID=""
LS_STARTS=()
GEN=""
MODE=""
ORIGIN_KEY=""
ORIGIN_VAL=""
FIELD=""

log() { printf '[wst-start] %s\n' "$*"; }
now() { date +%s; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

request_stop() { # reason
  if [ "$STOP_REQ" = 0 ]; then
    STOP_REQ=1
    STOP_AT="$(now)"
    log "stop requested ($1) during $PHASE"
  else
    log "$1 ignored: the stop is already in progress"
  fi
  # A boot step is ended at once; none of them writes to the replica.
  if [ -n "$STEP_PID" ]; then kill -TERM -- "-$STEP_PID" 2>/dev/null || true; fi
}
trap 'request_stop SIGTERM' TERM
trap 'request_stop SIGINT' INT
trap '' HUP

# ---- process helpers -------------------------------------------------------------------------------------
# Every long-running child is started with setsid: its PID is also its process group, so a whole tree
# (php under a shell loop, Apache workers) can be signalled at once, and nothing but this script ever
# signals Litestream.

alive() { # pid: running and not a zombie
  local st
  [ -n "${1:-}" ] || return 1
  st="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  st="${st##*) }"
  st="${st%% *}"
  [ -n "$st" ] && [ "$st" != Z ]
}

await() { # pid seconds: wait until the process has ended and reap it; 1 = still running after <seconds>
  local pid="$1" until=$(($(now) + $2))
  while alive "$pid"; do
    [ "$(now)" -lt "$until" ] || return 1
    sleep 1
  done
  wait "$pid" 2>/dev/null
  return 0
}

# step COMMAND...: a boot step in its own process group; returns its exit code, 143 after a stop request.
step() {
  local pid rc
  [ "$STOP_REQ" = 0 ] || return 143
  setsid "$@" &
  pid=$!
  STEP_PID=$pid
  while :; do
    wait "$pid"
    rc=$?
    alive "$pid" || break
    if [ "$STOP_REQ" = 1 ]; then # interrupted by the stop signal; the trap sent SIGTERM to the group
      await "$pid" 20 || { kill -KILL -- "-$pid" 2>/dev/null; await "$pid" 5; }
      rc=143
      break
    fi
  done
  STEP_PID=""
  [ "$STOP_REQ" = 0 ] || rc=143
  return "$rc"
}

stop_group() { # pid seconds: SIGTERM to the process group, SIGKILL after <seconds>
  [ -n "${1:-}" ] || return 0
  kill -TERM -- "-$1" 2>/dev/null || true
  await "$1" "$2" || { kill -KILL -- "-$1" 2>/dev/null; await "$1" 5; }
}

# Before Litestream runs, a failure or a stop only has to end the local helpers.
teardown_early() {
  if [ -n "$STEP_PID" ]; then stop_group "$STEP_PID" 10; STEP_PID=""; fi
  if [ -n "$MEMC_PID" ]; then stop_group "$MEMC_PID" 5; MEMC_PID=""; fi
}
die() {
  local code="$1"
  shift
  log "FATAL: $*"
  teardown_early
  exit "$code"
}
early_stop() {
  log "stopped before replication started: the replica is unchanged, nothing to sync"
  teardown_early
  exit 0
}
check() { [ "$STOP_REQ" = 0 ] || early_stop; }

# ---- R2 (always as wstsync; wst-r2.php: 0 = yes, 1 = no, >= 2 = error) ---------------------------------
r2() { timeout 180 "$AS" sync php "$R2" "$@"; }
r2q() {
  local rc=0
  r2 "$@" || rc=$?
  [ "$rc" -le 1 ] || die 75 "R2 error (wst-r2.php $*: exit $rc)"
  return "$rc"
}
r2mark() { r2 put-json "$1" "$2" || die 75 "could not write $1"; }
# r2field key field: FIELD = one field of a small JSON object (state marker); 1 = object absent.
# Never call it inside $(...): its die must end this script, not a subshell.
r2field() {
  local body rc=0
  FIELD=""
  body="$(r2 cat "$1")" || rc=$?
  [ "$rc" -le 1 ] || die 75 "R2 error reading $1 (exit $rc)"
  [ "$rc" = 0 ] || return 1
  FIELD="$(printf '%s' "$body" | php -r '$d = json_decode(stream_get_contents(STDIN), true);
    $v = is_array($d) ? ($d[$argv[1]] ?? "") : ""; echo is_scalar($v) ? $v : "";' "$2")"
  return 0
}

# ---- children ------------------------------------------------------------------------------------------
start_memcached() {
  setsid "$AS" wiki memcached -l 127.0.0.1 -p 11211 -U 0 -m 64 -I 4m &
  MEMC_PID=$!
  local i
  for i in $(seq 1 50); do
    (exec 3<>/dev/tcp/127.0.0.1/11211) 2>/dev/null && return 0
    sleep 0.1
  done
  log "warning: memcached does not answer yet"
}
start_litestream() {
  rm -f "$SOCKDIR/litestream.sock"
  setsid "$AS" sync litestream replicate -config "$CFG" &
  LS_PID=$!
  LS_STARTS+=("$(now)")
  log "litestream replicate started"
}
start_apache() { setsid "$AS" wiki apache2-foreground & HTTPD_PID=$!; }
start_jobs() { setsid "$AS" wiki /usr/local/bin/wst-run.sh jobs & JOBS_PID=$!; }
start_cargo() { setsid "$AS" wiki /usr/local/bin/wst-run.sh cargo & CARGO_PID=$!; }
start_dump() { setsid /usr/local/bin/wst-dump.sh loop & DUMP_PID=$!; }

# Waits until Litestream's control socket answers and every committed transaction of the main database is
# in the replica. Retries until <deadline> (epoch seconds). 0 = confirmed.
flush_main() {
  local deadline="$1" left t
  while :; do
    alive "$LS_PID" || return 1
    left=$((deadline - $(now)))
    [ "$left" -gt 5 ] || return 1
    t=$((left < 120 ? left : 120))
    "$AS" sync /usr/local/bin/wst-sync.sh flush "$t" westernis && return 0
    [ $((deadline - $(now))) -gt 15 ] || return 1
    sleep 5
  done
}

# ---- the orderly stop (once Litestream has been started) ------------------------------------------------
stop_apache() {
  [ -n "$HTTPD_PID" ] || return 0
  if alive "$HTTPD_PID"; then
    # graceful-stop (SIGWINCH) is understood only by apache2 itself, not by apache2-foreground before its exec
    local i=0
    while [ "$(cat "/proc/$HTTPD_PID/comm" 2>/dev/null)" != apache2 ] && alive "$HTTPD_PID" && [ "$i" -lt 10 ]; do
      sleep 1
      i=$((i + 1))
    done
    if [ "$(cat "/proc/$HTTPD_PID/comm" 2>/dev/null)" = apache2 ]; then
      kill -WINCH "$HTTPD_PID" 2>/dev/null
      # GracefulShutdownTimeout 30 (apache-cloud.conf): in-flight saves and uploads finish
      await "$HTTPD_PID" 40 || { log "apache did not stop gracefully: SIGTERM"; kill -TERM "$HTTPD_PID" 2>/dev/null; await "$HTTPD_PID" 10; }
    fi
  fi
  stop_group "$HTTPD_PID" 5   # also ends leftover workers and the piped loggers
  HTTPD_PID=""
}

shutdown_all() {
  PHASE=stopping
  [ "$STOP_AT" -gt 0 ] || STOP_AT="$(now)"
  local t0="$STOP_AT" left flushed=0
  : >"$STOPFILE"
  log "stopping: apache, jobs, then the final sync"

  stop_apache
  if [ -n "$DUMP_PID" ]; then stop_group "$DUMP_PID" 10; DUMP_PID=""; fi
  # The job loop ends after its current batch (runJobs --maxtime 25); a claimed job is not interrupted.
  if [ -n "$JOBS_PID" ]; then
    await "$JOBS_PID" 60 || { log "job loop did not end in time: killing it"; stop_group "$JOBS_PID" 5; }
    JOBS_PID=""
  fi
  # An unfinished Cargo rebuild is redone on the next start (wst_meta flag), so it gets a bounded wait.
  if [ -n "$CARGO_PID" ]; then
    left=$((t0 + 240 - $(now)))
    [ "$left" -gt 0 ] || left=1
    if ! await "$CARGO_PID" "$left"; then log "Cargo rebuild unfinished: the next start redoes it"; stop_group "$CARGO_PID" 5; fi
    CARGO_PID=""
  fi
  if [ -n "$LS_PID" ]; then
    "$AS" wiki /usr/local/bin/wst-run.sh drain   # what is left in the queue, while Litestream still streams
  fi
  if [ -n "$MEMC_PID" ]; then stop_group "$MEMC_PID" 5; MEMC_PID=""; fi

  if [ -n "$LS_PID" ]; then
    if ! alive "$LS_PID"; then
      # Litestream died: a new one resumes from its local state and uploads what is missing.
      wait "$LS_PID" 2>/dev/null
      log "litestream is not running: starting it once more for the final sync"
      start_litestream
    fi
    if flush_main $((t0 + FLUSH_UNTIL)); then
      flushed=1
      "$AS" sync /usr/local/bin/wst-sync.sh flush 30 westernis_cargo wikicache || true
    fi
    log "SIGTERM to litestream (once)"
    kill -TERM "$LS_PID" 2>/dev/null
    left=$((t0 + STOP_BUDGET - $(now)))
    [ "$left" -gt 5 ] || left=5
    if ! await "$LS_PID" "$left"; then
      log "litestream did not finish within the stop budget: SIGKILL"
      kill -KILL -- "-$LS_PID" 2>/dev/null
      await "$LS_PID" 5
    fi
    if [ "$flushed" = 1 ]; then
      log "stopped cleanly: every change of the main database is in the replica"
    else
      log "FINAL SYNC NOT CONFIRMED: changes after the last successful sync may be missing from the replica"
      EXIT_CODE=1
    fi
  fi
  rm -f "$STOPFILE"
  exit "$EXIT_CODE"
}

# =========================================================================================================
# 0. configuration
# =========================================================================================================
[ "$(id -u)" = 0 ] || { log "FATAL: must start as root (it hands every step to wstsync or www-data)"; exit 64; }
GEN="${WST_DB_GENERATION:-}"
case "$GEN" in
  '' | *[!A-Za-z0-9_-]*) die 64 "WST_DB_GENERATION must be set (letters, digits, '-' and '_' only)" ;;
esac
[ -r "$CFG" ] || die 64 "litestream config $CFG not found"
[ -n "${WIKI_SECRET_KEY:-}" ] || die 64 "WIKI_SECRET_KEY is not set"
if grep -Eq '^[^#]*type:[[:space:]]*s3' "$CFG"; then # R2 replicas: the keys must be there
  for v in R2_ACCOUNT_ID R2_DB_BUCKET LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || die 64 "$v is not set"
  done
  case "$R2_ACCOUNT_ID" in *[!A-Za-z0-9-]*) die 64 "R2_ACCOUNT_ID is not a valid account ID" ;; esac
else
  case "${WST_R2_LOCAL_DIR:-}" in
    /?*) ;;
    *) die 64 "$CFG has no R2 replicas: set WST_R2_LOCAL_DIR to an absolute directory (staging)" ;;
  esac
fi
if [ -n "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}" ]; then
  die 64 "AWS_* credentials are set; they would override LITESTREAM_* (use LITESTREAM_ACCESS_KEY_ID/_SECRET_ACCESS_KEY)"
fi

# Directories: the database and the import are shared (setgid group www-data, umask 0007 on both sides,
# so -wal/-shm stay writable for both); the sync side's work dir, the dump dir and the socket dir are not.
# A root step never writes into a directory that www-data can write.
mkdir -p "$DB" "$IMP" "$BASE/sync" "$BASE/dump" "$RUN" "$SOCKDIR" || die 64 "cannot create the state directories"
chown root:root "$BASE" "$RUN" && chmod 0755 "$BASE" "$RUN" \
  && chown wstsync:www-data "$DB" "$IMP" && chmod 2770 "$DB" "$IMP" \
  && chown wstsync:wstsync "$BASE/sync" "$SOCKDIR" && chmod 0700 "$BASE/sync" "$SOCKDIR" \
  && chown root:wstsync "$BASE/dump" && chmod 0750 "$BASE/dump" \
  || die 64 "cannot set up the state directories"
# Cloudflare Containers start with an empty /run (tmpfs), unlike Docker, which keeps the image's /run:
# recreate Apache's runtime directories as the php:apache image lays them out (www-data cannot create them).
install -d -m 1777 /run/lock \
  && install -d -o www-data -g www-data -m 1777 /run/apache2 /run/lock/apache2 \
  || die 64 "cannot create the Apache runtime directories"
rm -f "$STOPFILE" "$SOCKDIR/litestream.sock"
rm -rf "${BASE:?}/dump/"run.* 2>/dev/null
find "$IMP" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
# Staging: the file replicas and the local stand-in for the bucket belong to the sync side.
if [ -d "$BASE/replica" ]; then chown -R wstsync:wstsync "$BASE/replica"; chmod 0700 "$BASE/replica"; fi
if [ -n "${WST_R2_LOCAL_DIR:-}" ]; then
  case "$WST_R2_LOCAL_DIR" in /) die 64 "WST_R2_LOCAL_DIR must not be /" ;; esac
  mkdir -p "$WST_R2_LOCAL_DIR" && chown -R wstsync:wstsync "$WST_R2_LOCAL_DIR" && chmod 0700 "$WST_R2_LOCAL_DIR" \
    || die 64 "cannot prepare WST_R2_LOCAL_DIR"
fi
# Every start restores from the replica, as on Cloudflare (the disk is always empty there). Leftovers of a
# previous run on the same disk (docker restart) are moved aside, never deleted.
if [ -n "$(ls -A "$DB" 2>/dev/null)" ]; then
  if [ "${WST_KEEP_LOCAL_DB:-0}" = 1 ]; then
    log "WST_KEEP_LOCAL_DB=1: keeping the local database files"
  else
    rm -rf "$BASE/db.prev" && mkdir -p "$BASE/db.prev" && chmod 0700 "$BASE/db.prev" \
      && find "$DB" -mindepth 1 -maxdepth 1 -exec mv -t "$BASE/db.prev" {} + \
      || die 64 "cannot move the old local database files aside"
    log "moved the local database files of a previous run to $BASE/db.prev (restore from the replica instead)"
  fi
fi
"$AS" sync true && "$AS" wiki true || die 64 "cannot switch to wstsync / www-data (setpriv)"

log "generation $GEN, config $CFG, schema $SCHEMA_ID, $(litestream version 2>/dev/null || echo 'litestream ?')"
check

# =========================================================================================================
# 1. restore this generation from its replica (only data, never an error, makes a database appear)
# =========================================================================================================
PHASE=restore
restore() { # db
  step "$AS" sync litestream restore -config "$CFG" -if-db-not-exists -if-replica-exists -integrity-check quick "$DB/$1.sqlite"
}
restore westernis || { check; die 74 "restore of westernis.sqlite failed"; }
restore westernis_cargo || { check; die 74 "restore of westernis_cargo.sqlite failed"; }
if ! restore wikicache; then
  check
  log "wikicache restore failed: starting with an empty cache (sessions and VisualEditor stashes are lost)"
  rm -f "$DB"/wikicache.sqlite* && rm -rf "$DB"/.wikicache.sqlite-litestream
fi
check

# =========================================================================================================
# 2. guards: what is this start?
# =========================================================================================================
PHASE=guards
leftover_vars() { # marker key: WST_BOOTSTRAP / WST_RESTORE_FROM must not ask for anything else than happened
  local was
  if [ -n "${WST_BOOTSTRAP:-}" ]; then
    r2field "$1" importedFrom || true
    was="$FIELD"
    if [ -n "$was" ] && [ "import:$was" = "$WST_BOOTSTRAP" ]; then
      log "note: WST_BOOTSTRAP is left over from the first start of $GEN and is ignored; clear it"
    else
      die 71 "WST_BOOTSTRAP=$WST_BOOTSTRAP, but generation $GEN already has a database${was:+ (imported from $was)}; nothing was imported. Clear WST_BOOTSTRAP"
    fi
  fi
  if [ -n "${WST_RESTORE_FROM:-}" ]; then
    r2field "$1" restoredFrom || true
    was="$FIELD"
    if [ -n "$was" ] && [ "$was" = "$WST_RESTORE_FROM" ]; then
      log "note: WST_RESTORE_FROM is left over from the first start of $GEN and is ignored; clear it"
    else
      die 72 "WST_RESTORE_FROM=$WST_RESTORE_FROM, but generation $GEN already has a database; nothing was restored. A restore needs a NEW WST_DB_GENERATION"
    fi
  fi
}

if [ -s "$DB/westernis.sqlite" ]; then
  if r2q exists "state/$GEN.json"; then
    MODE=normal
    leftover_vars "state/$GEN.json"
  elif r2q exists "state/$GEN.pending.json"; then
    # The first start of this generation replicated, but stopped before the marker was confirmed.
    MODE=resume
    leftover_vars "state/$GEN.pending.json"
    r2field "state/$GEN.pending.json" importedFrom || true
    if [ -n "$FIELD" ]; then
      ORIGIN_KEY=importedFrom
    else
      ORIGIN_KEY=restoredFrom
      r2field "state/$GEN.pending.json" restoredFrom || true
    fi
    ORIGIN_VAL="$FIELD"
    case "$ORIGIN_VAL" in *[!A-Za-z0-9._:@+-]*) ORIGIN_VAL="" ;; esac
    log "resuming the first start of generation $GEN ($ORIGIN_KEY ${ORIGIN_VAL:-?}): confirming the replica"
  else
    die 77 "generation $GEN has a replica but no state marker (state/$GEN.json); it was not created by a supervised first start (a dry run?). Use a new WST_DB_GENERATION with WST_RESTORE_FROM or WST_BOOTSTRAP"
  fi
else
  # No main database: whatever else is local belongs to nothing. Start clean.
  find "$DB" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  if r2q exists "state/$GEN.json"; then
    die 70 "generation $GEN was initialised but its replica is gone; restore into a new generation (WST_DB_GENERATION + WST_RESTORE_FROM)"
  fi
  if [ -n "${WST_RESTORE_FROM:-}" ]; then
    FROM="${WST_RESTORE_FROM%%@*}"
    TS=""
    case "$WST_RESTORE_FROM" in *@*) TS="${WST_RESTORE_FROM#*@}" ;; esac
    case "$FROM" in '' | *[!A-Za-z0-9_-]*) die 64 "WST_RESTORE_FROM must be <gen> or <gen>@<RFC3339>" ;; esac
    case "$TS" in *[!0-9A-Za-z:.+-]*) die 64 "WST_RESTORE_FROM timestamp must be RFC 3339, e.g. 2026-11-02T10:00:00Z" ;; esac
    [ "$FROM" != "$GEN" ] || die 64 "WST_RESTORE_FROM must name an older generation than WST_DB_GENERATION ($GEN)"
    [ -z "${WST_BOOTSTRAP:-}" ] || die 64 "set either WST_RESTORE_FROM or WST_BOOTSTRAP, not both"
    PHASE=restore-from
    log "point-in-time restore: generation $FROM${TS:+ at $TS} -> new generation $GEN"
    for d in westernis westernis_cargo wikicache; do
      if WST_DB_GENERATION="$FROM" step "$AS" sync litestream restore -config "$CFG" -integrity-check quick \
        ${TS:+-timestamp "$TS"} "$DB/$d.sqlite"; then
        :
      else
        check
        if [ "$d" = wikicache ]; then
          log "wikicache not restored from $FROM: starting with an empty cache"
          rm -f "$DB"/wikicache.sqlite*
        else
          die 72 "restore of $d.sqlite from generation $FROM failed"
        fi
      fi
    done
    [ -s "$DB/westernis.sqlite" ] || die 72 "nothing restored from $WST_RESTORE_FROM"
    MODE=restored
    ORIGIN_KEY=restoredFrom
    ORIGIN_VAL="$WST_RESTORE_FROM"
  else
    case "${WST_BOOTSTRAP:-}" in
      import:*)
        STAMP="${WST_BOOTSTRAP#import:}"
        case "$STAMP" in '' | *[!A-Za-z0-9._-]*) die 64 "WST_BOOTSTRAP must be import:<stamp>" ;; esac
        keys="$(r2 list state/)" || die 75 "R2 error while listing state/"
        if printf '%s\n' "$keys" | grep -Eq '^state/[A-Za-z0-9_-]+\.json$'; then
          die 71 "the wiki was already initialised ($(printf '%s\n' "$keys" | grep -E '^state/[A-Za-z0-9_-]+\.json$' | head -n 3 | tr '\n' ' ')); use WST_RESTORE_FROM instead of WST_BOOTSTRAP"
        fi
        PHASE=import
        log "first start: importing the migration bundle import/$STAMP/"
        step "$AS" sync /usr/local/bin/wst-import.sh "$STAMP" || { check; die 76 "import of bundle $STAMP failed (nothing was marked; the next start tries again)"; }
        MODE=imported
        ORIGIN_KEY=importedFrom
        ORIGIN_VAL="$STAMP"
        ;;
      *)
        hint=""
        if r2q exists "state/$GEN.pending.json"; then hint=" (an earlier first start of $GEN did not finish: set the same WST_BOOTSTRAP or WST_RESTORE_FROM again)"; fi
        die 73 "no replica for generation $GEN and neither WST_BOOTSTRAP nor WST_RESTORE_FROM is set$hint"
        ;;
    esac
  fi
fi
check
# Restored and imported files: group www-data, group-writable (root; only our own helpers run yet).
find "$DB" -maxdepth 1 -type f -exec chgrp www-data {} + -exec chmod g+rw {} +

# =========================================================================================================
# 3. wiki-side preparation (nothing of it is replicated yet)
# =========================================================================================================
PHASE=prepare
start_memcached
check

if [ "$MODE" = imported ]; then
  PHASE=media
  ok=0
  for attempt in 1 2 3; do
    if step "$AS" wiki php maintenance/run.php /usr/local/bin/wst-import-media.php --dir "$IMP/media" --memory-limit=768M; then
      ok=1
      break
    fi
    check
    [ "$attempt" = 3 ] || { log "upload copy failed (attempt $attempt of 3): retrying in $((attempt * 20)) s"; step sleep $((attempt * 20)); check; }
  done
  [ "$ok" = 1 ] || die 76 "the uploads of bundle $ORIGIN_VAL could not be copied and verified (see above); nothing was marked, the next start imports again"
  find "$IMP" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  log "uploads copied and verified"
fi

for d in westernis_cargo wikicache; do
  if [ ! -s "$DB/$d.sqlite" ]; then
    rm -f "$DB/$d.sqlite"*
    step "$AS" wiki sqlite3 "$DB/$d.sqlite" 'PRAGMA journal_mode=WAL;' >/dev/null || { check; die 64 "cannot create $d.sqlite"; }
    # SQLite creates files 0644 whatever the umask; the sync side (group www-data) must be able to write too.
    # Its -wal/-shm files inherit the main file's mode, so fixing the main file is enough.
    rm -f "$DB/$d.sqlite-wal" "$DB/$d.sqlite-shm"
    step "$AS" wiki chmod 0660 "$DB/$d.sqlite" || { check; die 64 "cannot chmod $d.sqlite"; }
  fi
done
check

PHASE=update
need="$("$AS" wiki /usr/local/bin/wst-run.sh schema-needed)" || need=yes
if [ "$need" = yes ]; then
  REC="state/$GEN.update-$SCHEMA_ID.json"
  FAILREC="state/$GEN.update-$SCHEMA_ID.failed.json"
  r2field "$FAILREC" attempts || true
  attempts="$FIELD"
  case "$attempts" in '' | *[!0-9]*) attempts=0 ;; esac
  if [ "$attempts" -ge "$UPDATE_ATTEMPTS" ]; then
    r2field "$REC" before || true
    before="$FIELD"
    die 78 "update.php failed $attempts times for schema $SCHEMA_ID; the replica of $GEN still holds the state before it${before:+ (first attempt at $before)}. Fix the image and delete $FAILREC, or restore into a new generation"
  fi
  # The first attempt's time is kept: it is the point-in-time target before any schema change.
  r2q exists "$REC" || r2mark "$REC" "{\"generation\":\"$GEN\",\"schema\":\"$SCHEMA_ID\",\"before\":\"$(stamp)\"}"
  log "update.php for schema $SCHEMA_ID (the replica keeps the state before it until it succeeds)"
  if ! step "$AS" wiki /usr/local/bin/wst-run.sh update; then
    check
    attempts=$((attempts + 1))
    r2mark "$FAILREC" "{\"generation\":\"$GEN\",\"schema\":\"$SCHEMA_ID\",\"attempts\":$attempts,\"at\":\"$(stamp)\"}"
    die 78 "update.php failed (attempt $attempts of $UPDATE_ATTEMPTS); nothing was replicated"
  fi
fi
check

# =========================================================================================================
# 4. replication. From here on a stop request always goes through shutdown_all (final sync).
# =========================================================================================================
if [ "$MODE" = imported ] || [ "$MODE" = restored ]; then
  r2mark "state/$GEN.pending.json" "{\"generation\":\"$GEN\",\"$ORIGIN_KEY\":\"$ORIGIN_VAL\",\"at\":\"$(stamp)\",\"schema\":\"$SCHEMA_ID\"}"
fi
check
PHASE=replicating
start_litestream

# No edit is accepted before replication is shown to work: the first sync (on a normal start the snapshot of
# the restored state plus any update.php change) must be confirmed by Litestream. On the first start of a
# generation the replica is also restored once as a test, and only then is state/<gen>.json written.
PHASE=first-sync
minrev="$("$AS" wiki sqlite3 -cmd '.timeout 30000' "$DB/westernis.sqlite" 'SELECT COALESCE(MAX(rev_id), 0) FROM revision')" || minrev=0
case "$minrev" in '' | *[!0-9]*) minrev=0 ;; esac
deadline=$(($(now) + FIRST_SYNC_WAIT))
confirmed=0
while [ "$STOP_REQ" = 0 ] && [ "$(now)" -lt "$deadline" ] && alive "$LS_PID"; do
  if step "$AS" sync /usr/local/bin/wst-sync.sh flush 60 westernis; then
    if [ "$MODE" = normal ] || step "$AS" sync /usr/local/bin/wst-sync.sh verify "$minrev"; then
      confirmed=1
      break
    fi
  fi
  [ "$STOP_REQ" = 0 ] && step sleep 5
done
[ "$STOP_REQ" = 0 ] || shutdown_all
if [ "$confirmed" != 1 ]; then
  log "replication to the replica could not be confirmed within ${FIRST_SYNC_WAIT}s: the wiki does not start"
  # Nothing but update.php changes exist locally, and the next start redoes them: short stop budget.
  FLUSH_UNTIL=60
  STOP_BUDGET=150
  EXIT_CODE=1
  request_stop "replication not confirmed"
  shutdown_all
fi
if [ "$MODE" != normal ]; then
  if r2 put-json "state/$GEN.json" "{\"generation\":\"$GEN\",\"$ORIGIN_KEY\":\"$ORIGIN_VAL\",\"at\":\"$(stamp)\",\"schema\":\"$SCHEMA_ID\",\"verifiedRev\":$minrev}"; then
    log "generation $GEN initialised: state/$GEN.json written"
  else
    log "WARNING: could not write state/$GEN.json; the next start confirms the replica again"
  fi
fi

# =========================================================================================================
# 5. the wiki
# =========================================================================================================
PHASE=starting
start_cargo
start_jobs
start_dump
start_apache
PHASE=running
log "ready (generation $GEN, schema $SCHEMA_ID)"

while [ "$STOP_REQ" = 0 ]; do
  pids=()
  for p in "$LS_PID" "$HTTPD_PID" "$JOBS_PID" "$CARGO_PID" "$DUMP_PID" "$MEMC_PID"; do [ -z "$p" ] || pids+=("$p"); done
  [ "${#pids[@]}" -gt 0 ] || { EXIT_CODE=2; request_stop "no child process left"; break; }
  WHO=""
  wait -n -p WHO "${pids[@]}"
  rc=$?
  [ "$STOP_REQ" = 0 ] || break
  [ -n "$WHO" ] || continue
  case "$WHO" in
    "$LS_PID")
      LS_PID=""
      cutoff=$(($(now) - 600))
      recent=0
      for t in "${LS_STARTS[@]}"; do [ "$t" -lt "$cutoff" ] || recent=$((recent + 1)); done
      if [ "$recent" -lt 4 ]; then
        log "litestream exited unexpectedly (status $rc): restarting it"
        sleep 2
        start_litestream
      else
        log "litestream keeps exiting (status $rc): stopping the wiki"
        EXIT_CODE=2
        request_stop "litestream keeps exiting"
      fi
      ;;
    "$HTTPD_PID")
      HTTPD_PID=""
      log "apache exited on its own (status $rc): stopping"
      EXIT_CODE=2
      request_stop "apache exited"
      ;;
    "$JOBS_PID")
      JOBS_PID=""
      log "job loop exited (status $rc): restarting it"
      sleep 5
      start_jobs
      ;;
    "$CARGO_PID")
      CARGO_PID=""
      [ "$rc" = 0 ] || log "Cargo rebuild ended with status $rc"
      ;;
    "$DUMP_PID")
      DUMP_PID=""
      log "dump loop exited (status $rc): restarting it"
      start_dump
      ;;
    "$MEMC_PID")
      MEMC_PID=""
      log "memcached exited (status $rc): restarting it"
      start_memcached
      ;;
  esac
done
shutdown_all
