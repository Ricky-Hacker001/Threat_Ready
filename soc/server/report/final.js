// Final analyst report (Build specification, sections 7.4 and 7.5).
//
// Rebuilt from the user's attempt and badge records on every request, for
// every user, whatever their results: no attempts, open only, failed,
// abandoned, partial or complete. Every number comes from the records;
// every sentence comes from a fixed template whose condition holds. No
// section can fail because a field is missing.

import { repo } from '../repo.js';
import { config } from '../config.js';
import {
  LEVELS, SKILL_GROUPS, SKILLS, bandOf, skillLabel, SKILL_MIN_QUESTIONS, SKILL_MIN_SCENARIOS,
} from '../levels.js';
import { allLevelScenarios, levelScenarios, getScenario } from '../scenarios/index.js';
import { bestAttempt, scenarioStatus, STATUS_LABEL, levelState } from '../attempts.js';
import { RECOMMENDATIONS } from './recommendations.js';

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const STATEMENTS = {
  escalation: 'You escalated some cases that should have been closed at L1. Review the available context and verify the asset owner before escalating.',
  evidence: 'You missed required evidence in several investigations. Revisit the event timeline and link the evidence that supports your conclusion.',
  collateral: 'You selected disruptive response actions outside the incident scope. Confirm the affected assets before containment.',
  containment: (n) => `Required containment was not completed in ${n} attempt${n === 1 ? '' : 's'}. Check every affected host and account before closing.`,
  fp: 'You correctly handled false-positive scenarios in the attempts reviewed.',
  verdict: 'Several verdicts were wrong. Confirm what the rule matched, and whether it was authorised, before choosing a verdict.',
};

export function buildFinalReport(user, now = Date.now()) {
  const attempts = repo.listAttempts(user.uid);
  const badges = repo.listAwards(user.uid);
  const levels = levelState(user.uid);
  const closed = attempts.filter((a) => a.status === 'closed');
  const open = attempts.filter((a) => a.status === 'open');
  const abandoned = attempts.filter((a) => a.status === 'abandoned');
  const byScn = groupBy(attempts, (a) => a.scenarioId);
  const bests = [...byScn.values()].map((l) => bestAttempt(l)).filter(Boolean);
  const scenarioCount = allLevelScenarios().length;

  // 1. Status
  const scenariosClosed = new Set(closed.map((a) => a.scenarioId)).size;
  let status;
  if (!attempts.length && !badges.length) status = { kind: 'initial', line: 'Initial report: no attempts yet. Start with Foundations or Newbie Demo Mode.' };
  else if (badges.length >= LEVELS.length) status = { kind: 'complete', line: 'All three levels completed.' };
  else {
    const incomplete = LEVELS.filter((l) => !badges.some((b) => b.level === l.id)).map((l) => l.name);
    const list = incomplete.length > 1 ? `${incomplete.slice(0, -1).join(', ')} and ${incomplete[incomplete.length - 1]}` : incomplete[0];
    status = { kind: 'partial', line: `Partial report: ${list} progress is incomplete. This report includes all available attempt results.` };
  }
  status.data = `Based on ${closed.length} closed attempt${closed.length === 1 ? '' : 's'} across ${scenariosClosed} scenario${scenariosClosed === 1 ? '' : 's'}; ${open.length} open; ${abandoned.length} abandoned.`;

  // 2. Summary
  const passedScenarios = [...byScn.values()].filter((l) => l.some((a) => a.status === 'closed' && a.passed)).length;
  const notPassed = [...byScn.values()].filter((l) => l.some((a) => a.status === 'closed') && !l.some((a) => a.status === 'closed' && a.passed)).length;
  const avg = bests.length ? Math.round(bests.reduce((s, a) => s + a.score, 0) / bests.length) : null;
  const summary = {
    badges: badges.length, badgesOf: LEVELS.length,
    passed: passedScenarios, of: scenarioCount, notPassed,
    average: avg, averageText: avg === null ? 'No scored attempts yet' : `${avg}`,
    activeSeconds: attempts.reduce((s, a) => s + (num(a.activeSeconds) || 0), 0),
    attempts: attempts.length, closed: closed.length, open: open.length, abandoned: abandoned.length,
    badgeList: badges.map((b) => ({ level: b.level, name: `${LEVELS.find((l) => l.id === b.level)?.name} badge`, earnedAt: b.earnedAt, average: b.average })),
  };

  // 3. Results by level
  const levelTables = LEVELS.map((lv) => {
    const st = levels.find((l) => l.id === lv.id);
    return {
      id: lv.id, name: lv.name, state: st.state, passMark: lv.passMark, passed: st.passed, released: st.released,
      rows: levelScenarios(lv.id).map((s) => {
        const list = byScn.get(s.id) || [];
        const best = bestAttempt(list);
        const state = scenarioStatus(list);
        const last = list.map((a) => a.closedAt || a.startedAt).sort().pop() || null;
        return { code: s.code, title: s.catalog.title, best: best ? best.score : null, state, stateLabel: STATUS_LABEL[state], attempts: list.length, lastAttempted: last };
      }),
    };
  });

  // 4. Skill map over best attempts
  const skillAcc = new Map();
  for (const a of bests) {
    for (const q of a.questions || []) {
      for (const sk of q.skills || []) {
        if (!skillAcc.has(sk)) skillAcc.set(sk, { got: 0, max: 0, n: 0, scenarios: new Set(), byScenario: new Map() });
        const acc = skillAcc.get(sk);
        const p = num(q.points) || 0;
        const cr = num(q.credit) || 0;
        acc.got += cr * p;
        acc.max += p;
        acc.n++;
        acc.scenarios.add(a.scenarioId);
        const bs = acc.byScenario.get(a.scenarioId) || { got: 0, max: 0 };
        bs.got += cr * p;
        bs.max += p;
        acc.byScenario.set(a.scenarioId, bs);
      }
    }
  }
  const skillRows = SKILLS.map((s) => {
    const acc = skillAcc.get(s.id);
    const enough = acc && acc.n >= SKILL_MIN_QUESTIONS && acc.scenarios.size >= SKILL_MIN_SCENARIOS && acc.max > 0;
    const score = enough ? Math.round((acc.got / acc.max) * 100) : null;
    return { id: s.id, label: s.label, group: s.group, score, band: score === null ? null : bandOf(score), questions: acc?.n || 0, scenarios: acc?.scenarios.size || 0, status: enough ? 'scored' : 'insufficient', statusText: enough ? null : 'Not enough evidence yet' };
  });
  const skills = SKILL_GROUPS.map((g) => ({ id: g.id, name: g.name, skills: skillRows.filter((r) => r.group === g.id) }));

  // 5. Decision quality over best attempts
  const metric = (key) => {
    const vals = bests.map((a) => a.metrics?.[key]).filter((v) => v !== null && v !== undefined);
    return { n: vals.length, ok: vals.filter((v) => v === true).length };
  };
  const ratio = (key, label, what) => {
    const m = metric(key);
    return m.n ? { id: key, label, value: pct(m.ok, m.n), count: m.ok, total: m.n, text: `${label}: ${m.ok} of ${m.n}` } : { id: key, label, value: null, count: 0, total: 0, text: `${label}: not evaluated yet. No closed attempt has tested ${what}.` };
  };
  const verdict = ratio('verdictCorrect', 'Verdict accuracy', 'a verdict');
  const severity = ratio('severityCorrect', 'Severity accuracy', 'a severity');
  const escalation = ratio('escalationCorrect', 'Escalation accuracy', 'a routing decision');
  const benignBests = bests.filter((a) => a.metrics?.benign);
  const fp = (() => {
    const vals = benignBests.map((a) => a.metrics.fpHandled).filter((v) => v !== null && v !== undefined);
    return vals.length ? { id: 'fpHandled', label: 'False-positive handling', value: pct(vals.filter(Boolean).length, vals.length), count: vals.filter(Boolean).length, total: vals.length, text: `False-positive handling: ${vals.filter(Boolean).length} of ${vals.length} benign scenarios closed at L1 without containment` }
      : { id: 'fpHandled', label: 'False-positive handling', value: null, count: 0, total: 0, text: 'False-positive handling: not evaluated yet. No closed attempt has tested a benign scenario.' };
  })();
  const ev = (() => {
    let items = 0;
    let ok = 0;
    let n = 0;
    for (const a of bests) {
      const share = num(a.metrics?.evidenceLinked);
      const it = num(a.metrics?.evidenceItems) || 0;
      if (share === null || !it) continue;
      n++;
      items += it;
      ok += Math.round(share * it);
    }
    return items ? { id: 'evidenceLinked', label: 'Evidence linking', value: pct(ok, items), count: ok, total: items, attempts: n, text: `Evidence linking: ${ok} of ${items} evidence items corroborated` }
      : { id: 'evidenceLinked', label: 'Evidence linking', value: null, count: 0, total: 0, attempts: 0, text: 'Evidence linking: not evaluated yet. No closed attempt has asked for linked evidence.' };
  })();
  const fr = (() => {
    const vals = bests.map((a) => num(a.metrics?.firstRoundRate)).filter((v) => v !== null);
    if (!vals.length) return { id: 'firstRoundRate', label: 'First-round accuracy', value: null, text: 'First-round accuracy: not evaluated yet.' };
    const v = Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 100);
    return { id: 'firstRoundRate', label: 'First-round accuracy', value: v, total: vals.length, text: `First-round accuracy: ${v}% of questions right first time, over ${vals.length} attempt${vals.length === 1 ? '' : 's'}` };
  })();
  const hints = bests.reduce((s, a) => s + (num(a.metrics?.hintsUsed) || 0), 0);
  const respBests = bests.filter((a) => a.metrics && a.metrics.collateralActions !== null && a.metrics.collateralActions !== undefined);
  const collateral = respBests.reduce((s, a) => s + (num(a.metrics.collateralActions) || 0), 0);
  const missedAttempts = respBests.filter((a) => (num(a.metrics.missedContainment) || 0) > 0).length;
  const missedTotal = respBests.reduce((s, a) => s + (num(a.metrics.missedContainment) || 0), 0);
  const decisions = [verdict, severity, escalation, fp, ev, fr,
    { id: 'hintsUsed', label: 'Hints used', value: hints, text: closed.length ? `Hints used: ${hints}` : 'Hints used: not evaluated yet.' },
    respBests.length ? { id: 'collateralActions', label: 'Collateral response actions', value: collateral, text: `Collateral response actions: ${collateral} over ${respBests.length} response stage${respBests.length === 1 ? '' : 's'}` }
      : { id: 'collateralActions', label: 'Collateral response actions', value: null, text: 'Collateral response actions: not evaluated yet. No closed attempt included a response stage.' },
    respBests.length ? { id: 'missedContainment', label: 'Missed containment objectives', value: missedTotal, text: `Missed containment objectives: ${missedTotal} across ${missedAttempts} attempt${missedAttempts === 1 ? '' : 's'}` }
      : { id: 'missedContainment', label: 'Missed containment objectives', value: null, text: 'Missed containment objectives: not evaluated yet.' },
  ];
  const statements = [];
  if (escalation.total >= 2 && escalation.value < 80 && benignBests.some((a) => a.metrics.benignEscalated)) statements.push(STATEMENTS.escalation);
  if (ev.attempts >= 2 && ev.value !== null && ev.value < 70) statements.push(STATEMENTS.evidence);
  if (collateral > 0) statements.push(STATEMENTS.collateral);
  if (missedAttempts > 0) statements.push(STATEMENTS.containment(missedAttempts));
  if (fp.total >= 2 && fp.value === 100) statements.push(STATEMENTS.fp);
  if (verdict.total >= 3 && verdict.value < 60) statements.push(STATEMENTS.verdict);

  // 6. Strengths
  const codeOf = (sid) => getScenario(sid)?.code || sid;
  const strong = skillRows.filter((r) => r.band === 'Strong').sort((a, b) => b.score - a.score).slice(0, 3).map((r) => {
    const acc = skillAcc.get(r.id);
    let topSid = null;
    let top = -1;
    for (const [sid, v] of acc.byScenario) { const p = v.max ? v.got / v.max : 0; if (p > top) { top = p; topSid = sid; } }
    return { skill: r.id, label: r.label, score: r.score, scenario: codeOf(topSid), scenarioScore: Math.round(top * 100) };
  });
  const improvements = [];
  for (const [sid, list] of byScn) {
    const cl = list.filter((a) => a.status === 'closed').sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    if (cl.length < 2) continue;
    const first = cl[0].score;
    const latest = cl[cl.length - 1].score;
    if (latest >= first + 10) improvements.push({ code: codeOf(sid), first, latest, attempts: cl.length, text: `${codeOf(sid)}: ${first} → ${latest} over ${cl.length} attempts` });
  }
  const strengths = { items: strong, improvements, emptyText: strong.length ? null : 'No Strong skill band identified yet. Continue practising to establish consistent performance.' };

  // 7. Gaps (or missed decisions when no skill has enough evidence yet)
  const weakQs = (skill) => {
    const out = [];
    for (const a of bests) {
      for (const q of a.questions || []) {
        if ((num(q.credit) ?? 0) >= 0.999 || !(q.skills || []).includes(skill)) continue;
        out.push({ code: codeOf(a.scenarioId), label: q.label, credit: Math.round((num(q.credit) || 0) * 100) });
      }
    }
    return out.sort((x, y) => x.credit - y.credit).slice(0, 6);
  };
  let gaps;
  const weak = skillRows.filter((r) => r.band === 'Gap' || r.band === 'Developing').sort((a, b) => a.score - b.score).slice(0, 3);
  const anyScored = skillRows.some((r) => r.status === 'scored');
  if (weak.length) {
    gaps = { kind: 'skills', items: weak.map((r) => ({ skill: r.id, label: r.label, band: r.band, score: r.score, questions: weakQs(r.id) })) };
  } else if (!anyScored && closed.length) {
    const missed = [];
    for (const a of bests) for (const q of a.questions || []) if ((num(q.credit) ?? 0) < 0.999) missed.push({ code: codeOf(a.scenarioId), label: q.label, credit: Math.round((num(q.credit) || 0) * 100), skill: (q.skills || [])[0] || null });
    missed.sort((x, y) => x.credit - y.credit);
    gaps = { kind: 'missed', items: missed.slice(0, 5), emptyText: missed.length ? null : 'Every graded question in your best attempts was answered in full.' };
  } else if (!closed.length) {
    gaps = { kind: 'none', items: [], emptyText: 'No closed attempts yet, so there are no findings.' };
  } else {
    gaps = { kind: 'none', items: [], emptyText: 'No skill with enough evidence is in the Gap or Developing band.' };
  }

  // 8. What to learn next
  const openLevels = new Set(levels.filter((l) => l.state !== 'locked').map((l) => l.id));
  const recFor = (skill) => {
    const r = RECOMMENDATIONS[skill];
    if (!r) return null;
    const scn = allLevelScenarios().find((s) => s.code === r.replay);
    const available = !!scn && openLevels.has(scn.level);
    return { skill, label: skillLabel(skill), topic: r.topic, tip: r.tip, replay: available ? { code: scn.code, title: scn.catalog.title, level: scn.level } : null, replayNote: available ? null : scn ? `${r.replay} is in a level that is not open yet.` : `${r.replay} is not released yet.` };
  };
  let next;
  if (!closed.length) next = { items: [], startText: 'Start with Foundations F1-F3, or run Newbie Demo Mode first.' };
  else {
    const skillsWanted = gaps.kind === 'skills' ? gaps.items.map((g) => g.skill) : gaps.kind === 'missed' ? [...new Set(gaps.items.map((g) => g.skill).filter(Boolean))] : [];
    next = { items: skillsWanted.map(recFor).filter(Boolean), startText: skillsWanted.length ? null : 'No gaps to target from the records so far. Keep going with the next open scenarios.' };
  }

  // 9. History
  const history = attempts.map((a) => {
    const s = getScenario(a.scenarioId);
    return {
      attemptId: a.attemptId, caseId: a.status === 'closed' ? a.caseId : null, date: a.closedAt || a.startedAt, startedAt: a.startedAt,
      code: s?.code || a.scenarioId, title: s?.catalog.title || a.scenarioId, level: a.level, levelName: LEVELS.find((l) => l.id === a.level)?.name,
      status: a.status, score: a.status === 'closed' ? a.score : a.status === 'abandoned' ? 0 : null,
      scoreText: a.status === 'closed' ? String(a.score) : a.status === 'abandoned' ? '0 (abandoned)' : '–',
      passed: a.status === 'closed' ? !!a.passed : false,
      passedText: a.status === 'closed' ? (a.passed ? 'Yes' : 'No') : '–',
    };
  });

  return {
    schema: 'soc-report/1',
    generatedAt: new Date(now).toISOString(),
    user: { uid: user.uid, name: user.name },
    status, summary, levels: levelTables, skills, decisions, statements, strengths, gaps, next, history,
    notes: {
      abandoned: 'Abandoned attempts score 0 under the simulation rules and are not counted in averages, skill scores or decision metrics.',
      internal: 'Internal badges show progress inside this simulation. They are not a certification or professional qualification.',
      // Only true when the daily wipe runs (it is off inside ThreatReady).
      reset: config.dailyWipe ? 'Practice records reset daily at 00:00 UTC.' : null,
    },
  };
}
