import React, { useCallback, useEffect, useState } from 'react';
import Console from './Console.jsx';
import CaseView from './CaseView.jsx';
import LevelPage from './pages/LevelPage.jsx';
import BadgesPage from './pages/BadgesPage.jsx';
import ReportPage from './pages/ReportPage.jsx';
import DemoIntro from './tour/DemoIntro.jsx';
import DemoPage from './tour/DemoPage.jsx';
import DemoSummary from './tour/DemoSummary.jsx';
import HomeTour, { tourStore } from './tour/HomeTour.jsx';
import { BadgeDialog } from './components/Badge.jsx';
import { api, onApi, session } from './api.js';

// Hash routes: #/ (SOC home), #/level/:id, #/case/:id, #/badges, #/report,
// and the Newbie Demo Mode routes under #/demo.
const parse = () => {
  const h = window.location.hash;
  let m = h.match(/^#\/case\/([a-z0-9]+)/i);
  if (m) return { page: 'case', id: m[1] };
  m = h.match(/^#\/level\/(foundations|intermediate|expert)\b/);
  if (m) return { page: 'level', id: m[1] };
  if (/^#\/badges\/?$/.test(h)) return { page: 'badges' };
  if (/^#\/report\/?$/.test(h)) return { page: 'report' };
  m = h.match(/^#\/demo\/([a-z0-9]+)\/summary/i);
  if (m) return { page: 'summary', id: m[1] };
  m = h.match(/^#\/demo\/([a-z0-9]+)(?:\?at=([a-z0-9-]+))?/i);
  if (m) return { page: 'demo', id: m[1], at: m[2] };
  if (/^#\/demo\/?$/.test(h)) return { page: 'intro' };
  if (/^(#\/?)?$/.test(h)) return { page: 'home' };
  // Anything else (a mistyped level, an old bookmark) says so instead of silently showing home.
  return { page: 'notfound' };
};
const go = (hash) => { window.location.hash = hash; };

// Optional: when the server is configured for ThreatReady, a ?t=<token>
// link is exchanged for a session, then removed from the address bar.
async function boot() {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('t');
  let tokenError = null;
  if (t) {
    url.searchParams.delete('t');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    try { await api.signIn(t); } catch (e) { tokenError = e; }
  }
  const info = await api.sessionInfo();
  session.homeUrl = info.homeUrl;
  session.dailyWipe = info.dailyWipe !== false;
  if (!info.signedIn) return { signedIn: false, tokenError };
  session.me = await api.me();
  return { signedIn: true };
}

// Standalone sign-in: the analyst enters a display name. Records are
// private to this sign-in and reset daily at 00:00 UTC.
function SignIn({ tokenError, onSignedIn }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(tokenError || null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.signInLocal(name.trim());
      session.me = await api.me();
      onSignedIn();
    } catch (x) { setErr(x); setBusy(false); }
  };
  return (
    <main className="page nosession">
      <p className="brand" aria-label="ThreatReady, by Aerovant Technologies">
        <img src={`${import.meta.env.BASE_URL}logo-sm.png`} alt="" width="26" height="25" /><span className="brand-name">ThreatReady</span>
        <span className="brand-sep" aria-hidden="true" />
        <span className="brand-product">SOC Simulation</span>
      </p>
      <h1>SOC simulation</h1>
      <p className="lead">Work security alerts the way a SOC does, from the first log line to the closed ticket. Enter the name you want on your tickets and reports.</p>
      <form className="signin" onSubmit={submit}>
        <label htmlFor="signin-name">Analyst name</label>
        <input id="signin-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Asha Rivera" maxLength={40} autoFocus autoComplete="name" />
        <button type="submit" className="btn btn-primary" disabled={busy || name.trim().length < 2}>{busy ? 'Signing in…' : 'Start'}</button>
      </form>
      {err && <p className="note note-bad" role="alert">{err.message}</p>}
      <p className="muted small">No account or password. Your progress is kept in this browser until you sign out{session.dailyWipe ? ', and all practice records reset daily at 00:00 UTC' : ''}.</p>
      <footer className="brand-foot">© {new Date().getFullYear()} Aerovant Technologies · ThreatReady</footer>
    </main>
  );
}

function NotFound({ go }) {
  return (
    <main className="page">
      <h1>Page not found</h1>
      <p className="lead">There is no SOC simulation page at <span className="mono break">{window.location.hash || '/'}</span>. The link may be mistyped or out of date.</p>
      <p className="record-row">
        <button type="button" className="btn btn-primary" onClick={() => go('#/')}>Go to SOC home</button>
        <button type="button" className="btn" onClick={() => go('#/report')}>Final analyst report</button>
      </p>
    </main>
  );
}

export default function App() {
  const [route, setRoute] = useState(parse);
  const [state, setState] = useState({ ready: false });
  // Homepage walkthrough: an overlay that lives above whichever page is showing.
  const [tour, setTour] = useState(() => tourStore.get());
  const [badges, setBadges] = useState([]);

  useEffect(() => {
    boot().then((s) => setState({ ready: true, ...s })).catch((e) => setState({ ready: true, signedIn: false, tokenError: e }));
    const offA = onApi('noSession', () => setState((s) => ({ ...s, signedIn: false })));
    const offB = onApi('awards', (list) => setBadges((q) => [...q, ...list.filter((b) => !q.some((x) => x.badgeId === b.badgeId))]));
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => { offA(); offB(); window.removeEventListener('hashchange', on); };
  }, []);

  const closeBadge = useCallback(() => setBadges((q) => q.slice(1)), []);

  if (!state.ready) return <main className="page"><p className="muted" role="status">Loading…</p></main>;
  if (!state.signedIn) return <SignIn tokenError={state.tokenError} onSignedIn={() => { setState({ ready: true, signedIn: true }); go('#/'); }} />;

  const nav = {
    goHome: () => go('#/'),
    goIntro: () => go('#/demo'),
    goDemo: (id, at) => go(`#/demo/${id}${at ? `?at=${at}` : ''}`),
    goSummary: (id) => go(`#/demo/${id}/summary`),
    // "Open normal simulation" from the demo: the SOC home scrolls to the levels.
    goNormal: () => { try { window.sessionStorage.setItem('soc-sim-focus-shift', '1'); } catch { /* storage unavailable */ } go('#/'); },
    go,
  };

  let page;
  if (route.page === 'case') page = <CaseView key={route.id} id={route.id} goHome={nav.goHome} go={go} />;
  else if (route.page === 'level') page = <LevelPage key={route.id} id={route.id} go={go} openDemo={nav.goIntro} />;
  else if (route.page === 'badges') page = <BadgesPage go={go} />;
  else if (route.page === 'report') page = <ReportPage go={go} />;
  else if (route.page === 'intro') page = <DemoIntro {...nav} />;
  else if (route.page === 'demo') page = <DemoPage key={`${route.id}:${route.at || ''}`} id={route.id} startAt={route.at} {...nav} />;
  else if (route.page === 'summary') page = <DemoSummary key={route.id} id={route.id} {...nav} />;
  else if (route.page === 'notfound') page = <NotFound go={go} />;
  else page = <Console go={go} startTour={() => setTour(0)} openDemo={nav.goIntro} />;

  return (
    <>
      {page}
      {tour !== null && <HomeTour initial={tour} onClose={() => setTour(null)} />}
      {badges.length > 0 && <BadgeDialog badge={badges[0]} onClose={closeBadge} go={go} />}
    </>
  );
}
