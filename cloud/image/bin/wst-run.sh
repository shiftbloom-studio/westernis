#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# wst-run.sh — the wiki side of the cloud image (user www-data, started by wst-start.sh via `wst-as wiki`),
# docs/cloudflare-design.md sections 1.3 and 2.6. This process never holds the DB-bucket token.
#
#   wst-run.sh schema-needed   print "yes" when update.php has not run for this image's schema id, else "no"
#   wst-run.sh update          update.php (bounded memory), then record the schema id in updatelog
#   wst-run.sh cargo           rebuild the Cargo data tables when westernis_cargo.sqlite is empty or a
#                              previous rebuild did not finish (flag table wst_meta in that file)
#   wst-run.sh jobs            job loop; ends after the current batch once /run/westernis/stop exists
#   wst-run.sh drain           one bounded runJobs pass (shutdown, Apache already stopped)
#
# Every maintenance call gets --memory-limit: MediaWiki 1.46 runs maintenance scripts without a limit by
# default, and an OOM kill takes the whole container down without a final Litestream sync.
set -u
cd /var/www/html || exit 1

MW=(php maintenance/run.php)
DBDIR="${WST_SQLITE_DIR:-/var/lib/westernis/db}"
DB="$DBDIR/westernis.sqlite"
CARGO_DB="$DBDIR/westernis_cargo.sqlite"
STOP=/run/westernis/stop
SCHEMA="wst-schema-$(cat /etc/wst-schema-id)"

log() { echo "[wst-run] $*"; }
[ "$(id -u)" != 0 ] || { log "never run as root"; exit 64; }
sq() { sqlite3 -cmd '.timeout 30000' "$@"; }

case "${1:-}" in
  schema-needed)
    # An unreadable updatelog counts as "needed": update.php is idempotent, a skipped schema change is not.
    if [ -n "$(sq "$DB" "SELECT 1 FROM updatelog WHERE ul_key='$SCHEMA'" 2>/dev/null)" ]; then echo no; else echo yes; fi
    ;;

  update)
    log "update.php for $SCHEMA"
    "${MW[@]}" update --quick --skip-external-dependencies --memory-limit=1G || exit 1
    sq "$DB" "INSERT OR IGNORE INTO updatelog(ul_key) VALUES('$SCHEMA')" || exit 1
    log "update.php done"
    ;;

  cargo)
    tables="$(sq "$CARGO_DB" "SELECT COUNT(*) FROM sqlite_master WHERE name <> 'wst_meta'" 2>/dev/null)" \
      || { log "cannot read $CARGO_DB"; exit 1; }
    state="$(sq "$CARGO_DB" "SELECT v FROM wst_meta WHERE k='rebuild'" 2>/dev/null || true)"
    if [ "$tables" != 0 ] && [ "$state" != running ]; then
      exit 0   # filled (by the migration bundle or an earlier complete rebuild)
    fi
    if [ "$state" = running ]; then why="a previous rebuild did not finish"; else why="westernis_cargo.sqlite is empty"; fi
    log "rebuilding the Cargo data tables ($why)"
    sq "$CARGO_DB" "CREATE TABLE IF NOT EXISTS wst_meta(k TEXT PRIMARY KEY, v TEXT); INSERT OR REPLACE INTO wst_meta VALUES('rebuild','running')" || exit 1
    rc=0
    "${MW[@]}" Cargo:cargoRecreateData --create-missing-tables-only --memory-limit=768M >/tmp/wst-cargo.log 2>&1 || rc=1
    for t in $(grep -ho 'cargo_declare:_table=[A-Za-z0-9_]*' /content/pages/Template/*.wiki | sed 's/.*=//' | sort -u); do
      "${MW[@]}" Cargo:cargoRecreateData --table "$t" --memory-limit=768M >>/tmp/wst-cargo.log 2>&1 || { log "Cargo table $t FAILED"; rc=1; }
    done
    if [ "$rc" = 0 ]; then
      sq "$CARGO_DB" "INSERT OR REPLACE INTO wst_meta VALUES('rebuild','done')"
      log "Cargo tables rebuilt"
    else
      log "Cargo rebuild incomplete (see /tmp/wst-cargo.log); the next start tries again"
    fi
    exit "$rc"
    ;;

  jobs)
    # A claimed job is never interrupted: the loop checks the stop flag only between batches.
    while [ ! -e "$STOP" ]; do
      "${MW[@]}" runJobs --maxjobs 100 --maxtime 25 --wait --memory-limit=768M >/dev/null 2>&1 || sleep 10
      [ -e "$STOP" ] || sleep 2
    done
    ;;

  drain)
    timeout 75 "${MW[@]}" runJobs --maxtime 60 --memory-limit=768M >/dev/null 2>&1 || true
    ;;

  *)
    log "usage: wst-run.sh schema-needed|update|cargo|jobs|drain"
    exit 64
    ;;
esac
