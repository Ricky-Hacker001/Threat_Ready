// Smooth hand-off when leaving for another ThreatReady service: the page fades out, then navigates.
// Where the browser already cross-fades same-origin navigations (view transitions), it is left to do so.
// Identical copies live in onboard, InterviewPrep, Lab Simulations and Attack Reasoning (public/).
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var native = 'CSS' in window && CSS.supports && CSS.supports('view-transition-name: tr');
  document.addEventListener('click', function (e) {
    if (reduce || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    // Only the platform's own app links (header switcher, account menu, brand).
    if (!a.matches('.tr-app-link, .tr-menu-item, .tr-brand')) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.href === location.href) return;
    if (native && url.origin === location.origin) return; // the browser's own cross-fade
    e.preventDefault();
    document.documentElement.classList.add('tr-leaving');
    setTimeout(function () { location.href = url.href; }, 170);
  }, true);
  // The browser's own cross-fade only makes sense between pages that opt in (the platform apps). A hosted
  // lab console (SOC, DevSecOps, Firewall, Red Team, AI Security) is its own app, so the transition is skipped there;
  // without this Chrome reports "ViewTransition opt-in disabled" on the page being left.
  var standalone = /^\/labs\/(soc|devsecops|threatwall|redteam|aisec)(\/|$)/;
  window.addEventListener('pageswap', function (e) {
    if (!e.viewTransition) return;
    var to = e.activation && e.activation.entry && e.activation.entry.url;
    var skip = true;
    try { skip = !to || standalone.test(new URL(to, location.href).pathname); } catch (err) { skip = true; }
    if (skip) e.viewTransition.skipTransition();
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (e.reason && /ViewTransition|view transition/i.test(String(e.reason.message || e.reason))) e.preventDefault();
  });
  // Back/forward cache can restore a faded page: undo it.
  window.addEventListener('pageshow', function () { document.documentElement.classList.remove('tr-leaving'); });
})();
