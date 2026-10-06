/* SPDX-License-Identifier: AGPL-3.0-or-later */
/* SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio */
/* Westernis front-end behaviours: scroll reveal, hero parallax + embers, card tilt.
 * Loaded with `defer` from the page head (LocalSettings BeforePageDisplay hook), so it runs right after
 * the HTML is parsed instead of after the ResourceLoader queue. Progressive enhancement only — every
 * effect is skipped under prefers-reduced-motion, Citizen performance mode, or on hidden tabs.
 * Content that is already on screen is never hidden: only blocks below the fold wait for their reveal.
 * Re-initialises after VisualEditor / preview replace the content (mw.hook 'wikipage.content').
 * The html.wst-day / wst-night / wst-motion classes are set by the inline head script and kept in sync
 * by MediaWiki:Common.js. */
(function () {
  'use strict';
  var html = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  function motionOk() { return !reduced && html.classList.contains('wst-motion'); }
  html.classList.add('wst-ready');

  /* ---------------------------------------------------------------- reveal (below the fold only) */
  var observer = null;
  var activeHero = null;
  function show(n) { n.classList.remove('wst-reveal-pending'); n.classList.add('is-visible'); }
  function initReveal(root) {
    var nodes = root.querySelectorAll('.wst-reveal:not(.is-visible):not(.wst-reveal-pending)');
    if (!nodes.length) return;
    if (!motionOk() || !('IntersectionObserver' in window)) { nodes.forEach(show); return; }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { show(e.target); observer.unobserve(e.target); } });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    }
    var fold = window.innerHeight;
    nodes.forEach(function (n) {
      if (n.parentElement && n.parentElement.closest('.wst-reveal')) { show(n); return; }   // only outermost blocks animate
      if (n.getBoundingClientRect().top < fold * 0.98) { show(n); return; }                   // already (partly) on screen: never hide
      n.classList.add('wst-reveal-pending');
      observer.observe(n);
    });
  }
  /* article blocks reveal without authors adding classes */
  function autoReveal(root) {
    // self-contained blocks only: a heading must never drift apart from the text below it
    var selectors = ['.wst-quote', '.wst-tree', '.wst-timeline', '.mw-parser-output .gallery', '.wst-secret', '.wst-featured'];
    root.querySelectorAll(selectors.join(',')).forEach(function (el) { el.classList.add('wst-reveal'); });
  }
  /* if motion is switched off later, nothing may stay hidden */
  new MutationObserver(function () {
    if (motionOk()) return;
    document.querySelectorAll('.wst-reveal-pending').forEach(show);
    if (activeHero) activeHero.teardown();   // performance mode switched on: stop parallax and sparks
  }).observe(html, { attributes: true, attributeFilter: ['class'] });

  /* ---------------------------------------------------------------- hero (parallax, embers) */
  function initHero(root) {
    var hero = root.querySelector('.wst-hero') || document.querySelector('.wst-hero');
    if (!hero) return;
    if (activeHero && activeHero.el === hero) return;
    if (activeHero) activeHero.teardown();
    if (!motionOk()) return;
    var layers = {
      stars: hero.querySelector('.wst-hero-stars'), moon: hero.querySelector('.wst-hero-moon'), rays: hero.querySelector('.wst-hero-rays'),
      far: hero.querySelector('.wst-hero-far'), mist: hero.querySelector('.wst-hero-mist'), mid: hero.querySelector('.wst-hero-mid'),
      near: hero.querySelector('.wst-hero-near'), content: hero.querySelector('.wst-hero-content')
    };
    var speeds = { stars: 0.06, moon: 0.14, rays: 0.12, far: 0.2, mist: 0.28, mid: 0.34, near: 0.46, content: 0.3 };
    var ticking = false;
    function update() {
      ticking = false;
      if (!hero.isConnected) return;
      var rect = hero.getBoundingClientRect();
      if (rect.bottom < 0) return;
      var y = Math.max(0, -rect.top);
      Object.keys(layers).forEach(function (k) {
        var el = layers[k];
        if (el) el.style.translate = '0 ' + (y * speeds[k]).toFixed(1) + 'px';
      });
      if (layers.content) layers.content.style.opacity = String(Math.max(0, 1 - y / (rect.height * 0.75)));
    }
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    var embers = initEmbers(hero);
    var visObserver = null;
    if ('IntersectionObserver' in window) {
      visObserver = new IntersectionObserver(function (entries) {
        var on = entries[0].isIntersecting;
        hero.classList.toggle('is-offscreen', !on);   // pauses the CSS keyframes
        if (embers) { if (on) embers.start(); else embers.stop(); }
      });
      visObserver.observe(hero);
    } else if (embers) { embers.start(); }
    activeHero = {
      el: hero,
      teardown: function () {
        window.removeEventListener('scroll', onScroll);
        if (visObserver) visObserver.disconnect();
        if (embers) embers.destroy();
        activeHero = null;
      }
    };
  }

  /* drifting sparks: pre-rendered glow sprites, no per-frame shadow blur */
  function sprite(rgb) {
    var c = document.createElement('canvas'); c.width = c.height = 32;
    var g = c.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(' + rgb + ',1)'); grad.addColorStop(0.25, 'rgba(' + rgb + ',0.55)'); grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
    return c;
  }
  function initEmbers(hero) {
    var art = hero.querySelector('.wst-hero-art') || hero;
    var canvas = hero.querySelector('canvas.wst-hero-embers');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'wst-hero-embers';
      canvas.setAttribute('aria-hidden', 'true');
      art.appendChild(canvas);
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var sprites = { gold: sprite('255, 200, 120'), silver: sprite('214, 226, 255') };
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var particles = [];
    var running = false, raf = 0, last = 0, w = 0, h = 0;
    function resize() {
      var r = hero.getBoundingClientRect();
      w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height));
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var count = Math.round(Math.min(70, (w * h) / 16000));
      particles = [];
      for (var i = 0; i < count; i++) particles.push(spawn(true));
    }
    function spawn(anywhere) {
      return {
        x: Math.random() * w, y: anywhere ? h * (0.35 + Math.random() * 0.65) : h + 10,
        r: 2 + Math.random() * 4, vy: -(5 + Math.random() * 14), vx: (Math.random() - 0.5) * 7,
        life: 0, ttl: 7 + Math.random() * 9, phase: Math.random() * Math.PI * 2,
        img: Math.random() < 0.72 ? sprites.gold : sprites.silver
      };
    }
    function frame(t) {
      if (!running) return;
      if (!canvas.isConnected) { running = false; return; }
      var dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.life += dt;
        p.x += (p.vx + Math.sin(p.phase + p.life * 1.2) * 6) * dt;
        p.y += p.vy * dt;
        var a = Math.sin(Math.min(1, p.life / p.ttl) * Math.PI) * (0.55 + 0.45 * Math.sin(p.phase * 3 + p.life * 3.5));
        ctx.globalAlpha = Math.max(0, a * 0.85);
        ctx.drawImage(p.img, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        if (p.life > p.ttl || p.y < -10) particles[i] = spawn(false);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!running && hero.isConnected && !document.hidden) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    function onVisibility() { if (document.hidden) stop(); else start(); }
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return {
      start: start, stop: stop,
      destroy: function () { stop(); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVisibility); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    };
  }

  /* ---------------------------------------------------------------- tilt (codex tiles) */
  function initTilt(root) {
    if (!motionOk() || !finePointer) return;
    root.querySelectorAll('.wst-portal, .wst-card').forEach(function (card) {
      if (card.dataset.wstTilt) return;
      card.dataset.wstTilt = '1';
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.setProperty('--wst-tx', (px * 100).toFixed(1) + '%');
        card.style.setProperty('--wst-ty', (py * 100).toFixed(1) + '%');
        card.style.transform = 'perspective(900px) rotateX(' + ((0.5 - py) * 4).toFixed(2) + 'deg) rotateY(' + ((px - 0.5) * 5).toFixed(2) + 'deg) translateY(-3px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  /* ---------------------------------------------------------------- category pages: drop empty kinds */
  // Generated sub-kind categories (Belagerungen, Eide …) exist so article chips never show red links;
  // while empty they only clutter the parent listing (CSS hides the rows, this removes empty letters).
  function tidyCategories() {
    var box = document.getElementById('mw-subcategories');
    if (!box) return;
    box.querySelectorAll('li').forEach(function (li) {
      var c = li.querySelector('.CategoryTreeItem > span[title]');
      var n = c && c.title.match(/\d+/g);
      if (n && n.every(function (x) { return x === '0'; })) li.remove();
    });
    box.querySelectorAll('.mw-category-group').forEach(function (g) { if (!g.querySelector('li')) g.remove(); });
    if (!box.querySelector('li')) box.style.display = 'none';
  }

  /* ---------------------------------------------------------------- init */
  function init($content) {
    var root = ($content && $content[0]) || document;
    tidyCategories();
    autoReveal(root);
    initReveal(root);
    initTilt(root);
    initHero(root);
  }
  function boot() {
    init(document);
    // again after VE / preview / tabber replace the content (needs mw, which loads asynchronously)
    (window.RLQ = window.RLQ || []).push(['mediawiki.base', function () { mw.hook('wikipage.content').add(function ($c) { if ($c && $c[0] !== document) init($c); }); }]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());
