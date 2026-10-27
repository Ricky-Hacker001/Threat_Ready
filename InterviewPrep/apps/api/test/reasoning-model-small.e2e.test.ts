import { randomUUID } from 'node:crypto';
import type { ReasoningAttemptView, ReasoningResult } from '@threatready/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmService } from '../src/modules/ai/llm.service.js';
import type { StoredStages } from '../src/modules/reasoning/evaluation.service.js';
import { GenerationService } from '../src/modules/reasoning/generation.service.js';
import type { ReasoningItemPrivate } from '../src/modules/reasoning/item.types.js';
import { drainJobs, ORIGIN, resetDatabase, signUp, startApp, type Agent, type TestApp } from './harness.js';

/**
 * Attack Reasoning on Claude Haiku 5.5 (REASONING_MODEL_SMALL=claude-haiku-5-5) end to end on the fake
 * model: the question writer's first try and the stage-1 evaluator run on Haiku 5.5, and the ledger,
 * the stored question and the stored evaluation carry that model and its prices (US$0.10 / 0.50 / 0.01
 * / 0.125 per million input, output, cache-read and cache-write tokens). A refusal on SMALL is billed and
 * recorded, then the writer's next try is LARGE and the evaluation escalates. Interviews keep Haiku 4.5.
 * Haiku 5.5 is the default since H55 Decide (27 Oct 2026) and named here anyway; grading runs in tiered
 * mode (not the default since then), the only mode with a SMALL stage. PostgreSQL and the fake LLM only.
 */

/** Fifty-plus words that name no particular component: the fake evaluator credits every point (quote = first sentence). */
const STRONG =
  'The attacker entered through the component marked as the entry point and is moving along the path shown on the diagram right now. The option I chose removes exactly the access the attacker is using, so the next step on the path fails while the rest of the service keeps running. The wider alternatives would hurt customers or destroy evidence, and waiting accepts more loss, so I would act on the identity in use and keep the logs for the investigation.';

interface LedgerRow {
  feature: string;
  tier: string;
  model: string;
  status: string;
  error_kind: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  estimated_cost_usd: string;
  cost_usd: string;
}

/** A Haiku 5.5 call's price from its tokens, at the list prices (prompts here are far below the 100k long-context threshold). */
const haiku55Usd = (r: LedgerRow) => (r.input_tokens * 0.1 + r.output_tokens * 0.5 + r.cache_read_tokens * 0.01 + r.cache_write_tokens * 0.125) / 1e6;

describe('attack reasoning on Claude Haiku 5.5 (REASONING_MODEL_SMALL)', () => {
  let t: TestApp;
  let learner: Agent;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp({ RATE_LIMIT_SCALE: '20', REASONING_MAX_OPEN_ATTEMPTS: '40', REASONING_USER_DAILY_EVALUATIONS: '0', REASONING_MODEL_SMALL: 'claude-haiku-5-5', REASONING_EVALUATION_MODE: 'tiered' });
    learner = await signUp(t, 'Haiku Five Learner');
  });
  beforeEach(() => t.llm.reset());
  afterAll(async () => t?.close());

  async function ready(domain = 'cloud_security', difficulty = 'intermediate'): Promise<ReasoningAttemptView> {
    const created = await learner.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain, difficulty });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    // The pool is off in tests: every start is an on-demand generation billed to the learner.
    expect(created.body.state).toBe('generating');
    await drainJobs(t, { only: ['reasoning.generate'] });
    const got = await learner.get(`/v1/reasoning/attempts/${created.body.id}`);
    expect(got.body.state, JSON.stringify(got.body.failure)).toBe('ready');
    return got.body as ReasoningAttemptView;
  }

  async function keyOf(attemptId: string): Promise<ReasoningItemPrivate> {
    const { rows } = await t.pool.query(`SELECT i.private FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [attemptId]);
    return rows[0].private as ReasoningItemPrivate;
  }

  async function answer(a: ReasoningAttemptView, selectedOption: string, justification: string): Promise<ReasoningResult> {
    const sub = await learner.post(`/v1/reasoning/attempts/${a.id}/submit`).set('Origin', ORIGIN).send({ selectedOption, justification, clientSubmissionId: randomUUID() });
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);
    await drainJobs(t, { only: ['reasoning.evaluate'] });
    const res = await learner.get(`/v1/reasoning/attempts/${a.id}/result`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ReasoningResult;
  }

  async function ledger(attemptId: string, feature: 'generate' | 'evaluation'): Promise<LedgerRow[]> {
    const { rows } = await t.pool.query(
      `SELECT feature, tier, model, status, error_kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, cost_usd
         FROM llm_call_log WHERE source_id = $1 AND ${feature === 'generate' ? `feature = 'reasoning.generate'` : `feature IN ('reasoning.evaluator', 'reasoning.challenger', 'reasoning.reconciler')`} ORDER BY id`,
      [attemptId],
    );
    return rows as LedgerRow[];
  }

  async function storedEvaluation(attemptId: string) {
    const { rows } = await t.pool.query(`SELECT tier, model, degraded, stages FROM reasoning_evaluations WHERE attempt_id = $1`, [attemptId]);
    return rows[0] as { tier: string; model: string; degraded: boolean; stages: StoredStages };
  }

  const calls = (name: string) => t.llm.calls.filter((c) => c.name === name).map((c) => [c.tier, c.model]);

  it('writes and grades a question on Haiku 5.5: the stored model ids and the billed costs are Haiku 5.5 ones; interviews keep Haiku 4.5', async () => {
    const a = await ready();
    expect(calls('reasoning_question')).toEqual([['SMALL', 'claude-haiku-5-5']]);
    const [gen] = await ledger(a.id, 'generate');
    expect(gen).toMatchObject({ tier: 'SMALL', model: 'claude-haiku-5-5', status: 'settled' });
    expect(Number(gen!.cost_usd)).toBeGreaterThan(0);
    expect(Number(gen!.cost_usd)).toBeCloseTo(haiku55Usd(gen!), 6);
    // Reserved on Haiku 5.5 too: its characters per token (2) and the thinking model's 16,000-token allowance.
    const writerChars = t.llm.calls.find((c) => c.name === 'reasoning_question')!.chars;
    expect(Number(gen!.estimated_cost_usd)).toBeCloseTo((Math.ceil(writerChars / 2) * 0.1 + 16_000 * 0.5) / 1e6, 5);
    const { rows: [item] } = await t.pool.query(`SELECT i.tier, i.model FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [a.id]);
    expect(item).toEqual({ tier: 'SMALL', model: 'claude-haiku-5-5' });

    const key = await keyOf(a.id);
    t.llm.reset();
    const r = await answer(a, key.correctOption, STRONG);
    expect([r.totalScore, r.correct, r.degraded]).toEqual([100, true, false]);
    expect(calls('reasoning_evaluator')).toEqual([['SMALL', 'claude-haiku-5-5']]);
    const rows = await ledger(a.id, 'evaluation');
    expect(rows.map((l) => [l.feature, l.tier, l.model, l.status])).toEqual([['reasoning.evaluator', 'SMALL', 'claude-haiku-5-5', 'settled']]);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(haiku55Usd(rows[0]!), 6);
    const graderChars = t.llm.calls.find((c) => c.name === 'reasoning_evaluator')!.chars;
    expect(Number(rows[0]!.estimated_cost_usd)).toBeCloseTo((Math.ceil(graderChars / 2) * 0.1 + 8000 * 0.5) / 1e6, 5);
    // Haiku 5.5 bills its thinking as output (the fake adds as many thinking tokens as it writes at medium effort).
    expect(rows[0]!.output_tokens % 2).toBe(0);
    const s = await storedEvaluation(a.id);
    expect(s).toMatchObject({ tier: 'SMALL', model: 'claude-haiku-5-5', degraded: false });
    expect(s.stages.escalation).toEqual({ mode: 'tiered', escalated: false, reasons: [] });
    const { rows: evidence } = await t.pool.query(`SELECT DISTINCT tier, model FROM skill_evidence WHERE source = 'reasoning' AND source_id = $1`, [a.id]);
    expect(evidence).toEqual([{ tier: 'SMALL', model: 'claude-haiku-5-5' }]);

    // Interviews, in the same process: Haiku 4.5 and the caps derived from it.
    const llm = t.app.get(LlmService);
    expect([llm.modelFor('SMALL'), llm.modelFor('SMALL', 'reasoning'), llm.modelFor('LARGE', 'reasoning')]).toEqual(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect([t.cfg.AI_SESSION_CAP_USD, t.cfg.AI_FINAL_SCORING_RESERVE_USD, t.cfg.AI_USER_DAILY_CAP_USD, t.cfg.AI_GLOBAL_DAILY_CAP_USD]).toEqual([0.6, 0.2, 2, 60]);
  });

  it('a refusal on the SMALL writer goes straight to the LARGE try: the refused call is billed at Haiku 5.5 prices, the question is Sonnet\'s', async () => {
    t.llm.refuseNext('reasoning_question', 'cyber');
    const a = await ready('incident_response', 'beginner');
    expect(calls('reasoning_question')).toEqual([
      ['SMALL', 'claude-haiku-5-5'],
      ['LARGE', 'claude-sonnet-5-5'],
    ]);
    const rows = await ledger(a.id, 'generate');
    expect(rows.map((l) => [l.tier, l.model, l.status, l.error_kind])).toEqual([
      ['SMALL', 'claude-haiku-5-5', 'failed', 'refusal'],
      ['LARGE', 'claude-sonnet-5-5', 'settled', null],
    ]);
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(haiku55Usd(rows[0]!), 6);
    const { rows: [item] } = await t.pool.query(`SELECT i.tier, i.model, a.generation_tries FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1`, [a.id]);
    expect(item).toEqual({ tier: 'LARGE', model: 'claude-sonnet-5-5', generation_tries: 2 });
  });

  it('a refusal on the SMALL evaluator escalates: stage 1 again on LARGE, then the challenger and reconciler; the evaluation neither fails nor degrades', async () => {
    const a = await ready('cloud_security', 'advanced');
    const key = await keyOf(a.id);
    t.llm.reset();
    t.llm.refuseNext('reasoning_evaluator', 'cyber');
    const r = await answer(a, key.correctOption, STRONG);
    expect(r.degraded).toBe(false);
    expect(r.correct).toBe(true);
    expect(t.llm.calls.filter((c) => /^reasoning_(evaluator|challenger|reconciler)$/.test(c.name ?? '')).map((c) => [c.name, c.tier, c.model])).toEqual([
      ['reasoning_evaluator', 'SMALL', 'claude-haiku-5-5'],
      ['reasoning_evaluator', 'LARGE', 'claude-sonnet-5-5'],
      ['reasoning_challenger', 'LARGE', 'claude-sonnet-5-5'],
      ['reasoning_reconciler', 'LARGE', 'claude-sonnet-5-5'],
    ]);
    const rows = await ledger(a.id, 'evaluation');
    expect(rows.map((l) => [l.feature, l.tier, l.model, l.status, l.error_kind])).toEqual([
      ['reasoning.evaluator', 'SMALL', 'claude-haiku-5-5', 'failed', 'refusal'],
      ['reasoning.evaluator', 'LARGE', 'claude-sonnet-5-5', 'settled', null],
      ['reasoning.challenger', 'LARGE', 'claude-sonnet-5-5', 'settled', null],
      ['reasoning.reconciler', 'LARGE', 'claude-sonnet-5-5', 'settled', null],
    ]);
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(haiku55Usd(rows[0]!), 6);
    const s = await storedEvaluation(a.id);
    expect(s).toMatchObject({ tier: 'LARGE', model: 'claude-sonnet-5-5', degraded: false });
    expect(s.stages.escalation).toEqual({ mode: 'tiered', escalated: true, reasons: ['small_refused'] });
    expect(s.stages.challenger).not.toBeNull();
    expect(s.stages.reconciler).not.toBeNull();
    expect((await learner.get(`/v1/reasoning/attempts/${a.id}`)).body.state).toBe('evaluated');
  });

  it('a learner whose every answer the SMALL evaluator declines stays bounded by AI_USER_DAILY_CAP_USD: the LARGE stage 1 and the pair run as finalize but count toward their day (review H55-COST-4)', async () => {
    const first = await ready('cloud_security', 'beginner');
    const second = await ready('cloud_security', 'beginner');
    const me = (await learner.get('/v1/me')).body.id as string;
    /** The learner's spend today, as LlmService sums it for the user-day cap (every budget, finalize included). */
    const dayUsd = async () =>
      Number(
        (await t.pool.query(`SELECT COALESCE(SUM(COALESCE(cost_usd, estimated_cost_usd)), 0) AS s FROM llm_call_log WHERE user_id = $1 AND created_at >= date_trunc('day', now()) AND (status <> 'failed' OR cost_usd IS NOT NULL)`, [me])).rows[0].s,
      );
    // Spent elsewhere today (interviews share the cap) up to the room one stage-1 evaluation needs: the answer is admitted at the cap.
    const room = t.app.get(GenerationService).evaluationRoomUsd('cloud_security');
    const elsewhere = Math.round((t.cfg.AI_USER_DAILY_CAP_USD - room - (await dayUsd())) * 1e6) / 1e6;
    await t.pool.query(
      `INSERT INTO llm_call_log (org_id, user_id, feature, tier, model, prompt_version, status, estimated_cost_usd, cost_usd)
       VALUES ((SELECT org_id FROM memberships WHERE user_id = $1 LIMIT 1), $1, 'interview.turn', 'LARGE', 'claude-sonnet-5-5', 'test', 'settled', $2, $2)`,
      [me, elsewhere],
    );
    try {
      t.llm.reset();
      t.llm.refuseNext('reasoning_evaluator', 'cyber');
      const r = await answer(first, (await keyOf(first.id)).correctOption, STRONG);
      expect(r.degraded).toBe(false);
      const rows = await ledger(first.id, 'evaluation');
      expect(rows.map((l) => [l.feature, l.tier, l.status])).toEqual([
        ['reasoning.evaluator', 'SMALL', 'failed'],
        ['reasoning.evaluator', 'LARGE', 'settled'],
        ['reasoning.challenger', 'LARGE', 'settled'],
        ['reasoning.reconciler', 'LARGE', 'settled'],
      ]);
      // Admitted work completes past the cap, and only by its own finalize stages: without them the learner is still under it.
      const finalizeUsd = rows.slice(1).reduce((sum, l) => sum + Number(l.cost_usd), 0);
      const total = await dayUsd();
      expect(total).toBeGreaterThan(t.cfg.AI_USER_DAILY_CAP_USD);
      expect(total - finalizeUsd).toBeLessThan(t.cfg.AI_USER_DAILY_CAP_USD);
      // Those finalize rows count toward the learner's day, so the next answer is refused before it is sent.
      const next = await learner.post(`/v1/reasoning/attempts/${second.id}/submit`).set('Origin', ORIGIN).send({ selectedOption: 'A', justification: STRONG, clientSubmissionId: randomUUID() });
      expect(next.status).toBe(429);
      expect(next.body.error).toMatchObject({ code: 'LLM_BUDGET_EXCEEDED', details: { scope: 'user_day' } });
      expect(t.llm.calls.filter((c) => c.name === 'reasoning_evaluator')).toHaveLength(2);
    } finally {
      await t.pool.query(`DELETE FROM llm_call_log WHERE user_id = $1 AND prompt_version = 'test'`, [me]);
    }
  });

  it('the learner\'s on-demand pre-check still admits a question: the ladder and the evaluation room, priced on Haiku 5.5 with the larger allowances, fit the daily cap', async () => {
    const gen = t.app.get(GenerationService);
    // The shipped defaults: full mode, so the room is stage 1 on Sonnet.
    const defaults = await startApp({ RATE_LIMIT_SCALE: '20' });
    try {
      for (const domain of ['cloud_security', 'threat_intelligence']) {
        const ladder = gen.generationEstimateUsd(domain, 'advanced');
        const room = gen.evaluationRoomUsd(domain);
        // Haiku 5.5: 16,000 output tokens at US$0.50 is US$0.008, then the 12,000-token Sonnet rewrite (about US$0.13).
        expect(ladder).toBeGreaterThan(0.12);
        expect(ladder).toBeLessThan(0.16);
        // 8,000 output tokens at US$0.50 plus the bounded prompt.
        expect(room).toBeGreaterThan(0.004);
        expect(room).toBeLessThan(0.008);
        expect(ladder + room).toBeLessThan(t.cfg.AI_USER_DAILY_CAP_USD);
        const shipped = defaults.app.get(GenerationService);
        expect(shipped.generationEstimateUsd(domain, 'advanced')).toBeCloseTo(ladder, 6);
        // 3,000 output tokens at US$10 plus the bounded prompt at US$2.
        const fullRoom = shipped.evaluationRoomUsd(domain);
        expect(fullRoom).toBeGreaterThan(0.03);
        expect(fullRoom).toBeLessThan(0.07);
        expect(ladder + fullRoom).toBeLessThan(defaults.cfg.AI_USER_DAILY_CAP_USD);
      }
    } finally {
      await defaults.close();
    }
  });
});
