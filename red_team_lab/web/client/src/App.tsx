import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, BASE } from './api';
import { ToastHost, useToast, Sev, StatusBadge, Dialog, useMedia, Deco } from './ui';
import { BrowserTool, ProxyTool, RepeaterTool, TerminalTool, FindingsTool, ReportTool, type ToolProps } from './tools';

/** The one loading screen every ThreatReady app shows while it opens (shared platform markup). */
function PlatformLoading({ app }: { app: string }) {
  return <div className="trp tr-loading" role="status" aria-live="polite">
    <div className="tr-loading-in">
      <div className="tr-loading-radar" aria-hidden="true">
        <span className="tr-loading-ping" />
        <svg className="tr-loading-ring" viewBox="0 0 100 100"><circle className="tr-loading-track" cx="50" cy="50" r="46" /><circle className="tr-loading-sweep" cx="50" cy="50" r="46" /></svg>
        <img src={`${BASE}logo-sm.png`} alt="" />
      </div>
      <span className="tr-loading-mark">ThreatReady</span>
      <p className="tr-loading-line"><span className="tr-loading-prompt">›</span>opening {app}<span className="tr-loading-cursor" /></p>
    </div>
  </div>;
}

type User = { id: string; name: string; onboardUrl?: string | null } | null;

// Inside ThreatReady (/me names the onboard origin) the platform owns sign-in, and the lab catalog
// is one level up from this app's base (/labs/redteam/ → /labs/).
const LABS_HOME = BASE.replace(/[^/]+\/$/, '');
const platformSignOut = (onboardUrl: string) => location.assign(`${onboardUrl}/signout?next=${encodeURIComponent(location.origin + LABS_HOME)}`);
// The ThreatReady strip above the page links to the catalog; nothing in-app duplicates it.
type Snap = { session: any; view: any; status: any } | null;

export function App() { return <ToastHost><Root /></ToastHost>; }

function Root() {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);
  const [platformOut, setPlatformOut] = useState(false);
  // The lab server (or, inside ThreatReady, the process hosting it) is not answering: say so and offer a
  // retry, never the standalone display-name form, which could not work either (merge review UI-1).
  const [unavailable, setUnavailable] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setLoading(true); setUnavailable('');
    api.me().then((u: any) => setUser(u)).catch((e) => {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) { setUnavailable(e.message); return; }
      if (e instanceof ApiError && e.body?.devLogin === false) setPlatformOut(true);
      setUser(null);
    }).finally(() => setLoading(false));
  }, [attempt]);
  if (loading) return <PlatformLoading app="the Web Pentest Lab" />;
  if (!user && unavailable) return <Unavailable message={unavailable} onRetry={() => setAttempt(a => a + 1)} />;
  if (!user && platformOut) return <SessionEnded />;
  if (!user) return <Login onIn={setUser} />;
  return <Authed user={user} onOut={() => { if (user.onboardUrl) setPlatformOut(true); setUser(null); }} />;
}

/** Inside ThreatReady: the platform session ended. Reloading goes through sign-in and back. */
function SessionEnded() {
  return <div className="trp wl"><div className="center-wrap" style={{ maxWidth: 440 }}>
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" /><strong style={{ fontSize: 18 }}>Your ThreatReady session has ended</strong></div>
      <p className="muted small">Sign in again to continue. Your lab progress is saved.</p>
      <button className="wl-btn primary" style={{ marginTop: 10 }} onClick={() => location.reload()}>Sign in again</button>
    </div>
  </div></div>;
}

/** The lab could not be reached (a restart, a network problem): what happened and a retry. */
function Unavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="trp wl"><div className="center-wrap" style={{ maxWidth: 440 }}>
    <div className="card" role="alert">
      <div className="row" style={{ marginBottom: 12 }}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" /><h1 style={{ fontSize: 18, margin: 0 }}>Can't open the Web Pentest Lab</h1></div>
      <p className="muted small">{message}</p>
      <button className="wl-btn primary" style={{ marginTop: 10 }} onClick={onRetry}>Try again</button>
    </div>
  </div></main>;
}

function Login({ onIn }: { onIn: (u: any) => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const go = async () => { try { await api.devLogin(name.trim()); onIn(await api.me()); } catch (e: any) { setErr(e.message); } };
  return <main className="trp wl"><div className="center-wrap" style={{ maxWidth: 440 }}>
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" /><h1 style={{ fontSize: 18, margin: 0 }}>ThreatReady Web Pentest Lab</h1></div>
      <p className="muted small">Enter a display name to start. This is a standalone training simulation — no real account, credential or system is involved.</p>
      <label className="tr-sr" htmlFor="rt-login-name">Display name</label>
      <input id="rt-login-name" className="wl-input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go(); }} placeholder="Your name" autoComplete="nickname" autoFocus />
      {err && <p className="small" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      <button className="wl-btn primary" style={{ marginTop: 10 }} disabled={name.trim().length < 2} onClick={go}>Enter the lab</button>
    </div>
  </div></main>;
}

function Authed({ user, onOut }: { user: any; onOut: () => void }) {
  const toast = useToast();
  const [def, setDef] = useState<any>(null);
  const [snap, setSnap] = useState<Snap>(null);
  const [resuming, setResuming] = useState(true);
  const [starting, setStarting] = useState(false);
  const labId = 'TR-RED-001';

  // On load, go straight to an existing run instead of back to the catalog (UX-10). The mode
  // picker is only for a first run, so no button ever offers a mode that will not be applied.
  useEffect(() => {
    let dead = false;
    api.definition(labId).then(d => { if (!dead) setDef(d); }).catch(e => toast(e.message, 'err'));
    api.catalog()
      .then(async (list: any[]) => {
        if (dead) return;
        const entry = list.find(c => c.id === labId);
        if (entry?.progress) { const s = await api.startSession(labId); if (!dead) setSnap(s); }
      })
      .catch(() => { /* no prior run, or catalog unavailable: show the catalog */ })
      .finally(() => { if (!dead) setResuming(false); });
    return () => { dead = true; };
  }, []);

  const start = async (mode?: string) => { setStarting(true); try { const s = await api.startSession(labId, mode); setSnap(s); } catch (e: any) { toast(e.message, 'err'); } setStarting(false); };

  const act = async (type: string, params: any = {}) => {
    if (!snap) return;
    try {
      const r = await api.action(snap.session.id, type, params);
      setSnap({ session: r.session, view: r.view, status: r.status });
      if (r.message) toast(r.message, r.ok === false ? 'err' : 'ok');
      return r;
    } catch (e: any) { if (e instanceof ApiError && e.status === 401) { onOut(); return; } toast(e.message, 'err'); throw e; }
  };

  const logout = async () => { if (user.onboardUrl) return platformSignOut(user.onboardUrl); try { await api.devLogout(); } catch {} onOut(); };

  if (resuming) return <PlatformLoading app="the Web Pentest Lab" />;
  if (!snap) return <div className="trp wl"><TopBar user={user} logout={logout} /><main className="wl-center"><Catalog def={def} start={start} starting={starting} /></main></div>;
  return <Workspace user={user} def={def} snap={snap} act={act} logout={logout} reset={async () => { const s = await api.reset(snap.session.id); setSnap(s); toast('Lab reset — fresh engagement started.', 'ok'); }} />;
}

function TopBar({ user, logout, extra }: { user: any; logout: () => void; extra?: React.ReactNode }) {
  return <div className="wl-top" role="banner">
    {user.onboardUrl ? <span className="brand">Web Pentest Lab</span> : <span className="brand"><img src={`${BASE}logo-sm.png`} alt="" />ThreatReady <span className="muted" style={{ fontWeight: 400 }}>Web Pentest Lab</span></span>}
    <span className="simbadge">Simulation environment</span>
    {extra}
    <span className="spacer" />
    <span className="muted small">{user.name}</span>
    {/* Hosted inside ThreatReady, the platform strip owns sign-out (FUNC-17). */}
    {!user.onboardUrl && <button className="wl-btn sm" onClick={logout}>Sign out</button>}
  </div>;
}

const DEFAULT_MODES = [
  { id: 'beginner', label: 'Beginner', blurb: 'Step-by-step walkthrough — exactly what to do, where, and the input to use. Plus hints.' },
  { id: 'intermediate', label: 'Intermediate', blurb: 'A one-line goal per level and on-demand hints. You find the path.' },
  { id: 'advanced', label: 'Advanced', blurb: 'No guidance. Objective titles and on-demand hints only — like a real engagement.' },
];

function Catalog({ def, start, starting }: { def: any; start: (mode?: string) => void; starting: boolean }) {
  const modes = def?.modes || DEFAULT_MODES;
  const [mode, setMode] = useState('beginner');
  return <div className="center-wrap">
    <h1 style={{ marginTop: 0 }}>Web application penetration-testing labs</h1>
    <p className="muted">Join a security consultancy as a junior penetration tester. Investigate a real-feeling target with a Burp-style proxy, a Kali-style terminal and an embedded browser — then remediate, verify and report.</p>
    <div className="cat-grid" style={{ marginTop: 20 }}>
      <div className="cat-card" style={{ borderColor: 'var(--accent)' }}>
        <div className="row"><span className="badge st-Confirmed">TR-RED-001</span><span className="badge sev-High">Advanced</span><span className="grow" /><span className="muted small">~150 min</span></div>
        <strong style={{ fontSize: 16 }}>{def?.title || 'The Breach Files — AeroCart'}</strong>
        <p className="small muted">{def?.subtitle || 'Investigate, exploit, remediate and report on a vulnerable e-commerce application.'}</p>
        <div className="small muted">9 vulnerability classes · recon → exploit → remediate → report</div>
        <div style={{ marginTop: 4 }}>
          <span className="fld" id="mode-label">Choose your guidance level</span>
          <div className="modepick" role="radiogroup" aria-labelledby="mode-label">
            {modes.map((m: any) => <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`modeopt${mode === m.id ? ' sel' : ''}`} onClick={() => setMode(m.id)}>
              <span className="row"><b>{m.label}</b>{mode === m.id && <span className="badge st-ok" style={{ marginLeft: 'auto' }}>Selected</span>}</span>
              <span className="small muted">{m.blurb}</span>
            </button>)}
          </div>
        </div>
        <button className="wl-btn primary" onClick={() => start(mode)} disabled={starting}>{starting ? 'Starting…' : `Start engagement · ${modes.find((m: any) => m.id === mode)?.label || 'Beginner'}`}</button>
        <span className="small muted">You can change the mode any time from the top bar.</span>
      </div>
      {['AeroPay — FinTech SaaS', 'AeroDesk — Enterprise SaaS'].map(t => <div key={t} className="cat-card soon">
        <div className="row"><span className="badge st-none">Coming soon</span></div>
        <strong style={{ fontSize: 16 }}>{t}</strong>
        <p className="small muted">Access-control, business-logic and multi-tenant isolation testing. Built on the same engine.</p>
        <button className="wl-btn" disabled>Coming soon</button>
      </div>)}
    </div>
  </div>;
}

const TABS = [
  { id: 'browser', label: 'Browser' }, { id: 'proxy', label: 'Proxy' }, { id: 'repeater', label: 'Repeater' },
  { id: 'terminal', label: 'Terminal' }, { id: 'findings', label: 'Findings' }, { id: 'report', label: 'Report' },
];

function Workspace({ user, def, snap, act, logout, reset }: { user: any; def: any; snap: any; act: ToolProps['act']; logout: () => void; reset: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState('browser');
  // On phones the tool tabs scroll inside their own row (UI-2): keep the selected tab in view when it
  // is opened from elsewhere (guide steps, "Send to Repeater"). Only that row scrolls, never the page.
  useEffect(() => {
    const el = document.getElementById(`tab-${tab}`); const list = el?.parentElement;
    if (!el || !list || list.scrollWidth <= list.clientWidth) return;
    const a = list.getBoundingClientRect(), b = el.getBoundingClientRect();
    if (b.left < a.left) list.scrollLeft -= a.left - b.left;
    else if (b.right > a.right) list.scrollLeft += b.right - a.right;
  }, [tab]);
  const [repeater, setRepeater] = useState<any>(null);
  const [showBrief, setShowBrief] = useState(!snap.status.acknowledged);
  const [confirmReset, setConfirmReset] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuPop = useRef<HTMLDivElement>(null);
  // The More menu is a disclosure: focus moves to its first action, Escape closes it and returns focus.
  useEffect(() => { if (menuOpen) menuPop.current?.querySelector('button')?.focus(); }, [menuOpen]);
  const closeMenu = () => { setMenuOpen(false); menuBtn.current?.focus(); };
  // Show the guide once per browser. For a new run the briefing comes first, then the guide (see onAck);
  // a returning, already-briefed learner who hasn't seen it gets it on open.
  const guideSeen = () => { try { return !!localStorage.getItem('tr_guide_seen'); } catch { return false; } };
  const [rail, setRail] = useState<null | 'left' | 'right'>(null);  // narrow-screen drawers
  const narrow = useMedia('(max-width: 1100px)');  // below this the side rails are drawers
  const { view, status } = snap;

  const [browserPrefill, setBrowserPrefill] = useState<any>(null);
  const [termInject, setTermInject] = useState<any>(null);

  const pushRepeater = (req: any) => { setRepeater(JSON.parse(JSON.stringify(req))); setTab('repeater'); toast('Loaded into Repeater.', 'ok'); };
  const gotoTab = (t: string) => { setTab(t); setRail(null); };
  const toolProps: ToolProps = { def, view, status, sid: snap.session.id, act, pushRepeater, repeater, setRepeater, gotoTab, browserPrefill, termInject };
  const objDone = status.objectives.filter((o: any) => o.done).length;
  // Beginner "pointing" guide: highlight the tab the current step wants you in.
  const g = status.guidance;
  const pointTab = g?.mode === 'beginner' && g.currentIndex >= 0 && g.steps ? g.steps[g.currentIndex].tool : null;

  // Beginner "do this step" — load the exact input into the right tool and open it.
  const doStep = (step: any) => {
    const p = step?.prefill;
    if (!p) { gotoTab(step.tool); return; }
    if (p.tool === 'browser') { setBrowserPrefill({ method: p.method || 'GET', url: p.url, body: p.body || '', seq: Date.now() }); gotoTab('browser'); toast('Loaded into the Browser — watch it navigate.', 'ok'); }
    else if (p.tool === 'repeater') { setRepeater(JSON.parse(JSON.stringify(p.request))); gotoTab('repeater'); toast('Loaded into Repeater — press Send.', 'ok'); }
    else gotoTab(p.tool || step.tool);
  };
  const goUrl = (url: string) => { setBrowserPrefill({ method: 'GET', url, body: '', seq: Date.now() }); gotoTab('browser'); };
  const runCmd = (cmd: string) => { setTermInject({ cmd, seq: Date.now() }); gotoTab('terminal'); };
  const copyText = (t: string) => { navigator.clipboard?.writeText(t).then(() => toast('Copied.', 'ok'), () => toast('Copy failed — select and copy manually.', 'err')); };

  return <div className="trp wl">
    <div className="wl-top" role="banner">
      {user.onboardUrl ? <span className="brand">Web Pentest Lab</span> : <span className="brand"><img src={`${BASE}logo-sm.png`} alt="" />ThreatReady<span className="brandsub"> · Web Pentest Lab</span></span>}
      <span className="simbadge">Simulation</span>
      <span className="lvlpill">L{status.level}/4 · {LEVEL_NAMES[status.level - 1]}</span>
      <span className="scorepill hide-sm">{status.score.total}/{status.score.max} pts</span>
      <span className="spacer" />
      <label className="tr-sr" htmlFor="mode-select">Guidance mode</label>
      <select id="mode-select" className="wl-select modesel" value={status.mode} onChange={e => act('settings.setMode', { mode: e.target.value })} title="Guidance mode">
        <option value="beginner">Beginner</option>
        <option value="intermediate">Intermediate</option>
        <option value="advanced">Advanced</option>
      </select>
      <button className="wl-btn sm hide-sm" onClick={() => setShowBrief(true)}>Brief</button>
      <button className="wl-btn sm hide-sm" onClick={() => setConfirmReset(true)}>Reset</button>
      {/* On small screens Brief and Reset move into this menu so they stay reachable (UX-18). */}
      <div className="wl-menu show-sm" onKeyDown={e => { if (e.key === 'Escape' && menuOpen) { e.stopPropagation(); closeMenu(); } }}>
        <button ref={menuBtn} className="wl-btn sm" aria-expanded={menuOpen} aria-controls="rt-more-menu" onClick={() => setMenuOpen(o => !o)}>More <Deco>▾</Deco></button>
        {menuOpen && <>
          <div className="wl-menu-back" onClick={closeMenu} />
          <div className="wl-menu-pop" id="rt-more-menu" ref={menuPop} role="group" aria-label="More actions">
            <button className="wl-menu-item" onClick={() => { setMenuOpen(false); setShowBrief(true); }}>Brief</button>
            <button className="wl-menu-item" onClick={() => { setMenuOpen(false); setConfirmReset(true); }}>Reset engagement</button>
            {!user.onboardUrl && <button className="wl-menu-item" onClick={() => { setMenuOpen(false); logout(); }}>Sign out</button>}
          </div>
        </>}
      </div>
      <span className="muted small hide-sm">{user.name}</span>
      {!user.onboardUrl && <button className="wl-btn sm hide-sm" onClick={logout}>Sign out</button>}
    </div>

    <h1 className="tr-sr">ThreatReady Web Pentest Lab — {def?.title || 'TR-RED-001'}</h1>
    <div className="wl-main">
      {rail && <div className="wl-railback" onClick={() => setRail(null)} />}
      {/* When these rails are closed drawers they are removed from the tab order and the a11y tree (A11Y-03). */}
      <aside className={`wl-rail${rail === 'left' ? ' open' : ''}`} aria-label="Mission" {...(narrow && rail !== 'left' ? { inert: true, 'aria-hidden': true } : {})}>
        <div className="railclose"><b>Mission</b><button className="wl-btn sm" onClick={() => setRail(null)} aria-label="Close Mission panel"><Deco>✕</Deco></button></div>
        <MissionRail status={status} act={act} />
      </aside>
      <main className="wl-center">
        <GuidanceBanner guidance={status.guidance} gotoTab={gotoTab} complete={status.complete} doStep={doStep} runCmd={runCmd} copyText={copyText} goUrl={goUrl} level={status.level} />
        <div className="wl-tabs">
          {/* The accessible name starts with the visible label (and count), the rest is screen-reader text,
              so "Mission 3" is also what voice-control users say (WCAG 2.5.3, UI-7). */}
          <button className="wl-tab railtoggle" onClick={() => setRail('left')}><Deco>☰</Deco> Mission{objDone > 0 && <> <span className="count">{objDone}</span><span className="tr-sr"> done</span></>}<span className="tr-sr">, objectives and hints</span></button>
          <div className="wl-tablist" role="tablist" aria-label="Tools" onKeyDown={onTabKey}>
          {TABS.map(t => <button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={`wl-tab ${tab === t.id ? 'active' : ''}${pointTab === t.id && tab !== t.id ? ' point' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {pointTab === t.id && tab !== t.id && <span className="point-dot" aria-hidden="true" />}
            {t.id === 'proxy' && view.history.length > 0 && <span className="count">{view.history.length}</span>}
            {t.id === 'findings' && status.posture.confirmed > 0 && <span className="count">{status.posture.confirmed}</span>}
          </button>)}
          </div>
          <button className="wl-tab railtoggle rt-right" onClick={() => setRail('right')}>Activity{status.evidence.length > 0 && <> <span className="count">{status.evidence.length}</span><span className="tr-sr"> saved</span></>}<span className="tr-sr">, evidence, findings and story</span></button>
        </div>
        <div className="wl-toolwrap">
          <div role="tabpanel" id="panel-browser" aria-labelledby="tab-browser" hidden={tab !== 'browser'}><BrowserTool {...toolProps} /></div>
          <div role="tabpanel" id="panel-proxy" aria-labelledby="tab-proxy" hidden={tab !== 'proxy'}><ProxyTool {...toolProps} /></div>
          <div role="tabpanel" id="panel-repeater" aria-labelledby="tab-repeater" hidden={tab !== 'repeater'}><RepeaterTool {...toolProps} /></div>
          <div role="tabpanel" id="panel-terminal" aria-labelledby="tab-terminal" hidden={tab !== 'terminal'} style={{ height: tab === 'terminal' ? '100%' : undefined }}><TerminalTool {...toolProps} /></div>
          <div role="tabpanel" id="panel-findings" aria-labelledby="tab-findings" hidden={tab !== 'findings'}><FindingsTool {...toolProps} /></div>
          <div role="tabpanel" id="panel-report" aria-labelledby="tab-report" hidden={tab !== 'report'}><ReportTool {...toolProps} /></div>
        </div>
      </main>
      <aside className={`wl-rail right${rail === 'right' ? ' open' : ''}`} aria-label="Evidence, findings and story" {...(narrow && rail !== 'right' ? { inert: true, 'aria-hidden': true } : {})}>
        <div className="railclose"><b>Activity</b><button className="wl-btn sm" onClick={() => setRail(null)} aria-label="Close Activity panel"><Deco>✕</Deco></button></div>
        <ContextRail status={status} view={view} act={act} def={def} gotoTab={gotoTab} defaultGuideOpen={!guideSeen()} />
      </aside>
    </div>

    {showBrief && def && <Briefing def={def} acknowledged={status.acknowledged} onAck={() => { if (!status.acknowledged) act('engagement.acknowledge'); setShowBrief(false); }} onClose={() => setShowBrief(false)} />}
    {confirmReset && <Dialog title="Reset the engagement?" onClose={() => setConfirmReset(false)} maxWidth={440}>
      <p className="muted">This archives your current run (its report stays readable) and starts a fresh one from the beginning.</p>
      <div className="row"><button className="wl-btn primary" data-autofocus onClick={() => { reset(); setConfirmReset(false); }}>Reset</button><button className="wl-btn" onClick={() => setConfirmReset(false)}>Cancel</button></div>
    </Dialog>}
  </div>;
}

// Tabs follow the ARIA tabs pattern: one tab stop, arrow keys move the active tab.
function onTabKey(e: React.KeyboardEvent) {
  const key = e.key;
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(key)) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const cur = tabs.indexOf(document.activeElement as HTMLElement);
  if (cur === -1) return;
  e.preventDefault();
  const n = { ArrowRight: (cur + 1) % tabs.length, ArrowLeft: (cur - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[key]!;
  tabs[n].click(); tabs[n].focus();
}

const LEVEL_NAMES = ['Reconnaissance', 'Exploitation', 'Remediation', 'Reporting'];
const TOOL_LABEL: Record<string, string> = { browser: 'Browser', proxy: 'Proxy', repeater: 'Repeater', terminal: 'Terminal', findings: 'Findings', report: 'Report' };

function GuidanceBanner({ guidance, gotoTab, complete, doStep, runCmd, copyText, goUrl, level }: { guidance: any; gotoTab: (t: string) => void; complete: boolean; doStep: (s: any) => void; runCmd: (c: string) => void; copyText: (t: string) => void; goUrl: (u: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(false);
  const [whyOpen, setWhyOpen] = useState(true);
  // Collapsing the step panel is remembered, so the tools are not pushed below the fold (UX-02).
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('tr_guide_collapsed') === '1'; } catch { return false; } });
  const setCollapse = (v: boolean) => { setCollapsed(v); try { localStorage.setItem('tr_guide_collapsed', v ? '1' : '0'); } catch { /* storage unavailable */ } };
  if (!guidance || guidance.mode === 'advanced') return null;

  if (guidance.mode === 'intermediate')
    return <div className="guidebar int"><span className="gb-tag">Guided · Intermediate</span><span className="gb-tip">{guidance.tip}</span><span className="gb-hint muted small">Need more? Reveal a hint under any objective (<Deco>☰</Deco> Mission).</span></div>;

  // beginner
  const steps = guidance.steps as any[];
  const i = guidance.currentIndex;
  const levelLine = <div className="gb-level"><span className="gb-level-name">Level {level} · {LEVEL_NAMES[level - 1]}</span> — {guidance.levelWhy}</div>;
  if (i === -1 || complete)
    return <div className="guidebar done"><span className="gb-tag ok">Guided · Beginner</span><span className="gb-tip"><Deco>🎉</Deco> All steps complete{complete ? ' — engagement delivered!' : ' for now. Great work!'}</span><button className="wl-btn sm" onClick={() => setExpanded(e => !e)}>{expanded ? 'Hide steps' : 'Review steps'}</button>{expanded && <StepList steps={steps} current={i} />}</div>;

  const step = steps[i];
  const p = step.prefill;
  const doLabel = <>Load into {p?.tool === 'repeater' ? 'Repeater' : 'the Browser'} <Deco>→</Deco></>;
  if (collapsed)
    return <div className="guidebar collapsed">
      <span className="gb-tag">Guided · Beginner</span>
      <span className="gb-step">Step {i + 1} of {guidance.total}</span>
      <span className="gb-tip gb-collapsed-title">{step.title}</span>
      <span className="grow" />
      <button className="wl-btn primary sm" onClick={() => (p ? doStep(step) : gotoTab(step.tool))}>{p ? doLabel : <>Go to {TOOL_LABEL[step.tool] || step.tool} <Deco>→</Deco></>}</button>
      <button className="wl-btn sm" aria-expanded={false} onClick={() => setCollapse(false)}>Show steps</button>
    </div>;
  return <div className="guidebar">
    <div className="gb-head">
      <span className="gb-tag">Guided · Beginner</span>
      <span className="gb-step">Step {i + 1} of {guidance.total}</span>
      <span className="muted small hide-sm">in {TOOL_LABEL[step.tool] || step.tool}</span>
      <span className="grow" />
      <button className="wl-btn sm" aria-pressed={whyOpen} onClick={() => setWhyOpen(w => !w)} title="Why are we doing this?">{whyOpen ? 'Hide why' : 'Why?'}</button>
      <button className="wl-btn sm" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>{expanded ? 'Hide all' : 'All steps'}</button>
      <button className="wl-btn sm" aria-expanded={true} onClick={() => setCollapse(true)}>Collapse</button>
    </div>
    {whyOpen && levelLine}
    <div className="gb-current">
      <div className="gb-title">{step.title}</div>
      {whyOpen && step.why && <div className="gb-why"><Deco>🎯</Deco> <b>Why this step:</b> {step.why}</div>}
      <div className="gb-detail">{step.detail}</div>

      {p?.tool === 'terminal' && <div className="gb-cmds">
        {p.commands.map((c: string, k: number) => <div key={k} className="gb-cmd">
          <code className="grow">{c}</code>
          <button className="wl-btn sm" onClick={() => copyText(c)}>Copy</button>
          {p.runnable !== false && <button className="wl-btn primary sm" onClick={() => runCmd(c)}>Run</button>}
        </div>)}
      </div>}

      {p?.urls && <div className="gb-urls"><span className="muted small" style={{ width: '100%' }}>Click each to visit it (every one is logged in the Proxy):</span>
        {p.urls.map((u: any, k: number) => <button key={k} className="wl-btn sm" onClick={() => goUrl(u.url)}>{u.label} <Deco>→</Deco></button>)}
      </div>}

      {!p?.urls && <div className="row" style={{ marginTop: 8 }}>
        {p?.tool === 'terminal'
          ? <button className="wl-btn sm" onClick={() => gotoTab('terminal')}>Open Terminal <Deco>→</Deco></button>
          : p ? <button className="wl-btn primary sm" onClick={() => doStep(step)}>{doLabel}</button>
            : <button className="wl-btn primary sm" onClick={() => gotoTab(step.tool)}>Go to {TOOL_LABEL[step.tool] || step.tool} <Deco>→</Deco></button>}
        <span className="muted small">This step checks off automatically once done.</span>
      </div>}
    </div>
    {expanded && <StepList steps={steps} current={i} />}
  </div>;
}

function StepList({ steps, current }: { steps: any[]; current: number }) {
  return <ol className="gb-list">
    {steps.map((s, idx) => <li key={s.id} className={s.done ? 'done' : idx === current ? 'cur' : ''}>
      <span className="gb-tick" aria-hidden="true">{s.done ? '✓' : idx === current ? '▸' : '○'}</span> {s.title}{s.done && <span className="tr-sr"> (done)</span>}
    </li>)}
  </ol>;
}

function MissionRail({ status, act }: { status: any; act: ToolProps['act'] }) {
  const byLevel = useMemo(() => { const m: Record<number, any[]> = {}; for (const o of status.objectives) (m[o.level] ||= []).push(o); return m; }, [status.objectives]);
  return <div>
    <div className="railsec">
      <h2>Attack surface</h2>
      <div className="small">Routes seen: <b>{status.recon.routes}</b> · robots.txt {status.recon.robots ? 'yes' : 'no'} · API {status.recon.apiSeen ? 'yes' : 'no'} · admin {status.recon.adminSeen ? 'yes' : 'no'}</div>
      <div className="small muted" style={{ marginTop: 4 }}>Posture: {status.posture.confirmed} confirmed · {status.posture.verified} verified / {status.posture.total}</div>
      <div className="hintbox" style={{ marginTop: 8 }}><Deco>💡</Deco> Stuck on an objective below? Use its <b>Reveal hint</b> button for a staged nudge (−25% each). New here? Open the <b>Guide</b> in the Activity panel (right).</div>
    </div>
    {[1, 2, 3, 4].map(lvl => <div key={lvl} className="railsec">
      <div className="lvlhead">Level {lvl}: {LEVEL_NAMES[lvl - 1]} {lvl > status.level && <span className="lk"><Deco>🔒</Deco> <span className="tr-sr">locked</span></span>}</div>
      {(byLevel[lvl] || []).map(o => <Objective key={o.id} o={o} act={act} complete={status.complete} />)}
    </div>)}
  </div>;
}

function Objective({ o, act, complete }: { o: any; act: ToolProps['act']; complete?: boolean }) {
  // Completion is shown by a check mark and label, not colour alone (A11Y-15).
  return <div className={`obj ${o.done ? 'done' : ''} ${o.locked ? 'locked' : ''}`}>
    <div className="obh"><span className="tick" aria-hidden="true">{o.done ? '✓' : ''}</span><span className="ot">{o.title}</span><span className="pts">{o.done ? 'Done · ' : ''}{o.awarded ?? 0}/{o.points}</span></div>
    {o.hints.map((h: string, i: number) => <div key={i} className="hintbox"><Deco>💡</Deco> {h}</div>)}
    {!o.locked && !o.done && !complete && o.hintsRemaining > 0 && <button className="wl-btn sm" style={{ marginTop: 6 }} onClick={() => act('hint.request', { objectiveId: o.id })}>Reveal hint ({o.hintsRemaining} left · −25%)</button>}
  </div>;
}

function ContextRail({ status, view, act, def, gotoTab, defaultGuideOpen }: { status: any; view: any; act: ToolProps['act']; def: any; gotoTab: (t: string) => void; defaultGuideOpen: boolean }) {
  const [guideOpen, setGuideOpen] = useState(defaultGuideOpen);
  const toggleGuide = () => { const next = !guideOpen; setGuideOpen(next); if (next) { try { localStorage.setItem('tr_guide_seen', '1'); } catch {} } };
  useEffect(() => { if (defaultGuideOpen) { try { localStorage.setItem('tr_guide_seen', '1'); } catch {} } }, []);
  return <div>
    <div className="railsec">
      <h2 className="railsec-head"><span><Deco>📖</Deco> Guide</span><button className="wl-btn sm" aria-expanded={guideOpen} onClick={toggleGuide}>{guideOpen ? 'Hide' : 'How this lab works'}</button></h2>
      {guideOpen ? <GuideBody def={def} gotoTab={gotoTab} /> : <div className="muted small">Workflow, every tool, a terminal cheat-sheet and good habits — with links that jump to the right tool.</div>}
    </div>
    <div className="railsec">
      <h2>Story &amp; activity</h2>
      {[...status.timeline].slice(-14).reverse().map((e: any, i: number) => <div key={i} className="timeline-ev"><span className={`k-${e.kind}`} aria-hidden="true">●</span><span className="small">{e.text}</span></div>)}
    </div>
    <div className="railsec">
      <h2>Evidence locker ({status.evidence.length})</h2>
      {status.evidence.length ? status.evidence.map((e: any) => <div key={e.id} className="small row" style={{ padding: '3px 0' }}><span className="code2 mono">{e.id}</span> <span className="mono">{e.method} {e.path.slice(0, 22)}</span> <span className="grow" /><span className="muted">{e.status}</span>{!status.complete && <button className="wl-btn sm" onClick={() => act('evidence.remove', { historyId: e.id })} aria-label={`Remove evidence ${e.id} from the locker`}><Deco>✕</Deco></button>}</div>) : <div className="muted small">Save requests from the Proxy, Browser or Repeater as evidence for your report.</div>}
    </div>
    <div className="railsec">
      <h2>Findings</h2>
      {status.findings.map((f: any) => <div key={f.id} className="small row" style={{ padding: '3px 0' }}><span>{f.title.length > 30 ? f.title.slice(0, 30) + '…' : f.title}</span><span className="grow" />{f.confirmed ? <StatusBadge status={f.status} /> : <span className="badge st-none">—</span>}</div>)}
    </div>
  </div>;
}

function GuideBody({ def, gotoTab }: { def: any; gotoTab: (t: string) => void }) {
  const host = def?.target?.host || 'shop.aerocart.lab';
  const cmds = (def?.terminalCommands || []) as string[];
  const jump = (t: string) => gotoTab(t);
  return <div className="guide-inline">
    <p className="muted small">You're a junior pentester on an authorized engagement against the synthetic target <span className="code2 mono">{host}</span>. Everything is simulated. Work through four levels; each unlocks when the previous one's objectives (left) are done.</p>

    <h5>The workflow</h5>
    <div className="guide-flow">
      <span className="guide-step"><b>1 · Recon</b><br />Map the site, APIs & hidden paths</span>
      <span className="guide-step"><b>2 · Exploit</b><br />Prove each vulnerability with real traffic</span>
      <span className="guide-step"><b>3 · Remediate</b><br />Apply the fix, then re-test to verify</span>
      <span className="guide-step"><b>4 · Report</b><br />Document with evidence & deliver</span>
    </div>

    <h5>First steps</h5>
    <ol className="tight">
      <li>Open the <button type="button" className="guide-link" onClick={() => jump('terminal')}>Terminal</button> and run <span className="code2 mono">whatweb {`http://${host}/`}</span>, then <span className="code2 mono">curl {`http://${host}/robots.txt`}</span> — <span className="code2 mono">Disallow</span> maps what they'd rather you not see.</li>
      <li>In the <button type="button" className="guide-link" onClick={() => jump('browser')}>Browser</button>, visit pages (click the link chips). Every request is logged in the <button type="button" className="guide-link" onClick={() => jump('proxy')}>Proxy</button>.</li>
      <li>Send anything interesting to <button type="button" className="guide-link" onClick={() => jump('repeater')}>Repeater</button> and tamper with it. When your traffic proves a flaw it turns up as <b>Confirmed</b> in <button type="button" className="guide-link" onClick={() => jump('findings')}>Findings</button>.</li>
      <li>Stuck? Each objective (left) has staged <b><Deco>💡</Deco> Reveal hint</b> buttons.</li>
    </ol>

    <h5>The tools</h5>
    <dl className="kv">
      <dt>Browser</dt><dd>Embedded browser for the target. GET/POST from the address bar; links & forms stay in the simulation; manage the cookie jar; toggle proxy interception.</dd>
      <dt>Proxy</dt><dd>Every HTTP request from every tool, with response and detection flags. Inspect raw req/resp, send to Repeater, or save to evidence.</dd>
      <dt>Repeater</dt><dd>Hand-edit a request (method, path, query, headers, cookies, body) and resend. Where most exploitation happens.</dd>
      <dt>Terminal</dt><dd>Kali-style shell against the lab target: <span className="mono">{cmds.filter(c => ['whatweb', 'nmap', 'ffuf', 'gobuster', 'nikto', 'curl', 'sqlmap', 'jwt', 'base64'].includes(c)).join(', ')}</span> plus file commands. Type <span className="code2 mono">help</span>.</dd>
      <dt>Findings</dt><dd>Your tracker. Confirm → document (severity) → remediate → re-test to Verify. Root cause & fix revealed after verification.</dd>
      <dt>Report</dt><dd>Unlocks at Level 4. Write the summary and submit; a report renders with Print/PDF and JSON export from your evidence.</dd>
    </dl>

    <h5>Good habits</h5>
    <ul className="tight">
      <li><b>Prove, don't guess</b> — reporting an unconfirmed issue is penalised.</li>
      <li><b>Save evidence as you go</b> (<Deco>★</Deco> Save to evidence) — your report cites it.</li>
      <li><b>Fix ≠ verified</b> — always Re-test after remediating.</li>
      <li>Progress saves automatically; <b>Reset</b> archives the run and starts fresh.</li>
    </ul>
  </div>;
}

function Briefing({ def, acknowledged, onAck, onClose }: { def: any; acknowledged: boolean; onAck: () => void; onClose: () => void }) {
  const b = def.briefing;
  // A new run must be acknowledged, so it cannot be dismissed with Escape/backdrop; a reopened one can.
  return <Dialog title={def.title} onClose={acknowledged ? onClose : undefined} backdropCloses={acknowledged}>
    <div className="row"><span className="badge st-Confirmed">{b.engagement}</span><span className="badge sev-High">Authorized engagement</span></div>
    <p className="muted small">Client: {b.client} · Your role: {b.role}</p>
    <p>{b.intro}</p>
    <dl className="kv">
      <dt>Authorization</dt><dd>{b.authorization}</dd>
      <dt>In scope</dt><dd>{b.scope.join(' ')}</dd>
      <dt>Out of scope</dt><dd>{b.outOfScope.join(' ')}</dd>
      <dt>Target</dt><dd className="mono">{def.target.host}</dd>
      <dt>Deliverable</dt><dd>{b.deliverables}</dd>
    </dl>
    <h3 style={{ marginBottom: 4 }}>Rules of engagement</h3>
    <ul className="tight">{b.rules.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
    <h3 style={{ marginBottom: 4 }}>Levels</h3>
    <ul className="tight">{b.levels.map((l: any) => <li key={l.n}>Level {l.n}: {l.name}</li>)}</ul>
    <div className="row" style={{ marginTop: 16 }}><button className="wl-btn primary" data-autofocus onClick={onAck}>{acknowledged ? 'Close' : 'Acknowledge & enter the workspace'}</button></div>
  </Dialog>;
}
