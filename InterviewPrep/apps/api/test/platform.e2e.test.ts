import { AI_CONSENT_VERSION } from '@threatready/contracts';
import { PortError } from '@threatready/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmService } from '../src/modules/ai/llm.service.js';
import { withUsage } from '../src/platform/ports/llm.port.js';
import {
  docxFrom,
  drainJobs,
  identities,
  identityCalls,
  JD_TEXT,
  ORIGIN,
  resetDatabase,
  RESUME_TEXT,
  sessionCookieValue,
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
      const res = await request(broken.app.getHttpServer()).get('/v1/me').set('Cookie', `tr.session_token=${sessionCookieValue()}`);
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

describe('billed failures through LlmService (audit 2026-10-23 TR-09, IP-REG2)', () => {
  let t: TestApp;
  let owner: { userId: string; orgId: string };
  beforeAll(async () => {
    t = await startApp();
    const learner = await signUp(t, 'Billing Probe');
    const userId = (await learner.get('/v1/me')).body.id as string;
    const { rows } = await t.pool.query('SELECT org_id FROM memberships WHERE user_id = $1', [userId]);
    owner = { userId, orgId: rows[0].org_id };
  });
  afterAll(async () => t?.close());

  const req = { tier: 'LARGE' as const, system: 'probe', messages: [{ role: 'user' as const, content: 'probe' }], maxOutputTokens: 100, promptVersion: 'probe.v1' };
  const schema = { name: 'billing_probe', jsonSchema: { type: 'object' }, zod: z.object({ ok: z.boolean() }) };
  const usage = (model: string) => ({ model, inputTokens: 50_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 });

  it('records a billed failure at its real price, dated model ids priced at their model (not the cheapest)', async () => {
    const llm = t.app.get(LlmService);
    t.llm.overrides.set('billing_probe', () => {
      throw withUsage(new PortError('invalid_output', 'truncated', { retryable: true }), usage('claude-sonnet-5-5-20990101'));
    });
    const before = Number((await t.pool.query('SELECT ai_spend_today_usd() AS v')).rows[0].v);
    await expect(llm.structured({ feature: 'test.billing', owner, budget: 'new_interview' }, req, schema)).rejects.toMatchObject({ code: 'LLM_OUTPUT_INVALID' });
    const { rows } = await t.pool.query(`SELECT status, error_kind, model, input_tokens, output_tokens, cost_usd FROM llm_call_log WHERE feature = 'test.billing' ORDER BY id`);
    // One retry on invalid output: two billed rows at the sonnet-5-5 list price (50k x $2 + 100k x $10 per MTok).
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ status: 'failed', error_kind: 'invalid_output', model: 'claude-sonnet-5-5-20990101', input_tokens: 50_000, output_tokens: 100_000, cost_usd: '1.100000' });
    const after = Number((await t.pool.query('SELECT ai_spend_today_usd() AS v')).rows[0].v);
    expect(after - before).toBeCloseTo(2.2, 5);
    // The billed failures count toward the learner's daily cap ($2): the next call is refused.
    t.llm.overrides.clear();
    await expect(llm.structured({ feature: 'test.billing', owner, budget: 'new_interview' }, req, schema)).rejects.toMatchObject({ code: 'LLM_BUDGET_EXCEEDED', details: { scope: 'user_day' } });
  });

  it('charges the refused first try when a fallback model answered', async () => {
    const other = await signUp(t, 'Fallback Probe');
    const userId = (await other.get('/v1/me')).body.id as string;
    const { rows: [m] } = await t.pool.query('SELECT org_id FROM memberships WHERE user_id = $1', [userId]);
    const original = t.llm.generateStructured.bind(t.llm);
    t.llm.generateStructured = (async () => ({ value: { ok: true }, usage: { ...usage('claude-opus-5-5'), inputTokens: 1000, outputTokens: 1000 }, extraUsage: [{ ...usage('claude-sonnet-5-5'), inputTokens: 1000, outputTokens: 1000 }] })) as typeof t.llm.generateStructured;
    try {
      await t.app.get(LlmService).structured({ feature: 'test.fallback', owner: { userId, orgId: m.org_id }, budget: 'new_interview' }, req, schema);
    } finally {
      t.llm.generateStructured = original;
    }
    const { rows } = await t.pool.query(`SELECT status, error_kind, model, cost_usd FROM llm_call_log WHERE feature = 'test.fallback' ORDER BY id`);
    expect(rows).toEqual([
      { status: 'settled', error_kind: null, model: 'claude-opus-5-5', cost_usd: '0.024000' },
      { status: 'failed', error_kind: 'refusal', model: 'claude-sonnet-5-5', cost_usd: '0.012000' },
    ]);
  });
});
