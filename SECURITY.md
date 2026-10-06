# Security policy

## Supported versions

Westernis has no release branches. Security fixes go into `main`; please update to the
latest commit before you report a problem.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately through
GitHub's private vulnerability reporting:
<https://github.com/shiftbloom-studio/westernis/security/advisories/new>

Include what is affected, how to reproduce it, and the impact you expect. Never include real
passwords or keys from your `.env`. We aim to acknowledge reports within a week and will
credit you in the advisory unless you prefer otherwise.

## Scope

In scope: the files in this repository, namely `wiki/LocalSettings.php`, the Docker image and
Compose setup (`docker/`, `docker-compose.yml`), the scripts in `scripts/`, the Forge MCP server
(`tools/forge-mcp`), the generators in `tools/`, and the theme CSS and JS
(`content/pages/MediaWiki/`, `wiki/assets/js/`).

Out of scope: vulnerabilities in MediaWiki itself, the Citizen skin, the extensions, MariaDB,
memcached or the base images. Please report those to the upstream projects (for MediaWiki see
<https://www.mediawiki.org/wiki/Reporting_security_bugs>). If our configuration makes an upstream
issue exploitable, that part is in scope.

## Deployment notes

The default configuration assumes a **private wiki on a trusted local network** with a single
author. Before you expose a wiki to the internet, review at least these points:

- **TLS and a fixed server URL.** `$wgServer` is derived from the request's `Host` header so
  that both `localhost` and LAN addresses work. On a public host, put the wiki behind HTTPS and
  set a fixed `$wgServer` (for example in the untracked `wiki/LocalSettings.local.php`).
- **Error details.** Keep `WIKI_DEBUG=0` (the default): `WIKI_DEBUG=1` shows stack traces, paths
  and SQL on error pages.
- **Rate limits.** `$wgRateLimits` is empty so that the author and the MCP server are never
  throttled. Restore MediaWiki's defaults on a public wiki.
- **Anonymous access.** Anonymous visitors can read every page and run Cargo queries
  (`runcargoqueries`). Account creation and anonymous editing are off.
- **Uploads and user scripts.** Users may upload from URLs (`$wgAllowCopyUploads`), and user
  CSS and JS are enabled. Only give accounts to people you trust.
- **The bot password.** The Forge bot password (`WIKI_BOT_PASSWORD`) can edit the interface and
  site configuration, delete and protect pages, and create accounts. Keep it long and secret,
  and run the MCP server only on machines you control.
- **Secrets.** All secrets live only in `.env`, which is git-ignored. `WIKI_SECRET_KEY` has no
  fallback: the wiki refuses to start without it. Backups made with `wiki.ps1 backup` contain a
  copy of `.env`; never commit or share the `backups/` folder.

A hosted setup on Cloudflare is being designed in
[`docs/cloudflare-design.md`](docs/cloudflare-design.md).

Maintainers: enable *Private vulnerability reporting*, *Secret scanning* and *Push protection*
in the repository settings (Settings, Code security).
