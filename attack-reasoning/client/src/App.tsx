import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, BASE } from './api';
import { Shell, PlatformLoading, platformApps } from './shell';
import { AttemptPage, DomainPage, DomainsPage, HistoryPage, SummaryPage } from './reasoning/pages';
import './app.css';

interface Technique { id: string; name: string }
interface Scenario { id: string; title: string; track: string; summary: string; brief?: string; architecture?: string[]; techniques: Technique[]; categories: string[]; levels: string[]; release: string; available: boolean }
interface Catalog { levels: { level: string; minutes: string; hints: string }[]; dimensions: { code: string; name: string }[]; scenarios: Scenario[] }

/**
 * Attack Reasoning Lab, served under /ar/. `/ar/` lists the domains; `/ar/domains/<key>` is a domain's entry
 * point, `/ar/attempts/<id>` one assessment (scenario, diagram, decision, reasoning, result), `/ar/history`
 * the learner's attempts and analytics. `/ar/scenarios/<id>` keeps the hand-authored scenario briefs.
 * Sign-in happens on onboard.threatready.io (401 → there and back).
 */
export function App() {
  const [user, setUser] = useState<any>(null); const [err, setErr] = useState('');
  const [path, setPath] = useState(location.pathname);
  // The session and the app list together (the list capped at 1.5 s), so the header never renders half-filled.
  const load = useCallback(() => { setErr(''); Promise.all([api('/me'), Promise.race([platformApps(), new Promise((r) => setTimeout(r, 1500))])]).then(([u]) => setUser(u), (e: ApiError) => { if (e.status !== 401 && e.code !== 'AUTH_ACCOUNT_REQUIRED') setErr(e.message); }); }, []);
  useEffect(() => { load(); const h = () => setPath(location.pathname); addEventListener('popstate', h); return () => removeEventListener('popstate', h); }, [load]);
  const go = (to: string) => { history.pushState(null, '', to); setPath(new URL(to, location.href).pathname); scrollTo(0, 0); };

  if (err) return <div className="tr-center"><div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={load}>Retry</button></div></div>;
  if (!user) return <PlatformLoading app="Attack Reasoning Lab" />;
  const route = (re: string) => new RegExp(`^${BASE}${re}/?$`).exec(path);
  const scenario = route('scenarios/([\\w-]{1,40})');
  const domain = route('domains/([a-z0-9-]{1,40})');
  const attempt = route('attempts/([0-9a-f-]{36})');
  const historyRoute = route('history');
  const summaryRoute = route('summary');
  const legacy = route('scenarios');
  return <Shell current="reasoning" user={user}>
    {scenario ? <ScenarioPage id={scenario[1]!} back={() => go(`${BASE}scenarios`)} />
      : legacy ? <ScenarioList open={(id) => go(`${BASE}scenarios/${encodeURIComponent(id)}`)} />
      : domain ? <DomainPage slug={domain[1]!} go={go} />
      : attempt ? <AttemptPage key={attempt[1]!} id={attempt[1]!} go={go} />
      : historyRoute ? <HistoryPage go={go} />
      : summaryRoute ? <SummaryPage go={go} />
      : <DomainsPage go={go} />}
  </Shell>;
}

function Techniques({ list }: { list: Technique[] }) {
  return <ul className="tr-chips ar-chip-list" aria-label="Techniques">{list.map(t => <li key={t.id} className="tr-chip">{t.id} · {t.name}</li>)}</ul>;
}

function ScenarioList({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<Catalog | null>(null); const [err, setErr] = useState(''); const [track, setTrack] = useState('All');
  useEffect(() => { api<Catalog>('/scenarios').then((d) => (Array.isArray(d?.scenarios) ? setData(d) : setErr('Unexpected response from the server. Retry in a moment.')), (e: ApiError) => { if (e.status !== 401) setErr(e.message); }); }, []);
  const tracks = data ? ['All', ...new Set(data.scenarios.map(s => s.track))] : [];
  const shown = data?.scenarios.filter(s => track === 'All' || s.track === track) ?? [];
  const live = data?.scenarios.filter(s => s.available).length ?? 0;

  return <>
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in">
      <div>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-reasoning" aria-hidden="true" style={{ marginRight: 8 }} />Attack Reasoning Lab</span>
        <h1 className="tr-h1">Scenario briefs</h1>
        <p className="tr-lead">Hand-authored scenarios planned for a later release: one architecture with an active attack chain and a series of questions. Live today are the AI-generated assessments: one generated scenario and one decision at a time.</p>
      </div>
      {data && <div className="tr-meta"><span><b className="tr-h3">{data.scenarios.length}</b>&nbsp;scenarios</span><span><b className="tr-h3">{live}</b>&nbsp;available now</span><span><b className="tr-h3">{data.levels.length}</b>&nbsp;levels</span></div>}
    </div></section>
    {data && live === 0 && <div className="tr-strip"><div className="tr-wrap"><b>Hand-authored scenario briefs.</b> These multi-question scenarios open in a later release. AI-generated assessments are live now: <a className="ar-link" href={BASE} onClick={e => { e.preventDefault(); history.pushState(null, '', BASE); dispatchEvent(new PopStateEvent('popstate')); }}>choose a domain</a>.</div></div>}
    <div className="tr-wrap tr-section">
      {err && <div className="tr-note tr-note-bad" role="alert">{err}</div>}
      {!data && !err && <div className="tr-note"><span className="tr-spinner" aria-hidden="true" />Loading scenarios…</div>}
      {data && <>
        <div className="ar-filters tr-scroll-row" role="group" aria-label="Filter by track">
          {tracks.map(t => <button key={t} type="button" className="ar-filter" aria-pressed={track === t} onClick={() => setTrack(t)}>{t}</button>)}
        </div>
        <p className="tr-small tr-muted ar-count" aria-live="polite">{track === 'All' ? `${shown.length} scenarios` : `${shown.length} in ${track}`}</p>
        <ul className="tr-grid">{shown.map(s => <li key={s.id} className={`tr-card ar-card ${s.available ? '' : 'is-soon'}`}>
          <div className="tr-card-top">
            <span className="tr-eyebrow" style={{ margin: 0 }}>{s.track}</span>
            {s.available ? <span className="tr-tag tr-tag-live">Live</span> : <span className="tr-tag tr-tag-soon">Coming soon</span>}
          </div>
          <h3 className="tr-h3"><a className="ar-card-link" href={`${BASE}scenarios/${s.id}`} onClick={e => { e.preventDefault(); open(s.id); }}>{s.title}</a></h3>
          <p>{s.summary}</p>
          <Techniques list={s.techniques} />
          <div className="tr-card-foot">
            <span className="tr-mono">{s.id} · {s.categories.join(' · ')}</span>
            <span className="ar-more" aria-hidden="true">View scenario →</span>
          </div>
        </li>)}</ul>
        <h2 className="tr-section-title">How these scenarios will work (planned)</h2>
        <div className="ar-facts">
          <div className="tr-card"><span className="tr-eyebrow">Format</span><p>Planned: one architecture scenario and a series of adaptive questions, each built from your previous answer. Until then, the live assessments ask one question per generated scenario.</p></div>
          <div className="tr-card"><span className="tr-eyebrow">Levels</span><p>{data.levels.map(l => `${l.level} (${l.minutes})`).join(' · ')}. Less help, more depth at each level.</p></div>
          <div className="tr-card"><span className="tr-eyebrow">Scoring</span><p>{data.dimensions.map(d => d.name).join(', ')}. Every score band is published in the rubric.</p></div>
        </div>
      </>}
    </div>
  </>;
}

function ScenarioPage({ id, back }: { id: string; back: () => void }) {
  const [data, setData] = useState<{ scenario: Scenario; levels: Catalog['levels']; dimensions: Catalog['dimensions'] } | null>(null); const [err, setErr] = useState('');
  useEffect(() => { api(`/scenarios/${encodeURIComponent(id)}`).then(setData, (e: ApiError) => { if (e.status !== 401) setErr(e.status === 404 ? 'That scenario does not exist.' : e.message); }); }, [id]);
  const s = data?.scenario;
  return <>
    <section className="tr-page-head"><div className="tr-wrap">
      <nav className="ar-crumbs" aria-label="Breadcrumb"><a href={BASE} onClick={e => { e.preventDefault(); history.pushState(null, '', BASE); dispatchEvent(new PopStateEvent('popstate')); }}>All domains</a><span aria-hidden="true">/</span><a href={`${BASE}scenarios`} onClick={e => { e.preventDefault(); back(); }}>Scenario briefs</a><span aria-hidden="true">/</span><span>{s?.title ?? id}</span></nav>
      {s && <div className="tr-page-head-in">
        <div>
          <span className="tr-eyebrow">{s.track} · <span className="tr-mono">{s.id}</span></span>
          <h1 className="tr-h1">{s.title}</h1>
          <p className="tr-lead">{s.summary}</p>
        </div>
        <div className="ar-start">
          <span className="tr-tag tr-tag-soon">{s.available ? 'Planned' : `Coming soon · ${s.release}`}</span>
          <span className="tr-small tr-muted">This brief cannot be started yet. AI-generated assessments in this area are live now.</span>
          <a className="tr-btn tr-btn-primary" href={BASE} onClick={e => { e.preventDefault(); history.pushState(null, '', BASE); dispatchEvent(new PopStateEvent('popstate')); }}>Choose a domain</a>
        </div>
      </div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err && <div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={back}>All scenarios</button></div>}
      {!data && !err && <div className="tr-note"><span className="tr-spinner" aria-hidden="true" />Loading scenario…</div>}
      {s && data && <div className="ar-detail">
        <div className="ar-main">
          <section className="tr-card"><h2 className="tr-h3">The situation</h2><p>{s.brief}</p></section>
          <section className="tr-card"><h2 className="tr-h3">The environment</h2><ul className="ar-list">{s.architecture?.map(a => <li key={a}>{a}</li>)}</ul></section>
          <section className="tr-card"><h2 className="tr-h3">MITRE ATT&amp;CK techniques in play</h2>
            <table className="ar-table"><tbody>{s.techniques.map(t => <tr key={t.id}><td><span className="tr-chip">{t.id}</span></td><td>{t.name}</td></tr>)}</tbody></table></section>
        </div>
        <aside className="ar-side">
          <section className="tr-card"><h2 className="tr-h3">Levels</h2>
            <table className="ar-table"><thead><tr><th>Level</th><th>Time</th><th>Hints</th></tr></thead><tbody>{data.levels.map(l => <tr key={l.level}><td>{l.level}</td><td>{l.minutes}</td><td>{l.hints}</td></tr>)}</tbody></table>
            <p className="tr-small">Planned: every level runs a series of adaptive questions.</p></section>
          <section className="tr-card"><h2 className="tr-h3">Question categories</h2><div className="tr-chips">{s.categories.map(c => <span key={c} className="tr-tag tr-tag-plain">{c}</span>)}</div></section>
          <section className="tr-card"><h2 className="tr-h3">Scored on</h2><ul className="ar-list">{data.dimensions.map(d => <li key={d.code}><span className="tr-mono">{d.code}</span> {d.name}</li>)}</ul>
            <a className="ar-link" href="https://threatready.io/rubric.html" target="_blank" rel="noopener noreferrer">Read the published rubric</a></section>
        </aside>
      </div>}
    </div>
  </>;
}
