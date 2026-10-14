// ThreatReady theme, applied before first paint (no flash). One choice for every app: a "tr-theme"
// cookie on the parent domain (threatready.io), so onboard., interviewprep., labs. and ar. agree.
// localStorage "tr-theme" (threatready.io's key) is the fallback. Exposes window.trSetTheme.
(function () {
  var KEY = "tr-theme";
  var host = location.hostname;
  var domain = /(^|\.)threatready\.io$/.test(host) ? "; domain=threatready.io" : "";
  function read() {
    var m = document.cookie.match(/(?:^|;\s*)tr-theme=(light|dark)/);
    if (m) return m[1];
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(t) {
    if (t === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  window.trSetTheme = function (t) {
    apply(t);
    document.cookie = KEY + "=" + t + "; path=/; max-age=31536000; samesite=lax" + domain + (location.protocol === "https:" ? "; secure" : "");
    try { localStorage.setItem(KEY, t); } catch (e) {}
  };
  apply(read());
})();
