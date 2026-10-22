// Time spent, for the admin console: about once a minute while a ThreatReady page is visible and in
// use, tell onboard which app (and area) it is. The server credits only the time since the previous
// ping (≤ 75 s), so nothing is counted while the tab is hidden or the user is away. Sent to the same
// origin (/api is onboard on every deployment). Identical copies live in onboard, InterviewPrep,
// Lab Simulations and Attack Reasoning (public/); lab consoles get it through lab-nav.js.
(function () {
  if (window.__trActivity) return;
  window.__trActivity = true;
  var EVERY = 60000;
  var IDLE_AFTER = 5 * 60000; // reading a question or a log for a few minutes still counts
  var lastInput = Date.now();
  var stopped = false;
  var clean = function (s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); };

  /** Which app and where, from the path (the same on every deployment). */
  function where() {
    var p = location.pathname, m;
    if ((m = /^\/interview-prep(?:\/([^/]+))?(?:\/[^/]+(\/report)?)?/.exec(p))) {
      var seg = m[1] || '';
      return { app: 'interview', area: seg === 'sessions' ? (m[2] ? 'report' : 'interview') : seg === 'new' || seg === 'history' ? seg : '' };
    }
    if ((m = /^\/labs\/([^/]*)(?:\/([^/]+))?/.exec(p))) {
      var lab = m[1] || '';
      return { app: 'labs', area: !lab || lab === 'tracks' ? '' : clean(lab) };
    }
    if ((m = /^\/ar\/([^/]*)(?:\/([^/]+))?/.exec(p))) {
      var s = m[1] || '';
      return { app: 'reasoning', area: s === 'domains' ? clean(m[2]) : s === 'attempts' ? 'attempt' : s === 'history' ? 'history' : '' };
    }
    if ((m = /^\/app(?:\/([^/]+))?/.exec(p))) return { app: 'home', area: m[1] === 'profile' || m[1] === 'admin' ? m[1] : '' };
    return null; // sign-in and other public pages: nothing to count
  }

  function ping(final) {
    if (stopped) return;
    var w = where();
    if (!w) return;
    if (!final && (document.visibilityState !== 'visible' || Date.now() - lastInput > IDLE_AFTER)) return;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* older browsers */ }
    try {
      fetch('/api/activity/ping', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: w.app, area: w.area, timeZone: tz }),
      }).then(function (r) { if (r.status === 401 || r.status === 403 || r.status === 404) stopped = true; }, function () { /* offline: try next time */ });
    } catch (e) { /* ignore */ }
  }

  var mark = function () { lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (t) { addEventListener(t, mark, { passive: true, capture: true }); });
  var moved = 0;
  addEventListener('pointermove', function () { var n = Date.now(); if (n - moved > 5000) { moved = n; mark(); } }, { passive: true });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') ping(true); else { mark(); ping(); } });
  setTimeout(ping, 5000);
  setInterval(ping, EVERY);
})();
