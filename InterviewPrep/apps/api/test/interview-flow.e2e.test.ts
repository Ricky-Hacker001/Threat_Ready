import { AI_CONSENT_VERSION } from '@threatready/contracts';
import { randomUUID } from 'node:crypto';
import type { SessionView } from '@threatready/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docxFrom, drainJobs, JD_TEXT, ORIGIN, resetDatabase, RESUME_TEXT, signUp, sse, startApp, uploadDocument, type Agent, type TestApp } from './harness.js';

const CONSENT = { accepted: true, version: AI_CONSENT_VERSION } as const;

const config = { interviewType: 'cybersecurity_scenario', difficulty: 'intermediate', durationMin: 15, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false };

/** Plays the interview to the end, answering every question. Returns the final session view. */
export async function playInterview(agent: Agent, sessionId: string, answer: (n: number) => string): Promise<{ session: SessionView; questions: string[] }> {
  const start = await sse(agent, `/v1/interviews/${sessionId}/start`);
  expect(start.status).toBe(200);
  let done = start.events.find((e) => e.type === 'done');
  expect(done, JSON.stringify(start.events)).toBeTruthy();
  let session = (done as { session: SessionView }).session;
  const questions: string[] = [];
  for (let i = 0; i < 30 && session.state === 'awaiting_answer'; i++) {
    questions.push(session.currentTurn!.question);
    const res = await sse(agent, `/v1/interviews/${sessionId}/turns`, { turnId: session.currentTurn!.turnId, answer: answer(i), clientSubmissionId: randomUUID() });
    expect(res.status).toBe(200);
    const err = res.events.find((e) => e.type === 'error');
    expect(err, JSON.stringify(err)).toBeUndefined();
    done = res.events.find((e) => e.type === 'done');
    session = (done as { session: SessionView }).session;
  }
  return { session, questions };
}

const STRONG = (n: number) =>
  `In my role at Aero Fintech I handled this directly. For question ${n + 1}, I would first scope the alert using Splunk, correlate authentication logs across sources, check for password spraying patterns such as many accounts from one IP, enrich the indicators with threat intelligence, and then decide on escalation using our severity matrix. I documented the findings and the containment steps, and we tuned the detection afterwards to reduce false positives.`;

describe('InterviewPrep end to end (fake LLM through LlmPort)', () => {
  let t: TestApp;
  let agent: Agent;
  let sessionId: string;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp();
    agent = await signUp(t);
  });
  afterAll(async () => t?.close());

  it('uploads a resume, extracts and redacts it', async () => {
    const doc = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    expect(doc.status).toBe('extracted');
    expect(doc.extractedText).toContain('Splunk');
    expect(doc.extractedText).not.toContain('priya.sharma@example.com');
    expect(doc.extractedText).not.toContain('98765');
    expect(doc.extractedText).toContain('[EMAIL]');
    expect(doc.extractedText.split('\n')[0]).toBe('[NAME]');
    expect(doc.redactions.email).toBe(1);
  });

  it('runs the whole interview: analysis, briefing, plan, adaptive turns, report', async () => {
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    expect(jd.status).toBe(201);

    const created = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body.state).toBe('parsing');
    sessionId = created.body.id;

    expect((await agent.get(`/v1/interviews/${sessionId}/briefing`)).body.error.code).toBe('PARSE_IN_PROGRESS');
    await drainJobs(t, { only: ['interview.analyse'] });

    const briefing = await agent.get(`/v1/interviews/${sessionId}/briefing`);
    expect(briefing.status).toBe(200);
    expect(briefing.body.jobProfile.role_id).toBe('soc_analyst');
    expect(briefing.body.recommendation.track).toBe('soc_analyst');
    expect(briefing.body.candidateProfile.skills.length).toBeGreaterThan(2);
    // The raw resume was sent once (parse); the gap analysis received profiles only.
    const parseCalls = t.llm.calls.filter((c) => c.name === 'candidate_profile');
    expect(parseCalls).toHaveLength(1);

    const planned = await agent.post(`/v1/interviews/${sessionId}/plan`).set('Origin', ORIGIN).send({ config });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    expect(planned.body.state).toBe('planned');
    expect(planned.body.progress.plannedQuestions).toBeGreaterThanOrEqual(3);

    const { session, questions } = await playInterview(agent, sessionId, STRONG);
    expect(session.state).toBe('scoring');
    expect(questions[0]).toMatch(/^Hi Priya, I'm Alex/);
    expect(new Set(questions).size).toBe(questions.length); // no repeated questions

    const ran = await drainJobs(t);
    expect(ran).toContain('interview.final_scoring');
    expect(ran).toContain('skills.recalculate');
    expect(ran).toContain('interview.report_pdf');

    const view = await agent.get(`/v1/interviews/${sessionId}`);
    expect(view.body.state).toBe('report_ready');
    const report = await agent.get(`/v1/interviews/${sessionId}/report`);
    expect(report.status).toBe(200);
    expect(report.body.overall.score).toBeGreaterThan(0);
    expect(report.body.disclaimer).toMatch(/not a prediction of hiring success/);
    expect(report.body.questions.length).toBe(questions.length);
    expect(report.body.pdf.available).toBe(true);
    for (const q of report.body.questions) {
      expect(q.score === null || (q.score >= 0 && q.score <= 100)).toBe(true);
    }
  });

  it('report-job retries are idempotent: no duplicate evaluations, evidence or reports', async () => {
    const count = async (table: string) => Number((await t.pool.query(`SELECT count(*) FROM ${table} WHERE session_id = $1`, [sessionId])).rows[0].count);
    const ev = await count('evaluations');
    const rep = await count('reports');
    const evid = Number((await t.pool.query(`SELECT count(*) FROM skill_evidence WHERE source_id = $1`, [sessionId])).rows[0].count);
    // Simulate a redelivered job after success.
    await t.pool.query(`UPDATE interview_sessions SET state = 'scoring' WHERE id = $1`, [sessionId]);
    const { ReportsService } = await import('../src/modules/reports/reports.service.js');
    process.env.APP_ROLE = 'worker';
    await t.app.get(ReportsService).runFinalScoring(sessionId);
    await t.app.get(ReportsService).runFinalScoring(sessionId);
    process.env.APP_ROLE = 'api';
    expect(await count('evaluations')).toBe(ev);
    expect(await count('reports')).toBe(rep);
    expect(Number((await t.pool.query(`SELECT count(*) FROM skill_evidence WHERE source_id = $1`, [sessionId])).rows[0].count)).toBe(evid);
    expect((await agent.get(`/v1/interviews/${sessionId}`)).body.state).toBe('report_ready');
  });

  it('serves the PDF through a short-lived signed URL, only to the owner', async () => {
    const pdf = await agent.get(`/v1/interviews/${sessionId}/report/pdf`);
    expect(pdf.status).toBe(200);
    expect(new Date(pdf.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(121_000);
    const file = await agent.get(new URL(pdf.body.url).pathname + new URL(pdf.body.url).search);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body).subarray(0, 5).toString()).toBe('%PDF-');

    const other = await signUp(t, 'Other User');
    expect((await other.get(`/v1/interviews/${sessionId}/report/pdf`)).status).toBe(404);
    expect((await other.get(`/v1/interviews/${sessionId}/report`)).status).toBe(404);
  });

  it('dashboard and skills show persisted progress', async () => {
    const dash = await agent.get('/v1/interview-prep/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.completedCount).toBe(1);
    expect(dash.body.averageScore).toBeGreaterThan(0);
    expect(dash.body.scoreHistory).toHaveLength(1);
    const skills = await agent.get('/v1/skills/me');
    expect(skills.body.length).toBeGreaterThan(0);
    const history = await agent.get('/v1/interviews');
    expect(history.body.items.length).toBeGreaterThanOrEqual(1);
    expect(history.body.items[0].overallScore).not.toBeNull();
  });

  it('records token usage and cost for every model call, by session', async () => {
    const { rows } = await t.pool.query(
      `SELECT feature, tier, status, cost_usd FROM llm_call_log WHERE source_id = $1 ORDER BY id`,
      [sessionId],
    );
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.every((r) => r.status === 'settled' && Number(r.cost_usd) > 0)).toBe(true);
    expect(rows.some((r) => r.feature === 'interview.final_scoring' && r.tier === 'LARGE')).toBe(true);
    expect(rows.some((r) => r.feature === 'interview.question' && r.tier === 'SMALL')).toBe(true);
  });
});
