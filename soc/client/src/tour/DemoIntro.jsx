// Newbie Demo Mode: the starting page. Nothing is created until the learner
// presses Start.

import React, { useEffect, useRef, useState } from 'react';
import { demoApi, session } from '../api.js';
import { ErrorNote } from '../components/bits.jsx';
import { demoStore, newNonce } from './DemoPage.jsx';

export default function DemoIntro({ goHome, goDemo, goSummary }) {
  const [info, setInfo] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const nonce = useRef(newNonce());

  useEffect(() => {
    demoApi.info().then(setInfo).catch(setErr);
    const id = demoStore.get();
    if (id) demoApi.state(id).then((s) => setSaved(s)).catch(() => { demoStore.set(null); });
  }, []);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await demoApi.start({ nonce: nonce.current });
      demoStore.set(out.id);
      goDemo(out.id);
    } catch (e) { setErr(e); setBusy(false); }
  };
  const restart = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await demoApi.reset(saved.id, nonce.current);
      demoStore.set(out.id);
      goDemo(out.id);
    } catch (e) { setErr(e); setBusy(false); }
  };

  const cur = saved ? saved.beats.find((b) => b.id === saved.progress.cursor) : null;
  const finished = saved?.progress.status === 'completed';

  return (
    <main className="page demo-page">
      <p><button type="button" className="link" onClick={goHome}>Home</button></p>
      <header className="home-head">
        <div>
          <p className="meta">Guided practice, sample scenario, simulated data</p>
          <h1>{info?.title || 'Newbie Demo Mode'}</h1>
          <p className="lead">{info?.text}</p>
        </div>
        {session.me && <p className="name-chip"><span className="muted">Demo ticket analyst</span> <strong>{session.me.name}</strong></p>}
      </header>
      <ErrorNote error={err} onDismiss={() => setErr(null)} />

      {saved && (
        <section className="demo-card" data-tour="demo-resume">
          <h2>{finished ? 'You have finished this demo' : 'You have a demo in progress'}</h2>
          <p>{finished ? `Ticket ${saved.case.ticket} is closed and its learning summary is ready.` : `You stopped at step ${cur?.step} of ${saved.steps.length}: ${cur?.stepTitle}. ${saved.progress.tasksDone} of ${saved.progress.tasksTotal} checks passed.`}</p>
          <div className="demo-actions">
            {finished
              ? <button type="button" className="btn btn-primary" onClick={() => goSummary(saved.id)} disabled={busy}>Open learning summary</button>
              : <button type="button" className="btn btn-primary" onClick={() => goDemo(saved.id)} disabled={busy}>Resume demo</button>}
            <button type="button" className="btn" onClick={restart} disabled={busy}>{busy ? 'Starting…' : finished ? 'Replay from the beginning' : 'Restart from the beginning'}</button>
          </div>
          <p className="muted">Restarting discards this demo session only. Normal simulation cases are not touched.</p>
        </section>
      )}

      <section className="demo-cols">
        <div>
          <h2>Before you start</h2>
          <ul className="demo-notes">{(info?.notes || []).map((n) => <li key={n}>{n}</li>)}</ul>
          {!saved && (
            <div className="demo-actions">
              <button type="button" className="btn btn-primary" data-tour="demo-begin" onClick={start} disabled={busy || !info}>{busy ? 'Starting…' : 'Start the guided demo'}</button>
              <button type="button" className="btn" onClick={goHome}>Not now</button>
            </div>
          )}
          {info && <p className="muted">Takes about {info.minutes} minutes. You can pause, exit and resume at any time.</p>}
        </div>
        <div>
          <h2>The {info?.steps.length || 16} steps</h2>
          <ol className="demo-steps">{(info?.steps || []).map((s) => <li key={s.n}>{s.title}</li>)}</ol>
        </div>
      </section>
    </main>
  );
}
