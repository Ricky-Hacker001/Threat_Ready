import { useEffect, useState } from 'react';
import { api, BASE } from './api';
import { Shell } from './shell';

interface Progress { runs: number; status: string; level: number; percent: number; score: number; max: number; complete: boolean; updatedAt: string }
type TrackKey = 'cloud' | 'blue' | 'red' | 'network';
/**
 * `progressIn`: where the lab keeps progress. "account": ThreatReady's servers, kept across restarts
 * (saved with the platform account); "server": ThreatReady's lab server, with no promise beyond that;
 * "browser": the learner's browser. `onProfile`: the profile shows it.
 */
export interface Entry { id: string; title: string; subtitle: string; track: TrackKey; difficulty: string; minutes?: number; scope?: string; release: string; href?: string; home?: boolean; available: boolean; progress: Progress | null; progressIn?: 'account' | 'server' | 'browser'; onProfile?: boolean }

/** The four tracks, in catalog order. `slug` is the URL: /labs/tracks/<slug>. */
export const TRACKS: { key: TrackKey; slug: string; title: string; blurb: string; icon: string }[] = [
  { key: 'cloud', slug: 'cloud-security', title: 'Cloud Security', blurb: 'Secure cloud accounts and the pipelines that deploy to them: an AWS incident-response lab and a DevSecOps pipeline lab.', icon: 'M7 18a5 5 0 01-.6-9.96A6 6 0 0118 9a4.5 4.5 0 01-.5 9z' },
  { key: 'blue', slug: 'blue-team', title: 'Blue Team', blurb: 'Detect, triage and respond: monitor a SOC queue, investigate alerts and close incidents with evidence.', icon: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z' },
  { key: 'red', slug: 'red-team', title: 'Red Team', blurb: 'Think like an attacker: test applications and infrastructure, then write up what you found.', icon: 'M12 21a9 9 0 110-18 9 9 0 010 18zM12 16a4 4 0 110-8 4 4 0 010 8zM12 12h.01' },
  { key: 'network', slug: 'network-security', title: 'Network Security', blurb: 'Build and defend networks: firewall administration, segmentation, VPNs and traffic analysis.', icon: 'M5 4h4v4H5zM15 4h4v4h-4zM10 16h4v4h-4zM7 8v3h10V8M12 11v5' },
];
export const trackBySlug = (slug: string) => TRACKS.find((t) => t.slug === slug);

const ago = (iso: string) => { const d = (Date.now() - new Date(iso).getTime()) / 86_400_000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`; };
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;
const TrackIcon = ({ d }: { d: string }) => <svg className="tr-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;

function useLabs() {
  const [labs, setLabs] = useState<Entry[] | null>(null); const [err, setErr] = useState('');
  const load = () => { setErr(''); api('/labs').then((r) => (Array.isArray(r) ? setLabs(r) : setErr('Unexpected response from the server. Retry in a moment.')), (e: any) => { if (e.status !== 401) setErr(e.message); }); };
  useEffect(load, []);
  return { labs, err, load };
}

/** Where this lab keeps progress, in the card's footer. */
const keptIn = (l: Entry) => (l.progressIn === 'account' ? 'Saved to your ThreatReady account' : l.progressIn === 'server' ? 'Progress is kept on the ThreatReady lab server' : 'Progress is kept in this browser');

function LabCard({ l, open }: { l: Entry; open: (id: string) => void }) {
  const p = l.progress;
  const action = l.href ? 'Open lab' : !p ? 'Start lab' : p.complete ? 'Review lab' : 'Continue lab';
  return <li className={`tr-card ${l.available ? '' : 'is-soon'}`}>
    <div className="tr-card-top">
      <span className="tr-mono tr-small tr-muted">{l.id}</span>
      {l.available ? (p?.complete ? <span className="tr-tag tr-tag-live">Completed</span> : p ? <span className="tr-tag tr-tag-accent">In progress</span> : <span className="tr-tag tr-tag-live">Live</span>) : <span className="tr-tag tr-tag-soon">{l.release}</span>}
    </div>
    <h3 className="tr-h3">{l.title}</h3>
    <p>{l.subtitle}</p>
    <div className="tr-meta"><span>{l.difficulty}</span>{l.scope && <span>{l.scope}</span>}{l.minutes && <span>About {hours(l.minutes)}</span>}{p && <span>{p.runs} run{p.runs === 1 ? '' : 's'}</span>}</div>
    {p && <div className="tr-progress">
      <div className="tr-progress-row"><b>{p.complete ? 'Completed' : `Level ${p.level}`}</b><span>{p.percent}% of objectives</span></div>
      <div className="tr-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent} aria-label={`${l.title} progress`}><i style={{ width: `${p.percent}%` }} /></div>
      <span className="tr-small tr-muted">{p.score} of {p.max} points · last active {ago(p.updatedAt)}</span>
    </div>}
    <div className="tr-card-foot">
      {!l.available ? <span className="tr-small tr-muted">Planned for {l.release}</span>
        : l.href ? <><span className="tr-small tr-muted">{keptIn(l)}</span><a className="tr-btn tr-btn-primary tr-btn-sm" href={`${BASE}${l.href}`}>{action}</a></>
        : <><span className="tr-small tr-muted">{keptIn(l)}</span><button type="button" className="tr-btn tr-btn-primary tr-btn-sm" onClick={() => open(l.id)}>{action}</button></>}
    </div>
  </li>;
}

const Strip = () => <div className="tr-strip"><div className="tr-wrap"><b>Simulation environment.</b> Every lab runs on simulated systems. Nothing touches a real account or network.</div></div>;
const Status = ({ err, labs, load }: { err: string; labs: Entry[] | null; load: () => void }) => <>
  {err && <div className="tr-note tr-note-bad" role="alert">{err} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={load}>Retry</button></div>}
  {!labs && !err && <div className="tr-note" role="status"><span className="tr-spinner" aria-hidden="true" />Loading labs…</div>}
</>;

/** /labs/: the four tracks, each with its labs and this learner's progress. */
export function Catalog({ user, go, open }: { user: any; go: (to: string) => void; open: (id: string) => void }) {
  const { labs, err, load } = useLabs();
  const live = labs?.filter(l => l.available) ?? [];
  const inProgress = live.filter(l => l.progress && !l.progress.complete).length;
  const completed = live.filter(l => l.progress?.complete).length;
  return <Shell current="labs" user={user}>
    <Strip />
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in">
      <div>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-labs" aria-hidden="true" style={{ marginRight: 8 }} />Lab Simulations</span>
        <h1 className="tr-h1">Work the incident, not the quiz.</h1>
        <p className="tr-lead">Hands-on labs in simulated environments, grouped by track. Each lab keeps its own runs, objectives and reports, and its card says where your progress is kept. Progress kept by ThreatReady (not in your browser) also shows on your profile.</p>
      </div>
      {labs && <div className="tr-meta" aria-label="Your labs"><span><b className="tr-h3">{live.length}</b>&nbsp;available</span><span><b className="tr-h3">{inProgress}</b>&nbsp;in progress</span><span><b className="tr-h3">{completed}</b>&nbsp;completed</span></div>}
    </div></section>
    <div className="tr-wrap tr-section">
      <Status err={err} labs={labs} load={load} />
      {labs && labs.some(l => l.home) && <><h2 className="tr-section-title">Featured labs</h2><ul className="tr-grid">{labs.filter(l => l.home).map(l => <LabCard key={l.id} l={l} open={open} />)}</ul></>}
      {labs && <><h2 className="tr-section-title">Choose a track</h2><TrackGrid labs={labs} go={go} /></>}
    </div>
  </Shell>;
}

/** The four track cards. Labs shown in "Featured labs" belong to a track too and are counted and listed there as well. */
export function TrackGrid({ labs, go }: { labs: Entry[]; go: (to: string) => void }) {
  return <ul className="tr-grid lab-tracks">
    {TRACKS.map((t) => {
      const mine = labs.filter(l => l.track === t.key); const n = mine.filter(l => l.available).length; const soon = mine.length - n;
      const href = `${BASE}tracks/${t.slug}`;
      return <li key={t.key} className="tr-card lab-track">
        <div className="tr-card-top"><span className="lab-track-icon"><TrackIcon d={t.icon} /></span>{n ? <span className="tr-tag tr-tag-live">{n} live</span> : <span className="tr-tag tr-tag-soon">Coming soon</span>}</div>
        <h3 className="tr-h3"><a className="lab-card-link" href={href} onClick={(e) => { e.preventDefault(); go(href); }}>{t.title}</a></h3>
        <p>{t.blurb}</p>
        <ul className="lab-track-list">{mine.length ? mine.map(l => <li key={l.id}><span>{l.title}</span>{!l.available && <span className="tr-small tr-muted">{l.release}</span>}</li>) : <li className="tr-muted">Labs for this track are being prepared.</li>}</ul>
        <div className="tr-card-foot"><span className="tr-small tr-muted">{n} available{soon ? ` · ${soon} coming soon` : ''}</span><span className="tr-small lab-track-go" aria-hidden="true">View labs →</span></div>
      </li>;
    })}
  </ul>;
}

/** An address under /labs/ that matches nothing (an old bookmark, a mistyped track): say so, with the way back. */
export function NotFoundPage({ user, go, what }: { user: any; go: (to: string) => void; what: 'track' | 'lab' | 'page' }) {
  useEffect(() => { document.title = 'Not found · Lab Simulations · ThreatReady'; return () => { document.title = 'Lab Simulations · ThreatReady'; }; }, []);
  return <Shell current="labs" user={user}>
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in"><div>
      <nav className="lab-crumbs" aria-label="Breadcrumb"><a href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>All tracks</a><span aria-hidden="true">/</span><span aria-current="page">Not found</span></nav>
      <span className="tr-eyebrow"><span className="tr-dot tr-dot-labs" aria-hidden="true" style={{ marginRight: 8 }} />Lab Simulations</span>
      <h1 className="tr-h1">{what === 'track' ? 'That track does not exist' : what === 'lab' ? 'That lab does not exist' : 'That page does not exist'}</h1>
      <p className="tr-lead">The link may be out of date or mistyped. The tracks are Cloud Security, Blue Team, Red Team and Network Security.</p>
    </div></div></section>
    <div className="tr-wrap tr-section"><div className="lab-notfound">
      <a className="tr-btn tr-btn-primary" href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>See all tracks and labs</a>
      {TRACKS.map(t => <a key={t.key} className="tr-btn tr-btn-secondary" href={`${BASE}tracks/${t.slug}`} onClick={(e) => { e.preventDefault(); go(`${BASE}tracks/${t.slug}`); }}>{t.title}</a>)}
    </div></div>
  </Shell>;
}

/** /labs/tracks/<slug>: every lab in one track. */
export function TrackPage({ user, slug, go, open }: { user: any; slug: string; go: (to: string) => void; open: (id: string) => void }) {
  const { labs, err, load } = useLabs();
  const t = trackBySlug(slug)!;
  useEffect(() => { document.title = `${t.title} · Lab Simulations · ThreatReady`; return () => { document.title = 'Lab Simulations · ThreatReady'; }; }, [t.title]);
  return <Shell current="labs" user={user}>
    <Strip />
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in">
      <div>
        <nav className="lab-crumbs" aria-label="Breadcrumb"><a href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>All tracks</a><span aria-hidden="true">/</span><span aria-current="page">{t.title}</span></nav>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-labs" aria-hidden="true" style={{ marginRight: 8 }} />Lab Simulations<span aria-hidden="true" className="lab-eyebrow-sep">/</span><span className="lab-track-icon lab-track-icon-sm"><TrackIcon d={t.icon} /></span>{t.title}</span>
        <h1 className="tr-h1">{t.title} labs</h1>
        <p className="tr-lead">{t.blurb}</p>
      </div>
    </div></section>
    <div className="tr-wrap tr-section">
      <Status err={err} labs={labs} load={load} />
      {labs && <TrackLabs labs={labs} track={t.key} open={open} />}
    </div>
  </Shell>;
}

/** Every lab of one track, featured ones included (SOC Simulation is on the main Labs page and in Blue Team). */
export function TrackLabs({ labs, track, open }: { labs: Entry[]; track: TrackKey; open: (id: string) => void }) {
  const mine = labs.filter(l => l.track === track);
  const live = mine.filter(l => l.available); const soon = mine.filter(l => !l.available);
  return <>
    {live.length > 0 && <><h2 className="tr-section-title">Available now</h2><ul className="tr-grid">{live.map(l => <LabCard key={l.id} l={l} open={open} />)}</ul></>}
    {soon.length > 0 && <><h2 className="tr-section-title">Coming soon</h2><ul className="tr-grid">{soon.map(l => <LabCard key={l.id} l={l} open={open} />)}</ul></>}
    {!mine.length && <div className="tr-note tr-note-info">No labs in this track yet.</div>}
  </>;
}
