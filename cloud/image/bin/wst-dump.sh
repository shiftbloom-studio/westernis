#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# wst-dump.sh loop|once — weekly, Litestream-independent backup (docs/cloudflare-design.md, sections 2.6, 4.8).
# Started by the root supervisor wst-start.sh (loop: first check 10 minutes after the start, then every 6 h).
# When dumps/latest is older than 7 days (or missing), the wiki side (www-data, no bucket token) writes a
# full XML dump, and the sync side (wstsync, DB-bucket token) uploads it to dumps/YYYY-MM-DD.xml.gz and then
# refreshes dumps/latest. The bucket's lifecycle rule removes dumps after 180 days. Restore with importDump.php.
#
# This script runs as root but never touches a directory www-data can write: the dump file lives in
# /var/lib/westernis/dump (root:wstsync 0750), www-data only writes into the file descriptor it is given.
set -u -o pipefail

AS=/usr/local/bin/wst-as
R2=/usr/local/bin/wst-r2.php
WORK=/var/lib/westernis/dump
MAXAGE=$((7 * 86400))
log() { echo "[wst-dump] $*"; }
[ "$(id -u)" = 0 ] || { log "must run as root (it hands each step to wst-as)"; exit 64; }

once() {
  if [ -z "${WST_R2_LOCAL_DIR:-}" ] && { [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${LITESTREAM_ACCESS_KEY_ID:-}" ]; }; then
    log "skipped: no R2 configuration (staging?)"
    return 0
  fi
  local rc=0 age
  age="$("$AS" sync php "$R2" age dumps/latest)" || rc=$?
  case "$rc" in
    0) [ "$age" -lt "$MAXAGE" ] && return 0 ;;
    1) ;;
    *) log "R2 error while reading dumps/latest (exit $rc)"; return 1 ;;
  esac

  local day tmp bytes sha
  day="$(date -u +%Y-%m-%d)"
  tmp="$(mktemp -d "$WORK/run.XXXXXX")" || return 1
  chgrp wstsync "$tmp" && chmod 0750 "$tmp" || { rm -rf "$tmp"; return 1; }
  log "writing dumps/$day.xml.gz"
  if ! "$AS" wiki php maintenance/run.php dumpBackup --full --quiet --memory-limit=768M >"$tmp/dump.xml"; then
    log "dumpBackup failed"; rm -rf "$tmp"; return 1
  fi
  if ! tail -c 64 "$tmp/dump.xml" | grep -q '</mediawiki>'; then
    log "dump is incomplete"; rm -rf "$tmp"; return 1
  fi
  gzip -9 "$tmp/dump.xml" && chgrp wstsync "$tmp/dump.xml.gz" && chmod 0640 "$tmp/dump.xml.gz" || { rm -rf "$tmp"; return 1; }
  bytes="$(stat -c %s "$tmp/dump.xml.gz")"
  sha="$(sha256sum "$tmp/dump.xml.gz" | cut -d' ' -f1)"
  if "$AS" sync php "$R2" put "dumps/$day.xml.gz" "$tmp/dump.xml.gz" application/gzip \
    && "$AS" sync php "$R2" put-json dumps/latest \
      "{\"key\":\"dumps/$day.xml.gz\",\"bytes\":$bytes,\"sha256\":\"$sha\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"; then
    log "dumps/$day.xml.gz uploaded ($bytes bytes)"
    rc=0
  else
    log "upload of dumps/$day.xml.gz failed"
    rc=1
  fi
  rm -rf "$tmp"
  return "$rc"
}

case "${1:-once}" in
  once) once ;;
  loop)
    # The supervisor ends this loop (and a dump in progress) by signalling its process group.
    sleep 600
    while :; do
      once || log "weekly dump failed (retried in 6 h)"
      sleep 21600
    done
    ;;
  *) log "usage: wst-dump.sh loop|once"; exit 64 ;;
esac
