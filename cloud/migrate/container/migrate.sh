#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
#
# migrate.sh — entrypoint of the migration container (docs/cloudflare-design.md, sections 2.9 and 4).
# Export-Bundle.ps1 starts it as www-data in the cloud image, on the legacy stack's network:
#
#   docker run --rm --init --network westernis_default --env-file .env \
#     -e WST_DB=sqlite -e WST_MEDIA=local -e WST_SQLITE_DIR=/out/db -e WST_STAMP=<stamp> \
#     -v westernis_wiki_images:/src-images:ro -v westernis_migrate:/out \
#     --entrypoint /opt/westernis/migrate/migrate.sh westernis/mediawiki-cloud:<stamp>
#
# It reads the legacy wiki (MariaDB "db", read-only; uploads mounted read-only) and builds
#   /out/bundle/  westernis.sqlite  westernis_cargo.sqlite  images.tar.gz  manifest.json
#   /out/reports/ source/target counts, copy report, checks, steps.log (MediaWiki output), diffs on failure
#
# Steps: 1 source counts + content fingerprints + media staging, 2 installPreConfigured + update.php,
# 3 table copy, 4 rebuild derived data (as scripts/wiki-seed.sh does), 5 target counts + strict comparison
# (counts, pages, archived revisions with their text, collation, German category order, cl_timestamp),
# 6 render every page on both sides and compare (render.php: link sets, properties, HTML, Cargo rows),
# 7 XML equality, 8 integrity + single-file databases, 9 images.tar.gz, 10 manifest.json.
# Any count/content mismatch, render "fail", XML difference, failed integrity check or missing file stops the
# run (exit 1) before manifest.json exists. Render findings of the "review" class (the two parses differ,
# Cargo rows differ) do not stop it: they are recorded in manifest.json (checks.render), and
# Upload-Bundle.ps1 refuses such a bundle unless the owner accepts them (-AcceptReview).
# WST_FROZEN=1 (Export-Bundle.ps1 -Freeze) becomes manifest.json "frozen": true, which wst-import.sh requires.
# Secrets stay in the environment: nothing here prints them.
set -eu
umask 027

OUT=/out
DB="${WST_SQLITE_DIR:-}"
SRC=/src-images
STAMP="${WST_STAMP:-}"
HERE=/opt/westernis/migrate
BUNDLE="$OUT/bundle"
REPORTS="$OUT/reports"
WORK="$OUT/work"
LOG="$REPORTS/steps.log"
MEMC=""
# Every MediaWiki run goes through the guard: read-only on MariaDB, SQLite-only for the target.
export MW_CONFIG_FILE="$HERE/MigrationSettings.php"

log() { printf '[migrate] %s\n' "$*"; }
die() { printf '[migrate] FATAL: %s\n' "$*" >&2; exit 1; }
stop_memcached() {
  if [ -n "$MEMC" ]; then kill "$MEMC" 2>/dev/null || true; wait "$MEMC" 2>/dev/null || true; MEMC=""; fi
}
start_memcached() {
  memcached -l 127.0.0.1 -p 11211 -U 0 -m 64 -I 4m >>"$LOG" 2>&1 &
  MEMC=$!
}
trap stop_memcached EXIT
trap 'die "interrupted"' INT TERM

mw() { php maintenance/run.php "$@"; }                     # target: SQLite (WST_DB=sqlite from docker run)
mw_src() { WST_DB=mysql php maintenance/run.php "$@"; }    # source: MariaDB, read-only (MigrationSettings.php)
php_src() { WST_DB=mysql php "$@"; }

# run <label> <command...>: MediaWiki output goes to the step log; on failure show its tail and stop.
run() {
  label="$1"; shift
  log "$label"
  printf '\n===== %s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" >>"$LOG"
  if ! "$@" >>"$LOG" 2>&1; then
    tail -n 40 "$LOG" >&2
    die "$label failed (full output: reports/steps.log)"
  fi
}

# json <file> <dotted.path>: print a scalar from a JSON file (empty when absent)
json() {
  php -r '$d = json_decode((string)file_get_contents($argv[1]), true);
    foreach (explode(".", $argv[2]) as $k) { $d = is_array($d) ? ($d[$k] ?? null) : null; }
    echo is_scalar($d) ? (is_bool($d) ? ($d ? "true" : "false") : $d) : "";' "$1" "$2"
}
# json_keys <file> <dotted.path>: print the keys of a JSON object, one per line
json_keys() {
  php -r '$d = json_decode((string)file_get_contents($argv[1]), true);
    foreach (explode(".", $argv[2]) as $k) { $d = is_array($d) ? ($d[$k] ?? null) : null; }
    foreach (is_array($d) ? array_keys($d) : [] as $k) { echo $k, "\n"; }' "$1" "$2"
}
sha256() { sha256sum "$1" | cut -d' ' -f1; }
bytes() { stat -c %s "$1"; }

# ---- preflight --------------------------------------------------------------------------------------------
[ "$(id -u)" != 0 ] || die "run as www-data (the image's user), never as root"
case "$STAMP" in ''|*[!A-Za-z0-9._-]*) die "WST_STAMP is missing or contains other characters than A-Z a-z 0-9 . _ -" ;; esac
[ "${WST_DB:-}" = sqlite ] || die "WST_DB must be sqlite (the target; the source is read with WST_DB=mysql per command)"
[ "${WST_MEDIA:-}" = local ] || die "WST_MEDIA must be local: the export never writes to R2"
case "${WST_FROZEN:-0}" in 0|1) ;; *) die "WST_FROZEN must be 0 or 1" ;; esac
[ "$DB" = "$OUT/db" ] || die "WST_SQLITE_DIR must be $OUT/db"
[ -d "$SRC" ] || die "$SRC is not mounted (-v westernis_wiki_images:/src-images:ro)"
[ ! -w "$SRC" ] || die "$SRC must be mounted read-only (:ro)"
[ -d "$OUT" ] && [ -w "$OUT" ] || die "$OUT is not a writable volume"
[ -z "$(ls -A "$OUT")" ] || die "$OUT is not empty: every run starts with a fresh volume (Export-Bundle.ps1)"
for f in MigrationSettings.php CopyMysqlToSqlite.php counts.php render.php manifest.php; do
  [ -r "$HERE/$f" ] || die "missing $HERE/$f"
done
for c in php memcached sqlite3 tar gzip sha256sum cmp diff find; do
  command -v "$c" >/dev/null 2>&1 || die "missing tool in the image: $c"
done
mkdir -p "$BUNDLE" "$REPORTS" "$WORK"
: >"$LOG"
cd /var/www/html
# One parser clock for both sides (step 6)
RENDER_TS=$(date -u +%Y%m%d%H%M%S)
log "bundle $STAMP (frozen: ${WST_FROZEN:-0}); MediaWiki output goes to reports/steps.log"

# ---- 1. source counts, content fingerprints and media staging -----------------------------------------
start_memcached
run "1/10 source counts and content fingerprints (MariaDB, read-only)" php_src "$HERE/counts.php" --out "$REPORTS/source-counts.json"
SRC_PAGES=$(json "$REPORTS/source-counts.json" tables.page)
SRC_MAX_LOG=$(json "$REPORTS/source-counts.json" max.log_id)
[ -n "$SRC_PAGES" ] && [ "$SRC_PAGES" -gt 0 ] || die "the source has no pages: wrong database?"
[ -n "$SRC_MAX_LOG" ] || SRC_MAX_LOG=0
log "    source: $SRC_PAGES pages, $(json "$REPORTS/source-counts.json" tables.revision) revisions, newest log entry $SRC_MAX_LOG"

log "    staging uploads: public/ = images/ without thumb temp lockdir deleted lock_* .htaccess README; deleted/ = images/deleted/"
mkdir -p "$WORK/media/public" "$WORK/media/deleted"
# "-exec … +" makes find fail when cp fails (an unreadable file must stop the export)
find "$SRC" -mindepth 1 -maxdepth 1 \
  ! -name thumb ! -name temp ! -name lockdir ! -name deleted ! -name 'lock_*' ! -name .htaccess ! -name README \
  -exec cp -R --preserve=mode,timestamps -t "$WORK/media/public/" {} + || die "cannot read the uploads in $SRC"
if [ -d "$SRC/deleted" ]; then
  cp -R --preserve=mode,timestamps "$SRC/deleted/." "$WORK/media/deleted/" || die "cannot read $SRC/deleted"
fi
find "$WORK/media" -type f \( -name .htaccess -o -name README \) -delete
# wst-import.sh refuses archives with links; find them here, with a useful message
LINKS=$(find "$WORK/media" -type l | head -n 5)
[ -z "$LINKS" ] || die "the uploads contain symbolic links (not allowed in images.tar.gz): $LINKS"
# The SQLite side parses pages with the real files present (thumbnails, PageImages), as the legacy wiki does.
cp -R "$WORK/media/public/." /var/www/html/images/ || die "cannot copy the uploads into /var/www/html/images"

# ---- 2. fresh SQLite schema with the image's extension set ----------------------------------------------
run "2/10 installPreConfigured (SQLite in $DB)" mw installPreConfigured
run "    update.php" mw update --quick --skip-external-dependencies
SCHEMA_ID=""
if [ -r /etc/wst-schema-id ]; then
  SCHEMA_ID="wst-schema-$(cat /etc/wst-schema-id)"
  case "$SCHEMA_ID" in *[!A-Za-z0-9_-]*) die "unexpected /etc/wst-schema-id" ;; esac
  # Same image => same schema: wst-run.sh then skips update.php on the first cloud boot.
  sqlite3 -cmd '.timeout 30000' "$DB/westernis.sqlite" "INSERT OR IGNORE INTO updatelog (ul_key) VALUES ('$SCHEMA_ID');"
  log "    recorded $SCHEMA_ID in updatelog"
else
  log "    WARNING: /etc/wst-schema-id is missing; the first cloud boot will run update.php"
fi

# ---- 3. table copy --------------------------------------------------------------------------------------
run "3/10 copy MariaDB -> SQLite (explicit IDs, read-only source snapshot)" php "$HERE/CopyMysqlToSqlite.php" --out "$REPORTS/copy-report.json"
# The message cache in memcached still describes the installer's pages: start from an empty cache.
stop_memcached
start_memcached

# ---- 4. derived data, as scripts/wiki-seed.sh rebuilds it -----------------------------------------------
# Cargo tables: those the legacy wiki declares (cargo_tables) plus those the seed templates declare.
CARGO_TABLES=$( { json_keys "$REPORTS/source-counts.json" cargo.tables
  grep -ho 'cargo_declare:_table=[A-Za-z0-9_]*' /content/pages/Template/*.wiki 2>/dev/null | sed 's/.*=//'; } | sort -u )
run "4/10 Cargo: create the declared tables" mw Cargo:cargoRecreateData --create-missing-tables-only --quiet
for t in $CARGO_TABLES; do
  case "$t" in *[!A-Za-z0-9_]*) die "unexpected Cargo table name: $t" ;; esac
  run "    Cargo: recreate data of $t" mw Cargo:cargoRecreateData --table "$t" --quiet
done
run "    refreshLinks" mw refreshLinks
run "    rebuildtextindex" mw rebuildtextindex
run "    updateCollation --force" mw updateCollation --force
run "    initSiteStats --update" mw initSiteStats --update
run "    updateSpecialPages" mw updateSpecialPages
run "    runJobs" mw runJobs
# Links that depend on other pages' links or categories (DPL4 lists, Cargo queries over pages refreshed later
# in the first pass) settle in a second pass; it only rewrites pages whose parse changed.
run "    refreshLinks (second pass)" mw refreshLinks
run "    runJobs" mw runJobs

# ---- 5. counts and content: target vs source -----------------------------------------------------------
run "5/10 target counts and content fingerprints (SQLite)" php "$HERE/counts.php" --out "$REPORTS/target-counts.json"
run "    compare counts and content" php "$HERE/counts.php" --compare \
  --source "$REPORTS/source-counts.json" --target "$REPORTS/target-counts.json" --out "$REPORTS/count-check.json"

# ---- 6. rendering: every page parsed on both sides with the same code, settings and files ----------------
# The fixed parser time keeps {{CURRENT…}}/#time equal; every page is parsed twice per side, so pages with
# non-deterministic HTML (random IDs) are recognised and only their link sets are compared.
run "6/10 render every page on MariaDB (read-only, $RENDER_TS)" php_src "$HERE/render.php" \
  --out "$REPORTS/render-source.json" --timestamp "$RENDER_TS" --repeat 2
run "    render every page on SQLite" php "$HERE/render.php" \
  --out "$REPORTS/render-target.json" --timestamp "$RENDER_TS" --repeat 2
run "    compare the renders (fail stops here; review goes into the manifest)" php "$HERE/render.php" --compare \
  --source-render "$REPORTS/render-source.json" --target-render "$REPORTS/render-target.json" \
  --source-counts "$REPORTS/source-counts.json" --target-counts "$REPORTS/target-counts.json" \
  --frozen "${WST_FROZEN:-0}" --out "$REPORTS/render-check.json"
REVIEW=$(php -r '$d = json_decode((string)file_get_contents($argv[1]), true); echo count($d["review"] ?? []);' "$REPORTS/render-check.json")
STALE=$(json "$REPORTS/render-check.json" stats.staleInSource)
if [ "$REVIEW" != 0 ]; then
  log "    REVIEW: $REVIEW finding(s) to look at (reports/render-check.json); the bundle is written, upload needs -AcceptReview"
  grep '^REVIEW ' "$LOG" | tail -n 10 | sed 's/^/      /'
else
  log "    renders agree on every compared page"
fi
[ "${STALE:-0}" = 0 ] || log "    note: $STALE page(s) had stale link tables in the legacy wiki (rebuilt fresh on SQLite)"

# ---- 7. XML equality (IDs are preserved, so the dumps must be byte-identical) ----------------------------
END=$((SRC_MAX_LOG + 1))
# dump <file> <mysql|sqlite> <dumpBackup options...>
dump() {
  file="$1"; side="$2"; shift 2
  printf '\n===== %s  dumpBackup (%s) %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$side" "$*" >>"$LOG"
  if ! WST_DB="$side" php maintenance/run.php dumpBackup "$@" --skip-header --skip-footer --quiet >"$file" 2>>"$LOG"; then
    tail -n 40 "$LOG" >&2
    die "dumpBackup ($side $*) failed"
  fi
}
# xmlcmp <name> <source file> <target file>: "true" or "false"; a diff excerpt lands in reports/
xmlcmp() {
  if cmp -s "$2" "$3"; then echo true; else diff -u "$2" "$3" | head -n 400 >"$REPORTS/xml-$1.diff" || true; echo false; fi
}
log "7/10 XML dumps: all revisions and log entries < $END, MariaDB vs SQLite (siteinfo and root tag skipped)"
dump "$WORK/pages.mysql.xml" mysql --full
dump "$WORK/pages.sqlite.xml" sqlite --full
dump "$WORK/logs.mysql.xml" mysql --logs --end "$END"
dump "$WORK/logs.sqlite.xml" sqlite --logs --end "$END"
DUMPED_PAGES=$(grep -c '<page>' "$WORK/pages.mysql.xml" || true)
[ "$DUMPED_PAGES" = "$SRC_PAGES" ] || die "the MariaDB dump holds $DUMPED_PAGES pages, the source counts say $SRC_PAGES"
PAGES_OK=$(xmlcmp pages "$WORK/pages.mysql.xml" "$WORK/pages.sqlite.xml")
LOGS_OK=$(xmlcmp logs "$WORK/logs.mysql.xml" "$WORK/logs.sqlite.xml")
printf '{\n  "pages": { "identical": %s, "pages": %s, "bytes": %s, "sha256": "%s" },\n  "logs": { "identical": %s, "endId": %s, "bytes": %s, "sha256": "%s" }\n}\n' \
  "$PAGES_OK" "$DUMPED_PAGES" "$(bytes "$WORK/pages.sqlite.xml")" "$(sha256 "$WORK/pages.sqlite.xml")" \
  "$LOGS_OK" "$END" "$(bytes "$WORK/logs.sqlite.xml")" "$(sha256 "$WORK/logs.sqlite.xml")" >"$REPORTS/xml-check.json"
[ "$PAGES_OK" = true ] || die "the XML dumps of all revisions differ (excerpt: reports/xml-pages.diff)"
[ "$LOGS_OK" = true ] || die "the XML dumps of the log entries differ (excerpt: reports/xml-logs.diff)"
log "    identical: $DUMPED_PAGES pages with every revision, log entries 1..$SRC_MAX_LOG"

# ---- 8. integrity, then one self-contained file per database ---------------------------------------------
stop_memcached
log "8/10 integrity_check, wal_checkpoint(TRUNCATE), VACUUM, journal_mode=DELETE"
for f in westernis westernis_cargo; do
  db="$DB/$f.sqlite"
  [ -s "$db" ] || die "$db is missing"
  r=$(sqlite3 -cmd '.timeout 30000' "$db" 'PRAGMA integrity_check;')
  [ "$r" = ok ] || { printf '%s\n' "$r" | head -n 20 >&2; die "integrity_check failed for $f.sqlite"; }
  sqlite3 -cmd '.timeout 30000' "$db" 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA journal_mode=DELETE;' >>"$LOG" 2>&1 \
    || die "checkpoint/VACUUM failed for $f.sqlite"
  [ "$(sqlite3 "$db" 'PRAGMA journal_mode;')" = delete ] || die "$f.sqlite is not in rollback-journal mode"
  [ ! -e "$db-wal" ] && [ ! -e "$db-shm" ] || die "$f.sqlite still has -wal/-shm files"
  [ "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = ok ] || die "integrity_check failed for $f.sqlite after VACUUM"
  mv "$db" "$BUNDLE/$f.sqlite"
done
for t in page revision; do
  n=$(sqlite3 "$BUNDLE/westernis.sqlite" "SELECT COUNT(*) FROM $t;")
  [ "$n" = "$(json "$REPORTS/target-counts.json" "tables.$t")" ] || die "$t: $n rows in the final file, target counts say otherwise"
done
printf '{ "westernis.sqlite": "ok", "westernis_cargo.sqlite": "ok" }\n' >"$REPORTS/integrity.json"

# ---- 9. uploads archive -----------------------------------------------------------------------------------
log "9/10 images.tar.gz (public/, deleted/)"
tar -C "$WORK/media" --sort=name --owner=0 --group=0 --numeric-owner -czf "$BUNDLE/images.tar.gz" public deleted
# The checks in step 10 run against the archive's content, not against the staging copy.
mkdir "$WORK/tarcheck"
tar -C "$WORK/tarcheck" -xzf "$BUNDLE/images.tar.gz"

# ---- 10. manifest ----------------------------------------------------------------------------------------
run "10/10 manifest.json (sha256, counts, checks, media SHA-1 check)" php "$HERE/manifest.php" \
  --bundle "$BUNDLE" --reports "$REPORTS" --media "$WORK/tarcheck" --stamp "$STAMP" \
  --frozen "${WST_FROZEN:-0}" --image="${WST_IMAGE:-}" --image-id="${WST_IMAGE_ID:-}" --schema-id="$SCHEMA_ID"
grep '^\[manifest\]' "$LOG" | tail -n 5
[ -s "$BUNDLE/manifest.json" ] || die "manifest.json was not written"

rm -rf "$WORK"
log "done: bundle $STAMP = $(cd "$BUNDLE" && ls | tr '\n' ' ')"
