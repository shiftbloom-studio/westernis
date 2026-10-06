# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
# Westernis cloud image for Cloudflare Containers (linux/amd64), docs/cloudflare-design.md section 2.4.
# The same MediaWiki, skin and extensions as docker/mediawiki/Dockerfile, plus SQLite + Litestream (R2),
# Extension:AWS (uploads in R2), memcached and the boot scripts. Build context = repo root:
#   docker build -f cloud/image/Dockerfile -t westernis/mediawiki-cloud:<stamp> .
FROM mediawiki:1.46.0

# ---- 1. Skin + extensions: the RUN blocks and pins of docker/mediawiki/Dockerfile, VERBATIM -------------
#      Identical versions are required so the table copy of the migration maps 1:1. Change both files together.

# Extensions without release tags are pinned to commits (verified on MediaWiki 1.46, 2026-10-05).
ARG PORTABLEINFOBOX_SHA=60c09a75d023eac1da3a63945d0a4a9678fc86db
ARG SHORTDESCRIPTION_SHA=8d348a84a2e337b777525daeea2ff01707785171
ARG DATAMAPS_SHA=e95f4251d5e3074d9ba42e03bc6b37e712296dcc

# PDF thumbnails (PdfHandler), pygments runtime (SyntaxHighlight), diff3 for edit-conflict merging
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        poppler-utils ghostscript python3 diffutils; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/html

# --- Skin -------------------------------------------------------------------
RUN set -eux; \
    git clone -q --depth 1 --branch v3.24.0 https://github.com/StarCitizenTools/mediawiki-skins-Citizen skins/Citizen; \
    rm -rf skins/Citizen/.git

# --- Structured data & forms -------------------------------------------------
RUN set -eux; \
    git clone -q --depth 1 --branch 3.9.4  https://github.com/wikimedia/mediawiki-extensions-Cargo     extensions/Cargo; \
    git clone -q --depth 1 --branch 6.0.11 https://github.com/wikimedia/mediawiki-extensions-PageForms extensions/PageForms; \
    git init -q extensions/PortableInfobox; \
    git -C extensions/PortableInfobox fetch -q --depth 1 https://github.com/Universal-Omega/PortableInfobox "$PORTABLEINFOBOX_SHA"; \
    git -C extensions/PortableInfobox checkout -q FETCH_HEAD; \
    git clone -q --depth 1 --branch 4.0.6  https://github.com/Universal-Omega/DynamicPageList4          extensions/DynamicPageList4; \
    git clone -q --depth 1 --branch 4.1.0  https://github.com/wikimedia/mediawiki-extensions-DisplayTitle extensions/DisplayTitle; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-LabeledSectionTransclusion extensions/LabeledSectionTransclusion; \
    rm -rf extensions/*/.git

# --- Reading experience (Citizen companions) ---------------------------------
RUN set -eux; \
    git clone -q --depth 1 --branch v4.1.0  https://github.com/StarCitizenTools/mediawiki-extensions-TabberNeue       extensions/TabberNeue; \
    git init -q extensions/ShortDescription; \
    git -C extensions/ShortDescription fetch -q --depth 1 https://github.com/StarCitizenTools/mediawiki-extensions-ShortDescription "$SHORTDESCRIPTION_SHA"; \
    git -C extensions/ShortDescription checkout -q FETCH_HEAD; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-Popups                extensions/Popups; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-RelatedArticles       extensions/RelatedArticles; \
    git clone -q --depth 1 --branch 3.3.0   https://github.com/wikimedia/mediawiki-extensions-Lingo                 extensions/Lingo; \
    rm -rf extensions/*/.git

# --- Maps, graphs ------------------------------------------------------------
RUN set -eux; \
    git init -q extensions/DataMaps; \
    git -C extensions/DataMaps fetch -q --depth 1 https://github.com/alex4401/mediawiki-extensions-DataMaps "$DATAMAPS_SHA"; \
    git -C extensions/DataMaps checkout -q FETCH_HEAD; \
    git clone -q --depth 1 --branch 6.0.2   https://github.com/SemanticMediaWiki/Mermaid                  extensions/Mermaid; \
    git clone -q --depth 1 --branch 4.1.0   https://github.com/ProfessionalWiki/Network                   extensions/Network; \
    rm -rf extensions/*/.git

# --- Editing & uploads -------------------------------------------------------
RUN set -eux; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-CodeMirror  extensions/CodeMirror; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-CharInsert  extensions/CharInsert; \
    git clone -q --depth 1 --branch REL1_46 https://github.com/wikimedia/mediawiki-extensions-MsUpload    extensions/MsUpload; \
    git clone -q --depth 1 --branch 3.1.0   https://github.com/ProfessionalWiki/SimpleBatchUpload         extensions/SimpleBatchUpload; \
    rm -rf extensions/*/.git

# The extension.json check of docker/mediawiki/Dockerfile
RUN set -eux; \
    for e in Cargo PageForms PortableInfobox DynamicPageList4 DisplayTitle LabeledSectionTransclusion TabberNeue ShortDescription Popups RelatedArticles Lingo DataMaps Mermaid Network CodeMirror CharInsert MsUpload SimpleBatchUpload; do \
        test -f "extensions/$e/extension.json" || { echo "MISSING extension.json for $e" >&2; exit 1; }; \
    done; \
    test -f skins/Citizen/skin.json

# ---- 2. Cloud runtime packages (Debian 13: tini 0.19.0, memcached 1.6.38, sqlite3 3.46.1; unzip for composer;
#      setpriv/setsid from util-linux, already in the base image) and the sync-side user.
#      wstsync runs Litestream and every R2 call with the DB-bucket token; it is in group www-data only to
#      share /var/lib/westernis/db (setgid, umask 0007). www-data (PHP, Apache) never gets that token.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini memcached sqlite3 unzip; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/bin/tini; command -v memcached; command -v sqlite3; command -v setpriv; command -v setsid; \
    groupadd --system wstsync; \
    useradd --system --gid wstsync --groups www-data --home-dir /var/lib/westernis/sync --no-create-home \
        --shell /usr/sbin/nologin wstsync; \
    id wstsync | grep -q '(www-data)'; \
    setpriv --reuid=wstsync --regid=wstsync --init-groups --no-new-privs -- /usr/bin/env -i /usr/bin/id -u

# ---- 3. Litestream v0.5.17 (2026-08-31). sha256 = the release's checksums.txt entry and GitHub's asset digest.
#      The build also asserts that the CLI flags the boot scripts rely on still parse (Go's flag package answers
#      "flag provided but not defined" otherwise), so a version bump cannot silently drop them. No network:
#      an empty config (/dev/null) and a missing socket make the commands stop right after parsing their flags.
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
RUN set -eux; \
    cd /tmp; \
    f="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; \
    curl -fsSLO "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$f"; \
    echo "${LITESTREAM_SHA256}  $f" | sha256sum -c -; \
    tar -xzf "$f" -C /usr/local/bin litestream; \
    rm -f "$f"; \
    chown root:root /usr/local/bin/litestream; chmod 0755 /usr/local/bin/litestream; \
    litestream version | grep -qF "${LITESTREAM_VERSION}"; \
    out="$(timeout 20 litestream restore -config /dev/null -if-db-not-exists -if-replica-exists \
        -integrity-check quick -timestamp 2000-01-01T00:00:00Z -o /tmp/wst-flag-out.sqlite /tmp/wst-flag-check.sqlite 2>&1 || true)"; \
    if echo "$out" | grep -qiE 'not defined|invalid -integrity-check|invalid -timestamp'; then echo "$out" >&2; exit 1; fi; \
    out="$(timeout 20 litestream sync -wait -json -socket /tmp/wst-no-such.sock -timeout 1 /tmp/wst-flag-check.sqlite 2>&1 || true)"; \
    if echo "$out" | grep -qi 'not defined'; then echo "$out" >&2; exit 1; fi; \
    echo "$out" | grep -qi 'control socket'; \
    out="$(timeout 20 litestream replicate -config /dev/null 2>&1 || true)"; \
    if echo "$out" | grep -qi 'not defined'; then echo "$out" >&2; exit 1; fi; \
    rm -f /tmp/wst-flag-check.sqlite /tmp/wst-flag-out.sqlite

# ---- 4. Extension:AWS, pinned master ("Added support for MediaWiki 1.46", 2026-09-17).
#      Its own vendor/ (the extension falls back to it), so core's vendor/ stays untouched. Every package that
#      core's vendor/ already ships (Guzzle, PSR-7, ...) is declared "replace"d, so only the AWS SDK and what
#      core lacks are installed: one copy of each class, no second Guzzle behind a second autoloader.
ARG AWS_EXT_SHA=b79432133e076b3c1771834576b8d574f2432b0b
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
RUN set -eux; \
    git init -q extensions/AWS; \
    git -C extensions/AWS fetch -q --depth 1 https://github.com/edwardspec/mediawiki-aws-s3 "$AWS_EXT_SHA"; \
    git -C extensions/AWS checkout -q FETCH_HEAD; \
    rm -rf extensions/AWS/.git; \
    php -r '$core = json_decode(file_get_contents("vendor/composer/installed.json"), true); \
        $replace = []; foreach ($core["packages"] ?? $core as $p) { $replace[$p["name"]] = $p["version"]; } \
        $file = "extensions/AWS/composer.json"; $ext = json_decode(file_get_contents($file), true); \
        $ext["replace"] = $replace + ($ext["replace"] ?? []); \
        file_put_contents($file, json_encode($ext, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");'; \
    COMPOSER_ALLOW_SUPERUSER=1 composer install -d extensions/AWS --no-dev --no-interaction --no-progress --optimize-autoloader; \
    rm /usr/local/bin/composer; \
    test -f extensions/AWS/extension.json; \
    test ! -e extensions/AWS/vendor/guzzlehttp; \
    php -r 'require "vendor/autoload.php"; require "extensions/AWS/vendor/autoload.php"; \
        $c = new Aws\S3\S3Client(["version" => "2006-03-01", "region" => "auto", "endpoint" => "https://example.invalid", \
            "use_path_style_endpoint" => true, "credentials" => ["key" => "k", "secret" => "s"]]); \
        $u = (string)$c->createPresignedRequest($c->getCommand("GetObject", ["Bucket" => "b", "Key" => "k"]), "+5 minutes")->getUri(); \
        exit(str_starts_with($u, "https://example.invalid/b/k?") ? 0 : 1);'

# ---- 4b. Extension:Auth_remoteuser 3.0.0, branch REL1_46 pinned to 729e8a2815d21be2d691f0fa5a0ca4049b45e416
#      (2026-10-04, "build: Updating eslint-config-wikimedia to 0.32.6"). Single sign-on from the Worker's
#      password gate: LocalSettings.cloud.php accepts the remote name only from X-Westernis-User and only
#      when it equals WIKI_SSO_USER. No composer dependencies.
ARG AUTH_REMOTEUSER_SHA=729e8a2815d21be2d691f0fa5a0ca4049b45e416
RUN set -eux; \
    git init -q extensions/Auth_remoteuser; \
    git -C extensions/Auth_remoteuser fetch -q --depth 1 https://github.com/wikimedia/mediawiki-extensions-Auth_remoteuser "$AUTH_REMOTEUSER_SHA"; \
    git -C extensions/Auth_remoteuser checkout -q FETCH_HEAD; \
    test "$(git -C extensions/Auth_remoteuser rev-parse HEAD)" = "$AUTH_REMOTEUSER_SHA"; \
    rm -rf extensions/Auth_remoteuser/.git; \
    test -f extensions/Auth_remoteuser/extension.json; \
    test -f extensions/Auth_remoteuser/src/AuthRemoteuserSessionProvider.php

# ---- 5. Guard: Cargo where= clauses rely on SQLite accepting double-quoted string literals (DQS)
RUN php -r '$d = new PDO("sqlite::memory:"); $d->exec("CREATE TABLE t(a)"); exit($d->query("SELECT 1 FROM t WHERE a=\"x\"") === false ? 1 : 0);'

# ---- 6. Apache on :8080 as www-data, PHP limits
#      Apache is started by the root supervisor as www-data and must not reopen /dev/stdout or /dev/stderr
#      (they belong to root): every log goes through a piped logger that writes to the inherited descriptor.
COPY docker/mediawiki/wiki.conf /etc/apache2/conf-available/wiki.conf
COPY docker/mediawiki/zz-wiki.ini /usr/local/etc/php/conf.d/zz-wiki.ini
COPY cloud/image/apache-cloud.conf /etc/apache2/conf-available/westernis-cloud.conf
COPY cloud/image/php-cloud.ini /usr/local/etc/php/conf.d/zzz-cloud.ini
RUN set -eux; \
    sed -i 's/\r$//' /etc/apache2/conf-available/wiki.conf /etc/apache2/conf-available/westernis-cloud.conf \
        /usr/local/etc/php/conf.d/zz-wiki.ini /usr/local/etc/php/conf.d/zzz-cloud.ini; \
    a2enmod rewrite headers expires; \
    a2enconf wiki westernis-cloud; \
    a2disconf other-vhosts-access-log; \
    echo 'Listen 8080' > /etc/apache2/ports.conf; \
    v=/etc/apache2/sites-available/000-default.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' "$v"; \
    sed -i -E 's#^([[:space:]]*)ErrorLog .*#\1ErrorLog "|/usr/bin/cat"#; s#^([[:space:]]*)CustomLog [^ ]+ (.*)#\1CustomLog "|/usr/bin/cat" \2#' "$v"; \
    grep -q '<VirtualHost \*:8080>' "$v"; \
    grep -q 'ErrorLog "|/usr/bin/cat"' "$v"; \
    grep -q 'CustomLog "|/usr/bin/cat" combined' "$v"; \
    ! grep -RhE '^[[:space:]]*(ErrorLog|CustomLog)[[:space:]]+\$\{APACHE_LOG_DIR\}' "$v" /etc/apache2/conf-enabled/; \
    grep -q '^ErrorLog "|/usr/bin/cat"$' /etc/apache2/conf-enabled/westernis-cloud.conf; \
    mkdir -p /var/www/html/cache /var/www/html/images /var/www/html/assets; \
    echo ok > /var/www/html/__ready; \
    chown -R www-data:www-data /var/www/html/cache /var/www/html/images; \
    apache2ctl -t

# ---- 7. Cloud scripts + project files (thin layers last)
#      Only wiki/LocalSettings.php: the untracked per-install wiki/LocalSettings.local.php of the LAN stack must
#      never reach the cloud image (it is also kept out of this build's context by Dockerfile.dockerignore).
COPY cloud/image/litestream.yml cloud/image/litestream.file.yml /etc/
COPY cloud/image/bin/ /usr/local/bin/
COPY cloud/migrate/container/ /opt/westernis/migrate/
COPY scripts/ /scripts/
COPY content/ /content/
COPY wiki/assets/ /var/www/html/assets/
COPY wiki/LocalSettings.php /var/www/html/LocalSettings.php
COPY cloud/image/LocalSettings.cloud.php /var/www/html/LocalSettings.cloud.php
# WIKI_SECRET_KEY=build: LocalSettings.php throws without a key; the dummy never leaves this build step.
RUN set -eux; \
    test ! -e /var/www/html/LocalSettings.local.php; \
    sed -i 's/\r$//' /scripts/*.sh /usr/local/bin/wst-* /var/www/html/LocalSettings*.php /etc/litestream*.yml; \
    find /opt/westernis/migrate -type f \( -name '*.sh' -o -name '*.php' \) -exec sed -i 's/\r$//' {} +; \
    chown root:root /usr/local/bin/wst-* /etc/litestream.yml /etc/litestream.file.yml; \
    chmod 0755 /scripts/*.sh /usr/local/bin/wst-*; \
    chmod 0644 /etc/litestream.yml /etc/litestream.file.yml; \
    chmod -R a+rX /opt/westernis/migrate; \
    find /opt/westernis/migrate -type f -name '*.sh' -exec chmod 0755 {} +; \
    chown -R www-data:www-data /var/www/html/assets; \
    for f in /var/www/html/LocalSettings*.php /usr/local/bin/wst-r2.php /usr/local/bin/wst-import-media.php; do php -l "$f"; done; \
    for f in /usr/local/bin/wst-import.sh /usr/local/bin/wst-sync.sh; do sh -n "$f"; done; \
    for f in /usr/local/bin/wst-start.sh /usr/local/bin/wst-run.sh /usr/local/bin/wst-dump.sh /usr/local/bin/wst-as; do bash -n "$f"; done; \
    install -d -o root -g root -m 0755 /var/lib/westernis /run/westernis; \
    install -d -o wstsync -g www-data -m 2770 /var/lib/westernis/db /var/lib/westernis/import; \
    install -d -o wstsync -g wstsync -m 0700 /var/lib/westernis/sync /var/lib/westernis/replica /var/lib/westernis/r2local /run/wst-sync; \
    install -d -o root -g wstsync -m 0750 /var/lib/westernis/dump; \
    /usr/local/bin/wst-as wiki /usr/bin/env | grep -q '^USER=www-data$'; \
    ! LITESTREAM_SECRET_ACCESS_KEY=x R2_DB_SECRET_ACCESS_KEY=x /usr/local/bin/wst-as wiki /usr/bin/env | grep -qE '^(LITESTREAM|R2_DB|AWS)_'; \
    ! R2_MEDIA_SECRET_ACCESS_KEY=x WIKI_SECRET_KEY=x /usr/local/bin/wst-as sync /usr/bin/env | grep -qE '^(R2_MEDIA|WIKI)_'; \
    su -s /bin/sh www-data -c 'WIKI_SECRET_KEY=build php maintenance/run.php rebuildLocalisationCache --no-database --force --lang=de,en'; \
    { find extensions skins -maxdepth 2 \( -name extension.json -o -name skin.json \) | sort | xargs sha1sum; \
      sha1sum includes/Defines.php LocalSettings*.php; } | sha1sum | cut -c1-12 > /etc/wst-schema-id; \
    cat /etc/wst-schema-id

ENV WIKI_CACHE_HOST=127.0.0.1 \
    WST_MEDIA=r2 \
    WST_DB=sqlite \
    WST_SQLITE_DIR=/var/lib/westernis/db
EXPOSE 8080
STOPSIGNAL SIGTERM
# The supervisor starts as root (no USER www-data): it alone holds every secret and hands each process to
# wstsync or www-data with an allowlisted environment (bin/wst-as). Anything that runs another entrypoint in
# this image (the migration container) must pass `--user www-data` itself.
USER root
# tini -s: also reaps orphans when the platform does not start it as PID 1. Never -g: the stop order
# (Apache, jobs, a confirmed flush, then one SIGTERM to Litestream) is wst-start.sh's job, not a group signal.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/wst-start.sh"]
# The base image's CMD (apache2-foreground) would only become an ignored argument; wst-start.sh starts Apache.
CMD []
