// The embedded target browser's document (client/src/tools.tsx, BrowserTool), TR-44 / A15b. The lab's
// pages run under the platform's strict policy (script-src 'self'), which a srcdoc frame would inherit and
// so block the navigation shim and the lab's own XSS exercises. This document is served as its own
// same-origin route with a dedicated policy: an opaque-origin sandbox (no allow-same-origin: no cookies,
// storage or same-origin requests) in which inline script, eval and inline style may run, nothing may be
// fetched except data:/blob: images and data: fonts, nothing may connect, and nothing may be submitted or
// navigated to. The policy never relaxes the platform origin's own CSP: it is scoped to this one route.
//
// Handshake: the lab page mounts a fresh frame per simulated response and waits for `ready`; it then
// posts {__trlab: 1, type: 'render', nonce, html} (the simulated response body and a per-frame nonce).
// The document accepts that from its embedder only, once, writes the body into itself exactly as the
// former srcdoc did (document.write runs the page's inline/XSS scripts), and then installs the trusted
// navigation shim itself — after the write, so a payload that leaves a tag open cannot swallow it. The
// shim forwards link clicks and form submits to the lab (browser.navigate) with the frame's nonce, so the
// lab page can tie every message to the frame instance it created; blocking dialogs raised by payloads
// become a non-blocking banner, a safe visible proof that script ran.

/** The policy without the header-only directives: also carried in a <meta> inside the document. */
const TARGET_FRAME_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

/**
 * The response header. It replaces the gateway policy for this route, so it restores the platform's
 * framing rule (only the Red Team's own pages may frame this document, never another site; 'self' is the
 * URL's origin, so it holds despite the sandbox) and forces the opaque-origin sandbox even when the file
 * is opened directly. `sandbox` stays last (the hosted CSP check reads it there).
 */
export const TARGET_FRAME_CSP = [...TARGET_FRAME_POLICY, "frame-ancestors 'self'", 'sandbox allow-scripts allow-forms'].join('; ');

/** The in-document copy: browsers ignore `sandbox` and frame-ancestors in <meta> (and log the ignored sandbox as an error). */
export const TARGET_FRAME_META_CSP = TARGET_FRAME_POLICY.join('; ');

export const TARGET_FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${TARGET_FRAME_META_CSP}">
<title>AeroCart (sandboxed target)</title></head>
<body style="margin:0">
<script>
(function () {
  'use strict';
  var parentWindow = window.parent;
  if (parentWindow === window) return; // opened directly: nothing to show
  // Blocking dialogs raised by a payload become a non-blocking banner, a safe visible proof that script
  // ran. Installed here, before the page is written, so a payload that runs while the page is parsed is
  // caught too, and again after the write for browsers that reset them.
  function banner(m) { try { var d = document.createElement('div'); d.textContent = '\\u26A0 script executed in your session: ' + m; d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b4231c;color:#fff;font:600 13px system-ui,sans-serif;padding:7px 12px;z-index:99999'; (document.body || document.documentElement).appendChild(d); setTimeout(function () { try { d.remove(); } catch (e) {} }, 5000); } catch (e) {} }
  function dialogs() {
    window.alert = function (m) { banner('alert(' + m + ')'); };
    window.confirm = function (m) { banner('confirm(' + m + ')'); return false; };
    window.prompt = function (m) { banner('prompt(' + m + ')'); return null; };
  }
  dialogs();
  // Links and forms stay inside the simulation: posted to the lab page (which calls browser.navigate)
  // with this frame's nonce, never followed for real.
  function installShim(nonce) {
    function send(method, url, body) { try { parentWindow.postMessage({ __trlab: 1, type: 'nav', nonce: nonce, method: method, url: url, body: body || '' }, '*'); } catch (e) {} }
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:|tel:)/i.test(href)) { e.preventDefault(); return; }
      if (href.indexOf('#') === 0 || href.toLowerCase().indexOf('javascript:') === 0) { e.preventDefault(); return; }
      e.preventDefault(); send('GET', href);
    }, true);
    document.addEventListener('submit', function (e) {
      var f = e.target; if (!f || f.tagName !== 'FORM') return; e.preventDefault();
      var method = (f.getAttribute('method') || 'GET').toUpperCase();
      var action = f.getAttribute('action') || location.pathname;
      var p = new URLSearchParams();
      for (var i = 0; i < f.elements.length; i++) { var el = f.elements[i]; if (!el.name || el.disabled) continue; if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue; p.append(el.name, el.value); }
      if (method === 'GET') send('GET', action + (action.indexOf('?') > -1 ? '&' : '?') + p.toString());
      else send('POST', action, p.toString());
    }, true);
    dialogs();
  }
  function onMessage(e) {
    // Only our embedder, and only the first document it sends; the body replaces this document (listeners included).
    if (e.source !== parentWindow) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.__trlab !== 1 || d.type !== 'render' || typeof d.html !== 'string' || typeof d.nonce !== 'string') return;
    window.removeEventListener('message', onMessage);
    try {
      document.open();
      document.write(d.html);
      document.close();
    } finally { installShim(d.nonce); }
  }
  window.addEventListener('message', onMessage);
  parentWindow.postMessage({ __trlab: 1, type: 'ready' }, '*');
})();
</script>
</body></html>
`;
