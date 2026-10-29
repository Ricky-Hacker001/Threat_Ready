import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ReasoningAttemptView, ReasoningResult } from '@threatready/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { architecturesFor, getArchitecture } from '../src/modules/reasoning/architectures/index.js';
import { getDomain } from '../src/modules/reasoning/domains/index.js';
import { GenerationService, POOL_USER_ID } from '../src/modules/reasoning/generation.service.js';
import type { GeneratedItem } from '../src/modules/reasoning/item.types.js';
import { generationRequest, generationSchema } from '../src/modules/reasoning/prompts/generation.prompts.js';
import { DEFAULT_WEIGHTS } from '../src/modules/reasoning/scoring.js';
import { pickSeed } from '../src/modules/reasoning/seed.js';
import { toGeneratedItem } from '../src/modules/reasoning/validation.js';
import { fakeReasoningItem } from '../src/platform/adapters/fake/reasoning.fake.js';
import { fakeReasoningQuestion } from '../src/platform/adapters/fake/reasoning-question.fake.js';
import type { LlmRequest } from '../src/platform/ports/llm.port.js';
import { drainJobs, ORIGIN, resetDatabase, signUp, startApp, type Agent, type TestApp } from './harness.js';

/**
 * Questions on the architecture library and two learners per question (cost design 26 Oct 2026, §3-§5):
 * what a stored question carries, the Haiku-then-Sonnet ladder and its billing, the 2-serve rule under
 * concurrency, never the same question or one of the same shape twice, items generated before the
 * library, the daily question bound, the public view, and migration 0017. Fake LLM only.
 */

const STRONG =
  'The attacker is operating through the entry component: the logs show the first calls from an unknown address using that access, and data is moving right now. Removing exactly that access and narrowing what it can reach cuts the path to the target, so the attack stops where it started. Taking an unrelated component offline would hurt customers without stopping anything, and rotating every credential is wider than the evidence supports and conflicts with the constraint. I would keep the logs and the compromised access for the investigation.';

const idOf = async (agent: Agent) => (await agent.get('/v1/me')).body.id as string;
const itemOf = async (t: TestApp, attemptId: string) => (await t.pool.query<{ item_id: string | null }>(`SELECT item_id FROM reasoning_attempts WHERE id = $1`, [attemptId])).rows[0]?.item_id ?? null;
const start = (agent: Agent, domain: string, difficulty: string) => agent.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain, difficulty });
const available = async (agent: Agent, domain: string, difficulty: string) => (await agent.post('/v1/reasoning/attempts/prefetch').set('Origin', ORIGIN).send({ domain, difficulty })).body.available as number;

/**
 * Drops queued jobs a test left behind. pg-boss creates its schema on the first enqueue, so a test that
 * queued nothing (the first one in this file, right after the database reset) has no pgboss.job to clean.
 */
const clearJobs = async (pool: TestApp['pool'], name: string) =>
  pool.query(`DO $$ BEGIN IF to_regclass('pgboss.job') IS NOT NULL THEN DELETE FROM pgboss.job WHERE name = '${name}'; END IF; END $$`);

/** An item as generated before the library (gen.v2: a model-drawn diagram, no architecture), inserted into the pool. */
async function insertLegacyItem(t: TestApp, domainKey: string, difficulty: 'beginner' | 'intermediate' | 'advanced'): Promise<string> {
  const domain = getDomain(domainKey)!;
  const seed = pickSeed(domain, [], () => Math.random(), new Set(), difficulty);
  const out = generationSchema().zod.parse(fakeReasoningItem(generationRequest({ domain, seed, avoid: [], previousFailure: [], tryNumber: 1 })));
  const item: GeneratedItem = toGeneratedItem(out, domain, seed, DEFAULT_WEIGHTS);
  const { rows } = await t.pool.query<{ id: string }>(
    `INSERT INTO reasoning_items (pool, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, prompt_version, model, tier)
     VALUES (true, $1, $2, $3, $4, $5, $6, $7, 'gen.v2.2026-10-21', 'reasoning-generate.v2', 'claude-sonnet-5-5', 'LARGE') RETURNING id`,
    [domainKey, difficulty, item.fingerprint, item.seed, item.public, item.private, item.weights],
  );
  return rows[0]!.id;
}

describe('attack reasoning: questions on the architecture library', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_OPEN_ATTEMPTS: '20' });
  });
  beforeEach(() => t.llm.reset());
  afterAll(async () => t?.close());

  it('pool refills write questions on the library: the architecture, the seed, the composed diagram, the two-paragraph scenario, the tier and model of the call, spread over the bucket', async () => {
    const tp = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_POOL_ENABLED: 'true', REASONING_POOL_TARGET: '6', REASONING_POOL_IDLE_TARGET: '0', REASONING_POOL_BATCH: '6' });
    try {
      tp.llm.reset();
      await tp.app.get(GenerationService).refillPool({ domain: 'cloud_security', difficulty: 'beginner', userId: 'warm-up' });
      const { rows } = await tp.pool.query(
        `SELECT architecture_id, seed, public, private, tier, model, generator_version, prompt_version, serve_count FROM reasoning_items WHERE pool AND domain = 'cloud_security' AND difficulty = 'beginner'`,
      );
      expect(rows).toHaveLength(6);
      const bucket = architecturesFor('cloud_security', 'beginner').map((a) => a.id);
      for (const r of rows) {
        const arch = getArchitecture(r.architecture_id)!;
        expect(bucket).toContain(arch.id);
        // Attack Reasoning's SMALL model (claude-haiku-5-5 by default since H55), not the interviews' LLM_MODEL_SMALL.
        expect(r).toMatchObject({ tier: 'SMALL', model: tp.cfg.REASONING_MODEL_SMALL, generator_version: 'gen.v3.2026-10-26', prompt_version: 'reasoning-generate.v6', serve_count: 0 });
        expect(r.seed.topology).toBe(arch.id);
        expect(r.seed.architecture).toMatchObject({ id: arch.id, version: arch.version, surface: r.seed.entryPoint });
        expect(r.seed.architecture.pathKey.startsWith(`${arch.id}:`)).toBe(true);
        // The scenario is the organisation summary, then what is happening today.
        expect(r.public.scenario.startsWith(`${arch.organisation.summary}\n\n`)).toBe(true);
        // The diagram is the architecture with the overlay: every library component and flow, then attack edges atk1..N.
        const nodes = r.public.diagram.nodes.map((n: { id: string }) => n.id);
        for (const n of arch.diagram.nodes) expect(nodes).toContain(n.id);
        expect(nodes.filter((id: string) => !arch.diagram.nodes.some((n) => n.id === id)).every((id: string) => arch.attackerOrigins.some((o) => o.id === id))).toBe(true);
        expect(r.public.diagram.edges.slice(0, arch.diagram.edges.length)).toEqual(arch.diagram.edges);
        expect(r.public.diagram.attackPath).toEqual(r.public.diagram.edges.filter((e: { kind: string }) => e.kind === 'attack').map((e: { id: string }) => e.id));
        expect(r.public.diagram.attackPath[0]).toBe('atk1');
        expect(r.private.architectureAnalysis.length).toBeGreaterThan(150);
      }
      // Spread over the bucket's architectures (the least-used one first).
      expect(new Set(rows.map((r) => r.architecture_id)).size).toBe(Math.min(6, bucket.length));
      // Written by the SMALL tier, one call per question, on the pool account.
      expect(tp.llm.calls.map((c) => `${c.name}:${c.tier}`)).toEqual(Array(6).fill('reasoning_question:SMALL'));
      const { rows: ledger } = await tp.pool.query(`SELECT user_id, tier, status FROM llm_call_log WHERE feature = 'reasoning.generate' AND source_id IS NULL`);
      expect(ledger).toHaveLength(6);
      expect(ledger.every((l) => l.user_id === POOL_USER_ID && l.tier === 'SMALL' && l.status === 'settled')).toBe(true);
      // A learner is served the architecture they have seen least first: three starts, three architectures.
      const l = await signUp(tp, 'Spread Learner');
      const archsSeen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await start(l, 'cloud_security', 'beginner');
        expect(r.body.state).toBe('ready');
        archsSeen.push((await tp.pool.query(`SELECT architecture_id FROM reasoning_items WHERE id = $1`, [await itemOf(tp, r.body.id)])).rows[0].architecture_id);
      }
      expect(new Set(archsSeen).size).toBe(3);
    } finally {
      await clearJobs(tp.pool, 'reasoning.pool_refill');
      await tp.close();
    }
  });

  it('a question that fails the quality gate is rewritten once by the LARGE tier with the findings fed back; both calls are billed', async () => {
    const l = await signUp(t, 'Ladder Learner');
    const lId = await idOf(l);
    const reqs: LlmRequest[] = [];
    t.llm.overrides.set('reasoning_question', (req) => {
      reqs.push(req);
      const out = fakeReasoningQuestion(req) as { options: unknown[] };
      if (reqs.length === 1) out.options = out.options.slice(0, 3);
      return out;
    });
    const created = await start(l, 'cloud_security', 'intermediate');
    expect(created.body.state).toBe('generating');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const got = (await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body as ReasoningAttemptView;
    expect(got.state).toBe('ready');
    expect(reqs.map((r) => r.tier)).toEqual(['SMALL', 'LARGE']);
    // Same seed (the rejection was not a similarity one), the findings in the user message only.
    expect(reqs[1]!.systemPrefix).toBe(reqs[0]!.systemPrefix);
    expect(reqs[1]!.messages[0]!.content).toMatch(/Try 2: the previous item was rejected by the quality check/);
    expect(reqs[1]!.messages[0]!.content).toMatch(/exactly four options/);
    expect(reqs[0]!.messages[0]!.content).not.toMatch(/Try 2/);
    const { rows: [item] } = await t.pool.query(`SELECT i.tier, i.model, a.generation_tries FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [created.body.id]);
    expect(item).toMatchObject({ tier: 'LARGE', model: t.cfg.LLM_MODEL_LARGE, generation_tries: 2 });
    const { rows: ledger } = await t.pool.query(`SELECT user_id, tier, status, cost_usd FROM llm_call_log WHERE feature = 'reasoning.generate' AND source_id = $1 ORDER BY id`, [created.body.id]);
    expect(ledger.map((r) => `${r.tier}:${r.status}`)).toEqual(['SMALL:settled', 'LARGE:settled']);
    expect(ledger.every((r) => r.user_id === lId && Number(r.cost_usd) > 0)).toBe(true);
  });

  it('a question the content-quality rules reject (a timeline that runs backwards, gate rule 10) is rewritten by the LARGE tier with that reason fed back', async () => {
    const l = await signUp(t, 'Quality Ladder');
    const reqs: LlmRequest[] = [];
    t.llm.overrides.set('reasoning_question', (req) => {
      reqs.push(req);
      const out = fakeReasoningQuestion(req) as { attack_narrative: string };
      if (reqs.length === 1) out.attack_narrative = `${out.attack_narrative} At 23:40 the audit trail shows a listing. At 23:02 the session was used again.`;
      return out;
    });
    const created = await start(l, 'endpoint_security', 'intermediate');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const got = (await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body as ReasoningAttemptView;
    expect(got.state).toBe('ready');
    expect(reqs.map((r) => r.tier)).toEqual(['SMALL', 'LARGE']);
    expect(reqs[1]!.messages[0]!.content).toMatch(/Try 2: the previous item was rejected by the quality check/);
    expect(reqs[1]!.messages[0]!.content).toMatch(/attack_narrative: the timeline runs backwards \("23:40" then "23:02"\)/);
    const { rows: [item] } = await t.pool.query(`SELECT i.tier, i.prompt_version, a.generation_tries FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [created.body.id]);
    expect(item).toMatchObject({ tier: 'LARGE', prompt_version: 'reasoning-generate.v6', generation_tries: 2 });
    const { rows: ledger } = await t.pool.query(`SELECT tier, status FROM llm_call_log WHERE feature = 'reasoning.generate' AND source_id = $1 ORDER BY id`, [created.body.id]);
    expect(ledger.map((r) => `${r.tier}:${r.status}`)).toEqual(['SMALL:settled', 'LARGE:settled']);
  });

  it('two failures end the run with REASONING_GENERATION_FAILED after exactly two billed calls; a retry starts the ladder again', async () => {
    const l = await signUp(t, 'Failing Ladder');
    t.llm.overrides.set('reasoning_question', (req) => {
      const out = fakeReasoningQuestion(req) as { reference_answer: string };
      out.reference_answer = 'Too short.';
      return out;
    });
    const created = await start(l, 'incident_response', 'beginner');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const failed = (await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body as ReasoningAttemptView;
    expect(failed.state).toBe('generation_failed');
    expect(failed.failure).toEqual({ code: 'REASONING_GENERATION_FAILED', stage: 'generation' });
    expect(t.llm.calls.map((c) => `${c.name}:${c.tier}`)).toEqual(['reasoning_question:SMALL', 'reasoning_question:LARGE']);
    const { rows: ledger } = await t.pool.query(`SELECT tier, status, cost_usd FROM llm_call_log WHERE source_id = $1 ORDER BY id`, [created.body.id]);
    expect(ledger.map((r) => r.tier)).toEqual(['SMALL', 'LARGE']);
    expect(ledger.every((r) => Number(r.cost_usd) > 0)).toBe(true);
    t.llm.reset();
    expect((await l.post(`/v1/reasoning/attempts/${created.body.id}/retry`).set('Origin', ORIGIN)).status).toBe(202);
    await drainJobs(t, { only: ['reasoning.generate'] });
    expect((await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body.state).toBe('ready');
    expect(t.llm.calls.map((c) => c.tier)).toEqual(['SMALL']);
  });

  it('a schema failure on SMALL is not repeated on SMALL: the next call is the LARGE retry', async () => {
    const l = await signUp(t, 'Schema Ladder');
    t.llm.failNext('reasoning_question', 'invalid_output');
    const created = await start(l, 'cloud_security', 'advanced');
    await drainJobs(t, { only: ['reasoning.generate'] });
    expect((await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body.state).toBe('ready');
    expect(t.llm.calls.map((c) => `${c.name}:${c.tier}`)).toEqual(['reasoning_question:SMALL', 'reasoning_question:LARGE']);
    const { rows: ledger } = await t.pool.query(`SELECT tier, status, error_kind FROM llm_call_log WHERE source_id = $1 ORDER BY id`, [created.body.id]);
    expect(ledger).toEqual([
      { tier: 'SMALL', status: 'failed', error_kind: 'invalid_output' },
      { tier: 'LARGE', status: 'settled', error_kind: null },
    ]);
  });

  it('REASONING_GENERATION_FIRST_TIER=LARGE puts Sonnet back on writing questions (rollback), still on the library', async () => {
    const tl = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_GENERATION_FIRST_TIER: 'LARGE' });
    try {
      const l = await signUp(tl, 'Rollback Learner');
      tl.llm.reset();
      const created = await start(l, 'grc_risk', 'beginner');
      await drainJobs(tl, { only: ['reasoning.generate'] });
      expect((await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body.state).toBe('ready');
      expect(tl.llm.calls.map((c) => `${c.name}:${c.tier}`)).toEqual(['reasoning_question:LARGE']);
      const { rows: [r] } = await tl.pool.query(`SELECT i.tier, i.architecture_id FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [created.body.id]);
      expect(r.tier).toBe('LARGE');
      expect(r.architecture_id).toBeTruthy();
    } finally {
      await tl.close();
    }
  });

  it('pre-checks an on-demand start with the whole ladder (SMALL try plus the LARGE retry), billed to the learner', async () => {
    const gen = t.app.get(GenerationService);
    const ladder = gen.generationEstimateUsd('threat_intelligence', 'advanced');
    const one = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_GENERATION_TRIES: '1' });
    try {
      const single = one.app.get(GenerationService).generationEstimateUsd('threat_intelligence', 'advanced');
      // 16k output tokens on Haiku 5.5 (the default since H55; was 8k on Haiku 4.5, US$0.03-0.08), then 12k on Sonnet: the retry dominates the worst case.
      expect(single).toBeGreaterThan(0.005);
      expect(single).toBeLessThan(0.02);
      expect(ladder).toBeGreaterThan(single + 0.1);
    } finally {
      await one.close();
    }
    // A learner whose remaining budget covers one try but not the ladder (plus an evaluation) is refused before anything exists.
    const l = await signUp(t, 'Ladder Budget');
    const lId = await idOf(l);
    const room = t.cfg.AI_USER_DAILY_CAP_USD - ladder - gen.evaluationRoomUsd('threat_intelligence') + 0.01;
    await t.pool.query(
      `INSERT INTO llm_call_log (org_id, user_id, feature, tier, model, prompt_version, status, estimated_cost_usd, cost_usd)
       VALUES ((SELECT org_id FROM memberships WHERE user_id = $1 LIMIT 1), $1, 'interview.turn', 'LARGE', 'claude-sonnet-5-5', 'test', 'settled', $2, $2)`,
      [lId, room],
    );
    try {
      const refused = await start(l, 'threat_intelligence', 'advanced');
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('LLM_BUDGET_EXCEEDED');
      expect((await t.pool.query(`SELECT count(*)::int AS n FROM reasoning_attempts WHERE user_id = $1`, [lId])).rows[0].n).toBe(0);
    } finally {
      await t.pool.query(`DELETE FROM llm_call_log WHERE prompt_version = 'test'`);
    }
    const ok = await start(l, 'threat_intelligence', 'advanced');
    expect(ok.body.state).toBe('generating');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const { rows: owners } = await t.pool.query(`SELECT DISTINCT user_id FROM llm_call_log WHERE feature = 'reasoning.generate' AND source_id = $1`, [ok.body.id]);
    expect(owners.map((o) => o.user_id)).toEqual([lId]);
  });

  it('serves a question to at most two learners, even when three start at once; it is then retired and the bucket is backfilled', async () => {
    const tp = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_POOL_ENABLED: 'true', REASONING_POOL_TARGET: '1', REASONING_POOL_IDLE_TARGET: '0', REASONING_POOL_BATCH: '1', REASONING_POOL_MIN_AVAILABLE: '0' });
    try {
      const gen = tp.app.get(GenerationService);
      await gen.refillPool({ domain: 'identity_access', difficulty: 'advanced', userId: 'warm-up' });
      const { rows: pool } = await tp.pool.query<{ id: string; serve_count: number }>(`SELECT id, serve_count FROM reasoning_items WHERE pool AND domain = 'identity_access' AND difficulty = 'advanced'`);
      expect(pool).toEqual([{ id: expect.any(String), serve_count: 0 }]);
      const only = pool[0]!.id;
      const learners = await Promise.all([signUp(tp, 'Race One'), signUp(tp, 'Race Two'), signUp(tp, 'Race Three')]);
      for (const l of learners) await idOf(l); // provision the accounts before the race
      const res = await Promise.all(learners.map((l) => start(l, 'identity_access', 'advanced')));
      expect(res.map((r) => r.status)).toEqual([202, 202, 202]);
      const served = await Promise.all(res.map((r) => itemOf(tp, r.body.id)));
      expect(served.filter((id) => id === only)).toHaveLength(2);
      // The third learner got no third serve: the start generates a question for them instead.
      const third = res.find((r, i) => served[i] !== only)!;
      expect(third.body.state).toBe('generating');
      const { rows: [after] } = await tp.pool.query(`SELECT serve_count, (SELECT count(*)::int FROM reasoning_served WHERE item_id = $1) AS serves FROM reasoning_items WHERE id = $1`, [only]);
      expect(after).toEqual({ serve_count: 2, serves: 2 });
      await drainJobs(tp, { only: ['reasoning.generate'] });
      const fresh = await itemOf(tp, third.body.id);
      expect(fresh).not.toBe(only);
      // A fourth learner gets the third's new question (its second seat), never the retired one; a fifth gets neither.
      const fourth = await signUp(tp, 'Fourth');
      expect(await available(fourth, 'identity_access', 'advanced')).toBe(1);
      const f4 = await start(fourth, 'identity_access', 'advanced');
      expect(f4.body.state).toBe('ready');
      expect(await itemOf(tp, f4.body.id)).toBe(fresh);
      const fifth = await signUp(tp, 'Fifth');
      expect(await available(fifth, 'identity_access', 'advanced')).toBe(0);
      const f5 = await start(fifth, 'identity_access', 'advanced');
      expect(f5.body.state).toBe('generating');
      const { rows: counts } = await tp.pool.query(`SELECT max(serve_count)::int AS max FROM reasoning_items WHERE domain = 'identity_access'`);
      expect(counts[0].max).toBe(2);
      // Retired questions no longer count toward the bucket: a learner-triggered refill tops it up again.
      expect(await gen.headroom('identity_access', 'advanced')).toBe(1);
    } finally {
      await clearJobs(tp.pool, 'reasoning.pool_refill');
      await tp.close();
    }
  });

  it('never serves a learner the same question twice, nor another question of the same shape (same variation fingerprint)', async () => {
    const a = await signUp(t, 'Shape Learner');
    const b = await signUp(t, 'Other Shape Learner');
    const first = await start(a, 'data_security', 'beginner');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const x = (await itemOf(t, first.body.id))!;
    // A second pool question with the same fingerprint (same domain, architecture, surface, objective and technique).
    const { rows: [copy] } = await t.pool.query<{ id: string }>(
      `INSERT INTO reasoning_items (pool, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, prompt_version, model, tier, architecture_id)
       SELECT true, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, 'test-copy', model, tier, architecture_id FROM reasoning_items WHERE id = $1 RETURNING id`,
      [x],
    );
    expect(await available(a, 'data_security', 'beginner')).toBe(0);
    expect(await available(b, 'data_security', 'beginner')).toBe(2);
    const next = await start(a, 'data_security', 'beginner');
    expect(next.body.state).toBe('generating');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const y = (await itemOf(t, next.body.id))!;
    expect([x, copy!.id]).not.toContain(y);
    const { rows } = await t.pool.query(`SELECT fingerprint FROM reasoning_items WHERE id = ANY($1::uuid[])`, [[x, y]]);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
    // The other learner is served the shape of x once only: either x or its copy, never both.
    const bItems: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await start(b, 'data_security', 'beginner');
      if (r.body.state !== 'ready') break;
      bItems.push((await itemOf(t, r.body.id))!);
    }
    expect(bItems.length).toBe(2);
    expect(bItems.filter((id) => id === x || id === copy!.id)).toHaveLength(1);
    expect(bItems).toContain(y);
    await t.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.generate'`);
    await t.pool.query(`DELETE FROM reasoning_items WHERE prompt_version = 'test-copy'`);
  });

  it('keeps serving, evaluating and retiring questions generated before the library, and stops with REASONING_SERVE_LEGACY_ITEMS=false', async () => {
    const legacy = await insertLegacyItem(t, 'network_security', 'intermediate');
    const a = await signUp(t, 'Legacy A');
    const b = await signUp(t, 'Legacy B');
    const c = await signUp(t, 'Legacy C');
    // The legacy question is served first (it has no architecture, so it sorts first) and evaluated as usual.
    const ra = await start(a, 'network_security', 'intermediate');
    expect(ra.body.state).toBe('ready');
    expect(await itemOf(t, ra.body.id)).toBe(legacy);
    const sub = await a.post(`/v1/reasoning/attempts/${ra.body.id}/submit`).set('Origin', ORIGIN).send({ selectedOption: 'B', justification: STRONG, clientSubmissionId: randomUUID() });
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);
    await drainJobs(t, { only: ['reasoning.evaluate'] });
    const res = await a.get(`/v1/reasoning/attempts/${ra.body.id}/result`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as ReasoningResult).feedback.architectureAnalysis.length).toBeGreaterThan(20);
    const rb = await start(b, 'network_security', 'intermediate');
    expect(await itemOf(t, rb.body.id)).toBe(legacy);
    // Two serves: retired, even for a legacy question.
    expect(await available(c, 'network_security', 'intermediate')).toBe(0);
    expect((await start(c, 'network_security', 'intermediate')).body.state).toBe('generating');
    await t.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.generate'`);

    const tl = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_SERVE_LEGACY_ITEMS: 'false' });
    try {
      await insertLegacyItem(tl, 'network_security', 'advanced');
      const d = await signUp(tl, 'No Legacy');
      expect(await available(d, 'network_security', 'advanced')).toBe(0);
      expect((await start(d, 'network_security', 'advanced')).body.state).toBe('generating');
      expect(await tl.app.get(GenerationService).headroom('network_security', 'advanced')).toBe(tl.cfg.REASONING_POOL_TARGET);
    } finally {
      await tl.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.generate'`);
      await tl.close();
    }
  });

  it('bounds the questions one learner opens per UTC day (REASONING_USER_DAILY_QUESTIONS) with its own code and reset time, before skipping anything', async () => {
    const tq = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_OPEN_ATTEMPTS: '2', REASONING_USER_DAILY_QUESTIONS: '2' });
    try {
      const l = await signUp(tq, 'Daily Questions');
      const lId = await idOf(l);
      expect((await start(l, 'zero_trust', 'beginner')).status).toBe(202);
      expect((await start(l, 'zero_trust', 'beginner')).status).toBe(202);
      const over = await l.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain: 'zero_trust', difficulty: 'beginner', skipOldest: true });
      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe('REASONING_DAILY_QUESTIONS_REACHED');
      expect(over.body.error.retryable).toBe(false);
      expect(over.body.error.details).toMatchObject({ limit: 2, resetAt: expect.stringMatching(/T00:00:00\.000Z$/) });
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      // Refused before the open-question rule: nothing was skipped or created.
      const { rows } = await tq.pool.query(`SELECT state FROM reasoning_attempts WHERE user_id = $1`, [lId]);
      expect(rows.map((r) => r.state)).toEqual(['generating', 'generating']);
    } finally {
      await tq.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.generate'`);
      await tq.close();
    }
  });

  it('the public view carries the composed diagram and scenario, the attempt id, and nothing from the answer key or the architecture record (TR-42)', async () => {
    const l = await signUp(t, 'Public View');
    const created = await start(l, 'api_security', 'beginner');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const view = (await l.get(`/v1/reasoning/attempts/${created.body.id}`)).body as ReasoningAttemptView;
    expect(view.state).toBe('ready');
    const itemId = (await itemOf(t, view.id))!;
    const { rows: [row] } = await t.pool.query(`SELECT architecture_id FROM reasoning_items WHERE id = $1`, [itemId]);
    const arch = getArchitecture(row.architecture_id)!;
    expect(view.item!.id).toBe(view.id);
    expect(view.item!.scenario.split('\n\n')[0]).toBe(arch.organisation.summary);
    expect(view.item!.diagram.nodes.filter((n) => n.entryPoint)).toHaveLength(1);
    const raw = JSON.stringify(view);
    expect(raw).not.toContain(itemId);
    for (const secret of ['correctOption', 'rubric', 'referenceAnswer', 'mustNotCredit', 'optionAnalysis', 'verdict', 'architectureAnalysis', 'architectureId', 'architecture_id', 'pathKey', 'reviewNotes', 'attackSurfaces']) expect(raw).not.toContain(secret);
    // The model-written concepts can echo the answer: not sent before the evaluation (review AR-SEC-3)...
    const { rows: [stored] } = await t.pool.query(`SELECT public->'concepts' AS concepts FROM reasoning_items WHERE id = $1`, [itemId]);
    expect(stored.concepts.length).toBeGreaterThan(0);
    expect(view.item!.concepts).toEqual([]);
    // ...and returned with the result once it is.
    const sub = await l.post(`/v1/reasoning/attempts/${view.id}/submit`).set('Origin', ORIGIN).send({ selectedOption: 'B', justification: STRONG, clientSubmissionId: randomUUID() });
    expect(sub.status).toBe(202);
    expect((sub.body as ReasoningAttemptView).item!.concepts).toEqual([]);
    await drainJobs(t, { only: ['reasoning.evaluate'] });
    const result = (await l.get(`/v1/reasoning/attempts/${view.id}/result`)).body as { concepts: string[] };
    expect(result.concepts).toEqual(stored.concepts);
    expect(((await l.get(`/v1/reasoning/attempts/${view.id}`)).body as ReasoningAttemptView).item!.concepts).toEqual(stored.concepts);
  });

  it('two serves of one question racing past the cap: the second waits for the first and is skipped, never counted (row lock in the BEFORE trigger)', async () => {
    const item = await insertLegacyItem(t, 'grc_risk', 'intermediate');
    const users: { id: string; org: string }[] = [];
    for (const name of ['Lock One', 'Lock Two', 'Lock Three']) {
      const id = await idOf(await signUp(t, name));
      users.push({ id, org: (await t.pool.query(`SELECT org_id FROM memberships WHERE user_id = $1 LIMIT 1`, [id])).rows[0].org_id });
    }
    const insert = `INSERT INTO reasoning_served (org_id, user_id, item_id) VALUES ($1, $2, $3) RETURNING item_id`;
    await t.pool.query(insert, [users[0]!.org, users[0]!.id, item]); // one seat taken
    const c1 = await t.pool.connect();
    const c2 = await t.pool.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.reasoning_item_max_serves', '2', true)`);
      }
      expect((await c1.query(insert, [users[1]!.org, users[1]!.id, item])).rows).toHaveLength(1);
      let settled = false;
      const second = c2.query(insert, [users[2]!.org, users[2]!.id, item]).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting on the first serve's row lock
      await c1.query('COMMIT');
      expect((await second).rows).toHaveLength(0); // re-checked against the committed count: over the cap
      await c2.query('COMMIT');
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
    const { rows: [r] } = await t.pool.query(`SELECT serve_count, (SELECT count(*)::int FROM reasoning_served WHERE item_id = $1) AS serves FROM reasoning_items WHERE id = $1`, [item]);
    expect(r).toEqual({ serve_count: 2, serves: 2 });
  });

  it('never serves a learner a question with the architecture, attack path and objective of one they were served, even under another fingerprint (review AR-BIZ-2)', async () => {
    const a = await signUp(t, 'Structure Learner');
    const b = await signUp(t, 'Other Structure Learner');
    const first = await start(a, 'endpoint_security', 'beginner');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const x = (await itemOf(t, first.body.id))!;
    const copy = (fingerprintSuffix: string, objective?: string) =>
      t.pool.query<{ id: string }>(
        `INSERT INTO reasoning_items (pool, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, prompt_version, model, tier, architecture_id)
         SELECT true, domain, difficulty, fingerprint || $2, CASE WHEN $3::text IS NULL THEN seed ELSE jsonb_set(seed, '{objective}', to_jsonb($3::text)) END,
                public, private, weights, generator_version, 'test-structure', model, tier, architecture_id FROM reasoning_items WHERE id = $1 RETURNING id`,
        [x, fingerprintSuffix, objective ?? null],
      );
    // Same architecture, path and objective, another fingerprint (another technique, say): hidden from a, servable to b.
    const { rows: [same] } = await copy('|alt-technique');
    expect(await available(a, 'endpoint_security', 'beginner')).toBe(0);
    expect(await available(b, 'endpoint_security', 'beginner')).toBe(2);
    // Same path, another objective: a different question, servable to a.
    const { rows: [other] } = await copy('|alt-objective', 'zzz_other_objective');
    expect(await available(a, 'endpoint_security', 'beginner')).toBe(1);
    const next = await start(a, 'endpoint_security', 'beginner');
    expect(next.body.state).toBe('ready');
    expect(await itemOf(t, next.body.id)).toBe(other!.id);
    expect(same!.id).not.toBe(other!.id);
    await t.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.generate'`);
  });

  it('pool sizing counts what a learner cannot be served, learner-triggered refills avoid their fingerprints, and refills start only ladders the pool budget can finish (reviews AR-BIZ-11, COST-5)', async () => {
    const tp = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_OPEN_ATTEMPTS: '20', REASONING_POOL_ENABLED: 'true', REASONING_POOL_TARGET: '3', REASONING_POOL_IDLE_TARGET: '0', REASONING_POOL_MIN_AVAILABLE: '2', REASONING_POOL_MAX_ITEMS: '6', REASONING_POOL_BATCH: '3' });
    const D = 'zero_trust';
    const L = 'intermediate';
    try {
      const gen = tp.app.get(GenerationService);
      gen.rng = () => 0;
      const l = await signUp(tp, 'Sizing Learner');
      const r = await start(l, D, L);
      expect(r.body.state).toBe('generating');
      await drainJobs(tp, { only: ['reasoning.generate'] });
      const x = (await itemOf(tp, r.body.id))!;
      // Two live pool questions sharing x's fingerprint: counted in the bucket, but never servable to l.
      for (const n of [1, 2])
        await tp.pool.query(
          `INSERT INTO reasoning_items (pool, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, prompt_version, model, tier, architecture_id)
           SELECT true, domain, difficulty, fingerprint, seed, public, private, weights, generator_version, 'test-sizing-${n}', model, tier, architecture_id FROM reasoning_items WHERE id = $1`,
          [x],
        );
      expect(await available(l, D, L)).toBe(0);
      // Before the fix the most-served learner had "seen" only x (1 of 3) and nothing was needed.
      expect(await gen.needed(D, L)).toBe(2);
      tp.llm.reset();
      await gen.refillPool({ domain: D, difficulty: L });
      expect(tp.llm.calls.filter((c) => c.name === 'reasoning_question')).toHaveLength(2);
      expect(await available(l, D, L)).toBe(2);
      expect(await gen.needed(D, L)).toBe(0);

      // A learner-triggered refill stays off every fingerprint the learner was served, retired ones included.
      await tp.pool.query(`DELETE FROM reasoning_items WHERE prompt_version LIKE 'test-sizing-%' OR (pool AND domain = $1 AND difficulty = $2 AND id <> $3 AND serve_count = 0)`, [D, L, x]);
      await tp.pool.query(`UPDATE reasoning_items SET serve_count = 2 WHERE id = $1`, [x]);
      const { rows: [fx] } = await tp.pool.query(`SELECT fingerprint FROM reasoning_items WHERE id = $1`, [x]);
      tp.llm.reset();
      await gen.refillPool({ domain: D, difficulty: L, userId: await idOf(l) });
      const { rows: added } = await tp.pool.query(`SELECT fingerprint FROM reasoning_items WHERE pool AND domain = $1 AND difficulty = $2 AND serve_count = 0`, [D, L]);
      expect(added).toHaveLength(3);
      expect(added.map((a) => a.fingerprint)).not.toContain(fx.fingerprint);
      expect(await available(l, D, L)).toBe(3);

      // Review COST-5: with room in the pool's cap for one whole ladder (first try + rewrite), one ladder starts, not three.
      await tp.pool.query(`DELETE FROM reasoning_items WHERE pool AND domain = $1 AND difficulty = $2 AND serve_count = 0`, [D, L]);
      const ladder = gen.generationEstimateUsd(D, L);
      // The pool's spend today, by the ledger's own rule (LlmService.sum).
      const { rows: [spent] } = await tp.pool.query(
        `SELECT coalesce(sum(coalesce(cost_usd, estimated_cost_usd)), 0)::float AS usd FROM llm_call_log WHERE user_id = $1 AND created_at >= date_trunc('day', now()) AND (status <> 'failed' OR cost_usd IS NOT NULL)`,
        [POOL_USER_ID],
      );
      const cap = tp.cfg.REASONING_POOL_DAILY_CAP_USD;
      tp.cfg.REASONING_POOL_DAILY_CAP_USD = spent.usd + ladder * 1.5;
      tp.llm.reset();
      await gen.refillPool({ domain: D, difficulty: L });
      // One ladder: one first try (SMALL); a LARGE rewrite, when the first try is rejected, belongs to the same ladder.
      expect(tp.llm.calls.filter((c) => c.name === 'reasoning_question' && c.tier === 'SMALL'), JSON.stringify(tp.llm.calls.map((c) => c.tier))).toHaveLength(1);
      // Less than one ladder left: nothing starts at all.
      tp.cfg.REASONING_POOL_DAILY_CAP_USD = spent.usd + ladder * 0.5;
      await tp.pool.query(`DELETE FROM reasoning_items WHERE pool AND domain = $1 AND difficulty = $2 AND serve_count = 0`, [D, L]);
      tp.llm.reset();
      await gen.refillPool({ domain: D, difficulty: L });
      expect(tp.llm.calls).toHaveLength(0);
      tp.cfg.REASONING_POOL_DAILY_CAP_USD = cap;

      // On demand: the job checks the whole ladder again before the first try, and fails with the budget code when it no longer fits.
      const cap2 = tp.cfg.AI_USER_DAILY_CAP_USD;
      const od = await start(l, 'ai_llm_security', 'beginner');
      expect(od.body.state).toBe('generating');
      tp.cfg.AI_USER_DAILY_CAP_USD = 0.0001;
      tp.llm.reset();
      await drainJobs(tp, { only: ['reasoning.generate'] });
      tp.cfg.AI_USER_DAILY_CAP_USD = cap2;
      expect(tp.llm.calls).toHaveLength(0);
      expect((await l.get(`/v1/reasoning/attempts/${od.body.id}`)).body).toMatchObject({ state: 'generation_failed', failure: { code: 'LLM_BUDGET_EXCEEDED', stage: 'generation' } });
    } finally {
      await tp.pool.query(`DELETE FROM pgboss.job WHERE name IN ('reasoning.pool_refill', 'reasoning.generate')`);
      await tp.close();
    }
  });

  it('counts the pool questions a learner may have generated per day in questions, not refill jobs, and a refill never adds more than it reserved (review AR-SEC-2)', async () => {
    const tp = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_POOL_ENABLED: 'true', REASONING_POOL_TARGET: '8', REASONING_POOL_IDLE_TARGET: '0', REASONING_POOL_BATCH: '4', REASONING_USER_DAILY_REFILLS: '6' });
    try {
      const l = await signUp(tp, 'Refill Allowance Learner');
      const jobs = async () =>
        (await tp.pool.query<{ data: { domain: string; difficulty: string; max: number } }>(`SELECT data FROM pgboss.job WHERE name = 'reasoning.pool_refill' AND data->>'userId' IS NOT NULL ORDER BY created_on`)).rows.map((r) => r.data);
      // Three empty buckets: the first two prefetches reserve 4 and then 2 of the 6, the third gets nothing.
      for (const d of ['threat_intelligence', 'security_operations', 'grc_risk']) await available(l, d, 'advanced');
      expect((await jobs()).map((j) => [j.domain, j.max]), JSON.stringify(await jobs())).toEqual([
        ['threat_intelligence', 4],
        ['security_operations', 2],
      ]);
      // The job adds at most what it reserved, below the bucket's need (8).
      tp.llm.reset();
      await tp.app.get(GenerationService).refillPool({ domain: 'security_operations', difficulty: 'advanced', userId: await idOf(l), max: 2 });
      expect(tp.llm.calls.filter((c) => c.name === 'reasoning_question' && c.tier === 'SMALL')).toHaveLength(2);
    } finally {
      await tp.pool.query(`DELETE FROM pgboss.job WHERE name = 'reasoning.pool_refill'`);
      await tp.close();
    }
  });

  it('migration 0017: idempotent, the API role reads architecture_id but never the answer key, and the trigger enforces the cap atomically', async () => {
    const sql = readFileSync(new URL('../../../packages/db/migrations/0017_reasoning_architecture_library.sql', import.meta.url), 'utf8');
    const c = await t.pool.connect();
    try {
      // Applied a second time: no error, nothing changes.
      await c.query('BEGIN');
      for (const stmt of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await c.query(stmt);
      await c.query('COMMIT');
      const { rows: trig } = await c.query(`SELECT tgtype & 2 = 2 AS before FROM pg_trigger WHERE tgname = 'reasoning_served_bump_serve_count'`);
      expect(trig).toEqual([{ before: true }]);
      const { rows: idx } = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'reasoning_items' AND indexname = 'reasoning_items_architecture_idx'`);
      expect(idx).toHaveLength(1);

      // Three learners and one fresh pool question.
      const ls = [await signUp(t, 'Trig One'), await signUp(t, 'Trig Two'), await signUp(t, 'Trig Three')];
      const users: { id: string; org: string }[] = [];
      for (const l of ls) {
        const id = await idOf(l);
        users.push({ id, org: (await c.query(`SELECT org_id FROM memberships WHERE user_id = $1 LIMIT 1`, [id])).rows[0].org_id });
      }
      const item = await insertLegacyItem(t, 'grc_risk', 'beginner');
      const serve = (u: { id: string; org: string }, conflict = '') =>
        c.query(`INSERT INTO reasoning_served (org_id, user_id, item_id) VALUES ($1, $2, $3) ${conflict} RETURNING item_id`, [u.org, u.id, item]);
      const count = async () => (await c.query(`SELECT serve_count FROM reasoning_items WHERE id = $1`, [item])).rows[0].serve_count as number;
      // With the cap set for the transaction (as the API does): the first serve counts, one over the cap is skipped.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.reasoning_item_max_serves', '1', true)`);
      expect((await serve(users[0]!)).rows).toHaveLength(1);
      expect((await serve(users[1]!)).rows).toHaveLength(0);
      await c.query('COMMIT');
      expect(await count()).toBe(1);
      // A repeated serve for the same learner is skipped and never counted, with or without ON CONFLICT.
      expect((await serve(users[0]!, 'ON CONFLICT DO NOTHING')).rows).toHaveLength(0);
      expect((await serve(users[0]!)).rows).toHaveLength(0);
      expect(await count()).toBe(1);
      // Without the setting (older code, the worker's on-demand serve): counted only, as before 0017.
      expect((await serve(users[1]!)).rows).toHaveLength(1);
      expect(await count()).toBe(2);
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.reasoning_item_max_serves', '2', true)`);
      expect((await serve(users[2]!)).rows).toHaveLength(0);
      await c.query('COMMIT');
      expect(await count()).toBe(2);

      // The API role: every public column including architecture_id, never the answer key nor the
      // generation metadata (seed, fingerprint; migration 0018), which the shape check reads for it.
      const as = async (text: string) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE tr_app_user');
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [users[0]!.id]);
        try {
          return await c.query(text);
        } finally {
          await c.query('ROLLBACK');
        }
      };
      const ok = await as(`SELECT id, architecture_id, public, serve_count, reasoning_item_shape_served(id) AS shape_served FROM reasoning_items WHERE pool`);
      expect(ok.rows.length).toBeGreaterThan(0);
      expect(ok.rows.every((r: { shape_served: unknown }) => typeof r.shape_served === 'boolean')).toBe(true);
      await expect(as('SELECT private FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
      await expect(as('SELECT fingerprint FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
      await expect(as('SELECT seed FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
      await expect(as('SELECT * FROM reasoning_items')).rejects.toMatchObject({ code: '42501' });
      await expect(as('SELECT id FROM users')).rejects.toMatchObject({ code: '42501' });
      await expect(as(`SELECT * FROM platform_llm_usage(now() - interval '1 day', now(), NULL)`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
