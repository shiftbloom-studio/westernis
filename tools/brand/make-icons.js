#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Writes the small monochrome SVG icons and dividers used by the theme (CSS masks, recoloured per theme).
// Icons are 24x24, one filled shape each (evenodd cut-outs for detail), drawn to read at 18–40 px
// inside the gilt seals of the codex tiles, category banners and create cards.
// node tools/brand/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const out = path.resolve(__dirname, '..', '..', 'wiki', 'assets', 'img');
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const svg = (vb, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>\n`;
const P = (d) => `<path fill="#000" fill-rule="evenodd" d="${d}"/>`;
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

const icons = {
  // a royal crown: band, three tines with pearls, a cut gem
  character: P(`M3.2 17.2L2.4 9l4.7 3.6L12 5.6l4.9 7L21.6 9l-.8 8.2z M3.2 18.4h17.6v2.6H3.2z ${circle(2.4, 8.1, 1.5)} ${circle(12, 4.4, 1.6)} ${circle(21.6, 8.1, 1.5)} M12 12.4l1.6 1.9-1.6 1.9-1.6-1.9z`),
  // a castle: two crenellated towers, a keep with a pennant, an arched gate
  location: P(`M2 21.5V8.4h1.6V6.8h1.5v1.6h1V6.8h1.5v1.6H9v13.1z M15 21.5V8.4h1.6V6.8h1.5v1.6h1V6.8h1.5v1.6H22v13.1z M9 21.5v-9h6v9h-1.6v-3.1a1.4 1.4 0 0 0-2.8 0v3.1z M9.8 12.5V6.4h1V4.9h2.4v1.5h1v6.1z M11.6 4.9V1.2l3.2 1.1-3.2 1.1z M4.6 11.2h1.2v2.4H4.6z M18.2 11.2h1.2v2.4h-1.2z`),
  // a heraldic shield bearing a chevron
  faction: P(`M3.6 2.6h16.8v8.2c0 5.4-3.6 9-8.4 10.9-4.8-1.9-8.4-5.5-8.4-10.9z M5.6 4.6v6.2c0 4.2 2.7 7.1 6.4 8.7 3.7-1.6 6.4-4.5 6.4-8.7V4.6z M6.6 12.4L12 8.2l5.4 4.2v2.6L12 10.8 6.6 15z`),
  // a mallorn leaf brooch, veined
  people: P(`M12 1.8c-4.4 3.4-7 7.6-7 11.4 0 4.5 3 7.8 7 8.4 4-.6 7-3.9 7-8.4 0-3.8-2.6-8-7-11.4z M11.4 6.2h1.2v15h-1.2z M12 12.2l3.6-2.6.7.9-4.3 3.2z M12 12.2L8.4 9.6l-.7.9 4.3 3.2z M12 16.2l3.2-2.2.7.9-3.9 2.8z M12 16.2l-3.2-2.2-.7.9 3.9 2.8z M11.3 21.5h1.4v1.6h-1.4z`),
  // a dragon's wing and head
  creature: P(`M2 21c2.2-.4 4-1.6 5.2-3.4-1.3.2-2.5 0-3.4-.6 1.9-.5 3.4-1.7 4.3-3.5-1.2.2-2.4.1-3.3-.4 2-.6 3.6-2 4.4-4.1C11.5 6.2 15 4.4 18.6 2.6c-.4 1.6-.4 3 .2 4.2 1-.3 2.1-.2 3.2.3-1.3.7-2.2 1.7-2.6 3 .9.6 1.4 1.5 1.6 2.6-1.6-.6-3-.6-4.2-.1-1 3.6-3.6 6.4-7.2 7.6 1.6.4 2.6 1.1 3.2 2-3.2.3-6 .2-8.6-.3-.7.6-1.4.9-2.2 1.1z ${circle(17.7, 7.6, 0.8)}`),
  // the ring: a band with an inscription groove and a set stone
  artifact: P(`${circle(12, 13.5, 8)} ${circle(12, 13.5, 5.6)} M12 1.4l2.6 2.6-2.6 2.6-2.6-2.6z M5.6 12.8a6.6 6.6 0 0 1 2-4.3l.7.8a5.6 5.6 0 0 0-1.7 3.6z`),
  // two crossed swords with guards and pommels
  event: P(`M2.6 2.4l2.6.5 10 10-1.9 1.9-10-10z M12.6 16.4l4-4 1.2 1.2-4 4z M15.7 16.8l1.3-1.3 3.4 3.4-1.3 1.3z ${circle(20.7, 20.7, 1.3)} M21.4 2.4l-2.6.5-10 10 1.9 1.9 10-10z M11.4 16.4l-4-4-1.2 1.2 4 4z M8.3 16.8L7 15.5l-3.4 3.4 1.3 1.3z ${circle(3.3, 20.7, 1.3)}`),
  // an hourglass in its frame, sand running
  era: P(`M4.6 1.6h14.8v2.2H4.6z M4.6 20.2h14.8v2.2H4.6z M6.4 3.8h11.2c0 4.3-2.6 6.4-4.3 8.2 1.7 1.8 4.3 3.9 4.3 8.2H6.4c0-4.3 2.6-6.4 4.3-8.2-1.7-1.8-4.3-3.9-4.3-8.2z M8 5.1c.3 2.9 2.2 4.6 4 6.2 1.8-1.6 3.7-3.3 4-6.2z M8 18.9h8c-.3-2.9-2.2-4.6-4-6.2-1.8 1.6-3.7 3.3-4 6.2z M9.4 6.4h5.2c-.6 1.5-1.6 2.5-2.6 3.3-1-.8-2-1.8-2.6-3.3z M9.2 18.2c.5-1.6 1.6-2.6 2.8-3.4 1.2.8 2.3 1.8 2.8 3.4z M11.6 10.6h.8v5.4h-.8z`),
  // an unrolled scroll with lines of script
  language: P(`M6.2 2.6h12.2a2.6 2.6 0 0 1 0 5.2h-.9v11a2.6 2.6 0 0 1-2.6 2.6H3.4a2.6 2.6 0 0 1 0-5.2h.9V5.4a2.8 2.8 0 0 1 1.9-2.8z M6.4 4.9v11.3h7.2v2.6c0 .4.1.8.3 1.1h1a.9.9 0 0 0 .9-.9V4.9z M17.4 4.4v1.8h1a.9.9 0 0 0 0-1.8z M8.3 7.6h5.8v1.2H8.3z M8.3 10.2h5.8v1.2H8.3z M8.3 12.8h4.2V14H8.3z`),
  // the star of Eärendil: eight rays, a hollow heart
  power: P(`M12 .8l1.7 6.4 5.6-3.5-3.5 5.6 6.4 1.7-6.4 1.7 3.5 5.6-5.6-3.5L12 23.2l-1.7-6.4-5.6 3.5 3.5-5.6L1.8 13 8.2 11.3 4.7 5.7l5.6 3.5z ${circle(12, 12, 2.4)}`),
  // an open book, pages lined
  chronicle: P(`M1.8 5.2c3.4-1.3 6.9-1.1 9.6.9v15.1c-2.8-1.8-6.2-2-9.6-.9z M22.2 5.2c-3.4-1.3-6.9-1.1-9.6.9v15.1c2.8-1.8 6.2-2 9.6-.9z M4 8.2c1.9-.5 3.6-.4 5.2.3v1c-1.6-.6-3.3-.7-5.2-.3z M4 11.2c1.9-.5 3.6-.4 5.2.3v1c-1.6-.6-3.3-.7-5.2-.3z M14.8 8.5c1.6-.7 3.3-.8 5.2-.3v1c-1.9-.4-3.6-.3-5.2.3z M14.8 11.5c1.6-.7 3.3-.8 5.2-.3v1c-1.9-.4-3.6-.3-5.2.3z`),
  // a sealed folio of terms
  glossary: P(`M5 2.4h10.4l3.6 3.6v15.6H5z M7 4.4v15.2h10V7h-2.6V4.4z M8.8 9.2h6.4v1.2H8.8z M8.8 11.8h6.4V13H8.8z M8.8 14.4h4V15.6h-4z ${circle(15.6, 18.2, 2.1)}`),
  create: P('M11 3h2v8h8v2h-8v8h-2v-8H3v-2h8z'),
  // a folded chart with a marked route
  map: P(`M2 5.2l6-2.2 8 2.2 6-2.2v15.8l-6 2.2-8-2.2-6 2.2z M3.8 6.4v12.2l3.3-1.2V5.2z M8.9 5.2v12.2l6.2 1.7V6.9z M16.9 6.9v12.2l3.3-1.2V5.7z M10.2 9.3l1.1-.6.6 1.1-1.1.6z M12 11.4l1.1-.6.6 1.1-1.1.6z M12.4 14.2l1.2-.2.2 1.2-1.2.2z`),
};
for (const [name, body] of Object.entries(icons)) fs.writeFileSync(path.join(out, 'icons', `${name}.svg`), svg('0 0 24 24', body));

// ----- dividers (wide; recoloured by CSS mask). Hairlines are real rectangles so they have area.
const fleuron = svg('0 0 600 40',
  P('M0 19.3h232v1.4H0z M368 19.3h232v1.4H368z') +
  P('M300 6c-6 8-14 10-22 12 8 2 16 4 22 14 6-10 14-12 22-14-8-2-16-4-22-12z') +
  P(`${circle(258, 20, 4)} ${circle(342, 20, 4)}`) +
  P('M270 20c6-6 12-6 18 0-6 6-12 6-18 0z M330 20c-6-6-12-6-18 0 6 6 12 6 18 0z'));
const star = svg('0 0 600 40',
  P('M0 19.3h262v1.4H0z M338 19.3h262v1.4H338z') +
  P('M300 7l3.6 9.2L313 17l-7 5.4 2.3 9.3L300 26.6l-8.3 5.1 2.3-9.3-7-5.4 9.4-.8z') +
  P(`${circle(272, 20, 3)} ${circle(328, 20, 3)}`));
const knot = svg('0 0 600 40',
  P('M0 19h200v2H0z M400 19h200v2H400z') +
  `<path d="M210 20c20-16 40-16 60 0s40 16 60 0 40-16 60 0" fill="none" stroke="#000" stroke-width="3"/>` +
  `<path d="M210 20c20 16 40 16 60 0s40-16 60 0 40 16 60 0" fill="none" stroke="#000" stroke-width="3"/>` +
  P(circle(300, 20, 5)));
fs.writeFileSync(path.join(out, 'divider-fleuron.svg'), fleuron);
fs.writeFileSync(path.join(out, 'divider-star.svg'), star);
fs.writeFileSync(path.join(out, 'divider-knot.svg'), knot);
console.log('icons:', Object.keys(icons).length, '+ dividers written to', path.relative(process.cwd(), out));
