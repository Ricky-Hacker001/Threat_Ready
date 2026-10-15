// Final analyst report for every outcome (Build specification, 7.4 and 7.5).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, repo } from './helpers.mjs';

before(start);
after(stop);

let n = 0;
const q = (field, credit, skills, points = 10, label = `Question ${field}`) => ({ stage: 'l1_triage', field, label, points, credit, skills });
function rec(uid, scenarioId, level, { status = 'closed', score = 0, passMark = 60, at = '2026-10-14T08:00:00.000Z', questions = [], metrics = {}, active = 300 } = {}) {
  n++;
  return repo.createAttempt({
    schema: 'soc-attempt/1', attemptId: `att_R${n}`, caseId: null, ticket: null, userId: uid, userName: uid,
    scenarioId, level, scenarioVersion: 1, keyVersion: 1, seed: 1, status, startedAt: at, closedAt: status === 'open' ? null : at, activeSeconds: active,
    stages: [], answers: {}, questions, score: status === 'open' ? null : status === 'abandoned' ? 0 : score, passMark,
    passed: status === 'closed' ? score >= passMark : status === 'abandoned' ? false : null, skills: {}, metrics,
  });
}
const badge = (uid, level) => repo.addAward({ badgeId: `bdg_R${uid}${level}`, userId: uid, level, earnedAt: '2026-10-14T09:00:00.000Z', average: 80, passedCount: 10, internal: true });
const get = async (uid) => {
  const r = await api('GET', '/api/report', undefined, { user: uid });
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.doesNotMatch(text, /certif(icate|ied)\b(?! or professional)/i, 'no certificate is mentioned');
  assert.doesNotMatch(text, /undefined|NaN/);
  for (const sec of ['status', 'summary', 'levels', 'skills', 'decisions', 'strengths', 'gaps', 'next', 'history']) assert.ok(r.body[sec] !== undefined, sec);
  return r.body;
};
const rows = (r) => r.levels.flatMap((l) => l.rows);
const wrongMetrics = { verdictCorrect: false, severityCorrect: false, escalationCorrect: false, benign: false, fpHandled: null, evidenceLinked: 0, evidenceItems: 2, firstRoundRate: 0.2, hintsUsed: 2, collateralActions: null, missedContainment: null };

test('1. no attempts: initial report, zeros, nothing scored', async () => {
  const r = await get('r.none');
  assert.equal(r.status.kind, 'initial');
  assert.match(r.status.line, /^Initial report: no attempts yet/);
  assert.equal(r.summary.attempts, 0);
  assert.equal(r.summary.averageText, 'No scored attempts yet');
  assert.ok(rows(r).every((x) => x.state === 'not_attempted'));
  assert.ok(r.skills.flatMap((g) => g.skills).every((s) => s.statusText === 'Not enough evidence yet'));
  assert.equal(r.skills.flatMap((g) => g.skills).length, 25);
  assert.ok(r.decisions.filter((d) => ['verdictCorrect', 'severityCorrect', 'escalationCorrect'].includes(d.id)).every((d) => /not evaluated yet/.test(d.text)));
  assert.match(r.next.startText, /Start with Foundations F1-F3/);
  assert.equal(r.strengths.emptyText, 'No Strong skill band identified yet. Continue practising to establish consistent performance.');
  assert.deepEqual(r.history, []);
});

test('2. one open attempt: counted as open, never as scored', async () => {
  rec('r.open', 'F3', 'foundations', { status: 'open' });
  const r = await get('r.open');
  assert.equal(r.summary.open, 1);
  assert.equal(r.summary.closed, 0);
  assert.equal(r.summary.averageText, 'No scored attempts yet');
  assert.equal(rows(r).find((x) => x.code === 'F3').state, 'in_progress');
  assert.equal(r.history[0].scoreText, '–');
});

test('3-4. failed attempts: real scores, Not passed, missed decisions and recommendations', async () => {
  rec('r.fail', 'F3', 'foundations', { score: 35, questions: [q('verdict', 0, ['tri.verdict']), q('severity', 0.5, ['tri.severity']), q('source', 1, ['inv.pivot'])], metrics: wrongMetrics });
  let r = await get('r.fail');
  assert.equal(rows(r).find((x) => x.code === 'F3').state, 'not_passed');
  assert.equal(rows(r).find((x) => x.code === 'F3').best, 35);
  assert.equal(r.summary.passed, 0);
  assert.equal(r.summary.notPassed, 1);
  assert.equal(r.summary.average, 35);
  assert.equal(r.gaps.kind, 'missed', 'thin evidence: concrete missed decisions instead of skill gaps');
  assert.deepEqual(r.gaps.items.map((x) => x.label), ['Question verdict', 'Question severity']);
  assert.ok(r.next.items.some((x) => x.skill === 'tri.verdict' && /verdict|positive/i.test(x.topic)));
  assert.match(JSON.stringify(r.decisions.find((d) => d.id === 'verdictCorrect')), /0 of 1/);
  // several failed attempts on several scenarios
  rec('r.fail', 'F3', 'foundations', { score: 42, at: '2026-10-14T09:00:00.000Z', questions: [q('verdict', 0, ['tri.verdict']), q('severity', 1, ['tri.severity'])], metrics: wrongMetrics });
  rec('r.fail', 'F1', 'foundations', { score: 20, questions: [q('verdict', 0, ['tri.verdict']), q('route', 0, ['tri.escalation'])], metrics: wrongMetrics });
  rec('r.fail', 'F2', 'foundations', { score: 30, questions: [q('verdict', 0, ['tri.verdict']), q('route', 0, ['tri.escalation'])], metrics: wrongMetrics });
  r = await get('r.fail');
  assert.equal(r.summary.passed, 0);
  assert.equal(r.summary.closed, 4);
  const v = r.skills.flatMap((g) => g.skills).find((s) => s.id === 'tri.verdict');
  assert.equal(v.status, 'scored');
  assert.equal(v.score, 0);
  assert.equal(v.band, 'Gap');
  assert.equal(r.gaps.kind, 'skills');
  assert.equal(r.gaps.items[0].band, 'Gap');
  assert.ok(r.gaps.items[0].questions.length > 0);
  assert.ok(r.statements.some((s) => /Several verdicts were wrong/.test(s)));
  assert.ok(r.statements.some((s) => /missed required evidence/.test(s)));
  assert.ok(r.next.items.length > 0);
});

test('5. abandoned attempts: 0 (abandoned) in history, not scored', async () => {
  rec('r.aband', 'F3', 'foundations', { status: 'abandoned' });
  const r = await get('r.aband');
  assert.equal(r.summary.abandoned, 1);
  assert.equal(r.summary.closed, 0);
  assert.equal(r.summary.averageText, 'No scored attempts yet');
  assert.equal(rows(r).find((x) => x.code === 'F3').state, 'abandoned');
  assert.equal(r.history[0].scoreText, '0 (abandoned)');
  assert.equal(r.history[0].passedText, '–');
  assert.match(r.notes.abandoned, /score 0/);
});

test('6. a mix of passed and failed, never a failed one shown as passed', async () => {
  const good = [q('verdict', 1, ['tri.verdict']), q('evidence', 1, ['doc.evidence']), q('severity', 1, ['tri.severity'])];
  rec('r.mix', 'F3', 'foundations', { score: 92, questions: good, metrics: { ...wrongMetrics, verdictCorrect: true, benign: true, fpHandled: true, escalationCorrect: true, evidenceLinked: 1 } });
  rec('r.mix', 'F1', 'foundations', { score: 88, questions: good, metrics: { ...wrongMetrics, verdictCorrect: true, benign: true, fpHandled: true, escalationCorrect: true, evidenceLinked: 1 } });
  rec('r.mix', 'F2', 'foundations', { score: 90, questions: good, metrics: { ...wrongMetrics, verdictCorrect: true, benign: true, fpHandled: true, escalationCorrect: true, evidenceLinked: 1 } });
  rec('r.mix', 'F4', 'foundations', { score: 41, questions: [q('severity', 0, ['tri.severity'])], metrics: wrongMetrics });
  const r = await get('r.mix');
  const f4 = r.history.find((h) => h.code === 'F4');
  assert.equal(f4.passed, false);
  assert.equal(f4.passedText, 'No');
  assert.equal(r.summary.passed, 3);
  assert.equal(r.summary.notPassed, 1);
  assert.ok(r.strengths.items.length >= 1);
  assert.equal(r.strengths.items[0].band, undefined);
  assert.ok(r.strengths.items.every((s) => s.score >= 80));
  assert.ok(r.statements.includes('You correctly handled false-positive scenarios in the attempts reviewed.'));
});

test('7-9. one, two and three badges', async () => {
  badge('r.b1', 'foundations');
  let r = await get('r.b1');
  assert.equal(r.summary.badges, 1);
  assert.match(r.status.line, /Partial report: Intermediate and Expert progress is incomplete/);
  badge('r.b1', 'intermediate');
  r = await get('r.b1');
  assert.equal(r.summary.badges, 2);
  assert.match(r.status.line, /Partial report: Expert progress is incomplete/);
  badge('r.b1', 'expert');
  r = await get('r.b1');
  assert.equal(r.summary.badges, 3);
  assert.equal(r.status.line, 'All three levels completed.');
  assert.ok(r.summary.badgeList.every((b) => /badge$/.test(b.name)));
});

test('10-11. thin evidence for some skills; improvement shown only when proven', async () => {
  rec('r.imp', 'F3', 'foundations', { score: 45, at: '2026-10-14T08:00:00.000Z', questions: [q('verdict', 0.4, ['tri.verdict'])] });
  rec('r.imp', 'F3', 'foundations', { score: 61, at: '2026-10-14T09:00:00.000Z', questions: [q('verdict', 0.7, ['tri.verdict'])] });
  rec('r.imp', 'F3', 'foundations', { score: 78, at: '2026-10-14T10:00:00.000Z', questions: [q('verdict', 1, ['tri.verdict'])] });
  rec('r.imp', 'F1', 'foundations', { score: 50, at: '2026-10-14T08:00:00.000Z' });
  rec('r.imp', 'F1', 'foundations', { score: 55, at: '2026-10-14T09:00:00.000Z' });
  const r = await get('r.imp');
  assert.deepEqual(r.strengths.improvements.map((i) => i.text), ['F3: 45 → 78 over 3 attempts']);
  assert.equal(rows(r).find((x) => x.code === 'F3').best, 78);
  assert.equal(r.skills.flatMap((g) => g.skills).find((s) => s.id === 'tri.verdict').statusText, 'Not enough evidence yet');
});

test('12-14. all scenarios attempted; missing optional metrics; empty skill data', async () => {
  const { allLevelScenarios } = await import('../server/scenarios/index.js');
  for (const s of allLevelScenarios()) rec('r.all', s.id, s.level, { score: 70, passMark: 60 });
  rec('r.all', 'F3', 'foundations', { score: 10, metrics: undefined, questions: undefined });
  const r = await get('r.all');
  assert.equal(r.summary.closed, allLevelScenarios().length + 1);
  assert.equal(r.gaps.kind, 'missed');
  assert.deepEqual(r.gaps.items, []);
  assert.ok(r.gaps.emptyText);
  assert.ok(r.decisions.every((d) => typeof d.text === 'string'));
});
