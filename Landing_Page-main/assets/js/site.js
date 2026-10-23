/* ThreatReady — shared site behaviour (nav, drawer, theme, tabs). No dependencies. */
(function () {
  'use strict';
  var root = document.documentElement;

  /* ---------- Theme ----------
     One choice for threatready.io and every app: the "tr-theme" cookie on the parent domain (the same cookie
     the apps' theme-init.js reads and writes), with localStorage as the fallback. The inline <head> script
     applies it before first paint. */
  function currentTheme() { return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function saveTheme(t) {
    var onSite = /(^|\.)threatready\.io$/.test(location.hostname);
    try {
      document.cookie = 'tr-theme=' + t + '; path=/; max-age=31536000; samesite=lax' +
        (onSite ? '; domain=threatready.io' : '') + (location.protocol === 'https:' ? '; secure' : '');
    } catch (e) {}
    try { localStorage.setItem('tr-theme', t); } catch (e) {}
  }
  function setTheme(t) {
    if (t === 'light') root.setAttribute('data-theme', 'light');
    else root.setAttribute('data-theme', 'dark');
    saveTheme(t);
    syncThemeButtons();
    if (window.__trSyncFallbacks) window.__trSyncFallbacks();
  }
  function syncThemeButtons() {
    var t = currentTheme();
    document.querySelectorAll('[data-theme-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === t));
    });
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      var label = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    });
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
  });
  document.querySelectorAll('[data-theme-set]').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-set')); });
  });
  syncThemeButtons();

  /* ---------- Sticky nav background ---------- */
  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-solid', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Dropdown menus (click + keyboard) ---------- */
  var triggers = Array.prototype.slice.call(document.querySelectorAll('[data-menu]'));
  function closeAll(except) {
    triggers.forEach(function (t) {
      if (t === except) return;
      t.setAttribute('aria-expanded', 'false');
      var m = document.getElementById(t.getAttribute('aria-controls'));
      if (m) m.classList.remove('is-open');
    });
  }
  triggers.forEach(function (t) {
    var menu = document.getElementById(t.getAttribute('aria-controls'));
    if (!menu) return;
    var items = function () { return Array.prototype.slice.call(menu.querySelectorAll('a')); };
    function open(focusFirst) {
      closeAll(t);
      t.setAttribute('aria-expanded', 'true');
      menu.classList.add('is-open');
      if (focusFirst) { var i = items(); if (i[0]) i[0].focus(); }
    }
    function close(returnFocus) {
      t.setAttribute('aria-expanded', 'false');
      menu.classList.remove('is-open');
      if (returnFocus) t.focus();
    }
    t.addEventListener('click', function (e) {
      e.stopPropagation();
      if (t.getAttribute('aria-expanded') === 'true') close(false); else open(false);
    });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open(true); }
      if (e.key === 'Escape') close(true);
    });
    menu.addEventListener('keydown', function (e) {
      var i = items(), idx = i.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); i[(idx + 1) % i.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); i[(idx - 1 + i.length) % i.length].focus(); }
      else if (e.key === 'Tab') { close(false); }
    });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.menu')) closeAll(null);
  });

  /* ---------- Mobile drawer ---------- */
  var toggle = document.querySelector('.nav-toggle');
  var drawer = document.getElementById('drawer');
  if (toggle && drawer) {
    var setDrawer = function (openIt) {
      toggle.setAttribute('aria-expanded', String(openIt));
      toggle.setAttribute('aria-label', openIt ? 'Close menu' : 'Open menu');
      drawer.classList.toggle('is-open', openIt);
      document.body.classList.toggle('drawer-open', openIt);
      toggle.querySelector('.i-open').style.display = openIt ? 'none' : '';
      toggle.querySelector('.i-close').style.display = openIt ? '' : 'none';
    };
    toggle.addEventListener('click', function () { setDrawer(toggle.getAttribute('aria-expanded') !== 'true'); });
    drawer.addEventListener('click', function (e) { if (e.target.closest('a')) setDrawer(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setDrawer(false); toggle.focus(); }
    });
    window.addEventListener('resize', function () { if (window.innerWidth > 1000) setDrawer(false); });
  }

  /* ---------- Tabs (manual activation, no autoplay) ---------- */
  document.querySelectorAll('[role="tablist"]').forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var p = document.getElementById(t.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      var frame = list.closest('.frame');
      var url = frame && frame.querySelector('[data-frame-url]');
      if (url && tab.getAttribute('data-url')) url.textContent = tab.getAttribute('data-url');
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t, false); });
      t.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
        if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
        if (e.key === 'Home') n = tabs[0];
        if (e.key === 'End') n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
  });

  /* ---------- Screenshot load failures: show a text fallback instead of a broken image ---------- */
  function syncFallbacks() {
    document.querySelectorAll('.shot-fallback').forEach(function (fb) {
      var box = fb.parentElement;
      var shown = Array.prototype.some.call(box.querySelectorAll('img.shot'), function (i) {
        return !i.hidden && getComputedStyle(i).display !== 'none';
      });
      fb.hidden = shown;
    });
  }
  document.querySelectorAll('img.shot').forEach(function (img) {
    function fail() { img.hidden = true; syncFallbacks(); }
    img.addEventListener('error', fail);
    // the error may have fired before this deferred script ran
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) fail();
  });
  window.__trSyncFallbacks = syncFallbacks;

  /* ---------- Footer year ---------- */
  document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = String(new Date().getFullYear()); });
})();
