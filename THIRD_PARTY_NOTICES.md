# Third-party notices

Westernis's own code is licensed under [AGPL-3.0-or-later](LICENSE) and its wiki text and artwork
under [CC BY-SA 4.0](content/LICENSE.md).
This file lists the third-party material that the repository contains or that the build
downloads, and the licences that apply to it. Those licences, not the project's, govern
that material.

## 1. Bundled in this repository

### Fonts

The fonts in [`wiki/assets/fonts`](wiki/assets/fonts) are served from `/assets/fonts/`.
Each licence file sits next to the fonts and starts with the font's own copyright notice;
[`FONTS.txt`](wiki/assets/fonts/FONTS.txt) is the index. The WOFF2 files are lossless
conversions of the upstream TTFs (font data unchanged, no subsetting, no renaming).

| Family | Version | Files | Copyright | Licence |
| --- | --- | --- | --- | --- |
| Cinzel | 2.000 (variable) | `Cinzel.woff2`, `tools/brand/fonts/Cinzel[wght].ttf` | Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel) | OFL-1.1, [`OFL-Cinzel.txt`](wiki/assets/fonts/OFL-Cinzel.txt), [`tools/brand/fonts/OFL.txt`](tools/brand/fonts/OFL.txt) |
| Cinzel Decorative | 1.002 | `CinzelDecorative-Regular.woff2`, `CinzelDecorative-Bold.woff2` | Copyright (c) 2012 Natanael Gama (info@ndiscovered.com), with Reserved Font Name 'Cinzel' | OFL-1.1, [`OFL-CinzelDecorative.txt`](wiki/assets/fonts/OFL-CinzelDecorative.txt) |
| Cormorant Garamond | 4.001 (variable) | `CormorantGaramond.woff2`, `CormorantGaramond-Italic.woff2` | Copyright 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) | OFL-1.1, [`OFL-CormorantGaramond.txt`](wiki/assets/fonts/OFL-CormorantGaramond.txt) |
| EB Garamond | 1.003 (variable) | `EBGaramond.woff2`, `EBGaramond-Italic.woff2` | Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12) | OFL-1.1, [`OFL-EBGaramond.txt`](wiki/assets/fonts/OFL-EBGaramond.txt) |
| IM FELL English | 3.00 | `IMFellEnglish-Regular.woff2`, `IMFellEnglish-Italic.woff2` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com); Reserved Font Names "IM FELL English Roman" and "IM FELL English Italic" | OFL-1.1, [`OFL-IMFellEnglish.txt`](wiki/assets/fonts/OFL-IMFellEnglish.txt) |
| Tengwar Telcontar | 0.08 | `TengwarTelcontar.woff2`, `TengwarTelcontar-Bold.woff2`; original TTFs in [`third_party/fonts/TengwarTelcontar`](third_party/fonts/TengwarTelcontar/README.txt) | Copyright (C) 2005-2009 Johan Winge (Free Tengwar Font Project) | GPL-3.0-or-later WITH Font-exception-2.0, [`COPYING-TengwarTelcontar.txt`](wiki/assets/fonts/COPYING-TengwarTelcontar.txt) |

The SIL Open Font License 1.1 allows the fonts to be used, embedded, modified and
redistributed with any software, but not sold on their own; see <https://openfontlicense.org>.
Tengwar Telcontar is free software under the GNU GPL v3 or later; its font exception means
that a page or document using the font is not covered by the GPL because of the font.
The upstream project notes that using J. R. R. Tolkien's tengwar script in a commercial
production may need permission from the Tolkien Estate.

Fonts inside other files:

- [`content/files/Westernis_map.svg`](content/files/Westernis_map.svg) embeds glyph subsets of
  Cinzel, Cinzel Decorative Bold and IM FELL English Roman and Italic under the renamed families
  `WstMapCaps`, `WstMapTitle`, `WstMapRoman` and `WstMapHand` (written by
  `tools/brand/make-map.js`). Embedding fonts in a document is allowed by OFL-FAQ 1.12-1.13, the
  document does not become OFL-licensed, and the subsets keep their copyright and licence records.
- The logo, wordmark and tagline SVGs in [`wiki/assets/brand`](wiki/assets/brand) contain Cinzel
  outlines converted to paths (`tools/brand/make-wordmark.js`). Outlines used as artwork are not
  font software (OFL-FAQ 1.1, 1.13).

### Everything else

The repository contains no other third-party code or artwork. The theme CSS and JS
(`content/pages/MediaWiki/*`, `wiki/assets/js/westernis.js`), the Lua modules, the generators,
the MCP server, the scripts, the SVG, PNG and ICO artwork and the screenshots were made for
this project. The artwork and screenshots are licensed under CC BY-SA 4.0 (see
[content/LICENSE.md](content/LICENSE.md)); the code that generates them is AGPL-3.0-or-later.

## 2. Downloaded at build time (not included in this repository)

[`docker/mediawiki/Dockerfile`](docker/mediawiki/Dockerfile) builds the wiki image from the
official MediaWiki image and clones the skin and extensions below at pinned tags or commits.
They are separate works, keep their own licences, and are not part of this repository.
Anyone who redistributes a built image must meet the source-code obligations of these
licences (the GPL ones in particular).

**Base image `mediawiki:1.46.0`** (official Docker image): MediaWiki core, GPL-2.0-or-later.
Bundled skin Vector, GPL-2.0-or-later. Bundled extensions loaded by `LocalSettings.php`:
CategoryTree, Cite, Gadgets, ImageMap, Math, MultimediaViewer, Nuke, ParserFunctions,
PdfHandler, ReplaceText, TemplateData, TemplateStyles, TextExtracts and WikiEditor
(GPL-2.0-or-later); CodeEditor (GPL-2.0-or-later AND BSD-3-Clause); Scribunto
(GPL-2.0-or-later AND MIT); SyntaxHighlight (GPL-2.0-or-later, with Pygments under
BSD-2-Clause); InputBox (MIT); VisualEditor (MIT); PageImages (WTFPL); Poem (CC0-1.0).
The image also contains Debian, PHP, Apache httpd and LuaSandbox under their own licences.

**Skin and extensions cloned by the Dockerfile:**

| Component | Version | Licence |
| --- | --- | --- |
| Citizen (skin) | v3.24.0 | GPL-3.0-or-later |
| Cargo | 3.9.4 | GPL-2.0-or-later |
| Page Forms | 6.0.11 | GPL-2.0-or-later |
| PortableInfobox | commit 60c09a75 | GPL-3.0-or-later |
| DynamicPageList4 | 4.0.6 | GPL-3.0-or-later |
| DisplayTitle | 4.1.0 | MIT |
| LabeledSectionTransclusion | REL1_46 | GPL-2.0-or-later |
| TabberNeue | v4.1.0 | GPL-3.0-or-later |
| ShortDescription | commit 8d348a84 | GPL-3.0-or-later |
| Popups | REL1_46 | GPL-2.0-or-later |
| RelatedArticles | REL1_46 | GPL-2.0-only |
| Lingo | 3.3.0 | GPL-2.0-or-later |
| DataMaps | commit e95f4251 | GPL-2.0-or-later |
| Mermaid | 6.0.2 | GPL-2.0-or-later |
| Network | 4.1.0 | GPL-2.0-or-later |
| CodeMirror | REL1_46 | GPL-2.0-or-later |
| CharInsert | REL1_46 | GPL-2.0-or-later |
| MsUpload | REL1_46 | GPL-2.0-or-later |
| SimpleBatchUpload | 3.1.0 | GPL-2.0-or-later |

Some extensions bundle JavaScript libraries under their own licences (for example mermaid,
vis-network and CodeMirror).

**Debian packages added by the Dockerfile:** poppler-utils (GPL-2.0-only OR GPL-3.0-only),
ghostscript (AGPL-3.0-or-later), python3 (PSF-2.0), diffutils (GPL-3.0-or-later).

**Other Compose services** (separate containers, used unmodified): `mariadb:lts`
(GPL-2.0-only), `memcached:1.6-alpine` (BSD-3-Clause).

### Compatibility

MediaWiki core is GPL-2.0-or-later, so this project's AGPL-3.0-or-later configuration, theme
and scripts can run with it under the GPL version 3 option (GPLv3 and AGPLv3 section 13). The
GPL-3.0-or-later, MIT, BSD, WTFPL and CC0 components are compatible as well. RelatedArticles is
GPL-2.0-only. This repository distributes no extension code: the Dockerfile fetches it at build
time and `LocalSettings.php` only loads and configures it. MariaDB, memcached and Ghostscript are
separate programs. If you publish a built image, consider replacing RelatedArticles, and provide
the source of every component as its licence requires.

## 3. npm dependencies of the tools (installed, not redistributed)

`node_modules/` is not committed; `npm ci` installs these from the lockfiles.

- [`tools/forge-mcp`](tools/forge-mcp/package.json) (the MCP server): `@modelcontextprotocol/sdk`
  and `zod` (MIT); transitive dependencies under MIT, ISC, BSD-2-Clause and BSD-3-Clause.
- [`tools/brand`](tools/brand/package.json) (art generators): `fonteditor-core` and `wawoff2` (MIT),
  `@resvg/resvg-js` (MPL-2.0), `sharp` (Apache-2.0; its prebuilt libvips binaries are
  LGPL-3.0-or-later); transitive `@xmldom/xmldom` (MIT), `argparse` (Python-2.0), `semver` (ISC),
  `detect-libc` (Apache-2.0), `tslib` (0BSD).

All of them can be used with AGPL-3.0-or-later code.

## 4. Tolkien and trademarks

Westernis is an unofficial fan project. It is not affiliated with, endorsed, sponsored or
approved by the Tolkien Estate, the Tolkien Trust, Middle-earth Enterprises, HarperCollins,
Klett-Cotta or any film or game licensee. J. R. R. Tolkien's works are protected by copyright;
*The Lord of the Rings*, *The Hobbit*, *Middle-earth* and the names of characters, places,
events and items from them are trademarks or otherwise protected names of their respective
owners and are used here only to identify what the sample articles describe. The sample
articles summarise the published legendarium in our own words; short quotations are
attributed. German name forms follow the established German translations. The licences of
this repository (AGPL-3.0-or-later for code, CC BY-SA 4.0 for wiki text and artwork) cover only this
project's own contributions and grant no rights in Tolkien's works or in any third-party
trademark.
