#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
// Paints the layered main-page hero (moonlit night + dawn) as small, self-contained SVGs:
//   wiki/assets/img/hero/{stars,moon,far,mid,near,mist}.svg  and  {far,mid,near,mist}-dawn.svg
// The scene is composed for a 16:9 frame (1600 x 900 art units; the top ~380 are sky, painted in CSS):
// a snow range lit by the moon at upper right, a white seven-tiered city on a rock spur under the moon,
// a chain of beacons, a still lake that mirrors city and moonlight, and fir-framed shores.
// Shapes are authored (PEAKS, HILLS, the city plan); seeded noise only roughens them, so every run
// paints the same picture.  node tools/brand/make-hero.js [output-dir]
'use strict';
const fs = require('fs');
const path = require('path');
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..', 'wiki', 'assets', 'img', 'hero');
fs.mkdirSync(out, { recursive: true });

const W = 1600, H = 900;
// Layout, in art units.  The layers are cover-scaled from the bottom centre, so x 40–1560 and y 130–900
// survive on every desktop screen; the title block sits in SAFE (x 380–1220, y 380–700) and gets no focal object.
const MOON = { x: 1370, y: 270 };                  // where Common.css puts the moon disc (x 1352–1390, y 210–335 at 1280–1920 px)
const SHORE = 708;                                 // far waterline of the lake
const CITY = { x: 1372 };                          // the white city stands under the moon, right of the title
const SEED = { far: 11, distant: 7, snow: 19, hills: 29, forest: 31, city: 41, lake: 43, near: 53, trees: 59, reeds: 67, mist: 61, stars: 71, moon: 83 };

// ---------------------------------------------------------------- noise
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function noise1(seed) {
  const r = rng(seed); const N = 2048; const lat = Array.from({ length: N }, r);
  return (x) => { const i = Math.floor(x), t = x - i, u = t * t * (3 - 2 * t); const a = lat[((i % N) + N) % N], b = lat[(((i + 1) % N) + N) % N]; return a + (b - a) * u; };
}
const fbm = (n, x, oct = 5) => { let s = 0, a = 1, f = 1, k = 0; for (let o = 0; o < oct; o++) { s += a * n(x * f + o * 31.7); k += a; a *= 0.5; f *= 2.03; } return s / k; };
const ridged = (n, x, oct = 6) => { let s = 0, a = 1, f = 1, k = 0; for (let o = 0; o < oct; o++) { const v = 1 - Math.abs(2 * n(x * f + o * 17.3) - 1); s += a * v * v; k += a; a *= 0.52; f *= 2.07; } return s / k; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smin = (a, b, k) => { const h = clamp(0.5 + (b - a) / (2 * k), 0, 1); return b + (a - b) * h - k * h * (1 - h); };   // smooth minimum

// ---------------------------------------------------------------- svg helpers
const f1 = (n) => { const v = Math.round(n * 10) / 10; return (v === 0 ? 0 : v).toString(); };
const f0 = (n) => { const v = Math.round(n); return (v === 0 ? 0 : v).toString(); };
const poly = (pts, fmt = f1) => 'M' + pts.map((p) => fmt(p[0]) + ' ' + fmt(p[1])).join(' ') + 'Z';       // implicit line-tos
const open = (pts, fmt = f1) => 'M' + pts.map((p) => fmt(p[0]) + ' ' + fmt(p[1])).join(' ');
function curve(pts, closeTo) {   // Catmull-Rom through all points, as cubic Béziers; closeTo = y to close down to
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return closeTo === undefined ? d : `${d}L${f1(pts[pts.length - 1][0])} ${closeTo}L${f1(pts[0][0])} ${closeTo}Z`;
}
const svg = (body, vb = `0 0 ${W} ${H}`, par = 'xMidYMax slice') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="${par}">${body}</svg>\n`;
const stops = (s) => s.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${+a.toFixed(3)}"` : ''}/>`).join('');
const vgrad = (id, y1, y2, s) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${f0(y1)}" x2="0" y2="${f0(y2)}">${stops(s)}</linearGradient>`;
const hgrad = (id, x1, x2, s) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f0(x1)}" y1="0" x2="${f0(x2)}" y2="0">${stops(s)}</linearGradient>`;
const rgrad = (id, s, extra = '') => `<radialGradient id="${id}"${extra}>${stops(s)}</radialGradient>`;
const blur = (id, sd, extra = 'x="-10%" y="-60%" width="120%" height="220%"') => `<filter id="${id}" ${extra}><feGaussianBlur stdDeviation="${sd}"/></filter>`;
const two = (c) => (Array.isArray(c) ? c : [c, c]);   // a colour or a [top, bottom] pair

// ---------------------------------------------------------------- palettes
// night: ink-blue vellum and moonlight, warm only in fire and windows.  dawn: the same land in rose and gold.
const PAL = {
  night: {
    distant: { shade: ['#363c69', '#2f3560'], lit: ['#4d5585', '#3c4371'], snow: ['#9aa4cf', '#7983b3'], snowShade: ['#5f6896', '#4d5584'], mist: '#3b4274', mistA: 0.8, rim: '#c9d0f5',
      gully: '#2c3159', gullyA: 0.3, sliver: '#4d5585', sliverA: 0.3, rib: '#343a66', ribA: 0.5, tex: '#5d669a', texA: 0.25 },
    main: { shade: ['#222646', '#1a1d38'], lit: ['#474f7c', '#2b3056'], snow: ['#e9ecf8', '#aab3d8'], snowShade: ['#6e7699', '#4f577f'], rib: '#1b1e38', ribA: 0.6,
      gully: '#161930', gullyA: 0.55, sliver: '#59628f', sliverA: 0.38, rim: '#f6f7ff', mist: '#2f3563', mistA: 0.9, tex: '#7a83b0', texA: 0.22 },
    haze: '#8e98cf', hazeA: 0.15,                                   // moonlit haze behind the city
    beacon: '#ffb347', flame: ['#ff8a2a', '#ffd36b', '#fff4cf'], beaconA: 1,
    hills: { shade: ['#181b37', '#11132a'], lit: ['#272d52', '#161a33'], forest: '#0d0f22', rim: '#9aa5d8', mist: '#2a3160', mistA: 0.7, gully: '#11132a', gullyA: 0.4, sliver: '#272d52', sliverA: 0.3 },
    stone: { wall: ['#626b9b', '#b3bade', '#f4f6fd', '#dde1f4'], house: ['#353c69', '#5f6896', '#a0a8d0', '#8b93c2'], roof: '#30365f', roofLit: '#6c76a6', dark: '#363d6a', win: '#ffcf7f', winA: 0.95,
      rock: ['#2c3259', '#1b1f3c'], rockLit: '#7882b2', prow: ['#3c4371', '#8790bd'], shadow: '#0c0e20' },
    lake: { water: ['#30365f', '#1c1f3e', '#0d0e21'], mtn: '#1b1f3f', snow: '#7e88b8', hills: '#0f1129', refl: 0.75, glow: 0.24, glintA: 0.75, ripA: 0.12, aura: 0.16 }, glint: '#e2e7ff', shoreGlint: '#9aa4d6',
    near: ['#121526', '#07080f'], nearLit: '#454e7e', firFar: '#0c0e1c', fir: '#05060c', firRim: '#9aa4d6', firRimA: 0.38, menhir: '#10121f', menhirLit: '#5a6392', reed: '#090a15', reedLit: '#8590c2',
    mist: '#aab4dc', mistA: 0.14,
  },
  dawn: {
    distant: { shade: ['#b9a8c0', '#b3a1b8'], lit: ['#e1c6c2', '#d2b6b6'], snow: ['#fff5ee', '#f6e0da'], snowShade: ['#d6cbe0', '#c9bcd4'], mist: '#ecd3c8', mistA: 0.85, rim: '#fff6e6',
      gully: '#a594b0', gullyA: 0.3, sliver: '#d8bfbf', sliverA: 0.3, rib: '#a897b0', ribA: 0.45, tex: '#efd8d0', texA: 0.3 },
    main: { shade: ['#7f7395', '#6c6487'], lit: ['#cfa392', '#a58783'], snow: ['#fff8ef', '#ffdcc8'], snowShade: ['#c3bcdc', '#a7a1c8'], rib: '#5e5170', ribA: 0.5,
      gully: '#62577a', gullyA: 0.42, sliver: '#cba9a5', sliverA: 0.38, rim: '#fffaf0', mist: '#ead0c7', mistA: 0.9, tex: '#f2cdb6', texA: 0.28 },
    haze: '#fff0d8', hazeA: 0.24,
    beacon: '#ffb04a', flame: ['#ff8f3a', '#ffd27a', '#fff6dc'], beaconA: 0.7,
    hills: { shade: ['#64607a', '#545068'], lit: ['#a2856f', '#79675f'], forest: '#45414f', rim: '#ffe0b8', mist: '#e6cbc0', mistA: 0.6, gully: '#4e4a61', gullyA: 0.35, sliver: '#9b8273', sliverA: 0.3 },
    stone: { wall: ['#a48f98', '#e4cdbd', '#fff6e4', '#f3e1cd'], house: ['#7a6878', '#a8918e', '#dcc3b0', '#c9b2a2'], roof: '#6f5f72', roofLit: '#b98a74', dark: '#6e5d6c', win: '#ffd38a', winA: 0.5,
      rock: ['#867685', '#635667'], rockLit: '#d0a68a', prow: ['#8a7685', '#dbb89c'], shadow: '#4a3c4c' },
    lake: { water: ['#f3dcc6', '#c9b5bb', '#85737c'], mtn: '#9c8ca4', snow: '#fff4ec', hills: '#625a70', refl: 0.6, glow: 0.35, glintA: 0.75, ripA: 0.25, aura: 0.22 }, glint: '#fff7e6', shoreGlint: '#fff3e0',
    near: ['#45372b', '#2b231c'], nearLit: '#b88d62', firFar: '#4a4140', fir: '#2d2620', firRim: '#f6c995', firRimA: 0.45, menhir: '#4a3d33', menhirLit: '#c49b72', reed: '#3b3128', reedLit: '#ecc08a',
    mist: '#fff1e0', mistA: 0.18,
  },
};

// ---------------------------------------------------------------- mountains
// A range is a list of designed summits.  Each summit is a profile (steep near the top, spreading at the
// foot, a shoulder or two on the way down); the profiles are joined with a smooth minimum so cols are
// rounded, then roughened by noise that grows with altitude.  Light is painted, not computed: each summit
// gets a spine running down towards the viewer; the face between the spine and the next col faces the
// moon (lit), the rest is in shadow.  Spurs cut both faces into the rhythm of light and dark that makes rock.
function range(spec) {
  const { peaks, base, seed, step = 3, rough = 1 } = spec;
  const nA = noise1(seed), nB = noise1(seed + 101), nC = noise1(seed + 202);
  const top = Math.min(...peaks.map((p) => p.y));
  const prof = (p, x) => {
    const dx = x - p.x, t = Math.abs(dx) / (dx < 0 ? p.wl : p.wr);
    if (t >= 1) return base + (t - 1) * 80;
    if (p.round) return p.y + ((base - p.y) * (1 - Math.cos(Math.PI * t))) / 2;
    if (p.dome) return p.y + (base - p.y) * Math.pow(t, p.dome);
    const terrace = Math.sin(t * (6 + (Math.abs(p.x) % 4)) + p.x * 0.37 + (dx < 0 ? 2 : 0)) * t * (1 - t) * 0.18;
    return p.y + (base - p.y) * (1 - Math.pow(1 - t, p.k || 1.7) + terrace);
  };
  const pts = [];
  for (let x = -24; x <= W + 24; x += step) {
    let y = base + 80;
    for (const p of peaks) y = smin(y, prof(p, x), spec.soft || 12);
    const alt = clamp((base - y) / (base - top), 0, 1);
    y += rough * ((fbm(nA, x / 80, 4) - 0.5) * (4 + 18 * alt) - ridged(nB, x / 21, 3) * (1.5 + 9 * alt * alt) - ridged(nC, x / 6.5, 2) * (0.4 + 2.4 * alt));
    pts.push([x, y]);
  }
  const at = (x) => { const u = clamp((x + 24) / step, 0, pts.length - 1.001), i = Math.floor(u); return [x, lerp(pts[i][1], pts[i + 1][1], u - i)]; };
  const sorted = peaks.slice().sort((a, b) => a.x - b.x);
  const sum = sorted.map((p) => {
    const c = clamp(Math.round((p.x + 24) / step), 0, pts.length - 1), span = Math.max(2, Math.round((Math.min(p.wl, p.wr) * 0.2) / step));
    let best = c; for (let i = c - span; i <= c + span; i++) if (pts[i] && pts[i][1] < pts[best][1]) best = i;
    return best;
  });
  const cols = [];
  for (let i = 0; i < sum.length - 1; i++) { let c = sum[i]; for (let j = sum[i]; j <= sum[i + 1]; j++) if (pts[j][1] > pts[c][1]) c = j; cols.push(c); }
  const yb = base + 40;
  const lit = [], slivers = [], gullies = [], soft = [], rims = [], tex = [];
  sorted.forEach((p, i) => {
    const s = sum[i], S = pts[s], cl = i ? cols[i - 1] : 0, cr = i < cols.length ? cols[i] : pts.length - 1;
    const r = rng(seed * 31 + i * 7), nS = noise1(seed * 7 + i);
    const lean = p.lean ?? -0.12;
    // the spine: from the summit down towards the viewer, wandering a little
    const spine = [];
    for (let y = S[1]; y < yb; y += 6) { const u = (y - S[1]) / (yb - S[1]); spine.push([S[0] + lean * (y - S[1]) + (nS(y / 26) - 0.5) * 18 * Math.sqrt(u), y]); }
    spine.push([S[0] + lean * (yb - S[1]), yb]);
    const C = pts[cr], valley = [];
    for (let y = C[1]; y < yb; y += 8) valley.push([C[0] + 0.12 * (y - C[1]) + (nS(y / 30 + 9) - 0.5) * 10, y]);
    valley.push([C[0] + 0.12 * (yb - C[1]), yb]);
    if (cr - s >= 2) lit.push([...pts.slice(s, cr + 1), ...valley, ...spine.slice().reverse()]);
    if (!spec.detail) return;
    const k = spec.detail;   // 1 = full detail, < 1 = sparser (far away)
    // fall lines fan out from the summit
    const fall = (Q, len, wobble, kk) => { const fan = clamp((Q[0] - S[0]) / (Q[1] - S[1] + 70), -1.2, 1.2) * 0.55; const o = [];
      for (let j = 0; j <= 6; j++) { const t = j / 6; o.push([Q[0] + fan * t * len + (nS(t * 3 + kk * 5) - 0.5) * wobble * t, Q[1] + 1 + t * len]); } return o; };
    // spurs on the lit face: a crisp crest, its shadow spilling to the left into the gully
    const nG = Math.round(((cr - s) * step * k) / 22);
    for (let g = 0; g < nG; g++) {
      const qi = Math.round(s + (cr - s) * (0.04 + ((g + 0.15 + r() * 0.7) / nG) * 0.9)), Q = pts[qi];
      const len = (yb - Q[1]) * (0.22 + r() * 0.62), wmax = 1.6 + r() * 6, crest = fall(Q, len, 8, g);
      const back = crest.map(([x, y], j) => [x - wmax * Math.sin(Math.PI * Math.min(1, (j / 6) * 1.2 + 0.06)) * (0.4 + 0.6 * r()), y]);
      gullies.push([...crest, ...back.reverse()]);
      const back2 = crest.map(([x, y], j) => [x - wmax * 3 * Math.sin(Math.PI * Math.min(1, (j / 6) * 1.1 + 0.08)) * (0.7 + 0.3 * r()), y]);
      soft.push([...crest, ...back2.reverse()]);
    }
    // the shadowed face: spurs whose moon-facing flanks catch a sliver of light
    const nL = Math.round(((s - cl) * step * k) / 20);
    for (let g = 0; g < nL; g++) {
      const qi = Math.round(cl + (s - cl) * (0.15 + ((g + 0.2 + r() * 0.6) / nL) * 0.8)), Q = pts[qi];
      const len = (yb - Q[1]) * (0.25 + r() * 0.5), wmax = 1.5 + r() * 5, crest = fall(Q, len, 6, g + 9);
      const back = crest.map(([x, y], j) => [x + wmax * Math.sin(Math.PI * Math.min(1, (j / 6) * 1.3 + 0.05)) * (0.5 + 0.5 * r()), y]);
      slivers.push([...crest, ...back.reverse()]);
    }
    // dry-brush texture: short strokes down the fall lines
    for (let q = 0; q < ((cr - cl) * step * k) / 9; q++) {
      const Q = pts[Math.round(lerp(cl, cr, r()))], y0 = Q[1] + 5 + r() * (yb - Q[1]) * 0.55;
      const fan = clamp((Q[0] - S[0]) / (y0 - S[1] + 70), -1.2, 1.2) * 0.5, len = 4 + r() * 12;
      tex.push(`M${f0(Q[0] + (r() - 0.5) * 6)} ${f0(y0)}l${f1(fan * len)} ${f0(len)}`);
    }
    // rim light: only just right of a summit, where the ridge faces the moon
    const n = Math.round((p.wr * (p.rim ?? 0.22)) / step);
    if (n > 2) rims.push({ pts: pts.slice(Math.max(cl, s - 2), Math.min(cr, s + n) + 1), x1: S[0], x2: S[0] + n * step });
  });
  return { pts, at, top, base, yb, lit, slivers, gullies, soft, rims, tex, sum, sorted };
}

// snow: deep on the high fields, gone on steep rock, tongues down the couloirs; ribs of rock break it up
function snowOf(R, spec) {
  const { y: SL, depth, seed, ribs: ribRate = 1 } = spec;
  const n1 = noise1(seed), n2 = noise1(seed + 1), n3 = noise1(seed + 2), r = rng(seed + 3);
  const { pts } = R, step = pts[1][0] - pts[0][0];
  const bottom = pts.map(([x, y], i) => {
    const line = SL + (fbm(n1, x / 110, 3) - 0.5) * 44;
    const tongue = Math.pow(ridged(n2, x / 13, 2), 4) * 34 * smooth(0.35, 0.65, n3(x / 47 + 5)) + Math.pow(ridged(n2, x / 5 + 40, 1), 6) * 9;
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    const slope = Math.abs((b[1] - a[1]) / (b[0] - a[0]));
    const keep = 1 - 0.85 * smooth(1.6, 2.5, slope) * (fbm(n3, x / 30, 2) > 0.45 ? 1 : 0.3);   // steep crags shed their snow
    const d = Math.min(line + tongue - y, depth + tongue) * keep;
    return [x, y + Math.max(0, d)];
  });
  const polys = [], ribs = [], streaks = [];
  let run = [];
  const flush = () => { if (run.length > 2) polys.push([...run.map((i) => pts[i]), ...run.slice().reverse().map((i) => bottom[i])]); run = []; };
  pts.forEach((_, i) => { if (bottom[i][1] - pts[i][1] > 1.2) run.push(i); else flush(); });
  flush();
  // the nearest summit decides which way the fall lines lean
  const summitX = (x) => R.sum.map((i) => pts[i][0]).reduce((m, s) => (Math.abs(s - x) < Math.abs(m - x) ? s : m), 1e9);
  const lens = (X0, Y0, len, w, fan, wob, sym) => { const L = [], Rr = []; for (let j = 0; j <= 6; j++) { const t = j / 6, cx = X0 + fan * len * t + (n1(t * 4 + X0) - 0.5) * wob * t, cy = Y0 + len * t, ww = w * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.1)); L.push([cx - ww, cy]); Rr.push([cx + ww * sym, cy]); } return [...L, ...Rr.reverse()]; };
  for (let i = 2; i < pts.length - 2; i++) {
    const d = bottom[i][1] - pts[i][1];
    if (d < 6) continue;
    const [x, y] = pts[i], sx = summitX(x), fan = clamp((x - sx) / 150, -0.75, 0.75);
    if (r() < (step / 13) * ribRate) ribs.push(lens(x + (r() - 0.5) * 3, y + 1.5, d * (0.35 + r() * 0.75), 0.8 + r() * 1.8, fan, 5, 0.55));   // a rib of rock into the snow
    const tg = bottom[i][1] - bottom[i - 1][1], tg2 = bottom[i + 1][1] - bottom[i][1];
    if (tg > 0 && tg2 <= 0 && d > 10 && r() < 0.55) {   // a couloir: the snow tongue runs on down the gully
      const len = 6 + Math.pow(r(), 2) * 70, w = 1.4 + r() * 2.2, X0 = bottom[i][0], Y0 = bottom[i][1] - 4, L = [], Rr = [];
      for (let j = 0; j <= 6; j++) { const t = j / 6, cx = X0 + fan * len * t * 0.8 + (n1(t * 3 + i) - 0.5) * 3 * t, cy = Y0 + len * t, ww = w * (1 - t) ** 1.3; L.push([cx - ww, cy]); Rr.push([cx + ww, cy]); }
      streaks.push([...L, ...Rr.reverse()]);
    }
  }
  return { polys, ribs, streaks };
}

// paints one range: silhouette in shadow, spur slivers, moon-facing faces, gullies, texture, two-tone snow, ribs, rim
function paintRange(id, R, c, snow, opt = {}) {
  const lid = `${id}l`, P = (arr, fmt = f1) => arr.map((q) => poly(q, fmt)).join('');
  let defs = vgrad(`${id}s`, R.top, R.yb, [[0, two(c.shade)[0]], [1, two(c.shade)[1]]]) +
    vgrad(`${id}g`, R.top, R.yb, [[0, two(c.lit)[0]], [0.7, two(c.lit)[1]], [1, two(c.lit)[1], 0.5]]) +
    `<path id="${lid}" d="${P(R.lit)}"/><clipPath id="${id}c"><use href="#${lid}"/></clipPath>` +
    `<path id="${id}x" d="${poly([...R.pts, [W + 24, R.yb + 20], [-24, R.yb + 20]])}"/>`;
  let body = `<use href="#${id}x" fill="url(#${id}s)"/>`;
  if (R.slivers.length) body += `<path fill="${c.sliver}" opacity="${c.sliverA}" d="${P(R.slivers, f0)}"/>`;
  body += `<use href="#${lid}" fill="url(#${id}g)"/>`;
  if (R.gullies.length) body += `<g fill="${c.gully}" clip-path="url(#${id}c)"><path opacity="${(c.gullyA * 0.4).toFixed(2)}" d="${P(R.soft, f0)}"/><path opacity="${c.gullyA}" d="${P(R.gullies, f0)}"/></g>`;
  if (R.tex.length) body += `<path fill="none" stroke="${c.sliver}" stroke-width="0.9" stroke-linecap="round" opacity="${(c.sliverA * 0.7).toFixed(2)}" d="${R.tex.filter((_, i) => i % 3 === 2).join('')}"/>` +
    `<path fill="none" stroke="${c.tex}" stroke-width="0.8" stroke-linecap="round" opacity="${c.texA}" clip-path="url(#${id}c)" d="${R.tex.join('')}"/>` +
    `<path fill="none" stroke="${c.gully}" stroke-width="0.8" stroke-linecap="round" opacity="${(c.gullyA * 0.6).toFixed(2)}" d="${R.tex.filter((_, i) => i % 3 === 1).join('')}"/>`;
  // grain on the rock only, so the snow stays clean and luminous
  if (opt.grain) body += `<use href="#${id}x" fill="url(#gd)" opacity="${opt.grain}"/><use href="#${id}l" fill="url(#gl)" opacity="${(opt.grain * 0.55).toFixed(2)}"/>`;
  if (snow) {
    const sd = P(snow.polys) + P(snow.streaks);
    const sTop = R.top, sBot = opt.snowY + 60;
    defs += vgrad(`${id}w`, sTop, sBot, [[0, two(c.snowShade)[0]], [1, two(c.snowShade)[1]]]) +
      vgrad(`${id}v`, sTop, sBot, [[0, two(c.snow)[0]], [1, two(c.snow)[1]]]) + `<path id="${id}d" d="${sd}"/>`;
    body += `<use href="#${id}d" fill="url(#${id}w)"/><use href="#${id}d" fill="url(#${id}v)" clip-path="url(#${id}c)"/>`;
    if (snow.ribs.length) body += `<path fill="${c.rib}" opacity="${c.ribA}" d="${P(snow.ribs)}"/>`;
  }
  R.rims.forEach((m, k) => {
    defs += hgrad(`${id}r${k}`, m.x1 - 8, m.x2, [[0, c.rim, 0.25], [0.12, c.rim, 0.95], [1, c.rim, 0]]);
    body += `<path fill="none" stroke="url(#${id}r${k})" stroke-width="${opt.rimW || 1.4}" stroke-linejoin="round" stroke-linecap="round" d="${open(m.pts)}"/>`;
  });
  return { defs, body };
}

// grain: a tile of tiny specks laid over a range, so its flat washes read as pigment on vellum
function grain(id, color, seed, n = 90, size = 48) {
  const r = rng(seed); let d = '';
  for (let k = 0; k < n; k++) { const x = r() * size, y = r() * size, w = 0.5 + r() * 1.3; d += `M${f1(x)} ${f1(y)}h${f1(w)}v${f1(0.45 + r() * 0.6)}h${f1(-w)}z`; }
  return `<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse"><path fill="${color}" d="${d}"/></pattern>`;
}

// mist lying at the foot of a range: a soft, patchy bank that climbs into the valleys between the summits
function mistBank(id, R, y, h, color, alpha, seed, floor = y + h + 40) {
  const n = noise1(seed), r = rng(seed), pts = [];
  for (let x = -40; x <= W + 40; x += 16) {
    const low = clamp((R.at(x)[1] - R.top) / (R.base - R.top), 0, 1);           // 1 where the range dips to its foot
    pts.push([x, y - h * (0.05 + 1.05 * low * low) + (fbm(n, x / 110, 3) - 0.5) * h * 1.3]);
  }
  let puffs = '';
  for (let x = -60; x < W + 60; x += 60 + r() * 110) puffs += `<ellipse cx="${f0(x)}" cy="${f0(y - h * (0.1 + r() * 0.8))}" rx="${f0(60 + r() * 130)}" ry="${f0(h * (0.18 + r() * 0.3))}" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
  return {
    defs: vgrad(`${id}m`, y - h * 1.2, y + h * 0.6, [[0, color, 0], [0.55, color, alpha * 0.45], [1, color, alpha]]) + blur(`${id}b`, 7) +
      rgrad(`${id}p`, [[0, color, alpha * 0.45], [1, color, 0]]),
    body: `<path fill="url(#${id}m)" filter="url(#${id}b)" d="${curve(pts, f0(floor))}"/><g fill="url(#${id}p)">${puffs}</g>`,
  };
}

// a beacon fire: a soft glow and a small flickering flame
function beacon(x, y, s, p, id) {
  const [o, m, c] = p.flame;
  return `<circle cx="${f1(x)}" cy="${f1(y - s * 1.2)}" r="${f1(s * 7)}" fill="url(#${id})" opacity="${p.beaconA}"/>` +
    `<path fill="${o}" d="M${f1(x - s)} ${f1(y)}c${f1(-s * 0.3)} ${f1(-s * 1.3)} ${f1(s * 0.3)} ${f1(-s * 1.6)} ${f1(s * 0.5)} ${f1(-s * 3)}c${f1(s * 0.3)} ${f1(s * 1.2)} ${f1(s * 1.2)} ${f1(s * 1.5)} ${f1(s * 0.5)} ${f1(s * 3)}z"/>` +
    `<path fill="${m}" d="M${f1(x - s * 0.5)} ${f1(y)}c0 ${f1(-s)} ${f1(s * 0.3)} ${f1(-s * 1.2)} ${f1(s * 0.35)} ${f1(-s * 2)}c${f1(s * 0.2)} ${f1(s * 0.9)} ${f1(s * 0.7)} ${f1(s * 1.1)} ${f1(s * 0.15)} ${f1(s * 2)}z"/>` +
    `<circle cx="${f1(x - s * 0.1)}" cy="${f1(y - s * 0.5)}" r="${f1(s * 0.45)}" fill="${c}"/>`;
}

// ---------------------------------------------------------------- far: distant range, the great snow range, beacons
// The main range is high at the sides and low in the middle, where the title sits; the moon looks down into
// the notch between the city's mountain (right) and the title.  The distant range shows only in that gap.
const DISTANT = [
  { x: 390, y: 450, wl: 230, wr: 210, k: 1.5 }, { x: 650, y: 474, wl: 230, wr: 200, k: 1.45 }, { x: 870, y: 454, wl: 230, wr: 250, k: 1.6 },
  { x: 1090, y: 480, wl: 200, wr: 200, k: 1.4 }, { x: 1330, y: 468, wl: 200, wr: 220, k: 1.4 },
];
const PEAKS = [
  { x: -40, y: 362, wl: 220, wr: 200, k: 1.4 },
  { x: 116, y: 302, wl: 150, wr: 160, k: 1.5, lean: -0.06 },
  { x: 240, y: 250, wl: 210, wr: 290, k: 1.6, lean: -0.15, rim: 0.3 },     // the great peak, left of the title
  { x: 384, y: 384, wl: 90, wr: 160, k: 1.3 },
  { x: 525, y: 456, wl: 140, wr: 190, k: 1.2, lean: -0.05 },
  { x: 690, y: 518, wl: 230, wr: 190, dome: 1.6 },
  { x: 840, y: 512, wl: 70, wr: 80, k: 1.5 },
  { x: 950, y: 530, wl: 190, wr: 220, dome: 1.7 },
  { x: 1085, y: 500, wl: 100, wr: 110, k: 1.45 },
  { x: 1212, y: 466, wl: 120, wr: 130, k: 1.45 },
  { x: 1432, y: 420, wl: 110, wr: 100, k: 1.4 },
  { x: 1562, y: 308, wl: 200, wr: 230, k: 1.6, lean: -0.2, rim: 0.3 },     // the city's mountain
  { x: 1730, y: 360, wl: 120, wr: 150, k: 1.5 },
];
const BEACONS = [[1212, 1.9], [1085, 1.4], [840, 1]];   // [summit x, size]: the chain runs from the city towards the centre
// the ranges are shared by both palettes and by the lake, which mirrors the main range
let GEO = null;
function geo() {
  if (GEO) return GEO;
  const D = range({ peaks: DISTANT, base: 600, seed: SEED.distant, step: 5, rough: 0.6, soft: 24, detail: 0.4 });
  const M = range({ peaks: PEAKS, base: 645, seed: SEED.far, step: 3, detail: 1 });
  GEO = { D, M, dSnow: snowOf(D, { y: 488, depth: 34, seed: SEED.snow + 50, ribs: 0.5 }), mSnow: snowOf(M, { y: 438, depth: 125, seed: SEED.snow }) };
  return GEO;
}
function far(p) {
  const { D, M, dSnow, mSnow } = geo();
  const d = paintRange('d', D, p.distant, dSnow, { snowY: 488, rimW: 0.9 });
  const m = paintRange('m', M, p.main, mSnow, { snowY: 438, rimW: 1.5, grain: 0.5 });
  const dm = mistBank('a', D, 588, 46, p.distant.mist, p.distant.mistA, 3);
  const mm = mistBank('b', M, 640, 60, p.main.mist, p.main.mistA, 5);
  // the beacon chain, on the summits between the city and the centre
  const fires = BEACONS.map(([x, s]) => { let best = M.at(x); for (let k = -6; k <= 6; k++) { const q = M.at(x + k * 3); if (q[1] < best[1]) best = q; } return beacon(best[0], best[1] + 1, s, p, 'bf'); }).join('');
  return svg(
    `<defs>${d.defs}${m.defs}${dm.defs}${mm.defs}` + grain('gd', p.main.gully, 5) + grain('gl', p.main.tex, 6, 60) +
    rgrad('hz', [[0, p.haze, p.hazeA], [0.5, p.haze, p.hazeA * 0.45], [1, p.haze, 0]], ` gradientUnits="userSpaceOnUse" cx="${MOON.x}" cy="560" r="360" gradientTransform="matrix(1 0 0 0.55 0 252)"`) +
    rgrad('bf', [[0, p.beacon, 0.55], [0.35, p.beacon, 0.16], [1, p.beacon, 0]]) + `</defs>` +
    d.body + dm.body + m.body + mm.body +
    `<rect x="0" y="300" width="${W}" height="420" fill="url(#hz)"/>` + fires
  );
}

// ---------------------------------------------------------------- firs
// a fir: drooping, ragged branch tiers on a slightly leaning leader.  When rimOut is given, the upper edges
// of the moon-side branches are collected for a rim of light.
function conifer(x, base, h, w, r, rimOut, fmt = f1) {
  const big = h > 110;
  const tiers = clamp(Math.round(h / (big ? 18 : 6.5)), 3, 30);
  const lean = (r() - 0.5) * 0.05, X = (y) => x + (base - y) * lean;
  const L = [], R = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers, st = (h * 0.9) / tiers, y = base - h * 0.07 - st * i;
    const env = Math.pow(1 - t, 0.92) * (0.84 + 0.3 * r());
    for (const sg of [-1, 1]) {
      const wi = w * env * (0.72 + r() * 0.5), dr = st * (0.55 + r() * 0.55), xc = X(y);
      // outward along the upper edge to the drooping tip, back in along a ragged underside
      const b = [[xc + sg * wi * 0.2, y - st * 0.8]];
      if (big) b.push([xc + sg * wi * 0.6, y - st * 0.3 + (r() - 0.5) * st * 0.3]);
      b.push([xc + sg * wi, y + dr * 0.6]);
      if (big) b.push([xc + sg * wi * 0.84, y + dr * 0.25 + r() * st * 0.25], [xc + sg * wi * 0.68, y + dr * 0.5 + r() * st * 0.2], [xc + sg * wi * 0.46, y + dr * 0.12]);
      else b.push([xc + sg * wi * 0.42, y + dr * 0.12]);
      (sg < 0 ? L : R).push(b);
      if (rimOut && sg > 0 && t > 0.35 && r() < 0.6) { const [u, v] = [b[big ? 1 : 0], b[big ? 2 : 1]]; rimOut.push([[lerp(u[0], v[0], 0.45), lerp(u[1], v[1], 0.45)], v]); }
    }
  }
  const tip = [X(base - h), base - h];
  const left = []; L.forEach((b) => left.push(...b.slice().reverse()));     // bottom tier first, underside then upper edge
  const right = []; for (let i = R.length - 1; i >= 0; i--) right.push(...R[i]);   // top tier first, upper edge then underside
  return poly([[x - w * 0.05, base + 3], ...left, tip, ...right, [x + w * 0.05, base + 3]], fmt);
}

// ---------------------------------------------------------------- the white city
// Seven rings of wall climb a hill under the mountain; ring 0 is the outer (lowest) wall.  We look up at it
// from the lake, so each ring curves down towards its ends.  A keel of rock (the prow) splits the upper rings
// and points at the viewer; the citadel and the White Tower crown it, a beacon burning in the tower's lantern.
const RINGS = Array.from({ length: 7 }, (_, i) => ({ R: 120 - i * 15, top: 672 - i * 18.8, sag: 10 - i * 1.1, h: (i ? 9 : 12) - i * 0.5 }));
const ringY = (g, dx) => g.top + g.sag * (dx / g.R) ** 2 * (dx < 0 ? 1.3 : 0.8);   // wall top: the rings curve down to their ends
const prowW = (y) => lerp(11, 4, clamp((y - 550) / 112, 0, 1));       // half-width of the rock prow at height y
function city(p, seed) {
  const r = rng(seed), cx = CITY.x, s = p.stone;
  const crown = RINGS[6].top - 3;                                       // the citadel's level
  let houses = '', walls = '', wallTops = '', wallFeet = '', wins = '', lights = '', roofs = '', roofLit = '', spires = '';
  // the hill the city is built on: rock showing between the ends of the rings and in the cliff under the gate
  const end = (g, sg) => [cx + sg * (g.R + 3), ringY(g, g.R) + g.h + 2];
  const hill = [[cx - 240, SHORE + 2], [cx - 182, SHORE - 7], [cx - 142, SHORE - 16], ...RINGS.map((g) => end(g, -1)),
    [cx - 22, crown - 1], [cx + 24, crown - 3], ...RINGS.slice().reverse().map((g) => end(g, 1)), [cx + 150, SHORE - 22], [cx + 215, SHORE - 9], [cx + 270, SHORE + 2]];
  const hillLit = [[cx + 8, crown], ...RINGS.slice().reverse().map((g) => end(g, 1)), [cx + 150, SHORE - 22], [cx + 90, SHORE - 7], [cx + 30, SHORE - 3], [cx + 10, RINGS[0].top + 14]];
  let rocks = '';   // crags in the cliff below the outer wall
  for (let k = 0; k < 16; k++) { const x = cx + (r() - 0.5) * 210, y0 = ringY(RINGS[0], x - cx) + RINGS[0].h + 3 + r() * 6, len = 4 + r() * 12; rocks += `M${f1(x)} ${f1(y0)}l${f1(1 + r() * 2)} ${f1(len)}l${f1(-1.6 - r() * 2)} ${f1(-len * 0.6)}z`; }
  for (let i = 6; i >= 0; i--) {
    const g = RINGS[i], pw = i ? prowW(g.top) + 1 : 0;
    // houses on the terrace behind this wall (in front of the next ring up): gables, a few towers and domes
    if (i < 6) {
      for (let dx = -g.R + 5; dx < g.R - 4; dx += 3.2 + r() * 3.8) {
        if (Math.abs(dx) < prowW(g.top - 8) + 2.5) continue;
        const tall = r() < 0.09, w = tall ? 3 + r() * 1.6 : 3.4 + r() * 4.4;
        const hh = tall ? 11 + r() * 8 : 3.5 + r() * 6.5 + (i < 2 ? 1.5 : 0), y0 = ringY(g, dx) + 1.5, x0 = cx + dx - w / 2;
        houses += `M${f1(x0)} ${f1(y0)}V${f1(y0 - hh)}H${f1(x0 + w)}V${f1(y0)}Z`;
        const lit = dx > -g.R * 0.1;
        if (tall) spires += `M${f1(x0 - 0.4)} ${f1(y0 - hh)}L${f1(x0 + w / 2)} ${f1(y0 - hh - w * 1.6)}L${f1(x0 + w + 0.4)} ${f1(y0 - hh)}Z`;
        else if (r() < 0.78) {   // gabled roof
          const rh = w * (0.4 + r() * 0.22), rd = `M${f1(x0 - 0.5)} ${f1(y0 - hh)}L${f1(x0 + w / 2)} ${f1(y0 - hh - rh)}L${f1(x0 + w + 0.5)} ${f1(y0 - hh)}Z`;
          if (lit) roofLit += rd; else roofs += rd;
        } else if (r() < 0.4) houses += `M${f1(x0)} ${f1(y0 - hh)}a${f1(w / 2)} ${f1(w * 0.45)} 0 0 1 ${f1(w)} 0Z`;   // a little dome
        if (r() < 0.3) lights += `M${f1(cx + dx - 0.5)} ${f1(y0 - hh * 0.55)}h1v1.3h-1z`;
      }
    }
    // the wall: an arc from end to end, cut by the prow on the upper rings
    const seg = (a, b) => { const top = [], bot = []; for (let k = 0; k <= 10; k++) { const dx = lerp(a, b, k / 10); top.push([cx + dx, ringY(g, dx)]); bot.push([cx + dx, ringY(g, dx) + g.h]); } return { top, bot }; };
    const parts = i ? [seg(-g.R, -pw), seg(pw, g.R)] : [seg(-g.R, g.R)];
    for (const { top, bot } of parts) { walls += poly([...top, ...bot.slice().reverse()]); wallTops += open(top); wallFeet += open(bot); }
    if (i > 0 && i < 6) for (const sg of [-1, 1]) {
      const dx = sg * g.R * (0.42 + r() * 0.4), y = ringY(g, dx), w = 4.6 + r() * 2.2, th = 5 + r() * 5;
      walls += `M${f1(cx + dx - w / 2)} ${f1(y + g.h)}V${f1(y - th)}H${f1(cx + dx + w / 2)}V${f1(y + g.h)}Z`; wallTops += `M${f1(cx + dx - w / 2)} ${f1(y - th)}h${f1(w)}`;
    }
    // windows in a row under the wall top; a few are lit
    for (let dx = -g.R + 4; dx < g.R - 3; dx += 3.2 + r() * 2.4) {
      if (i && Math.abs(dx) < pw + 2) continue;
      if (r() < 0.2) continue;
      const y = ringY(g, dx) + 2.6 + (i ? 0 : 1.5);
      if (r() < 0.16) lights += `M${f1(cx + dx)} ${f1(y)}h1.1v1.7h-1.1z`; else wins += `M${f1(cx + dx)} ${f1(y)}h1v1.6h-1z`;
    }
  }
  // the outer wall's bastions and the great gate under the prow
  const g0 = RINGS[0], gy = ringY(g0, 0) + g0.h;
  let bastions = '';
  for (const dx of [-g0.R + 7, -g0.R * 0.52, -11, 11, g0.R * 0.52, g0.R - 7]) {
    const y = ringY(g0, dx), w = Math.abs(dx) < 20 ? 7 : 9;
    bastions += `M${f1(cx + dx - w / 2)} ${f1(y + g0.h + 1)}V${f1(y - 5)}H${f1(cx + dx + w / 2)}V${f1(y + g0.h + 1)}Z`;
  }
  const gate = `M${f1(cx - 3.4)} ${f1(gy)}V${f1(gy - 5.5)}a3.4 3.4 0 0 1 6.8 0V${f1(gy)}Z`;
  // the prow: a keel of rock from the second ring up to the citadel, its edge towards the viewer
  const pTop = crown - 2, pBot = RINGS[1].top + RINGS[1].h + 3, kx = cx + 1.5;
  const prowL = poly([[kx, pTop - 3], [cx - prowW(pTop), pTop], [cx - prowW(pBot) + 1, pBot], [kx, pBot + 4]]);
  const prowR = poly([[kx, pTop - 3], [cx + prowW(pTop), pTop], [cx + prowW(pBot) - 1, pBot], [kx, pBot + 4]]);
  const prowRim = `M${f1(cx - prowW(pTop) - 1)} ${f1(pTop)}L${f1(kx)} ${f1(pTop - 3)}L${f1(cx + prowW(pTop) + 1)} ${f1(pTop)}`;
  // the citadel: a hall and a domed house round the foot of the White Tower
  const tx = cx - 13, tb = crown - 1, tt = tb - 92;
  const citadel = `M${f1(cx + 3)} ${f1(tb + 2)}V${f1(tb - 10)}H${f1(cx + 27)}V${f1(tb + 2)}Z` + `M${f1(cx - 31)} ${f1(tb + 2)}V${f1(tb - 6)}H${f1(cx - 21)}V${f1(tb + 2)}Z`;
  const citadelRoof = `M${f1(cx + 1.5)} ${f1(tb - 10)}L${f1(cx + 15)} ${f1(tb - 18)}L${f1(cx + 28.5)} ${f1(tb - 10)}Z` + `M${f1(cx - 31)} ${f1(tb - 6)}a5 5 0 0 1 10 0Z`;
  // the White Tower: a plinth, a gently tapering shaft with string courses, a lantern gallery, a pinnacle
  const hw = (y) => lerp(7, 4.9, (tb - y) / (tb - tt));                 // half-width of the shaft at height y
  const shaftL = poly([[tx - 9.5, tb + 1], [tx - 9.5, tb - 6], [tx - hw(tb - 6), tb - 7], [tx - hw(tt), tt], [tx + 0.3, tt], [tx + 0.5, tb - 7], [tx + 0.5, tb + 1]]);
  const shaftR = poly([[tx + 0.5, tb + 1], [tx + 0.5, tb - 7], [tx + 0.3, tt], [tx + hw(tt), tt], [tx + hw(tb - 6), tb - 7], [tx + 9.5, tb - 6], [tx + 9.5, tb + 1]]);
  let courses = '';
  for (const f of [0.22, 0.48, 0.72]) { const y = lerp(tb - 7, tt, f); courses += `M${f1(tx - hw(y) - 0.6)} ${f1(y)}H${f1(tx + hw(y) + 0.6)}`; }
  const gallery = `M${f1(tx - 5.6)} ${f1(tt + 4)}h11.2l2 -3v-10.5h-15.2v10.5z`, galleryLit = `M${f1(tx + 0.3)} ${f1(tt + 4)}h5.3l2 -3v-10.5h-7.3z`;
  const pin = `M${f1(tx - 3.4)} ${f1(tt - 9)}L${f1(tx)} ${f1(tt - 42)}L${f1(tx + 3.4)} ${f1(tt - 9)}Z`, pinLit = `M${f1(tx)} ${f1(tt - 9)}L${f1(tx)} ${f1(tt - 42)}L${f1(tx + 3.4)} ${f1(tt - 9)}Z`;
  let slits = '';
  for (let y = tb - 18; y > tt + 10; y -= 13) slits += `M${f1(tx - 0.6)} ${f1(y)}h1.3v3.4h-1.3z`;
  const merlons = `M${f1(tx - 7.6)} ${f1(tt - 9)}h15.2`;
  const arches = `M${f1(tx - 4.2)} ${f1(tt - 0.5)}v-5a1.1 1.1 0 0 1 2.2 0v5zM${f1(tx - 0.6)} ${f1(tt - 0.5)}v-5a1.1 1.1 0 0 1 2.2 0v5zM${f1(tx + 3)} ${f1(tt - 0.5)}v-5a1 1 0 0 1 2 0v5z`;
  return {
    tower: { x: tx, top: tt - 42, flameY: tt - 9 },
    body:
      `<g id="cw">` +
      `<path fill="url(#ch)" d="${poly(hill)}"/><path fill="${s.rockLit}" opacity="0.35" d="${poly(hillLit)}"/><path fill="${s.rock[1]}" opacity="0.6" d="${rocks}"/>` +
      `<path fill="url(#cd)" d="${houses}"/><path fill="${s.roof}" d="${roofs}${spires}"/><path fill="${s.roofLit}" d="${roofLit}"/>` +
      `<path id="cwl" fill="url(#cs)" d="${walls}${bastions}"/><use href="#cwl" fill="url(#cv)"/>` +
      `<path fill="none" stroke="${s.dark}" stroke-width="2.2" opacity="0.4" d="${wallFeet}"/>` +
      `<path fill="none" stroke="url(#cs)" stroke-width="1.7" stroke-dasharray="1.2 1.1" d="${wallTops}"/>` +
      `<path fill="none" stroke="${s.dark}" stroke-width="0.6" opacity="0.5" transform="translate(0 1.4)" d="${wallTops}"/>` +
      `<path fill="${s.dark}" opacity="0.75" d="${wins}"/>` +
      `<path fill="${s.prow[0]}" d="${prowL}"/><path fill="${s.prow[1]}" d="${prowR}"/>` +
      `<path fill="none" stroke="${s.wall[2]}" stroke-width="1.4" stroke-dasharray="1.2 1" d="${prowRim}"/>` +
      `<path fill="${s.dark}" d="${gate}"/>` +
      `<path fill="url(#cs)" d="${citadel}"/><path fill="${s.roofLit}" d="${citadelRoof}"/>` +
      `<path fill="${s.wall[0]}" d="${shaftL}${gallery}${pin}"/><path fill="${s.wall[2]}" d="${shaftR}${galleryLit}${pinLit}"/>` +
      `<path fill="none" stroke="${s.dark}" stroke-width="0.7" opacity="0.45" d="${courses}"/>` +
      `<path fill="none" stroke="${s.wall[2]}" stroke-width="1.6" stroke-dasharray="1.1 0.9" d="${merlons}"/>` +
      `<path fill="${s.dark}" opacity="0.8" d="${slits}"/>` +
      `</g>` +
      `<path fill="${s.win}" opacity="${s.winA}" d="${lights}"/>` +
      `<path fill="${p.flame[1]}" d="${arches}"/>`,
  };
}

// ---------------------------------------------------------------- mid: wooded hills, the white city, the lake
const HILLS = [
  { x: -40, y: 560, wl: 200, wr: 250, round: true }, { x: 245, y: 606, wl: 170, wr: 200, round: true },
  { x: 500, y: 642, wl: 170, wr: 190, round: true }, { x: 760, y: 657, wl: 190, wr: 200, round: true },
  { x: 1010, y: 646, wl: 180, wr: 170, round: true }, { x: 1180, y: 630, wl: 110, wr: 130, round: true },
  { x: 1462, y: 452, wl: 270, wr: 230, dome: 1.35 }, // the mountain's knee, dark rock behind the city
];
function mid(p, night) {
  const Hl = range({ peaks: HILLS, base: SHORE, seed: SEED.hills, step: 6, rough: 0.35, soft: 30, detail: 0.5 });
  const h = p.hills, lk = p.lake, { M, mSnow } = geo();
  const nF = noise1(SEED.forest), tr = rng(SEED.forest);
  // forest: firs along the crests and scattered down the slopes, thinning out where the noise says meadow
  const ctop = [], cbot = [];
  let forest = '';
  for (let x = -12; x <= W + 12; x += 2.4 + tr() * 3.2) {
    const y = Hl.at(x)[1], d = fbm(nF, x / 90, 3), on = d > 0.36 && Math.abs(x - CITY.x) > 150;
    const ht = on ? 5 + tr() * 8 + (d - 0.36) * 40 : 0;
    ctop.push([x - 1.3, y + 1 - ht * 0.28], [x, y + 1 - ht]);
    cbot.push([x, y + 1 + (on ? 8 + (d - 0.36) * 160 + tr() * 8 : 0)]);
    if (on && tr() < 0.08) { const h2 = 14 + tr() * 10; forest += conifer(x, y + 3, h2, h2 * 0.3, tr); }
  }
  forest += poly([...ctop, ...cbot.reverse()]);
  const C = city(p, SEED.city), T = C.tower;
  // the lake: sky light near the far shore, darker towards us.  Mountains, hills and city are mirrored in it,
  // broken by slow ripples (two interleaved stripe masks, the second copy nudged sideways).
  const rr = rng(SEED.lake), DEPTH = 190;
  const stripes = (k) => { let d = ''; for (let y = SHORE - 2; y < SHORE + DEPTH;) { const t = (y - SHORE) / DEPTH, hgt = 0.8 + t * 3.6 + rr() * 1.4, gap = 0.5 + t * 1.8 + rr() * 1.2; if ((Math.floor(y) + k) % 2 || rr() < 0.75) d += `M0 ${f1(y)}H${W}v${f1(hgt)}H0z`; y += hgt + gap; } return d; };
  const glitter = (x0, spread, n, col, a, sd, w0 = 4) => { const r = rng(sd); let d = ''; for (let k = 0; k < n; k++) { const t = Math.pow(r(), 0.85), y = SHORE + 2 + t * 150, w = w0 + r() * (6 + 50 * t), x = x0 + (r() - 0.5) * (spread * (0.2 + t)) - w / 2; d += `M${f1(x)} ${f1(y)}h${f1(w)}v${f1(0.5 + t * 1.4)}h${f1(-w)}z`; } return `<path fill="${col}" opacity="${a}" d="${d}"/>`; };
  const mirror = `matrix(1 0 0 -1 0 ${2 * SHORE})`;
  let shore = '';   // the waterline catching the moon
  { const n = noise1(SEED.lake + 5); for (let x = 260; x < 1580; x += 6 + rr() * 22) { const w = 5 + rr() * 34; if (fbm(n, x / 70, 2) > 0.4) shore += `M${f0(x)} ${SHORE + 0.6}h${f0(w)}`; } }
  let ripples = '';
  for (let k = 0; k < 46; k++) { const t = Math.pow(rr(), 0.7), y = SHORE + 5 + t * 150, w = 20 + rr() * (40 + 200 * t); ripples += `M${f0(320 + rr() * 1240 - w / 2)} ${f1(y)}h${f0(w)}`; }
  const hm = mistBank('w', Hl, SHORE - 3, 18, h.mist, h.mistA, 9, SHORE + 6);
  const st = p.stone;
  return svg(
    `<defs>` +
    vgrad('lk', SHORE, 880, [[0, lk.water[0]], [0.3, lk.water[1]], [1, lk.water[2]]]) +
    vgrad('hs', Hl.top, SHORE, [[0, h.shade[0]], [1, h.shade[1]]]) + vgrad('hl', Hl.top, SHORE, [[0, h.lit[0]], [1, h.lit[1], 0.4]]) +
    vgrad('ch', 550, SHORE, [[0, st.rock[0]], [1, st.rock[1]]]) +
    hgrad('cs', CITY.x - 120, CITY.x + 120, [[0, st.wall[0]], [0.36, st.wall[1]], [0.6, st.wall[2]], [1, st.wall[3]]]) +
    vgrad('cv', 560, 700, [[0, st.shadow, 0], [1, st.shadow, 0.42]]) + hgrad('cd', CITY.x - 120, CITY.x + 120, [[0, st.house[0]], [0.36, st.house[1]], [0.6, st.house[2]], [1, st.house[3]]]) +
    vgrad('rf', SHORE, SHORE + DEPTH - 10, [[0, '#fff'], [0.6, '#fff', 0.55], [1, '#fff', 0]]) +
    `<mask id="ra" maskUnits="userSpaceOnUse" x="0" y="${SHORE - 4}" width="${W}" height="${DEPTH + 10}"><path fill="url(#rf)" d="${stripes(0)}"/></mask>` +
    `<mask id="rb" maskUnits="userSpaceOnUse" x="0" y="${SHORE - 4}" width="${W}" height="${DEPTH + 10}"><path fill="url(#rf)" d="${stripes(1)}"/></mask>` +
    `<clipPath id="land"><rect width="${W}" height="${SHORE}"/></clipPath><clipPath id="hc"><use href="#hp"/></clipPath>` +
    vgrad('hh', 440, 640, [[0, h.mist, h.mistA * 0.9], [1, h.mist, 0]]) +
    rgrad('bg', [[0, p.beacon, 0.7], [0.25, p.beacon, 0.28], [1, p.beacon, 0]]) +
    rgrad('ca', [[0, p.glint, lk.aura], [0.6, p.glint, lk.aura * 0.3], [1, p.glint, 0]]) +
    rgrad('lg', [[0, p.glint, lk.glow], [0.5, p.glint, lk.glow * 0.35], [1, p.glint, 0]]) +
    `<path id="hp" d="${curve(Hl.pts.map(([x, y]) => [x, Math.min(y, SHORE + 1)]), SHORE + 1)}"/>` + hm.defs +
    `</defs>` +
    // water, and what it mirrors
    `<rect x="0" y="${SHORE - 1}" width="${W}" height="${H - SHORE + 1}" fill="url(#lk)"/>` +
    `<g mask="url(#ra)" opacity="${lk.refl}" transform="${mirror}">` +
    `<path fill="${lk.mtn}" d="${poly([...M.pts, [W + 24, SHORE], [-24, SHORE]], f0)}"/><path fill="${lk.snow}" opacity="0.55" d="${mSnow.polys.map((q) => poly(q, f0)).join('')}"/>` +
    `<use href="#hp" fill="${lk.hills}"/><use href="#cw"/></g>` +
    `<g mask="url(#rb)" opacity="${(lk.refl * 0.75).toFixed(2)}"><use href="#cw" transform="translate(1.8 0) ${mirror}"/></g>` +
    `<ellipse cx="${MOON.x}" cy="${SHORE + 70}" rx="150" ry="95" fill="url(#lg)"/>` +
    `<path fill="none" stroke="${p.glint}" stroke-width="0.8" opacity="${lk.ripA}" d="${ripples}"/>` +
    glitter(MOON.x, 90, 150, p.glint, lk.glintA, SEED.lake + 1) +
    glitter(T.x, 10, 30, p.beacon, night ? 0.75 : 0.45, SEED.lake + 2, 1.5) +
    // land
    `<g clip-path="url(#land)"><use href="#hp" fill="url(#hs)"/>` +
    `<path fill="url(#hl)" d="${Hl.lit.map((q) => poly(q)).join('')}"/>` +
    `<path fill="${h.sliver}" opacity="${h.sliverA}" d="${Hl.slivers.map((q) => poly(q, f0)).join('')}"/><path fill="${h.gully}" opacity="${h.gullyA}" d="${Hl.gullies.map((q) => poly(q, f0)).join('')}"/>` +
    `<path fill="${h.forest}" d="${forest}"/>` +
    `<rect y="440" width="${W}" height="200" fill="url(#hh)" clip-path="url(#hc)"/></g>` +   // the tall knee fades into the air
    `<path fill="none" stroke="${p.shoreGlint}" stroke-width="1" opacity="0.6" d="${shore}"/>` +
    `<ellipse cx="${CITY.x}" cy="610" rx="190" ry="120" fill="url(#ca)"/>` +   // moonlight thrown back by white stone
    C.body +
    `<circle cx="${f1(T.x)}" cy="${f1(T.flameY - 2)}" r="46" fill="url(#bg)"/>` +
    beacon(T.x + 0.3, T.flameY + 0.5, 2.4, p, 'bg') +
    hm.body
  );
}

// ---------------------------------------------------------------- near: shores, reeds, standing stones, framing firs
function near(p) {
  const n = noise1(SEED.near), r = rng(SEED.trees), rr = rng(SEED.reeds);
  // banks: high on both sides, a low reedy shore in the middle so the lake shows wide; open water under the city
  const bank = (x) => 858 - 122 * smooth(500, -60, x) - 100 * smooth(1430, 1650, x) + (fbm(n, x / 60, 4) - 0.5) * 12 - 8 * Math.exp(-(((x - 380) / 70) ** 2));
  const ridge = []; for (let x = -20; x <= W + 20; x += 8) ridge.push([x, bank(x)]);
  const edge = ridge.filter(([x]) => x < 560 || x > 1400);   // a lit edge where the banks face the moon
  // standing stones on the left bank, one on the right
  const stones = [[348, 64, 15, -0.05], [388, 42, 12, 0.07], [420, 27, 10, -0.1], [1492, 32, 11, 0.05]];
  let stD = '', stLit = '';
  for (const [x, h, w, lean] of stones) {
    const b = bank(x) + 5, t = [x + lean * h, b - h];
    stD += poly([[x - w / 2, b], [x - w * 0.56 + lean * h * 0.4, b - h * 0.55], [t[0] - w * 0.32, t[1] + 3], [t[0] + w * 0.15, t[1]], [x + w * 0.5 + lean * h * 0.5, b - h * 0.5], [x + w / 2, b]]);
    stLit += poly([[x + w * 0.04, b], [t[0] + w * 0.02, t[1] + 1.5], [t[0] + w * 0.15, t[1]], [x + w * 0.5 + lean * h * 0.5, b - h * 0.5], [x + w / 2, b]]);
  }
  // grass on the banks and reeds along the open shore
  let reeds = '', reedLit = '';
  const blade = (x, b, h, bend, w) => { reeds += `M${f1(x - w)} ${f1(b)}Q${f1(x + bend * 0.3)} ${f1(b - h * 0.6)} ${f1(x + bend)} ${f1(b - h)}Q${f1(x + bend * 0.3 + w * 0.6)} ${f1(b - h * 0.6)} ${f1(x + w)} ${f1(b)}Z`; if (rr() < 0.4) reedLit += `M${f1(x + bend * 0.55)} ${f1(b - h * 0.78)}Q${f1(x + bend * 0.8)} ${f1(b - h * 0.92)} ${f1(x + bend)} ${f1(b - h)}`; };
  const clump = (x0, x1, cnt, hMax, heads) => {
    for (let k = 0; k < cnt; k++) {
      const x = lerp(x0, x1, rr()), b = bank(x) + 3, h = hMax * (0.3 + rr() * 0.7), bend = (rr() - 0.35) * h * 0.35;
      blade(x, b, h, bend, 0.7 + rr() * 0.9);
      if (heads && rr() < 0.2) { const hy = b - h * (0.72 + rr() * 0.18), hx = x + bend * 0.72; reeds += `M${f1(hx - 1.3)} ${f1(hy)}a1.3 3.6 0 1 0 2.6 0a1.3 3.6 0 1 0 -2.6 0Z`; }
    }
  };
  const tufts = (x0, x1, step, hMax) => { for (let x = x0; x < x1; x += step * (0.5 + rr())) { const k = 2 + Math.floor(rr() * 4); for (let j = 0; j < k; j++) blade(x + (rr() - 0.5) * 6, bank(x) + 4, hMax * (0.3 + rr() * 0.7), (rr() - 0.5) * 10, 0.6 + rr() * 0.6); } };
  clump(470, 740, 80, 50, true); clump(860, 1170, 70, 46, true); clump(1190, 1280, 22, 32, true); clump(1395, 1470, 20, 36, true);
  tufts(-20, 470, 16, 16); tufts(1460, 1620, 16, 16);
  // framing firs, outside the title: tall on the left, shorter on the right so they never touch the city
  const back = [], front = [], rim = [];
  const stand = (from, to, count, hMax, hMin, arr, rimArr) => {
    for (let k = 0; k < count; k++) {
      const t = count > 1 ? k / (count - 1) : 0, x = lerp(from, to, t) + (r() - 0.5) * 26;
      const h = lerp(hMax, hMin, t) * (0.78 + r() * 0.36);
      arr.push(conifer(x, bank(x) + 10, h, h * (0.2 + r() * 0.06), r, rimArr, f0));
    }
  };
  stand(-40, 300, 8, 420, 120, back, null);
  stand(1470, 1650, 5, 250, 330, back, null);
  stand(-30, 250, 6, 560, 170, front, rim);
  stand(1505, 1640, 4, 300, 420, front, rim);
  return svg(
    `<defs>${vgrad('n', 730, 900, [[0, p.near[0]], [1, p.near[1]]])}${hgrad('e', 0, W, [[0, p.nearLit, 0.9], [0.3, p.nearLit, 0.5], [0.7, p.nearLit, 0.5], [1, p.nearLit, 0.9]])}</defs>` +
    `<path fill="${p.firFar}" d="${back.join('')}"/>` +
    `<path fill="url(#n)" d="${curve(ridge, H + 2)}"/>` +
    `<path fill="none" stroke="url(#e)" stroke-width="1.3" d="${open(edge)}"/>` +
    `<path fill="${p.menhir}" d="${stD}"/><path fill="${p.menhirLit}" d="${stLit}"/>` +
    `<path fill="${p.reed}" d="${reeds}"/><path fill="none" stroke="${p.reedLit}" stroke-width="0.7" opacity="0.6" d="${reedLit}"/>` +
    `<path fill="${p.fir}" d="${front.join('')}"/>` +
    `<path fill="none" stroke="${p.firRim}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" opacity="${p.firRimA}" d="${rim.map((q) => open(q, f0)).join('')}"/>`
  );
}

// ---------------------------------------------------------------- mist: soft, irregular drifts (tiles horizontally)
// No filters here: the layer's background-position drifts, so it is repainted often.  Each bank is a loose
// cluster of large soft ellipses whose centre line wanders, with smaller wisps lifting off it.
function mist(p) {
  const r = rng(SEED.mist), n = noise1(SEED.mist);
  let body = '';
  const puff = (cx, cy, rx, ry, op, rot) => {
    for (const dx of [-W, 0, W]) if (cx + dx + rx > 0 && cx + dx - rx < W) body += `<ellipse cx="${f0(cx + dx)}" cy="${f0(cy)}" rx="${f0(rx)}" ry="${f0(ry)}" opacity="${op.toFixed(2)}"${rot ? ` transform="rotate(${rot.toFixed(1)} ${f0(cx + dx)} ${f0(cy)})"` : ''}/>`;
  };
  // [centre line y, how far it wanders, thickness, strength, puffs]
  for (const [y0, wander, thick, a, count] of [[540, 40, 30, 0.6, 7], [612, 46, 40, 0.85, 9], [686, 26, 28, 0.95, 11], [742, 18, 20, 0.8, 8]]) {
    for (let k = 0; k < count; k++) {
      const cx = ((k + r() * 0.9) * W) / count, cy = y0 + (n(cx / 260 + y0) - 0.5) * wander * 2 + (r() - 0.5) * thick * 0.5;
      const rx = 90 + r() * 230, ry = thick * (0.5 + r() * 0.8);
      if (r() < 0.2) continue;   // gaps, so the banks never read as stripes
      puff(cx, cy, rx, ry, a * (0.35 + r() * 0.65), (r() - 0.5) * 5);
      if (r() < 0.65) puff(cx + (r() - 0.5) * rx, cy - ry * (0.5 + r() * 0.7), rx * (0.25 + r() * 0.3), ry * (0.35 + r() * 0.3), a * (0.3 + r() * 0.4), (r() - 0.5) * 12);
    }
  }
  return svg(`<defs>${rgrad('e', [[0, p.mist, p.mistA], [0.5, p.mist, p.mistA * 0.55], [1, p.mist, 0]])}</defs><g fill="url(#e)">${body}</g>`, `0 0 ${W} ${H}`, 'none');
}

// ---------------------------------------------------------------- stars (tile) and moon
function stars() {
  const r = rng(SEED.stars), n = noise1(SEED.stars), TW = 1200, TH = 700;
  let dots = '', glints = '', halos = '';
  const tints = ['#f6f1e2', '#fff6dc', '#dfe7ff', '#f6f1e2', '#ffe9c4', '#e8ecff'];
  for (let k = 0; k < 300; k++) {
    let x = r() * TW; const y = TH * Math.pow(r(), 1.25);
    if (fbm(n, x / 140, 2) < 0.42 && r() < 0.5) x = r() * TW;        // a little clustering, no grid
    const big = r() < 0.05, rad = big ? 1.1 + r() * 0.8 : 0.3 + Math.pow(r(), 2.2) * 0.9;
    dots += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${rad.toFixed(2)}" fill="${tints[k % tints.length]}" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
    if (big) { halos += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rad * 5)}"/>`; if (r() < 0.5) glints += `M${f1(x - 7)} ${f1(y)}H${f1(x + 7)}M${f1(x)} ${f1(y - 7)}V${f1(y + 7)}`; }
  }
  return svg(`<defs>${rgrad('h', [[0, '#e8ecff', 0.35], [1, '#e8ecff', 0]])}</defs><g fill="url(#h)">${halos}</g>${dots}<path stroke="#fff8e4" stroke-width="0.5" opacity="0.45" d="${glints}"/>`, `0 0 ${TW} ${TH}`, 'xMidYMid slice');
}
function moon() {
  const r = rng(SEED.moon);
  let maria = '';
  // the seas sit roughly where they sit on our own moon: a dark scatter upper left and centre
  const seas = [[-14, -18, 15, 11], [4, -22, 12, 9], [-22, 2, 10, 13], [10, -6, 14, 10], [-4, 12, 9, 7], [18, 14, 7, 6], [-26, 20, 6, 5]];
  for (const [dx, dy, rx, ry] of seas) maria += `<ellipse cx="${f1(200 + dx)}" cy="${f1(200 + dy)}" rx="${f1(rx * (0.9 + r() * 0.2))}" ry="${f1(ry)}" transform="rotate(${Math.round(r() * 60 - 30)} ${f1(200 + dx)} ${f1(200 + dy)})"/>`;
  let craters = '';
  for (let k = 0; k < 12; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 44, rr = 0.8 + r() * 2.2;
    craters += `<circle cx="${f1(200 + Math.cos(a) * d)}" cy="${f1(200 + Math.sin(a) * d)}" r="${rr.toFixed(1)}"/>`;
  }
  return svg(
    `<defs><radialGradient id="glow"><stop offset="0" stop-color="#f6efd8" stop-opacity="0.85"/><stop offset="0.16" stop-color="#efe4c2" stop-opacity="0.42"/><stop offset="0.34" stop-color="#d9cba0" stop-opacity="0.12"/><stop offset="0.62" stop-color="#b9b3c8" stop-opacity="0.04"/><stop offset="1" stop-color="#b9b3c8" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="disc" cx="44%" cy="40%" r="62%"><stop offset="0" stop-color="#fffbef"/><stop offset="0.6" stop-color="#f1e8cc"/><stop offset="0.92" stop-color="#d8cba4"/><stop offset="1" stop-color="#c6b891"/></radialGradient>` +
    `<clipPath id="c"><circle cx="200" cy="200" r="54"/></clipPath><filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>` +
    `<circle cx="200" cy="200" r="200" fill="url(#glow)"/><circle cx="200" cy="200" r="54" fill="url(#disc)"/>` +
    `<g clip-path="url(#c)"><g fill="#a89a78" opacity="0.26" filter="url(#soft)">${maria}</g><g fill="#b5a682" opacity="0.25">${craters}</g></g>` +
    `<circle cx="200" cy="200" r="54" fill="none" stroke="#fffaf0" stroke-opacity="0.5" stroke-width="0.8"/>`,
    '0 0 400 400', 'xMidYMid meet'
  );
}

// ---------------------------------------------------------------- write
const files = {
  'stars.svg': stars(),
  'moon.svg': moon(),
  'far.svg': far(PAL.night), 'far-dawn.svg': far(PAL.dawn),
  'mid.svg': mid(PAL.night, true), 'mid-dawn.svg': mid(PAL.dawn, false),
  'near.svg': near(PAL.night), 'near-dawn.svg': near(PAL.dawn),
  'mist.svg': mist(PAL.night), 'mist-dawn.svg': mist(PAL.dawn),
};
for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), body);
  console.log(`  ${name.padEnd(14)} ${(body.length / 1024).toFixed(1)} KB`);
}
