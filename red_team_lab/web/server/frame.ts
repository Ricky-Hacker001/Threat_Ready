// The embedded target browser's document (client/src/tools.tsx, BrowserTool). The lab's pages run under
// the platform's strict policy (script-src 'self'), which a srcdoc frame would inherit and so block the
// navigation shim and the lab's own XSS exercises. This document is served as its own same-origin route
// with a dedicated policy: an opaque-origin sandbox (no allow-same-origin: no cookies, storage or
// same-origin requests) in which inline script and style may run, nothing may be fetched except data:
// images, and nothing may be submitted or navigated to. The lab page loads it with `src=`, waits for
// `ready`, then posts the simulated response body (plus the shim) with a per-frame nonce; the document
// writes that body into itself exactly as the former srcdoc did.
export const TARGET_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts allow-forms',
].join('; ');

export const TARGET_FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>target</title></head>
<body style="margin:0">
<script>
(function () {
  'use strict';
  var parentWindow = window.parent;
  if (parentWindow === window) return; // opened directly: nothing to show
  // Blocking dialogs raised by a payload become a non-blocking banner, a safe visible proof that script
  // ran. Installed here, before the page is written, so a payload that runs before the shim at the end
  // of the page is caught too (the shim installs the same overrides again for browsers that reset them).
  function banner(m) { try { var d = document.createElement('div'); d.textContent = '\\u26A0 script executed in your session: ' + m; d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b4231c;color:#fff;font:600 13px system-ui,sans-serif;padding:7px 12px;z-index:99999'; (document.body || document.documentElement).appendChild(d); setTimeout(function () { d.remove(); }, 5000); } catch (e) {} }
  window.alert = function (m) { banner('alert(' + m + ')'); };
  window.confirm = function (m) { banner('confirm(' + m + ')'); return false; };
  window.prompt = function (m) { banner('prompt(' + m + ')'); return null; };
  function onMessage(e) {
    // Only our embedder, and only the first document it sends; the body replaces this document (listeners included).
    if (e.source !== parentWindow) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.html !== 'string' || typeof d.nonce !== 'string') return;
    window.removeEventListener('message', onMessage);
    document.open();
    document.write(d.html);
    document.close();
  }
  window.addEventListener('message', onMessage);
  parentWindow.postMessage({ __trlab: 1, type: 'ready' }, '*');
})();
</script>
</body></html>
`;
