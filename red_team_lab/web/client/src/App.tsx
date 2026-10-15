import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, BASE } from './api';
import { ToastHost, useToast, Sev, StatusBadge } from './ui';
import { BrowserTool, ProxyTool, RepeaterTool, TerminalTool, FindingsTool, ReportTool, type ToolProps } from './tools';

type User = { id: string; name: string; onboardUrl?: string | null } | null;

// Inside ThreatReady (/me names the onboard origin) the platform owns sign-in, and the lab catalog
// is one level up from this app's base (/labs/redteam/ → /labs/).
const LABS_HOME = BASE.replace(/[^/]+\/$/, '');
const platformSignOut = (onboardUrl: string) => location.assign(`${onboardUrl}/signout?next=${encodeURIComponent(location.origin + LABS_HOME)}`);
const AllLabs = ({ user }: { user: any }) => (user.onboardUrl ? <a className="wl-btn sm" href={LABS_HOME}>All labs</a> : null);
type Snap = { session: any; view: any; status: any } | null;

export function App() { return <ToastHost><Root /></ToastHost>; }

function Root() {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);
  const [platformOut, setPlatformOut] = useState(false);
  useEffect(() => {
    api.me().then((u: any) => setUser(u)).catch((e) => { if (e instanceof ApiError && e.body?.devLogin === false) setPlatformOut(true); setUser(null); }).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="center-wrap"><p className="muted">Loading ThreatReady…</p></div>;
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

function Login({ onIn }: { onIn: (u: any) => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const go = async () => { try { await api.devLogin(name.trim()); onIn(await api.me()); } catch (e: any) { setErr(e.message); } };
  return <div className="trp wl"><div className="center-wrap" style={{ maxWidth: 440 }}>
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" /><strong style={{ fontSize: 18 }}>ThreatReady Web Pentest Lab</strong></div>
      <p className="muted small">Enter a display name to start. This is a standalone training simulation — no real account, credential or system is involved.</p>
      <input className="wl-input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go(); }} placeholder="Your name" autoFocus />
      {err && <p className="small" style={{ color: 'var(--bad)' }}>{err}</p>}
      <button className="wl-btn primary" style={{ marginTop: 10 }} disabled={name.trim().length < 2} onClick={go}>Enter the lab</button>
    </div>
  </div></div>;
}

function Authed({ user, onOut }: { user: any; onOut: () => void }) {
  const toast = useToast();
  const [def, setDef] = useState<any>(null);
  const [snap, setSnap] = useState<Snap>(null);
  const [starting, setStarting] = useState(false);
  const labId = 'TR-RED-001';

  useEffect(() => { api.definition(labId).then(setDef).catch(e => toast(e.message, 'err')); }, []);

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

  if (!snap) return <div className="trp wl"><TopBar user={user} logout={logout} /><Catalog def={def} start={start} starting={starting} /></div>;
  return <Workspace user={user} def={def} snap={snap} act={act} logout={logout} reset={async () => { const s = await api.reset(snap.session.id); setSnap(s); toast('Lab reset — fresh engagement started.', 'ok'); }} />;
}

function TopBar({ user, logout, extra }: { user: any; logout: () => void; extra?: React.ReactNode }) {
  return <div className="wl-top">
    <span className="brand"><img src={`${BASE}logo-sm.png`} alt="" />ThreatReady <span className="muted" style={{ fontWeight: 400 }}>Web Pentest Lab</span></span>
    <span className="simbadge">Simulation environment</span>
    {extra}
    <span className="spacer" />
    <span className="muted small">{user.name}</span>
    <AllLabs user={user} />
    <button className="wl-btn sm" onClick={logout}>Sign out</button>
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
        <strong style={{ fontSize: 16 }}>{def?.title || 'The Breach Files — NovaCart'}</strong>
        <p className="small muted">{def?.subtitle || 'Investigate, exploit, remediate and report on a vulnerable e-commerce application.'}</p>
        <div className="small muted">9 vulnerability classes · recon → exploit → remediate → report</div>
        <div style={{ marginTop: 4 }}>
          <label className="fld">Choose your guidance level</label>
          <div className="modepick">
            {modes.map((m: any) => <button key={m.id} type="button" className={`modeopt${mode === m.id ? ' sel' : ''}`} onClick={() => setMode(m.id)}>
              <span className="row"><b>{m.label}</b>{mode === m.id && <span className="badge st-ok" style={{ marginLeft: 'auto' }}>Selected</span>}</span>
              <span className="small muted">{m.blurb}</span>
            </button>)}
          </div>
        </div>
        <button className="wl-btn primary" onClick={() => start(mode)} disabled={starting}>{starting ? 'Starting…' : `Start engagement · ${modes.find((m: any) => m.id === mode)?.label || 'Beginner'}`}</button>
        <span className="small muted">You can change the mode any time from the top bar.</span>
      </div>
      {['PayFlow — FinTech SaaS', 'TeamDesk — Enterprise SaaS'].map(t => <div key={t} className="cat-card" style={{ opacity: .6 }}>
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
  const [repeater, setRepeater] = useState<any>(null);
  const [showBrief, setShowBrief] = useState(!snap.status.acknowledged);
  const [confirmReset, setConfirmReset] = useState(false);
  // Show the guide once per browser. For a new run the briefing comes first, then the guide (see onAck);
  // a returning, already-briefed learner who hasn't seen it gets it on open.
  const guideSeen = () => { try { return !!localStorage.getItem('tr_guide_seen'); } catch { return false; } };
  const [rail, setRail] = useState<null | 'left' | 'right'>(null);  // narrow-screen drawers
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
    <div className="wl-top">
      <span className="brand"><img src={`${BASE}logo-sm.png`} alt="" />ThreatReady<span className="brandsub"> · Web Pentest Lab</span></span>
      <span className="simbadge">Simulation</span>
      <span className="lvlpill">L{status.level}/4 · {LEVEL_NAMES[status.level - 1]}</span>
      <span className="scorepill hide-sm">{status.score.total}/{status.score.max} pts</span>
      <span className="spacer" />
      <select className="wl-select modesel" value={status.mode} onChange={e => act('settings.setMode', { mode: e.target.value })} title="Guidance mode">
        <option value="beginner">◆ Beginner</option>
        <option value="intermediate">◆ Intermediate</option>
        <option value="advanced">◆ Advanced</option>
      </select>
      <button className="wl-btn sm hide-sm" onClick={() => setShowBrief(true)}>Brief</button>
      <button className="wl-btn sm hide-sm" onClick={() => setConfirmReset(true)}>Reset</button>
      <span className="muted small hide-sm">{user.name}</span>
      <AllLabs user={user} />
      <button className="wl-btn sm" onClick={logout}>Sign out</button>
    </div>

    <div className="wl-main">
      {rail && <div className="wl-railback" onClick={() => setRail(null)} />}
      <aside className={`wl-rail${rail === 'left' ? ' open' : ''}`}>
        <div className="railclose"><b>Mission</b><button className="wl-btn sm" onClick={() => setRail(null)}>✕</button></div>
        <MissionRail status={status} act={act} />
      </aside>
      <section className="wl-center">
        <GuidanceBanner guidance={status.guidance} gotoTab={gotoTab} complete={status.complete} doStep={doStep} runCmd={runCmd} copyText={copyText} goUrl={goUrl} level={status.level} />
        <div className="wl-tabs">
          <button className="wl-tab railtoggle" onClick={() => setRail('left')} title="Objectives & hints">☰ Mission {objDone > 0 && <span className="count">{objDone}</span>}</button>
          {TABS.map(t => <button key={t.id} className={`wl-tab ${tab === t.id ? 'active' : ''}${pointTab === t.id && tab !== t.id ? ' point' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {pointTab === t.id && tab !== t.id && <span className="point-dot" aria-hidden="true" />}
            {t.id === 'proxy' && view.history.length > 0 && <span className="count">{view.history.length}</span>}
            {t.id === 'findings' && status.posture.confirmed > 0 && <span className="count">{status.posture.confirmed}</span>}
          </button>)}
          <button className="wl-tab railtoggle rt-right" onClick={() => setRail('right')} title="Evidence, findings & story">Activity {status.evidence.length > 0 && <span className="count">{status.evidence.length}</span>}</button>
        </div>
        <div className="wl-toolwrap">
          <div style={{ display: tab === 'browser' ? 'block' : 'none' }}><BrowserTool {...toolProps} /></div>
          <div style={{ display: tab === 'proxy' ? 'block' : 'none' }}><ProxyTool {...toolProps} /></div>
          <div style={{ display: tab === 'repeater' ? 'block' : 'none' }}><RepeaterTool {...toolProps} /></div>
          <div style={{ display: tab === 'terminal' ? 'block' : 'none', height: '100%' }}><TerminalTool {...toolProps} /></div>
          <div style={{ display: tab === 'findings' ? 'block' : 'none' }}><FindingsTool {...toolProps} /></div>
          <div style={{ display: tab === 'report' ? 'block' : 'none' }}><ReportTool {...toolProps} /></div>
        </div>
      </section>
      <aside className={`wl-rail right${rail === 'right' ? ' open' : ''}`}>
        <div className="railclose"><b>Activity</b><button className="wl-btn sm" onClick={() => setRail(null)}>✕</button></div>
        <ContextRail status={status} view={view} act={act} def={def} gotoTab={gotoTab} defaultGuideOpen={!guideSeen()} />
      </aside>
    </div>

    {showBrief && def && <Briefing def={def} acknowledged={status.acknowledged} onAck={() => { if (!status.acknowledged) act('engagement.acknowledge'); setShowBrief(false); }} />}
    {confirmReset && <div className="modal-back" onClick={() => setConfirmReset(false)}><div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
      <h2>Reset the engagement?</h2><p className="muted">This archives your current run (its report stays readable) and starts a fresh one from the beginning.</p>
      <div className="row"><button className="wl-btn primary" onClick={() => { reset(); setConfirmReset(false); }}>Reset</button><button className="wl-btn" onClick={() => setConfirmReset(false)}>Cancel</button></div>
    </div></div>}
  </div>;
}

const LEVEL_NAMES = ['Reconnaissance', 'Exploitation', 'Remediation', 'Reporting'];
const TOOL_LABEL: Record<string, string> = { browser: 'Browser', proxy: 'Proxy', repeater: 'Repeater', terminal: 'Terminal', findings: 'Findings', report: 'Report' };

function GuidanceBanner({ guidance, gotoTab, complete, doStep, runCmd, copyText, goUrl, level }: { guidance: any; gotoTab: (t: string) => void; complete: boolean; doStep: (s: any) => void; runCmd: (c: string) => void; copyText: (t: string) => void; goUrl: (u: string) => void; level: number }) {
  const [expanded, setExpanded] = useState(false);
  const [whyOpen, setWhyOpen] = useState(true);
  if (!guidance || guidance.mode === 'advanced') return null;

  if (guidance.mode === 'intermediate')
    return <div className="guidebar int"><span className="gb-tag">Guided · Intermediate</span><span className="gb-tip">{guidance.tip}</span><span className="gb-hint muted small">Need more? Reveal a hint under any objective (☰ Mission).</span></div>;

  // beginner
  const steps = guidance.steps as any[];
  const i = guidance.currentIndex;
  const levelLine = <div className="gb-level"><span className="gb-level-name">Level {level} · {LEVEL_NAMES[level - 1]}</span> — {guidance.levelWhy}</div>;
  if (i === -1 || complete)
    return <div className="guidebar done"><span className="gb-tag ok">Guided · Beginner</span><span className="gb-tip">🎉 All steps complete{complete ? ' — engagement delivered!' : ' for now. Great work!'}</span><button className="wl-btn sm" onClick={() => setExpanded(e => !e)}>{expanded ? 'Hide steps' : 'Review steps'}</button>{expanded && <StepList steps={steps} current={i} />}</div>;

  const step = steps[i];
  const p = step.prefill;
  const doLabel = p?.tool === 'repeater' ? `Load into Repeater →` : `Do it in the Browser →`;
  return <div className="guidebar">
    <div className="gb-head">
      <span className="gb-tag">Guided · Beginner</span>
      <span className="gb-step">Step {i + 1} of {guidance.total}</span>
      <span className="muted small hide-sm">in {TOOL_LABEL[step.tool] || step.tool}</span>
      <span className="grow" />
      <button className="wl-btn sm" onClick={() => setWhyOpen(w => !w)} title="Why are we doing this?">{whyOpen ? 'Hide why' : 'Why?'}</button>
      <button className="wl-btn sm" onClick={() => setExpanded(e => !e)}>{expanded ? 'Hide all' : 'All steps'}</button>
    </div>
    {whyOpen && levelLine}
    <div className="gb-current">
      <div className="gb-title">{step.title}</div>
      {whyOpen && step.why && <div className="gb-why">🎯 <b>Why this step:</b> {step.why}</div>}
      <div className="gb-detail">{step.detail}</div>

      {p?.tool === 'terminal' && <div className="gb-cmds">
        {p.commands.map((c: string, k: number) => <div key={k} className="gb-cmd">
          <code className="grow">{c}</code>
          <button className="wl-btn sm" onClick={() => copyText(c)}>Copy</button>
          {p.runnable !== false && <button className="wl-btn primary sm" onClick={() => runCmd(c)}>Run</button>}
        </div>)}
      </div>}

      {p?.urls && <div className="gb-urls"><span className="muted small" style={{ width: '100%' }}>Click each to visit it (every one is logged in the Proxy):</span>
        {p.urls.map((u: any, k: number) => <button key={k} className="wl-btn sm" onClick={() => goUrl(u.url)}>{u.label} →</button>)}
      </div>}

      {!p?.urls && <div className="row" style={{ marginTop: 8 }}>
        {p?.tool === 'terminal'
          ? <button className="wl-btn sm" onClick={() => gotoTab('terminal')}>Open Terminal →</button>
          : p ? <button className="wl-btn primary sm" onClick={() => doStep(step)}>{doLabel}</button>
            : <button className="wl-btn primary sm" onClick={() => gotoTab(step.tool)}>Go to {TOOL_LABEL[step.tool] || step.tool} →</button>}
        <span className="muted small">This step checks off automatically once done.</span>
      </div>}
    </div>
    {expanded && <StepList steps={steps} current={i} />}
  </div>;
}

function StepList({ steps, current }: { steps: any[]; current: number }) {
  return <ol className="gb-list">
    {steps.map((s, idx) => <li key={s.id} className={s.done ? 'done' : idx === current ? 'cur' : ''}>
      <span className="gb-tick">{s.done ? '✓' : idx === current ? '▸' : '○'}</span> {s.title}
    </li>)}
  </ol>;
}

function MissionRail({ status, act }: { status: any; act: ToolProps['act'] }) {
  const byLevel = useMemo(() => { const m: Record<number, any[]> = {}; for (const o of status.objectives) (m[o.level] ||= []).push(o); return m; }, [status.objectives]);
  return <div>
    <div className="railsec">
      <h4>Attack surface</h4>
      <div className="small">Routes seen: <b>{status.recon.routes}</b> · robots.txt {status.recon.robots ? '✓' : '—'} · API {status.recon.apiSeen ? '✓' : '—'} · admin {status.recon.adminSeen ? '✓' : '—'}</div>
      <div className="small muted" style={{ marginTop: 4 }}>Posture: {status.posture.confirmed} confirmed · {status.posture.verified} verified / {status.posture.total}</div>
      <div className="hintbox" style={{ marginTop: 8 }}>💡 Stuck on an objective below? Use its <b>Reveal hint</b> button for a staged nudge (−25% each). New here? Open the <b>Guide</b> in the Activity panel (right).</div>
    </div>
    {[1, 2, 3, 4].map(lvl => <div key={lvl} className="railsec">
      <div className="lvlhead">Level {lvl}: {LEVEL_NAMES[lvl - 1]} {lvl > status.level && <span className="lk">🔒</span>}</div>
      {(byLevel[lvl] || []).map(o => <Objective key={o.id} o={o} act={act} />)}
    </div>)}
  </div>;
}

function Objective({ o, act }: { o: any; act: ToolProps['act'] }) {
  return <div className={`obj ${o.done ? 'done' : ''} ${o.locked ? 'locked' : ''}`}>
    <div className="obh"><span className="tick" /><span className="ot">{o.title}</span><span className="pts">{o.awarded ?? 0}/{o.points}</span></div>
    {o.hints.map((h: string, i: number) => <div key={i} className="hintbox">💡 {h}</div>)}
    {!o.locked && !o.done && o.hintsRemaining > 0 && <button className="wl-btn sm" style={{ marginTop: 6 }} onClick={() => act('hint.request', { objectiveId: o.id })}>Reveal hint ({o.hintsRemaining} left · −25%)</button>}
  </div>;
}

function ContextRail({ status, view, act, def, gotoTab, defaultGuideOpen }: { status: any; view: any; act: ToolProps['act']; def: any; gotoTab: (t: string) => void; defaultGuideOpen: boolean }) {
  const [guideOpen, setGuideOpen] = useState(defaultGuideOpen);
  const toggleGuide = () => { const next = !guideOpen; setGuideOpen(next); if (next) { try { localStorage.setItem('tr_guide_seen', '1'); } catch {} } };
  useEffect(() => { if (defaultGuideOpen) { try { localStorage.setItem('tr_guide_seen', '1'); } catch {} } }, []);
  return <div>
    <div className="railsec">
      <h4 className="railsec-head"><span>📖 Guide</span><button className="wl-btn sm" onClick={toggleGuide}>{guideOpen ? 'Hide' : 'How this lab works'}</button></h4>
      {guideOpen ? <GuideBody def={def} gotoTab={gotoTab} /> : <div className="muted small">Workflow, every tool, a terminal cheat-sheet and good habits — with links that jump to the right tool.</div>}
    </div>
    <div className="railsec">
      <h4>Story &amp; activity</h4>
      {[...status.timeline].slice(-14).reverse().map((e: any, i: number) => <div key={i} className="timeline-ev"><span className={`k-${e.kind}`}>●</span><span className="small">{e.text}</span></div>)}
    </div>
    <div className="railsec">
      <h4>Evidence locker ({status.evidence.length})</h4>
      {status.evidence.length ? status.evidence.map((e: any) => <div key={e.id} className="small row" style={{ padding: '3px 0' }}><span className="code2 mono">{e.id}</span> <span className="mono">{e.method} {e.path.slice(0, 22)}</span> <span className="grow" /><span className="muted">{e.status}</span><button className="wl-btn sm" onClick={() => act('evidence.remove', { historyId: e.id })}>✕</button></div>) : <div className="muted small">Save requests from the Proxy, Browser or Repeater as evidence for your report.</div>}
    </div>
    <div className="railsec">
      <h4>Findings</h4>
      {status.findings.map((f: any) => <div key={f.id} className="small row" style={{ padding: '3px 0' }}><span>{f.title.length > 30 ? f.title.slice(0, 30) + '…' : f.title}</span><span className="grow" />{f.confirmed ? <StatusBadge status={f.status} /> : <span className="badge st-none">—</span>}</div>)}
    </div>
  </div>;
}

function GuideBody({ def, gotoTab }: { def: any; gotoTab: (t: string) => void }) {
  const host = def?.target?.host || 'shop.novacart.lab';
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
      <li>Open the <a onClick={() => jump('terminal')}>Terminal</a> and run <span className="code2 mono">whatweb {`http://${host}/`}</span>, then <span className="code2 mono">curl {`http://${host}/robots.txt`}</span> — <span className="code2 mono">Disallow</span> maps what they'd rather you not see.</li>
      <li>In the <a onClick={() => jump('browser')}>Browser</a>, visit pages (click the link chips). Every request is logged in the <a onClick={() => jump('proxy')}>Proxy</a>.</li>
      <li>Send anything interesting to <a onClick={() => jump('repeater')}>Repeater</a> and tamper with it. When your traffic proves a flaw it turns up as <b>Confirmed</b> in <a onClick={() => jump('findings')}>Findings</a>.</li>
      <li>Stuck? Each objective (left) has staged <b>💡 Reveal hint</b> buttons.</li>
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
      <li><b>Save evidence as you go</b> (★ Save to evidence) — your report cites it.</li>
      <li><b>Fix ≠ verified</b> — always Re-test after remediating.</li>
      <li>Progress saves automatically; <b>Reset</b> archives the run and starts fresh.</li>
    </ul>
  </div>;
}

function Briefing({ def, acknowledged, onAck }: { def: any; acknowledged: boolean; onAck: () => void }) {
  const b = def.briefing;
  return <div className="modal-back"><div className="modal">
    <div className="row"><span className="badge st-Confirmed">{b.engagement}</span><span className="badge sev-High">Authorized engagement</span></div>
    <h2 style={{ marginBottom: 2 }}>{def.title}</h2>
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
    <div className="row" style={{ marginTop: 16 }}><button className="wl-btn primary" onClick={onAck}>{acknowledged ? 'Close' : 'Acknowledge & enter the workspace'}</button></div>
  </div></div>;
}
