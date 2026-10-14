import { AI_CONSENT_VERSION } from '@threatready/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  docxFrom,
  drainJobs,
  identities,
  identityCalls,
  JD_TEXT,
  ORIGIN,
  resetDatabase,
  RESUME_TEXT,
  signOutEverywhere,
  signUp,
  startApp,
  uploadDocument,
  type Agent,
  type TestApp,
} from './harness.js';

const CONSENT = { accepted: true, version: AI_CONSENT_VERSION } as const;
const TOKEN = () => `Bearer ${process.env.INTERNAL_API_TOKEN}`;
const RANGE = () => {
  const to = new Date(Date.now() + 60_000);
  return { from: new Date(to.getTime() - 86_400_000).toISOString(), to: to.toISOString() };
};

describe('platform: identity from onboard, internal API for onboard', () => {
  let t: TestApp;
  let learner: Agent;
  let learnerId: string;
  let sessionId: string;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp();
    learner = await signUp(t, 'Asha Rao');
    const me = await learner.get('/v1/me');
    learnerId = me.body.id;
    const resume = await uploadDocument(t, learner, 'resume', await docxFrom(RESUME_TEXT));
    const jd = await learner.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const s = await learner.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    sessionId = s.body.id;
    await drainJobs(t);
  });
  afterAll(async () => t?.close());

  it('has no local sign-in: /api/auth is gone', async () => {
    const res = await request(t.app.getHttpServer()).post('/api/auth/sign-up/email').set('Origin', ORIGIN).send({});
    expect(res.status).toBe(404);
  });

  it('resolves the shared session cookie through onboard and mirrors the user', async () => {
    const me = await learner.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: 'Asha Rao', isAdmin: false });
    const last = identityCalls.at(-1)!;
    expect(last.authorization).toBe(TOKEN());
    expect(last.cookie).toMatch(/tr\.session_token=/);
    const { rows } = await t.pool.query('SELECT name, email_verified FROM users WHERE id = $1', [learnerId]);
    expect(rows[0]).toMatchObject({ name: 'Asha Rao', email_verified: true });
  });

  it('refuses requests without a session, and a session onboard has ended', async () => {
    expect((await request(t.app.getHttpServer()).get('/v1/me')).status).toBe(401);
    const bogus = await request(t.app.getHttpServer()).get('/v1/me').set('Cookie', 'tr.session_token=nope');
    expect(bogus.status).toBe(401);
    expect(bogus.body.error.code).toBe('AUTH_REQUIRED');

    const leaving = await signUp(t, 'Leaving User');
    expect((await leaving.get('/v1/me')).status).toBe(200);
    signOutEverywhere(leaving);
    expect((await leaving.get('/v1/me')).status).toBe(401);
  });

  it('asks a no-account trial session to create an account', async () => {
    const trial = await signUp(t, 'Trial user', { isTrial: true, email: null });
    const res = await trial.get('/v1/interview-prep/dashboard');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_REQUIRED');
  });

  it('marks platform admins as staff', async () => {
    const admin = await signUp(t, 'Admin Person', { isAdmin: true });
    expect((await admin.get('/v1/me')).body.isAdmin).toBe(true);
  });

  it('reports a down identity provider as unavailable, not as signed out', async () => {
    const broken = await startApp({ IDENTITY_URL: 'http://127.0.0.1:9' });
    try {
      const res = await request(broken.app.getHttpServer()).get('/v1/me').set('Cookie', 'tr.session_token=x');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE', retryable: true });
    } finally {
      await broken.close();
    }
  });

  describe('internal API', () => {
    const server = () => request(t.app.getHttpServer());

    it('requires the internal token', async () => {
      for (const path of [`/internal/v1/users/${learnerId}/summary`, `/internal/v1/ai-usage?from=${RANGE().from}&to=${RANGE().to}`]) {
        expect((await server().get(path)).status).toBe(401);
        expect((await server().get(path).set('Authorization', 'Bearer wrong-token')).status).toBe(401);
        // A browser session is not enough either.
        expect((await learner.get(path)).status).toBe(401);
      }
    });

    it("summarises one user's interviews and lifetime AI usage", async () => {
      const res = await server().get(`/internal/v1/users/${learnerId}/summary`).set('Authorization', TOKEN());
      expect(res.status).toBe(200);
      expect(res.body.app).toBe('interview');
      expect(res.body.stats.map((s: { label: string }) => s.label)).toContain('Interviews completed');
      const item = res.body.items.find((i: { id: string }) => i.id === sessionId);
      expect(item.url).toBe(`${ORIGIN}/interview-prep/sessions/${sessionId}`);
      expect(res.body.aiUsage.calls).toBeGreaterThan(0);
      expect(res.body.aiUsage.inputTokens).toBeGreaterThan(0);
      expect(res.body.aiUsage.costUsd).toBeGreaterThan(0);
    });

    it("never shows one user another user's interviews", async () => {
      const other = await signUp(t, 'Someone Else');
      const otherId = (await other.get('/v1/me')).body.id;
      const res = await server().get(`/internal/v1/users/${otherId}/summary`).set('Authorization', TOKEN());
      expect(res.body.items).toEqual([]);
      expect(res.body.aiUsage.calls).toBe(0);
    });

    it('aggregates AI usage per user, model and feature, matching the ledger', async () => {
      const { from, to } = RANGE();
      const res = await server().get('/internal/v1/ai-usage').query({ from, to }).set('Authorization', TOKEN());
      expect(res.status).toBe(200);
      const mine = res.body.users.find((u: { userId: string }) => u.userId === learnerId);
      const { rows } = await t.pool.query(
        `SELECT count(*) FILTER (WHERE status <> 'failed')::int AS calls, COALESCE(sum(input_tokens),0)::int AS input
           FROM llm_call_log WHERE user_id = $1`,
        [learnerId],
      );
      expect(mine.calls).toBe(rows[0].calls);
      expect(mine.inputTokens).toBe(rows[0].input);
      expect(res.body.byModel.length).toBeGreaterThan(0);
      expect(res.body.byFeature.length).toBeGreaterThan(0);

      const one = await server().get('/internal/v1/ai-usage').query({ from, to, userId: 'nobody' }).set('Authorization', TOKEN());
      expect(one.body.users).toEqual([]);
    });

    it('validates the range', async () => {
      const bad = await server().get('/internal/v1/ai-usage').query({ from: 'yesterday', to: 'today' }).set('Authorization', TOKEN());
      expect(bad.status).toBe(422);
    });
  });

  it('keeps the stub honest: unknown cookies stay unknown', () => {
    expect(identities.has('nope')).toBe(false);
  });
});
