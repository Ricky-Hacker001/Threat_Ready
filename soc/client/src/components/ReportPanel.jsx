import React, { useState } from 'react';
import { api } from '../api.js';
import { stamp, duration, Verdict, ErrorNote } from './bits.jsx';

// Level attempts: result banner at the top of the review.
function ResultBanner({ res }) {
  return (
    <div className={`result-banner ${res.passed ? 'is-pass' : 'is-fail'}`} role="status">
      <strong>{res.passed ? 'Passed' : 'Not passed'}: {res.score} (pass mark {res.passMark})</strong>
      <span>{res.newBest ? 'New best for this scenario' : `Your best remains ${res.best}`}</span>
    </div>
  );
}

function SkillsTested({ skills }) {
  if (!skills?.length) return null;
  return (
    <section className="skills-tested">
      <h3 className="rep-h">Skills tested</h3>
      <ul className="skill-list">
        {skills.map((k) => (
          <li key={k.id}>
            <span className="skill-name">{k.label}</span>
            <span className="rep-bar" aria-hidden="true"><span style={{ width: `${k.score}%` }} className={k.score >= 80 ? 'good' : k.score >= 50 ? 'mid' : 'low'} /></span>
            <span className="skill-score">{k.score}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LevelFooter({ cs, go }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const replay = async () => {
    setBusy(true);
    try {
      const out = await api.startAttempt(cs.scenarioId);
      go(`#/case/${out.caseId}`);
    } catch (e) {
      if (e.code === 'attempt_open' && e.body.caseId) go(`#/case/${e.body.caseId}`);
      else { setErr(e); setBusy(false); }
    }
  };
  return (
    <footer className="rep-foot">
      <ErrorNote error={err} onDismiss={() => setErr(null)} />
      <div className="rep-foot-actions">
        <button type="button" className="btn" onClick={() => go(`#/level/${cs.level}`)}>Back to level</button>
        <button type="button" className="btn btn-primary" onClick={replay} disabled={busy}>{busy ? 'Starting…' : 'Replay with a new variant'}</button>
        <button type="button" className="btn" onClick={() => go('#/report')}>Final analyst report</button>
      </div>
      <p className="muted small">ThreatReady SOC Simulation · Aerovant Technologies</p>
    </footer>
  );
}

function Stage({ s }) {
  const [open, setOpen] = useState(s.pct < 100 && !s.skipped);
  if (s.skipped) {
    return <section className="rep-stage"><header><h3>{s.label}</h3><span className="muted">Not required on the path this ticket took</span></header></section>;
  }
  return (
    <section className="rep-stage">
      <header>
        <button type="button" className="rep-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <h3>{s.label}</h3>
        </button>
        <span className="muted">{s.tier}, weight {s.weight}%{s.seconds != null ? `, ${duration(s.seconds)}` : ''}{s.attempts > 1 ? `, ${s.attempts} review rounds` : ''}</span>
        <span className="rep-bar" aria-hidden="true"><span style={{ width: `${s.pct}%` }} className={s.pct >= 80 ? 'good' : s.pct >= 50 ? 'mid' : 'low'} /></span>
        <span className="rep-pct">{s.pct}%</span>
      </header>
      {open && (
        <div className="rep-body">
          {(s.fields || []).map((f) => (
            <div className="rep-item" key={f.label}>
              <div className="rep-item-head"><h4>{f.label}</h4><Verdict v={f.verdict} supported={f.supported} /><span className="muted">{f.earned} / {f.points}</span></div>
              <dl>
                <div><dt>You answered</dt><dd className="break">{f.yours}</dd></div>
                <div><dt>Expected</dt><dd className="break">{f.expected}</dd></div>
                {f.explain && <div><dt>Why</dt><dd>{f.explain}</dd></div>}
              </dl>
            </div>
          ))}
          {(s.objectives || []).map((o) => (
            <div className="rep-item" key={o.label}>
              <div className="rep-item-head"><h4>{o.label}</h4><Verdict v={o.verdict} /><span className="muted">{o.earned} / {o.points}</span></div>
              <dl><div><dt>Why</dt><dd>{o.explain}</dd></div></dl>
            </div>
          ))}
          {(s.findings || []).length > 0 && (
            <div className="rep-item">
              <div className="rep-item-head"><h4>Deductions</h4><span className="muted">-{s.penalty}</span></div>
              <ul className="notes">{s.findings.map((f, i) => <li key={i}><strong>{f.action}</strong> (-{f.points}). {f.reason}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function ReportPanel({ cs, go }) {
  const r = cs.report;
  return (
    <div className="panel">
      <div className="scroll pad report">
        {cs.kind === 'demo' && <p className="note" data-tour="report-note">Guided demo result. You were coached and could retry, so this figure is a learning record, not an assessment or a certification. It is not listed with, and does not affect, normal simulation cases.</p>}
        {r.result && <ResultBanner res={r.result} />}
        {r.sample && <p className="note" data-tour="report-note">Sample report for the walkthrough. Answers, expected answers and explanations are left out here; your own closed ticket shows them in full.</p>}
        <header className="rep-head" data-tour="report-head">
          <div>
            <p className="meta">After-action review, {cs.ticket}</p>
            <h2>{cs.title}</h2>
            <p className="muted">Analyst {cs.analyst}. Opened {stamp(cs.createdAt)} UTC, closed {stamp(cs.closedAt)} UTC.</p>
          </div>
          <div className="rep-score"><span className="score-n">{r.score}</span><span className="score-of">/ 100</span><span className="band">{r.band}</span></div>
        </header>
        <dl className="metrics">
          {cs.metrics.map((m) => <div key={m.id}><dt>{m.label}</dt><dd>{duration(m.seconds)}</dd></div>)}
        </dl>
        <div className="rep-export" data-tour="report-export">
          <a className="btn btn-sm" href={`/api/cases/${cs.id}/export?format=md`}>Download case file (Markdown)</a>
          <a className="btn btn-sm" href={`/api/cases/${cs.id}/export?format=json`}>Download case file (JSON)</a>
        </div>

        {r.result && <SkillsTested skills={r.result.skills} />}

        <div data-tour="report-stages">
          <h3 className="rep-h">Scoring by stage</h3>
          {r.stages.map((s) => <Stage key={s.id} s={s} />)}
        </div>

        <h3 className="rep-h" data-tour="report-truth">What actually happened</h3>
        <p className="prose">{r.truth.summary}</p>
        <ol className="truth">
          {r.truth.timeline.map((t) => <li key={t.ts + t.text}><span className="mono">{stamp(t.ts)}</span><span>{t.text}</span></li>)}
        </ol>
        {r.truth.iocs?.length > 0 && (
          <>
            <h3 className="rep-h">Indicators of compromise</h3>
            <table className="grid">
              <thead><tr><th>Type</th><th>Value</th><th>Role</th></tr></thead>
              <tbody>{r.truth.iocs.map((i) => <tr key={i.value}><td>{i.type}</td><td className="mono break">{i.value}</td><td>{i.note}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {cs.level && go && <LevelFooter cs={cs} go={go} />}
      </div>
    </div>
  );
}
