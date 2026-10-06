#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# wst-sync.sh — Litestream checks on the sync side (user wstsync, started by wst-start.sh via `wst-as sync`).
# Talks to the running `litestream replicate` through its control socket (socket: in /etc/litestream*.yml).
#
#   wst-sync.sh flush <timeout-seconds> [db...]
#       `litestream sync -wait` for each database (default: all three, main first): every committed
#       transaction is in the replica when this returns 0. Exit 1 when the MAIN database could not be synced;
#       a failure of the derived files (Cargo, cache) is only reported.
#   wst-sync.sh verify <min-rev-id>
#       Restores the main database from the replica into a private temp file and checks it: integrity,
#       at least one page, MAX(rev_id) >= <min-rev-id>. Proves that the generation can be restored.
set -eu

CFG="${WST_LITESTREAM_CONFIG:-/etc/litestream.yml}"
SOCK=/run/wst-sync/litestream.sock
DB=/var/lib/westernis/db
TMP=/var/lib/westernis/sync

log() { echo "[wst-sync] $*"; }
[ "$(id -u)" != 0 ] || { log "never run as root"; exit 64; }

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  flush)
    timeout="${1:-60}"
    [ $# -gt 0 ] && shift
    case "$timeout" in '' | *[!0-9]*) log "flush: timeout must be a number of seconds"; exit 64 ;; esac
    [ $# -gt 0 ] || set -- westernis westernis_cargo wikicache
    rc=0
    for d in "$@"; do
      if out="$(litestream sync -wait -json -socket "$SOCK" -timeout "$timeout" "$DB/$d.sqlite" 2>&1)"; then
        log "$d: synced $(printf '%s' "$out" | tr -d ' \n')"
      else
        log "$d: sync FAILED: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
        [ "$d" != westernis ] || rc=1
      fi
    done
    exit "$rc"
    ;;
  verify)
    min="${1:-0}"
    case "$min" in '' | *[!0-9]*) log "verify: min-rev-id must be a number"; exit 64 ;; esac
    out="$TMP/verify-$$.sqlite"
    rm -f "$out" "$out"-*
    trap 'rm -f "$out" "$out"-*' EXIT
    trap 'exit 1' INT TERM
    if ! litestream restore -config "$CFG" -integrity-check quick -o "$out" "$DB/westernis.sqlite"; then
      log "verify: the replica could not be restored"
      exit 1
    fi
    pages="$(sqlite3 "$out" 'SELECT COUNT(*) FROM page' 2>/dev/null || echo 0)"
    rev="$(sqlite3 "$out" 'SELECT COALESCE(MAX(rev_id), 0) FROM revision' 2>/dev/null || echo 0)"
    case "$pages$rev" in *[!0-9]*) pages=0 ;; esac
    if [ "$pages" -gt 0 ] && [ "$rev" -ge "$min" ]; then
      log "verify: replica restores ($pages pages, newest revision $rev)"
      exit 0
    fi
    log "verify: replica restores but is incomplete ($pages pages, newest revision $rev, expected >= $min)"
    exit 1
    ;;
  *)
    log "usage: wst-sync.sh flush <seconds> [db...] | verify <min-rev-id>"
    exit 64
    ;;
esac
