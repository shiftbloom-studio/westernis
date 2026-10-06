# Licence of the wiki content and artwork

The wiki pages in [`content/pages`](pages) are licensed under the
**Creative Commons Attribution-ShareAlike 4.0 International** licence (CC BY-SA 4.0).
This covers the `*.wiki` files and the page data in `*.json` files: the sample articles,
the main page, help and project pages, the text of templates and forms (including their
documentation), category pages and interface messages.

- Summary: <https://creativecommons.org/licenses/by-sa/4.0/>
- Full legal code: [`LICENSES/CC-BY-SA-4.0.txt`](../LICENSES/CC-BY-SA-4.0.txt)
  (also at <https://creativecommons.org/licenses/by-sa/4.0/legalcode>)
- SPDX identifier: `CC-BY-SA-4.0`

## Exceptions: code in `content/pages`

These files are code and are licensed like the rest of the project under the
GNU Affero General Public License v3.0 or later (see [`LICENSE`](../LICENSE)):

- `content/pages/MediaWiki/*.css` and `content/pages/MediaWiki/*.js` (the theme)
- `content/pages/Module/*.lua` (Scribunto Lua modules)

## Artwork

The artwork is licensed under CC BY-SA 4.0 as well: the map and marker icons in
[`content/files`](files), the logos, hero landscape, icons and ornaments in
[`wiki/assets/brand`](../wiki/assets/brand) and [`wiki/assets/img`](../wiki/assets/img), and the
screenshots in [`docs/screenshots`](../docs/screenshots). The scripts in
[`tools/brand`](../tools/brand) that generate the artwork are code (AGPL-3.0-or-later). The fonts
embedded in the map SVG keep their own licences; see
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## How to give credit

When you reuse or adapt this text, credit it like this and say whether you changed it:

> Westernis wiki content © 2026 Fabian Zimber / shiftbloom studio,
> <https://github.com/shiftbloom-studio/westernis>, licensed under
> [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Changes: …

Adaptations must be shared under CC BY-SA 4.0 or a compatible licence.

## Your own wiki

This licence covers the seed files in this repository. Pages that you and your users
write in your own installation are yours; choose a licence for them yourself (the
optional `WIKI_RIGHTS_URL` and `WIKI_RIGHTS_TEXT` settings in `.env` show it in the
footer). Contributions to `content/pages` in this repository are accepted under
CC BY-SA 4.0 (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).

## Tolkien's works

The sample articles marked `canon=Tolkien` summarise J. R. R. Tolkien's published works in
this project's own words; short quotations are attributed. This licence covers only the
project's own text and its selection and arrangement. It grants no rights in Tolkien's
works, in the names from them, or in their translations. Westernis is an unofficial fan
project; see the disclaimer in the [README](../README.md#disclaimer).
