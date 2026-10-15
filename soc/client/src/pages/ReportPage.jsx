// Final analyst report (#/report). Rebuilt by the server on every request
// from the user's own records; available to every user whatever the results.

import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, stamp, duration } from '../components/bits.jsx';
import { Shield } from '../components/Badge.jsx';
import { Brand, Footer } from '../Console.jsx';

const BAND_CLASS = { Strong: 'good', Competent: 'good', Developing: 'mid', Gap: 'low' };
const d10 = (iso) => (iso ? stamp(Date.parse(iso)).slice(0, 10) : '–');

export default function ReportPage({ go }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.report().then(setR).catch(setErr); }, []);

  const download = () => {
    window.location.href = '/api/me/export';
  };

  if (err) return <div className="page"><ErrorNote error={err} /><p><button type="button" className="btn" onClick={() => go('#/')}>Back to SOC home</button></p></div>;
  if (!r) return <div className="page"><p className="muted">Building your report…</p></div>;
  const s = r.summary;

  return (
    <div className="page final-report">
      <div className="no-print report-actions">
        <button type="button" className="link" onClick={() => go('#/')}>SOC home</button>
        <span className="grow" />
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>
        <button type="button" className="btn" onClick={download}>Download my record (JSON)</button>
      </div>

      {/* 1. Analyst and report status */}
      <header className="fr-head">
        <Brand />
        <h1>Final analyst report</h1>
        <dl className="facts facts-row">
          <div><dt>Analyst</dt><dd>{r.user.name}</dd></div>
          <div><dt>Generated</dt><dd>{stamp(Date.parse(r.generatedAt))} UTC</dd></div>
        </dl>
        <p className={`fr-status fr-${r.status.kind}`}><strong>{r.status.line}</strong></p>
        <p className="muted">{r.status.data}</p>
      </header>

      {/* 2. Overall summary */}
      <section className="fr-sec">
        <h2>Overall summary</h2>
        <dl className="summary-grid">
          <div><dt>Internal badges</dt><dd>{s.badges} of {s.badgesOf}</dd></div>
          <div><dt>Scenarios passed</dt><dd>{s.passed} of {s.of}</dd></div>
          <div><dt>Scenarios attempted, not passed</dt><dd>{s.notPassed}</dd></div>
          <div><dt>Average best score</dt><dd>{s.averageText}</dd></div>
          <div><dt>Active time</dt><dd>{duration(s.activeSeconds)}</dd></div>
          <div><dt>Attempts</dt><dd>{s.attempts} ({s.closed} closed, {s.open} open, {s.abandoned} abandoned)</dd></div>
        </dl>
        {s.badgeList.length > 0 && (
          <ul className="fr-badges">
            {s.badgeList.map((b) => <li key={b.level}><Shield level={b.level} size={22} /> {b.name}, earned {d10(b.earnedAt)}, average {b.average}</li>)}
          </ul>
        )}
      </section>

      {/* 3. Results by level */}
      <section className="fr-sec page-break">
        <h2>Results by level</h2>
        {r.levels.map((lv) => (
          <div key={lv.id} className="fr-level">
            <h3>{lv.name} <span className="muted small">({lv.state === 'locked' ? 'Locked' : lv.state === 'completed' ? 'Completed' : 'Open'}; pass mark {lv.passMark}; {lv.passed} of {lv.released} passed)</span></h3>
            <div className="table-wrap">
              <table className="grid">
                <thead><tr><th>Scenario</th><th>Title</th><th className="num">Best</th><th>Status</th><th className="num">Attempts</th><th>Last attempted</th></tr></thead>
                <tbody>
                  {lv.rows.map((row) => (
                    <tr key={row.code}>
                      <td className="mono">{row.code}</td>
                      <td>{row.title}</td>
                      <td className="num">{row.best ?? '–'}</td>
                      <td>{row.stateLabel}</td>
                      <td className="num">{row.attempts}</td>
                      <td className="mono">{d10(row.lastAttempted)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      {/* 4. Skill map */}
      <section className="fr-sec">
        <h2>Skill map</h2>
        <p className="muted small">Scored from your best attempt at each scenario. A skill needs at least three questions across two scenarios before it is scored.</p>
        <div className="skill-groups">
          {r.skills.map((g) => (
            <div key={g.id} className="skill-group">
              <h3>{g.name}</h3>
              <ul className="skill-list">
                {g.skills.map((k) => (
                  <li key={k.id}>
                    <span className="skill-name">{k.label}</span>
                    {k.status === 'scored' ? (
                      <>
                        <span className="rep-bar" aria-hidden="true"><span style={{ width: `${k.score}%` }} className={BAND_CLASS[k.band]} /></span>
                        <span className="skill-score">{k.score} · {k.band}</span>
                      </>
                    ) : <span className="skill-score muted">{k.statusText}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* 5. Decision quality */}
      <section className="fr-sec">
        <h2>Decision quality</h2>
        <ul className="plain">{r.decisions.map((d) => <li key={d.id}>{d.text}</li>)}</ul>
        {r.statements.length > 0 && (
          <>
            <h3>Observations</h3>
            <ul>{r.statements.map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        )}
      </section>

      {/* 6. Strengths */}
      <section className="fr-sec">
        <h2>Strengths</h2>
        {r.strengths.items.length > 0
          ? <ul>{r.strengths.items.map((x) => <li key={x.skill}><strong>{x.label}</strong>: {x.score}. Best shown in {x.scenario} ({x.scenarioScore}).</li>)}</ul>
          : <p>{r.strengths.emptyText}</p>}
        {r.strengths.improvements.length > 0 && (
          <>
            <h3>Improvement after retakes</h3>
            <ul>{r.strengths.improvements.map((x) => <li key={x.code}>{x.text}</li>)}</ul>
          </>
        )}
      </section>

      {/* 7. Gaps or missed decisions */}
      <section className="fr-sec">
        <h2>{r.gaps.kind === 'missed' ? 'Missed decisions' : 'Gaps'}</h2>
        {r.gaps.kind === 'skills' && r.gaps.items.map((g) => (
          <div key={g.skill} className="fr-gap">
            <h3>{g.label} <span className="muted small">({g.band}, {g.score})</span></h3>
            {g.questions.length > 0 && <ul>{g.questions.map((q, i) => <li key={i}>{q.code}: {q.label} ({q.credit}% credit)</li>)}</ul>}
          </div>
        ))}
        {r.gaps.kind === 'missed' && (r.gaps.items.length
          ? <><p className="muted small">Not enough evidence yet to score skills, so these are the questions your best attempts missed.</p><ul>{r.gaps.items.map((q, i) => <li key={i}>{q.code}: {q.label} ({q.credit}% credit)</li>)}</ul></>
          : <p>{r.gaps.emptyText}</p>)}
        {r.gaps.kind === 'none' && <p>{r.gaps.emptyText}</p>}
      </section>

      {/* 8. What to learn next */}
      <section className="fr-sec">
        <h2>What to learn next</h2>
        {r.next.items.length > 0 ? (
          <ul>
            {r.next.items.map((n) => (
              <li key={n.skill}>
                <strong>{n.label}</strong>: {n.topic}. {n.tip}{' '}
                {n.replay ? <span>Replay <button type="button" className="link" onClick={() => go(`#/level/${n.replay.level}`)}>{n.replay.code} {n.replay.title}</button>.</span> : <span className="muted">{n.replayNote}</span>}
              </li>
            ))}
          </ul>
        ) : <p>{r.next.startText}</p>}
      </section>

      {/* 9. Attempt history */}
      <section className="fr-sec page-break">
        <h2>Attempt history</h2>
        {r.history.length === 0 ? <p>No attempts yet.</p> : (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Date (UTC)</th><th>Scenario</th><th>Level</th><th>Status</th><th className="num">Score</th><th>Passed</th><th className="no-print" /></tr></thead>
              <tbody>
                {r.history.map((h) => (
                  <tr key={h.attemptId}>
                    <td className="mono">{d10(h.date)}</td>
                    <td><span className="mono">{h.code}</span> {h.title}</td>
                    <td>{h.levelName}</td>
                    <td>{h.status === 'closed' ? 'Closed' : h.status === 'abandoned' ? 'Abandoned' : 'Open'}</td>
                    <td className="num">{h.scoreText}</td>
                    <td>{h.passedText}</td>
                    <td className="no-print">{h.caseId && <button type="button" className="link" onClick={() => go(`#/case/${h.caseId}`)}>Review</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="fr-notes">
        <p className="muted small">{r.notes.abandoned}</p>
        <p className="muted small">{r.notes.internal}</p>
        <p className="muted small">{r.notes.reset}</p>
      </section>
      <p className="no-print"><button type="button" className="btn" onClick={() => go('#/')}>Back to SOC home</button></p>
      <Footer />
    </div>
  );
}
