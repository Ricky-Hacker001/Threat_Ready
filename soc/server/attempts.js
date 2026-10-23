// Attempts: one per start of a level scenario (Build specification,
// sections 5, 6.3, 7.1-7.2 and 8.2). An attempt wraps one case. When the
// case closes, the attempt is scored, skills and metrics are written, and
// internal badges are checked in the same request.

import crypto from 'node:crypto';
import { repo, newId } from './repo.js';
import { LEVELS, levelById, BADGE_AT, skillLabel } from './levels.js';
import { getScenario, levelScenarios } from './scenarios/index.js';
import { createCase, getCase, hooks, totalScore, stagePct, aliasFor, removeCase } from './engine/cases.js';
import { HttpError } from './engine/response.js';
import { config } from './config.js';

const iso = (ts = Date.now()) => new Date(ts).toISOString();

// ---------------------------------------------------------------------------
// Derived progress
// ---------------------------------------------------------------------------
const closedOf = (list) => list.filter((a) => a.status === 'closed');

// Best closed attempt: highest score, earliest on a tie.
export function bestAttempt(list) {
  let best = null;
  for (const a of closedOf(list)) {
    if (!best || a.score > best.score || (a.score === best.score && a.closedAt < best.closedAt)) best = a;
  }
  return best;
}

export function scenarioStatus(attempts) {
  if (!attempts.length) return 'not_attempted';
  if (attempts.some((a) => a.status === 'open')) return 'in_progress';
  const closed = closedOf(attempts);
  if (closed.some((a) => a.passed)) return 'passed';
  if (closed.length) return 'not_passed';
  return 'abandoned';
}
export const STATUS_LABEL = { not_attempted: 'Not attempted', in_progress: 'In progress', passed: 'Passed', not_passed: 'Not passed', abandoned: 'Abandoned' };

function byScenario(list) {
  const m = new Map();
  for (const a of list) {
    if (!m.has(a.scenarioId)) m.set(a.scenarioId, []);
    m.get(a.scenarioId).push(a);
  }
  return m;
}

function levelSummary(level, attempts, badges) {
  const mine = attempts.filter((a) => a.level === level.id);
  const groups = byScenario(mine);
  let passed = 0;
  let attempted = 0;
  const bests = [];
  for (const [, list] of groups) {
    const best = bestAttempt(list);
    if (best) { attempted++; bests.push(best.score); }
    if (closedOf(list).some((a) => a.passed)) passed++;
  }
  const badge = badges.find((b) => b.level === level.id) || null;
  return {
    passed, attempted,
    bestAverage: bests.length ? Math.round(bests.reduce((s, x) => s + x, 0) / bests.length) : null,
    badge,
  };
}

// One function decides what is open (section 5.2).
export function levelState(userId) {
  const attempts = repo.listAttempts(userId);
  const badges = repo.listAwards(userId);
  return LEVELS.map((lv) => {
    const sum = levelSummary(lv, attempts, badges);
    const prev = lv.unlockAfter;
    const open = !prev || badges.some((b) => b.level === prev);
    const released = levelScenarios(lv.id).length;
    return {
      id: lv.id, name: lv.name, oneLine: lv.oneLine, audience: lv.audience, workflow: lv.workflow, trains: lv.trains,
      passMark: lv.passMark, rounds: lv.rounds, hints: lv.hints, minutes: lv.minutes, badgeAt: BADGE_AT,
      unlockAfter: prev, unlockAfterName: prev ? levelById(prev).name : null,
      state: sum.badge ? 'completed' : open ? 'open' : 'locked',
      passed: sum.passed, attempted: sum.attempted, bestAverage: sum.bestAverage, released,
      badge: sum.badge ? publicBadge(sum.badge) : null,
    };
  });
}

export const publicBadge = (b) => ({ badgeId: b.badgeId, level: b.level, name: `${levelById(b.level).name} badge`, earnedAt: b.earnedAt, average: b.average, passedCount: b.passedCount, internal: true });

export function levelDetail(userId, levelId) {
  const lv = levelById(levelId);
  if (!lv) throw new HttpError(404, 'not_found', { message: 'No such level.' });
  const state = levelState(userId).find((l) => l.id === levelId);
  const groups = byScenario(repo.listAttempts(userId).filter((a) => a.level === levelId));
  const scenarios = levelScenarios(levelId).map((s) => {
    const list = groups.get(s.id) || [];
    const best = bestAttempt(list);
    const open = list.find((a) => a.status === 'open');
    const lastClosed = closedOf(list)[0];
    return {
      id: s.id, code: s.code, title: s.catalog.title, sources: s.catalog.sources, sourceGroups: s.catalog.sourceGroups || [], minutes: s.catalog.minutes,
      state: scenarioStatus(list), best: best ? best.score : null, passed: closedOf(list).some((a) => a.passed), attempts: list.length,
      openAttemptId: open?.attemptId || null, openCaseId: open?.caseId || null,
      lastAttemptId: lastClosed?.attemptId || null, lastCaseId: lastClosed?.caseId || null,
    };
  });
  return { level: state, scenarios };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Every open attempt keeps a case and a live log stream in memory.
const MAX_OPEN_ATTEMPTS = 3;
export function startAttempt(user, scenarioId, opts = {}) {
  const scn = getScenario(scenarioId);
  if (!scn || !scn.level || scn.hidden) throw new HttpError(404, 'not_found', { message: 'Unknown scenario.' });
  const state = levelState(user.uid).find((l) => l.id === scn.level);
  if (state.state === 'locked') throw new HttpError(403, 'level_locked', { message: `Earn the ${state.unlockAfterName} badge to unlock ${state.name}.` });
  const open = repo.listAttempts(user.uid).find((a) => a.scenarioId === scenarioId && a.status === 'open');
  if (open) throw new HttpError(409, 'attempt_open', { message: 'You have an attempt in progress. Resume it, or abandon it and start a new variant.', attemptId: open.attemptId, caseId: open.caseId });
  const openCount = repo.listAttempts(user.uid).filter((a) => a.status === 'open').length;
  if (openCount >= MAX_OPEN_ATTEMPTS) throw new HttpError(409, 'too_many_open', { message: `You have ${openCount} attempts in progress. Finish or abandon one before starting another.` });
  const lv = levelById(scn.level);
  const rec = {
    schema: 'soc-attempt/1',
    attemptId: newId('att'),
    caseId: null,
    ticket: null,
    userId: user.uid,
    userName: user.name,
    scenarioId: scn.id,
    level: scn.level,
    scenarioVersion: scn.version || 1,
    keyVersion: scn.keyVersion || 1,
    seed: crypto.randomInt(2 ** 31),
    status: 'open',
    startedAt: iso(),
    closedAt: null,
    activeSeconds: 0,
    stages: [],
    answers: {},
    questions: [],
    score: null,
    passMark: lv.passMark,
    passed: null,
    skills: {},
    metrics: {},
  };
  const canonical = !!(opts.canonical && config.testMode);
  if (canonical) rec.canonical = true;
  if (opts.seed !== undefined && config.testMode) rec.seed = opts.seed;
  const backdateSeconds = config.testMode && opts.backdate ? Number(opts.backdate) || 0 : 0;
  const c = createCase({ scenarioId: scn.id, analyst: user.name, userId: user.uid, backdateSeconds, attempt: { attemptId: rec.attemptId, seed: rec.seed, canonical } });
  rec.caseId = c.id;
  rec.ticket = c.ticket;
  repo.createAttempt(rec);
  return rec;
}

export function ownAttempt(user, id) {
  const a = repo.getAttempt(id);
  if (!a || a.userId !== user.uid) throw new HttpError(404, 'not_found', { message: 'Attempt not found.' });
  return a;
}

export function abandonAttempt(user, id) {
  const a = ownAttempt(user, id);
  if (a.status !== 'open') throw new HttpError(409, 'not_open', { message: 'Only an open attempt can be abandoned.' });
  repo.updateAttempt(a.attemptId, { status: 'abandoned', score: 0, passed: false, closedAt: iso() });
  beats.delete(a.attemptId);
  try {
    const c = getCase(a.caseId);
    c.abandoned = true;
    removeCase(c);
  } catch { /* case already gone */ }
  pushToPortal(a);
  return a;
}

// Heartbeats every 30 s while the console is open; only visible time counts.
// An entry is dropped when its attempt closes or is abandoned, and anything silent for an hour
// goes on the next sweep, so the map tracks open consoles rather than every attempt ever made.
const beats = new Map();
const BEAT_STALE_MS = 3600 * 1000;
let lastBeatSweep = 0;
export function heartbeat(c, visible) {
  if (!c.attemptId) return;
  const a = repo.getAttempt(c.attemptId);
  if (!a || a.status !== 'open') { beats.delete(c.attemptId); return; }
  const now = Date.now();
  if (now - lastBeatSweep > 60000) { lastBeatSweep = now; for (const [k, v] of beats) if (now - v.at > BEAT_STALE_MS) beats.delete(k); }
  const last = beats.get(a.attemptId);
  if (last && last.visible && visible) a.activeSeconds += Math.min(45, Math.max(0, Math.round((now - last.at) / 1000)));
  beats.set(a.attemptId, { at: now, visible: !!visible });
  repo.touchAttempt();
}

// ---------------------------------------------------------------------------
// Closing: score, questions, skills, metrics, badges
// ---------------------------------------------------------------------------
function fieldSkills(scn, f) {
  if (Array.isArray(f.skills) && f.skills.length) return f.skills;
  const m = scn.fieldSkills?.[f.id];
  if (m) return m;
  return [scn.skills?.[0] || 'tri.verdict'];
}

function containmentObjective(o) {
  return o.containment === true || /^(contain|block|creds|isolate|cut)/.test(o.id);
}

export function questionsOf(c, scn) {
  const out = [];
  for (const def of scn.stages) {
    const st = c.stages[def.id];
    if (!def.weight) continue;
    if (def.kind === 'form' && (st.status === 'done' || st.missed)) {
      for (const f of def.fields) {
        if (!f.points) continue;
        const fs = st.fields?.[f.id];
        const earned = st.missed ? 0 : (fs?.earned ?? 0);
        out.push({ stage: def.id, field: f.id, label: f.label, points: f.points, credit: +(earned / f.points).toFixed(3), skills: fieldSkills(scn, f), ...(fs?.hinted ? { hinted: true } : {}), ...(st.missed ? { missed: true } : {}) });
      }
    }
    if (def.kind === 'response' && (st.status === 'done' || st.missed)) {
      for (const o of st.evaluation?.objectives || scn.secret.response.objectives.map((x) => ({ ...x, credit: 0 }))) {
        const src = scn.secret.response.objectives.find((x) => x.id === o.id) || {};
        out.push({ stage: def.id, field: o.id, label: o.label, points: o.points, credit: st.missed ? 0 : +(o.credit ?? 0).toFixed(3), skills: src.skills || ['res.containment'], response: true });
      }
      // Proportionality: every collateral action takes a quarter of this credit.
      out.push({ stage: def.id, field: 'proportionality', label: 'Response limited to what the evidence supports', points: 4, credit: st.missed ? 0 : Math.max(0, 1 - 0.25 * (st.collateral || 0)), skills: ['res.proportionality'], response: true });
    }
  }
  return out;
}

/** Open-console heartbeat entries (tests). */
export const __beats = beats;

export function skillScores(questions) {
  const acc = {};
  for (const q of questions) {
    for (const sk of q.skills) {
      const a = (acc[sk] ||= { got: 0, max: 0, n: 0 });
      a.got += q.credit * q.points;
      a.max += q.points;
      a.n++;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.max ? Math.round((v.got / v.max) * 100) : 0]));
}

function metricsOf(c, scn, questions) {
  const meta = scn.meta || {};
  const field = (stageId, id) => c.stages[stageId]?.fields?.[id];
  const find = (id) => {
    for (const def of scn.stages) if (def.kind === 'form' && def.fields.some((f) => f.id === id) && c.stages[def.id]?.fields?.[id]) return { def, fs: field(def.id, id), f: def.fields.find((f) => f.id === id) };
    return null;
  };
  const m = {};
  const v = find(meta.verdictField || 'verdict');
  m.verdictCorrect = v ? (v.fs.firstCredit ?? v.fs.credit) >= 0.999 : null;
  const sv = find(meta.severityField || 'severity');
  m.severityCorrect = sv ? sv.fs.credit >= 0.999 : null;
  const rt = find(meta.routeField || 'route');
  m.escalationCorrect = rt ? rt.fs.credit >= 0.999 : null;
  m.benign = !!meta.benign;
  if (meta.benign) {
    const escalated = rt ? rt.fs.credit < 0.999 : false;
    m.fpHandled = !escalated && !(c.actions || []).some((a) => a.ok);
    m.benignEscalated = escalated;
  } else m.fpHandled = null;
  // Evidence: linkable findings corroborated, plus pins questions fully met.
  let evN = 0;
  let evOk = 0;
  for (const def of scn.stages) {
    if (def.kind !== 'form' || c.stages[def.id]?.status !== 'done') continue;
    for (const f of def.fields) {
      const fs = c.stages[def.id].fields?.[f.id];
      if (!fs) continue;
      if (f.linkable) { evN++; if (fs.supported) evOk++; }
      if (f.type === 'pins') { evN++; if (fs.credit >= 0.999) evOk++; }
    }
  }
  m.evidenceLinked = evN ? +(evOk / evN).toFixed(3) : null;
  m.evidenceItems = evN;
  // First-round accuracy over graded questions.
  let fr = 0;
  let frOk = 0;
  for (const def of scn.stages) {
    if (def.kind !== 'form' || c.stages[def.id]?.status !== 'done') continue;
    for (const f of def.fields) {
      const fs = c.stages[def.id].fields?.[f.id];
      if (!fs || ['longtext', 'checks'].includes(f.type) || !f.points) continue;
      fr++;
      if ((fs.firstCredit ?? fs.credit) >= 0.999) frOk++;
    }
  }
  m.firstRoundRate = fr ? +(frOk / fr).toFixed(3) : null;
  let hints = 0;
  for (const def of scn.stages) for (const fs of Object.values(c.stages[def.id]?.fields || {})) if (fs.hinted || fs.hintShown) hints++;
  m.hintsUsed = hints;
  let coll = 0;
  let missed = 0;
  let hasResponse = false;
  for (const def of scn.stages) {
    if (def.kind !== 'response') continue;
    hasResponse = true;
    const st = c.stages[def.id];
    coll += st.collateral || 0;
    const objs = st.missed ? scn.secret.response.objectives.map((o) => ({ ...o, credit: 0 })) : (st.evaluation?.objectives || []);
    for (const o of objs) {
      const src = scn.secret.response.objectives.find((x) => x.id === o.id) || o;
      if (containmentObjective(src) && (o.credit ?? 0) < 0.999) missed++;
    }
  }
  m.collateralActions = hasResponse ? coll : null;
  m.missedContainment = hasResponse ? missed : null;
  m.questions = questions.length;
  return m;
}

function stagesOf(c, scn) {
  return scn.stages.filter((d) => d.weight).map((d) => {
    const st = c.stages[d.id];
    return {
      id: d.id, label: d.label, weight: d.weight,
      pct: st.status === 'done' ? Math.round(stagePct(st)) : st.missed ? 0 : null,
      rounds: st.attempts || 0,
      hints: c.hints?.[d.id] || [],
      skipped: st.status === 'skipped' && !st.missed,
      ...(st.missed ? { missed: true } : {}),
      ...(st.collateral ? { collateral: st.collateral } : {}),
    };
  });
}

function checkBadge(user, level) {
  const lv = levelById(level);
  const badges = repo.listAwards(user.uid);
  if (badges.some((b) => b.level === level)) return null;
  const groups = byScenario(repo.listAttempts(user.uid).filter((a) => a.level === level));
  const passedBests = [];
  for (const [, list] of groups) {
    if (!closedOf(list).some((a) => a.passed)) continue;
    passedBests.push(bestAttempt(list).score);
  }
  if (passedBests.length < BADGE_AT) return null;
  const badge = {
    badgeId: newId('bdg'), userId: user.uid, level, earnedAt: iso(),
    average: Math.round(passedBests.reduce((s, x) => s + x, 0) / passedBests.length),
    passedCount: passedBests.length, internal: true,
  };
  repo.addAward(badge);
  const next = LEVELS.find((l) => l.unlockAfter === level);
  return { ...publicBadge(badge), levelName: lv.name, nextLevel: next ? { id: next.id, name: next.name } : null, allComplete: !next };
}

// Called by the case engine when a level case closes.
hooks.onClose = (c) => {
  if (!c.attemptId) return null;
  const a = repo.getAttempt(c.attemptId);
  if (!a || a.status !== 'open') return null;
  const scn = getScenario(c.scenarioId);
  const lv = levelById(a.level);
  const score = totalScore(c) ?? 0;
  const questions = questionsOf(c, scn);
  const prevBest = bestAttempt(repo.listAttempts(a.userId).filter((x) => x.scenarioId === a.scenarioId && x.attemptId !== a.attemptId));
  const answers = {};
  for (const def of scn.stages) if (c.stages[def.id]?.rounds) answers[def.id] = c.stages[def.id].rounds;
  repo.updateAttempt(a.attemptId, {
    status: 'closed', closedAt: iso(c.closedAt), score, passed: score >= lv.passMark,
    stages: stagesOf(c, scn), answers, questions, skills: skillScores(questions), metrics: metricsOf(c, scn, questions),
  });
  beats.delete(a.attemptId);
  const user = { uid: a.userId, name: a.userName };
  const awards = [];
  if (score >= lv.passMark) {
    const b = checkBadge(user, a.level);
    if (b) awards.push(b);
  }
  const newBest = !prevBest || score > prevBest.score;
  c.attemptResult = { score, passMark: lv.passMark, passed: score >= lv.passMark, newBest, best: newBest ? score : prevBest.score, awards };
  pushToPortal(repo.getAttempt(a.attemptId));
  const skillList = Object.entries(skillScores(questions)).map(([id, s]) => ({ id, label: skillLabel(id), score: s }));
  return { result: { score, passMark: lv.passMark, passed: score >= lv.passMark, newBest, best: newBest ? score : prevBest.score, skills: skillList, level: a.level, levelName: lv.name, code: scn.code } };
};

// ---------------------------------------------------------------------------
// Client views of attempts
// ---------------------------------------------------------------------------
export function publicAttempt(a, { full = false } = {}) {
  const scn = getScenario(a.scenarioId);
  let stageLabel = null;
  let caseStatus = null;
  try {
    const c = getCase(a.caseId);
    caseStatus = c.status;
    stageLabel = c.status === 'closed' ? 'Closed' : c.status === 'monitoring' ? 'Monitoring' : scn.stages.find((s) => s.id === c.stage)?.label;
  } catch { /* case wiped or abandoned */ }
  const out = {
    attemptId: a.attemptId, caseId: a.status === 'abandoned' ? null : a.caseId, ticket: a.ticket, scenarioId: a.scenarioId, code: scn?.code,
    title: scn?.catalog.title, level: a.level, levelName: levelById(a.level)?.name, status: a.status, stageLabel: a.status === 'abandoned' ? 'Abandoned' : stageLabel, caseStatus,
    startedAt: a.startedAt, closedAt: a.closedAt, score: a.score, passMark: a.passMark, passed: a.status === 'open' ? null : a.passed,
    activeSeconds: a.activeSeconds, keyVersion: a.keyVersion, scenarioVersion: a.scenarioVersion,
  };
  if (full && a.status === 'closed') {
    Object.assign(out, { stages: a.stages, questions: a.questions.map(({ skills, ...q }) => ({ ...q, skills })), skills: a.skills, metrics: a.metrics, answers: a.answers });
  }
  return out;
}

// Rename canonical values in an attempt record the same way the case was
// renamed, so exported answers match what the analyst saw.
export function aliasAttempt(a, obj) {
  try {
    return aliasFor(getCase(a.caseId)).outDeep(obj);
  } catch {
    return obj;
  }
}

// ---------------------------------------------------------------------------
// Optional: push closed and abandoned attempts to the ThreatReady admin
// portal (section 8.5). Disabled unless TR_WEBHOOK_URL is set.
// ---------------------------------------------------------------------------
export function pushToPortal(a, attempt = 0) {
  if (!config.webhookUrl || !a) return;
  const body = JSON.stringify(a);
  const sig = crypto.createHmac('sha256', config.webhookSecret || '').update(body).digest('hex');
  fetch(config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TR-Signature': sig }, body })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
    .catch((err) => {
      if (attempt < 3) setTimeout(() => pushToPortal(a, attempt + 1), 1000 * 4 ** attempt);
      else console.error(`Portal push failed for ${a.attemptId}: ${err.message}`);
    });
}
