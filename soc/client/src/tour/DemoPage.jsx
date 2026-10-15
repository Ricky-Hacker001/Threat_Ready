// Newbie Demo Mode: the guided run. Renders the ordinary console for the
// demo session's case and drives the reusable GuidedTour over it.
// Every task is validated by the server against the demo case; the browser
// only reports what the learner did.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CaseView from '../CaseView.jsx';
import GuidedTour from './GuidedTour.jsx';
import Quiz from './Quiz.jsx';
import { bridge, waitFor } from './bridge.js';
import { demoApi } from '../api.js';

export const demoStore = {
  get() { try { return window.localStorage.getItem('soc-sim-demo'); } catch { return null; } },
  set(id) { try { if (id) window.localStorage.setItem('soc-sim-demo', id); else window.localStorage.removeItem('soc-sim-demo'); } catch { /* storage unavailable */ } },
};
export const newNonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function Gone({ error, goHome, goIntro }) {
  const expired = error.status === 404;
  return (
    <div className="page demo-page">
      <section className="demo-card" role="alert">
        <h1>{expired ? 'This demo session is no longer available' : 'The demo could not be loaded'}</h1>
        <p className="lead">{expired
          ? 'Demo sessions are kept for a day, and are removed when you restart. Your normal simulation cases are not affected.'
          : 'The server did not answer. Check that it is running, then try again.'}</p>
        <div className="demo-actions">
          {!expired && <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>}
          <button type="button" className={`btn${expired ? ' btn-primary' : ''}`} onClick={goIntro}>Start a new demo</button>
          <button type="button" className="btn" onClick={goHome}>Return home</button>
        </div>
      </section>
    </div>
  );
}

export default function DemoPage({ id, startAt, goHome, goIntro, goSummary, goDemo }) {
  const [state, setState] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [answers, setAnswers] = useState({});
  const [local, setLocal] = useState({});
  const [index, setIndex] = useState(0);
  const resetNonce = useRef(newNonce());
  const live = useRef({});

  const fail = useCallback((e) => {
    if (e?.status === 404) { demoStore.set(null); setFatal(e); } else setNotice(e?.status === 409 ? e.message : 'The server could not be reached. Progress is saved up to your last completed check. Try again in a moment.');
  }, []);

  // Load the script and the saved progress; a refresh resumes at the same step.
  useEffect(() => {
    let dead = false;
    demoApi.state(id).then(async (s) => {
      if (dead) return;
      let st = s;
      if (startAt && s.beats.some((b) => b.id === startAt)) {
        try { st = { ...s, progress: (await demoApi.goto(id, startAt)).progress }; } catch { /* not reachable yet: stay at the saved step */ }
      } else if (['paused', 'exited'].includes(s.progress.status)) {
        try { st = { ...s, progress: (await demoApi.status(id, 'active')).progress }; } catch { /* keep going */ }
      }
      if (dead) return;
      demoStore.set(id);
      setState(st);
      setIndex(Math.max(0, st.beats.findIndex((b) => b.id === st.progress.cursor)));
    }).catch((e) => { if (!dead) { if (e?.status === 404) demoStore.set(null); setFatal(e); } });
    return () => { dead = true; };
  }, [id, startAt]);

  const steps = useMemo(() => (state?.beats || []).map((b) => ({
    ...b, required: b.kind === 'task', checkLabel: b.check?.label, dim: b.kind === 'info' && !!b.target,
  })), [state?.beats]);
  const beat = steps[index];
  const progress = state?.progress;
  const doneSet = useMemo(() => new Set(progress?.done || []), [progress?.done]);
  live.current = { beat, progress, busy, answers, doneSet };

  // Put the right tab behind the step.
  const prepare = useCallback(async (b) => {
    if (!b?.tab) return;
    const view = await waitFor(() => (bridge.view?.id === id && bridge.view.cs() ? bridge.view : null), 8000);
    if (!view) return;
    if (b.tab === 'report' && view.cs().status !== 'closed') return;
    if (view.tab() !== b.tab) view.setTab(b.tab);
  }, [id]);
  useEffect(() => { if (beat) prepare(beat); }, [beat?.id, prepare]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the learner did, as far as the browser can see it. The server decides what it is worth.
  const collect = (b) => {
    const data = {};
    for (const k of b.check?.collect || []) {
      if (k === 'open') data.open = [...document.querySelectorAll('[data-tour~="log-detail"][data-eid]')].filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.dataset.eid);
      if (k === 'search') { const s = bridge.view?.search(); data.search = s ? { q: s.q, source: s.source, from: s.from, to: s.to } : null; }
      if (k === 'form') data.form = bridge.form?.get() || null;
    }
    if (b.widget) data.answers = live.current.answers[b.id] || {};
    return data;
  };

  const check = useCallback(async (b, quiet = false) => {
    if (!quiet) { setBusy(true); setNotice(null); }
    try {
      const out = await demoApi.check(id, b.id, collect(b), quiet);
      setState((s) => (s ? { ...s, progress: out.progress } : s));
      if (!quiet || out.ok) setLocal((p) => ({ ...p, [b.id]: { ok: out.ok, warn: out.warn, message: out.message, items: out.items } }));
      return out;
    } catch (e) {
      if (!quiet) fail(e);
      return null;
    } finally {
      if (!quiet) setBusy(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fail]);

  // Tasks that are judged from the case itself are re-checked when the case changes.
  useEffect(() => {
    let timer = null;
    const off = bridge.on((what) => {
      if (what !== 'case') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { beat: b, doneSet: d, busy: bz } = live.current;
        if (b?.check?.auto && !d.has(b.id) && !bz) check(b, true);
      }, 450);
    });
    return () => { off(); clearTimeout(timer); };
  }, [check]);

  const goto = async (i) => {
    const target = steps[i];
    if (!target || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const out = await demoApi.goto(id, target.id);
      setState((s) => (s ? { ...s, progress: out.progress } : s));
      setIndex(i);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    if (!beat || busy) return;
    if (!beat.required && !doneSet.has(beat.id)) {
      const out = await check(beat);
      if (!out) return;
    }
    if (index === steps.length - 1) goSummary(id); else await goto(index + 1);
  };

  const onCheck = async (b) => {
    const out = await check(b);
    if (out?.ok && index === steps.length - 1) goSummary(id);
  };

  const skip = async (b) => {
    setBusy(true);
    try {
      const out = await demoApi.skip(id, b.id);
      setState((s) => (s ? { ...s, progress: out.progress } : s));
    } catch (e) { fail(e); setBusy(false); return; }
    setBusy(false);
    await goto(index + 1);
  };

  const leave = async (status) => {
    try { await demoApi.status(id, status); } catch { /* leaving anyway; progress is already saved */ }
    goHome();
  };

  const restart = async () => {
    setBusy(true);
    try {
      const out = await demoApi.reset(id, resetNonce.current);
      demoStore.set(out.id);
      goDemo(out.id);
    } catch (e) { fail(e); setBusy(false); }
  };

  if (fatal) return <Gone error={fatal} goHome={goHome} goIntro={goIntro} />;
  if (!state) return <div className="page"><p className="muted">Loading the guided demo…</p></div>;

  const frontier = progress.frontier ? steps.findIndex((b) => b.id === progress.frontier) : steps.length - 1;
  const stepList = state.steps.map((s) => {
    const mine = steps.map((b, i) => ({ b, i })).filter((x) => x.b.step === s.n);
    const tasks = mine.filter((x) => x.b.required);
    const complete = tasks.length ? tasks.every((x) => doneSet.has(x.b.id)) : mine.every((x) => doneSet.has(x.b.id) || progress.skipped.includes(x.b.id));
    const first = mine[0].i;
    const current = beat.step === s.n;
    return {
      key: s.n, label: `${s.n}. ${s.title}`, current,
      status: complete ? 'Complete' : first <= frontier ? (current ? 'Current' : 'Open') : 'Locked',
      disabled: first > frontier || busy,
      onClick: () => goto(first),
    };
  });
  const inStep = steps.filter((b) => b.step === beat.step);
  const part = inStep.findIndex((b) => b.id === beat.id) + 1;

  return (
    <>
      <CaseView key={id} id={id} goHome={() => leave('paused')} />
      <GuidedTour
        steps={steps} index={index} label="Guided demo"
        progress={{ value: index + 1, max: steps.length, text: `Step ${beat.step} of ${state.steps.length}: ${beat.stepTitle}${inStep.length > 1 ? ` (part ${part} of ${inStep.length})` : ''}` }}
        isDone={(b) => doneSet.has(b.id)}
        result={(b) => local[b.id] || progress.results?.[b.id] || null}
        busy={busy}
        notice={notice}
        onBack={() => goto(index - 1)}
        onNext={next}
        onCheck={onCheck}
        onSkip={skip}
        onRetarget={prepare}
        nextLabel={(b, last) => (last ? 'Open learning summary' : 'Next')}
        menu={[
          { label: 'Pause and return home', hint: 'Your place is saved. Resume from the home page.', onClick: () => leave('paused') },
          { label: 'Exit the demo', hint: 'Leaves the demo. The session is kept for a day in case you come back.', onClick: () => leave('exited') },
          { label: 'Restart from the beginning', hint: 'Discards this demo session only and starts a clean one. Normal cases are not touched.', danger: true, onClick: restart },
        ]}
        stepList={stepList}
        renderWidget={(b) => (b.widget ? (
          <Quiz
            key={b.id} widget={b.widget} answers={answers[b.id] || {}} disabled={busy || doneSet.has(b.id)}
            onChange={(v) => setAnswers((p) => ({ ...p, [b.id]: v }))}
            items={(local[b.id] || progress.results?.[b.id])?.items}
          />
        ) : null)}
      />
    </>
  );
}
