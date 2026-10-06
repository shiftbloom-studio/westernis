#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Manuscript ornaments for the theme, written to wiki/assets/img/orn/. They are used as CSS
// masks (black shapes on transparent, recoloured with background-color), so one file serves
// night and day. Gradients fade via stop-opacity, which masks honour.
//   node tools/brand/make-ornaments.js
'use strict';
const fs = require('fs');
const path = require('path');
const out = path.resolve(__dirname, '..', '..', 'wiki', 'assets', 'img', 'orn');
fs.mkdirSync(out, { recursive: true });

const svg = (vb, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>${body}</svg>\n`;
const files = {};

// ---------------------------------------------------------------- frame corners (40x40, top-left; others mirrored)
// a scrolling curl in the corner, two tendrils along the edges, a bead on the diagonal
const cornerBody = `<g fill="none" stroke="#000" stroke-linecap="round" stroke-width="1.5">` +
  `<path d="M2 2c10 0 16 5 16 12 0 4.5-3 7-6.5 7S6 18.5 6 16s2-4 4-3.5"/>` +
  `<path d="M2 2c0 10 5 16 12 16" stroke-width="1"/>` +
  `<path d="M18 8.5c5.5-2.6 11-2.6 18 0" stroke-width="1"/><path d="M8.5 18c-2.6 5.5-2.6 11 0 18" stroke-width="1"/>` +
  `</g><g fill="#000"><circle cx="21" cy="21" r="1.8"/><circle cx="38" cy="8.5" r="1.1"/><circle cx="8.5" cy="38" r="1.1"/><path d="M0 0h6L0 6z"/></g>`;
const corner = (t) => svg('0 0 40 40', t ? `<g transform="${t}">${cornerBody}</g>` : cornerBody);
files['corner-tl.svg'] = corner('');
files['corner-tr.svg'] = corner('translate(40 0) scale(-1 1)');
files['corner-bl.svg'] = corner('translate(0 40) scale(1 -1)');
files['corner-br.svg'] = corner('translate(40 40) scale(-1 -1)');

// ---------------------------------------------------------------- heading rule: lozenge, bead, double rule fading out
files['rule.svg'] = svg('0 0 800 16',
  `<defs><linearGradient id="f" x2="1"><stop offset="0" stop-opacity="1"/><stop offset="0.55" stop-opacity="0.55"/><stop offset="1" stop-opacity="0"/></linearGradient></defs>` +
  `<path fill-rule="evenodd" d="M1 8l6-6 6 6-6 6zM4.2 8L7 5.2 9.8 8 7 10.8z"/>` +
  `<circle cx="19" cy="8" r="1.6"/>` +
  `<rect x="25" y="7.2" width="775" height="1.4" fill="url(#f)"/>` +
  `<rect x="25" y="10.6" width="560" height="0.6" fill="url(#f)"/>`,
  ' preserveAspectRatio="xMinYMid slice"');

// ---------------------------------------------------------------- fleuron: a centred ornament for titles and section heads
files['fleuron.svg'] = svg('0 0 320 24',
  `<defs><linearGradient id="l" x1="1" x2="0"><stop offset="0"/><stop offset="1" stop-opacity="0"/></linearGradient>` +
  `<linearGradient id="r"><stop offset="0"/><stop offset="1" stop-opacity="0"/></linearGradient></defs>` +
  `<rect x="0" y="11.4" width="120" height="1.2" fill="url(#l)"/><rect x="200" y="11.4" width="120" height="1.2" fill="url(#r)"/>` +
  `<path d="M160 3c-3 5-7 7-12 9 5 2 9 4 12 9 3-5 7-7 12-9-5-2-9-4-12-9z"/>` +
  `<g fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round">` +
  `<path d="M146 12c-6-6-13-6-17 0 4 6 11 6 17 0M174 12c6-6 13-6 17 0-4 6-11 6-17 0"/>` +
  `<path d="M129 12c-3-3-6-3-8 0M191 12c3-3 6-3 8 0"/></g>` +
  `<circle cx="125" cy="12" r="1.5"/><circle cx="195" cy="12" r="1.5"/>`);

// ---------------------------------------------------------------- small star (list bullets, timeline nodes, separators)
files['star.svg'] = svg('0 0 16 16', `<path d="M8 0c.6 4.2 2.5 6.6 8 8-5.5 1.4-7.4 3.8-8 8-.6-4.2-2.5-6.6-8-8 5.5-1.4 7.4-3.8 8-8z"/>`);
files['lozenge.svg'] = svg('0 0 16 16', `<path fill-rule="evenodd" d="M8 1l7 7-7 7-7-7zM8 4.5L11.5 8 8 11.5 4.5 8z"/>`);

// ---------------------------------------------------------------- quill (create buttons)
files['quill.svg'] = svg('0 0 24 24',
  `<path d="M21.5 2.2c-6.3.6-11 3.6-13.6 8.6-.9 1.8-1.5 3.8-1.8 5.8l-2.3 3.9 1.2.7 2.1-3.6c1.7.3 3.4-.1 4.8-1.1l-1.9-.6 3.1-1.1c.6-.6 1.2-1.3 1.7-2l-2.2-.3 3.3-1.4c1.7-3 2.9-6.1 3.4-9z"/>` +
  `<path d="M3 21.5h9v1.2H3z"/>`);

// ---------------------------------------------------------------- open book (empty states) and seal ring (canon badge)
files['seal.svg'] = svg('0 0 40 40',
  `<path d="M20 1.5l3 2.6 3.9-.9 1.7 3.6 3.9.6.1 4 3.4 2-1.3 3.7 2.3 3.2-2.9 2.7.8 3.9-3.8 1.2-.8 3.9-4-.3-2.3 3.3-3.4-2.1-3.7 1.5-1.7-3.6-3.9-.7-.1-4L4.7 22l1.3-3.7L3.7 15l2.9-2.7-.8-3.9 3.8-1.2.8-3.9 4 .3z"/>`);

for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), body);
}
console.log(Object.keys(files).map((f) => '  orn/' + f).join('\n'));
