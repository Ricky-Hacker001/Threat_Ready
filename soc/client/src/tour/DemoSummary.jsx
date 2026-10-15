// Step 16: the learning summary. Built by the server from the demo session.
// Nothing here redirects by itself; the learner chooses where to go next.

import React, { useEffect, useRef, useState } from 'react';
import { demoApi } from '../api.js';
import { ErrorNote, stamp, SourceTag } from '../components/bits.jsx';
import { demoStore, newNonce } from './DemoPage.jsx';

function List({ items, empty }) {
  if (!items?.length) return <p className="muted">{empty}</p>;
  return <ul className="demo-notes">{items.map((x) => <li key={x}>{x}</li>)}</ul>;
}

export default function DemoSummary({ id, goHome, goIntro, goDemo, goNormal }) {
  const [sum, setSum] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const nonce = useRef(newNonce());

  useEffect(() => {
    let dead = false;
    demoApi.summary(id).then((s) => { if (!dead) setSum(s); }).catch((e) => { if (!dead) { if (e.status === 404) demoStore.set(null); setErr(e); } });
    return () => { dead = true; };
  }, [id]);

  const replay = async () => {
    setBusy(true);
    try {
      const out = await demoApi.reset(id, nonce.current);
      demoStore.set(out.id);
      goDemo(out.id);
    } catch (e) { setErr(e); setBusy(false); }
  };

  if (err && !sum) {
    return (
      <div className="page demo-page">
        <section className="demo-card" role="alert">
          <h1>{err.status === 404 ? 'This demo session is no longer available' : 'The summary could not be loaded'}</h1>
          <p className="lead">{err.status === 404 ? 'Demo sessions are kept for a day, and are removed when you restart.' : 'The server did not answer. Try again in a moment.'}</p>
          <div className="demo-actions">
            <button type="button" className="btn btn-primary" onClick={goIntro}>Start a new demo</button>
            <button type="button" className="btn" onClick={goHome}>Return home</button>
          </div>
        </section>
      </div>
    );
  }
  if (!sum) return <div className="page"><p className="muted">Building your learning summary…</p></div>;

  const c = sum.checks;
  return (
    <div className="page demo-page">
      <header className="home-head">
        <div>
          <p className="meta">Step 16 of 16, {sum.ticket}, analyst {sum.analyst}</p>
          <h1>{sum.label}</h1>
          <p className="note" data-tour="summary-disclaimer">{sum.disclaimer}</p>
        </div>
      </header>
      <ErrorNote error={err} onDismiss={() => setErr(null)} />

      {!sum.complete && <p className="note note-warn">The demo is not finished yet, so this summary is partial. Resume the demo to complete it.</p>}

      <dl className="metrics demo-metrics">
        <div><dt>Guided checks passed</dt><dd>{c.total - c.open.length} of {c.total}</dd></div>
        <div><dt>Passed on the first try</dt><dd>{c.passedFirst.length}</dd></div>
        <div><dt>Needed another try</dt><dd>{c.retried.length}</dd></div>
        <div><dt>Time taken</dt><dd>{sum.minutes ? `${sum.minutes} min` : 'In progress'}</dd></div>
        <div><dt>Guided result</dt><dd>{sum.guidedResult === null ? 'Not closed' : `${sum.guidedResult} / 100`}</dd></div>
      </dl>

      <div className="demo-actions" data-tour="summary-actions">
        {!sum.complete && <button type="button" className="btn btn-primary" onClick={() => goDemo(id)}>Resume demo</button>}
        <button type="button" className={`btn${sum.complete ? ' btn-primary' : ''}`} onClick={replay} disabled={busy}>{busy ? 'Starting…' : 'Replay demo'}</button>
        <button type="button" className="btn" onClick={() => setPick(!pick)} aria-expanded={pick}>Review a specific step</button>
        <button type="button" className="btn" onClick={goHome}>Return home</button>
        <button type="button" className="btn" onClick={goNormal}>Open normal simulation</button>
      </div>
      {pick && (
        <ol className="demo-steps demo-pick">
          {sum.steps.map((s) => (
            <li key={s.n}>
              <button type="button" className="link" disabled={s.status === 'Not started'} onClick={() => goDemo(id, s.first)}>{s.title}</button>
              <span className="muted"> {s.status}{s.retries ? `, ${s.retries} extra tr${s.retries === 1 ? 'y' : 'ies'}` : ''}</span>
            </li>
          ))}
        </ol>
      )}

      <section className="demo-cols">
        <div>
          <h2>What you did</h2>
          <List items={sum.did} empty="Nothing recorded yet." />
          <h2>What went well</h2>
          <List items={sum.wentWell} empty="Nothing to list yet." />
        </div>
        <div>
          <h2>What needs improvement</h2>
          <List items={sum.improve} empty="Nothing to list yet." />
          <h2>Recommended next steps</h2>
          <List items={sum.next} empty="" />
        </div>
      </section>

      <section>
        <h2>Validation checks</h2>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Step</th><th>Status</th><th className="num">Checks passed</th><th className="num">Extra tries</th><th className="num">Explanations skipped</th></tr></thead>
            <tbody>
              {sum.steps.map((s) => (
                <tr key={s.n}><td>{s.n}. {s.title}</td><td>{s.status}</td><td className="num">{s.tasks ? `${s.tasksDone} / ${s.tasks}` : '-'}</td><td className="num">{s.retries}</td><td className="num">{s.explanationsSkipped}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="rep-h">Workflow stages</h3>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Stage</th><th>Tier</th><th>Status</th><th className="num">Submissions</th><th className="num">Guided result</th></tr></thead>
            <tbody>
              {sum.stages.map((s) => <tr key={s.id}><td>{s.label}</td><td>{s.tier}</td><td>{s.status === 'done' ? 'Completed' : s.status === 'active' ? 'In progress' : 'Not reached'}</td><td className="num">{s.submissions || '-'}</td><td className="num">{s.pct === null ? '-' : `${s.pct}%`}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Evidence you collected</h2>
        {!sum.evidence.pins.length && <p className="muted">No events were pinned.</p>}
        <ul className="pins">
          {sum.evidence.pins.map((p) => (
            <li key={p.ts + p.raw}>
              <div className="pin-head"><span className="mono">{stamp(p.ts)}</span><SourceTag source={p.source} /><span>{p.host}</span></div>
              <div className="raw-line">{p.raw}</div>
              {p.note && <p className="muted">Note: {p.note}</p>}
            </li>
          ))}
        </ul>
        <p className="muted">
          Indicators: {sum.evidence.indicators.length ? sum.evidence.indicators.map((i) => `${i.type} ${i.value}`).join(', ') : 'none'}.
          {' '}Lookups: {sum.evidence.tools.length ? sum.evidence.tools.map((t) => `${t.label} (${t.runs})`).join(', ') : 'none'}.
        </p>
      </section>
    </div>
  );
}
