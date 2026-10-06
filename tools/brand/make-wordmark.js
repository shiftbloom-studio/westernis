#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Renders text to SVG paths with the project's own font files (no font dependency in the SVG).
// node tools/brand/make-wordmark.js
'use strict';
const fs = require('fs');
const path = require('path');
const { Font } = require('fonteditor-core');

const root = path.resolve(__dirname, '..', '..');
// TTF sources (the wiki serves WOFF2; outlines are read from the TTF kept next to this script)
const fontsDir = process.env.FONT_SRC_DIR || path.join(__dirname, 'fonts');
const outDir = path.join(root, 'wiki', 'assets', 'brand');

function glyphPath(glyph, scale, ox, oy) {
  // fonteditor-core contours: arrays of {x,y,onCurve} (TrueType quadratic)
  let d = '';
  for (const contour of glyph.contours || []) {
    const pts = contour;
    if (!pts.length) continue;
    // find first on-curve point
    let start = pts.findIndex((p) => p.onCurve);
    if (start < 0) start = 0;
    const P = (i) => pts[(start + i) % pts.length];
    const X = (p) => (ox + p.x * scale).toFixed(2);
    const Y = (p) => (oy - p.y * scale).toFixed(2);
    d += `M${X(P(0))} ${Y(P(0))}`;
    let i = 1;
    while (i <= pts.length) {
      const p = P(i);
      if (p.onCurve) { d += `L${X(p)} ${Y(p)}`; i++; }
      else {
        const next = P(i + 1);
        if (next.onCurve) { d += `Q${X(p)} ${Y(p)} ${X(next)} ${Y(next)}`; i += 2; }
        else { const mid = { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 }; d += `Q${X(p)} ${Y(p)} ${X(mid)} ${Y(mid)}`; i += 1; }
      }
    }
    d += 'Z';
  }
  return d;
}

function render(text, { fontFile, size = 40, tracking = 0.08, fill = '#e3c16f' }) {
  const buf = fs.readFileSync(path.join(fontsDir, fontFile));
  const font = Font.create(buf, { type: 'ttf', hinting: false, compound2glyph: true });
  const data = font.get();
  const upm = data.head.unitsPerEm;
  const scale = size / upm;
  const byCode = new Map(data.glyf.map((g) => [g.unicode && g.unicode[0], g]));
  let x = 0;
  const paths = [];
  const baseline = size * 0.78;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const g = byCode.get(code);
    if (!g) { x += size * 0.3; continue; }
    if (g.contours && g.contours.length) paths.push(glyphPath(g, scale, x, baseline));
    x += (g.advanceWidth || upm * 0.5) * scale + size * tracking;
  }
  const width = Math.ceil(x);
  const height = Math.ceil(size);
  return { width, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path fill="${fill}" fill-rule="nonzero" d="${paths.join(' ')}"/></svg>\n` };
}

fs.mkdirSync(outDir, { recursive: true });
const wm = render('WESTERNIS', { fontFile: 'Cinzel[wght].ttf', size: 40, tracking: 0.10 });
fs.writeFileSync(path.join(outDir, 'wordmark.svg'), wm.svg);
const tag = render('CHRONICLES OF THE WEST', { fontFile: 'Cinzel[wght].ttf', size: 14, tracking: 0.18, fill: '#b9a77a' });
fs.writeFileSync(path.join(outDir, 'tagline.svg'), tag.svg);
// logo.svg = emblem + wordmark side by side (fallback logo for skins other than Citizen)
const icon = fs.readFileSync(path.join(outDir, 'icon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<svg[^>]*>/, '<g transform="translate(0,4) scale(0.4)">').replace('</svg>', '</g>');
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wm.width + 52} 48" width="${wm.width + 52}" height="48">${icon}<g transform="translate(50,4)">${wm.svg.replace(/<\?xml[^>]*>/, '').replace(/<svg[^>]*>/, '').replace('</svg>', '')}</g></svg>\n`;
fs.writeFileSync(path.join(outDir, 'logo.svg'), logo);
console.log('wordmark', wm.width, 'x', wm.height, '| tagline', tag.width, 'x', tag.height, '| logo written');
