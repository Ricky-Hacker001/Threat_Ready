import { AI_CONSENT_VERSION } from '@threatready/contracts';
import { randomUUID } from 'node:crypto';
import type { SessionView } from '@threatready/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InterviewService } from '../src/modules/interview/interview.service.js';
import { JobsService } from '../src/modules/jobs/jobs.service.js';
import { drainJobs, JD_TEXT, ORIGIN, resetDatabase, RESUME_TEXT, signUp, sse, startApp, type Agent, type TestApp } from './harness.js';
import { docxFrom, uploadDocument } from './harness.js';

const CONSENT = { accepted: true, version: AI_CONSENT_VERSION } as const;

const ANSWER = 'I would first scope the alert, correlate authentication logs across sources, check whether many accounts failed from one IP, enrich the indicators and then decide on escalation using the severity matrix.';
const config = { interviewType: 'technical', difficulty: 'intermediate', durationMin: 30, mode: 'practice', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false };

/** Creates a session in awaiting_answer with the first question asked. */
async function readySession(t: TestApp, agent: Agent, cfg: object = config): Promise<SessionView> {
  const resume = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
  const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
  const created = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  await drainJobs(t, { only: ['interview.analyse'] });
  const planned = await agent.post(`/v1/interviews/${created.body.id}/plan`).set('Origin', ORIGIN).send({ config: cfg });
  expect(planned.status, JSON.stringify(planned.body)).toBe(200);
  const start = await sse(agent, `/v1/interviews/${created.body.id}/start`);
  return (start.events.find((e) => e.type === 'done') as { session: SessionView }).session;
}

const done = (events: { type: string }[]) => (events.find((e) => e.type === 'done') as { session: SessionView } | undefined)?.session;

describe('session resilience', () => {
  let t: TestApp;
  let agent: Agent;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp({ INTERVIEW_MAX_OPEN_SESSIONS: '20', INTERVIEW_MONTHLY_QUOTA_FREE: '50', RATE_LIMIT_SCALE: '20' });
    agent = await signUp(t);
  });
  beforeEach(() => t.llm.reset());
  afterAll(async () => t?.close());

  it('duplicate submissions are idempotent: one stored answer, one evaluation', async () => {
    const s = await readySession(t, agent);
    const body = { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() };
    const first = await sse(agent, `/v1/interviews/${s.id}/turns`, body);
    expect(done(first.events)?.state).toBe('awaiting_answer');
    const evalCalls = t.llm.calls.filter((c) => c.name === 'answer_evaluation').length;
    const again = await sse(agent, `/v1/interviews/${s.id}/turns`, body);
    expect(again.status).toBe(200);
    expect(done(again.events)?.id).toBe(s.id);
    expect(t.llm.calls.filter((c) => c.name === 'answer_evaluation').length).toBe(evalCalls);
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM interview_turns WHERE session_id = $1 AND answer IS NOT NULL', [s.id]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects an answer while a turn is in progress, and answers to a stale turn', async () => {
    const s = await readySession(t, agent);
    await t.pool.query(`UPDATE interview_sessions SET state = 'evaluating' WHERE id = $1`, [s.id]);
    const busy = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    expect(busy.status).toBe(409);
    expect(busy.raw.body).toContain('INTERVIEW_TURN_IN_PROGRESS');
    await t.pool.query(`UPDATE interview_sessions SET state = 'awaiting_answer' WHERE id = $1`, [s.id]);
    const stale = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: randomUUID(), answer: ANSWER, clientSubmissionId: randomUUID() });
    expect(stale.status).toBe(409);
  });

  it('the candidate can ask up to three clarifying questions, stored with the turn, without answers being given away', async () => {
    const s = await readySession(t, agent);
    const turnId = s.currentTurn!.turnId;
    const first = await sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: 'Could you repeat the question?' });
    expect(first.status).toBe(200);
    expect(first.events.some((e) => e.type === 'reply.delta')).toBe(true);
    const view = done(first.events)!;
    expect(view.state).toBe('awaiting_answer');
    expect(view.currentTurn!.clarifications).toHaveLength(1);
    expect(view.currentTurn!.clarifications[0]!.question).toBe('Could you repeat the question?');

    const askForAnswer = await sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: 'What is the answer you are looking for?' });
    expect(done(askForAnswer.events)!.currentTurn!.clarifications[1]!.answer).toMatch(/can't give that away/);
    await sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: 'Do I have admin access?' });
    const fourth = await sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: 'One more thing?' });
    expect(fourth.status).toBe(409);
    expect(fourth.raw.body).toContain('CLARIFICATION_LIMIT_REACHED');

    await agent.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN);
    const whilePaused = await sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: 'Could you repeat that?' });
    expect(whilePaused.status).toBe(409);
  });

  it('rejects answers over 4,000 characters', async () => {
    const s = await readySession(t, agent);
    const res = await agent.post(`/v1/interviews/${s.id}/turns`).set('Origin', ORIGIN).send({ turnId: s.currentTurn!.turnId, answer: 'a'.repeat(4001), clientSubmissionId: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTERVIEW_ANSWER_TOO_LONG');
  });

  it('pause stops the clock; resume restores the same question; refresh returns it', async () => {
    const s = await readySession(t, agent);
    const paused = await agent.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN);
    expect(paused.body.state).toBe('paused');
    expect(paused.body.timing.runningSince).toBeNull();
    const remaining = paused.body.timing.remainingSec;
    await new Promise((r) => setTimeout(r, 1200));
    const refreshed = await agent.get(`/v1/interviews/${s.id}`);
    expect(refreshed.body.timing.remainingSec).toBe(remaining);
    expect(refreshed.body.currentTurn.turnId).toBe(s.currentTurn!.turnId);
    const blocked = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    expect(blocked.status).toBe(409);
    const resumed = await agent.post(`/v1/interviews/${s.id}/resume`).set('Origin', ORIGIN);
    expect(resumed.body.state).toBe('awaiting_answer');
    expect(resumed.body.currentTurn.question).toBe(s.currentTurn!.question);
  });

  it('auto-pauses after 10 minutes idle', async () => {
    const s = await readySession(t, agent);
    await t.pool.query(`UPDATE interview_sessions SET last_activity_at = now() - interval '11 minutes' WHERE id = $1`, [s.id]);
    const view = await agent.get(`/v1/interviews/${s.id}`);
    expect(view.body.state).toBe('paused');
  });

  it('a failed or slow evaluation never ends the interview: no follow-up, next question asked', async () => {
    const s = await readySession(t, agent);
    t.llm.failNext('answer_evaluation', 'timeout');
    const res = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    const next = done(res.events)!;
    expect(next.state).toBe('awaiting_answer');
    expect(next.currentTurn!.kind).toBe('question');
    expect(next.progress.questionNumber).toBe(2);
    const { rows } = await t.pool.query(`SELECT evaluation_status FROM interview_turns WHERE id = $1`, [s.currentTurn!.turnId]);
    expect(rows[0].evaluation_status).toBe('failed');
  });

  it('malformed model output is retried once, then the turn continues without a follow-up', async () => {
    const s = await readySession(t, agent);
    t.llm.overrides.set('answer_evaluation', () => ({ nonsense: true }));
    const res = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    expect(t.llm.calls.filter((c) => c.name === 'answer_evaluation')).toHaveLength(2);
    expect(done(res.events)?.state).toBe('awaiting_answer');
  });

  it('question generation failure falls back to a template question', async () => {
    const s = await readySession(t, agent);
    t.llm.failNext('question', 'unavailable');
    const res = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: 'Short.', clientSubmissionId: randomUUID() });
    expect(res.events.some((e) => e.type === 'question.reset')).toBe(true);
    const next = done(res.events)!;
    expect(next.state).toBe('awaiting_answer');
    const { rows } = await t.pool.query(`SELECT question_source FROM interview_turns WHERE id = $1`, [next.currentTurn!.turnId]);
    expect(rows[0].question_source).toBe('template');
  });

  it('adaptive follow-ups: a partial answer gets a clarifying follow-up on the same question', async () => {
    const s = await readySession(t, agent);
    // The warm-up introduction never gets a follow-up; answer it, then give a partial answer.
    const afterIntro = done((await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: 'Short.', clientSubmissionId: randomUUID() })).events)!;
    expect(afterIntro.currentTurn!.kind).toBe('question');
    expect(afterIntro.currentTurn!.questionNumber).toBe(2);
    const partial = 'I would check the logs in Splunk and then escalate it to the incident team.'; // 15 words -> level 1-2
    const res = await sse(agent, `/v1/interviews/${afterIntro.id}/turns`, { turnId: afterIntro.currentTurn!.turnId, answer: partial, clientSubmissionId: randomUUID() });
    const next = done(res.events)!;
    expect(next.currentTurn!.kind).toBe('follow_up');
    expect(next.currentTurn!.questionNumber).toBe(2);
    expect(res.events.some((e) => e.type === 'feedback')).toBe(true); // practice mode
  });

  it('recovers an interrupted question stream after the lease expires', async () => {
    const s = await readySession(t, agent);
    await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    // Simulate a crash mid-stream: the session is left in asking with an expired lease and no stored question.
    const { rows } = await t.pool.query(`SELECT progress FROM interview_sessions WHERE id = $1`, [s.id]);
    const progress = rows[0].progress;
    const pending = { turnId: randomUUID(), planItemId: 'q3', kind: 'question', seq: progress.turnsUsed + 1, questionNumber: progress.questionNumber + 1, directive: 'standard' };
    await t.pool.query(`UPDATE interview_sessions SET state = 'asking', current_turn_id = null, progress = $2 WHERE id = $1`, [
      s.id,
      { ...progress, pendingTurn: pending, askingLeaseUntil: new Date(Date.now() + 60_000).toISOString() },
    ]);
    const tooSoon = await sse(agent, `/v1/interviews/${s.id}/question`);
    expect(tooSoon.status).toBe(409);
    await t.pool.query(`UPDATE interview_sessions SET progress = jsonb_set(progress, '{askingLeaseUntil}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [s.id]);
    const recovered = await sse(agent, `/v1/interviews/${s.id}/question`);
    const view = done(recovered.events)!;
    expect(view.state).toBe('awaiting_answer');
    expect(view.currentTurn!.turnId).toBe(pending.turnId);
  });

  it('ending early scores what exists; ending with no answers expires the session', async () => {
    const s = await readySession(t, agent);
    const ended = await agent.post(`/v1/interviews/${s.id}/end`).set('Origin', ORIGIN).send({ reason: 'candidate_ended' });
    expect(ended.body.state).toBe('expired');

    const s2 = await readySession(t, agent);
    await sse(agent, `/v1/interviews/${s2.id}/turns`, { turnId: s2.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    const ended2 = await agent.post(`/v1/interviews/${s2.id}/end`).set('Origin', ORIGIN).send({ reason: 'candidate_ended' });
    expect(ended2.body.state).toBe('scoring');
    await drainJobs(t);
    const report = await agent.get(`/v1/interviews/${s2.id}/report`);
    expect(report.status).toBe(200);
    // The unanswered current question is reviewed but unscored.
    expect(report.body.questions.some((q: { answer: string | null; score: number | null }) => q.answer === null && q.score === null)).toBe(true);
  });

  it('report job failure: retries, then dead-letter marks failed, and a manual retry produces one report', async () => {
    const s = await readySession(t, agent);
    await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    await agent.post(`/v1/interviews/${s.id}/end`).set('Origin', ORIGIN).send({ reason: 'candidate_ended' });
    t.llm.failNext('turn_assessment', 'unavailable');
    await expect(drainJobs(t, { only: ['interview.final_scoring'] })).rejects.toThrow();
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('scoring');

    // Retries exhausted: the dead-letter handler moves the session to a visible failed state.
    await t.app.get(JobsService).onDeadLetter({ kind: 'final_scoring', sessionId: s.id });
    const failed = await agent.get(`/v1/interviews/${s.id}`);
    expect(failed.body).toMatchObject({ state: 'failed', report: { status: 'failed' }, failure: { stage: 'scoring' } });

    const retried = await agent.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
    expect(retried.status).toBe(202);
    expect(retried.body.state).toBe('scoring');
    // The original failed job and the manual retry both run; the handler is idempotent.
    await drainJobs(t);
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
    const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM reports WHERE session_id = $1', [s.id]);
    expect(rows[0].n).toBe(1);
  });

  it('analysis failures surface as a failed state after the retry, never a stuck spinner', async () => {
    t.llm.failNext('candidate_profile', 'invalid_output', 'invalid_output', 'invalid_output', 'invalid_output');
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(`${RESUME_TEXT}\nUnique line ${randomUUID()}`));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const created = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    const { AnalysisService } = await import('../src/modules/interview/analysis.service.js');
    process.env.APP_ROLE = 'worker';
    await expect(t.app.get(AnalysisService).run(created.body.id, false)).rejects.toThrow();
    await t.app.get(AnalysisService).run(created.body.id, true);
    process.env.APP_ROLE = 'api';
    const view = await agent.get(`/v1/interviews/${created.body.id}`);
    expect(view.body).toMatchObject({ state: 'failed', failure: { code: 'PARSE_FAILED', stage: 'analysis' } });
  });

  it('the session budget cap ends the interview gracefully and still produces a report', async () => {
    const s = await readySession(t, agent);
    const { rows } = await t.pool.query('SELECT org_id, user_id FROM interview_sessions WHERE id = $1', [s.id]);
    await t.pool.query(
      `INSERT INTO llm_call_log (org_id, user_id, feature, source_id, tier, model, prompt_version, status, estimated_cost_usd, cost_usd)
       VALUES ($1, $2, 'test.spend', $3, 'SMALL', 'claude-haiku-4-5', 't', 'settled', 0.39, 0.39)`,
      [rows[0].org_id, rows[0].user_id, s.id],
    );
    const res = await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    const view = done(res.events)!;
    expect(view.state).toBe('scoring');
    expect(view.endReason).toBe('budget_cap');
    await drainJobs(t); // finalize is exempt from the session cap
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
  });

  it('enforces open-session and monthly quotas', async () => {
    const small = await startApp({ INTERVIEW_MAX_OPEN_SESSIONS: '1' });
    try {
      const a = await signUp(small, 'Quota User');
      const resume = await uploadDocument(small, a, 'resume', await docxFrom(RESUME_TEXT));
      const jd = await a.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
      expect((await a.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT })).status).toBe(202);
      const second = await a.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('INTERVIEW_LIMIT_REACHED');
    } finally {
      await small.close();
    }
  });

  it('sessions whose analysis failed do not use monthly quota', async () => {
    const one = await startApp({ INTERVIEW_MONTHLY_QUOTA_FREE: '1', INTERVIEW_MAX_OPEN_SESSIONS: '5' });
    try {
      const a = await signUp(one, 'Quota Fairness');
      const resume = await uploadDocument(one, a, 'resume', await docxFrom(RESUME_TEXT));
      const jd = await a.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
      const body = { resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT };
      const first = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect(first.status).toBe(202);
      await one.pool.query(`UPDATE interview_sessions SET state = 'failed', failure_stage = 'analysis', failure_code = 'LLM_PROVIDER_UNAVAILABLE' WHERE id = $1`, [first.body.id]);
      const second = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect(second.status).toBe(202);
      const third = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect(third.status).toBe(403);
      expect(third.body.error.code).toBe('ENTITLEMENT_QUOTA_EXCEEDED');
      expect((await a.get('/v1/interview-prep/dashboard')).body.usage.interviewsThisMonth).toBe(1);
    } finally {
      await one.close();
    }
  });

  it('the sweeper completes sessions paused for 24 hours and expires unused plans', async () => {
    const s = await readySession(t, agent);
    await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    await agent.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN);
    await t.pool.query(`UPDATE interview_sessions SET last_activity_at = now() - interval '25 hours' WHERE id = $1`, [s.id]);
    process.env.APP_ROLE = 'worker';
    await t.app.get(JobsService).sweep();
    process.env.APP_ROLE = 'api';
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('scoring');
  });
});

describe('session integrity, recovery and report retries (audit 2026-10-23, second pass)', () => {
  let t: TestApp;
  let agent: Agent;

  beforeAll(async () => {
    t = await startApp({ INTERVIEW_MAX_OPEN_SESSIONS: '50', INTERVIEW_MONTHLY_QUOTA_FREE: '100', RATE_LIMIT_SCALE: '20' });
    agent = await signUp(t, 'Integrity Learner');
  });
  beforeEach(() => t.llm.reset());
  afterAll(async () => t?.close());

  const answerAndEnd = async (s: SessionView) => {
    await sse(agent, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
    const ended = await agent.post(`/v1/interviews/${s.id}/end`).set('Origin', ORIGIN).send({ reason: 'candidate_ended' });
    expect(ended.body.state).toBe('scoring');
  };
  const progressOfRow = async (id: string) => (await t.pool.query('SELECT progress FROM interview_sessions WHERE id = $1', [id])).rows[0].progress;

  it('a paused interview hides the question; pauses and tab switches are counted and reported (TR-24)', async () => {
    const s = await readySession(t, agent);
    const question = s.currentTurn!.question;
    const paused = await agent.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN);
    expect(paused.body.currentTurn).toMatchObject({ turnId: s.currentTurn!.turnId, question: '', questionHidden: true, clarifications: [] });
    const view = await agent.get(`/v1/interviews/${s.id}`);
    expect(JSON.stringify(view.body)).not.toContain(question.slice(-40));
    expect(view.body.transcript.some((e: { turnId: string }) => e.turnId === s.currentTurn!.turnId)).toBe(false);
    expect(view.body.integrity).toMatchObject({ pauseCount: 1, maxPauses: null, tabHiddenCount: 0 });
    await t.pool.query(`UPDATE interview_sessions SET integrity = jsonb_set(integrity, '{pausedAt}', to_jsonb((now() - interval '2 minutes')::text)) WHERE id = $1`, [s.id]);
    for (const hiddenMs of [4000, 9000]) expect((await agent.post(`/v1/interviews/${s.id}/tab-hidden`).set('Origin', ORIGIN).send({ hiddenMs })).status).toBe(204);
    const resumed = await agent.post(`/v1/interviews/${s.id}/resume`).set('Origin', ORIGIN);
    expect(resumed.body.currentTurn.question).toBe(question);
    expect(resumed.body.currentTurn.questionHidden).toBeUndefined();
    expect(resumed.body.integrity.pausedSec).toBeGreaterThanOrEqual(119);
    await answerAndEnd(resumed.body);
    await drainJobs(t);
    const report = await agent.get(`/v1/interviews/${s.id}/report`);
    expect(report.body.integrity).toMatchObject({ pauseCount: 1, tabHiddenCount: 2 });
    expect(report.body.integrity.pausedSec).toBeGreaterThanOrEqual(119);
    expect(report.body.integrityNotes.join(' ')).toMatch(/paused the interview once.*about 2 minutes/);
    expect(report.body.integrityNotes.join(' ')).toMatch(/switched away from the interview tab 2 times/);
    // Once the interview is over, tab reports change nothing.
    expect((await agent.post(`/v1/interviews/${s.id}/tab-hidden`).set('Origin', ORIGIN).send({})).status).toBe(204);
  });

  it('INTERVIEW_MAX_PAUSES caps the pauses a candidate may take', async () => {
    const capped = await startApp({ INTERVIEW_MAX_PAUSES: '1', INTERVIEW_MAX_OPEN_SESSIONS: '50', INTERVIEW_MONTHLY_QUOTA_FREE: '100', RATE_LIMIT_SCALE: '20' });
    try {
      const a = await signUp(capped, 'Pause Capped');
      const s = await readySession(capped, a);
      expect((await a.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN)).body.integrity.maxPauses).toBe(1);
      expect((await a.post(`/v1/interviews/${s.id}/resume`).set('Origin', ORIGIN)).status).toBe(200);
      const again = await a.post(`/v1/interviews/${s.id}/pause`).set('Origin', ORIGIN);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INTERVIEW_PAUSE_LIMIT_REACHED');
    } finally {
      await capped.close();
    }
  });

  it('an evaluation lost mid-call is recovered: the interview moves on, and ending is possible (TR-23)', async () => {
    const s = await readySession(t, agent);
    const stall = async (leaseOffsetSec: number) => {
      await t.pool.query(`UPDATE interview_turns SET answer = $2, answered_at = now(), evaluation_status = 'pending' WHERE id = $1`, [s.currentTurn!.turnId, ANSWER]);
      await t.pool.query(
        `UPDATE interview_sessions SET state = 'evaluating', running_since = null,
           progress = jsonb_set(progress, '{evaluatingLeaseUntil}', to_jsonb((now() + make_interval(secs => $2))::text)) WHERE id = $1`,
        [s.id, leaseOffsetSec],
      );
    };
    await stall(120);
    expect((await agent.post(`/v1/interviews/${s.id}/end`).set('Origin', ORIGIN)).status).toBe(409); // still within its lease
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('evaluating');
    await stall(-5);
    const recovered = await agent.get(`/v1/interviews/${s.id}`);
    expect(recovered.body.state).toBe('asking');
    const { rows } = await t.pool.query('SELECT evaluation_status FROM interview_turns WHERE id = $1', [s.currentTurn!.turnId]);
    expect(rows[0].evaluation_status).toBe('failed');
    const next = done((await sse(agent, `/v1/interviews/${s.id}/question`)).events)!;
    expect(next.state).toBe('awaiting_answer');
    expect(next.progress.questionNumber).toBe(2);

    // The sweeper recovers too, and an expired lease never blocks ending.
    const s2 = await readySession(t, agent);
    await t.pool.query(`UPDATE interview_turns SET answer = $2, answered_at = now(), evaluation_status = 'pending' WHERE id = $1`, [s2.currentTurn!.turnId, ANSWER]);
    await t.pool.query(`UPDATE interview_sessions SET state = 'evaluating', last_activity_at = now() - interval '10 minutes', progress = progress - 'evaluatingLeaseUntil' WHERE id = $1`, [s2.id]);
    process.env.APP_ROLE = 'worker';
    await t.app.get(JobsService).sweep();
    process.env.APP_ROLE = 'api';
    expect((await t.pool.query('SELECT state FROM interview_sessions WHERE id = $1', [s2.id])).rows[0].state).toBe('asking');
    const s3 = await readySession(t, agent);
    await t.pool.query(`UPDATE interview_turns SET answer = $2, answered_at = now(), evaluation_status = 'pending' WHERE id = $1`, [s3.currentTurn!.turnId, ANSWER]);
    await t.pool.query(`UPDATE interview_sessions SET state = 'evaluating', progress = jsonb_set(progress, '{evaluatingLeaseUntil}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [s3.id]);
    const ended = await agent.post(`/v1/interviews/${s3.id}/end`).set('Origin', ORIGIN);
    expect(ended.status).toBe(200);
    expect(ended.body.state).toBe('scoring');
  });

  it('while the daily AI breaker refuses final scoring, retries are not used up, and the report is generated once it closes (IP-REG0, AR-REG0)', async () => {
    const s = await readySession(t, agent);
    await answerAndEnd(s);
    const { rows: [other] } = await t.pool.query(`SELECT org_id, user_id FROM interview_sessions WHERE user_id <> (SELECT user_id FROM interview_sessions WHERE id = $1) LIMIT 1`, [s.id]);
    const owner = other ?? (await t.pool.query('SELECT org_id, user_id FROM interview_sessions WHERE id = $1', [s.id])).rows[0];
    const spend = (1.11 * t.cfg.AI_GLOBAL_DAILY_CAP_USD).toFixed(2);
    const { rows: [row] } = await t.pool.query(
      `INSERT INTO llm_call_log (org_id, user_id, feature, tier, model, prompt_version, status, estimated_cost_usd, cost_usd)
       VALUES ($1, $2, 'test.breaker', 'LARGE', 'claude-sonnet-5-5', 't', 'settled', $3, $3) RETURNING id`,
      [owner.org_id, owner.user_id, spend],
    );
    try {
      await drainJobs(t, { only: ['interview.final_scoring'] }); // no throw: nothing for the queue to retry
      const failed = await agent.get(`/v1/interviews/${s.id}`);
      expect(failed.body).toMatchObject({ state: 'failed', failure: { code: 'AI_SERVICE_PAUSED', stage: 'scoring' }, report: { status: 'failed', retriesLeft: 3 } });
      for (let i = 0; i < 4; i++) {
        const retry = await agent.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
        expect(retry.status).toBe(503);
        expect(retry.body.error).toMatchObject({ code: 'AI_SERVICE_PAUSED', retryable: false });
        expect(retry.body.error.message).toMatch(/00:00 UTC/);
        expect(Number(retry.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect((await progressOfRow(s.id)).retryReportCount ?? 0).toBe(0);
    } finally {
      await t.pool.query('DELETE FROM llm_call_log WHERE id = $1', [row.id]);
    }
    // The next sweep after the breaker closes resumes it; the learner does not have to come back.
    expect(await t.app.get(JobsService).resumePausedScoring()).toBeGreaterThanOrEqual(1);
    await drainJobs(t);
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
  });

  it('a provider outage does not use up report retries: attempts that billed nothing are free (IP-REG0)', async () => {
    const s = await readySession(t, agent);
    await answerAndEnd(s);
    for (let i = 0; i < 5; i++) {
      t.llm.failNext('turn_assessment', 'unavailable');
      await expect(drainJobs(t, { only: ['interview.final_scoring'] })).rejects.toThrow();
      await t.app.get(JobsService).onDeadLetter({ kind: 'final_scoring', sessionId: s.id });
      await t.pool.query(`UPDATE pgboss.job SET state = 'failed' WHERE name = 'interview.final_scoring' AND state IN ('created', 'retry')`);
      const view = await agent.get(`/v1/interviews/${s.id}`);
      expect(view.body.report.retriesLeft).toBe(3);
      const retry = await agent.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
      expect(retry.status, `retry ${i + 1}`).toBe(202);
    }
    await drainJobs(t);
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
  });

  it('billed failures are capped: the fourth retry is refused with its own code and the button goes away (IP-REG0, UX-REG4)', async () => {
    const s = await readySession(t, agent);
    await answerAndEnd(s);
    const { withUsage } = await import('../src/platform/ports/llm.port.js');
    const { PortError } = await import('@threatready/shared');
    t.llm.overrides.set('turn_assessment', () => {
      throw withUsage(new PortError('invalid_output', 'truncated', { retryable: true }), { model: t.cfg.LLM_MODEL_LARGE, inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
    const fail = async () => {
      await expect(drainJobs(t, { only: ['interview.final_scoring'] })).rejects.toThrow();
      await t.app.get(JobsService).onDeadLetter({ kind: 'final_scoring', sessionId: s.id });
      await t.pool.query(`UPDATE pgboss.job SET state = 'failed' WHERE name = 'interview.final_scoring' AND state IN ('created', 'retry')`);
    };
    await fail();
    for (let i = 1; i <= 3; i++) {
      expect((await agent.get(`/v1/interviews/${s.id}`)).body.report.retriesLeft).toBe(4 - i);
      expect((await agent.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN)).status, `retry ${i}`).toBe(202);
      await fail();
    }
    const view = await agent.get(`/v1/interviews/${s.id}`);
    expect(view.body.report.retriesLeft).toBe(0);
    const refused = await agent.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'REPORT_RETRY_LIMIT_REACHED', retryable: false });
  });

  it('a report PDF lost with the instance storage is rendered again instead of a broken link (TR-36)', async () => {
    const s = await readySession(t, agent);
    await answerAndEnd(s);
    await drainJobs(t);
    const first = await agent.get(`/v1/interviews/${s.id}/report/pdf`);
    expect(first.status).toBe(200);
    const { rows: [r] } = await t.pool.query('SELECT object_key FROM reports WHERE session_id = $1', [s.id]);
    const { STORAGE_PORT } = await import('../src/platform/ports/storage.port.js');
    await t.app.get<{ delete(k: string): Promise<void> }>(STORAGE_PORT).delete(r.object_key);
    const gone = await agent.get(`/v1/interviews/${s.id}/report/pdf`);
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe('REPORT_NOT_READY');
    expect(Number(gone.headers['retry-after'])).toBeGreaterThan(0);
    await drainJobs(t, { only: ['interview.report_pdf'] });
    const again = await agent.get(`/v1/interviews/${s.id}/report/pdf`);
    expect(again.status).toBe(200);
    const target = new URL(again.body.url);
    const file = await agent.get(`${target.pathname}${target.search}`);
    expect(file.status).toBe(200);
  });

  it('a final-scoring retry does not pay again for answers already assessed (TR-08)', async () => {
    const s = await readySession(t, agent);
    await answerAndEnd(s);
    t.llm.reset();
    t.llm.failNext('report_summary', 'unavailable');
    await expect(drainJobs(t, { only: ['interview.final_scoring'] })).rejects.toThrow(); // the batches ran, the summary failed
    expect((await progressOfRow(s.id)).scoringCheckpoint.turns).toHaveProperty(s.currentTurn!.turnId);
    await drainJobs(t); // the queue's retry
    expect((await agent.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
    expect(t.llm.calls.filter((c) => c.name === 'turn_assessment')).toHaveLength(1);
    expect(t.llm.calls.filter((c) => c.name === 'report_summary')).toHaveLength(2);
    expect((await progressOfRow(s.id)).scoringCheckpoint).toBeUndefined(); // cleared with the report
  });

  it('final scoring stops at its per-session ceiling, without queue retries, and is not offered again (TR-08 IP-07)', async () => {
    const capped = await startApp({ AI_FINALIZE_SOURCE_CAP_USD: '0.0001', INTERVIEW_MAX_OPEN_SESSIONS: '50', INTERVIEW_MONTHLY_QUOTA_FREE: '100', RATE_LIMIT_SCALE: '20' });
    try {
      const a = await signUp(capped, 'Ceiling Learner');
      const s = await readySession(capped, a);
      await sse(a, `/v1/interviews/${s.id}/turns`, { turnId: s.currentTurn!.turnId, answer: ANSWER, clientSubmissionId: randomUUID() });
      expect((await a.post(`/v1/interviews/${s.id}/end`).set('Origin', ORIGIN).send({ reason: 'candidate_ended' })).body.state).toBe('scoring');
      capped.llm.reset();
      await drainJobs(capped, { only: ['interview.final_scoring'] }); // no throw: nothing for the queue to retry
      expect(capped.llm.calls.filter((c) => c.name === 'turn_assessment')).toHaveLength(0);
      const view = (await a.get(`/v1/interviews/${s.id}`)).body;
      expect(view).toMatchObject({ state: 'failed', failure: { code: 'LLM_BUDGET_EXCEEDED', stage: 'scoring' }, report: { status: 'failed', retriesLeft: 0 } });
      const retry = await a.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('REPORT_RETRY_LIMIT_REACHED');
      // Support's recovery (scripts/retry-report.ts --reset --allow-usd=5) raises only this session's
      // ceiling; the report is then generated.
      expect(await capped.app.get(InterviewService).resetReportRetries(s.id, 5)).toEqual({ extraSourceCapUsd: 5 });
      const again = await a.post(`/v1/interviews/${s.id}/report/retry`).set('Origin', ORIGIN);
      expect(again.status).toBe(202);
      await drainJobs(capped, { only: ['interview.final_scoring'] });
      expect(capped.llm.calls.filter((c) => c.name === 'turn_assessment').length).toBeGreaterThan(0);
      expect((await a.get(`/v1/interviews/${s.id}`)).body.state).toBe('report_ready');
    } finally {
      await capped.close();
    }
  });

  it('parallel clarifications cannot exceed three or each pay for a reply (TR-08)', async () => {
    const s = await readySession(t, agent);
    const turnId = s.currentTurn!.turnId;
    t.llm.reset();
    t.llm.delayMs = 200; // every request has taken or been refused its slot before the first reply arrives
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sse(agent, `/v1/interviews/${s.id}/clarify`, { turnId, message: `Could you clarify part ${i}?` })));
    t.llm.delayMs = 0;
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.raw.body).toContain('CLARIFICATION_LIMIT_REACHED');
    expect(t.llm.calls.filter((c) => c.promptVersion === 'clarify.v2')).toHaveLength(3);
    const view = (await agent.get(`/v1/interviews/${s.id}`)).body;
    expect(view.currentTurn.clarifications).toHaveLength(3);
    expect(view.currentTurn.clarifications.every((c: { answer: string }) => c.answer.length > 0)).toBe(true);
  });

  it('a session cancelled after its analysis counts toward the monthly quota; one cancelled before does not (TR-08 IP-06)', async () => {
    const one = await startApp({ INTERVIEW_MONTHLY_QUOTA_FREE: '1', INTERVIEW_MAX_OPEN_SESSIONS: '5' });
    try {
      const a = await signUp(one, 'Cancel Loop');
      const resume = await uploadDocument(one, a, 'resume', await docxFrom(RESUME_TEXT));
      const jd = await a.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
      const body = { resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT };
      const early = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect((await a.post(`/v1/interviews/${early.body.id}/cancel`).set('Origin', ORIGIN)).body.state).toBe('cancelled'); // before analysis ran
      const analysed = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect(analysed.status).toBe(202);
      await drainJobs(one, { only: ['interview.analyse'] });
      expect((await a.post(`/v1/interviews/${analysed.body.id}/cancel`).set('Origin', ORIGIN)).body.state).toBe('cancelled');
      const again = await a.post('/v1/interviews').set('Origin', ORIGIN).send(body);
      expect(again.status).toBe(403);
      expect(again.body.error.code).toBe('ENTITLEMENT_QUOTA_EXCEEDED');
      expect((await a.get('/v1/interview-prep/dashboard')).body.usage.interviewsThisMonth).toBe(1);
    } finally {
      await one.close();
    }
  });
});
