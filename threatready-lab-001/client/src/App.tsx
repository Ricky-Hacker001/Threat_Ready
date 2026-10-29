import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, newRequestId, onConnection, store, fmt, signOut, onboardLinks, BASE } from './api';
import { Catalog, TrackPage, NotFoundPage, trackBySlug } from './catalog';
import { PlatformLoading, platformApps } from './shell';
import { Ctx, Modal, Badge, Tabs, Note, Field, StatusDot, tabPanelProps, useLab as useLabCtx } from './ui';
import { IamConsole, S3Console, Ec2Console, VpcConsole } from './services1';
import { CloudTrailConsole, CloudWatchConsole, LambdaConsole, KmsConsole, SecretsConsole, OrgConsole } from './services2';
import { ArchitectureCorner } from './architecture';
import { Home, FindingsPage, IncidentCenter, ObjectivesPage, ReportScreen, ObjectiveList, sevTone, statusTone } from './pages';

export const SERVICES = [
  { id: 'home', label: 'Console Home', group: '' },
  { id: 'iam', label: 'IAM', group: 'Security, Identity & Compliance', global: true, desc: 'Users, roles and policies' },
  { id: 'kms', label: 'KMS', group: 'Security, Identity & Compliance', desc: 'Encryption keys' },
  { id: 'secrets', label: 'Secrets Manager', group: 'Security, Identity & Compliance', desc: 'Stored credentials' },
  { id: 'org', label: 'Governance', group: 'Security, Identity & Compliance', global: true, desc: 'Organization and guardrails' },
  { id: 's3', label: 'S3', group: 'Storage', desc: 'Buckets and objects' },
  { id: 'ec2', label: 'EC2', group: 'Compute & Networking', desc: 'Instances and security groups' },
  { id: 'vpc', label: 'VPC', group: 'Compute & Networking', desc: 'Network topology' },
  { id: 'lambda', label: 'Lambda', group: 'Compute & Networking', desc: 'Functions' },
  { id: 'cloudtrail', label: 'CloudTrail', group: 'Management & Monitoring', desc: 'Audit event history' },
  { id: 'cloudwatch', label: 'CloudWatch', group: 'Management & Monitoring', desc: 'Metrics, logs and alarms' },
  { id: 'findings', label: 'Security Findings', group: 'ThreatReady Lab', lab: true },
  { id: 'incident', label: 'Incident Center', group: 'ThreatReady Lab', lab: true },
  { id: 'objectives', label: 'Lab Objectives', group: 'ThreatReady Lab', lab: true },
];
const REGIONS = [['ap-south-1', 'Asia Pacific (Mumbai)'], ['ap-southeast-1', 'Asia Pacific (Singapore)'], ['us-east-1', 'US East (N. Virginia)'], ['eu-west-1', 'Europe (Ireland)']];
const parseHash = () => { const [service = 'home', type = '', id = '', tab = ''] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent); return { service: service || 'home', type, id, tab }; };
const toHash = (r: any) => '#/' + [r.service, r.type, r.id, r.tab].map(x => encodeURIComponent(x || '')).join('/').replace(/\/+$/, '');
/** Above this width the services nav and the lab panel sit beside the console; below it they overlay it, so they start closed. */
const wideConsole = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1101px)').matches;
/** The services nav overlays the console at this width and below (styles.css). */
const navOverlays = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;

/** Plain-language titles for the server's error codes; the message under the title explains what happened. */
const CODE_TITLE: Record<string, string> = {
  AccessDenied: 'Access denied', NotSupportedByEvidence: 'Not supported by the evidence', EvidenceRequired: 'Inspect the evidence first',
  PreconditionFailed: 'Not available yet', LabComplete: 'Lab complete', NotFound: 'Not found', TargetNotFoundException: 'Not found',
  ValidationError: 'Check your input', InvalidParameterValue: 'Check your input', MalformedPolicy: 'Policy is not valid',
  MalformedPolicyDocument: 'Policy is not valid', MalformedPolicyDocumentException: 'Policy is not valid', ConstraintViolationException: 'Change refused',
  DuplicatePolicyAttachmentException: 'Already attached', PolicyNotAttachedException: 'Not attached', ResourceExistsException: 'Already exists',
  KMSInvalidStateException: 'Key cannot be used right now', RotationFailed: 'Rotation failed', NotSupported: 'Not supported', UnknownAction: 'Action not recognised',
};
const initials = (name: string) => (name || '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
export const toastTitle = (tone: string, code?: string) => (tone === 'ok' ? 'Success' : code ? CODE_TITLE[code] ?? 'Action failed' : 'Something went wrong');

/**
 * Lab Simulations, served under /labs/. `/labs/` is the catalog; `/labs/<id>` is one lab. Sign-in happens on
 * onboard.threatready.io: with no session the API answers 401 and the client goes there and back.
 */
export function App() {
  const [user, setUser] = useState<any>(null); const [err, setErr] = useState('');
  const [path, setPath] = useState(location.pathname);
  // A lab address the server does not know (a stale or mistyped /labs/<id>): the not-found page, not a Retry.
  const [missing, setMissing] = useState<string | null>(null);
  // The session and the app list together (the list capped at 1.5 s), so the header never renders half-filled.
  const load = useCallback(() => { setErr(''); Promise.all([api('/me'), Promise.race([platformApps(), new Promise((r) => setTimeout(r, 1500))])]).then(([u]) => setUser(u), (e: any) => { if (e.status !== 401 && e.code !== 'AUTH_ACCOUNT_REQUIRED') setErr(e.message); }); }, []);
  useEffect(() => { load(); const h = () => setPath(location.pathname); window.addEventListener('popstate', h); return () => window.removeEventListener('popstate', h); }, []);
  const go = (to: string) => { history.pushState(null, '', to); setPath(to); window.scrollTo(0, 0); };
  if (err) return <div className="trp tr-center"><div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={load}>Retry</button></div></div>;
  if (!user) return <PlatformLoading app="Lab Simulations" />;
  const open = (id: string) => go(`${BASE}${encodeURIComponent(id)}`);
  const t = new RegExp(`^${BASE}tracks/([^/]{1,80})/?$`).exec(path);
  if (t) return trackBySlug(t[1]) ? <TrackPage key={t[1]} user={user} slug={t[1]} go={go} open={open} /> : <NotFoundPage user={user} go={go} what="track" />;
  const m = new RegExp(`^${BASE}([\\w-]{1,40})/?$`).exec(path);
  if (m && m[1] !== 'tracks') return missing === m[1] ? <NotFoundPage user={user} go={go} what="lab" /> : <Lab key={m[1]} labId={m[1]} user={user} logout={signOut} backToCatalog={() => go(BASE)} onMissing={() => setMissing(m[1])} />;
  // The catalog lives at /labs/ only; any other address under it is a broken link, not the catalog.
  const home = path === BASE || path === BASE.replace(/\/$/, '') || path === `${BASE}index.html` || path === `${BASE}tracks` || path === `${BASE}tracks/`;
  if (!home) return <NotFoundPage user={user} go={go} what="page" />;
  return <Catalog user={user} go={go} open={open} />;
}

function Lab({ labId, user, logout, backToCatalog, onMissing }: { labId: string; user: any; logout: () => void; backToCatalog: () => void; onMissing: () => void }) {
  // The ThreatReady strip (mark, Back, All labs) shared with every hosted lab console.
  useEffect(() => {
    const tag = document.createElement('script'); tag.src = `${BASE}lab-nav.js`; tag.defer = true; document.head.appendChild(tag);
    return () => { tag.remove(); document.querySelector('.tr-labnav')?.remove(); document.documentElement.classList.remove('tr-has-labnav'); };
  }, []);
  const [def, setDef] = useState<any>(null); const [snap, setSnap] = useState<any>(null); const [loadErr, setLoadErr] = useState('');
  const [route, setRoute] = useState(parseHash()); const [region, setRegion] = useState('ap-south-1');
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [toasts, setToasts] = useState<any[]>([]); const [history, setHistory] = useState<any[]>([]);
  const [confirmReq, setConfirmReq] = useState<any>(null); const [reportFor, setReportFor] = useState<string | null>(null);
  const [online, setOnline] = useState(true); const [screen, setScreen] = useState<'briefing' | 'console' | 'report'>('console');
  const [levelUp, setLevelUp] = useState<number | null>(null); const [menu, setMenu] = useState<string | null>(null); const [resetOpen, setResetOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(wideConsole); const [side, setSide] = useState(wideConsole); const [sideW, setSideW] = useState(350); const [dock, setDock] = useState(true);
  // Which run's report is open: null = this run; otherwise an archived run's session id (read-only).
  const [reportSid, setReportSid] = useState<string | null>(null); const [runsOpen, setRunsOpen] = useState(false);
  const dirty = useRef(new Set<string>()); const inspected = useRef(new Set<string>()); const prevLevel = useRef<number | null>(null); const snapRef = useRef<any>(null);

  const apply = useCallback((s: any) => { if (!s?.cloud) return; if (snapRef.current && s.session.id === snapRef.current.session.id && s.cloud.clock.minutes < snapRef.current.cloud.clock.minutes) return; snapRef.current = s; setSnap({ session: s.session, cloud: s.cloud, status: s.status }); }, []);
  const toast = useCallback((tone: string, text: string, code?: string) => { const t = { id: Math.random(), tone, text, code, at: new Date() }; setToasts(x => [...x.slice(-3), t]); setHistory(x => [t, ...x].slice(0, 30)); setTimeout(() => setToasts(x => x.filter(y => y.id !== t.id)), tone === 'ok' ? 4500 : 11000); }, []);
  const load = useCallback(async () => {
    setLoadErr('');
    try { const [d, s] = await Promise.all([api(`/labs/${labId}`), api(`/labs/${labId}/sessions`, {})]); setDef(d); apply(s); inspected.current = new Set(); prevLevel.current = s.status.level; setScreen(store.get(`tr_brief_${s.session.id}`) ? 'console' : 'briefing'); }
    catch (e: any) {
      if (e instanceof ApiError && e.status === 404) { onMissing(); return; }
      if (!(e instanceof ApiError && (e.status === 401 || e.code === 'AUTH_ACCOUNT_REQUIRED'))) setLoadErr(e.message);
    }
  }, []);
  // The console names its lab in the tab ("The Compromised Startup · Lab Simulations · ThreatReady", WCAG 2.4.2).
  useEffect(() => {
    if (!def?.title) return undefined;
    document.title = `${def.title} · Lab Simulations · ThreatReady`;
    return () => { document.title = 'Lab Simulations · ThreatReady'; };
  }, [def?.title]);
  useEffect(() => { onConnection(setOnline); load(); const h = () => setRoute(parseHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  useEffect(() => { const b = (e: BeforeUnloadEvent) => { if (dirty.current.size) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', b); return () => window.removeEventListener('beforeunload', b); }, []);
  useEffect(() => { const lv = snap?.status.level; if (lv && prevLevel.current !== null && lv > prevLevel.current) setLevelUp(lv - 1); if (lv) prevLevel.current = lv; }, [snap?.status.level]);

  const askConfirm = (c: any) => new Promise<boolean>(resolve => setConfirmReq({ ...c, resolve }));
  const sid = snap?.session.id;
  const send = async (type: string, params: any, requestId: string) => { try { return await api(`/sessions/${sid}/actions`, { type, params, requestId }); } catch (e: any) { if (e.status === 0) { await new Promise(r => setTimeout(r, 800)); return await api(`/sessions/${sid}/actions`, { type, params, requestId }); } throw e; } };
  const act = async (type: string, params: any = {}, opts: any = {}) => {
    if (busyRef.current) return null;
    if (opts.confirm && !(await askConfirm(opts.confirm))) return null;
    busyRef.current = true; setBusy(true);
    try { const r = await send(type, params, newRequestId()); apply(r); if (!opts.silent) toast(r.ok ? 'ok' : 'err', r.message, r.code); return r; }
    catch (e: any) { if (e.status !== 401) toast('err', e.message); return null; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const inspect = (key: string) => { if (!sid || inspected.current.has(key) || snapRef.current?.status.complete) return; inspected.current.add(key); send('inspect', { key }, newRequestId()).then(apply).catch(() => inspected.current.delete(key)); };
  const setDirty = (id: string, d: boolean) => { d ? dirty.current.add(id) : dirty.current.delete(id); };
  const nav = async (r: any) => {
    const next = typeof r === 'string' ? { service: r } : r;
    if (dirty.current.size && !(await askConfirm({ title: 'Discard unsaved changes?', body: 'You have edits that have not been saved. Leaving this view will discard them.', label: 'Discard changes', danger: true }))) return;
    dirty.current.clear(); setScreen('console'); location.hash = toHash(next); setRoute({ service: next.service, type: next.type || '', id: next.id || '', tab: next.tab || '' });
    // On phones the services nav covers the console: close it once a destination is chosen.
    if (navOverlays()) setNavOpen(false);
  };
  const openReport = (sid: string | null = null) => { setReportSid(sid); setScreen('report'); };
  const reset = async () => { try { const s = await api(`/sessions/${sid}/reset`, { confirm: 'RESET' }); snapRef.current = null; apply(s); inspected.current = new Set(); prevLevel.current = 1; dirty.current.clear(); setResetOpen(false); location.hash = '#/home'; setRoute(parseHash()); setScreen('briefing'); toast('ok', `Lab reset. Run ${s.session.run} started; your previous run is archived.`); } catch (e: any) { toast('err', e.message); } };

  if (loadErr) return <main className="gate"><div className="gate-card"><h1>Cannot load the lab</h1><Note tone="bad">{loadErr}</Note><button className="btn primary" onClick={load}>Retry</button><button className="btn" onClick={backToCatalog}>All labs</button></div></main>;
  if (!def || !snap) return <main className="gate"><div className="gate-card" role="status" aria-live="polite"><div className="spinner" aria-hidden="true" /><p className="muted">Loading simulation…</p></div></main>;

  const { cloud, status } = snap;
  // A completed run is read-only: every action that would change the run (and its score) is disabled.
  const ctx = { def, cloud, status, session: snap.session, user, route, nav, region, act, busy: busy || !!status.complete, working: busy, inspect, setDirty, toast, reportFinding: (resource: string) => setReportFor(resource), openReport: () => openReport(null), askConfirm };
  const svc = SERVICES.find(s => s.id === route.service) || SERVICES[0];
  const wrongRegion = region !== 'ap-south-1' && !svc.global && !svc.lab && svc.id !== 'home';
  const page = () => {
    if (wrongRegion) return <div className="page"><div className="emptystate tall"><b>No {svc.label} resources in {region}</b><p>AeroCart runs in Asia Pacific (Mumbai). Switch the region selector back to ap-south-1.</p><button className="btn" onClick={() => setRegion('ap-south-1')}>Switch to ap-south-1</button></div></div>;
    switch (route.service) {
      case 'iam': return <IamConsole />; case 's3': return <S3Console />; case 'ec2': return <Ec2Console />; case 'vpc': return <VpcConsole />;
      case 'cloudtrail': return <CloudTrailConsole />; case 'cloudwatch': return <CloudWatchConsole />; case 'lambda': return <LambdaConsole />; case 'kms': return <KmsConsole />;
      case 'secrets': return <SecretsConsole />; case 'org': return <OrgConsole />; case 'findings': return <FindingsPage />; case 'incident': return <IncidentCenter />; case 'objectives': return <ObjectivesPage />;
      default: return <Home />;
    }
  };
  const elapsed = `${Math.floor(status.minutes / 60)}h ${String(status.minutes % 60).padStart(2, '0')}m`;
  const unread = cloud.cloudwatch.notifications.length + status.alerts.length;

  return <Ctx.Provider value={ctx}>
    <div className="app" onClick={() => (menu === 'bell' || menu === 'me') && setMenu(null)} onKeyDown={e => { if (e.key === 'Escape' && (menu === 'bell' || menu === 'me')) setMenu(null); }}>
      <a className="skip" href="#main">Skip to main content</a>
      <header className="top">
        <button className="iconbtn" aria-label={navOpen ? 'Hide services navigation' : 'Show services navigation'} aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>☰</button>
        {/* Under the ThreatReady strip only the lab's name shows here (one ThreatReady mark per page); standalone it keeps the mark. */}
        <div className="brand" onClick={() => nav('home')} role="link" tabIndex={0} aria-label={`${def.id} · ${def.title}: Console Home`} onKeyDown={e => e.key === 'Enter' && nav('home')}><span className="brand-mark" aria-hidden><span className="logo">TR</span>ThreatReady</span><span className="labtitle"><span className="lab-id">{def.id}</span><span className="lab-name"> · {def.title}</span></span></div>
        <ServiceSearch />
        <div className="top-r">
          <span className="timer" title="Simulated incident clock. It is not real time: it moves forward with every step you take, including opening a resource's details to inspect it."><b>{fmt(status.time)}</b><small>T+{elapsed} · L{status.level}</small></span>
          <span className={`conn ${online ? 'ok' : 'bad'}`} role="status"><i aria-hidden />{online ? (busy ? 'Working…' : 'Connected') : 'Offline'}</span>
          <div className="dd"><button className="topbtn" aria-label={`Notifications (${unread})`} aria-haspopup="true" aria-expanded={menu === 'bell'} onClick={e => { e.stopPropagation(); setMenu(menu === 'bell' ? null : 'bell'); }}><span aria-hidden>🔔</span>{unread > 0 && <sup aria-hidden>{unread}</sup>}</button>
            {menu === 'bell' && <div className="ddmenu wide" onClick={e => e.stopPropagation()}><h3>Notifications</h3>
              {status.alerts.map((a: any) => <div key={a.id} className="notif"><Badge tone="red">Alert</Badge> <b>{a.title}</b><small>{fmt(a.at)}</small></div>)}
              {[...cloud.cloudwatch.notifications].reverse().map((n: any, i: number) => <div key={i} className="notif"><Badge tone="orange">SNS · {n.topic}</Badge> {n.message}<small>{fmt(n.at)}</small></div>)}
              {history.slice(0, 8).map(t => <div key={t.id} className="notif"><Badge tone={t.tone === 'ok' ? 'green' : 'red'}>{toastTitle(t.tone, t.code)}</Badge> {t.text}</div>)}
              {!unread && !history.length && <p className="muted">Nothing yet.</p>}</div>}</div>
          <button className="topbtn" aria-label="Help: how this lab works" onClick={() => setMenu('help')}>?</button>
          <select className="region" aria-label="Region" value={region} onChange={e => setRegion(e.target.value)}>{REGIONS.map(([id, l]) => <option key={id} value={id}>{l} · {id}</option>)}</select>
          <span className="acct" title="Simulated account"><b>{cloud.account.alias}</b><small>{cloud.account.id}</small></span>
          <div className="dd"><button className="topbtn name" aria-label={`${user.name}, ${initials(user.name)}: account and lab menu`} aria-haspopup="true" aria-expanded={menu === 'me'} onClick={e => { e.stopPropagation(); setMenu(menu === 'me' ? null : 'me'); }}><span className="nm">{user.name}</span><span className="ini" aria-hidden>{initials(user.name)}</span> <span aria-hidden>▾</span></button>
            {menu === 'me' && <div className="ddmenu"><p className="muted">Signed in as <b>{user.name}</b><br />Role: ThreatReady-SecurityAnalyst<br />Run {snap.session.run} · Level {status.level}<br />Simulated clock: {fmt(status.time)} (T+{elapsed})</p>
              <button onClick={() => setScreen('briefing')}>View briefing</button><button onClick={() => openReport(null)}>Incident report</button><button onClick={() => setRunsOpen(true)}>Previous runs…</button><button onClick={() => setResetOpen(true)}>Reset lab…</button>
              <button onClick={() => { if (!dirty.current.size || confirm('Discard unsaved changes?')) backToCatalog(); }}>All labs</button><a className="ddlink" href={onboardLinks.profile}>Profile and overview</a><button onClick={logout}>Sign out of ThreatReady</button></div>}</div>
        </div>
      </header>
      <div className="simbar" role="status">SIMULATION ENVIRONMENT — All cloud operations are simulated. No changes are made to a real AWS account.</div>
      <div className="body">
        {navOpen && <nav className="left" aria-label="Services">
          {[...new Set(SERVICES.map(s => s.group))].map(g => <div key={g}>{g && <h3>{g}</h3>}{SERVICES.filter(s => s.group === g).map(s => <button key={s.id} className={route.service === s.id && screen === 'console' ? 'on' : ''} onClick={() => nav(s.id)}>{s.label}{s.id === 'incident' && status.alerts.length > 0 && <sup>{status.alerts.length}</sup>}</button>)}</div>)}
          <div className="left-foot"><Badge tone={sevTone(status.incident.severity)}>Incident: {status.incident.severity}</Badge><small>{status.incident.id} · {status.incident.containment}</small></div>
        </nav>}
        <div className="center">
          <div className="mainwrap"><main id="main" className="main" tabIndex={-1}>
            {status.complete && screen !== 'report' && <div className="donebar" role="note"><b>This run is complete and read-only.</b> Actions that would change it are turned off. <button className="btn sm" onClick={() => openReport(null)}>Open the incident report</button> <button className="btn sm" onClick={() => setResetOpen(true)}>Reset the lab to start a new run</button></div>}
            {screen === 'report' ? <ReportScreen key={reportSid ?? 'current'} sid={reportSid} onBack={() => { setReportSid(null); setScreen('console'); }} /> : page()}</main>
            {screen !== 'report' && <ArchitectureCorner />}</div>
          <Dock open={dock} setOpen={setDock} />
        </div>
        {side ? <SidePanel width={sideW} setWidth={setSideW} close={() => setSide(false)} /> : <button className="sidetab" onClick={() => setSide(true)} aria-label="Open lab panel">Lab panel ‹</button>}
      </div>
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={`toast t-${t.tone}`}><b>{toastTitle(t.tone, t.code)}</b><span>{t.text}</span><button aria-label="Dismiss" onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>×</button></div>)}</div>

      {screen === 'briefing' && <Briefing onEnter={() => { store.set(`tr_brief_${sid}`, '1'); setScreen('console'); }} />}
      {confirmReq && <Modal title={confirmReq.title} onClose={() => { confirmReq.resolve(false); setConfirmReq(null); }} footer={<><button className="btn" onClick={() => { confirmReq.resolve(false); setConfirmReq(null); }}>Cancel</button><button className={`btn ${confirmReq.danger ? 'danger' : 'primary'}`} onClick={() => { confirmReq.resolve(true); setConfirmReq(null); }}>{confirmReq.label || 'Confirm'}</button></>}>
        <p>{confirmReq.body}</p>{confirmReq.impact && <Note tone="warn"><b>Potential operational impact.</b> {confirmReq.impact}</Note>}</Modal>}
      {reportFor && <ReportFindingModal resource={reportFor} onClose={() => setReportFor(null)} />}
      {levelUp && <LevelSummary level={levelUp} onClose={() => setLevelUp(null)} />}
      {resetOpen && <ResetModal onClose={() => setResetOpen(false)} onReset={reset} />}
      {runsOpen && <RunsModal onClose={() => setRunsOpen(false)} onOpen={(id) => { setRunsOpen(false); openReport(id === snap.session.id ? null : id); }} />}
      {menu === 'help' && <Modal title="How this lab works" onClose={() => setMenu(null)} footer={<button className="btn primary" onClick={() => setMenu(null)}>Close</button>}>
        <ol className="steps"><li><b>Investigate.</b> Open a service from the left, select a resource and read its tabs. The simulated clock is not real time: it moves forward with every step you take, including opening a resource's details, and the intruder keeps working as it does.</li><li><b>Report.</b> When configuration looks unsafe, use <i>Report finding</i> on that resource and pick the matching vulnerability.</li><li><b>Act.</b> Change the configuration yourself and confirm the change.</li><li><b>Verify.</b> Use the access test, reachability test, policy simulator or test event to prove the fix. A finding is only marked Verified after a passing test.</li><li><b>Watch production.</b> The App health tab in the bottom dock shows whether AeroCart is still working.</li></ol>
        <p className="muted">Company policies that define "correct" are in the Incident Center. Hints are per objective, in the lab panel.</p></Modal>}
    </div>
  </Ctx.Provider>;
}

function ServiceSearch() {
  const lab = useLabCtx();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const input = useRef<HTMLInputElement>(null);
  // "/" jumps to the service search (as the placeholder says), unless the learner is typing somewhere.
  useEffect(() => { const k = (e: KeyboardEvent) => { const t = e.target as HTMLElement; if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector('[aria-modal="true"]') || !input.current?.offsetParent) return; e.preventDefault(); input.current.focus(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const hits = SERVICES.filter(s => s.label.toLowerCase().includes(q.toLowerCase()) || (s.desc || '').toLowerCase().includes(q.toLowerCase()));
  return <div className="svcsearch"><input ref={input} type="search" aria-label="Search services" placeholder="Search services  [/]" value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={e => { if (e.key === 'Enter' && hits[0]) { lab.nav(hits[0].id); setQ(''); (e.target as HTMLInputElement).blur(); } }} />
    {open && q && <div className="ddmenu">{hits.length ? hits.map(s => <button key={s.id} onMouseDown={() => { lab.nav(s.id); setQ(''); }}>{s.label}<small>{s.desc}</small></button>) : <p className="muted">No services match.</p>}</div>}</div>;
}

function Briefing({ onEnter }: { onEnter: () => void }) {
  const { def, status } = useLabCtx(); const [step, setStep] = useState(0); const b = def.briefing;
  return <Modal wide title={step === 0 ? 'Incident briefing' : 'Rules and objectives'} onClose={onEnter} footer={<>{step === 1 && <button className="btn" onClick={() => setStep(0)}>Back</button>}{step === 0 ? <button className="btn primary" onClick={() => setStep(1)}>Next: rules and objectives</button> : <button className="btn primary" onClick={onEnter}>Enter the console</button>}</>}>
    {step === 0 ? <div className="brief">
      <p className="eyebrow">{def.id} · {def.category}</p><h3 className="brief-title">{def.title}</h3><p className="muted">{def.subtitle}</p>
      <p>{b.intro}</p>
      <div className="ticket"><div><Badge tone="orange">{b.ticket}</Badge> <b>Suspicious access patterns in aerocart-training</b></div><p>Assigned to: you ({b.role}). Severity: {status.incident.severity}. Account 123456789012 · ap-south-1 · production-simulation.</p></div>
      <Note tone="warn">SIMULATION ENVIRONMENT — identities, logs, documents and secrets are synthetic. Nothing here touches a real AWS account.</Note>
    </div> : <div className="brief">
      <h4>Rules</h4><ul className="rules">{b.rules.map((r: string) => <li key={r}>{r}</li>)}</ul>
      <h4>Levels</h4><ol className="levels">{b.levels.map((l: any) => <li key={l.n} className={status.level >= l.n ? 'on' : ''}><b>L{l.n}</b> {l.name}</li>)}</ol>
      <h4>Ten vulnerabilities are present</h4><p className="muted">You know what kinds of weakness exist — not where they are. Each is marked when you find it and again when you have fixed and verified it.</p>
      <ul className="vulnchips">{def.vulnerabilities.map((v: any) => <li key={v.id}>{v.title}</li>)}</ul>
    </div>}
  </Modal>;
}

function ReportFindingModal({ resource, onClose }: { resource: string; onClose: () => void }) {
  const { def, status, act } = useLabCtx(); const [sel, setSel] = useState('');
  return <Modal title="Report a finding" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!sel} onClick={async () => { const r = await act('finding.report', { findingId: sel, resource }); if (r?.ok) onClose(); }}>Submit finding</button></>}>
    <p id="rf-q">Which vulnerability does the configuration of <code>{resource.split('/').slice(1).join(' / ')}</code> demonstrate?</p>
    <p className="muted">The server checks your claim against the evidence you have inspected. Unsupported reports cost points.</p>
    <div className="radio-list" role="radiogroup" aria-labelledby="rf-q">{def.vulnerabilities.map((v: any) => { const st = status.findings.find((f: any) => f.id === v.id).status; return <label key={v.id} className={st !== 'Not found' ? 'dim' : ''}><input type="radio" name="vuln" value={v.id} disabled={st !== 'Not found'} checked={sel === v.id} onChange={() => setSel(v.id)} /> {v.title} {st !== 'Not found' && <Badge tone="grey">already recorded</Badge>}</label>; })}</div>
  </Modal>;
}

function LevelSummary({ level, onClose }: { level: number; onClose: () => void }) {
  const { status, def } = useLabCtx(); const objs = status.objectives.filter((o: any) => o.level === level); const next = def.briefing.levels.find((l: any) => l.n === level + 1);
  return <Modal title={`Level ${level} complete`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Continue to Level {level + 1}</button>}>
    <p><b>{def.briefing.levels[level - 1].name}</b></p>
    <table className="plain"><tbody>{objs.map((o: any) => <tr key={o.id}><td>✓ {o.title}</td><td className="num">{o.awarded} / {o.points}</td></tr>)}</tbody></table>
    <p className="muted">Score so far: {status.score.total} / {status.score.max} · Hints used: {status.hintsUsed} · Failed actions: {status.failedActions}</p>
    {next && <Note tone="info"><b>Next — {next.name}.</b> {status.chapters[status.chapters.length - 1].text}</Note>}
  </Modal>;
}

function ResetModal({ onClose, onReset }: { onClose: () => void; onReset: () => void }) {
  const { def } = useLabCtx(); const maxRuns = Number(def.maxRuns) || 0;
  const [t, setT] = useState('');
  return <Modal title="Reset lab" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={t !== 'RESET'} onClick={onReset}>Reset lab</button></>}>
    <p>This restores the AeroCart environment to its original, vulnerable state and starts a new run. Your current run and its report are archived: open them later from <b>Previous runs</b> in the account menu.{maxRuns > 0 && <> Up to {maxRuns} runs are kept: your best run, your best completed run and the most recent ones. Older ones are removed.</>}</p>
    <Field label='Type RESET to confirm'><input value={t} onChange={e => setT(e.target.value)} autoFocus /></Field></Modal>;
}

function SidePanel({ width, setWidth, close }: { width: number; setWidth: (n: number) => void; close: () => void }) {
  const { status, nav, openReport } = useLabCtx(); const [tab, setTab] = useState('objectives');
  const drag = (e: React.MouseEvent) => { e.preventDefault(); const x0 = e.clientX, w0 = width; const mv = (m: MouseEvent) => setWidth(Math.max(280, Math.min(560, w0 + x0 - m.clientX))); const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); };
  const cur = status.objectives.filter((o: any) => o.level === status.level);
  return <aside className="side" style={{ width: `min(${width}px, 90vw)` }} aria-label="Lab panel">
    <div className="side-drag" onMouseDown={drag} role="separator" aria-orientation="vertical" aria-label="Resize lab panel" />
    <div className="side-h"><div><b>Level {status.level}</b> · {status.progress}% complete<div className="bar"><i style={{ width: `${status.progress}%` }} /></div></div><button className="x" onClick={close} aria-label="Collapse lab panel">›</button></div>
    <Tabs label="Lab panel" panelId="lab-side-panel" value={tab} onChange={setTab} tabs={[{ id: 'objectives', label: 'Objectives' }, { id: 'vulns', label: `Vulnerabilities ${status.posture.resolved}/${status.posture.total}` }, { id: 'verify', label: 'Verify' }, { id: 'score', label: 'Score' }]} />
    <div className="side-b" {...tabPanelProps('lab-side-panel', tab)}>
      {tab === 'objectives' && <><p className="chapter"><b>{status.chapters[status.chapters.length - 1].title}.</b> {status.chapters[status.chapters.length - 1].text}</p><ObjectiveList objectives={cur} />{status.complete ? <Note tone="ok">Lab complete. <button className="btn sm" onClick={openReport}>Open the incident report</button></Note> :<a href="#" onClick={e => { e.preventDefault(); nav('objectives'); }}>All levels and objectives</a>}</>}
      {tab === 'vulns' && <ul className="vulnlist">{status.findings.map((f: any) => <li key={f.id} className={f.status === 'Verified' ? 'done' : f.status === 'Not found' ? '' : 'found'}>
        <span className="tick" aria-hidden>{f.status === 'Verified' ? '✓' : f.status === 'Not found' ? '' : '◐'}</span><div><b>{f.title}</b><small><Badge tone={statusTone(f.status)}>{f.status}</Badge>{f.severity && <Badge tone={sevTone(f.severity)}>{f.severity}</Badge>}</small></div></li>)}
        <li className="more"><a href="#" onClick={e => { e.preventDefault(); nav('findings'); }}>Open Security Findings</a></li></ul>}
      {tab === 'verify' && <><h4>Verification status</h4>{status.findings.filter((f: any) => f.checks).length === 0 && <p className="muted">Verification requirements appear here once you have recorded a finding.</p>}
        {status.findings.filter((f: any) => f.checks).map((f: any) => <div key={f.id} className="vcheck"><b>{f.id} {f.title}</b>{f.checks.map((c: any) => <div key={c.label} className={c.passed ? 'pass' : ''}>{c.passed ? '✓' : '○'} {c.label}</div>)}</div>)}
        <h4>Recent tests</h4>{!status.tests.length && <p className="muted">No tests run yet.</p>}
        <ul className="tests">{status.tests.map((t: any, i: number) => <li key={i}><Badge tone={(t.allowed ?? t.ok ?? t.recorded ?? t.accepted ?? (t.fired?.length > 0)) ? 'green' : 'grey'}>{t.kind}</Badge> {describeTest(t)}</li>)}</ul></>}
      {tab === 'score' && <><div className="bigscore"><b>{status.score.total}</b><span>/ {status.score.max} points</span></div>
        <table className="plain"><tbody>{Object.entries<any>(status.score.categories).map(([k, v]) => <tr key={k}><td style={{ textTransform: 'capitalize' }}>{k}</td><td className="num">{v.awarded} / {v.max}</td></tr>)}
          {status.score.penalties.map((p: any) => <tr key={p.label} className="pen"><td>{p.label}</td><td className="num">−{p.points}</td></tr>)}</tbody></table>
        <p className="muted">Security posture: {status.posture.resolved} of {status.posture.total} findings verified (started at 0). Hints used: {status.hintsUsed}. Failed actions: {status.failedActions}. Outages caused: {status.outages.length}.</p></>}
    </div>
  </aside>;
}
const short = (a: string) => (a || '').split(/[:/]/).pop();
export function describeTest(t: any) {
  switch (t.kind) {
    case 'iam.simulate': return `${short(t.principal)} → ${t.action}: ${t.allowed ? 'allowed' : 'denied'}`;
    case 's3.access': return `${t.principal === 'anonymous' ? 'anonymous' : short(t.principal)} ${t.operation} ${t.bucket}/${t.key}: ${t.allowed ? 'allowed' : 'denied'}`;
    case 'ec2.reach': return `${t.source} → ${t.target === 'alb' ? 'ALB' : 'instance'} tcp/${t.port}: ${t.allowed ? 'reachable' : 'blocked'}`;
    case 'cloudtrail.audit': return `audit probe ${t.recorded ? 'captured' : 'not captured'}`;
    case 'cw.test': return `${t.count} → ${t.metric}: ${t.delivered ? (t.fired.length ? `ALARM ${t.fired.join(', ')}` : 'no alarm') : 'not delivered'}`;
    case 'lambda.invoke': return `${t.name}: ${t.ok ? 'succeeded' : 'failed'}`;
    case 'kms.crypto': return `${short(t.principal)} kms:${t.operation}: ${t.allowed ? 'allowed' : 'denied'}`;
    case 'secrets.testCredential': return `${t.source === 'leaked' ? 'exposed credential' : 'stored secret'}: ${t.accepted ? 'accepted' : 'rejected'}`;
    default: return t.kind;
  }
}

/** Every run of this lab (the current one and those archived by a reset), each with its report, read-only. */
function RunsModal({ onClose, onOpen }: { onClose: () => void; onOpen: (sessionId: string) => void }) {
  const { def, session } = useLabCtx(); const [runs, setRuns] = useState<any[] | null>(null); const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); api(`/labs/${encodeURIComponent(def.id)}/runs`).then(r => Array.isArray(r) ? setRuns([...r].reverse()) : setErr('Unexpected response from the server. Retry in a moment.'), (e: any) => setErr(e.message)); }, [def.id]);
  useEffect(load, [load]);
  return <Modal wide title="Previous runs" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
    <p className="muted">A reset archives the run it ends. Archived runs are read-only; their incident report shows what was done and verified in that run.{Number(def.maxRuns) > 0 && <> Up to {Number(def.maxRuns)} runs are kept: your best run, your best completed run and the most recent ones.</>}</p>
    {err && <Note tone="bad">{err} <button className="btn sm" onClick={load}>Retry</button></Note>}
    {!runs && !err && <div role="status"><div className="spinner" aria-hidden="true" /><span className="sr">Loading runs…</span></div>}
    {runs && <div className="dt-scroll"><table><thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Level</th><th className="num">Score</th><th><span className="sr">Report</span></th></tr></thead>
      <tbody>{runs.map(r => <tr key={r.id}><td>Run {r.run}{r.id === session.id && <> <Badge tone="blue">Current</Badge></>}</td><td className="nowrap">{fmt(r.createdAt)}</td>
        <td>{r.complete ? <Badge tone="green">Completed</Badge> : r.status === 'archived' ? <Badge tone="grey">Archived</Badge> : <Badge tone="orange">In progress</Badge>}</td>
        <td>{r.level ?? '—'}</td><td className="num">{r.score ?? '—'} / {r.max ?? '—'}</td>
        <td><button className="btn sm" onClick={() => onOpen(r.id)} aria-label={`${r.complete ? 'Report' : 'Draft report'} for run ${r.run}`}>{r.complete ? 'Report' : 'Draft report'}</button></td></tr>)}
        {!runs.length && <tr><td colSpan={6} className="empty">No runs yet.</td></tr>}</tbody></table></div>}
  </Modal>;
}

function Dock({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  const { status, session } = useLabCtx(); const [tab, setTab] = useState('activity'); const [page, setPage] = useState(1); const [data, setData] = useState<any>({ rows: [], total: 0 }); const [err, setErr] = useState('');
  useEffect(() => { if (!open || tab !== 'activity') return; let live = true; api(`/sessions/${session.id}/activity?page=${page}`).then(d => { if (live && Array.isArray(d?.rows)) { setData(d); setErr(''); } }).catch(e => live && setErr(e.message)); return () => { live = false; }; }, [open, tab, page, status.minutes, status.failedActions, session.id]);
  const bad = status.health.filter((h: any) => !h.ok).length;
  return <section className={`dock ${open ? 'open' : ''}`} aria-label="Activity dock">
    <div className="dock-h"><Tabs label="Activity dock" panelId={open ? 'lab-dock-panel' : undefined} value={open ? tab : ''} onChange={t => { setTab(t); setOpen(true); }} tabs={[{ id: 'activity', label: 'Activity' }, { id: 'timeline', label: 'Incident timeline' }, { id: 'health', label: <>App health {bad > 0 ? <Badge tone="red">{bad} failing</Badge> : <Badge tone="green">OK</Badge>}</> }]} /><button className="x" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse dock' : 'Expand dock'}>{open ? '▾' : '▴'}</button></div>
    {open && <div className="dock-b" {...tabPanelProps('lab-dock-panel', tab)}>
      {tab === 'activity' && <>{err && <Note tone="bad">{err}</Note>}{!data.rows.length && !err && <p className="muted">Your actions will be recorded here. This history is append-only.</p>}
        <table className="plain log"><tbody>{data.rows.map((e: any) => <tr key={e.seq}><td className="mono">#{e.seq}</td><td className="nowrap">{fmt(e.at)}</td><td className="mono">{e.type}</td><td><Badge tone={e.outcome === 'Success' ? 'green' : 'red'}>{e.outcome}</Badge></td><td>{e.message}</td></tr>)}</tbody></table>
        {data.total > 20 && <div className="pager"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Newer</button> {page} / {Math.ceil(data.total / 20)} <button className="btn sm" disabled={page * 20 >= data.total} onClick={() => setPage(page + 1)}>Older ›</button></div>}</>}
      {tab === 'timeline' && <ul className="tl">{[...status.timeline].reverse().map((t: any, i: number) => <li key={i} className={`tl-${t.kind}`}><time>{fmt(t.at)}</time><span>{t.text}</span></li>)}</ul>}
      {tab === 'health' && <><table className="plain"><tbody>{status.health.map((h: any) => <tr key={h.id}><td><StatusDot ok={h.ok} label={h.label} /></td><td className="muted">{h.ok ? 'Healthy' : h.detail}</td></tr>)}</tbody></table>
        {status.outages.length > 0 && <p className="muted">Outages caused this run: {status.outages.map((o: any) => `${o.label} (after ${o.cause})`).join('; ')}</p>}</>}
    </div>}
  </section>;
}
