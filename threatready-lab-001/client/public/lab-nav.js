// The small ThreatReady strip above every lab console: mark + wordmark, Back, All labs. Injected by the
// Labs server into each hosted lab's page (server/hosted.ts) and loaded by the AWS lab console; the
// labs' own code stays untouched. Served at /labs/lab-nav.js next to /labs/logo-sm.png.
//
// Layout contract with every lab (OVF-01):
// - The strip is fixed at the top, 40 px tall, z-index 40: below every modal layer (backdrops are z ≥ 50),
//   so a dialog's backdrop covers it and its links cannot be used while a dialog is open.
// - It adds class `tr-has-labnav` to <html>, which publishes `--tr-labnav-h: 40px` and pads <body> by
//   that much with `html, body { height: 100% }`, so an app's `html, body, #root { height: 100% }`
//   chain resolves to the viewport minus the strip.
// - Apps size full-viewport roots with `calc(100vh - var(--tr-labnav-h, 0px))` and offset their own
//   `position: sticky/fixed; top: 0` chrome by `var(--tr-labnav-h, 0px)`. Standalone (no strip) the
//   variable is unset, so it falls back to 0 and nothing changes.
(function () {
  if (document.querySelector('.tr-labnav')) return;
  var base = '/labs/';
  var css = document.createElement('style');
  css.setAttribute('data-tr-labnav', '');
  css.textContent =
    '.tr-labnav{position:fixed;top:0;left:0;right:0;z-index:40;height:40px;background:#0b1020;border-bottom:1px solid #243047;color:#f3f5f9;font:500 13px/1 "Inter Variable",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}' +
    '.tr-labnav-in{max-width:1280px;height:100%;margin:0 auto;padding:0 32px;display:flex;align-items:center;gap:10px;box-sizing:border-box}' +
    '@media (max-width:900px){.tr-labnav-in{padding:0 24px}}@media (max-width:600px){.tr-labnav-in{padding:0 16px}}' +
    '.tr-labnav a,.tr-labnav button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;border:1px solid transparent;background:none;color:#a3acbf;font:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}' +
    '.tr-labnav a:hover,.tr-labnav button:hover{color:#f3f5f9;background:#1a2234}' +
    '.tr-labnav a:focus-visible,.tr-labnav button:focus-visible{outline:2px solid #6d5dfc;outline-offset:1px}' +
    '.tr-labnav-brand{font-weight:700;color:#f3f5f9!important;padding-left:0!important;letter-spacing:-.01em}' +
    '.tr-labnav-brand img{width:22px;height:21px;display:block}' +
    '.tr-labnav-sep{width:1px;height:18px;background:#243047}' +
    '.tr-labnav-spacer{flex:1}' +
    '.tr-labnav-all{border-color:#33415c!important}' +
    'html.tr-has-labnav{--tr-labnav-h:40px;height:100%}' +
    'html.tr-has-labnav body{height:100%;box-sizing:border-box;padding-top:var(--tr-labnav-h)}' +
    '@media (max-width:480px){.tr-labnav-brand span{display:none}}' +
    '@media print{.tr-labnav{display:none}html.tr-has-labnav body{padding-top:0}}';
  var nav = document.createElement('nav');
  nav.className = 'tr-labnav';
  nav.setAttribute('aria-label', 'ThreatReady');
  var brand = document.createElement('a');
  brand.className = 'tr-labnav-brand';
  brand.href = base;
  // The wordmark is hidden on small phones; the link keeps its name.
  brand.setAttribute('aria-label', 'ThreatReady Lab Simulations home');
  var mark = document.createElement('img');
  mark.src = base + 'logo-sm.png';
  mark.alt = '';
  mark.width = 22;
  mark.height = 21;
  brand.appendChild(mark);
  var word = document.createElement('span');
  word.textContent = 'ThreatReady';
  brand.appendChild(word);
  var sep = document.createElement('span');
  sep.className = 'tr-labnav-sep';
  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'tr-labnav-back';
  back.textContent = '← Back';
  back.onclick = function () {
    // Back within the platform when there is somewhere to go; otherwise the catalog.
    var sameOrigin = false;
    try { sameOrigin = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { /* ignore */ }
    if (history.length > 1 && sameOrigin) history.back();
    else location.href = base;
  };
  var spacer = document.createElement('span');
  spacer.className = 'tr-labnav-spacer';
  var all = document.createElement('a');
  all.className = 'tr-labnav-all';
  all.href = base;
  all.textContent = 'All labs';
  var inner = document.createElement('div');
  inner.className = 'tr-labnav-in';
  inner.appendChild(brand); inner.appendChild(sep); inner.appendChild(back); inner.appendChild(spacer); inner.appendChild(all);
  nav.appendChild(inner);
  var mount = function () {
    if (!document.querySelector('style[data-tr-labnav]')) document.head.appendChild(css);
    document.documentElement.classList.add('tr-has-labnav');
    document.body.insertBefore(nav, document.body.firstChild);
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  // Time spent in this lab, for the admin console (activity.js guards against loading twice).
  var act = document.createElement('script');
  act.src = base + 'activity.js';
  act.defer = true;
  document.head.appendChild(act);
})();
