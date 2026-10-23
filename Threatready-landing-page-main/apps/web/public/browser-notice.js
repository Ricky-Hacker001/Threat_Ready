// Warns once per tab when ThreatReady is opened in a browser it doesn't fully support.
// Identical copies live in onboard, InterviewPrep, Lab Simulations and Attack Reasoning (public/).
(function () {
  var KEY = 'tr-browser-notice';
  try { if (sessionStorage.getItem(KEY)) return; } catch (e) { /* storage unavailable: show every time */ }

  function el(tag, text, cls) { var n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }

  function show(why) {
    var css = document.createElement('style');
    css.textContent = '.tr-browser-notice{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px var(--gutter,16px);background:var(--warn-soft,#fff4d6);border-bottom:1px solid var(--warn,#e0a43b);color:var(--text,#111);font:500 14px/1.45 var(--font,system-ui,sans-serif)}.tr-browser-notice p{margin:0;flex:1 1 320px}.tr-browser-notice p strong{font-weight:700}.tr-browser-notice button{font:inherit;font-weight:600;padding:6px 12px;border-radius:var(--r1,6px);border:1px solid var(--border-strong,#999);background:var(--surface,#fff);color:var(--text,#111);cursor:pointer}';
    // Carries the platform's design tokens itself (.trp), so it looks the same whatever page hosts it.
    var box = el('div', null, 'trp tr-browser-notice');
    box.setAttribute('role', 'alert');
    var p = el('p');
    p.appendChild(el('strong', 'You’re using a browser ThreatReady doesn’t fully support. '));
    p.appendChild(document.createTextNode(why + ' For the full experience open ThreatReady in Chrome, Edge or Safari (Firefox works for everything except voice interviews).'));
    var ok = el('button', 'Continue anyway');
    ok.type = 'button';
    ok.onclick = function () { box.remove(); try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ } };
    box.appendChild(p); box.appendChild(ok);
    var mount = function () { document.head.appendChild(css); document.body.insertBefore(box, document.body.firstChild); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  }

  var ua = navigator.userAgent;
  if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
    // Brave hides itself in the user agent; it only answers this call.
    navigator.brave.isBrave().then(function (yes) { if (yes) show('Brave blocks speech recognition and some page features, so voice interviews and parts of the labs may not work.'); });
  } else if (/MSIE |Trident\//.test(ua)) {
    show('Internet Explorer cannot run ThreatReady.');
  }
})();
