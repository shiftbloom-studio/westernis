# Westernis — project notes for Claude Code

A private, LAN-only MediaWiki (1.46, Citizen skin) for the owner's Middle-earth-derived
"Westernis" universe, run with Docker Compose. Claude Code works on the wiki through the
**westernis-forge** MCP server (`.mcp.json`), which logs in with a bot password from `.env`.

## Working on lore (the wiki content)
- Skills: `/wiki-article` (create or extend one article), `/lore-sweep` (groom the red-link
  backlog, write batches, audit consistency).
- Always call `wiki_lore_context` (and `wiki_entity_schema`) before writing; existing pages win.
- New pages are `canon=Draft` until the owner promotes them. Never change `canon=Tolkien` facts.
- Article types and their fields live in `tools/gen-entities/entities.js` — the single source of
  truth for templates, forms, categories and the MCP schema. Reader-facing German text (labels,
  group headers, section titles, dropdown display values, type names) lives in
  `tools/gen-entities/de.js`; identifiers (template/form/table/field/category names, stored values)
  stay English. The generator fails on any untranslated label. After editing either run
  `node tools/gen-entities/generate.js`, then `.\scripts\wiki.ps1 sync` and `.\scripts\wiki.ps1 seed`.
- The wiki defaults to German (`WIKI_LANG=de`); write new lore in German (see the skills).
- Sample pages (Tolkien summaries), the glossary, help and project pages and the housekeeping
  categories come from `tools/gen-entities/samples.js`: edit it, then run
  `node tools/gen-entities/samples.js` (generate.js does not run it). They are scaffolding; the
  owner may delete or rewrite them. Summarise Tolkien in your own words: no long verbatim
  quotations, only short attributed ones.

## Working on the installation
- `docker-compose.yml` + `docker/mediawiki/Dockerfile` build the image; `wiki/LocalSettings.php`,
  `wiki/assets/`, `scripts/` and `content/` are COPIED into the image (no bind mounts, so the stack
  also runs where the project folder is not shared with the Docker daemon). `.\scripts\wiki.ps1 sync`
  pushes edits into the running containers without a rebuild; `.\scripts\wiki.ps1 up` rebuilds the
  thin layers. Per-install PHP overrides go in the untracked `wiki/LocalSettings.local.php`.
- Theme = `content/pages/MediaWiki/Common.css` (design system: tokens, typography, components,
  hero, map) / `Citizen.css` (skin chrome) / `Common.js` plus static files in `wiki/assets/`
  (fonts, svg, js). Re-seed after editing the MediaWiki: pages. Art is generated, not hand-edited:
  `tools/brand/make-hero.js` (landscape layers, night + dawn), `make-ornaments.js` (mask ornaments
  in img/orn), `make-icons.js` (entity icons, dividers), `make-map.js` (content/files/Westernis_map.svg,
  the source) + `raster-map.js` (Westernis_map.webp, the image Map:Westernis shows: Leaflet zooming a
  dense SVG stalls Chromium); re-upload with `seed -ForceFiles`.
- `/assets` is browser-cached for a day: bump the `?v=` on asset URLs in Common.css after changing
  an image, and `WST_ASSET_VERSION` in LocalSettings.php after changing westernis.js. The site CSS
  (load.php site.styles) is cached for 5 minutes; append `?debug=1` to see edits immediately.
- MediaWiki 1.46 dropped the global class aliases in LocalSettings hooks: use `\MediaWiki\Html\Html`.
- Shell scripts must stay LF; inside Git Bash set `MSYS_NO_PATHCONV=1` before `docker exec … /scripts/…`.
- Run maintenance scripts inside the container as `www-data` (`docker compose exec -u www-data wiki …`),
  never as root: root-owned files in `images/` break uploads for Apache.
- `.mcp.json` uses a path relative to this folder: start Claude Code here. After cloning, run
  `npm ci --prefix tools/forge-mcp` once so the MCP server can start.
- Port 8088 on the host by default (`WIKI_HOST_PORT`); the canonical URL is `WIKI_SERVER` in `.env`.
  All personal settings (URL, admin user, passwords) live only in the untracked `.env`.
