import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, BASE } from './api';
import { Shell, PlatformLoading, platformApps } from './shell';
import './app.css';

interface Technique { id: string; name: string }
interface Scenario { id: string; title: string; track: string; summary: string; brief?: string; architecture?: string[]; techniques: Technique[]; categories: string[]; levels: string[]; release: string; available: boolean }
interface Catalog { levels: { level: string; minutes: string; hints: string }[]; dimensions: { code: string; name: string }[]; scenarios: Scenario[] }

/**
 * Attack Reasoning Lab, served under /ar/. `/ar/` lists the scenarios; `/ar/scenarios/<id>` is one scenario's
 * dedicated page. Sign-in happens on onboard.threatready.io (401 → there and back).
 */
export function App() {
  const [user, setUser] = useState<any>(null); const [err, setErr] = useState('');
  const [path, setPath] = useState(location.pathname);
  // The session and the app list together (the list capped at 1.5 s), so the header never renders half-filled.
  const load = useCallback(() => { setErr(''); Promise.all([api('/me'), Promise.race([platformApps(), new Promise((r) => setTimeout(r, 1500))])]).then(([u]) => setUser(u), (e: ApiError) => { if (e.status !== 401 && e.code !== 'AUTH_ACCOUNT_REQUIRED') setErr(e.message); }); }, []);
  useEffect(() => { load(); const h = () => setPath(location.pathname); addEventListener('popstate', h); return () => removeEventListener('popstate', h); }, [load]);
  const go = (to: string) => { history.pushState(null, '', to); setPath(to); scrollTo(0, 0); };

  if (err) return <div className="tr-center"><div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={load}>Retry</button></div></div>;
  if (!user) return <PlatformLoading app="Attack Reasoning Lab" />;
  const m = new RegExp(`^${BASE}scenarios/([\\w-]{1,40})/?$`).exec(path);
  return <Shell current="reasoning" user={user}>{m ? <ScenarioPage id={m[1]!} back={() => go(BASE)} /> : <ScenarioList open={(id) => go(`${BASE}scenarios/${encodeURIComponent(id)}`)} />}</Shell>;
}

function Techniques({ list }: { list: Technique[] }) {
  return <div className="tr-chips">{list.map(t => <span key={t.id} className="tr-chip" title={t.name}>{t.id}</span>)}</div>;
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
        <h1 className="tr-h1">Think like a defender under pressure.</h1>
        <p className="tr-lead">A real architecture with an active attack chain. Five questions, each built from your previous answer, scored on the five published rubric dimensions.</p>
      </div>
      {data && <div className="tr-meta"><span><b className="tr-h3">{data.scenarios.length}</b>&nbsp;scenarios</span><span><b className="tr-h3">{live}</b>&nbsp;available now</span><span><b className="tr-h3">{data.levels.length}</b>&nbsp;levels</span></div>}
    </div></section>
    {data && live === 0 && <div className="tr-strip"><div className="tr-wrap"><b>Opening with release V1.0.</b> Browse the scenarios now; each one opens for practice when the reasoning engine launches. Your results will show on your ThreatReady profile.</div></div>}
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
        <h2 className="tr-section-title">How a session works</h2>
        <div className="ar-facts">
          <div className="tr-card"><span className="tr-eyebrow">Format</span><p>One architecture scenario, five adaptive questions. Each question is built from your previous answer.</p></div>
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
      <nav className="ar-crumbs" aria-label="Breadcrumb"><a href={BASE} onClick={e => { e.preventDefault(); back(); }}>All scenarios</a><span aria-hidden="true">/</span><span>{s?.title ?? id}</span></nav>
      {s && <div className="tr-page-head-in">
        <div>
          <span className="tr-eyebrow">{s.track} · <span className="tr-mono">{s.id}</span></span>
          <h1 className="tr-h1">{s.title}</h1>
          <p className="tr-lead">{s.summary}</p>
        </div>
        <div className="ar-start">
          {s.available ? <button type="button" className="tr-btn tr-btn-primary">Start scenario</button>
            : <><span className="tr-tag tr-tag-soon">Coming soon · {s.release}</span><button type="button" className="tr-btn tr-btn-primary" disabled aria-describedby="ar-start-note">Start scenario</button><span id="ar-start-note" className="tr-small tr-muted">Opens when the reasoning engine launches.</span></>}
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
            <p className="tr-small">Every level runs five adaptive questions.</p></section>
          <section className="tr-card"><h2 className="tr-h3">Question categories</h2><div className="tr-chips">{s.categories.map(c => <span key={c} className="tr-tag tr-tag-plain">{c}</span>)}</div></section>
          <section className="tr-card"><h2 className="tr-h3">Scored on</h2><ul className="ar-list">{data.dimensions.map(d => <li key={d.code}><span className="tr-mono">{d.code}</span> {d.name}</li>)}</ul>
            <a className="ar-link" href="https://threatready.io/rubric.html" target="_blank" rel="noopener noreferrer">Read the published rubric</a></section>
        </aside>
      </div>}
    </div>
  </>;
}
