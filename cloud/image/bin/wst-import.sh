#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# wst-import.sh <stamp> — first boot only (docs/cloudflare-design.md, sections 2.6 and 4.5). Runs as wstsync
# (`wst-as sync`, it needs the DB-bucket token) and is started by wst-start.sh BEFORE Litestream: nothing it
# does reaches the replica, and a failure (or a stop request) leaves R2 untouched.
#
# Fetches the migration bundle import/<stamp>/ from the DB bucket and verifies it against manifest.json
# (sha256 and size of every file, page/revision counts, "frozen": true unless WST_ALLOW_UNFROZEN=1),
# runs PRAGMA integrity_check, extracts the uploads to /var/lib/westernis/import/media/{public,deleted}
# (wst-import-media.php copies them into the media bucket as www-data) and places the two SQLite files in
# /var/lib/westernis/db. Any failure exits non-zero; wst-start.sh then stops without replicating anything.
set -eu

STAMP="${1:?usage: wst-import.sh <stamp>}"
case "$STAMP" in '' | *[!A-Za-z0-9._-]*) echo "[wst-import] invalid stamp" >&2; exit 2 ;; esac
R2=/usr/local/bin/wst-r2.php
DB=/var/lib/westernis/db
IMP=/var/lib/westernis/import
B="$IMP/bundle"

log() { echo "[wst-import] $*"; }
fail() { log "FAILED: $*"; exit 1; }
[ "$(id -u)" != 0 ] || fail "never run as root"

rm -rf "${IMP:?}"/* "$IMP"/.[!.]* 2>/dev/null || true
mkdir -p "$B" "$IMP/media"

for f in manifest.json westernis.sqlite westernis_cargo.sqlite images.tar.gz; do
  php "$R2" get "import/$STAMP/$f" "$B/$f" || fail "could not fetch import/$STAMP/$f"
done

php "$R2" verify-manifest "$B" "$STAMP" || fail "bundle does not match its manifest.json"

# A dry-run bundle (Export-Bundle.ps1 without -Freeze) lacks every edit made after it was built.
frozen="$(php -r '$m = json_decode((string)file_get_contents($argv[1]), true);
  echo (is_array($m) && ($m["frozen"] ?? null) === true) ? "yes" : "no";' "$B/manifest.json")"
if [ "$frozen" != yes ]; then
  if [ "${WST_ALLOW_UNFROZEN:-0}" = 1 ]; then
    log "WARNING: bundle $STAMP is a dry run (frozen: false); imported only because WST_ALLOW_UNFROZEN=1"
  else
    fail "bundle $STAMP is a dry run (manifest.json \"frozen\" is not true). Import the frozen bundle, or set WST_ALLOW_UNFROZEN=1 for a staging test"
  fi
fi

for d in westernis westernis_cargo; do
  r="$(sqlite3 "$B/$d.sqlite" 'PRAGMA integrity_check;' 2>&1 || true)"
  [ "$r" = ok ] || fail "integrity_check of $d.sqlite: $(printf '%s' "$r" | head -n 3)"
done

# Only public/ and deleted/ (relative, no "..", no links) may come out of the archive.
bad="$(tar -tzf "$B/images.tar.gz" | grep -Ev '^(\./)?$|^(\./)?(public|deleted)(/.*)?$' || true)"
[ -z "$bad" ] || fail "unexpected entries in images.tar.gz: $(printf '%s' "$bad" | head -n 3 | tr '\n' ' ')"
if tar -tzf "$B/images.tar.gz" | grep -Eq '(^|/)\.\.(/|$)'; then fail "images.tar.gz contains '..'"; fi
if tar -tvzf "$B/images.tar.gz" | grep -q '^[lh]'; then fail "images.tar.gz contains links"; fi
tar -xzf "$B/images.tar.gz" -C "$IMP/media" --no-same-owner --no-same-permissions || fail "cannot extract images.tar.gz"
mkdir -p "$IMP/media/public" "$IMP/media/deleted"
log "uploads: $(find "$IMP/media/public" -type f | wc -l) public, $(find "$IMP/media/deleted" -type f | wc -l) deleted files"

for d in westernis westernis_cargo; do
  rm -f "$DB/$d.sqlite" "$DB/$d.sqlite-wal" "$DB/$d.sqlite-shm" "$DB/$d.sqlite-journal"
  mv "$B/$d.sqlite" "$DB/$d.sqlite"
done
rm -f "$B/images.tar.gz"
log "bundle $STAMP imported (pages: $(sqlite3 "$DB/westernis.sqlite" 'SELECT COUNT(*) FROM page'), newest revision: $(sqlite3 "$DB/westernis.sqlite" 'SELECT MAX(rev_id) FROM revision'))"
