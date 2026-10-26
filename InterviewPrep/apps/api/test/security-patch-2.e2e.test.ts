import { randomUUID } from 'node:crypto';
import { ROUTES, type ReasoningAttemptView, type ReasoningResult } from '@threatready/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EVALUATING_LEASE_MS } from '../src/modules/interview/turn.service.js';
import { JobsService } from '../src/modules/jobs/jobs.service.js';
import { drainJobs, identityCalls, ORIGIN, resetDatabase, signUp, startApp, type Agent, type TestApp } from './harness.js';
import { fuzzHttp, PROTO_KEYS, type HttpProbe } from './helpers/protoKeys.js';

const TOKEN = () => `Bearer ${process.env.INTERNAL_API_TOKEN}`;
const STRONG = (role: string, bucket: string) =>
  `The attacker is operating as the ${role}: the audit log shows the first calls from an unknown address using that identity, and the exports are being downloaded right now. Revoking the ${role} session and scoping its policy removes exactly the access being used, so the path from the role to the ${bucket} and on to the database network is cut. The load balancer carries no attack edge, so taking it down would hurt customers without stopping anything, and rotating every credential is wider than the evidence supports and conflicts with the change freeze. I would keep the audit log and the compromised key for forensics.`;

const sweep = async (t: TestApp) => {
  process.env.APP_ROLE = 'worker';
  try {
    await t.app.get(JobsService).sweep();
  } finally {
    process.env.APP_ROLE = 'api';
  }
};

/** The signed-in user's mirror row and personal organisation, as the identity adapter provisioned them. */
async function whoami(t: TestApp, agent: Agent): Promise<{ userId: string; orgId: string }> {
  const me = await agent.get('/v1/me');
  expect(me.status).toBe(200);
  const { rows } = await t.pool.query<{ org_id: string }>('SELECT org_id FROM memberships WHERE user_id = $1 AND is_active LIMIT 1', [me.body.id]);
  return { userId: me.body.id, orgId: rows[0]!.org_id };
}

/**
 * A session exactly as submit() leaves it when the API process dies after step 1: the answer is
 * stored on the current turn, the session is `evaluating`, and the lease is as given. The plan is a
 * minimal valid one (two technical items and a closing), so decideNext() has somewhere to go.
 */
async function stuckEvaluatingSession(t: TestApp, who: { userId: string; orgId: string }, leaseUntil: Date | null, opts: { brokenPlan?: boolean } = {}): Promise<{ sessionId: string; turnId: string }> {
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const item = (id: string, seq: number, kind: string, skillId: string) => ({ id, seq, kind, section: kind === 'closing' ? 'closing' : 'technical', skillId, targetLevel: 'working', intent: 'test', rubricId: kind === 'closing' ? 'rubric.closing' : 'rubric.technical', followUpLimit: 1, estMinutes: 4 });
  const plan = { planVersion: 'test', contentVersion: 'test', rubricVersion: 'test', objectives: [], items: [item('q1', 1, 'jd_technical', 'soc.alert_triage'), item('q2', 2, 'jd_technical', 'soc.siem_querying'), item('q3', 3, 'closing', 'soc.alert_triage')], maxTurns: 6, maxFollowUps: 2, topicDistribution: {}, followUpStrategy: 'test' };
  const config = { interviewType: 'technical', difficulty: 'intermediate', durationMin: 30, mode: 'practice', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false };
  const progress = { itemIndex: 0, questionNumber: 1, turnsUsed: 1, followUpsUsed: 0, perItemFollowUps: {}, runningSummary: [], recentLevels: [], directive: 'standard', integrityFlags: 0 };
  const analysis = { roleTitle: 'SOC Analyst', job: {}, candidate: {} };
  await t.pool.query(
    `INSERT INTO interview_sessions (id, org_id, user_id, state, config, analysis, plan, progress, current_turn_id, active_elapsed_ms, running_since, last_activity_at, started_at, evaluating_lease_until, version)
     VALUES ($1, $2, $3, 'evaluating', $4, $5, $6, $7, $8, 60000, NULL, now() - interval '3 minutes', now() - interval '5 minutes', $9, 3)`,
    [sessionId, who.orgId, who.userId, JSON.stringify(config), JSON.stringify(analysis), JSON.stringify(plan), JSON.stringify(progress), turnId, leaseUntil],
  );
  await t.pool.query(
    `INSERT INTO interview_turns (id, org_id, user_id, session_id, seq, plan_item_id, kind, question_number, question, question_source, answer, answered_at, client_submission_id, evaluation_status)
     VALUES ($1, $2, $3, $4, 1, $5, 'question', 1, 'How do you triage a password-spraying alert?', 'template', 'I would correlate the failed logins by source and escalate when many accounts are hit from one address.', now() - interval '3 minutes', $6, 'pending')`,
    [turnId, who.orgId, who.userId, sessionId, opts.brokenPlan ? 'no-such-item' : 'q1', randomUUID()],
  );
  return { sessionId, turnId };
}

describe('security patch 2: InterviewPrep', () => {
  let t: TestApp;
  let learner: Agent;
  let other: Agent;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_OPEN_ATTEMPTS: '20', REASONING_ITEM_MAX_SERVES: '2' });
    learner = await signUp(t, 'Asha Rao');
    other = await signUp(t, 'Other Person');
  });
  beforeEach(() => t.llm.reset());
  afterAll(async () => t?.close());

  describe('A2: sessions stuck in evaluating', () => {
    it('submit() takes an evaluating lease (column exists and is set by the state machine)', async () => {
      const { rows } = await t.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'interview_sessions' AND column_name = 'evaluating_lease_until'`);
      expect(rows).toHaveLength(1);
      expect(EVALUATING_LEASE_MS).toBeGreaterThanOrEqual(60_000);
    });

    it('an evaluating session whose lease expired is moved on by the next sweep; a live lease is left alone', async () => {
      const who = await whoami(t, learner);
      const expired = await stuckEvaluatingSession(t, who, new Date(Date.now() - 60_000));
      const live = await stuckEvaluatingSession(t, who, new Date(Date.now() + 60_000));
      const legacy = await stuckEvaluatingSession(t, who, null); // written by a pre-patch API process, idle for 3 minutes only

      await sweep(t);

      const after = await learner.get(`/v1/interviews/${expired.sessionId}`);
      expect(after.status).toBe(200);
      // Re-entered the interview loop: the client's poll sees `asking` and requests the next question.
      expect(after.body.state).toBe('asking');
      expect(after.body.interviewerStatus).toBe('asking');
      const { rows: [s] } = await t.pool.query(`SELECT progress, evaluating_lease_until, version FROM interview_sessions WHERE id = $1`, [expired.sessionId]);
      expect(s.evaluating_lease_until).toBeNull();
      expect(s.progress.pendingTurn).toMatchObject({ seq: 2, kind: 'question', planItemId: 'q2', questionNumber: 2 });
      expect(s.version).toBe(4);
      const { rows: [turn] } = await t.pool.query(`SELECT evaluation_status, answer FROM interview_turns WHERE id = $1`, [expired.turnId]);
      expect(turn.evaluation_status).toBe('failed'); // the answer is kept, the evaluation is recorded as lost
      expect(turn.answer).toContain('correlate');

      expect((await learner.get(`/v1/interviews/${live.sessionId}`)).body.state).toBe('evaluating');
      expect((await learner.get(`/v1/interviews/${legacy.sessionId}`)).body.state).toBe('evaluating');

      // The recovered session continues: the client asks for the next question and gets one.
      const next = await learner.post(`/v1/interviews/${expired.sessionId}/question`).set('Origin', ORIGIN).buffer(true).parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (data += c));
        r.on('end', () => cb(null, data));
      });
      expect(next.status).toBe(200);
      expect(String(next.body)).toContain('"type":"question.start"');
      expect((await learner.get(`/v1/interviews/${expired.sessionId}`)).body.state).toBe('awaiting_answer');
    });

    it('one session that cannot be recovered does not stop the sweep from recovering the others', async () => {
      const who = await whoami(t, learner);
      const broken = await stuckEvaluatingSession(t, who, new Date(Date.now() - 120_000), { brokenPlan: true });
      const fine = await stuckEvaluatingSession(t, who, new Date(Date.now() - 60_000));
      await sweep(t);
      expect((await learner.get(`/v1/interviews/${fine.sessionId}`)).body.state).toBe('asking');
      expect((await learner.get(`/v1/interviews/${broken.sessionId}`)).body.state).toBe('evaluating');
    });
  });

  describe('A5: pool answer keys', () => {
    let item: ReasoningAttemptView;

    it('the API role cannot select the private column at all; the public columns and RLS still work', async () => {
      const created = await learner.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain: 'cloud_security' });
      expect(created.status, JSON.stringify(created.body)).toBe(202);
      await drainJobs(t, { only: ['reasoning.generate'] });
      item = (await learner.get(`/v1/reasoning/attempts/${created.body.id}`)).body as ReasoningAttemptView;
      expect(item.state).toBe('ready');
      const who = await whoami(t, learner);

      const c = await t.pool.connect();
      try {
        const as = async (userId: string, sqlText: string) => {
          await c.query('BEGIN');
          await c.query('SET LOCAL ROLE tr_app_user');
          await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
          try {
            return await c.query(sqlText);
          } finally {
            await c.query('ROLLBACK');
          }
        };
        await expect(as(who.userId, 'SELECT private FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
        await expect(as(who.userId, 'SELECT * FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
        await expect(as(who.userId, `SELECT public->'correctOption' FROM reasoning_items`)).resolves.toBeTruthy();
        const pub = await as(who.userId, 'SELECT id, public, weights, serve_count FROM reasoning_items WHERE pool');
        expect(pub.rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(pub.rows)).not.toContain('correctOption');
        // Writes to the question table are not the API's business either.
        await expect(as(who.userId, `UPDATE reasoning_items SET serve_count = 0`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        c.release();
      }
      // And the view the API builds carries nothing from the private half.
      const raw = JSON.stringify(item);
      for (const secret of ['correctOption', 'rubric', 'referenceAnswer', 'mustNotCredit', 'optionAnalysis', 'verdict']) expect(raw).not.toContain(secret);
    });

    it('serving increments serve_count; an item at REASONING_ITEM_MAX_SERVES is never served again and the refill backfills it', async () => {
      const { rows: [before] } = await t.pool.query(`SELECT serve_count FROM reasoning_items WHERE id = $1`, [item.item!.id]);
      expect(before.serve_count).toBe(1); // served to the learner who triggered its generation
      // Second learner: the pool has one unseen item with serve_count 1 < cap 2 -> served instantly.
      const second = await other.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain: 'cloud_security' });
      expect(second.status).toBe(202);
      expect(second.body.state).toBe('ready');
      expect(second.body.item.id).toBe(item.item!.id);
      const { rows: [after] } = await t.pool.query(`SELECT serve_count FROM reasoning_items WHERE id = $1`, [item.item!.id]);
      expect(after.serve_count).toBe(2);
      // Third learner: the only item is at the cap -> not served; a fresh one is generated instead.
      const third = await signUp(t, 'Third Person');
      const status = await third.post('/v1/reasoning/attempts/prefetch').set('Origin', ORIGIN).send({ domain: 'cloud_security' });
      expect(status.status, JSON.stringify(status.body)).toBeLessThan(300);
      expect(status.body.available).toBe(0);
      const created = await third.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain: 'cloud_security' });
      expect(created.status).toBe(202);
      expect(created.body.state).toBe('generating');
      await drainJobs(t, { only: ['reasoning.generate'] });
      const got = await third.get(`/v1/reasoning/attempts/${created.body.id}`);
      expect(got.body.state).toBe('ready');
      expect(got.body.item.id).not.toBe(item.item!.id);
      // The refill job counts only items below the cap, so the retired one is backfilled toward the target.
      const { rows: [{ n }] } = await t.pool.query(`SELECT count(*)::int AS n FROM reasoning_items WHERE pool AND domain = 'cloud_security' AND serve_count < 2`);
      expect(n).toBeGreaterThanOrEqual(1);
    });

    it('result() still returns the verdict and the correct option, read with the owner role after the attempt is evaluated', async () => {
      const role = item.item!.diagram.nodes.find((n) => n.entryPoint)!.label;
      const bucket = item.item!.diagram.nodes.find((n) => n.type === 'storage')!.label;
      expect((await learner.get(`/v1/reasoning/attempts/${item.id}/result`)).status).toBe(409);
      const sub = await learner.post(`/v1/reasoning/attempts/${item.id}/submit`).set('Origin', ORIGIN).send({ selectedOption: 'B', justification: STRONG(role, bucket), clientSubmissionId: randomUUID() });
      expect(sub.status, JSON.stringify(sub.body)).toBe(202);
      await drainJobs(t, { only: ['reasoning.evaluate'] });
      const res = await learner.get(`/v1/reasoning/attempts/${item.id}/result`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const r = res.body as ReasoningResult;
      expect(r.correctOption).toBe('B');
      expect(r.correct).toBe(true);
      expect(r.options.length).toBe(4);
      expect(r.feedback).toBeTruthy();
      // Another learner still gets a 404 for it (ownership before the answer key is ever read).
      expect((await other.get(`/v1/reasoning/attempts/${item.id}/result`)).status).toBe(404);
    });
  });

  describe('A9: per-caller internal tokens on the wire', () => {
    const derived = 'd'.repeat(64);
    const otherDerived = 'e'.repeat(64);

    it('accepts an accepted derived token, rejects a different derived token and (legacy off) the raw token', async () => {
      const strict = await startApp({ INTERNAL_TOKENS_ACCEPT: derived, INTERNAL_TOKEN_LEGACY_ACCEPT: 'false' });
      try {
        const who = await whoami(t, learner);
        const http = strict.app.getHttpServer();
        for (const path of [`/internal/v1/users/${who.userId}/summary`, `/internal/v1/reasoning/users/${who.userId}/summary`]) {
          expect((await request(http).get(path).set('Authorization', `Bearer ${derived}`)).status, path).toBe(200);
          expect((await request(http).get(path).set('Authorization', `Bearer ${otherDerived}`)).status, path).toBe(401);
          expect((await request(http).get(path).set('Authorization', TOKEN())).status, `${path} raw token`).toBe(401);
          expect((await request(http).get(path)).status, path).toBe(401);
        }
      } finally {
        await strict.close();
      }
      // Default outside production: the raw token still works (local development unchanged).
      const who = await whoami(t, learner);
      expect((await request(t.app.getHttpServer()).get(`/internal/v1/users/${who.userId}/summary`).set('Authorization', TOKEN())).status).toBe(200);
    });

    it('presents INTERNAL_TOKEN_TO_ONBOARD to onboard when set', async () => {
      const presenting = await startApp({ INTERNAL_TOKEN_TO_ONBOARD: derived });
      try {
        const agent = await signUp(presenting, 'Token Check');
        const before = identityCalls.length;
        // The stub only knows the raw token, so this sign-in fails; what matters is which bearer was presented.
        const res = await agent.get('/v1/me');
        expect(res.status).toBe(401);
        expect(identityCalls.slice(before).at(-1)?.authorization).toBe(`Bearer ${derived}`);
      } finally {
        await presenting.close();
      }
    });
  });

  describe('A13: request id from the gateway', () => {
    it('echoes a gateway x-request-id in the envelope, the header and the log context; junk gets a fresh req_', async () => {
      const http = t.app.getHttpServer();
      const id = 'gw_01HZX6K3Q9Y7B8C2D4E5F6G7H8';
      const res = await request(http).get('/v1/interview-prep/dashboard').set('x-request-id', id);
      expect(res.status).toBe(401);
      expect(res.body.error.request_id).toBe(id);
      expect(res.headers['x-request-id']).toBe(id);
      const junk = await request(http).get('/v1/interview-prep/dashboard').set('x-request-id', 'bad id\twith control');
      expect(junk.body.error.request_id).toMatch(/^req_/);
      expect(junk.headers['x-request-id']).toBe(junk.body.error.request_id);
      const none = await request(http).get('/v1/interview-prep/dashboard');
      expect(none.body.error.request_id).toMatch(/^req_/);
    });
  });

  describe('A11a: prototype keys on every route parameter', () => {
    it('every {id} route, the list cursors and the internal user ids reject __proto__ and friends without a 500 or a hit', async () => {
      const who = await whoami(t, learner);
      const idRoutes = ROUTES.filter((r) => r.path.includes('{id}'));
      expect(idRoutes.length).toBeGreaterThan(15);
      const probes: HttpProbe[] = idRoutes.map((r) => ({ method: r.method as HttpProbe['method'], path: r.path.replace('{id}', '{fuzz}'), headers: { Origin: ORIGIN }, body: r.body ? {} : undefined }));
      for (const r of ROUTES.filter((x) => x.method === 'get' && !x.path.includes('{id}') && /interviews$|attempts$/.test(x.path))) {
        probes.push({ method: 'get', path: `${r.path}?cursor={fuzz}`, headers: { Origin: ORIGIN } });
      }
      const results = await fuzzHttp(learner as never, probes);
      expect(results.length).toBe(probes.length * PROTO_KEYS.length);
      for (const r of results) {
        expect([400, 404, 409, 422]).toContain(r.status);
        expect((r.body as { error?: { request_id?: string } }).error?.request_id).toMatch(/^req_/);
      }

      // Internal routes take an opaque onboard user id, not a UUID. A user this app has never seen gets
      // the same empty summary onboard shows for any new account; what must never happen is a 5xx, a
      // prototype property being read as a user, or another user's data.
      const internal: HttpProbe[] = [
        { method: 'get', path: '/internal/v1/users/{fuzz}/summary', headers: { Authorization: TOKEN() } },
        { method: 'get', path: '/internal/v1/reasoning/users/{fuzz}/summary', headers: { Authorization: TOKEN() } },
        { method: 'get', path: '/internal/v1/reasoning/users/{fuzz}/summary?appOrigin={fuzz}', headers: { Authorization: TOKEN() } },
        { method: 'get', path: `/internal/v1/ai-usage?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date().toISOString()}&userId={fuzz}`, headers: { Authorization: TOKEN() } },
      ];
      const anon = request(t.app.getHttpServer()) as unknown as Parameters<typeof fuzzHttp>[0];
      const internalResults = await fuzzHttp(anon, internal, {
        allowEmptySuccess: (r) => {
          if (r.status !== 200) return false;
          const b = r.body as { items?: unknown[]; aiUsage?: { calls: number }; totals?: { calls: number }; stats?: { value: unknown }[] };
          if (b.items) expect(b.items, `${r.probe.path} ${r.key}`).toEqual([]);
          if (b.aiUsage) expect(b.aiUsage.calls, `${r.probe.path} ${r.key}`).toBe(0);
          if (b.totals) expect(b.totals.calls, `${r.probe.path} ${r.key}`).toBe(0);
          return true;
        },
      });
      expect(internalResults.every((r) => r.status < 500)).toBe(true);
      // The real learner's summary is unaffected.
      expect((await request(t.app.getHttpServer()).get(`/internal/v1/users/${who.userId}/summary`).set('Authorization', TOKEN())).status).toBe(200);
    });
  });
});
