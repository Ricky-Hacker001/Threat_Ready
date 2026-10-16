// SOC home (#/). The signed-in analyst's name is fixed for the session; levels,
// progress and permissions all come from the server.

import React, { useEffect, useState } from 'react';
import { api, session } from './api.js';
import { stamp, ErrorNote } from './components/bits.jsx';
import { Shield } from './components/Badge.jsx';

export function Brand() {
  return (
    <p className="brand" aria-label="ThreatReady, by Aerovant Technologies">
      <img src={`${import.meta.env.BASE_URL}logo-sm.png`} alt="" width="26" height="25" />
      <span className="brand-name">ThreatReady</span>
      <span className="brand-sep" aria-hidden="true" />
      <span className="brand-product">SOC Simulation</span>
    </p>
  );
}

export function NameChip() {
  const me = session.me;
  if (!me) return null;
  const signOut = async () => {
    try { await api.signOut(); } catch { /* already signed out */ }
    window.location.hash = '#/';
    window.location.reload();
  };
  return (
    <p className="name-chip" data-tour="home-analyst">
      <span className="muted">Signed in as</span> <strong>{me.name}</strong>
      {session.homeUrl
        // Inside ThreatReady the platform owns sign-in, and its strip above the page links to the catalog.
        ? null
        : <button type="button" className="link signout" onClick={signOut} title="Signing out ends this session. Your records stay only until the daily reset and cannot be reopened under a new sign-in.">Sign out</button>}
    </p>
  );
}

export function Footer() {
  return <footer className="brand-foot">© {new Date().getFullYear()} Aerovant Technologies · ThreatReady</footer>;
}

const STATE = { open: 'Open', locked: 'Locked', completed: 'Completed' };

export function Progress({ passed, of = 12, badgeAt }) {
  const pct = Math.round((passed / of) * 100);
  return (
    <div className="progress">
      <span className="progress-text">{passed} of {of} passed{badgeAt ? ` (badge at ${badgeAt})` : ''}</span>
      <span className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={passed} aria-label={`${passed} of ${of} passed`}><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

function LevelCard({ l, go }) {
  return (
    <article className={`level-card is-${l.state}`} data-tour="home-level">
      <header>
        <h3>{l.name}</h3>
        <span className={`state-tag st-${l.state}`}>{l.state === 'completed' && <Shield level={l.id} size={18} />}{STATE[l.state]}</span>
      </header>
      <p>{l.oneLine}</p>
      <Progress passed={l.passed} of={l.released || 12} />
      <dl className="facts">
        <div><dt>Best average</dt><dd>{l.bestAverage ?? '–'}</dd></div>
        <div><dt>Pass mark</dt><dd>{l.passMark}</dd></div>
        <div><dt>Badge</dt><dd>{l.badge ? `Earned ${stamp(l.badge.earnedAt).slice(0, 10)}` : `At ${l.badgeAt} passed`}</dd></div>
      </dl>
      {l.state === 'locked'
        ? <p className="locked-note">Earn the {l.unlockAfterName} badge to unlock. <button type="button" className="link" onClick={() => go(`#/level/${l.id}`)}>Preview scenarios</button></p>
        : <button type="button" className="btn btn-primary" onClick={() => go(`#/level/${l.id}`)}>Open level</button>}
    </article>
  );
}

export function AttemptsTable({ attempts, go, onAbandon, showLevel = true }) {
  const [confirm, setConfirm] = useState(null);
  return (
    <div className="table-wrap">
      <table className="grid cases">
        <thead><tr><th>Ticket</th>{showLevel && <th>Level</th>}<th>Scenario</th><th>Stage</th><th className="num">Score</th><th>Passed</th><th>Started (UTC)</th><th /></tr></thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.attemptId}>
              <td className="mono">{a.ticket || '–'}</td>
              {showLevel && <td>{a.levelName}</td>}
              <td><span className="mono">{a.code}</span> {a.title}</td>
              <td>{a.status === 'open' ? a.stageLabel : a.status === 'abandoned' ? 'Abandoned' : 'Closed'}</td>
              <td className="num">{a.score ?? '–'}</td>
              <td>{a.status === 'abandoned' ? 'No' : a.passed == null ? '–' : a.passed ? 'Yes' : 'No'}</td>
              <td className="mono">{stamp(a.startedAt)}</td>
              <td className="row-actions">
                {a.status === 'abandoned'
                  ? <button type="button" className="link" onClick={() => go(`#/level/${a.level}`)}>Scenario</button>
                  : <button type="button" className="link" onClick={() => go(`#/case/${a.caseId}`)}>{a.status === 'open' ? 'Resume' : 'Open'}</button>}
                {a.status === 'open' && onAbandon && (confirm === a.attemptId ? (
                  <>
                    <button type="button" className="link danger" onClick={async () => { setConfirm(null); await onAbandon(a); }}>Abandon (scores 0)</button>
                    <button type="button" className="link" onClick={() => setConfirm(null)}>Cancel</button>
                  </>
                ) : <button type="button" className="link" onClick={() => setConfirm(a.attemptId)}>Delete</button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Console({ go, startTour, openDemo }) {
  const [levels, setLevels] = useState(null);
  const [att, setAtt] = useState(null);
  const [limit, setLimit] = useState(20);
  const [err, setErr] = useState(null);

  const load = (n = limit) => Promise.all([api.levels(), api.attempts(n)]).then(([l, a]) => { setLevels(l); setAtt(a); }).catch(setErr);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving from "Open normal simulation": scroll to the levels once they are on the page.
  useEffect(() => {
    if (!levels) return;
    let wanted = false;
    try { wanted = window.sessionStorage.getItem('soc-sim-focus-shift') === '1'; window.sessionStorage.removeItem('soc-sim-focus-shift'); } catch { /* storage unavailable */ }
    if (wanted) requestAnimationFrame(() => document.getElementById('your-levels')?.scrollIntoView({ block: 'start' }));
  }, [levels]);

  const open = (att?.attempts || []).filter((a) => a.status === 'open');
  const abandon = async (a) => { try { await api.abandon(a.attemptId); await load(); } catch (e) { setErr(e); } };

  return (
    <div className="page">
      <header className="home-head">
        <div>
          <Brand />
          <h1>SOC simulation</h1>
          <p className="lead">Work a ticket the way a SOC does: watch the queue, triage at Tier 1, hand off to Tier 2, investigate and validate, respond as Tier 3, close. Logs are generated live and every decision is checked against the evidence.</p>
        </div>
        <NameChip />
      </header>
      <ErrorNote error={err} onDismiss={() => setErr(null)} />

      <section className="learn" data-tour="home-learn" aria-labelledby="learn-h">
        <h2 id="learn-h">New here?</h2>
        <div className="learn-grid">
          <article className="learn-card" data-tour="home-demo">
            <p className="meta">Guided, step by step, sample scenario</p>
            <h3>Newbie Demo Mode</h3>
            <p>Learn how a SOC analyst investigates security events, reads logs, collects evidence, validates findings, and completes an incident through a guided, step-by-step demonstration.</p>
            <button type="button" className="btn btn-primary" data-tour="home-demo-start" onClick={openDemo}>Start guided demo</button>
          </article>
          <article className="learn-card" data-tour="home-tour">
            <p className="meta">Optional, about five minutes, nothing is started</p>
            <h3>How it works</h3>
            <p>A short tour of this application: the home page, the console, logs and search, the three tiers and the final report. It does not start an assessment and you can leave it at any time.</p>
            <button type="button" className="btn" data-tour="home-tour-start" onClick={startTour}>Take a walkthrough</button>
          </article>
        </div>
      </section>

      <section data-tour="home-scenarios" aria-labelledby="your-levels">
        <h2 id="your-levels">Your levels</h2>
        {!levels && <p className="muted">Loading…</p>}
        <div className="levels">{(levels || []).map((l) => <LevelCard key={l.id} l={l} go={go} />)}</div>
      </section>

      {open.length > 0 && (
        <section className="continue" aria-labelledby="continue-h">
          <h2 id="continue-h">Continue where you left off</h2>
          <ul className="continue-list">
            {open.map((a) => (
              <li key={a.attemptId}>
                <span><span className="mono">{a.code}</span> {a.title}</span>
                <span className="muted">{a.levelName} · {a.stageLabel}</span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => go(`#/case/${a.caseId}`)}>Resume</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="record" aria-labelledby="record-h">
        <h2 id="record-h">Your record</h2>
        <div className="record-row">
          <button type="button" className="btn" onClick={() => go('#/badges')}>Internal badges</button>
          <button type="button" className="btn" onClick={() => go('#/report')}>Final analyst report</button>
        </div>
        <p className="muted small">The report is available at any time, whatever your results.</p>
      </section>

      <section data-tour="home-cases" aria-labelledby="recent-h">
        <h2 id="recent-h">Recent attempts</h2>
        {att && !att.total && <p className="muted">No attempts yet. Open Foundations and start a scenario.</p>}
        {att && att.total > 0 && <AttemptsTable attempts={att.attempts} go={go} onAbandon={abandon} />}
        {att && att.total > att.attempts.length && <p><button type="button" className="btn btn-sm" onClick={() => { const n = limit + 20; setLimit(n); load(n); }}>Show more</button></p>}
      </section>

      <p className="reset-note">Practice records reset daily at 00:00 UTC.</p>
      <Footer />
    </div>
  );
}
