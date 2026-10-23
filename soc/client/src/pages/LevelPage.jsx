// Level page (#/level/:id): scenario cards with filters. The server decides
// what may be started; a locked level is read-only.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, SOURCE_LABEL } from '../components/bits.jsx';
import { Shield } from '../components/Badge.jsx';
import { Brand, NameChip, Footer, Progress, ResetNote } from '../Console.jsx';

const STATES = [['all', 'All'], ['not_attempted', 'Not attempted'], ['passed', 'Passed'], ['not_passed', 'Not passed']];
const GROUPS = [['windows', 'Windows'], ['firewall', 'Firewall'], ['proxy', 'Proxy'], ['dns', 'DNS'], ['email', 'Email'], ['endpoint', 'Endpoint'], ['vpn', 'VPN'], ['identity', 'Identity'], ['cloud', 'Cloud'], ['web', 'Web']];

// Scenario states from the server: not_attempted, in_progress, passed, not_passed.
const stateText = (s) => {
  if (s.state === 'passed') return `Passed, best ${s.best}`;
  if (s.state === 'not_passed') return `Not passed, best ${s.best ?? 0}`;
  if (s.state === 'in_progress') return s.best != null ? `In progress (best ${s.best})` : 'In progress';
  if (s.state === 'abandoned') return 'Abandoned, no score';
  return 'Not attempted';
};
const matchState = (s, f) => f === 'all'
  || (f === 'not_attempted' && s.state === 'not_attempted')
  || (f === 'passed' && (s.state === 'passed' || (s.state === 'in_progress' && s.passed)))
  || (f === 'not_passed' && (s.state === 'not_passed' || s.state === 'abandoned' || (s.state === 'in_progress' && s.best != null && !s.passed)));

function bannerHidden() {
  try { return window.sessionStorage.getItem('soc-sim-demo-banner') === 'hidden'; } catch { return false; }
}

export default function LevelPage({ id, go, openDemo }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [st, setSt] = useState('all');
  const [grp, setGrp] = useState(null);
  const [busy, setBusy] = useState(null);
  const [conflict, setConflict] = useState(null);
  // Dismissed for this visit only; the banner comes back on a later visit.
  const [banner, setBanner] = useState(() => !bannerHidden());
  // The resume-or-abandon prompt takes focus so keyboard and screen-reader users meet it.
  const conflictRef = useRef(null);
  useEffect(() => { if (conflict) conflictRef.current?.focus(); }, [conflict]);

  const load = () => api.level(id).then(setData).catch(setErr);
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { try { window.sessionStorage.removeItem('soc-sim-demo-banner'); } catch { /* storage unavailable */ } }, []);

  const list = data?.scenarios || [];
  const counts = useMemo(() => {
    const byState = Object.fromEntries(STATES.map(([k]) => [k, list.filter((s) => matchState(s, k) && (!grp || (s.sourceGroups || []).includes(grp))).length]));
    const byGroup = Object.fromEntries(GROUPS.map(([k]) => [k, list.filter((s) => matchState(s, st) && (s.sourceGroups || []).includes(k)).length]));
    return { byState, byGroup };
  }, [list, st, grp]);
  const shown = list.filter((s) => matchState(s, st) && (!grp || (s.sourceGroups || []).includes(grp)));

  const start = async (s) => {
    setBusy(s.id);
    setErr(null);
    try {
      const out = await api.startAttempt(s.id);
      go(`#/case/${out.caseId}`);
    } catch (e) {
      if (e.code === 'attempt_open') setConflict({ s, attemptId: e.body.attemptId, caseId: e.body.caseId });
      else setErr(e);
      setBusy(null);
    }
  };
  const abandonAndStart = async () => {
    const c = conflict;
    setConflict(null);
    try { await api.abandon(c.attemptId); await start(c.s); } catch (e) { setErr(e); }
  };

  if (!data && !err) return <main className="page"><p className="muted" role="status">Loading…</p></main>;
  const lv = data?.level;
  const locked = lv?.state === 'locked';

  return (
    <main className="page">
      <header className="home-head">
        <div>
          <Brand />
          <p><button type="button" className="link" onClick={() => go('#/')}>SOC home</button></p>
          {lv && <h1>{lv.name}</h1>}
        </div>
        <NameChip />
      </header>
      <ErrorNote error={err} onDismiss={() => setErr(null)} />
      {lv && (
        <section className="level-head">
          <p className="lead">{lv.oneLine}</p>
          <p>For: {lv.audience}. Workflow: {lv.workflow}.</p>
          <p>Trains: {lv.trains}</p>
          <dl className="facts facts-row">
            <div><dt>Pass mark</dt><dd>{lv.passMark}</dd></div>
            <div><dt>Submission rounds</dt><dd>{lv.rounds}</dd></div>
            <div><dt>Hints</dt><dd>{lv.hints === 'auto' ? 'Shown after a wrong answer' : lv.hints === 'request' ? 'On request (caps that question at 80%)' : 'None before the review'}</dd></div>
            <div><dt>Typical time</dt><dd>{lv.minutes} minutes</dd></div>
            <div><dt>Badge</dt><dd>{lv.badge ? <span className="badge-inline"><Shield level={lv.id} size={16} /> Earned, average {lv.badge.average}</span> : 'Not yet earned'}</dd></div>
          </dl>
          <Progress passed={lv.passed} of={lv.released || 12} badgeAt={lv.badgeAt} />
          {locked && <p className="note">This level is locked. Earn the {lv.unlockAfterName} badge to unlock it. You can look at the scenario titles below.</p>}
        </section>
      )}

      {id === 'foundations' && banner && (
        <div className="banner" role="region" aria-label="Newbie Demo Mode">
          <span>New to SOC work? Start with Newbie Demo Mode.</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={openDemo}>Start guided demo</button>
          <button type="button" className="link" onClick={() => { setBanner(false); try { window.sessionStorage.setItem('soc-sim-demo-banner', 'hidden'); } catch { /* storage unavailable */ } }}>Dismiss</button>
        </div>
      )}

      {conflict && (
        <div className="note" role="alertdialog" aria-label="Attempt in progress" aria-describedby="conflict-text" tabIndex={-1} ref={conflictRef}>
          <p id="conflict-text">You have an attempt in progress. Resume it, or abandon it and start a new variant?</p>
          <p className="muted small">An abandoned attempt scores 0 and stays in your history as Abandoned.</p>
          <div className="row-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => go(`#/case/${conflict.caseId}`)}>Resume</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={abandonAndStart}>Abandon and start a new variant</button>
            <button type="button" className="link" onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </div>
      )}

      {data && (
        <section aria-label="Filters" className="filters">
          <div className="chips" role="group" aria-label="Attempt state">
            {STATES.map(([k, l]) => <button type="button" key={k} className={`chip${st === k ? ' chip-on' : ''}`} aria-pressed={st === k} onClick={() => setSt(k)}>{l} <span className="chip-n">{counts.byState[k]}</span></button>)}
          </div>
          <div className="chips" role="group" aria-label="Log source">
            {GROUPS.map(([k, l]) => <button type="button" key={k} className={`chip${grp === k ? ' chip-on' : ''}`} aria-pressed={grp === k} onClick={() => setGrp(grp === k ? null : k)}>{l} <span className="chip-n">{counts.byGroup[k]}</span></button>)}
          </div>
        </section>
      )}

      {data && (
        <div className="scenarios">
          {shown.length === 0 && <p className="muted">No scenarios match these filters.</p>}
          {shown.map((s) => (
            <article className={`scenario sc-${s.state}`} key={s.id}>
              <p className="meta"><span className="mono">{s.code}</span> · {s.minutes} minutes</p>
              <h3>{s.title}</h3>
              <p className="src-chips">{(s.sources || []).map((x) => <span key={x} className={`src src-${x}`}>{SOURCE_LABEL[x] || x}</span>)}</p>
              <p className={`sc-state st-${s.state}`}>{stateText(s)}{s.attempts ? ` · ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}` : ''}</p>
              {locked ? <p className="locked-note">Locked: earn the {lv.unlockAfterName} badge</p> : (
                <div className="sc-actions">
                  {s.openCaseId && <button type="button" className="btn btn-primary" onClick={() => go(`#/case/${s.openCaseId}`)}>Resume</button>}
                  {!s.openCaseId && !s.lastCaseId && <button type="button" className="btn btn-primary" onClick={() => start(s)} disabled={busy === s.id}>{busy === s.id ? 'Starting…' : 'Start'}</button>}
                  {!s.openCaseId && s.lastCaseId && <button type="button" className="btn btn-primary" onClick={() => start(s)} disabled={busy === s.id}>{busy === s.id ? 'Starting…' : 'Replay with a new variant'}</button>}
                  {s.lastCaseId && <button type="button" className="btn" onClick={() => go(`#/case/${s.lastCaseId}`)}>Last report</button>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      <ResetNote />
      <Footer />
    </main>
  );
}
