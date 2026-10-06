#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
# Runs INSIDE the wiki container (idempotent, safe to re-run):
#   1. creates the database schema from LocalSettings.php (baked into the image)
#   2. runs update.php (extension tables: Cargo, Echo-less setup, etc.)
#   3. creates the admin account + the Forge bot password (for the MCP server)
#   4. imports seed content from /content (templates, modules, pages, files)
set -eu
cd /var/www/html
MW="php maintenance/run.php"
UPDLOG=$(mktemp)
BOTLOG=$(mktemp)

echo "==> waiting for database"
i=0
until php -r 'new mysqli(getenv("WIKI_DB_HOST") ?: "db", getenv("MARIADB_USER"), getenv("MARIADB_PASSWORD"), getenv("MARIADB_DATABASE"));' >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then echo "database not reachable" >&2; exit 1; fi
  sleep 2
done

if $MW sql --query "SELECT 1 FROM page LIMIT 1" >/dev/null 2>&1; then
  echo "==> schema already present"
else
  echo "==> installing database schema (installPreConfigured)"
  $MW installPreConfigured
fi

echo "==> running update.php"
$MW update --quick --skip-external-dependencies >"$UPDLOG" 2>&1 || { tail -30 "$UPDLOG"; exit 1; }
tail -3 "$UPDLOG"

ADMIN="${WIKI_ADMIN_USER:-Admin}"
if $MW sql --query "SELECT user_id FROM user WHERE user_name = '$ADMIN' LIMIT 1" 2>/dev/null | grep -qE '^[0-9]+$|user_id'; then
  echo "==> admin user $ADMIN exists"
else
  echo "==> creating admin user $ADMIN"
  $MW createAndPromote --sysop --bureaucrat --interface-admin --force "$ADMIN" "$WIKI_ADMIN_PASSWORD"
fi

echo "==> (re)creating bot password $ADMIN@${WIKI_BOT_APPID:-Forge} from .env"
GRANTS="basic,highvolume,editpage,createeditmovepage,uploadfile,uploadeditmovefile,patrol,rollback,delete,protect,editinterface,editsiteconfig,editmycssjs,viewdeleted,viewmywatchlist,editmywatchlist,viewrestrictedlogs,createaccount,cargo"
$MW sql --query "DELETE FROM bot_passwords WHERE bp_app_id = '${WIKI_BOT_APPID:-Forge}'" >/dev/null 2>&1 || true
if ! $MW createBotPassword --appid "${WIKI_BOT_APPID:-Forge}" --grants "$GRANTS" "$ADMIN" "$WIKI_BOT_PASSWORD" >"$BOTLOG" 2>&1; then
  cat "$BOTLOG"
fi

if [ -d /content/pages ]; then
  echo "==> importing seed content"
  sh /scripts/wiki-seed.sh
fi

echo "==> refreshing caches"
$MW rebuildLocalisationCache --force >/dev/null 2>&1 || true
$MW runJobs --maxjobs 1000 >/dev/null 2>&1 || true
# If this ever runs as root, hand the uploads back to Apache's user.
if [ "$(id -u)" = "0" ]; then
  chown -R www-data:www-data /var/www/html/images /var/www/html/cache 2>/dev/null || true
fi
echo "==> bootstrap complete"
