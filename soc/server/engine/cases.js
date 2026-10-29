// Case lifecycle and workflow state machine.
//
// A case moves through the scenario's ordered stages. Every transition,
// decision, tool run and response action is appended to case.history and
// never rewritten. What the analyst is sent is built field-by-field in
// publicCase(); scenario answer keys live under `key` / `secret` and are
// only read by the grading functions.

import crypto from 'node:crypto';
import { store } from '../store.js';
import { getScenario } from '../scenarios/index.js';
import { LogStream, publicEvent } from './logstream.js';
import { rng } from './rng.js';
import { publicDirectory } from './env.js';
import { gradeField, validateField, verdictOf, describeValue, describeExpected } from './grading.js';
import { deriveState, executeAction, publicResponse, evaluateResponse, HttpError } from './response.js';
import { TOOLS, runTool } from './tools.js';
import { buildReport } from './report.js';
import { buildAlias, IDENTITY } from './alias.js';
import * as aliasModule from './alias.js';
import { levelById } from '../levels.js';

const streams = new Map();
const aliases = new Map();
// When each stream was last used. A stream is rebuilt from the case's seed on demand, so one that
// belongs to a closed case, or that nobody has touched for two hours, can be dropped (every live
// stream keeps up to six hours of events in memory).
const streamUsed = new Map();
const STREAM_IDLE_MS = 2 * 3600 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
// Hooks set by the attempt layer (server/attempts.js) so this module does
// not depend on it.
export const hooks = { onClose: null, onChange: null };
// Read-only sample tickets for the homepage walkthrough. Held in memory
// only: they are never written to the case store and never listed.
const ephemeral = new Map();
const TIER_NUM = { L1: 1, L2: 2, L3: 3 };
const DECAY = [1, 0.7, 0.4];
// Per-case growth bounds. Every list an analyst can append to is capped
// (oldest entry dropped, like `searches`), every free-text value is sliced,
// and a write that would still push the serialised case past CASE_MAX_BYTES
// is refused with 413 and rolled back. Normal use stays far below all of
// these; they exist so one case cannot grow the store without limit.
const TOOL_RUNS_MAX = 400;
const HISTORY_MAX = 1000;
const IOCS_MAX = 100;
const DRAFT_TEXT_MAX = 2000;
const DRAFT_ITEM_TEXT_MAX = 500;
const DRAFT_LIST_MAX = 50;
const DRAFT_KEYS_MAX = 50;
const CASE_MAX_BYTES = 512 * 1024;

/** Refuses (413) a case whose serialised form exceeds CASE_MAX_BYTES. */
export function assertCaseSize(c) {
  if (JSON.stringify(c).length > CASE_MAX_BYTES) {
    throw new HttpError(413, 'case_too_large', { message: 'This case file is full. Remove notes, indicators or pinned events before adding more.' });
  }
}
// Runs the size check after a write; when it trips the write is undone
// before the error propagates, so the stored case never exceeds the cap.
function commit(c, undo) {
  try { assertCaseSize(c); } catch (err) { undo(); throw err; }
  store.save();
}

export function getCase(id) {
  const c = store.get(id) || ephemeral.get(id);
  if (!c) throw new HttpError(404, 'Case not found.');
  return c;
}

// The alias map of a level attempt (identity for demo and preview cases).
export function aliasFor(c) {
  if (!c.variant || c.variant.canonical) return IDENTITY;
  let a = aliases.get(c.id);
  if (!a) {
    a = buildAlias(c.variant.seed, getScenario(c.scenarioId).entities || {});
    aliases.set(c.id, a);
  }
  return a;
}

export function streamFor(c) {
  let s = streams.get(c.id);
  if (!s) {
    s = new LogStream(c, getScenario(c.scenarioId), aliasFor(c));
    streams.set(c.id, s);
  }
  streamUsed.set(c.id, Date.now());
  return s;
}

/** Drops the in-memory streams (and alias maps) of closed, removed or idle cases. Returns how many went. */
export function sweepStreams(now = Date.now()) {
  let dropped = 0;
  for (const id of [...streams.keys()]) {
    const c = store.get(id) || ephemeral.get(id);
    const idle = now - (streamUsed.get(id) || 0) > STREAM_IDLE_MS;
    if (c && c.status !== 'closed' && !idle) continue;
    streams.delete(id);
    streamUsed.delete(id);
    if (!c || c.status === 'closed') aliases.delete(id);
    dropped++;
  }
  return dropped;
}
const sweeper = setInterval(() => { try { sweepStreams(); } catch (err) { console.error(err); } }, SWEEP_EVERY_MS);
sweeper.unref?.();

// Level rules for this case: rounds, decay and hint policy. Demo and
// preview cases keep the scenario's own settings.
export function rulesFor(c) {
  const lv = c.level ? levelById(c.level) : null;
  return lv ? { rounds: lv.rounds, decay: lv.decay, hints: lv.hints, hintCap: lv.hintCap ?? 1 } : null;
}
const roundsOf = (c, def) => rulesFor(c)?.rounds ?? (def.attempts || 1);
const decayOf = (c) => rulesFor(c)?.decay ?? DECAY;

const stageDef = (scn, id) => scn.stages.find((s) => s.id === id);
const currentDef = (c) => stageDef(getScenario(c.scenarioId), c.stage);

function log(c, actor, kind, text, extra = {}) {
  c.history.push({ ts: extra.ts ?? Date.now(), actor, kind, text, stage: c.stage, ...(extra.data ? { data: extra.data } : {}) });
  if (c.history.length > HISTORY_MAX) c.history.shift();
  c.rev++;
}
// Undoes the last log() call (for a write that is rolled back).
function unlog(c) {
  c.history.pop();
  c.rev--;
}
const actorOf = (c) => {
  const def = currentDef(c);
  return `${def?.tier || 'L1'} analyst (${c.analyst})`;
};

// `kind` is set only by the guided-demo and walkthrough modules, never from
// a request body. Without it the case is an ordinary assessment case and
// hidden (demo-only) scenarios are refused.
export function createCase({ scenarioId, analyst, kind, backdateSeconds = 0, userId, attempt }) {
  const scn = getScenario(scenarioId);
  if (!scn || (scn.hidden && !kind) || (kind && !scn.hidden)) throw new HttpError(400, 'Unknown scenario.');
  if (!kind && !attempt) throw new HttpError(400, 'use_attempts', { message: 'Level scenarios are started through POST /api/attempts.' });
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  let ticket;
  if (kind === 'preview') ticket = `SAMPLE-${year}-0001`;
  else if (kind === 'demo') ticket = `DEMO-${year}-${String(store.nextSeq('demo')).padStart(4, '0')}`;
  else ticket = `INC-${year}-${String(store.nextSeq()).padStart(5, '0')}`;
  const c = {
    id: crypto.randomBytes(6).toString('hex'),
    ticket,
    ...(kind ? { kind } : {}),
    scenarioId,
    seed: attempt ? String(attempt.seed) : crypto.randomBytes(8).toString('hex'),
    t0: now - backdateSeconds * 1000,
    ...(userId ? { userId } : {}),
    ...(attempt ? { attemptId: attempt.attemptId, level: scn.level, code: scn.code, variant: { seed: attempt.seed, canonical: !!attempt.canonical } } : {}),
    hints: {},
    searches: [],
    analyst: String(analyst || 'analyst').trim().slice(0, 40) || 'analyst',
    status: 'monitoring',
    stage: scn.stages[0].id,
    stages: Object.fromEntries(scn.stages.map((s, i) => [s.id, { status: i === 0 ? 'active' : 'pending', ...(i === 0 ? { startedAt: now } : {}) }])),
    severity: null,
    alert: null,
    relatedAlerts: [],
    relatedChecked: [],
    history: [],
    pins: [],
    iocs: [],
    toolRuns: [],
    actions: [],
    injected: [],
    rev: 0,
    closedAt: null,
    report: null,
  };
  log(c, 'System', 'system', `Shift started. Monitoring the ${scn.catalog.queue} queue.`, { ts: c.t0 });
  if (attempt && !attempt.canonical) c.aliasMap = aliasFor(c).pairs;
  if (kind === 'preview') ephemeral.set(c.id, c); else store.put(c);
  streamFor(c);
  return c;
}

// Time-driven events: alert firing. Called on every request and stream tick.
export function tick(c, now = Date.now()) {
  if (c.status === 'closed') return;
  const scn = getScenario(c.scenarioId);
  const stream = streamFor(c);
  stream.ensure(now);
  const before = c.rev;
  if (!c.alert && now >= c.t0 + scn.alert.at * 1000) {
    const firedAt = c.t0 + scn.alert.at * 1000;
    c.alert = { ...scn.alert.build(stream, c), firedAt };
    log(c, 'SIEM', 'alert', `Alert ${c.alert.rule} fired: ${c.alert.title}`, { ts: firedAt });
  }
  for (const ra of scn.relatedAlerts || []) {
    const due = c.t0 + ra.at * 1000;
    if (!c.alert || c.relatedChecked.includes(ra.id) || now < due) continue;
    c.relatedChecked.push(ra.id);
    c.rev++;
    if (ra.when(deriveState(c.actions, due), c)) {
      const a = { ...ra.build(stream, c), firedAt: due };
      c.relatedAlerts.push(a);
      log(c, 'SIEM', 'alert', `Related alert ${a.rule} fired and was linked to this ticket: ${a.title}`, { ts: due });
    }
  }
  if (c.rev !== before) store.save();
}

// ---------------------------------------------------------------------------
// Public (analyst-facing) views
// ---------------------------------------------------------------------------
function publicField(f, c, stream, st) {
  const { key, skills, ...pub } = f;
  if (f.type === 'checks') pub.items = key.checks.map((ch) => ({ id: ch.id, label: ch.label, done: !!ch.test(c, stream) }));
  if (f.type === 'order') {
    const r = rng(c.seed, 'order', f.id);
    pub.items = f.items.map((it) => [r.f(), it]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  // Level attempts show options in a per-attempt order; option ids are stable.
  if (c.variant && !c.variant.canonical && Array.isArray(f.options) && ['single', 'multi'].includes(f.type)) {
    const r = rng(c.seed, 'options', f.id);
    pub.options = f.options.map((o) => [r.f(), o]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  // Intermediate: a hint can be requested per question. Its text is only
  // sent once requested.
  const rules = rulesFor(c);
  if (rules?.hints === 'request' && f.key?.hint && f.type !== 'longtext') {
    pub.hintAvailable = true;
    if (c.hints?.[st?.id]?.includes(f.id)) pub.hintText = f.key.hint;
  }
  return pub;
}

function fieldFeedback(def, st) {
  if (!st.fields) return null;
  return def.fields.filter((f) => st.fields[f.id]).map((f) => {
    const fs = st.fields[f.id];
    return {
      id: f.id,
      verdict: verdictOf(fs.credit),
      locked: !!fs.locked,
      supported: f.linkable ? !!fs.supported : undefined,
      message: fs.message,
    };
  });
}

function publicStage(c, def, stream) {
  const st = c.stages[def.id];
  const out = {
    id: def.id, label: def.label, tier: def.tier, kind: def.kind, intro: def.intro,
    attempts: roundsOf(c, def), attemptsUsed: st.attempts || 0, submitLabel: def.submitLabel,
    ...(def.noFinalize ? { noFinalize: true } : {}),
    ...(rulesFor(c) ? { hintPolicy: rulesFor(c).hints } : {}),
  };
  if (def.kind === 'form') {
    out.fields = def.fields.map((f) => publicField(f, c, stream, { id: def.id }));
    out.draft = st.draft || { values: {}, links: {} };
    out.feedback = fieldFeedback(def, st);
  }
  if (def.kind === 'response') out.response = publicResponse(c);
  return out;
}

// Verdicts on a completed stage. Shows what the analyst answered and whether
// it was accepted; never what the accepted answer is.
function stageReview(def, st) {
  return def.fields.filter((f) => f.type !== 'longtext' && st.fields?.[f.id]).map((f) => {
    const fs = st.fields[f.id];
    return {
      label: f.label,
      answer: f.type === 'checks' ? undefined : describeValue(f, fs.value),
      verdict: verdictOf(fs.credit),
      supported: f.linkable ? !!fs.supported : undefined,
      detail: fs.detail,
    };
  });
}

function metrics(c) {
  const m = [];
  const st = c.stages;
  const d = (a, b) => (a && b ? Math.max(0, Math.round((b - a) / 1000)) : null);
  if (c.alert) m.push({ id: 'tta', label: 'Time to acknowledge', seconds: d(c.alert.firedAt, c.ackAt) });
  const first = Object.entries(st).find(([id, s]) => id !== 'monitoring' && s.completedAt);
  if (first) m.push({ id: 'ttt', label: 'Time to triage decision', seconds: d(c.ackAt, first[1].completedAt) });
  if (c.containedAt) m.push({ id: 'ttc', label: 'Time to contain', seconds: d(c.alert?.firedAt, c.containedAt) });
  if (c.closedAt) m.push({ id: 'ttr', label: 'Time to close', seconds: d(c.alert?.firedAt, c.closedAt) });
  return m;
}

// Stage percentage, including the collateral-action deduction on response
// stages (5 points each, at most 20).
export function stagePct(st) {
  if (!st?.score) return 0;
  const raw = st.score.max ? (st.score.earned / st.score.max) * 100 : 0;
  return Math.max(0, raw - (st.collateralPenalty || 0));
}

// Scenario score: weighted mean of reachable stages, rounded half up. A
// stage skipped because of a correct earlier decision is left out; a stage
// missed because of a wrong decision (st.missed) counts as zero.
export function totalScore(c) {
  const scn = getScenario(c.scenarioId);
  let w = 0;
  let got = 0;
  for (const def of scn.stages) {
    const st = c.stages[def.id];
    if (!def.weight) continue;
    if (st.missed) { w += def.weight; continue; }
    if (st.status !== 'done' || !st.score) continue;
    w += def.weight;
    got += def.weight * (stagePct(st) / 100);
  }
  return w ? Math.floor((got / w) * 100 + 0.5 + 1e-9) : null;
}

export function caseSummary(c) {
  const scn = getScenario(c.scenarioId);
  const def = stageDef(scn, c.stage);
  return {
    id: c.id, ticket: c.ticket, ...(c.kind ? { kind: c.kind } : {}), scenarioId: c.scenarioId, scenarioTitle: scn.catalog.title,
    title: c.alert ? c.alert.title : 'Monitoring',
    analyst: c.analyst, status: c.status, stage: c.stage, stageLabel: def?.label, tier: def?.tier,
    severity: c.severity || c.alert?.severity || null,
    createdAt: c.t0, closedAt: c.closedAt, score: c.status === 'closed' ? totalScore(c) : null,
  };
}

export function publicCase(c) {
  const scn = getScenario(c.scenarioId);
  const stream = streamFor(c);
  const def = stageDef(scn, c.stage);
  const tier = TIER_NUM[def?.tier] || 1;
  const open = c.status === 'open';
  const pub = {
    ...caseSummary(c),
    rev: c.rev,
    serverTime: Date.now(),
    environment: scn.catalog.environment,
    sources: scn.catalog.sources,
    alert: c.status === 'monitoring' && !c.alert ? null : c.alert,
    relatedAlerts: c.relatedAlerts,
    stages: scn.stages.map((s) => ({
      id: s.id, label: s.label, tier: s.tier, status: c.stages[s.id].status,
      score: c.stages[s.id].score && c.stages[s.id].status === 'done' && s.weight
        ? { pct: Math.round(stagePct(c.stages[s.id])) } : null,
      ...(c.stages[s.id].missed ? { missed: true } : {}),
      result: c.stages[s.id].status === 'done' ? c.stages[s.id].result : undefined,
      review: c.stages[s.id].status === 'done' && s.kind === 'form' ? stageReview(s, c.stages[s.id]) : undefined,
    })),
    current: c.status === 'closed' ? null : publicStage(c, def, stream),
    tools: TOOLS.map((t) => ({ ...t, available: open && tier >= t.tier })),
    pins: c.pins.map((p) => ({ eventId: p.eventId, note: p.note, at: p.at, by: p.by, event: p.snapshot })),
    iocs: c.iocs,
    history: c.history,
    directory: publicDirectory(),
    metrics: metrics(c),
    report: c.status === 'closed' ? c.report : null,
    ...(c.attemptId ? { attemptId: c.attemptId, level: c.level, code: c.code, rules: rulesFor(c) } : {}),
  };
  return c.kind === 'preview' ? redactPreview(pub) : pub;
}

// A walkthrough preview is worked by the server so the tour has something
// to point at. What it shows is cut back to what the alert itself already
// displays, so touring the interface cannot give away the guided demo.
const PREVIEW_NOTE = 'Sample layout only. In your own ticket this section shows your answers, the expected answers and the reasons.';
function redactPreview(pub) {
  const shown = new Set(pub.alert?.matched || []);
  const alertText = JSON.stringify(pub.alert?.details || []);
  const short = (h) => {
    if (h.kind === 'system' || h.kind === 'alert') return h.text;
    if (h.kind === 'stage') return `${h.text.split('. ')[0].replace(/\.$/, '')}.`;
    if (h.kind === 'note') return 'Analyst note recorded.';
    return `${h.text.split(/[:.]/)[0]}.`;
  };
  return {
    ...pub,
    readOnly: true,
    stages: pub.stages.map(({ review, ...s }) => s),
    pins: pub.pins.filter((p) => shown.has(p.eventId)).map((p) => ({ ...p, note: '' })),
    iocs: pub.iocs.filter((i) => alertText.includes(i.value)),
    history: pub.history.filter((h) => h.kind !== 'qa').map(({ data, ...h }) => ({ ...h, text: short(h) })),
    report: pub.report ? {
      score: pub.report.score, band: pub.report.band, generatedAt: pub.report.generatedAt, sample: true,
      stages: pub.report.stages.map((s) => ({ id: s.id, label: s.label, tier: s.tier, weight: s.weight, pct: s.pct, seconds: s.seconds, attempts: s.attempts, skipped: s.skipped })),
      truth: { summary: PREVIEW_NOTE, timeline: [], iocs: [] },
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Analyst operations
// ---------------------------------------------------------------------------
const READ_ONLY = 'This is a read-only sample ticket used by the walkthrough. Start the Newbie Demo or a shift to work a ticket yourself.';
function requireOpen(c) {
  if (c.readOnly) throw new HttpError(403, READ_ONLY);
  if (c.status === 'closed') throw new HttpError(409, 'This ticket is closed. The case file is read-only.');
  if (c.status === 'monitoring') throw new HttpError(409, 'Acknowledge the alert to open a ticket first.');
}

function enterStage(c, id, now) {
  c.stage = id;
  c.stages[id].status = 'active';
  c.stages[id].startedAt = now;
}

export function acknowledge(c) {
  if (c.readOnly) throw new HttpError(403, READ_ONLY);
  if (c.status !== 'monitoring') throw new HttpError(409, 'The alert has already been acknowledged.');
  if (!c.alert) throw new HttpError(409, 'There is no alert in the queue yet.');
  const scn = getScenario(c.scenarioId);
  const now = Date.now();
  c.ackAt = now;
  c.status = 'open';
  c.severity = c.alert.severity;
  c.stages[c.stage].status = 'done';
  c.stages[c.stage].completedAt = now;
  log(c, `L1 analyst (${c.analyst})`, 'stage', `Alert acknowledged ${Math.round((now - c.alert.firedAt) / 1000)}s after firing. Ticket ${c.ticket} opened and assigned to Tier 1.`, { ts: now });
  enterStage(c, scn.stages[1].id, now);
  store.save();
}

export function pinEvent(c, eventId, note) {
  requireOpen(c);
  const ev = streamFor(c).get(eventId);
  if (!ev) throw new HttpError(404, 'That event is no longer available.');
  const existing = c.pins.find((p) => p.eventId === eventId);
  if (existing) {
    const before = existing.note;
    existing.note = String(note ?? existing.note ?? '').slice(0, 400);
    c.rev++;
    commit(c, () => { existing.note = before; c.rev--; });
  } else {
    c.pins.push({ eventId, note: String(note || '').slice(0, 400), at: Date.now(), by: actorOf(c), snapshot: publicEvent(ev) });
    log(c, actorOf(c), 'evidence', `Pinned ${ev.source} event from ${ev.host} as evidence.`, { data: { eventId, raw: ev.raw } });
    commit(c, () => { unlog(c); c.pins.pop(); });
  }
}

export function unpinEvent(c, eventId) {
  requireOpen(c);
  const i = c.pins.findIndex((p) => p.eventId === eventId);
  if (i < 0) return;
  const [p] = c.pins.splice(i, 1);
  log(c, actorOf(c), 'evidence', `Removed pinned ${p.snapshot.source} event from ${p.snapshot.host}.`, { data: { eventId } });
  store.save();
}

const IOC_TYPES = ['domain', 'ip', 'sha256', 'url', 'email', 'file'];
export function addIoc(c, { type, value }, quiet = false) {
  if (!quiet) requireOpen(c);
  const v = String(value || '').trim().slice(0, 300);
  if (!v) throw new HttpError(400, 'Enter an indicator value.');
  const t = IOC_TYPES.includes(type) ? type : guessIocType(v);
  if (c.iocs.some((i) => i.value.toLowerCase() === v.toLowerCase())) return false;
  c.iocs.push({ type: t, value: v, at: Date.now(), by: actorOf(c) });
  if (c.iocs.length > IOCS_MAX) c.iocs.shift();
  // Quiet adds come from submit() (bounded by the form and IOCS_MAX) and
  // must not fail a submission half-way through.
  if (quiet) { c.rev++; store.save(); return true; }
  log(c, actorOf(c), 'evidence', `Added indicator to the case: ${t} ${v}`);
  commit(c, () => { unlog(c); c.iocs.pop(); });
  return true;
}

export function guessIocType(v) {
  if (/^[a-f0-9]{64}$/i.test(v)) return 'sha256';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return 'ip';
  if (/^[a-z]+:\/\//i.test(v)) return 'url';
  if (/^[^@\s]+@[^@\s]+$/.test(v)) return 'email';
  if (/\.(exe|dll|ps1|xlsm|docm|zip|7z|js|vbs|bat|lnk)$/i.test(v)) return 'file';
  return 'domain';
}

export function removeIoc(c, value) {
  requireOpen(c);
  const i = c.iocs.findIndex((x) => x.value.toLowerCase() === String(value).toLowerCase());
  if (i < 0) return;
  const [x] = c.iocs.splice(i, 1);
  log(c, actorOf(c), 'evidence', `Removed indicator from the case: ${x.value}`);
  store.save();
}

export function addNote(c, text) {
  requireOpen(c);
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new HttpError(400, 'Write a note first.');
  log(c, actorOf(c), 'note', t);
  commit(c, () => unlog(c));
}

// A draft is kept in the shape the form produces (strings, lists of ids,
// lists of small objects such as ioc_list entries) but every piece is
// bounded and anything else is dropped.
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function draftItem(v) {
  if (typeof v === 'string') return v.slice(0, DRAFT_TEXT_MAX);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (isPlain(v)) {
    return Object.fromEntries(Object.entries(v).slice(0, 10).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k.slice(0, 50), x.slice(0, DRAFT_ITEM_TEXT_MAX)]));
  }
  return undefined;
}
function draftValue(v) {
  if (Array.isArray(v)) return v.slice(0, DRAFT_LIST_MAX).map(draftItem).filter((x) => x !== undefined);
  return draftItem(v);
}
function draftLinks(v) {
  if (!Array.isArray(v)) return undefined;
  return v.slice(0, DRAFT_LIST_MAX).filter((x) => typeof x === 'string').map((x) => x.slice(0, DRAFT_ITEM_TEXT_MAX));
}
export function cleanDraft(def, values, links) {
  const vals = isPlain(values) ? values : {};
  const lnks = isPlain(links) ? links : {};
  const ids = Array.isArray(def?.fields) ? def.fields.map((f) => f.id) : Object.keys(vals).slice(0, DRAFT_KEYS_MAX);
  const out = { values: {}, links: {} };
  for (const id of ids) {
    if (Object.hasOwn(vals, id)) { const v = draftValue(vals[id]); if (v !== undefined) out.values[id] = v; }
    if (Object.hasOwn(lnks, id)) { const l = draftLinks(lnks[id]); if (l !== undefined) out.links[id] = l; }
  }
  return out;
}

export function saveDraft(c, { values = {}, links = {} }) {
  requireOpen(c);
  const def = currentDef(c);
  if (def.kind !== 'form') return;
  const st = c.stages[c.stage];
  const before = st.draft;
  st.draft = cleanDraft(def, values, links);
  commit(c, () => { st.draft = before; });
}

export function tool(c, id, body) {
  requireOpen(c);
  const def = currentDef(c);
  const ctx = { c, scenario: getScenario(c.scenarioId), stream: streamFor(c), tier: TIER_NUM[def.tier] || 1, visibleInput: body?._visibleInput };
  ctx.stream.ensure();
  const { def: tdef, input, filter, result } = runTool(ctx, id, body || {});
  c.toolRuns.push({ ts: Date.now(), tool: id, input: input.toLowerCase(), filter: filter.toLowerCase(), stage: c.stage });
  if (c.toolRuns.length > TOOL_RUNS_MAX) c.toolRuns.shift();
  log(c, actorOf(c), 'tool', `${tdef.label}${input ? `: ${input.length > 90 ? `${input.slice(0, 90)}…` : input}` : ''}`);
  commit(c, () => { unlog(c); c.toolRuns.pop(); });
  return result;
}

export function action(c, body) {
  requireOpen(c);
  const def = currentDef(c);
  if (def.kind !== 'response') throw new HttpError(403, 'Response actions need incident-response (Tier 3) authority. They become available once the incident is handed to L3.');
  const scn = getScenario(c.scenarioId);
  const stream = streamFor(c);
  const now = Date.now();
  stream.ensure(now);
  const { rec, logs } = executeAction(c, stream, scn, body || {}, now);
  c.actions.push(rec);
  logs.forEach((e) => c.injected.push({ id: `x${c.injected.length + 1}`, ts: e.ts, source: e.source, host: e.host, raw: e.raw, fields: e.fields }));
  stream.ensure(now);
  log(c, actorOf(c), 'action', `${rec.label}: ${rec.targetLabel}. ${rec.summary}`, { ts: now, data: { actionId: rec.id, ok: rec.ok } });
  if (rec.impact) log(c, 'IT Operations', 'system', rec.impact, { ts: now + 1 });
  if (!c.containedAt && scn.secret.response.contained && scn.secret.response.contained(deriveState(c.actions))) c.containedAt = now;
  store.save();
  const { matched, ...pub } = rec;
  return pub;
}

// ---------------------------------------------------------------------------
// Stage submission and grading
// ---------------------------------------------------------------------------
function summarise(def, values) {
  const parts = [];
  for (const f of def.fields) {
    if (!f.summary) continue;
    parts.push(`${f.summary}: ${describeValue(f, values[f.id])}`);
  }
  return parts.join(' | ');
}

function gradeForm(c, def, st, values, links, stream) {
  st.attempts = (st.attempts || 0) + 1;
  const decay = decayOf(c);
  const factor = decay[Math.min(st.attempts - 1, decay.length - 1)];
  st.fields ||= {};
  const pinned = new Set(c.pins.map((p) => p.eventId));
  const maxAttempts = roundsOf(c, def);
  const rules = rulesFor(c);
  const hinted = new Set(c.hints?.[def.id] || []);
  for (const f of def.fields) {
    const fs = (st.fields[f.id] ||= { credit: 0, best: 0, locked: false });
    if (!fs.locked) {
      const g = gradeField(f, values[f.id], { stream, case: c });
      fs.tries = (fs.tries || 0) + 1;
      fs.value = values[f.id];
      fs.credit = g.credit;
      if (fs.firstCredit === undefined) fs.firstCredit = g.credit;
      let earned = g.credit * factor;
      if (hinted.has(f.id) && rules?.hintCap !== undefined) { earned = Math.min(earned, rules.hintCap); fs.hinted = true; }
      fs.best = Math.max(fs.best, earned);
      fs.detail = g.detail;
      if (g.credit >= 0.999) fs.locked = maxAttempts > 1;
    }
    if (f.linkable) {
      const l = (links[f.id] || []).filter((id) => pinned.has(id));
      fs.links = l;
      fs.supported = l.some((id) => (stream.get(id)?._tags || []).some((t) => (f.key.support || []).includes(t)));
    }
    const msgs = [];
    const v = verdictOf(fs.credit);
    if (fs.detail) msgs.push(fs.detail);
    // Teaching scenarios may attach coaching to a specific wrong answer and
    // give the answer away after repeated tries. Assessment scenarios define
    // neither, so they keep the single generic hint.
    const coach = v === 'correct' ? null : coachFor(f, fs.value);
    if (coach) msgs.push(coach);
    // Automatic hints: Foundations, the demo and legacy cases only.
    else if (v === 'incorrect' && f.key?.hint && st.attempts < maxAttempts && (!rules || rules.hints === 'auto')) { msgs.push(f.key.hint); fs.hintShown = true; }
    if (v !== 'correct' && f.key?.reveal && fs.tries >= 3) msgs.push(`Shown after three tries: ${f.key.reveal}`);
    if (f.linkable && v === 'correct' && !fs.supported) msgs.push('Accepted, but the linked evidence does not corroborate it. Link the pinned event that shows this.');
    fs.message = msgs.join(' ') || undefined;
  }
  // Every round is kept for the attempt record (canonical values).
  (st.rounds ||= []).push({
    round: st.attempts, at: new Date().toISOString(),
    values: Object.fromEntries(def.fields.filter((f) => f.type !== 'checks').map((f) => [f.id, values[f.id]])),
    credit: Object.fromEntries(def.fields.map((f) => [f.id, +(st.fields[f.id]?.credit ?? 0).toFixed(3)])),
  });
}

export function coachFor(f, value) {
  const k = f.key?.coach;
  if (!k) return null;
  if (typeof k === 'function') return k(value) || null;
  return k[String(value ?? '').toLowerCase()] || null;
}

function scoreForm(def, st) {
  let earned = 0;
  let max = 0;
  for (const f of def.fields) {
    const pts = f.points || 0;
    max += pts;
    const fs = st.fields?.[f.id];
    if (!fs) continue;
    fs.earned = +(pts * fs.best * (f.linkable && !fs.supported ? 0.7 : 1)).toFixed(2);
    earned += fs.earned;
  }
  return { earned: +earned.toFixed(2), max };
}

export function submit(c, body = {}) {
  requireOpen(c);
  const scn = getScenario(c.scenarioId);
  const def = currentDef(c);
  const st = c.stages[c.stage];
  const stream = streamFor(c);
  const now = Date.now();
  stream.ensure(now);
  const actor = actorOf(c);
  let values = {};
  const blocked = scn.guard?.(def.id, c);
  if (blocked) throw new HttpError(409, blocked);
  const finalize = !!body.finalize && !def.noFinalize;

  if (def.kind === 'form') {
    values = { ...(body.values || {}) };
    const links = body.links || {};
    // Locked (already-correct) answers keep their accepted value.
    for (const f of def.fields) if (st.fields?.[f.id]?.locked) values[f.id] = st.fields[f.id].value;
    const problems = def.fields.map((f) => validateField(f, values[f.id])).filter(Boolean);
    if (problems.length) throw new HttpError(400, 'The form is incomplete.', { problems });
    st.draft = { values, links };
    gradeForm(c, def, st, values, links, stream);
    const allCorrect = def.fields.every((f) => verdictOf(st.fields[f.id].credit) === 'correct' && (!f.linkable || st.fields[f.id].supported));
    const rounds = roundsOf(c, def);
    const complete = rounds <= 1 || finalize || allCorrect || st.attempts >= rounds;
    if (!complete) {
      const right = def.fields.filter((f) => verdictOf(st.fields[f.id].credit) === 'correct').length;
      log(c, actor, 'stage', `${def.label}: findings submitted for review (attempt ${st.attempts} of ${rounds}). ${right} of ${def.fields.length} accepted.`, { ts: now });
      store.save();
      return { complete: false, attemptsLeft: rounds - st.attempts };
    }
    st.score = scoreForm(def, st);
    st.submission = { values, links };
    for (const f of def.fields) {
      if (f.type === 'ioc_list') for (const i of values[f.id] || []) addIoc(c, i, true);
      if (f.sets === 'severity' && values[f.id]) c.severity = values[f.id];
    }
    const sum = summarise(def, values);
    log(c, actor, 'stage', `${def.label} submitted.${sum ? ` ${sum}` : ''}`, { ts: now });
    for (const f of def.fields) {
      if (f.type === 'longtext' && values[f.id]) log(c, actor, 'note', `${f.label}: ${String(values[f.id]).trim()}`, { ts: now });
    }
  } else if (def.kind === 'response') {
    const ev = evaluateResponse(c, scn, stream);
    st.score = { earned: Math.max(0, +(ev.earned - ev.penalty).toFixed(2)), max: ev.max };
    st.evaluation = ev;
    st.collateral = ev.collateral;
    st.collateralPenalty = Math.min(20, 5 * ev.collateral);
    const done = c.actions.filter((a) => a.ok).length;
    log(c, actor, 'stage', `${def.label} declared complete with ${done} action${done === 1 ? '' : 's'} executed. Handed over for closure review.`, { ts: now });
  } else {
    throw new HttpError(409, 'Nothing to submit at this stage.');
  }

  st.status = 'done';
  st.completedAt = now;

  // Decide where the ticket goes next. Scenarios may branch or override.
  const order = scn.stages.map((s) => s.id);
  const flow = (scn.flow && scn.flow(def.id, { values, c })) || {};
  if (flow.result) st.result = flow.result;
  for (const n of flow.notes || []) log(c, n.actor, 'qa', n.text, { ts: now + 1 });
  const nextId = flow.next !== undefined ? flow.next : order[order.indexOf(def.id) + 1];
  // Stages passed over because of a wrong decision count as zero.
  for (const m of flow.missed || []) if (c.stages[m]) c.stages[m].missed = true;

  if (def.final || !nextId) {
    c.status = 'closed';
    c.closedAt = now;
    for (const s of scn.stages) if (c.stages[s.id].status === 'pending') c.stages[s.id].status = 'skipped';
    log(c, 'System', 'system', `Ticket ${c.ticket} closed.`, { ts: now + 2 });
    c.report = buildReport(c, scn, stream, totalScore(c));
    if (hooks.onClose) {
      const extra = hooks.onClose(c);
      if (extra) Object.assign(c.report, extra);
    }
  } else {
    for (let i = order.indexOf(def.id) + 1; i < order.indexOf(nextId); i++) c.stages[order[i]].status = 'skipped';
    const nd = stageDef(scn, nextId);
    enterStage(c, nextId, now);
    if (nd.tier !== def.tier) log(c, 'System', 'system', `Ticket reassigned from ${def.tier} to ${nd.tier}: ${nd.label}.`, { ts: now + 2 });
  }
  store.save();
  return { complete: true };
}

// Intermediate: the analyst asks for a hint on one question.
export function requestHint(c, stageId, fieldId) {
  requireOpen(c);
  const rules = rulesFor(c);
  if (!rules || rules.hints !== 'request') throw new HttpError(403, 'hints_off', { message: rules?.hints === 'auto' ? 'At this level hints appear automatically under a wrong answer.' : 'Hints are not available at this level.' });
  if (stageId !== c.stage) throw new HttpError(409, 'stage_closed', { message: 'That stage is not open.' });
  const def = currentDef(c);
  const f = def.kind === 'form' && def.fields.find((x) => x.id === fieldId);
  if (!f || !f.key?.hint) throw new HttpError(404, 'no_hint', { message: 'No hint exists for that question.' });
  if (c.stages[c.stage].fields?.[fieldId]?.locked) throw new HttpError(409, 'stage_closed', { message: 'That question is already accepted.' });
  c.hints ||= {};
  const list = (c.hints[stageId] ||= []);
  if (!list.includes(fieldId)) {
    list.push(fieldId);
    log(c, actorOf(c), 'note', `Hint requested: ${f.label}. Credit for this question is capped at ${Math.round(rules.hintCap * 100)}%.`);
    store.save();
  }
  return { hint: f.key.hint, cap: rules.hintCap };
}

// Searches are recorded (canonical form) so response objectives such as
// "review the bucket access logs" can be checked.
export function recordSearch(c, q) {
  const t = String(q || '').trim();
  if (!t || c.status === 'closed' || !c.searches) return;
  if (c.searches[c.searches.length - 1]?.q === t) return;
  c.searches.push({ ts: Date.now(), q: t.slice(0, 300), stage: c.stage });
  if (c.searches.length > 400) c.searches.shift();
  store.save();
}

export function removeCase(c) {
  if (c.kind === 'preview') throw new HttpError(403, READ_ONLY);
  streams.delete(c.id);
  streamUsed.delete(c.id);
  aliases.delete(c.id);
  store.remove(c.id);
}

export function dropPreview(id) {
  streams.delete(id);
  streamUsed.delete(id);
  ephemeral.delete(id);
}

export { describeValue, describeExpected };

// Daily wipe: forget every in-memory stream and alias map.
export function dropAll() {
  streams.clear();
  streamUsed.clear();
  aliases.clear();
  ephemeral.clear();
}

/** Number of live streams (tests). */
export const liveStreams = () => streams.size;

// Exposed for tests.
export const __alias = aliasModule;
