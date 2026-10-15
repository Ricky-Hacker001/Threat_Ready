// Newbie Demo Mode: sessions, progress and the learning summary.
//
// A demo session is a case of kind 'demo' on the dedicated demo scenario.
// It is stored like any case so a refresh or a later visit can resume it,
// but it has its own ticket numbers, is never listed with assessment cases,
// and nothing here reads or writes any other case.

import { store } from '../store.js';
import { getScenario } from '../scenarios/index.js';
import { HttpError } from '../engine/response.js';
import { createCase, getCase, streamFor, tick, removeCase, caseSummary, totalScore } from '../engine/cases.js';
import { TOOLS } from '../engine/tools.js';
import { BEATS, STEPS, INTRO, CHECKS, beatIndex, buildCtx, publicBeat } from './guide.js';
import { DEMO_SCENARIO } from './autoplay.js';

const MAX_AGE = 24 * 3600 * 1000;
const recent = new Map(); // start/reset nonce -> case id, so a double click cannot create two sessions

export const demoInfo = () => ({ ...INTRO, steps: STEPS.map((title, i) => ({ n: i + 1, title })) });

// A demo session belongs to the signed-in user who started it.
export function demoCase(id, user) {
  let c;
  try { c = getCase(id); } catch { c = null; }
  if (!c || c.kind !== 'demo' || (user && c.userId && c.userId !== user.uid)) throw new HttpError(404, 'This demo session is no longer available. Start a new one from the home page.');
  return c;
}

function sweep() {
  const now = Date.now();
  for (const c of store.all()) if (c.kind === 'demo' && now - c.t0 > MAX_AGE) removeCase(c);
  for (const [k, v] of recent) if (now - v.at > 60000) recent.delete(k);
}

function fresh(analyst, userId) {
  const c = createCase({ scenarioId: DEMO_SCENARIO, analyst, kind: 'demo', userId });
  c.demo = { status: 'active', cursor: BEATS[0].id, done: {}, skipped: {}, tries: {}, results: {}, startedAt: Date.now() };
  store.save();
  return c;
}

export function startDemo({ analyst, resumeId, nonce, user } = {}) {
  sweep();
  const key = nonce ? `${user?.uid || ''}:${String(nonce).slice(0, 64)}` : null;
  if (key && recent.has(key)) {
    try { return demoCase(recent.get(key).id, user); } catch { recent.delete(key); }
  }
  if (resumeId) {
    try {
      const c = demoCase(String(resumeId), user);
      if (c.demo.status !== 'completed') c.demo.status = 'active';
      store.save();
      return c;
    } catch { /* gone: fall through to a new session */ }
  }
  const c = fresh(user?.name || analyst, user?.uid);
  if (key) recent.set(key, { id: c.id, at: Date.now() });
  return c;
}

// Replay: discard this demo session only, and start a clean one.
export function resetDemo(c, nonce) {
  const key = nonce ? `r:${String(nonce).slice(0, 64)}` : null;
  const analyst = c.analyst;
  removeCase(c);
  const n = fresh(analyst, c.userId);
  if (key) recent.set(key, { id: n.id, at: Date.now() });
  return n;
}
export function resetDemoById(id, nonce, user) {
  const key = nonce ? `r:${String(nonce).slice(0, 64)}` : null;
  if (key && recent.has(key)) {
    try { return demoCase(recent.get(key).id, user); } catch { recent.delete(key); }
  }
  return resetDemo(demoCase(id, user), nonce);
}

const isDone = (c, b) => !!c.demo.done[b.id];
const firstOpenTask = (c) => BEATS.findIndex((b) => b.kind === 'task' && !isDone(c, b));
const reachable = (c, i) => { const f = firstOpenTask(c); return f === -1 || i <= f; };

function ctxFor(c, data) {
  tick(c);
  return buildCtx(c, getScenario(c.scenarioId), streamFor(c), data);
}

export function progressOf(c) {
  const f = firstOpenTask(c);
  const tasks = BEATS.filter((b) => b.kind === 'task');
  return {
    status: c.demo.status,
    cursor: c.demo.cursor,
    done: Object.keys(c.demo.done),
    skipped: Object.keys(c.demo.skipped),
    tries: c.demo.tries,
    results: c.demo.results,
    frontier: f === -1 ? null : BEATS[f].id,
    tasksDone: tasks.filter((b) => isDone(c, b)).length,
    tasksTotal: tasks.length,
  };
}

export function demoState(c) {
  const ctx = ctxFor(c);
  return {
    id: c.id,
    case: caseSummary(c),
    steps: STEPS.map((title, i) => ({ n: i + 1, title })),
    beats: BEATS.map((b) => publicBeat(b, ctx)),
    progress: progressOf(c),
  };
}

function need(c, id) {
  const i = beatIndex.get(String(id));
  if (i === undefined) throw new HttpError(400, 'Unknown step.');
  if (!reachable(c, i)) {
    const f = BEATS[firstOpenTask(c)];
    throw new HttpError(409, `Complete "${f.title}" (step ${f.step}) first.`, { frontier: f.id });
  }
  return BEATS[i];
}

export function checkBeat(c, beatId, data, quiet) {
  const b = need(c, beatId);
  const d = c.demo;
  if (b.kind === 'info') {
    d.done[b.id] ||= Date.now();
    delete d.skipped[b.id];
    store.save();
    return { ok: true, message: '', progress: progressOf(c) };
  }
  const ctx = ctxFor(c, data && typeof data === 'object' ? data : {});
  const res = CHECKS[b.id](ctx);
  if (res.ok) {
    if (!d.done[b.id]) {
      d.tries[b.id] = (d.tries[b.id] || 0) + 1;
      d.done[b.id] = Date.now();
    }
    d.results[b.id] = { ok: true, message: res.message, items: res.items, ...(res.warn ? { warn: true } : {}) };
    if (b.id === BEATS[BEATS.length - 1].id) { d.status = 'completed'; d.completedAt ||= Date.now(); }
  } else if (!quiet) {
    if (!d.done[b.id]) {
      d.tries[b.id] = (d.tries[b.id] || 0) + 1;
      d.results[b.id] = { ok: false, message: res.message, items: res.items };
    }
  }
  store.save();
  // A task already passed stays passed: reviewing it later cannot undo it.
  const shown = d.done[b.id] && !res.ok ? { ok: false, message: res.message, items: res.items, alreadyDone: true } : res;
  return { ...shown, progress: progressOf(c) };
}

export function gotoBeat(c, beatId) {
  const b = need(c, beatId);
  c.demo.cursor = b.id;
  if (c.demo.status === 'paused' || c.demo.status === 'exited') c.demo.status = 'active';
  store.save();
  return progressOf(c);
}

export function skipBeat(c, beatId) {
  const b = need(c, beatId);
  if (b.kind === 'task') throw new HttpError(409, 'This task is checked before the demo can continue, so it cannot be skipped. You can pause or exit and come back to it.');
  if (!c.demo.done[b.id]) c.demo.skipped[b.id] = Date.now();
  store.save();
  return progressOf(c);
}

export function setStatus(c, status) {
  if (!['active', 'paused', 'exited'].includes(status)) throw new HttpError(400, 'Unknown status.');
  if (c.demo.status !== 'completed') c.demo.status = status;
  store.save();
  return progressOf(c);
}

// ---------------------------------------------------------------------------
// Learning summary
// ---------------------------------------------------------------------------
const PRACTICE = {
  2: 'Go over the five words again: event, alert, incident, case. Say out loud what each one is.',
  3: 'Open several log lines of different sources and find the same kinds of field in each.',
  4: 'Practise reading fields: for any log line, say who, from where, to what, and what happened.',
  5: 'Practise Log search: start with one field:value term, read the count, then add a second term.',
  6: 'For any event, ask how often, how fast and from where before deciding it is unusual.',
  7: 'Write the plain facts of an event before forming an opinion about it.',
  8: 'Re-read the four verdicts. Run the lookups before choosing, and base each answer on something you saw.',
  9: 'Pin only the lines your decision rests on, and make sure they cover each part of the claim.',
  10: 'A handoff should let the next tier start without repeating your work: system, indicators, priority, summary.',
  11: 'Link each finding to the one pinned event that shows it. If no event shows it, it is an assumption.',
  12: 'Separate what is confirmed from what is assumed, and choose the scope the evidence shows.',
  13: 'Match response actions to the confirmed scope: enough to stop the attacker, no more than the business needs to lose.',
  14: 'After any response, look for a log line that proves it worked, and one that proves normal work continues.',
  15: 'Root cause is the weakness that allowed it. Recommendations should be in proportion to what happened.',
};

export function summaryOf(c) {
  const scn = getScenario(c.scenarioId);
  tick(c);
  const d = c.demo;
  const closed = c.status === 'closed';
  const tasks = BEATS.filter((b) => b.kind === 'task' && b.step < 16);
  const stepRows = STEPS.map((title, i) => {
    const n = i + 1;
    const mine = BEATS.filter((b) => b.step === n);
    const req = mine.filter((b) => b.kind === 'task');
    const doneReq = req.filter((b) => d.done[b.id]);
    const touched = mine.some((b) => d.done[b.id] || d.skipped[b.id]);
    const status = req.length && doneReq.length === req.length ? 'Complete' : !req.length && mine.every((b) => d.done[b.id] || d.skipped[b.id]) ? 'Complete' : touched ? 'In progress' : 'Not started';
    return {
      n, title, status, first: BEATS.find((b) => b.step === n).id,
      tasks: req.length, tasksDone: doneReq.length,
      retries: req.reduce((a, b) => a + Math.max(0, (d.tries[b.id] || 0) - 1), 0),
      explanationsSkipped: mine.filter((b) => d.skipped[b.id] && !d.done[b.id]).length,
    };
  });

  const toolCount = {};
  for (const r of c.toolRuns) toolCount[r.tool] = (toolCount[r.tool] || 0) + 1;
  const tools = Object.entries(toolCount).map(([id, n]) => ({ label: TOOLS.find((x) => x.id === id)?.label || id, runs: n }));
  const okActions = c.actions.filter((a) => a.ok);
  const stagesDone = scn.stages.filter((s) => s.kind !== 'monitor' && c.stages[s.id].status === 'done');

  const did = [];
  if (c.ackAt && c.alert) did.push(`Acknowledged the alert ${Math.max(0, Math.round((c.ackAt - c.alert.firedAt) / 1000))} seconds after it fired and opened ticket ${c.ticket}.`);
  if (tools.length) did.push(`Ran ${c.toolRuns.length} lookup${c.toolRuns.length === 1 ? '' : 's'}: ${tools.map((x) => x.label).join(', ')}.`);
  if (c.pins.length) did.push(`Pinned ${c.pins.length} log event${c.pins.length === 1 ? '' : 's'} as evidence.`);
  if (stagesDone.length) did.push(`Completed ${stagesDone.length} workflow stage${stagesDone.length === 1 ? '' : 's'}: ${stagesDone.map((s) => s.label).join(', ')}.`);
  if (okActions.length) did.push(`Ran ${okActions.length} simulated response action${okActions.length === 1 ? '' : 's'}: ${okActions.map((a) => a.label).join(', ')}.`);
  if (closed) did.push('Closed the ticket and reviewed the after-action report.');

  const passedFirst = tasks.filter((b) => d.done[b.id] && (d.tries[b.id] || 1) <= 1).map((b) => ({ step: b.step, title: b.title, id: b.id }));
  const retried = tasks.filter((b) => d.done[b.id] && (d.tries[b.id] || 1) > 1).map((b) => ({ step: b.step, title: b.title, id: b.id, tries: d.tries[b.id] }));
  const open = tasks.filter((b) => !d.done[b.id]).map((b) => ({ step: b.step, title: b.title, id: b.id, tries: d.tries[b.id] || 0 }));

  const stageRows = scn.stages.filter((s) => s.weight).map((s) => {
    const st = c.stages[s.id];
    const fields = s.kind === 'form' && st.fields ? s.fields.filter((f) => f.type !== 'longtext' && st.fields[f.id]).map((f) => ({ label: f.label, tries: st.fields[f.id].tries || 1, accepted: st.fields[f.id].credit >= 0.999 })) : [];
    return {
      id: s.id, label: s.label, tier: s.tier, status: st.status,
      pct: st.status === 'done' && st.score?.max ? Math.round((st.score.earned / st.score.max) * 100) : null,
      submissions: st.attempts || (st.status === 'done' ? 1 : 0),
      fields,
      findings: st.evaluation?.findings?.map((f) => ({ action: f.action, reason: f.reason })) || [],
    };
  });

  const wentWell = [];
  if (passedFirst.length) wentWell.push(`${passedFirst.length} of ${tasks.length} guided checks passed on the first try.`);
  for (const s of stageRows) if (s.pct !== null && s.pct >= 90) wentWell.push(`${s.label}: answers accepted${s.submissions <= 1 ? ' at the first submission' : ''} (${s.pct}%).`);
  if (closed && !stageRows.some((s) => s.findings.length)) wentWell.push('The response stayed within the confirmed scope: no action caused avoidable disruption.');
  if (d.done['14-negative'] && d.done['14-positive'] && !d.results['14-positive']?.warn) wentWell.push('You proved the response from the logs with both a negative and a positive test.');

  const improve = [];
  const stepsRetried = [...new Set(retried.map((r) => r.step))];
  for (const n of stepsRetried) {
    const r = retried.filter((x) => x.step === n);
    improve.push(`Step ${n}, ${STEPS[n - 1]}: ${r.map((x) => `"${x.title}" took ${x.tries} tries`).join('; ')}. ${PRACTICE[n] || ''}`.trim());
  }
  for (const s of stageRows) {
    const slow = s.fields.filter((f) => f.tries > 1 || !f.accepted);
    if (slow.length) improve.push(`${s.label}: ${slow.map((f) => `${f.label} (${f.accepted ? `accepted at submission ${f.tries}` : 'not accepted'})`).join('; ')}.`);
    for (const f of s.findings) improve.push(`${s.label}: ${f.action}. ${f.reason}`);
  }
  for (const b of tasks) if (d.results[b.id]?.warn) improve.push(`Step ${b.step}, ${b.title}: ${d.results[b.id].message}`);
  if (!improve.length && closed) improve.push('Nothing needed a second try. Next, work without the guide.');

  const next = [];
  if (!closed) next.push('Resume the demo and finish the remaining steps.');
  next.push('Replay the demo and aim to pass every check on the first try without opening "Learn more".');
  next.push('Open the normal simulation and work a scenario with no guidance. Nothing there is explained in advance, each answer is final, and an alert that looks like this one can have a different explanation.');
  if (stepsRetried.includes(5) || stepsRetried.includes(11)) next.push('In a normal scenario, spend time in Log search before answering: field:value terms, exclusion with a leading minus, and the source buttons.');
  if (stepsRetried.includes(8) || stepsRetried.includes(6)) next.push('Before any verdict, check three things: who owns the source, where the account normally signs in from, and whether approved work explains it.');

  return {
    label: 'Guided learning summary',
    disclaimer: 'This is a record of guided practice on a sample scenario. You were coached and could retry, so it is not an independent assessment and not a certification. It does not change any score in the normal simulation.',
    complete: closed,
    status: d.status,
    ticket: c.ticket,
    analyst: c.analyst,
    startedAt: d.startedAt,
    finishedAt: c.closedAt,
    minutes: c.closedAt ? Math.max(1, Math.round((c.closedAt - d.startedAt) / 60000)) : null,
    guidedResult: closed ? totalScore(c) : null,
    steps: stepRows,
    did,
    evidence: {
      pins: [...c.pins].sort((a, b) => a.snapshot.ts - b.snapshot.ts).map((p) => ({ ts: p.snapshot.ts, source: p.snapshot.source, host: p.snapshot.host, raw: p.snapshot.raw, note: p.note })),
      indicators: c.iocs.map((i) => ({ type: i.type, value: i.value })),
      tools,
    },
    checks: { total: tasks.length, passedFirst, retried, open },
    stages: stageRows.map(({ fields, findings, ...s }) => s),
    wentWell,
    improve,
    next,
  };
}
