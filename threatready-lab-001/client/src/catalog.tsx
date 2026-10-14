import { useEffect, useState } from 'react';
import { api } from './api';
import { Shell } from './shell';

interface Progress { runs: number; status: string; level: number; percent: number; score: number; max: number; complete: boolean; updatedAt: string }
interface Entry { id: string; title: string; subtitle: string; track: string; difficulty: string; minutes: number; release: string; available: boolean; progress: Progress | null }

const ago = (iso: string) => { const d = (Date.now() - new Date(iso).getTime()) / 86_400_000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`; };
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;

/** labs.threatready.io: every ThreatReady lab, with this learner's progress in each. */
export function Catalog({ user, open }: { user: any; open: (id: string) => void }) {
  const [labs, setLabs] = useState<Entry[] | null>(null); const [err, setErr] = useState('');
  const load = () => { setErr(''); api('/labs').then((r) => (Array.isArray(r) ? setLabs(r) : setErr('Unexpected response from the server. Retry in a moment.')), (e: any) => { if (e.status !== 401) setErr(e.message); }); };
  useEffect(load, []);
  const live = labs?.filter(l => l.available) ?? []; const soon = labs?.filter(l => !l.available) ?? [];
  const inProgress = live.filter(l => l.progress && !l.progress.complete).length;
  const completed = live.filter(l => l.progress?.complete).length;

  const card = (l: Entry) => {
    const p = l.progress;
    const action = !p ? 'Start lab' : p.complete ? 'Review lab' : 'Continue lab';
    return <li key={l.id} className={`tr-card ${l.available ? '' : 'is-soon'}`}>
      <div className="tr-card-top">
        <span className="tr-eyebrow" style={{ margin: 0 }}><span className="tr-dot tr-dot-labs" aria-hidden="true" style={{ marginRight: 8 }} />{l.track}</span>
        {l.available ? (p?.complete ? <span className="tr-tag tr-tag-live">Completed</span> : p ? <span className="tr-tag tr-tag-accent">In progress</span> : <span className="tr-tag tr-tag-live">Live</span>) : <span className="tr-tag tr-tag-soon">{l.release}</span>}
      </div>
      <h3 className="tr-h3">{l.title}</h3>
      <p>{l.subtitle}</p>
      <div className="tr-meta"><span className="tr-mono">{l.id}</span><span>{l.difficulty}</span><span>About {hours(l.minutes)}</span>{p && <span>{p.runs} run{p.runs === 1 ? '' : 's'}</span>}</div>
      {p && <div className="tr-progress">
        <div className="tr-progress-row"><b>{p.complete ? 'Completed' : `Level ${p.level}`}</b><span>{p.percent}% of objectives</span></div>
        <div className="tr-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent} aria-label={`${l.title} progress`}><i style={{ width: `${p.percent}%` }} /></div>
        <span className="tr-small tr-muted">{p.score} of {p.max} points · last active {ago(p.updatedAt)}</span>
      </div>}
      <div className="tr-card-foot">
        {l.available
          ? <button type="button" className="tr-btn tr-btn-primary tr-btn-sm" onClick={() => open(l.id)}>{action}</button>
          : <span className="tr-small tr-muted">Planned for {l.release}</span>}
      </div>
    </li>;
  };

  return <Shell current="labs" user={user}>
    <div className="tr-strip"><div className="tr-wrap"><b>Simulation environment.</b> Every lab runs on simulated systems. Nothing touches a real account or network.</div></div>
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in">
      <div>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-labs" aria-hidden="true" style={{ marginRight: 8 }} />Lab Simulations</span>
        <h1 className="tr-h1">Work the incident, not the quiz.</h1>
        <p className="tr-lead">Hands-on investigations in simulated environments. Each lab keeps its own runs, objectives and incident report; your overall progress also shows on your ThreatReady profile.</p>
      </div>
      {labs && <div className="tr-meta" aria-label="Your labs"><span><b className="tr-h3">{live.length}</b>&nbsp;available</span><span><b className="tr-h3">{inProgress}</b>&nbsp;in progress</span><span><b className="tr-h3">{completed}</b>&nbsp;completed</span></div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err && <div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={load}>Retry</button></div>}
      {!labs && !err && <div className="tr-note"><span className="tr-spinner" aria-hidden="true" />Loading labs…</div>}
      {live.length > 0 && <><h2 className="tr-section-title">Available now</h2><ul className="tr-grid">{live.map(card)}</ul></>}
      {soon.length > 0 && <><h2 className="tr-section-title">Coming soon</h2><ul className="tr-grid">{soon.map(card)}</ul></>}
    </div>
  </Shell>;
}
