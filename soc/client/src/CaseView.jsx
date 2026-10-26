import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUrl } from './api.js';
import { LiveFeed, SearchPanel, AlertPanel, EvidencePanel, HistoryPanel } from './components/Panels.jsx';
import ToolsPanel from './components/ToolsPanel.jsx';
import Workflow from './components/Workflow.jsx';
import ReportPanel from './components/ReportPanel.jsx';
import { Severity, duration, ErrorNote } from './components/bits.jsx';
import { bridge } from './tour/bridge.js';

const MAX_LIVE = 300;
const TIER_NAME = { L1: 'Tier 1', L2: 'Tier 2', L3: 'Tier 3' };

function StageRail({ cs, review, setReview }) {
  const groups = [];
  for (const s of cs.stages) {
    const g = groups[groups.length - 1];
    if (g && g.tier === s.tier) g.stages.push(s); else groups.push({ tier: s.tier, stages: [s] });
  }
  return (
    <nav className="rail" aria-label="Ticket stages" data-tour="rail">
      {groups.map((g, gi) => (
        <div className="rail-group" key={gi} style={{ flexGrow: g.stages.length }}>
          <span className="rail-tier">{TIER_NAME[g.tier]}</span>
          <ol>
            {g.stages.map((s) => {
              const current = cs.stage === s.id && cs.status !== 'closed';
              const cls = `rail-step is-${s.status}${current ? ' is-current' : ''}${review === s.id ? ' is-review' : ''}`;
              const inner = (
                <>
                  <span className="rail-mark" aria-hidden="true">{s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : ''}</span>
                  <span className="rail-label">{s.label}</span>
                  {s.score && <span className="rail-score">{s.score.pct}%</span>}
                  {s.result && <span className="rail-result">{s.result}</span>}
                </>
              );
              return (
                <li key={s.id} className={cls} aria-current={current ? 'step' : undefined} data-tour="rail-step" data-stage={s.id}>
                  {s.status === 'done' && s.review
                    ? <button type="button" onClick={() => setReview(review === s.id ? null : s.id)} title="Review what was submitted">{inner}</button>
                    : <span>{inner}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </nav>
  );
}

const LEVEL_NAME = { foundations: 'Foundations', intermediate: 'Intermediate', expert: 'Expert' };

export default function CaseView({ id, goHome, go }) {
  const [cs, setCs] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('feed');
  const [live, setLive] = useState([]);
  const [paused, setPausedState] = useState(false);
  const [held, setHeld] = useState(0);
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState({ q: '', source: '', nonce: 0 });
  const [prefill, setPrefill] = useState(null);
  const [review, setReview] = useState(null);
  const [now, setNow] = useState(Date.now());
  const pausedRef = useRef(false);
  const buffer = useRef([]);
  const seen = useRef(new Set());
  const alertSeen = useRef(null);
  const [flash, setFlash] = useState(null);

  const refresh = useCallback(() => api.getCase(id).then(setCs).catch((e) => { if (e.status === 404) setLoadErr(e); }), [id]);

  const push = useCallback((events) => {
    const fresh = events.filter((e) => !seen.current.has(e.id));
    fresh.forEach((e) => seen.current.add(e.id));
    if (!fresh.length) return;
    if (pausedRef.current) {
      buffer.current.push(...fresh);
      setHeld(buffer.current.length);
    } else {
      setLive((prev) => [...fresh.sort((a, b) => b.ts - a.ts), ...prev].slice(0, MAX_LIVE));
    }
  }, []);

  const setPaused = (p) => {
    pausedRef.current = p;
    setPausedState(p);
    if (!p && buffer.current.length) {
      const b = buffer.current;
      buffer.current = [];
      setHeld(0);
      setLive((prev) => [...b, ...prev].sort((x, y) => y.ts - x.ts).slice(0, MAX_LIVE));
    }
  };

  useEffect(() => {
    let dead = false;
    seen.current = new Set();
    api.getCase(id).then((c) => { if (!dead) { setCs(c); if (c.status === 'closed' && c.report) setTab('report'); } }).catch((e) => { if (!dead) setLoadErr(e); });
    api.logs(id, { limit: 120 }).then((r) => { if (!dead) push(r.events); }).catch(() => {});
    const es = new EventSource(apiUrl(`/api/cases/${id}/stream`));
    es.addEventListener('hello', () => setConnected(true));
    es.addEventListener('logs', (m) => push(JSON.parse(m.data)));
    es.addEventListener('case', () => refresh());
    es.addEventListener('closed', () => es.close());
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { dead = true; es.close(); clearInterval(t); };
  }, [id, push, refresh]);

  // Active time: report every 30 seconds whether the console is visible.
  const beating = !!cs?.attemptId && cs?.status !== 'closed';
  useEffect(() => {
    if (!beating) return undefined;
    const beat = () => api.heartbeat(id, document.visibilityState === 'visible').catch(() => {});
    beat();
    const t = setInterval(beat, 30000);
    const vis = () => beat();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [id, beating]);

  // Announce alerts as they arrive.
  useEffect(() => {
    if (!cs) return;
    const n = (cs.alert ? 1 : 0) + cs.relatedAlerts.length;
    if (alertSeen.current !== null && n > alertSeen.current) {
      const a = cs.relatedAlerts.length ? cs.relatedAlerts[cs.relatedAlerts.length - 1] : cs.alert;
      setFlash(`${cs.relatedAlerts.length ? 'Related alert linked to this ticket' : 'New alert'}: ${a.title}`);
    }
    alertSeen.current = n;
  }, [cs]);

  const act = useCallback(async (fn) => {
    try {
      const out = await fn();
      if (out?.id) setCs(out); else if (out?.case) setCs(out.case);
      setErr(null);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    }
  }, []);

  // Guided tours switch tabs and read the current search through this bridge.
  const tourRef = useRef({});
  tourRef.current = { tab, search, cs };
  useEffect(() => {
    const me = {
      id,
      tab: () => tourRef.current.tab,
      setTab: (k) => setTab(k),
      search: () => tourRef.current.search,
      cs: () => tourRef.current.cs,
      refresh,
    };
    bridge.view = me;
    bridge.emit('view');
    return () => { if (bridge.view === me) { bridge.view = null; bridge.emit('view'); } };
  }, [id, refresh]);
  useEffect(() => { bridge.emit('case'); }, [cs?.rev, cs?.status, cs?.stage, tab]);

  const pinned = useMemo(() => new Set((cs?.pins || []).map((p) => p.eventId)), [cs]);
  const fmtVal = (v) => {
    let s = String(v).replace(/"/g, '*');
    if (s.length > 120) s = `${s.slice(0, 120)}*`;
    return /[\s()]/.test(s) ? `"${s}"` : s;
  };
  const ctx = useMemo(() => ({
    pinned,
    canPin: cs?.status === 'open' && !cs?.readOnly,
    onPin: (ev, isPinned) => act(() => (isPinned ? api.unpin(id, ev.id) : api.pin(id, ev.id))),
    onFilter: (k, v, neg) => {
      setSearch((s) => ({ ...s, q: `${s.q} ${neg ? '-' : ''}${k}:${fmtVal(v)}`.trim(), nonce: s.nonce + 1 }));
      setTab('search');
    },
    onSearch: (q) => { setSearch({ q, source: '', nonce: Date.now() }); setTab('search'); },
    onContext: (ev) => {
      setSearch({ q: `host:${ev.host}`, source: '', from: ev.ts - 120000, to: ev.ts + 120000, nonce: Date.now() });
      setTab('search');
    },
    onLookup: (tool, input) => { setPrefill({ tool, input, nonce: Date.now() }); setTab('tools'); },
    onIoc: cs?.status === 'open' && !cs?.readOnly ? (value) => act(() => api.addIoc(id, value)) : null,
    goTab: setTab,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [pinned, cs?.status, cs?.readOnly, id]);

  if (loadErr) {
    return <div className="page"><ErrorNote error={loadErr} /><p><button type="button" className="btn" onClick={goHome}>Back to SOC home</button></p></div>;
  }
  if (!cs) return <div className="page"><p className="muted">Loading case…</p></div>;

  const closed = cs.status === 'closed';
  const tabs = [
    ['feed', 'Live feed'], ['search', 'Log search'], ['alert', `Alert${cs.alert ? ` ${1 + cs.relatedAlerts.length}` : ''}`], ['tools', 'Tools'],
    ['evidence', `Evidence ${cs.pins.length}`], ['history', `Case history ${cs.history.length}`],
    ...(closed ? [['report', 'After-action review']] : []),
  ];
  const elapsed = cs.alert ? Math.round(((cs.closedAt || now) - cs.alert.firedAt) / 1000) : null;

  return (
    <div className="case">
      <header className="topbar" data-tour="topbar">
        {cs.level
          ? <button type="button" className="link back" onClick={() => go(`#/level/${cs.level}`)}>Back to level</button>
          : <button type="button" className="link back" onClick={goHome}>{cs.kind ? 'Home' : 'SOC home'}</button>}
        <div className="top-id" data-tour="ticket">
          <span className="ticket mono">
            {cs.status === 'monitoring' ? 'No ticket yet' : cs.ticket}
            {cs.kind === 'demo' && <span className="kind-tag">Guided demo</span>}
            {cs.kind === 'preview' && <span className="kind-tag">Read-only sample</span>}
            {cs.level && <span className="kind-tag level-tag">{LEVEL_NAME[cs.level]} · {cs.code}</span>}
          </span>
          <h1>{cs.status === 'monitoring' ? 'Monitoring the alert queue' : cs.title}</h1>
        </div>
        <dl className="top-facts" data-tour="top-facts">
          {cs.severity && <div><dt>Severity</dt><dd><Severity level={cs.severity} /></dd></div>}
          <div><dt>Status</dt><dd>{closed ? 'Closed' : cs.status === 'monitoring' ? 'Monitoring' : `Open, ${TIER_NAME[cs.tier]}`}</dd></div>
          {elapsed != null && <div><dt>{closed ? 'Time to close' : 'Since alert'}</dt><dd className="mono">{duration(Math.max(0, elapsed))}</dd></div>}
          <div><dt>Analyst</dt><dd>{cs.analyst}</dd></div>
        </dl>
      </header>
      <StageRail cs={cs} review={review} setReview={setReview} />
      {flash && (
        <div className="flash" role="status">
          <span>{flash}</span>
          <button type="button" className="link" onClick={() => { setTab('alert'); setFlash(null); }}>View alert</button>
          <button type="button" className="link" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}
      {err && <div className="flash flash-bad"><ErrorNote error={err} onDismiss={() => setErr(null)} /></div>}
      <div className="split">
        <main className="main" data-tour="main">
          <div className="tabs" role="tablist" data-tour="tabs">
            {tabs.map(([k, l]) => <button type="button" role="tab" key={k} data-tour={`tab-${k}`} aria-selected={tab === k} className={`tab${tab === k ? ' is-on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'feed' && <LiveFeed live={live} paused={paused} setPaused={setPaused} held={held} ctx={ctx} sources={cs.sources} connected={connected} closed={closed} />}
          <div hidden={tab !== 'search'} className="tab-keep"><SearchPanel caseId={id} search={search} setSearch={setSearch} ctx={ctx} sources={cs.sources} /></div>
          {tab === 'alert' && <AlertPanel cs={cs} ctx={ctx} />}
          <div hidden={tab !== 'tools'} className="tab-keep"><ToolsPanel cs={cs} ctx={ctx} prefill={prefill} onCase={setCs} /></div>
          {tab === 'evidence' && <EvidencePanel cs={cs} ctx={ctx} act={act} />}
          {tab === 'history' && <HistoryPanel cs={cs} act={act} />}
          {tab === 'report' && closed && <ReportPanel cs={cs} go={go} />}
        </main>
        <Workflow cs={cs} onCase={(c) => { if (cs.status === 'monitoring' && c.status === 'open') { setTab('alert'); setFlash(null); } setCs(c); if (c.status === 'closed') setTab('report'); }} review={review} setReview={setReview} ctx={ctx} />
      </div>
    </div>
  );
}
