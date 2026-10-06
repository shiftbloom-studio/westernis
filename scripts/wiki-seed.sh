#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
# Imports /content/** into the wiki (idempotent; re-run after editing seed files).
#
# Layout:
#   content/pages/<Namespace>/<Title>.wiki   -> page "Namespace:Title"   ("__" in the file name becomes "/")
#   content/pages/Main/<Title>.wiki          -> page "Title" in the main namespace
#   content/pages/MediaWiki/Common.css       -> page "MediaWiki:Common.css" (extension kept for css/js/json/lua)
#   content/pages/Module/<Name>.lua          -> page "Module:Name"
#   content/files/**                         -> uploaded as File:<basename>
#
# Namespaces are imported in dependency order (modules and templates before articles),
# then Cargo tables are (re)created from the templates' #cargo_declare calls.
set -eu
cd /var/www/html
MW="php maintenance/run.php"
EDITOR_USER="${WIKI_ADMIN_USER:-Admin}"
ORDER="Module Template Form MediaWiki Category Help Project Map Main Chronicle Notes File User"
count=0
EDITLOG=$(mktemp)
FAILLOG=$(mktemp)
: > "$FAILLOG"

import_dir() {
  ns="$1"; dir="$2"
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    ext="${base##*.}"
    stem="${base%.*}"
    stem=$(printf '%s' "$stem" | sed 's#__#/#g')
    case "$ext" in
      wiki|lua)         title="$stem" ;;                       # Module:Name (content model is Lua anyway)
      json)             case "$ns" in MediaWiki|User) title="$stem.$ext" ;; *) title="$stem" ;; esac ;;   # Map:Name vs MediaWiki:Foo.json
      css|js)           title="$stem.$ext" ;;                  # MediaWiki:Common.css, User:X/common.js
      *)                continue ;;
    esac
    case "$ns" in
      Main) full="$title" ;;
      *)    full="$ns:$title" ;;
    esac
    printf '   %s\n' "$full"
    if $MW edit --user "$EDITOR_USER" --summary "Grundbestand eingespielt" --bot --no-rc "$full" < "$f" >"$EDITLOG" 2>&1; then
      count=$((count+1))
    else
      failed=$((failed+1))
      printf '   !! FAILED: %s\n' "$full" >> "$FAILLOG"
      grep -vE '^\s*$' "$EDITLOG" | tail -3 | sed 's/^/      /' >> "$FAILLOG"
    fi
  done
}
failed=0

if [ -d /content/files ] && [ -n "$(ls -A /content/files 2>/dev/null)" ]; then
  # Existing file names are skipped (idempotent). SEED_FORCE_FILES=1 re-uploads changed artwork.
  OVERWRITE=""
  [ "${SEED_FORCE_FILES:-0}" = "1" ] && OVERWRITE="--overwrite"
  echo "   uploading files from /content/files${OVERWRITE:+ (overwriting)}"
  $MW importImages --user "$EDITOR_USER" --comment "Seed asset" --skip-dupes ${OVERWRITE:+--overwrite} --search-recursively /content/files 2>&1 | tail -2 || true
fi

for ns in $ORDER; do
  [ -d "/content/pages/$ns" ] && import_dir "$ns" "/content/pages/$ns"
done
# any other namespace directories not listed above
for nsdir in /content/pages/*; do
  [ -d "$nsdir" ] || continue
  ns=$(basename "$nsdir")
  case " $ORDER " in *" $ns "*) ;; *) import_dir "$ns" "$nsdir" ;; esac
done

echo "   $count pages imported, $failed failed"
if [ -s "$FAILLOG" ]; then cat "$FAILLOG"; fi

echo "   creating Cargo tables"
$MW Cargo:cargoRecreateData --create-missing-tables-only >/dev/null 2>&1 || true
for t in $(grep -ho 'cargo_declare:_table=[A-Za-z0-9_]*' /content/pages/Template/*.wiki 2>/dev/null | sed 's/.*=//' | sort -u); do
  printf '   table %s\n' "$t"
  $MW Cargo:cargoRecreateData --table "$t" >/dev/null 2>&1 || true
done

echo "   rebuilding the message cache (MediaWiki: pages such as the sidebar)"
$MW rebuildmessages >/dev/null 2>&1 || true
echo "   refreshing link tables, parser cache and running jobs"
$MW refreshLinks --quiet >/dev/null 2>&1 || true
$MW purgeParserCache --age 1 >/dev/null 2>&1 || true
$MW runJobs --maxjobs 5000 >/dev/null 2>&1 || true
$MW rebuildLocalisationCache --force --lang=de,en >/dev/null 2>&1 || true
rm -rf /var/www/html/cache/* 2>/dev/null || true
# If this ever runs as root, hand the uploads back to Apache's user.
if [ "$(id -u)" = "0" ]; then
  chown -R www-data:www-data /var/www/html/images /var/www/html/cache 2>/dev/null || true
fi
echo "   seed complete"
[ "$failed" -eq 0 ] || exit 1
