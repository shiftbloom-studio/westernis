#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Draws the world chart content/files/Westernis_map.svg (2800 x 1400) in the manner of a hand-inked
// Middle-earth map: aged parchment; an inked coast with engraved water-lines; mountain chains of
// hand-shaded peaks with spurs and foothills; mixed woods of tiny broadleaf and fir trees; rivers that
// meander and swell from source to mouth, with tributaries; walled cities, towns, towers and ruins on a
// dotted road network; Mordor in its ring of mountains; and, across the Great Sea at the far western
// edge, the coast of Westernis itself, reached by the Straight Road. The cartouche, the compass rose
// (with rhumb lines) and the scale bar sit in the open sea.
//
// Labels are set in the theme's own fonts, cut down to the characters used and embedded as data: URIs
// (an SVG shown as an <img> cannot load web fonts). They follow a period hierarchy — regions in spaced
// capitals, natural features in italic, towns in small roman — and are placed by a small collision
// search (font metrics from the real fonts), so no name sits on a peak, a town or another name; trees,
// hills and waves under a name are cleared away, as an engraver would.
//
// The geography is pinned to the markers on Map:Westernis: 1 map unit = 20 px and the old 2000-px chart
// now starts 800 px from the west edge, so the DataMaps page must use
//   "background": { "image": "Westernis map.webp", "at": [[-40, 0], [100, 70]] }
// (the page shows the raster made by raster-map.js: zooming a vector this dense stalls Chromium).
// Seeded, so the chart is stable between runs.   node tools/brand/make-map.js [out.svg]; node tools/brand/raster-map.js
// MAP_DEBUG=1 prints every label with its placement cost and what it still touches.
'use strict';
const fs = require('fs');
const path = require('path');
const { Font } = require('fonteditor-core');
const wawoff2 = require('wawoff2');

const root = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'content', 'files', 'Westernis_map.svg');
const W = 2800, H = 1400;
const OX = 800;                                   // Middle-earth is drawn 800 px east of the west edge
const mu = (x, y) => [OX + x * 20, y * 20];       // DataMaps map units -> px
const INK = '#3a2915', INK2 = '#6b5232', RIVER = '#35546a', RED = '#7e2a17', PAPER = '#ecdcb3';
const CARD = '#f3e7c6', DUSK = '#2b1a10';
const EDGE = 40;                                  // inner edge of the frame
const MARGIN = 50;                                // no lettering closer than this to the edge
// where the DataMaps markers stand: lettering keeps a little clear of them
const MARKERS = [mu(33, 55), mu(76, 49), mu(60, 49), mu(44, 23.1), mu(32, 25.2), mu(61, 50.4)];
const MARKER_PX = [40, 40, 32, 32, 26, 28];       // their icon sizes on Map:Westernis (screen px)

// ---------------------------------------------------------------- utils
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function noise1(seed) { const r = rng(seed), N = 4096, lat = Array.from({ length: N }, r); return (x) => { const i = Math.floor(x), t = x - i, u = t * t * (3 - 2 * t); const a = lat[((i % N) + N) % N], b = lat[(((i + 1) % N) + N) % N]; return a + (b - a) * u; }; }
const fbm = (n, x, o = 4) => { let s = 0, a = 1, f = 1, k = 0; for (let i = 0; i < o; i++) { s += a * (n(x * f + i * 19.7) - 0.5); k += a; a *= 0.5; f *= 2.1; } return s / k; };
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const poly = (pts, closed = false) => pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join('') + (closed ? 'Z' : '');
function rel(pts, closed = false) {   // compact relative polyline (rounded so the deltas never drift)
  let px = Math.round(pts[0][0] * 10), py = Math.round(pts[0][1] * 10);
  let d = `M${px / 10} ${py / 10}l`;
  for (let i = 1; i < pts.length; i++) {
    const x = Math.round(pts[i][0] * 10), y = Math.round(pts[i][1] * 10);
    if (x === px && y === py) continue;
    const dx = (x - px) / 10, dy = (y - py) / 10;
    d += `${dx}${dy < 0 ? '' : ' '}${dy} `.replace(/ -/g, '-');
    px = x; py = y;
  }
  return d.trim() + (closed ? 'z' : '');
}
// a pen that writes compact relative path data (relief glyphs number in the hundreds; every byte counts)
const r1 = (v) => Math.round(v * 10) / 10;
class Pen {
  constructor() { this.d = ''; this.x = 0; this.y = 0; }
  put(c, nums) { this.d += c + nums.map((v, i) => { const t = f1(v); return i && t[0] !== '-' ? ' ' + t : t; }).join(''); return this; }
  M(x, y) { const X = r1(x), Y = r1(y); this.put(this.d ? 'm' : 'M', this.d ? [X - this.x, Y - this.y] : [X, Y]); this.x = X; this.y = Y; return this; }
  L(x, y) { const X = r1(x), Y = r1(y); this.put('l', [X - this.x, Y - this.y]); this.x = X; this.y = Y; return this; }
  Q(cx, cy, x, y) { const X = r1(x), Y = r1(y); this.put('q', [r1(cx) - this.x, r1(cy) - this.y, X - this.x, Y - this.y]); this.x = X; this.y = Y; return this; }
  C(ax, ay, bx, by, x, y) { const X = r1(x), Y = r1(y); this.put('c', [r1(ax) - this.x, r1(ay) - this.y, r1(bx) - this.x, r1(by) - this.y, X - this.x, Y - this.y]); this.x = X; this.y = Y; return this; }
  // a quadratic from the current point to b, bowed outward (+) or inward (-) by bulge x its length
  bow(b, bulge) { const a = [this.x, this.y], l = dist(a, b) || 1, dx = (b[0] - a[0]) / l, dy = (b[1] - a[1]) / l; return this.Q((a[0] + b[0]) / 2 + dy * bulge * l, (a[1] + b[1]) / 2 - dx * bulge * l, b[0], b[1]); }
}
function curve(pts, closed = false) {   // Catmull-Rom through the points, as cubic Béziers
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${f1(P[1][0])} ${f1(P[1][1])}`;
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}
function spline(pts, step = 4) {        // dense samples of the same curve curve() draws (open)
  const P = [pts[0], ...pts, pts[pts.length - 1]], out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2], n = Math.max(1, Math.ceil(dist(p1, p2) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const c = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([c(0), c(1)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function resample(pts, step) {   // evenly spaced points along a polyline
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    let d = step - carry;
    while (d <= len) { out.push([lerp(x0, x1, d / len), lerp(y0, y1, d / len)]); d += step; }
    carry = len - (d - step);
  }
  if (dist(out[out.length - 1], pts[pts.length - 1]) > step * 0.3) out.push(pts[pts.length - 1]);
  return out;
}
const cum = (pts) => pts.reduce((c, p, i) => (c.push(i ? c[i - 1] + dist(pts[i - 1], p) : 0), c), []);
function at(pts, c, s) {                // point and unit tangent at arc length s
  s = clamp(s, 0, c[c.length - 1]);
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const seg = c[hi] - c[lo] || 1, t = (s - c[lo]) / seg, a = pts[lo], b = pts[hi];
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), (b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
}
function tangents(pts) {
  return pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], l = dist(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });
}
// offset along the normal (-ty, tx): for a line drawn west -> east that is "south", i.e. below the text
const offset = (pts, d) => { const T = tangents(pts); return pts.map((p, i) => [p[0] - T[i][1] * d, p[1] + T[i][0] * d]); };
function smooth(pts, win) {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const w = Math.min(win, i, pts.length - 1 - i);
    let x = 0, y = 0;
    for (let j = i - w; j <= i + w; j++) { x += pts[j][0]; y += pts[j][1]; }
    return [x / (2 * w + 1), y / (2 * w + 1)];
  });
}
function fractal(pts, depth, rough, seed, closed = false) {   // midpoint displacement: a crinkled coast
  const r = rng(seed);
  let P = closed ? [...pts, pts[0]] : pts.slice(), amp = rough;
  for (let d = 0; d < depth; d++) {
    const Q = [P[0]];
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], len = dist(a, b) || 1, k = (r() - 0.5) * len * amp;
      Q.push([(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * k, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * k], b);
    }
    P = Q; amp *= 0.88;
  }
  return closed ? P.slice(0, -1) : P;
}
function inPoly(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
function blob(cx, cy, rx, ry, seed, rough = 0.22, n = 48) {   // irregular closed outline
  const nz = noise1(seed);
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; const k = 1 + rough * fbm(nz, i * 0.35, 3) * 2; return [cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]; });
}

// ---------------------------------------------------------------- collision space
// Every glyph that lettering must respect is registered as a box with a kind; a label's cost is the
// weighted overlap of its letters with those boxes.
const SC = 40, SPACE = new Map();
const WEIGHT = { peak: 9, town: 16, label: 26, orn: 80, marker: 3, river: 1.8, bigriver: 9, zone: 0, lake: 4, coast: 4, hill: 2.5, tree: 0.25, road: 0.5 };
function addBox(x0, y0, x1, y1, k) {
  const b = { x0, y0, x1, y1, k };
  for (let i = Math.floor(x0 / SC); i <= Math.floor(x1 / SC); i++) for (let j = Math.floor(y0 / SC); j <= Math.floor(y1 / SC); j++) {
    const key = i * 4096 + j;
    if (!SPACE.has(key)) SPACE.set(key, []);
    SPACE.get(key).push(b);
  }
  return b;
}
function hits(x0, y0, x1, y1) {
  const out = new Set();
  for (let i = Math.floor(x0 / SC); i <= Math.floor(x1 / SC); i++) for (let j = Math.floor(y0 / SC); j <= Math.floor(y1 / SC); j++) {
    for (const b of SPACE.get(i * 4096 + j) || []) if (b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1) out.add(b);
  }
  return out;
}

// ---------------------------------------------------------------- land mask (2-px cells)
const MW = W / 2, MH = H / 2, MASK = new Uint8Array(MW * MH);   // 0 sea, 1 land, 2 lake
function rasterize(P, val) {
  for (let j = 0; j < MH; j++) {
    const y = j * 2 + 1, xs = [];
    for (let i = 0, k = P.length - 1; i < P.length; k = i++) { const [xi, yi] = P[i], [xk, yk] = P[k]; if ((yi > y) !== (yk > y)) xs.push(xi + ((y - yi) * (xk - xi)) / (yk - yi)); }
    xs.sort((a, b) => a - b);
    for (let m = 0; m + 1 < xs.length; m += 2) for (let i = Math.max(0, Math.ceil((xs[m] - 1) / 2)); i <= Math.min(MW - 1, Math.floor((xs[m + 1] - 1) / 2)); i++) MASK[j * MW + i] = val;
  }
}
const cell = (x, y) => MASK[clamp(Math.floor(y / 2), 0, MH - 1) * MW + clamp(Math.floor(x / 2), 0, MW - 1)];
const isLand = (x, y) => cell(x, y) === 1;
const isSea = (x, y) => cell(x, y) === 0;

// distance to the nearest shore point (coasts, islands, lakes)
const SHORE = new Map(), SHC = 40;
function addShore(pts) { for (const p of resample(pts, 3)) { const k = Math.floor(p[0] / SHC) * 4096 + Math.floor(p[1] / SHC); if (!SHORE.has(k)) SHORE.set(k, []); SHORE.get(k).push(p); } }
function shoreDist(x, y) {
  let best = 1e9;
  const i0 = Math.floor(x / SHC), j0 = Math.floor(y / SHC);
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const p of SHORE.get(i * 4096 + j) || []) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < best) best = d; }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------- fonts: metrics, subset + embed
const FONTS = {};
// credit: family and copyright holder, kept next to the embedded subsets (all SIL OFL-1.1)
const useFont = (key, file, family, credit) => { FONTS[key] = { file, family, credit, chars: new Set([32]) }; return key; };
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
async function loadFonts() {
  for (const f of Object.values(FONTS)) {
    f.ttf = Buffer.from(await wawoff2.decompress(fs.readFileSync(path.join(root, 'wiki', 'assets', 'fonts', f.file))));
    const t = Font.create(f.ttf, { type: 'ttf' }).get();
    f.upm = t.head.unitsPerEm; f.cmap = t.cmap; f.glyf = t.glyf;
  }
}
const advance = (key, ch) => { const f = FONTS[key], g = f.glyf[f.cmap[ch.codePointAt(0)] ?? 0]; return (g.advanceWidth || f.upm * 0.5) / f.upm; };
function measure(key, str, size, tracking = 0) {
  const advs = [...str].map((ch) => advance(key, ch) * size), ls = tracking * size;
  return { advs, ls, width: advs.reduce((a, b) => a + b, 0) + ls * (advs.length - 1) };
}
// fixed text (ornaments), centred on (cx, cy)
function text(key, str, cx, cy, size, { tracking = 0, rotate = 0, fill = INK, opacity = 1, halo = false, weight } = {}) {
  const f = FONTS[key];
  for (const ch of str) f.chars.add(ch.codePointAt(0));
  const tr = `translate(${f1(cx)} ${f1(cy)})${rotate ? ` rotate(${rotate})` : ''}`;
  const h = halo ? ` stroke="${PAPER}" stroke-opacity="0.8" stroke-width="${f1(Math.min(5, size * 0.16))}" stroke-linejoin="round" paint-order="stroke"` : '';
  const { width } = measure(key, str, size, tracking);
  const ls = tracking ? ` letter-spacing="${f1(size * tracking)}"` : '';
  return `<text transform="${tr}" x="${f1(-width / 2)}" y="${f1(size * 0.34)}" font-family="${f.family}" font-size="${size}"${ls} fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ''}${weight ? ` font-weight="${weight}"` : ''}${h}>${esc(str)}</text>`;
}
async function fontFaces() {
  let css = '';
  for (const f of Object.values(FONTS)) {
    const sub = Font.create(f.ttf, { type: 'ttf', subset: [...f.chars], hinting: false, kerning: true });
    const b64 = Buffer.from(sub.write({ type: 'ttf', hinting: false })).toString('base64');
    css += `@font-face{font-family:'${f.family}';src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
  }
  const credits = [...new Set(Object.values(FONTS).map((f) => f.credit))].join('; ');
  return `<!-- Embedded font subsets (SIL Open Font License 1.1): ${credits}. See THIRD_PARTY_NOTICES.md in the Westernis repository. -->
<style>${css}</style>`;
}

// ================================================================ GEOGRAPHY (px of the 2800 x 1400 chart)
// ---- coasts. Middle-earth: north -> south down the west coast, then west -> east along the south coast.
const meCtrl = [
  [1100, -30], [1088, 40], [1062, 88], [1072, 138], [1042, 176], [1018, 216], [1034, 266], [1020, 312], [1040, 352], [1030, 392],   // Forlindon
  [1058, 402], [1090, 410], [1116, 420], [1130, 432], [1116, 446], [1088, 452], [1056, 460], [1028, 472],                              // Gulf of Lhûn
  [1016, 522], [1010, 582], [1030, 642], [1020, 700], [1046, 748], [1078, 778], [1094, 802], [1118, 842], [1150, 882], [1174, 918],   // Harlindon, Minhiriath
  [1188, 952], [1196, 986], [1178, 1022], [1150, 1062], [1132, 1102], [1126, 1142], [1150, 1170], [1204, 1182], [1266, 1200],        // Enedwaith, Andrast
  [1342, 1214], [1420, 1224], [1500, 1230], [1568, 1222], [1622, 1206], [1660, 1192], [1676, 1166], [1716, 1148], [1770, 1128],     // Anfalas, Dol Amroth
  [1834, 1114], [1900, 1110], [1960, 1120], [2010, 1140], [2046, 1162], [2080, 1180], [2112, 1200], [2152, 1234], [2200, 1264],     // Bay of Belfalas, Ethir
  [2252, 1300], [2290, 1344], [2318, 1396], [2334, 1440],                                                                               // Harondor
];
const wlCtrl = [   // Westernis, the far shore: north -> south, land to the west
  [318, -30], [300, 40], [334, 108], [376, 148], [342, 190], [296, 214], [262, 262], [286, 330], [332, 372], [374, 410], [356, 452],
  [302, 482], [268, 540], [250, 620], [278, 700], [302, 760], [276, 820], [232, 862], [214, 930], [240, 1010], [296, 1060], [332, 1110],
  [300, 1162], [258, 1222], [240, 1300], [262, 1440],
];
const meCoast = smooth(fractal(meCtrl, 4, 0.36, 11), 1);
const wlCoast = smooth(fractal(wlCtrl, 4, 0.4, 13), 1);
const meLand = [[W + 30, -30], ...meCoast, [W + 30, H + 30]];
const wlLand = [...wlCoast, [-30, H + 30], [-30, -30]];
const isle = (cx, cy, rx, ry, seed, n = 12) => smooth(fractal(blob(cx, cy, rx, ry, seed, 0.3, n), 3, 0.3, seed + 1, true), 1);
const islands = [
  isle(985, 172, 16, 22, 21), isle(1002, 212, 8, 9, 22), isle(964, 238, 6, 7, 23),          // off Forlindon
  isle(1890, 1196, 26, 10, 25, 14),                                                           // Tolfalas
  isle(416, 560, 18, 12, 27), isle(442, 590, 8, 7, 28), isle(392, 1196, 14, 10, 29), isle(420, 290, 10, 14, 30),  // the isles of the West
];
rasterize(meLand, 1); rasterize(wlLand, 1); islands.forEach((p) => rasterize(p, 1));
// ---- lakes (inside land)
const lake = (cx, cy, rx, ry, seed, n = 14) => smooth(fractal(blob(cx, cy, rx, ry, seed, 0.25, n), 3, 0.22, seed + 1, true), 1);
const lakes = {
  evendim: lake(1300, 246, 26, 15, 61), hithoel: lake(1962, 812, 7, 19, 62, 10), long: lake(2345, 306, 11, 38, 63, 12),
  rhun: lake(2636, 604, 80, 52, 64, 18), nurnen: lake(2604, 1090, 66, 26, 65, 16), west: lake(118, 770, 22, 14, 66),
};
Object.values(lakes).forEach((p) => rasterize(p, 2));
[meCoast, wlCoast, ...islands, ...Object.values(lakes)].forEach(addShore);
for (const p of resample(meCoast, 6).concat(resample(wlCoast, 6))) addBox(p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2, 'coast');
for (const l of Object.values(lakes)) for (const p of resample([...l, l[0]], 6)) addBox(p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2, 'lake');

// ---- rivers: hand-placed courses, meandered, then drawn as tapering ribbons
function meander(ctrl, amp, wl, seed) {
  const pts = spline(ctrl, 3), c = cum(pts), T = tangents(pts), nz = noise1(seed), L = c[c.length - 1];
  const out = pts.map((p, i) => {
    const s = c[i], fade = Math.min(1, s / 50, (L - s) / 50);
    const m = amp * fade * (fbm(nz, s / wl, 3) * 2.2 + 0.3 * Math.sin(s / (wl * 0.35)));
    return [p[0] - T[i][1] * m, p[1] + T[i][0] * m];
  });
  return resample(smooth(out, 2), 3.5);
}
const RIVERS = {};
const river = (id, ctrl, w0, w1, { amp = 6, wl = 46, into = null, seed = 1 } = {}) => {
  if (into) { const P = RIVERS[into].pts, end = ctrl[ctrl.length - 1]; let best = P[0]; for (const p of P) if (dist(p, end) < dist(best, end)) best = p; ctrl = [...ctrl.slice(0, -1), best]; }
  RIVERS[id] = { pts: meander(ctrl, amp, wl, seed), w0, w1 };
};
river('anduin', [[1805, 186], [1840, 252], [1872, 322], [1895, 392], [1906, 452], [1910, 520], [1912, 590], [1918, 650], [1936, 712], [1952, 766], [1962, 812], [1972, 858], [1992, 900], [2024, 934], [2048, 957], [2060, 995], [2066, 1040], [2060, 1090], [2052, 1128], [2047, 1150]], 0.8, 6, { amp: 7, wl: 52, seed: 3 });
river('ethirA', [[2050, 1120], [2034, 1140], [2026, 1160]], 2.6, 2.2, { amp: 0, seed: 4 });
river('ethirB', [[2056, 1124], [2070, 1150], [2086, 1176]], 2.6, 2.2, { amp: 0, seed: 5 });
river('celebrant', [[1786, 622], [1820, 664], [1866, 682], [1934, 704]], 0.5, 2.2, { into: 'anduin', seed: 6 });
river('gladden', [[1782, 520], [1830, 548], [1876, 556], [1912, 566]], 0.5, 1.8, { into: 'anduin', seed: 7 });
river('limlight', [[1822, 782], [1872, 772], [1942, 744]], 0.5, 1.8, { into: 'anduin', seed: 8 });
river('entwash', [[1800, 858], [1842, 890], [1900, 906], [1960, 908], [1994, 900]], 0.6, 2.6, { into: 'anduin', amp: 6, seed: 9 });
river('erui', [[1946, 1016], [1990, 1046], [2030, 1066], [2064, 1070]], 0.5, 1.8, { into: 'anduin', seed: 10 });
river('morgulduin', [[2152, 994], [2110, 1006], [2066, 1012]], 0.5, 1.6, { into: 'anduin', seed: 11 });
river('forest', [[2190, 252], [2260, 272], [2320, 290], [2340, 290]], 0.5, 1.8, { seed: 12 });
river('celduin', [[2348, 344], [2376, 420], [2428, 488], [2490, 548], [2560, 594]], 1.4, 3.2, { amp: 7, seed: 13 });
river('carnen', [[2620, 238], [2600, 330], [2580, 420], [2532, 520]], 0.5, 1.8, { into: 'celduin', seed: 14 });
river('baranduin', [[1302, 262], [1312, 310], [1326, 372], [1334, 420], [1336, 456], [1326, 520], [1292, 592], [1240, 650], [1182, 708], [1124, 756], [1086, 784]], 0.9, 3.6, { amp: 8, wl: 40, seed: 15 });
river('lhun', [[1236, 120], [1214, 210], [1188, 300], [1154, 380], [1132, 428]], 0.6, 2.6, { seed: 16 });
river('mitheithel', [[1630, 170], [1614, 260], [1602, 360], [1598, 458], [1596, 520], [1592, 578], [1552, 640], [1494, 700], [1436, 748], [1402, 768], [1336, 818], [1262, 870], [1212, 904], [1176, 920]], 0.7, 4.4, { amp: 7, seed: 17 });
river('bruinen', [[1748, 428], [1716, 452], [1684, 474], [1646, 486], [1620, 520], [1594, 572]], 0.6, 2.2, { into: 'mitheithel', seed: 18 });
river('glanduin', [[1724, 704], [1650, 690], [1580, 676], [1520, 672]], 0.5, 1.8, { into: 'mitheithel', seed: 19 });
river('isen', [[1702, 914], [1696, 942], [1666, 962], [1600, 970], [1500, 964], [1404, 968], [1300, 978], [1230, 984], [1197, 986]], 0.7, 3, { amp: 6, seed: 20 });
river('morthond', [[1520, 1074], [1532, 1140], [1548, 1226]], 0.5, 2, { seed: 21 });
river('gilrain', [[1760, 1052], [1770, 1096], [1776, 1132]], 0.5, 1.8, { seed: 22 });
river('nurnA', [[2520, 1150], [2560, 1112], [2580, 1100]], 0.4, 1.4, { amp: 3, seed: 23 });
river('nurnB', [[2700, 1150], [2660, 1110], [2640, 1098]], 0.4, 1.4, { amp: 3, seed: 24 });
river('westR', [[96, 520], [150, 640], [190, 760], [214, 860], [232, 870]], 0.6, 3, { amp: 8, seed: 25 });
const riverD = (r) => {
  const { pts, w0, w1 } = r, c = cum(pts), L = c[c.length - 1], T = tangents(pts), left = [], right = [];
  pts.forEach((p, i) => { const w = (w0 + (w1 - w0) * Math.pow(c[i] / L, 0.75)) / 2; left.push([p[0] - T[i][1] * w, p[1] + T[i][0] * w]); right.push([p[0] + T[i][1] * w, p[1] - T[i][0] * w]); });
  return rel([...left, ...right.reverse()], true);
};
const nearRiver = (x, y, pad) => { for (const r of Object.values(RIVERS)) for (let i = 0; i < r.pts.length; i += 2) { const p = r.pts[i]; if (Math.abs(p[0] - x) < pad + 3 && Math.abs(p[1] - y) < pad + 3) return true; } return false; };
for (const r of Object.values(RIVERS)) for (const p of resample(r.pts, 7)) addBox(p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3, r === RIVERS.anduin ? 'bigriver' : 'river');
const anduinX = (y) => { let best = null; for (const p of RIVERS.anduin.pts) if (!best || Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p; return best[0]; };

// ---- settlements
const TOWNS = [
  // [label, x, y, glyph, label size, font, preferred label offsets]
  ['Minas Tirith', ...mu(60, 49), 'city', 17, 'caps', [[-66, -27], [-58, -32], [-74, -22]]],   // north-west, over the mountain's end
  ['Osgiliath', 2050, 957, 'ruin', 16],
  ['Pelargir', 2052, 1094, 'town', 16],
  ['Edoras', 1772, 958, 'hall', 16],
  ['Isengart', 1700, 912, 'orthanc', 16],
  ['Bruchtal', ...mu(44, 23.1), 'haven', 17],
  ['Bree', 1408, 452, 'town', 16],
  ['Hobbingen', 1268, 432, 'town', 16],
  ['Grauhafen', 1136, 428, 'haven', 16],
  ['Dol Guldur', 2014, 590, 'darktower', 16],
  ['Esgaroth', 2345, 318, 'town', 15],
  ['Dol Amroth', 1660, 1180, 'castle', 15],
  ['Minas Morgul', 2136, 992, 'tower', 15],
  ['Barad-dûr', 2522, 860, 'baraddur', 16],
  ['Morannon', 2192, 836, 'gate', 14],
  ['Wetterspitze', 1520, 446, 'ruin', 14],
  ['Tharbad', 1404, 768, 'ruin', 14],
];
const TOWN_R = { city: 12, town: 6, hall: 7, ruin: 7, orthanc: 10, haven: 8, darktower: 9, castle: 8, tower: 8, baraddur: 12, gate: 8 };
for (const [, x, y, g] of TOWNS) { const r = TOWN_R[g]; addBox(x - r, y - r * (g === 'baraddur' || g === 'tower' || g === 'darktower' || g === 'orthanc' ? 2.2 : 1), x + r, y + r, 'town'); }
for (const [x, y] of MARKERS) addBox(x - 20, y - 20, x + 20, y + 20, 'marker');
MARKERS.forEach(([x, y], i) => { const r = MARKER_PX[i] / 2 / 0.4; addBox(x - r, y - r * (i === 4 ? 2 : 1), x + r, y + (i === 4 ? 0 : r), 'zone'); });

// ---- roads (dotted)
const ROADS = [
  [[1136, 430], [1200, 436], [1268, 432], [1336, 446], [1408, 452], [1462, 454], [1520, 448], [1562, 452], [1598, 458], [1650, 470], mu(44, 23.1)],   // Große Oststraße
  [mu(44, 23.1), [1722, 474], [1766, 482], [1822, 472], [1870, 460], [1906, 452]],                                                                     // over the High Pass
  [[1906, 452], [1980, 446], [2060, 440], [2140, 446], [2220, 438], [2300, 432]],                                                                      // Old Forest Road
  [[1388, 300], [1400, 380], [1408, 452], [1416, 540], [1410, 650], [1404, 768], [1478, 832], [1576, 890], [1650, 934], [1690, 946]],                  // Greenway
  [[1690, 946], [1772, 958], [1852, 962], [1926, 958], [1972, 968], mu(60, 49)],                                                                         // Great West Road
  [mu(60, 49), [2026, 966], [2050, 957], [2090, 962], [2114, 978], [2136, 992]],                                                                        // to Osgiliath and the Morgul Vale
  [mu(60, 49), [2016, 1020], [2036, 1060], [2052, 1094]],                                                                                               // to Pelargir
];
const roadPts = ROADS.map((r) => spline(r, 4));
for (const r of roadPts) for (const p of resample(r, 8)) addBox(p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2, 'road');
const nearRoad = (x, y, pad) => roadPts.some((r) => r.some((p) => Math.abs(p[0] - x) < pad && Math.abs(p[1] - y) < pad));

/// ---- relief: peaks and hills, collected and later drawn back to front
const relief = [];
const BANDS = [];   // a faint wash under each chain, so it reads as a mass when the chart is small
const townClear = (x, y, pad) => TOWNS.some(([, tx, ty, g]) => Math.abs(tx - x) < TOWN_R[g] + pad && Math.abs(ty - y) < TOWN_R[g] + pad);
function addPeak(x, y, h, o = {}) {
  if (!isLand(x, y - 2) || !isLand(x, y - h * 0.5)) return;
  if (townClear(x, y - h / 2, h * 0.6) || nearRiver(x, y, 5)) return;
  const r = rng(Math.round(x * 31 + y * 17));
  relief.push({ x, y, h, w: h * (o.wide || 1.05) * (0.85 + r() * 0.3), tone: o.tone || 'ink', hill: false });
}
function addHill(x, y, w, o = {}) {
  if (!isLand(x, y) || !isLand(x, y - w * 0.5) || townClear(x, y, w) || nearRiver(x, y, 4) || nearRoad(x, y, 6)) return;
  relief.push({ x, y, h: w * (0.36 + 0.14 * Math.abs(Math.sin(x * 0.37 + y))), w, tone: o.tone || 'ink', hill: true });
}
// A mountain chain along a spine. Peaks are spaced by their own size, so big massifs breathe and small
// saddles crowd; the belt swells and narrows (breadth noise), carries one to three peaks abreast, sinks
// at passes, throws off spurs and is fringed with foothills.
function range(ctrl, o) {
  const r = rng(o.seed), nz = noise1(o.seed + 5), nw = noise1(o.seed + 6);
  const sp = spline(ctrl, 3), c = cum(sp), L = c[c.length - 1];
  const pass = (s) => (o.passes || []).reduce((k, [t, hw]) => k * (1 - 0.6 * Math.exp(-(((s / L - t) / hw) ** 2))), 1);
  const env = (s) => Math.pow(Math.sin(Math.PI * clamp(s / L, 0.02, 0.98)), 0.5) * pass(s);
  const mass = (s) => clamp(0.62 + fbm(nz, s / 120, 3) * 2.6, 0.25, 1.2);
  const breadth = (s) => clamp(0.65 + fbm(nw, s / 150, 2) * 2.4, 0.3, 1.3);
  const half = (s) => o.width * breadth(s) * (0.35 + 0.65 * env(s));
  const pos = (s, off) => { const [x, y, tx, ty] = at(sp, c, s); return [x - ty * off, y + tx * off]; };
  let s = r() * 6;
  while (s < L) {
    const e = env(s), m = mass(s), hw = half(s);
    const h = lerp(o.size[0], o.size[1], clamp(e * m * (0.78 + r() * 0.4), 0, 1.1));
    const n = hw > h * 1.15 ? 3 : hw > h * 0.6 ? 2 : 1;
    for (const k of n === 3 ? [-1, 1, 0] : n === 2 ? [-0.5, 0.5] : [0]) {
      const [x, y] = pos(s + (r() - 0.5) * h * 0.5, k * hw * (0.85 + r() * 0.3) + (r() - 0.5) * h * 0.3);
      addPeak(x, y, h * (k === 0 ? 1 : 0.6 + r() * 0.28), o);
    }
    s += h * (o.gap || 0.9) * (0.7 + r() * 0.55);
  }
  for (const [t, side, len, ang] of o.spurs || []) {          // side-ridges that run off the main chain
    const [x0, y0, tx, ty] = at(sp, c, t * L), a = Math.atan2(tx * side, -ty * side) + ang, h0 = lerp(o.size[0], o.size[1], env(t * L) * mass(t * L));
    for (let d = half(t * L) + h0 * 0.5; d < len; ) {
      const k = 1 - d / len, h = Math.max(o.size[0] * 0.55, h0 * (0.4 + 0.45 * k) * (0.85 + r() * 0.3));
      addPeak(x0 + Math.cos(a) * d + (r() - 0.5) * 5, y0 + Math.sin(a) * d + (r() - 0.5) * 5, h, o);
      d += h * (0.75 + r() * 0.35);
    }
  }
  if (o.foot) for (const side of [-1, 1]) {                   // foothills along both flanks
    for (let s2 = r() * 14; s2 < L; s2 += 13 + r() * 16) {
      if (r() > o.foot * 0.75 * env(s2)) continue;
      const [, , tx] = at(sp, c, s2), up = side * tx < -0.4 ? o.size[1] * 0.7 : 0;   // the uphill (northern) flank is hidden by the peaks
      const [x, y] = pos(s2, side * (half(s2) + 12 + up + r() * 14));
      addHill(x, y, 7 + r() * 6, o);
    }
  }
  // the wash: a soft band covering the belt, lifted by half a peak (the peaks rise above their feet)
  const band = resample(sp, 12), T = tangents(band), cb = cum(band);
  for (const k of [1.35, 1, 0.65]) {   // three nested washes fake a soft edge
    const Lft = [], Rgt = [];
    band.forEach((p, i) => { const hw = (half(cb[i]) + 10) * k, lift = lerp(o.size[0], o.size[1], env(cb[i])) * 0.45; Lft.push([p[0] - T[i][1] * hw, p[1] + T[i][0] * hw - lift]); Rgt.push([p[0] + T[i][1] * hw, p[1] - T[i][0] * hw - lift]); });
    BANDS.push({ pts: [...Lft, ...Rgt.reverse()], tone: o.tone || 'ink' });
  }
  return sp;
}
const SPINES = {};
SPINES.misty = range([[1742, 92], [1762, 160], [1772, 232], [1770, 312], [1756, 392], [1752, 452], [1766, 520], [1778, 590], [1768, 660], [1748, 730], [1728, 800], [1712, 858]],
  { seed: 101, size: [16, 44], width: 44, gap: 0.8, foot: 0.75, passes: [[0.47, 0.035], [0.71, 0.03]], spurs: [[0.16, 1, 74, 0.35], [0.36, -1, 58, -0.3], [0.6, 1, 80, -0.3], [0.84, -1, 56, 0.35], [0.27, 1, 50, -0.2], [0.93, 1, 46, 0.5]] });
SPINES.grey = range([[1806, 142], [1880, 128], [1958, 140], [2040, 124], [2120, 120], [2198, 134], [2268, 152]],
  { seed: 102, size: [13, 28], width: 18, foot: 0.45, spurs: [[0.45, 1, 44, 0.3], [0.75, 1, 36, -0.3]] });
SPINES.luinN = range([[1094, 56], [1108, 140], [1102, 230], [1094, 312], [1084, 380]], { seed: 103, size: [12, 26], width: 16, foot: 0.45 });
SPINES.luinS = range([[1074, 488], [1066, 556], [1078, 632], [1072, 712]], { seed: 104, size: [12, 23], width: 14, foot: 0.4 });
SPINES.white = range([[1300, 1088], [1384, 1066], [1470, 1052], [1560, 1054], [1650, 1038], [1740, 1034], [1820, 1022], [1886, 1006], [1934, 994], [1964, 990]],
  { seed: 105, size: [15, 38], width: 26, gap: 0.85, foot: 0.65, spurs: [[0.18, 1, 62, 0.45], [0.42, 1, 78, -0.15], [0.62, 1, 58, 0.3], [0.8, 1, 44, -0.2], [0.07, -1, 40, -0.4]] });
SPINES.lithui = range([[2192, 812], [2252, 798], [2332, 790], [2420, 794], [2510, 782], [2600, 790], [2690, 774], [2800, 782]],
  { seed: 106, size: [13, 30], width: 22, tone: 'ash', wide: 0.8, spurs: [[0.55, 1, 60, 0.15]] });
SPINES.ephel = range([[2194, 826], [2170, 880], [2158, 940], [2160, 1000], [2172, 1060], [2196, 1110], [2240, 1148], [2310, 1166], [2400, 1174], [2490, 1166], [2580, 1178], [2680, 1168], [2800, 1178]],
  { seed: 107, size: [13, 32], width: 22, tone: 'dark', wide: 0.72, passes: [[0.17, 0.02]], spurs: [[0.62, -1, 44, 0.25], [0.4, -1, 36, -0.3]] });
range([[2230, 878], [2224, 940], [2232, 1000], [2250, 1050]], { seed: 108, size: [7, 12], width: 4, gap: 1.9, tone: 'dark', wide: 0.9 });   // Morgai, the inner ridge
SPINES.iron = range([[2520, 214], [2580, 202], [2650, 212], [2720, 202]], { seed: 109, size: [12, 22], width: 14, foot: 0.4 });
range([[150, 56], [124, 200], [104, 360], [86, 520], [64, 660]], { seed: 110, size: [22, 56], width: 36, gap: 0.78, tone: 'far' });   // mountains of the West
range([[96, 880], [80, 1040], [92, 1190], [116, 1340]], { seed: 111, size: [18, 44], width: 28, gap: 0.8, tone: 'far' });
// Erebor, the Lonely Mountain, with its spurs
addPeak(2330, 252, 58, { wide: 1.05 }); addPeak(2300, 262, 26); addPeak(2362, 264, 30); addPeak(2316, 270, 16); addPeak(2346, 272, 18);
// downs and hill-country
const hillCluster = (cx, cy, rx, ry, n, seed, o) => {   // spaced so humps overlap a little, never heap up
  const r = rng(seed), got = [];
  for (let tries = 0; got.length < n && tries < n * 12; tries++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()), x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d, w = 9 + r() * 8;
    if (got.some(([gx, gy, gw]) => Math.abs(gx - x) < (gw + w) * 0.8 && Math.abs(gy - y) < 9)) continue;
    got.push([x, y, w]); addHill(x, y, w, o);
    if (r() < 0.35) addHill(x + w * 1.15, y + 3 + r() * 2, w * (0.5 + r() * 0.25), o);
  }
};
hillCluster(1506, 392, 24, 36, 8, 201);    // Wetterberge
hillCluster(1404, 540, 34, 18, 9, 202);    // Hügelgräberhöhen
hillCluster(1186, 470, 22, 10, 4, 203);    // Turmberge
hillCluster(1380, 312, 46, 18, 7, 204);    // Nordhöhen
hillCluster(1950, 806, 40, 34, 13, 205);   // Emyn Muil
hillCluster(1250, 520, 40, 16, 5, 206);    // Weiße Höhen
hillCluster(2160, 372, 46, 22, 8, 207);    // Berge des Düsterwalds
hillCluster(2036, 770, 30, 18, 5, 208);    // Braune Lande
relief.sort((a, b) => a.y - b.y);
for (const p of relief) addBox(p.x - p.w * 0.85, p.y - p.h, p.x + p.w * 0.85, p.y, p.hill ? 'hill' : 'peak');

// ---- forests
const FORESTS = [
  // [outline, seed, { spacing, mix (share of firs), colour }]
  [fractal(blob(2122, 428, 150, 210, 31, 0.3, 30), 2, 0.25, 32, true), 41, { spacing: 10.5, mix: 0.72, color: '#9a8a5e', wash: '#5a5030', glades: [blob(2070, 330, 22, 14, 34), blob(2196, 524, 26, 16, 36), blob(2236, 300, 18, 12, 38), blob(2010, 470, 14, 22, 40)] }],   // Düsterwald
  [blob(1792, 828, 46, 40, 33), 43, { spacing: 10, mix: 0.45, color: '#a4976a', wash: '#5a5030' }],                     // Fangorn
  [blob(1852, 648, 42, 34, 35), 45, { spacing: 10, mix: 0, color: '#e2c25a', wash: '#b08a20' }],                         // Lórien (mallorn)
  [blob(1370, 494, 36, 26, 37), 47, { spacing: 10, mix: 0.25, color: '#bfb27c' }],                                       // Alter Wald
  [blob(1636, 410, 30, 26, 39), 49, { spacing: 11, mix: 0.6, color: '#b5a874' }],                                        // Trollhöhen
  [[[2086, 880], [2122, 870], [2140, 900], [2132, 958], [2130, 1024], [2140, 1084], [2124, 1126], [2092, 1128], [2082, 1078], [2084, 1012], [2074, 948]], 51, { spacing: 10, mix: 0.2, color: '#c6c088', ithilien: true }],   // Ithilien
  [blob(1948, 1030, 18, 12, 53), 53, { spacing: 10, mix: 0.4, color: '#b5a874' }],                                       // Drúadan-Wald
  [blob(1236, 1126, 44, 24, 55), 55, { spacing: 11, mix: 0.3, color: '#bfb27c' }],                                       // Anfalas woods
  [blob(2470, 470, 54, 34, 59, 0.3), 59, { spacing: 12, mix: 0.4, color: '#b5a874' }],                                  // eastern woods
  [blob(210, 420, 70, 60, 81), 81, { spacing: 11, mix: 0.3, color: '#d6c98c' }],                                         // woods of the West
  [blob(170, 1080, 60, 90, 83), 83, { spacing: 11, mix: 0.2, color: '#d6c98c' }],
];
const TREES = [];
for (const [outline, seed, o] of FORESTS) {
  const r = rng(seed), clump = noise1(seed + 9), xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]), sp = o.spacing;
  const tr = [];
  for (let y = Math.min(...ys); y < Math.max(...ys); y += sp * 0.82) {
    for (let x = Math.min(...xs) + ((Math.round(y / sp) % 2) * sp) / 2; x < Math.max(...xs); x += sp) {
      const jx = x + (r() - 0.5) * sp * 0.7, jy = y + (r() - 0.5) * sp * 0.5;
      if (!inPoly(jx, jy, outline) || !isLand(jx, jy) || !isLand(jx, jy - 10) || r() < 0.06) continue;
      if (o.ithilien && jx < anduinX(jy) + 10) continue;                  // Ithilien lies on the EAST bank
      if (o.glades && o.glades.some((g) => inPoly(jx, jy, g))) continue;   // clearings
      if (nearRiver(jx, jy - 3, 5) || nearRoad(jx, jy - 3, 5) || townClear(jx, jy, 8)) continue;
      if ([...hits(jx - 4, jy - 12, jx + 4, jy)].some((b) => b.k === 'peak' || b.k === 'hill' || b.k === 'lake')) continue;
      const fir = r() < o.mix + fbm(clump, jx / 60 + jy / 80, 2) * 0.8;   // firs grow in clumps
      tr.push({ x: jx, y: jy, t: fir ? (r() < 0.5 ? 'c1' : r() < 0.6 ? 'c2' : 'c3') : (r() < 0.45 ? 'd1' : r() < 0.6 ? 'd2' : 'd3'), color: o.color });
    }
  }
  TREES.push(...tr);
  o.trees = tr;
}
for (const t of TREES) addBox(t.x - 4, t.y - 12, t.x + 4, t.y, 'tree');

// ---- Mordor: the land inside the ring of mountains
const mordorIn = [...spline([[2196, 820], [2252, 806], [2332, 798], [2420, 802], [2510, 792], [2600, 798], [2690, 784], [2800, 790]], 8),
  [2800, 1166], ...spline([[2790, 1166], [2680, 1158], [2580, 1166], [2490, 1156], [2400, 1162], [2310, 1156], [2244, 1138], [2206, 1100], [2190, 1060], [2182, 1000], [2180, 940], [2186, 880], [2196, 820]], 8)];
const gorgoroth = blob(2390, 905, 170, 78, 71, 0.2);
const marsh = blob(2092, 826, 40, 20, 73, 0.3);
// marsh tufts: reeds fanning from a short water-line, hand-placed on a jittered grid
const TUFTS = [];
{ const r = rng(75); for (let y = 806; y < 850; y += 8) for (let x = 2046; x < 2140; x += 11) { const jx = x + (r() - 0.5) * 7, jy = y + (r() - 0.5) * 4; if (inPoly(jx, jy, marsh) && r() > 0.2) TUFTS.push([jx, jy, 0.8 + r() * 0.5]); } }

// ---- the open sea: ornaments live here
const COMPASS = { x: 520, y: 1000, r: 118 };
const CART = { x: 646, y: 206, w: 480, h: 226 };
const SCALE = { x: 664, y: 1268, len: 300 };
addBox(COMPASS.x - COMPASS.r - 30, COMPASS.y - COMPASS.r - 60, COMPASS.x + COMPASS.r + 30, COMPASS.y + COMPASS.r + 34, 'orn');
addBox(CART.x - CART.w / 2 - 30, CART.y - CART.h / 2 - 8, CART.x + CART.w / 2 + 30, CART.y + CART.h / 2 + 10, 'orn');
addBox(SCALE.x - 20, SCALE.y - 34, SCALE.x + SCALE.len + 20, SCALE.y + 30, 'orn');
// the Straight Road: from the Grey Havens out of the Gulf and over the sea to Westernis
const ROUTE = spline([[1126, 430], [1080, 432], [1030, 438], [950, 452], [850, 470], [760, 478], [660, 466], [560, 444], [470, 424], [400, 412]], 6);
const SHIP = { x: 778, y: 474 };
addBox(SHIP.x - 34, SHIP.y - 52, SHIP.x + 40, SHIP.y + 8, 'orn');

// ================================================================ LABELS
const LBL = [];   // placed labels: { key, str, size, ls, fill, opacity, halo, base, boxes }
const EXT = 24;   // the text path runs this far past each end of the lettering
function lettersOn(cl, m, size, hh) {
  const c = cum(cl), out = [];
  let s = EXT;
  m.advs.forEach((a) => { const [x, y, tx, ty] = at(cl, c, s + a / 2); const hx = (a / 2) * 0.92; out.push({ x, y, hx: Math.abs(tx) * hx + Math.abs(ty) * hh, hy: Math.abs(ty) * hx + Math.abs(tx) * hh }); s += a + m.ls; });
  return out;
}
function readable(cl) {   // text must not stand on its head: run west -> east, or bottom -> top when steep
  const dx = cl[cl.length - 1][0] - cl[0][0], dy = cl[cl.length - 1][1] - cl[0][1];
  return (dx < 0 && Math.abs(dx) > 0.3 * Math.abs(dy)) || (Math.abs(dx) <= 0.3 * Math.abs(dy) && dy > 0) ? cl.slice().reverse() : cl;
}
const HARD = new Set(['peak', 'town', 'label', 'orn', 'bigriver']);
function cost(L, spec) {
  let c = 0;
  for (const l of L) {
    const x0 = l.x - l.hx, y0 = l.y - l.hy, x1 = l.x + l.hx, y1 = l.y + l.hy, area = (x1 - x0) * (y1 - y0);
    if (x0 < MARGIN || y0 < MARGIN || x1 > W - MARGIN || y1 > H - MARGIN) c += 300;
    for (const b of hits(x0, y0, x1, y1)) {
      const w = (spec.soft && spec.soft[b.k]) ?? WEIGHT[b.k];
      c += (w * ((Math.min(x1, b.x1) - Math.max(x0, b.x0)) * (Math.min(y1, b.y1) - Math.max(y0, b.y0)))) / area * (HARD.has(b.k) ? 4 : 1);
    }
    if (spec.medium === 'land' && !isLand(l.x, l.y)) c += 6;
    if (spec.medium === 'sea' && !isSea(l.x, l.y)) c += 6;
  }
  return c;
}
// spec: { key, str, size, tracking, fill, opacity, halo, medium, cands: [centre-lines], bias, soft: {kind: weight}, clear: true }
// The cheapest candidate wins; with `clear`, the few peaks it still touches are taken out (an engraver's notch).
function place(spec) {
  const { key, str, size, tracking = 0 } = spec;
  const m = measure(key, str, size, tracking), hh = size * (key === 'fellI' || key === 'fell' ? 0.36 : 0.37);
  let best = null;
  spec.cands.forEach((cl0, idx) => {
    const cl = readable(cl0), c = cum(cl), L = c[c.length - 1], need = m.width + EXT * 2;
    if (L < need - 0.5) return;
    const s0 = (L - need) / 2, n = Math.ceil(need / 4), sub = [];   // the middle stretch of the candidate line
    for (let i = 0; i <= n; i++) sub.push(at(cl, c, s0 + (need * i) / n).slice(0, 2));
    const letters = lettersOn(sub, m, size, hh);
    const v = cost(letters, spec) + idx * (spec.bias ?? 0.08);
    if (!best || v < best.v) best = { v, sub, letters };
  });
  if (!best) { console.warn('could not place', str); return; }
  for (const ch of str) FONTS[key].chars.add(ch.codePointAt(0));
  for (const l of best.letters) addBox(l.x - l.hx - 3, l.y - l.hy - 3, l.x + l.hx + 3, l.y + l.hy + 3, 'label');
  if (spec.clear) for (const p of relief) if (best.letters.some((l) => p.x + p.w * 0.7 > l.x - l.hx && p.x - p.w * 0.7 < l.x + l.hx && p.y > l.y - l.hy && p.y - p.h * 0.8 < l.y + l.hy)) p.cleared = true;
  const base = offset(best.sub, size * (key === 'fellI' || key === 'fell' ? 0.3 : 0.35));
  LBL.push({ ...spec, m, base, boxes: best.letters, cost: best.v });
  if (process.env.MAP_DEBUG) { const k = {}; for (const l of best.letters) for (const b of hits(l.x - l.hx, l.y - l.hy, l.x + l.hx, l.y + l.hy)) k[b.k] = (k[b.k] || 0) + 1; console.log(`${str.padEnd(26)} cost ${best.v.toFixed(2)} ${JSON.stringify(k)}`); }
}
const straight = (cx, cy, len, rot = 0, arch = 0) => {   // a straight or gently arched centre-line
  const a = (rot * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a), out = [];
  for (let i = 0, n = Math.ceil(len / 6); i <= n; i++) { const u = -len / 2 + (len * i) / n, k = 1 - ((2 * u) / len) ** 2; out.push([cx + dx * u + dy * arch * k, cy + dy * u - dx * arch * k]); }
  return out;
};
const around = (x, y, offs, len, rot = 0, arch = 0) => offs.map(([dx, dy]) => straight(x + dx, y + dy, len, rot, arch));
// along a feature: offset copies of its (smoothed) line, at several distances and positions
function alongs(line, offs, centres, span) {
  const sm = smooth(resample(line, 4), 10), out = [];
  for (const d of offs) {
    const o = smooth(offset(sm, d), 6), c = cum(o), L = c[c.length - 1];
    for (const t of centres) {
      const s0 = clamp(t * L - span / 2, 0, L), s1 = clamp(t * L + span / 2, 0, L), sub = [];
      for (let s = s0; s <= s1; s += 4) sub.push(at(o, c, s).slice(0, 2));
      if (sub.length > 4) out.push(sub);
    }
  }
  return out;
}
// candidate offsets: the spot itself, then two rings of eight around it (steps sx, sy)
const NEAR = (sx, sy) => { const o = [[0, 0]]; for (const k of [1, 2]) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) o.push([a * sx * k, b * sy * k]); return o; };

function labelAll() {
  const cinzel = 'cinzel', fellI = 'fellI', fell = 'fell';
  // 1. settlements — small roman (the capital in small capitals), set beside the glyph: eight places
  //    close in, four further out; a town name may notch a peak or two out of a range, never cross the Anduin
  const tall = new Set(['baraddur', 'tower', 'darktower', 'orthanc']);
  for (const [name, x, y, g, size, style, prefer] of TOWNS) {
    const key = style === 'caps' ? cinzel : fell, tracking = style === 'caps' ? 0.1 : 0.02;
    const w = measure(key, name, size, tracking).width, r = TOWN_R[g] + 5, up = tall.has(g) ? r : 0;
    const offs = [[r + w / 2, -2], [-(r + w / 2), -2], [0, -(r + size * 0.6) - up], [0, r + size * 0.55],
      [r * 0.7 + w / 2, -r - size * 0.3], [-(r * 0.7 + w / 2), -r - size * 0.3], [r * 0.7 + w / 2, r + size * 0.3], [-(r * 0.7 + w / 2), r + size * 0.3],
      [r * 2 + w / 2, -2], [-(r * 2 + w / 2), -2], [0, -(r * 2 + size * 0.6) - up], [0, r * 2 + size * 0.55]];
    if (prefer) offs.unshift(...prefer);
    place({ key, str: name, size, tracking, fill: g === 'baraddur' || g === 'gate' ? '#5a1d10' : INK, halo: 0.85, bias: 0.3, soft: { peak: prefer ? 0.5 : 3, bigriver: 40 }, clear: true,
      cands: offs.map(([dx, dy]) => straight(x + dx, y + dy, w + EXT * 2 + 2)) });
  }
  // 2. mountain chains — italic, set beside the chain, following its line (never on the peaks)
  const rangeLbl = (str, spine, size, offs, centres = [0.5, 0.4, 0.6, 0.3, 0.7], o = {}) => {
    const w = measure(fellI, str, size, 0.08).width;
    place({ key: fellI, str, size, tracking: 0.08, fill: o.fill || INK, halo: 0.8, medium: 'land', cands: alongs(spine, offs, centres, w + EXT * 2 + 8) });
  };
  rangeLbl('Nebelgebirge', SPINES.misty, 30, [-66, 66, -80, 80, -94, 94], [0.32, 0.5, 0.22, 0.4, 0.6]);
  rangeLbl('Graues Gebirge', SPINES.grey, 25, [40, 50, 60]);
  rangeLbl('Ered Luin', SPINES.luinN, 22, [40, 50, -36, -44]);
  rangeLbl('Weiße Berge', SPINES.white, 27, [-84, -94, 52, 62, 72], [0.3, 0.4, 0.5, 0.2]);
  rangeLbl('Schattengebirge', SPINES.ephel, 22, [44, 54, 64], [0.66, 0.74, 0.58, 0.82], { fill: '#4a1c10' });
  rangeLbl('Aschengebirge', SPINES.lithui, 22, [-70, -80, 44, 54], [0.3, 0.4, 0.62, 0.72], { fill: '#4a1c10' });
  rangeLbl('Eisenberge', SPINES.iron, 18, [36, 44, 52], [0.5, 0.4, 0.6]);
  // 3. regions — spaced capitals, a gentle arch
  const region = (str, x, y, size, o = {}) => {
    const tr = o.tracking ?? 0.42, w = measure(cinzel, str, size, tr).width;
    place({ key: cinzel, str, size, tracking: tr, fill: o.fill || INK2, opacity: o.opacity ?? 0.9, halo: 0.5, medium: o.medium || 'land', bias: 0.2, soft: { zone: 5, tree: 1.5 },
      cands: around(x, y, o.offs || NEAR(26, 20), w + EXT * 2 + 4, o.rot || 0, o.arch ?? size * 0.35) });
  };
  region('ERIADOR', 1450, 618, 50, { offs: NEAR(30, 26) });
  region('RHOVANION', 2380, 688, 42, { offs: NEAR(30, 14) });
  region('ROHAN', 1872, 912, 38, { offs: NEAR(16, 12) });
  region('GONDOR', 1462, 1142, 46, { offs: NEAR(24, 12) });
  region('MORDOR', 2520, 1040, 46, { fill: RED, opacity: 0.95, offs: NEAR(26, 12) });
  region('HARAD', 2560, 1312, 42, { arch: 10 });
  region('RHÛN', 2672, 452, 38, { offs: NEAR(20, 20) });
  region('ENEDWAITH', 1460, 900, 24, { tracking: 0.36, arch: 6 });
  region('LINDON', 1052, 560, 20, { tracking: 0.3, rot: -84, arch: 0, offs: NEAR(8, 30) });
  region('DAS AUENLAND', 1258, 392, 20, { tracking: 0.3, arch: 4, offs: NEAR(10, 10) });
  region('WESTERNIS', 186, 700, 52, { tracking: 0.5, rot: -90, arch: 0, fill: '#6a4a1a', offs: NEAR(6, 40) });
  // 4. waters — italic
  const water = (str, x, y, size, o = {}) => {
    const tr = o.tracking ?? 0.06, w = measure(fellI, str, size, tr).width;
    place({ key: fellI, str, size, tracking: tr, fill: o.fill || '#3f4a4c', halo: o.halo ?? 0.55, medium: o.medium || 'sea', bias: 0.15,
      cands: around(x, y, o.offs || NEAR(14, 12), w + EXT * 2 + 4, o.rot || 0, o.arch ?? 0) });
  };
  water('Belegaer', 660, 652, 64, { tracking: 0.14, arch: 10, offs: [[0, 0], [0, 14], [0, -14]] });
  water('Das Große Meer', 660, 728, 28, { tracking: 0.22, arch: 6, offs: [[0, 0], [0, 10], [0, 20]] });
  water('Bucht von Belfalas', 1856, 1262, 28, { tracking: 0.1, arch: 6 });
  water('Golf von Lhûn', 940, 398, 18, { offs: [[0, 0], [-20, -10], [0, -16], [-30, 0]] });
  water('See von Rhûn', 2636, 604, 17, { medium: 'any', offs: [[0, 0], [0, 6], [0, -6]] });
  water('Núrnen', 2604, 1090, 15, { medium: 'any', offs: [[0, 0], [6, 2], [-6, 2]] });
  // 5. woods, hills, marshes and lands within lands — italic
  const feat = (str, x, y, size, o = {}) => {
    const tr = o.tracking ?? 0.06, w = measure(fellI, str, size, tr).width;
    place({ key: fellI, str, size, tracking: tr, fill: o.fill || INK, halo: o.halo ?? 0.8, medium: o.medium ?? 'land', bias: 0.15,
      cands: around(x, y, o.offs || NEAR(12, 10), w + EXT * 2 + 4, o.rot || 0, o.arch ?? 0) });
  };
  feat('Düsterwald', 2132, 480, 40, { tracking: 0.12, arch: 8, fill: '#2e2210', offs: NEAR(10, 22) });
  feat('Fangorn', 1792, 830, 19, { offs: NEAR(6, 6) });
  feat('Lórien', 1852, 646, 18, { offs: NEAR(6, 6), fill: '#4a3410' });
  feat('Alter Wald', 1372, 494, 15, { offs: NEAR(8, 6) });
  feat('Trollhöhen', 1636, 410, 14, { offs: NEAR(8, 8) });
  feat('Ithilien', 2112, 1050, 18, { rot: -84, offs: NEAR(4, 16) });
  feat('Wetterberge', 1506, 392, 14, { offs: NEAR(14, 8) });
  feat('Hügelgräberhöhen', 1404, 560, 14, { offs: NEAR(14, 8) });
  feat('Emyn Muil', 1994, 790, 15, { offs: NEAR(10, 8) });
  feat('Totensümpfe', 2092, 806, 14, { offs: NEAR(10, 8) });
  feat('Gorgoroth', 2300, 900, 20, { fill: '#4a1c10', tracking: 0.12, offs: NEAR(16, 10) });
  feat('Nurn', 2470, 1104, 20, { fill: '#4a1c10', tracking: 0.2, offs: NEAR(16, 8) });
  feat('Orodruin', 2405, 960, 14, { fill: '#5a1d10', offs: [[0, 0], [0, 6], [40, -6], [-40, 4]] });
  feat('Der Einsame Berg', 2440, 236, 14, { offs: [[0, 0], [0, -10], [0, 10], [-210, 0]] });
  // 6. rivers — italic, river ink, beside the stream
  const riverLbl = (str, id, size, centres, o = {}) => {
    const w = measure(fellI, str, size, 0.1).width;
    place({ key: fellI, str, size, tracking: 0.1, fill: RIVER, halo: 0.7, medium: 'land', bias: 0.1, cands: alongs(RIVERS[id].pts, o.offs || [-12, 12, -16, 16], centres, w + EXT * 2 + 6) });
  };
  riverLbl('Anduin', 'anduin', 20, [0.26, 0.32, 0.2, 0.38]);
  riverLbl('Anduin', 'anduin', 20, [0.88, 0.84, 0.92]);
  riverLbl('Baranduin', 'baranduin', 16, [0.7, 0.62, 0.78]);
  riverLbl('Grauflut', 'mitheithel', 16, [0.68, 0.6, 0.76]);
  riverLbl('Weißquell', 'mitheithel', 13, [0.16, 0.24, 0.1]);
  riverLbl('Isen', 'isen', 15, [0.5, 0.4, 0.6]);
  riverLbl('Entwasser', 'entwash', 13, [0.5, 0.4, 0.6]);
  riverLbl('Eilend', 'celduin', 14, [0.5, 0.4, 0.6]);
  riverLbl('Lhûn', 'lhun', 13, [0.4, 0.5, 0.3]);
  // 7. roads and the sea road
  const roadLbl = (str, line, size, centres, fill = INK2, medium = 'land') => {
    const w = measure(fellI, str, size, 0.1).width;
    place({ key: fellI, str, size, tracking: 0.1, fill, halo: 0.7, medium, bias: 0.1, cands: alongs(line, [-10, 10, -14, 14], centres, w + EXT * 2 + 6) });
  };
  roadLbl('Große Oststraße', roadPts[0], 13, [0.36, 0.32, 0.4, 0.76, 0.84]);
  roadLbl('Der Gerade Weg', ROUTE, 19, [0.62, 0.7, 0.55], '#6b4a12', 'sea');
}

// ================================================================ DRAWING
// ---- relief glyphs
// A peak: an uneven lit (west) slope with a knee, a steeper shadow (east) slope inked twice — now and then
// carrying a lesser twin summit — a ridge from the summit, and short fall-lines on the shaded face that
// stop well short of the foot.
function peakD({ x, y, h, w }) {
  const r = rng(Math.round(x * 7.3 + y * 13.1)), P = new Pen();
  const S = [x + w * (r() - 0.42) * 0.36, y - h];
  const Lb = [x - w * (0.85 + r() * 0.25), y], Rb = [x + w * (0.8 + r() * 0.3), y];
  const a = 0.38 + r() * 0.28;
  const A = [lerp(Lb[0], S[0], a) - h * 0.05 * r(), lerp(Lb[1], S[1], a) - h * (0.03 + r() * 0.09)];
  let right;
  if (h > 20 && r() < 0.3) {
    const D = [lerp(S[0], Rb[0], 0.3), lerp(S[1], y, 0.36)], B2 = [lerp(S[0], Rb[0], 0.52), y - h * (0.6 + r() * 0.12)];
    right = [S, D, B2, Rb];
  } else {
    const b = 0.3 + r() * 0.3;
    right = [S, [lerp(S[0], Rb[0], b) + h * 0.04 * r(), lerp(S[1], Rb[1], b) - h * (0.02 + r() * 0.06)], Rb];
  }
  const M = [x + w * (0.06 + r() * 0.16), y - h * (0.06 + r() * 0.12)];
  const bulge = (i) => (i === right.length - 1 ? -0.1 : right.length > 3 && i === 1 ? -0.04 : 0.06);
  P.M(...Lb).bow(A, -0.07).bow(S, 0.05);
  for (let i = 1; i < right.length; i++) P.bow(right[i], bulge(i));
  P.M(S[0] + 0.8, S[1] + 0.7);                                                                         // the shadow slope, gone over again
  for (let i = 1; i < right.length; i++) P.bow([right[i][0] + (i === right.length - 1 ? 0.2 : 0.8), right[i][1] + (i === right.length - 1 ? 0 : 0.5)], bulge(i));
  P.M(...S).bow(M, r() > 0.5 ? 0.06 : -0.05);                                                         // the ridge
  const rc = cum(right), RL = rc[rc.length - 1], n = 3 + Math.round(h / 6);
  for (let k = 1; k <= n; k++) {
    const t = (k - 0.2) / (n + 0.4), [qx, qy] = at(right, rc, t * RL);
    const f = Math.min(0.42, (1 - t) * (0.45 + r() * 0.35));
    P.M(qx - 0.7, qy + 0.9).L(qx - 0.7 + (M[0] - S[0]) * f, qy + 0.9 + (M[1] - S[1]) * f);
  }
  if (h > 22 && r() < 0.55) { const g = [lerp(A[0], S[0], 0.35), lerp(A[1], S[1], 0.35)]; P.M(g[0] + 2, g[1] + 1.5).L(g[0] + 2 + w * 0.1, g[1] + 1.5 + h * 0.2); }   // a gully on the lit face
  return P.d;
}
// A hill: a low rounded hump on a little ground-stroke, shaded with short strokes inside its east side.
function hillD({ x, y, h, w }) {
  const r = rng(Math.round(x * 3.7 + y * 5.3)), P = new Pen();
  const c1 = [x - w * 0.6, y - h * 1.3], c2 = [x + w * (0.3 + r() * 0.2), y - h * 1.36];
  P.M(x - w, y).C(...c1, ...c2, x + w, y).M(x - w - 3, y + 0.4).L(x - w + 2, y + 0.4).M(x + w - 1, y + 0.2).L(x + w + 4, y + 0.6);
  for (const t of w > 10 ? [0.58, 0.68, 0.78, 0.88] : [0.62, 0.75, 0.88]) {
    const u = 1 - t, px = u ** 3 * (x - w) + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * (x + w), py = u ** 3 * y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * y;
    P.M(px - 0.5, py + 1.3).L(px - 0.5 - w * 0.06, py + 1.3 + (y - py) * 0.62);
  }
  return P.d;
}
// ---- trees: a handful of stamps, used thousands of times; crowns take the forest's colour
function treeDefs() {
  const dec = (id, rx, ry, trunk, seed) => {
    const r = rng(seed), cy = -(trunk + ry);
    const pts = Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2, k = 1 + (r() - 0.5) * 0.18; return [Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]; });
    const p1 = [rx * 0.82, cy - ry * 0.5], p2 = [-rx * 0.45, cy + ry * 0.88];
    return `<g id="${id}"><path d="M0 0.3V${f1(cy + ry * 0.4)}M-1.6 0.4h3.2" stroke="${INK}" stroke-width="1"/><path d="${curve(pts, true)}" fill="currentColor" stroke="${INK}" stroke-width="0.8"/>` +
      `<path d="M${f1(p1[0])} ${f1(p1[1])}A${f1(rx)} ${f1(ry)} 0 0 1 ${f1(p2[0])} ${f1(p2[1])}A${f1(rx * 1.05)} ${f1(ry * 1.05)} 0 0 0 ${f1(p1[0])} ${f1(p1[1])}Z" fill="${INK}" opacity="0.42"/></g>`;
  };
  const fir = (id, h, w, tiers) => {
    const top = -h, L = [], R = [];
    for (let k = 1; k <= tiers; k++) {
      const y = top + (h - 2) * (k / tiers), wk = w * (0.42 + 0.58 * (k / tiers));
      L.push([-wk, y], ...(k < tiers ? [[-wk * 0.42, y - 1.2]] : []));
      R.unshift(...(k < tiers ? [[wk * 0.42, y - 1.2]] : []), [wk, y]);
    }
    const out = [[0, top], ...L, [0, -2], ...R];
    const shade = [[0, top], [0, -2], ...R];
    return `<g id="${id}"><path d="M0 0.3V-2.4M-1.4 0.4h2.8" stroke="${INK}" stroke-width="1"/><path d="${poly(out, true)}" fill="currentColor" stroke="${INK}" stroke-width="0.8" stroke-linejoin="round"/><path d="${poly(shade, true)}" fill="${INK}" opacity="0.38"/></g>`;
  };
  return dec('d1', 4.4, 4.2, 3, 1) + dec('d2', 3.6, 3.5, 2.6, 2) + dec('d3', 3.9, 4.8, 3, 3) + fir('c1', 13, 4.6, 3) + fir('c2', 10.5, 3.9, 3) + fir('c3', 14, 3.6, 4);
}
// ---- settlement glyphs
function townGlyph([name, x, y, g]) {
  const S = `stroke="${INK}" stroke-linejoin="round"`;
  switch (g) {
    case 'city': {   // Minas Tirith: seven walls about a white tower
      let d = `<circle cx="${x}" cy="${y}" r="11.5" fill="${CARD}" ${S} stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="8.2" fill="none" ${S} stroke-width="0.8"/><circle cx="${x}" cy="${y}" r="5" fill="none" ${S} stroke-width="0.8"/>`;
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; d += `<rect x="${f1(x + Math.cos(a) * 11.5 - 1.8)}" y="${f1(y + Math.sin(a) * 11.5 - 1.8)}" width="3.6" height="3.6" fill="${CARD}" ${S} stroke-width="0.9"/>`; }
      return d + `<path d="M${x - 1.6} ${y + 2}V${y - 13}l1.6 -3 1.6 3V${y + 2}Z" fill="${CARD}" ${S} stroke-width="1"/><path d="M${x} ${y - 16}v-5l6 1.6 -6 1.6" fill="${RED}" ${S} stroke-width="0.7"/>`;
    }
    case 'town': return `<circle cx="${x}" cy="${y}" r="5.4" fill="${CARD}" ${S} stroke-width="1.4"/><circle cx="${x}" cy="${y}" r="1.8" fill="${INK}"/>`;
    case 'hall': return `<path d="M${x - 8} ${y + 4}h16M${x - 6} ${y + 4}v-6l6 -6 6 6v6" fill="${CARD}" ${S} stroke-width="1.3"/><path d="M${x - 2.4} ${y - 9}l2.4 -3 2.4 3M${x} ${y + 4}v-4" fill="none" ${S} stroke-width="1"/>`;
    case 'castle': return `<path d="M${x - 7} ${y + 5}v-9h3v-3h2v3h4v-3h2v3h3v9z" fill="${CARD}" ${S} stroke-width="1.2"/><path d="M${x - 1.6} ${y + 5}v-3.4a1.6 1.6 0 0 1 3.2 0v3.4" fill="${INK}"/>`;
    case 'ruin': return `<path d="M${x + 5.6} ${y - 2}A6 6 0 1 0 ${x + 2} ${y + 5.6}M${x + 4.2} ${y + 3}l1.6 1.4" fill="none" ${S} stroke-width="1.4" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="1.6" fill="${INK}"/>`;
    case 'haven': { let d = ''; for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? 4.4 : 8.4; d += `${k ? 'L' : 'M'}${f1(x + Math.cos(a) * rr)} ${f1(y + Math.sin(a) * rr)}`; } return `<path d="${d}Z" fill="#e6c76a" ${S} stroke-width="1.1"/><circle cx="${x}" cy="${y}" r="1.7" fill="${INK}"/>`; }
    case 'orthanc': return `<circle cx="${x}" cy="${y}" r="9.5" fill="${CARD}" ${S} stroke-width="1.4"/><path d="M${x - 2.4} ${y + 3}l0.6 -15 -1.6 -4 2.2 2 1.2 -4 1.2 4 2.2 -2 -1.6 4 0.6 15z" fill="${DUSK}" ${S} stroke-width="0.8"/>`;
    case 'darktower': return `<path d="M${x - 10} ${y + 5}q10 -10 20 0" fill="${CARD}" ${S} stroke-width="1.2"/><path d="M${x - 3} ${y + 1}v-13l-1.4 -2.4h2.2v1.6h1.2v-1.6h2v1.6h1.2v-1.6h2.2l-1.4 2.4v13z" fill="${DUSK}" ${S} stroke-width="0.8"/>`;
    case 'tower': return `<path d="M${x - 2.8} ${y + 5}v-15l-1.4 -2.4h1.8v1.6h1.4v-1.6h2v1.6h1.4v-1.6h1.8l-1.4 2.4v15z" fill="#d9d6b4" ${S} stroke-width="1"/><path d="M${x - 0.8} ${y - 6}h1.6v3h-1.6z" fill="#4c6b3c"/>`;
    case 'baraddur': return `<path d="M${x - 9} ${y + 6}h18l-4 -6h-2.6l-0.6 -18 2.4 -4 -3 1.4 -1.2 -4.6 -1 4 -1 -4 -1.2 4.6 -3 -1.4 2.4 4 -0.6 18h-2.6z" fill="${DUSK}" ${S} stroke-width="0.9"/><circle cx="${x}" cy="${y - 17}" r="1.5" fill="#d0542a"/>`;
    case 'gate': return `<path d="M${x - 9} ${y + 5}v-12h4v12M${x + 5} ${y + 5}v-12h4v12M${x - 5} ${y - 2}h10" fill="${DUSK}" ${S} stroke-width="1.1"/><path d="M${x - 5} ${y + 5}v-7h10v7" fill="none" ${S} stroke-width="1.6"/>`;
  }
  return '';
}
// ---- the Rammas Echor: the out-wall of the Pelennor, from the mountain round to the Anduin
function rammas() {
  const [cx, cy] = mu(60, 49), pts = [];
  for (let a = -34; a <= 160; a += 6) { const t = (a * Math.PI) / 180, rr = 50 + 4 * Math.sin(a * 0.11); const p = [cx + Math.sin(t) * rr, cy - Math.cos(t) * rr]; if (p[0] < anduinX(p[1]) - 4) pts.push(p); }
  return `<path d="${curve(pts)}" fill="none" stroke="${INK2}" stroke-width="1.1" stroke-dasharray="4 2.5" opacity="0.8"/>`;
}
// ---- Orodruin and its smoke
function doom(x, y) {
  const r = rng(5);
  let smoke = '';
  for (let k = 0; k < 4; k++) {   // plumes rise and are bent east by the wind
    const pts = []; let px = x + (k - 1.5) * 3, py = y - 44;
    for (let j = 0; j < 9; j++) { pts.push([px, py]); px += 6 + j * 4 + r() * 4; py -= 9 - j * 0.9 + r() * 3; }
    smoke += `<path d="${curve(pts)}" fill="none" stroke="#5a4a40" stroke-width="${f1(5 - k)}" stroke-linecap="round" opacity="${f1(0.16 + k * 0.04)}"/><path d="${curve(pts)}" fill="none" stroke="${DUSK}" stroke-width="0.8" stroke-dasharray="${8 + k * 3} ${5 + k}" opacity="0.5"/>`;
  }
  return `<ellipse cx="${x}" cy="${y - 40}" rx="16" ry="8" fill="#d0542a" opacity="0.25"/>` + smoke +
    `<path d="M${x - 38} ${y + 4}Q${x - 22} ${y - 14} ${x - 9} ${y - 42}h18Q${x + 24} ${y - 14} ${x + 40} ${y + 4}Z" fill="#7d6450" stroke="${DUSK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="M${x - 9} ${y - 42}q9 4 18 0" fill="none" stroke="${DUSK}" stroke-width="1.2"/><path d="M${x - 9} ${y - 42}q9 -4 18 0" fill="#c4502a" stroke="${DUSK}" stroke-width="0.9"/>` +
    `<path d="M${x - 4} ${y - 38}q-6 16 -14 30M${x + 3} ${y - 38}q4 14 12 34M${x} ${y - 38}q1 10 -3 22" fill="none" stroke="#c4502a" stroke-width="1.6" stroke-linecap="round"/>` +
    `<path d="M${x + 12} ${y - 30}l-5 18M${x + 20} ${y - 18}l-6 16M${x + 28} ${y - 6}l-5 9" stroke="${DUSK}" stroke-width="0.9" opacity="0.7"/>`;
}
// ---- a swan-ship of the Elves, sailing west
function ship(x, y) {
  return `<g transform="translate(${x} ${y})" stroke="${INK}" stroke-linejoin="round" stroke-linecap="round">` +
    `<path d="M34 1q12 2 26 -1M40 6q10 2 20 0M30 -3q8 1 14 0" fill="none" stroke-width="0.8" opacity="0.6"/>` +
    `<path d="M-24 -4C-16 4 18 5 28 -5L22 -3C8 0 -12 0 -24 -4Z" fill="${CARD}" stroke-width="1.3"/>` +
    `<path d="M-24 -4C-31 -9 -32 -21 -27 -25C-24 -27 -20 -25 -21 -22L-25 -21C-26 -17 -25 -10 -20 -5" fill="${CARD}" stroke-width="1.2"/>` +
    `<path d="M28 -5q4 -6 2 -12" fill="none" stroke-width="1.1"/><path d="M2 -2V-48" stroke-width="1.3"/>` +
    `<path d="M-14 -44Q-22 -27 -14 -10H16Q8 -27 16 -44Z" fill="${CARD}" stroke-width="1.1"/><path d="M-10 -38q-4 10 0 22M-4 -40q-3 12 0 26" fill="none" stroke-width="0.6" opacity="0.6"/>` +
    `<path d="M2 -48l-16 -3 16 -3z" fill="${RED}" stroke-width="0.7"/></g>`;
}
// ---- ornaments
function compass({ x: cx, y: cy, r: R }) {
  const pt = (a, len, wid, darkLeft) => {
    const tip = [cx + Math.cos(a) * len, cy + Math.sin(a) * len];
    const l = [cx + Math.cos(a - Math.PI / 2) * wid, cy + Math.sin(a - Math.PI / 2) * wid], rr = [cx + Math.cos(a + Math.PI / 2) * wid, cy + Math.sin(a + Math.PI / 2) * wid];
    return `<path d="M${f1(cx)} ${f1(cy)}L${f1(l[0])} ${f1(l[1])}L${f1(tip[0])} ${f1(tip[1])}Z" fill="${darkLeft ? INK : CARD}"/><path d="M${f1(cx)} ${f1(cy)}L${f1(rr[0])} ${f1(rr[1])}L${f1(tip[0])} ${f1(tip[1])}Z" fill="${darkLeft ? CARD : INK}"/><path d="M${f1(l[0])} ${f1(l[1])}L${f1(tip[0])} ${f1(tip[1])}L${f1(rr[0])} ${f1(rr[1])}M${f1(cx)} ${f1(cy)}L${f1(tip[0])} ${f1(tip[1])}" fill="none"/>`;
  };
  let ring = '', ticks = '';
  for (let k = 0; k < 32; k++) if (k % 2 === 0) { const a0 = (k / 32) * Math.PI * 2, a1 = ((k + 1) / 32) * Math.PI * 2, r0 = R * 0.9, r1 = R * 0.97; ring += `M${f1(cx + Math.cos(a0) * r0)} ${f1(cy + Math.sin(a0) * r0)}L${f1(cx + Math.cos(a0) * r1)} ${f1(cy + Math.sin(a0) * r1)}A${f1(r1)} ${f1(r1)} 0 0 1 ${f1(cx + Math.cos(a1) * r1)} ${f1(cy + Math.sin(a1) * r1)}L${f1(cx + Math.cos(a1) * r0)} ${f1(cy + Math.sin(a1) * r0)}A${f1(r0)} ${f1(r0)} 0 0 0 ${f1(cx + Math.cos(a0) * r0)} ${f1(cy + Math.sin(a0) * r0)}Z`; }
  for (let k = 0; k < 128; k++) { const a = (k / 128) * Math.PI * 2, r0 = R * (k % 4 === 0 ? 0.8 : 0.84), r1 = R * 0.88; ticks += `M${f1(cx + Math.cos(a) * r0)} ${f1(cy + Math.sin(a) * r0)}L${f1(cx + Math.cos(a) * r1)} ${f1(cy + Math.sin(a) * r1)}`; }
  let pts = '';
  for (let k = 0; k < 8; k++) pts += pt(-Math.PI / 2 + Math.PI / 8 + (k * Math.PI) / 4, R * 0.52, R * 0.055, k % 2);
  for (let k = 0; k < 4; k++) pts += pt(-Math.PI / 4 + (k * Math.PI) / 2, R * 0.7, R * 0.085, true);
  for (let k = 0; k < 4; k++) pts += pt(-Math.PI / 2 + (k * Math.PI) / 2, R * 0.97, R * 0.12, true);
  const fleur = `<g transform="translate(${cx} ${f1(cy - R - 20)})" fill="${INK}" stroke="${CARD}" stroke-width="0.6" stroke-linejoin="round">` +   // a fleur-de-lis on the north point
    `<path d="M0 -27C4.5 -20 6 -10 2.6 2H-2.6C-6 -10 -4.5 -20 0 -27Z"/><path d="M2.5 2C4 -6 9 -13 16 -13C21 -13 22 -7 18.5 -5C16 -4 14.5 -6 16 -8C12.5 -8 8 -3 6 4Z"/>` +
    `<path d="M-2.5 2C-4 -6 -9 -13 -16 -13C-21 -13 -22 -7 -18.5 -5C-16 -4 -14.5 -6 -16 -8C-12.5 -8 -8 -3 -6 4Z"/><rect x="-8.5" y="2.4" width="17" height="4.2" rx="1"/><path d="M-6 6.6C-6 10 -3 11 0 16C3 11 6 10 6 6.6Z"/></g>`;
  return `<g><circle cx="${cx}" cy="${cy}" r="${f1(R * 1.06)}" fill="${INK}" opacity="0.1"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="${CARD}" stroke="${INK}" stroke-width="1.6"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${f1(R * 0.9)}" fill="none" stroke="${INK}" stroke-width="0.7"/><path d="${ring}" fill="${INK}" opacity="0.85"/><path d="${ticks}" stroke="${INK}" stroke-width="0.6"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${f1(R * 0.8)}" fill="none" stroke="${INK}" stroke-width="0.9"/><circle cx="${cx}" cy="${cy}" r="${f1(R * 0.36)}" fill="none" stroke="${INK}" stroke-width="0.6"/><circle cx="${cx}" cy="${cy}" r="${f1(R * 0.31)}" fill="none" stroke="${INK}" stroke-width="0.6" stroke-dasharray="1 2.4"/>` +
    `<g stroke="${INK}" stroke-width="0.8" stroke-linejoin="round">${pts}</g><circle cx="${cx}" cy="${cy}" r="${f1(R * 0.06)}" fill="${CARD}" stroke="${INK}" stroke-width="0.9"/><circle cx="${cx}" cy="${cy}" r="${f1(R * 0.025)}" fill="${RED}"/>${fleur}` +
    text('cinzel', 'O', cx + R + 16, cy, 20) + text('cinzel', 'S', cx, cy + R + 17, 20) + text('cinzel', 'W', cx - R - 18, cy, 20) + `</g>`;
}
function rhumbs({ x: cx, y: cy, r: R }) {
  let d = '', d2 = '';
  for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2, s = `M${f1(cx + Math.cos(a) * R)} ${f1(cy + Math.sin(a) * R)}L${f1(cx + Math.cos(a) * 2600)} ${f1(cy + Math.sin(a) * 2600)}`; if (k % 4 === 0) d += s; else d2 += s; }
  return `<path d="${d}" stroke="${INK2}" stroke-width="0.8" opacity="0.32"/><path d="${d2}" stroke="${INK2}" stroke-width="0.5" opacity="0.22"/>`;
}
function cartouche({ x: cx, y: cy, w, h }) {
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2, n = 20;
  const plate = (i) => `M${x0 + n + i} ${y0 + i}H${x1 - n - i}A${n} ${n} 0 0 0 ${x1 - i} ${y0 + n + i}V${y1 - n - i}A${n} ${n} 0 0 0 ${x1 - n - i} ${y1 - i}H${x0 + n + i}A${n} ${n} 0 0 0 ${x0 + i} ${y1 - n - i}V${y0 + n + i}A${n} ${n} 0 0 0 ${x0 + n + i} ${y0 + i}Z`;
  const curl = (sx, dir) => `M${sx} ${cy - 26}c${dir * -16} 4 ${dir * -22} 16 ${dir * -12} 26c${dir * 8} 8 ${dir * 20} 2 ${dir * 16} -8c${dir * -3} -6 ${dir * -10} -5 ${dir * -10} 1M${sx} ${cy + 26}c${dir * -16} -4 ${dir * -22} -16 ${dir * -12} -26`;
  const sprig = (sx, dir) => { let d = `M${sx} ${cy + 14}h${dir * 70}`; for (let k = 0; k < 6; k++) { const px = sx + dir * (10 + k * 11); d += `M${px} ${cy + 14}q${dir * 4} -6 ${dir * 9} -6q${dir * -2} 5 ${dir * -9} 6q${dir * 4} 6 ${dir * 9} 6q${dir * -2} -5 ${dir * -9} -6`; } return d; };
  return `<g><path d="${plate(0)}" transform="translate(5 6)" fill="${INK}" opacity="0.14"/><path d="${plate(0)}" fill="${CARD}" stroke="${INK}" stroke-width="1.8"/>` +
    `<path d="${plate(7)}" fill="none" stroke="${INK}" stroke-width="0.8"/><path d="${plate(11)}" fill="none" stroke="${INK}" stroke-width="0.5" stroke-dasharray="1.5 3"/>` +
    `<path d="${curl(x0, 1)}${curl(x1, -1)}" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>` +
    text('deco', 'WESTERNIS', cx, cy - 38, 60, { tracking: 0.1, fill: '#2f210f' }) +
    `<path d="${sprig(cx - 22, -1)}${sprig(cx + 22, 1)}" fill="none" stroke="${INK}" stroke-width="0.9" stroke-linecap="round"/><path d="M${cx} ${cy + 6}l8 8 -8 8 -8 -8z" fill="${RED}" stroke="${INK}" stroke-width="0.8"/>` +
    text('fellI', 'Mittelerde und die Lande jenseits des Meeres', cx, cy + 50, 21) +
    text('fell', 'Gezeichnet in den Archiven des Westens', cx, cy + 82, 13, { tracking: 0.12, fill: INK2 }) + `</g>`;
}
function scaleBar({ x, y, len }) {   // a two-row chequered bar; the first fifty miles split into tens
  const seg = len / 6, hgt = 9;
  let blk = '';
  for (let k = 0; k < 6; k++) blk += `M${x + k * seg} ${y + (k % 2 ? hgt / 2 : 0)}h${seg}v${hgt / 2}h${-seg}z`;
  for (let k = 0; k < 5; k++) blk += `M${x + (k * seg) / 5} ${y + (k % 2 ? 0 : hgt / 2)}h${seg / 5}v${hgt / 2}h${-seg / 5}z`;
  const cap = (cx, dir) => `M${cx} ${y - 3}v${hgt + 6}M${cx + dir * 2} ${y + hgt / 2}c${dir * 6} -7 ${dir * 16} -6 ${dir * 14} 0c${dir * -2} 5 ${dir * -8} 4 ${dir * -7} 0`;
  const swash = (sx, dir) => `M${sx} ${y - 22}c${dir * 14} 0 ${dir * 22} -4 ${dir * 34} -2c${dir * 8} 1 ${dir * 12} 5 ${dir * 6} 7c${dir * -4} 1 ${dir * -6} -3 ${dir * -3} -5`;
  let d = `<rect x="${x}" y="${y}" width="${len}" height="${hgt}" fill="${CARD}" stroke="${INK}" stroke-width="1.2"/><path d="${blk}" fill="${INK}"/>`;
  d += `<path d="M${x} ${y + hgt / 2}h${len}${cap(x, -1)}${cap(x + len, 1)}${swash(x + len / 2 - 40, -1)}${swash(x + len / 2 + 40, 1)}" fill="none" stroke="${INK}" stroke-width="0.9" stroke-linecap="round"/>`;
  d += [0, 50, 100, 150, 200, 250, 300].map((v, k) => text('fell', String(v), x + k * seg, y + hgt + 13, 14)).join('');
  d += text('fellI', 'Meilen', x + len / 2, y - 20, 21, { tracking: 0.1 });
  return d;
}
function frame() {
  let band = '', ticks = '';
  for (let x = 40, k = 0; x < W - 40; x += 50, k++) if (k % 2 === 0) band += `M${x} 22h${Math.min(50, W - 40 - x)}v8h${-Math.min(50, W - 40 - x)}zM${x} ${H - 30}h${Math.min(50, W - 40 - x)}v8h${-Math.min(50, W - 40 - x)}z`;
  for (let y = 40, k = 0; y < H - 40; y += 50, k++) if (k % 2 === 0) band += `M22 ${y}v${Math.min(50, H - 40 - y)}h8v${-Math.min(50, H - 40 - y)}zM${W - 30} ${y}v${Math.min(50, H - 40 - y)}h8v${-Math.min(50, H - 40 - y)}z`;
  for (let x = 100; x < W; x += 100) ticks += `M${x} 30v6M${x} ${H - 30}v-6`;
  for (let y = 100; y < H; y += 100) ticks += `M30 ${y}h6M${W - 30} ${y}h-6`;
  const corner = (x, y) => `<rect x="${x - 9}" y="${y - 9}" width="18" height="18" fill="${CARD}" stroke="${INK}" stroke-width="1.2"/><path d="M${x - 6} ${y}h12M${x} ${y - 6}v12" stroke="${INK}" stroke-width="0.8"/><circle cx="${x}" cy="${y}" r="2.6" fill="${RED}" stroke="${INK}" stroke-width="0.6"/>`;
  return `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="none" stroke="${INK}" stroke-width="2.6"/><rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none" stroke="${INK}" stroke-width="0.8"/>` +
    `<path d="${band}" fill="${INK}" opacity="0.78"/><rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="${INK}" stroke-width="0.8"/><rect x="${EDGE}" y="${EDGE}" width="${W - 2 * EDGE}" height="${H - 2 * EDGE}" fill="none" stroke="${INK}" stroke-width="1.4"/>` +
    `<path d="${ticks}" stroke="${INK}" stroke-width="0.9"/>${corner(26, 26)}${corner(W - 26, 26)}${corner(26, H - 26)}${corner(W - 26, H - 26)}`;
}
// ---- water-lining: lines that follow the shore out to sea, as an engraver draws them
function waterLines(line, steps, closed = false) {
  const base = closed ? [...line, line[0], line[1]] : line;
  let out = '';
  // which side is the sea? look a little way out along the normal
  const T0 = tangents(base);
  let vote = 0;
  for (let i = 0; i < base.length; i += 7) { const p = base[i], n = [-T0[i][1], T0[i][0]]; vote += isLand(p[0] + n[0] * 9, p[1] + n[1] * 9) ? -1 : 1; }
  const side = vote >= 0 ? 1 : -1;
  for (const [d, w, op] of steps) {
    const o = offset(smooth(resample(base, 5), Math.round(1 + d / 6)), side * d);
    let run = [];
    const flush = () => { if (run.length > 4) out += `<path d="${rel(run)}" stroke-width="${w}" opacity="${op}"/>`; run = []; };
    for (const p of o) { if (shoreDist(p[0], p[1]) > d * 0.82 && isSea(p[0], p[1])) run.push(p); else flush(); }
    flush();
  }
  return out;
}

// ================================================================ COMPOSE
(async () => {
  useFont('cinzel', 'Cinzel.woff2', 'WstMapCaps', 'Cinzel, The Cinzel Project Authors');
  useFont('fellI', 'IMFellEnglish-Italic.woff2', 'WstMapHand', 'IM FELL English, Igino Marini');
  useFont('fell', 'IMFellEnglish-Regular.woff2', 'WstMapRoman', 'IM FELL English, Igino Marini');
  useFont('deco', 'CinzelDecorative-Bold.woff2', 'WstMapTitle', 'Cinzel Decorative, Natanael Gama');
  await loadFonts();
  labelAll();

  // clear trees, hills, reeds and waves from under the lettering
  const under = (x0, y0, x1, y1) => LBL.some((l) => l.boxes.some((b) => b.x + b.hx + 2 > x0 && b.x - b.hx - 2 < x1 && b.y + b.hy + 2 > y0 && b.y - b.hy - 2 < y1));
  const trees = TREES.filter((t) => !under(t.x - 4, t.y - 12, t.x + 4, t.y));
  const relief2 = relief.filter((p) => !p.cleared && (!p.hill || !under(p.x - p.w, p.y - p.h, p.x + p.w, p.y)));
  // Harad: a sparse sand stipple of short strokes, thinning northwards
  const sr = rng(99);
  let sand = '';
  for (let y = 1196; y < H - 50; y += 9) for (let x = 2230; x < W - 50; x += 11) {
    const jx = x + (sr() - 0.5) * 9, jy = y + (sr() - 0.5) * 6;
    if (!isLand(jx, jy) || sr() > (jy - 1190) / 160 || under(jx - 2, jy - 2, jx + 2, jy + 2) || [...hits(jx - 2, jy - 2, jx + 2, jy + 2)].some((b) => b.k === 'peak')) continue;
    sand += `M${f1(jx)} ${f1(jy)}h${f1(1 + sr() * 2)}`;
  }
  const tufts = TUFTS.filter(([x, y]) => !under(x - 6, y - 6, x + 6, y + 3));
  const dots = roadPts.map((r) => resample(r, 6.2).filter(([x, y]) => !under(x - 1, y - 1, x + 1, y + 1)).map(([x, y]) => `M${f1(x)} ${f1(y)}h0`).join('')).join('');   // the roads as dots, lifted from under the names

  // sea waves: little doubled strokes scattered on the open water
  const wr = rng(91);
  let waves = '';
  for (let y = 70; y < H - 60; y += 30) for (let x = 60; x < W - 60; x += 64) {
    const jx = x + (wr() - 0.5) * 44, jy = y + (wr() - 0.5) * 12;
    if (!isSea(jx, jy) || !isSea(jx + 16, jy) || shoreDist(jx, jy) < 46 || wr() < 0.45) continue;
    if ([...hits(jx - 4, jy - 6, jx + 20, jy + 4)].some((b) => b.k === 'orn' || b.k === 'label')) continue;
    if (Math.hypot(jx - COMPASS.x, jy - COMPASS.y) < COMPASS.r + 40) continue;
    waves += `M${f1(jx)} ${f1(jy)}q4 -4 8 0t8 0`;
  }
  // the lettering, each on its own path (a straight run needs only its two ends)
  let lpaths = '', ltext = '';
  LBL.forEach((l, i) => {
    const f = FONTS[l.key], a = l.base[0], b = l.base[l.base.length - 1], len = dist(a, b);
    const bent = l.base.some((p) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / len > 0.6);
    lpaths += `<path id="t${i}" d="${bent ? curve(resample(l.base, 14)) : poly([a, b])}"/>`;
    const halo = l.halo ? ` stroke="${PAPER}" stroke-opacity="${l.halo}" stroke-width="${f1(clamp(l.size * 0.16, 2.2, 4.5))}" stroke-linejoin="round" paint-order="stroke"` : '';
    ltext += `<text font-family="${f.family}" font-size="${l.size}"${l.m.ls ? ` letter-spacing="${f1(l.m.ls)}"` : ''} fill="${l.fill || INK}"${l.opacity && l.opacity < 1 ? ` opacity="${l.opacity}"` : ''}${halo}><textPath href="#t${i}" startOffset="${EXT}">${esc(l.str)}</textPath></text>\n`;
  });

  const isleD = islands.map((p) => rel(p, true)).join(''), lakeD = Object.values(lakes).map((p) => rel(p, true)).join('');
  const water = [
    waterLines(meCoast, [[4, 0.9, 0.75], [9, 0.8, 0.55], [15, 0.7, 0.4], [23, 0.6, 0.27], [33, 0.5, 0.15]]),
    waterLines(wlCoast, [[4, 0.9, 0.7], [9, 0.8, 0.5], [15, 0.7, 0.34], [23, 0.6, 0.2]]),
    ...islands.map((p) => waterLines(p, [[4, 0.8, 0.6], [9, 0.7, 0.4], [15, 0.6, 0.22]], true)),
  ].join('');
  const lakeLines = Object.values(lakes).map((p) => `<path d="${rel(offset([...p, p[0], p[1]], 3.5))}" opacity="0.5"/>`).join('');   // blobs run clockwise: +offset is inward
  const forestsSvg = FORESTS.map(([outline, , o]) => `<path d="${rel(resample([...outline, outline[0]], 7), true)}" fill="${o.wash || '#7a6a3a'}" opacity="0.1"/>`).join('');
  const treeUses = [...new Set(trees.map((t) => t.color))].map((col) => `<g color="${col}">${trees.filter((t) => t.color === col).sort((a, b) => a.y - b.y).map((t) => `<use href="#${t.t}" x="${f1(t.x)}" y="${f1(t.y)}"/>`).join('')}</g>`).join('');
  const TONE = { ink: '', dark: ` fill="#9b8466" stroke="${DUSK}"`, ash: ` fill="#b5a68d" stroke="${DUSK}"`, far: ` fill="#efe1b6" stroke="#a08c66"` };
  const farSvg = relief2.filter((p) => p.tone === 'far').map((p) => `<path d="${peakD(p)}"/>`).join('');
  const reliefSvg = relief2.filter((p) => p.tone !== 'far').map((p) => `<path d="${p.hill ? hillD(p) : peakD(p)}"${TONE[p.tone]}${!p.hill && p.h > 30 && p.tone !== 'far' ? ' stroke-width="1.2"' : ''}/>`).join('');
  const bandsSvg = BANDS.map((b) => `<path d="${rel(resample([...b.pts, b.pts[0]], 12), true)}" fill="${b.tone === 'dark' || b.tone === 'ash' ? '#2b1a10' : '#6b5232'}" opacity="${b.tone === 'far' ? 0.02 : 0.035}"/>`).join('');
  let reeds = '', pools = '';
  for (const [x, y, k] of tufts) { reeds += `M${f1(x - 3 * k)} ${f1(y)}l${f1(-1 * k)} ${f1(-4 * k)}M${f1(x)} ${f1(y)}v${f1(-5.5 * k)}M${f1(x + 3 * k)} ${f1(y)}l${f1(1 * k)} ${f1(-4 * k)}M${f1(x - 4.5 * k)} ${f1(y + 0.3)}h${f1(9 * k)}`; pools += `M${f1(x + 5)} ${f1(y + 3)}h6`; }

  const ornaments = compass(COMPASS) + cartouche(CART) + scaleBar(SCALE);   // before the fonts are cut, so their letters are kept
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
${await fontFaces()}
<radialGradient id="paper" cx="52%" cy="46%" r="68%"><stop offset="0" stop-color="#f4e8c8"/><stop offset="0.55" stop-color="#ecdbb1"/><stop offset="0.85" stop-color="#dcc293"/><stop offset="1" stop-color="#c4a46e"/></radialGradient>
<radialGradient id="west" cx="0" cy="0.5" r="1"><stop offset="0" stop-color="#fff6d2" stop-opacity="0.75"/><stop offset="0.55" stop-color="#fbeec2" stop-opacity="0.28"/><stop offset="1" stop-color="#fbeec2" stop-opacity="0"/></radialGradient>
<radialGradient id="stain"><stop offset="0" stop-color="#8a6630" stop-opacity="0.13"/><stop offset="0.7" stop-color="#8a6630" stop-opacity="0.05"/><stop offset="1" stop-color="#8a6630" stop-opacity="0"/></radialGradient>
<radialGradient id="haven"><stop offset="0" stop-color="#fff2c4" stop-opacity="0.9"/><stop offset="1" stop-color="#fff2c4" stop-opacity="0"/></radialGradient>
<linearGradient id="creaseV" x1="0" x2="1"><stop offset="0" stop-color="#7a5a2a" stop-opacity="0"/><stop offset="0.45" stop-color="#7a5a2a" stop-opacity="0.1"/><stop offset="0.5" stop-color="#fff8e4" stop-opacity="0.35"/><stop offset="0.56" stop-color="#7a5a2a" stop-opacity="0"/></linearGradient>
<linearGradient id="creaseH" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7a5a2a" stop-opacity="0"/><stop offset="0.45" stop-color="#7a5a2a" stop-opacity="0.08"/><stop offset="0.5" stop-color="#fff8e4" stop-opacity="0.3"/><stop offset="0.56" stop-color="#7a5a2a" stop-opacity="0"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#3a1a0c" stop-opacity="0.32"/><stop offset="1" stop-color="#3a1a0c" stop-opacity="0"/></radialGradient>
<linearGradient id="seaTint" x1="0" x2="1"><stop offset="0" stop-color="#c2c09e" stop-opacity="0.36"/><stop offset="0.45" stop-color="#a9b09a" stop-opacity="0.48"/><stop offset="1" stop-color="#9fa891" stop-opacity="0.5"/></linearGradient>
<path id="meL" d="${rel(meLand, true)}"/><path id="wlL" d="${rel(wlLand, true)}"/><path id="isL" d="${isleD}"/>
<clipPath id="inner"><rect x="${EDGE}" y="${EDGE}" width="${W - 2 * EDGE}" height="${H - 2 * EDGE}"/></clipPath>
<clipPath id="land"><use href="#meL"/><use href="#wlL"/><use href="#isL"/></clipPath>
<clipPath id="wl"><use href="#wlL"/></clipPath>
<clipPath id="mordor"><path d="${rel(mordorIn, true)}"/></clipPath>
<pattern id="ash" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="3" cy="4" r="0.9" fill="${DUSK}" opacity="0.55"/><circle cx="11" cy="11" r="0.7" fill="${DUSK}" opacity="0.5"/><circle cx="10" cy="2" r="0.5" fill="${DUSK}" opacity="0.4"/><path d="M5 12l2 -1" stroke="${DUSK}" stroke-width="0.6" opacity="0.45"/></pattern>
<pattern id="fibre" width="160" height="160" patternUnits="userSpaceOnUse"><path d="M12 30l40 3M90 12l30 -2M30 110l46 4M110 90l34 -3M60 150l28 2M140 140l14 -1" stroke="#7a5a2a" stroke-width="0.6" opacity="0.16"/><circle cx="70" cy="60" r="0.9" fill="#7a5a2a" opacity="0.2"/><circle cx="130" cy="40" r="0.7" fill="#7a5a2a" opacity="0.2"/><circle cx="20" cy="140" r="0.8" fill="#7a5a2a" opacity="0.2"/></pattern>
${treeDefs()}
${lpaths}
</defs>
<rect width="${W}" height="${H}" fill="url(#paper)"/>
<g clip-path="url(#inner)">
<rect width="${W}" height="${H}" fill="url(#seaTint)"/>
${rhumbs(COMPASS)}
<g fill="none" stroke="${INK}" stroke-linecap="round">${water}</g>
<path d="${waves}" fill="none" stroke="${INK2}" stroke-width="0.9" opacity="0.5" stroke-linecap="round"/>
<g clip-path="url(#land)"><rect width="${W}" height="${H}" fill="url(#paper)"/><use href="#meL" fill="none" stroke="#9a7a3a" stroke-width="18" opacity="0.14"/><use href="#meL" fill="none" stroke="#9a7a3a" stroke-width="7" opacity="0.12"/><use href="#wlL" fill="none" stroke="#9a7a3a" stroke-width="16" opacity="0.14"/><use href="#isL" fill="none" stroke="#9a7a3a" stroke-width="10" opacity="0.12"/></g>
<rect width="${W}" height="${H}" fill="url(#fibre)"/>
<rect width="1500" height="${H}" fill="url(#west)"/>
<g clip-path="url(#wl)"><rect width="700" height="${H}" fill="#f3dc8e" opacity="0.18"/></g>
<g clip-path="url(#mordor)"><rect x="2100" y="740" width="700" height="480" fill="#4a2a18" opacity="0.13"/>${[1.15, 0.9, 0.65].map((k) => `<path d="${curve(gorgoroth.map(([gx, gy]) => [2390 + (gx - 2390) * k, 905 + (gy - 905) * k]), true)}" fill="#3a2214" opacity="0.06"/>`).join('')}<rect x="2100" y="740" width="700" height="480" fill="url(#ash)"/></g>
<circle cx="2405" cy="900" r="70" fill="url(#glow)"/>
<path d="${sand}" stroke="#8a6a3a" stroke-width="1.1" stroke-linecap="round" opacity="0.45"/>
${forestsSvg}
${bandsSvg}
<path d="${lakeD}" fill="#c9c5a2" stroke="${RIVER}" stroke-width="1.4"/><g fill="none" stroke="${RIVER}" stroke-width="0.7">${lakeLines}</g>
<path d="${pools}" stroke="${RIVER}" stroke-width="0.8" opacity="0.7"/><path d="${reeds}" fill="none" stroke="${INK}" stroke-width="0.75" stroke-linecap="round"/>
<path d="${Object.values(RIVERS).map(riverD).join('')}" fill="${RIVER}"/>
<path d="${dots}" fill="none" stroke="${INK2}" stroke-width="1.8" stroke-linecap="round"/>
<path d="${rel(ROUTE)}" fill="none" stroke="#8a6420" stroke-width="1.5" stroke-dasharray="9 6" opacity="0.8"/>
<use href="#meL" fill="none" stroke="${INK}" stroke-width="2.7" stroke-linejoin="round"/>
<use href="#wlL" fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
<use href="#isL" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>
${treeUses}
<g fill="#f1e4bb" stroke="#7d6a45" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.62">${farSvg}</g>
<g fill="#efe1bb" stroke="${INK}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${reliefSvg}</g>
${doom(2405, 952)}
${rammas()}
${TOWNS.map(townGlyph).join('')}
<circle cx="362" cy="404" r="46" fill="url(#haven)"/>
<g transform="translate(362 414)" stroke="${INK}" stroke-width="1.1"><path d="M-4 6V-14h8V6z" fill="${CARD}"/><path d="M-6 -14h12l-6 -8z" fill="${CARD}"/><circle cx="0" cy="-26" r="3" fill="#e6c76a" stroke-width="0.6"/></g>
${ship(SHIP.x, SHIP.y)}
${ltext}
${ornaments}
</g>
<circle cx="${W * 0.3}" cy="${H * 0.2}" r="260" fill="url(#stain)"/><circle cx="${W * 0.82}" cy="${H * 0.8}" r="300" fill="url(#stain)"/><circle cx="${W * 0.6}" cy="${H * 0.32}" r="170" fill="url(#stain)"/><circle cx="${W * 0.12}" cy="${H * 0.86}" r="200" fill="url(#stain)"/>
${[W / 4, W / 2, (3 * W) / 4].map((x) => `<rect x="${x - 7}" y="0" width="14" height="${H}" fill="url(#creaseV)"/>`).join('')}<rect x="0" y="${H / 2 - 7}" width="${W}" height="14" fill="url(#creaseH)"/>
${frame()}
</svg>
`;
  fs.writeFileSync(OUT, svg);
  console.log(`${path.relative(root, OUT)}  ${(svg.length / 1024).toFixed(0)} KB, ${relief2.length} relief glyphs, ${trees.length} trees, ${LBL.length} labels`);
})().catch((e) => { console.error(e); process.exit(1); });
