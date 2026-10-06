# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
# Westernis wiki image: official MediaWiki 1.46 + Citizen skin + worldbuilding extensions.
# Build context is the project root (see docker-compose.yml).
FROM mediawiki:1.46.0

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

# --- Server config -------------------------------------------------------------
COPY docker/mediawiki/wiki.conf /etc/apache2/conf-available/wiki.conf
COPY docker/mediawiki/zz-wiki.ini /usr/local/etc/php/conf.d/zz-wiki.ini
RUN set -eux; \
    a2enmod rewrite headers expires; \
    a2enconf wiki; \
    mkdir -p /var/www/html/cache /var/www/html/assets /var/www/html/images; \
    chown -R www-data:www-data /var/www/html/cache /var/www/html/images; \
    for e in Cargo PageForms PortableInfobox DynamicPageList4 DisplayTitle LabeledSectionTransclusion TabberNeue ShortDescription Popups RelatedArticles Lingo DataMaps Mermaid Network CodeMirror CharInsert MsUpload SimpleBatchUpload; do \
        test -f "extensions/$e/extension.json" || { echo "MISSING extension.json for $e" >&2; exit 1; }; \
    done; \
    test -f skins/Citizen/skin.json

# --- Project files (kept last so edits rebuild only these thin layers) --------
COPY scripts/ /scripts/
COPY content/ /content/
COPY wiki/assets/ /var/www/html/assets/
# LocalSettings.php, plus the optional untracked per-install wiki/LocalSettings.local.php when present
COPY wiki/LocalSettings*.php /var/www/html/
RUN set -eux; \
    sed -i 's/\r$//' /scripts/*.sh /var/www/html/LocalSettings*.php; \
    chmod +x /scripts/*.sh; \
    chown -R www-data:www-data /var/www/html/assets; \
    for f in /var/www/html/LocalSettings*.php; do php -l "$f"; done
