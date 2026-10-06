#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Westernis world chart, raster edition: renders content/files/Westernis_map.svg (from make-map.js) to a
// 4200 x 2100 WebP, the image Map:Westernis actually shows.  Leaflet scales its background with CSS
// transforms while zooming; with a dense vector chart (≈3000 shapes) Chromium re-rasterises the SVG on
// every animation step and the page stalls for seconds, a bitmap is simply scaled on the GPU.
// The SVG stays the source art.  Its embedded TTF subsets are handed to resvg, each renamed to the
// family the SVG asks for, so the lettering matches the browser rendering.
//   node tools/brand/raster-map.js            (after make-map.js; then wiki.ps1 sync + seed -ForceFiles)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Font } = require('fonteditor-core');
const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');

const root = path.resolve(__dirname, '../..');
const SRC = path.join(root, 'content/files/Westernis_map.svg');
const OUT = path.join(root, 'content/files/Westernis_map.webp');
const WIDTH = 4200;   // 1.5x the chart's units: sharp at the map's max zoom on a 2x screen

const svg = fs.readFileSync(SRC, 'utf8');
const W = +svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)[1];
const scale = WIDTH / W;

// resvg panics (geom.rs unwrap) when the chart's rectangular clip-path="url(#inner)" group meets the
// rhumb lines that run far past the sheet.  The clip is reproduced exactly instead: render the chart
// unclipped (A) and the sheet without its chart (B: paper, stains, creases, frame), then paste A's inner
// rectangle onto B.  Inside the rectangle the original equals A, outside it equals B.
const rect = svg.match(/<clipPath id="inner"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/);
const open = '<g clip-path="url(#inner)">';
const start = svg.indexOf(open);
if (!rect || start < 0) throw new Error('inner clip group not found in ' + SRC);
let end = -1;
{
  const tag = /<g[\s>]|<\/g>/g;
  let depth = 0;
  tag.lastIndex = start;
  for (let m; (m = tag.exec(svg));) {
    depth += m[0] === '</g>' ? -1 : 1;
    if (!depth) { end = m.index; break; }
  }
}
if (end < 0) throw new Error('unbalanced <g> in ' + SRC);
const unclipped = svg.slice(0, start) + '<g>' + svg.slice(start + open.length);
const sheetOnly = svg.slice(0, start) + svg.slice(end + 4);

// The embedded subsets, renamed to the families the SVG uses (WstMapCaps …).  resvg-js 2.6 mishandles
// its fontBuffers option (it silently falls back to all defaults: system fonts, no fitTo), so they go
// to a temporary folder and are passed as fontFiles.
const fontDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-map-fonts-'));
const fontFiles = [];
for (const m of svg.matchAll(/@font-face\{font-family:'([^']+)';src:url\(data:font\/ttf;base64,([A-Za-z0-9+/=]+)\)/g)) {
  const [, family, b64] = m;
  const font = Font.create(Buffer.from(b64, 'base64'), { type: 'ttf' });
  const name = font.get().name;
  Object.assign(name, { fontFamily: family, preferredFamily: family, fullName: family, postScriptName: family.replace(/[^A-Za-z0-9-]/g, '') });
  const file = path.join(fontDir, family + '.ttf');
  fs.writeFileSync(file, Buffer.from(font.write({ type: 'ttf' })));
  fontFiles.push(file);
}
if (!fontFiles.length) throw new Error('no embedded fonts found in ' + SRC);

const render = (src) => new Resvg(src, {
  fitTo: { mode: 'width', value: WIDTH },
  font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'WstMapRoman' },
  textRendering: 2,      // geometricPrecision: no hinting, letter-spaced capitals stay even
}).render().asPng();

(async () => {
  const [x, y, w, h] = rect.slice(1, 5).map((v) => Math.round(+v * scale));
  const chart = await sharp(render(unclipped)).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  const info = await sharp(render(sheetOnly))
    .composite([{ input: chart, left: x, top: y }])
    .webp({ quality: 84, effort: 6, smartSubsample: true })
    .toFile(OUT);
  console.log(`${path.relative(root, OUT)}  ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KB, ${fontFiles.length} fonts`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(fontDir, { recursive: true, force: true }));
