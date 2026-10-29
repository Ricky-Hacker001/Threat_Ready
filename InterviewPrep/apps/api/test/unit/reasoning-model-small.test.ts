import type { JobProfile } from '@threatready/contracts';
import { DomainError, PortError } from '@threatready/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import { LlmService, refusalOf } from '../../src/modules/ai/llm.service.js';
import { costUsd, estimateInterviewCost, estimateTokens, INTERVIEW_COST_MODEL, MODEL_PRICING } from '../../src/modules/ai/pricing.js';
import { clarifyRequest } from '../../src/modules/ai/prompts/interview.prompts.js';
import { architecturesFor, surfacesFor } from '../../src/modules/reasoning/architectures/index.js';
import { CLOUD_SECURITY } from '../../src/modules/reasoning/domains/cloud-security.js';
import { escalationReasons, type EscalationInput } from '../../src/modules/reasoning/evaluation-policy.js';
import type { VariationSeed } from '../../src/modules/reasoning/domain.types.js';
import { challengerRequest, evaluatorRequestBound, reconcilerRequest, type EvaluationItem, type EvaluatorOutput } from '../../src/modules/reasoning/prompts/evaluation.prompts.js';
import { generationRequest, generationSchema, questionRequest } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { DEFAULT_WEIGHTS } from '../../src/modules/reasoning/scoring.js';
import { pickLibrarySeed } from '../../src/modules/reasoning/seed.js';
import { smallTierParams } from '../../src/modules/reasoning/small-tier.js';
import { toGeneratedItem } from '../../src/modules/reasoning/validation.js';
import { AnthropicLlmAdapter } from '../../src/platform/adapters/anthropic-llm.adapter.js';
import { FakeLlmAdapter } from '../../src/platform/adapters/fake-llm.adapter.js';
import { fakeReasoningItem } from '../../src/platform/adapters/fake/reasoning.fake.js';
import { DEFAULT_TIMING, queuePolicy } from '../../src/platform/adapters/pgboss-queue.adapter.js';
import { JOBS } from '../../src/platform/ports/queue.port.js';
import { promptChars, resolveModel, type LlmRequest } from '../../src/platform/ports/llm.port.js';

/**
 * Claude Haiku 5.5 for Attack Reasoning only (H55, 27 Oct 2026): the registry entry and its two rate
 * cards, REASONING_MODEL_SMALL and the one (tier, profile) -> model mapping, the request parameters a
 * thinking model gets, and what a refusal does. Interviews keep LLM_MODEL_SMALL. No database, no real model.
 */

const base = { DATABASE_URL: 'postgres://x', APP_ORIGIN: 'http://localhost:5173', API_BASE_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: 's'.repeat(40), INTERNAL_API_TOKEN: 't'.repeat(40), STORAGE_DRIVER: 'fs', LLM_DRIVER: 'fake' };
const prod = { ...base, NODE_ENV: 'production', LLM_DRIVER: 'anthropic', ANTHROPIC_API_KEY: 'k', ALLOW_EPHEMERAL_STORAGE: 'true', ALLOW_NO_SENTRY: 'true', ONBOARD_URL: 'https://onboard.example', INTERNAL_TOKENS_ACCEPT: 'a'.repeat(64), INTERNAL_TOKEN_FROM_ONBOARD: 'a'.repeat(64), LLM_MODEL_SMALL: 'claude-haiku-4-5' };
// Attack Reasoning on Haiku 4.5 (the rollback value; the default before H55 Decide) and on Haiku 5.5 (the default since).
const h45 = loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-4-5' });
const h55 = loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-5-5' });
const HAIKU_55 = MODEL_PRICING['claude-haiku-5-5']!;

/** A question request on the first beginner Cloud Security architecture. */
function question(tier: 'SMALL' | 'LARGE', cfg: AppConfig): LlmRequest {
  const arch = architecturesFor('cloud_security', 'beginner')[0]!;
  const seed = pickLibrarySeed(CLOUD_SECURITY, 'beginner', [arch], [], () => 0);
  const surface = surfacesFor(arch, 'cloud_security').find((s) => s.id === seed.entryPoint)!;
  return questionRequest({ arch, domain: CLOUD_SECURITY, seed, surface, tier, small: smallTierParams(cfg, 'generation'), avoid: [], previousFailure: [], tryNumber: 1 });
}

/** A legacy (pre-library) seed and the fake's item for it: enough for the grader prompts. */
const legacySeed: VariationSeed = { domain: 'cloud_security', difficulty: 'intermediate', topology: 'three_tier_web', entryPoint: 'leaked_access_key', objective: 'break_the_path', technique: 'T1078.004', constraint: 'change_freeze' };
function evaluationItem(): EvaluationItem {
  const out = generationSchema().zod.parse(fakeReasoningItem(generationRequest({ domain: CLOUD_SECURITY, seed: legacySeed, avoid: [], previousFailure: [], tryNumber: 1 })));
  const item = toGeneratedItem(out, CLOUD_SECURITY, legacySeed, DEFAULT_WEIGHTS);
  return { public: { ...item.public, weights: item.weights }, private: item.private };
}

const evaluatorOut = (): EvaluatorOutput => ({
  points: [],
  asserted_claims: [],
  incorrect_claims: [],
  integrity: { off_topic: false, instructs_grader: false, argues_for_option: null },
  strengths: [],
  gaps: [],
  confidence: 'high',
  reasoning_summary: 's',
  improve: [],
});

/** The Anthropic adapter with a stub SDK client: records every params object sent and answers with `reply`. */
function anthropic(cfg: AppConfig, reply: (params: Record<string, unknown>) => Record<string, unknown> = (p) => message(String(p.model), 'end_turn')) {
  const adapter = new AnthropicLlmAdapter({ ...cfg, ANTHROPIC_API_KEY: 'test-key' });
  const sent: Record<string, unknown>[] = [];
  Object.assign(adapter as unknown as { client: unknown }, {
    client: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          sent.push(params);
          return { currentMessage: undefined, finalMessage: async () => reply(params) };
        },
      },
    },
  });
  return { adapter, sent };
}
const message = (model: string, stop: string, extra: Record<string, unknown> = {}) => ({
  model,
  stop_reason: stop,
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '{"ok":true}' }],
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});
const probe = { name: 'probe', jsonSchema: {}, zod: z.object({ ok: z.boolean() }) };

describe('pricing: Claude Haiku 5.5 and the corrected Sonnet 5.5 cache read', () => {
  it('registers claude-haiku-5-5 at the verified prices, with effort, a 128k output cap and adaptive thinking', () => {
    expect(HAIKU_55).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, supportsEffort: true, maxOutputTokens: 128_000, adaptiveThinking: true });
    expect(HAIKU_55.longContext).toEqual({ aboveTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 });
    // Haiku 4.5 is unchanged: no effort, no adaptive thinking.
    expect(MODEL_PRICING['claude-haiku-4-5']).toEqual({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, supportsEffort: false, maxOutputTokens: 64_000 });
  });

  it('prices a call on the long-context card when input + cache reads + cache writes exceed 100,000 tokens, every token of it', () => {
    // Exactly 100,000 prompt tokens: the standard card.
    const at = { inputTokens: 50_000, cacheReadTokens: 30_000, cacheWriteTokens: 20_000, outputTokens: 2_000 };
    expect(costUsd(HAIKU_55, at)).toBeCloseTo((50_000 * 0.1 + 30_000 * 0.01 + 20_000 * 0.125 + 2_000 * 0.5) / 1e6, 6);
    // One token more: input, cache, and output all at the long-context rates.
    const over = { ...at, inputTokens: 50_001 };
    expect(costUsd(HAIKU_55, over)).toBeCloseTo((50_001 * 0.5 + 30_000 * 0.05 + 20_000 * 0.625 + 2_000 * 2.5) / 1e6, 5);
    // Cache reads count toward the prompt length: the same call with its prompt read from cache switches too.
    expect(costUsd(HAIKU_55, { inputTokens: 1_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 0 })).toBeCloseTo((1_000 * 0.5 + 100_000 * 0.05) / 1e6, 6);
    // A model without a long-context card never switches.
    expect(costUsd(MODEL_PRICING['claude-sonnet-5-5']!, { inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0.4);
  });

  it('Sonnet 5.5 cache hits cost US$0.10 per million tokens (0.05x input), as the pricing page lists', () => {
    expect(MODEL_PRICING['claude-sonnet-5-5']!.cacheReadPerMTok).toBe(0.1);
    expect(costUsd(MODEL_PRICING['claude-sonnet-5-5']!, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBe(0.1);
  });

  it('estimates Haiku 5.5 prompts at 2 characters a token (newer tokenizer); every other model keeps 3, so interview estimates do not move', () => {
    expect(estimateTokens(3000)).toBe(1000);
    expect(estimateTokens(3000, HAIKU_55)).toBe(1500);
    expect(estimateTokens(3000, MODEL_PRICING['claude-haiku-4-5'])).toBe(1000);
    expect(estimateTokens(3000, MODEL_PRICING['claude-sonnet-5-5'])).toBe(1000);
  });

  it('the interview caps are derived from LLM_MODEL_SMALL alone: REASONING_MODEL_SMALL does not move them', () => {
    const est = estimateInterviewCost(MODEL_PRICING['claude-haiku-4-5']!, MODEL_PRICING['claude-sonnet-5-5']!);
    expect(est).toMatchObject({ sessionCapUsd: 0.6, finalizeUsd: 0.2, userDailyCapUsd: 2, globalDailyCapUsd: 60 });
    for (const cfg of [h45, h55, loadConfig(prod), loadConfig({ ...prod, REASONING_MODEL_SMALL: 'claude-haiku-4-5' })]) {
      expect([cfg.LLM_MODEL_SMALL, cfg.AI_SESSION_CAP_USD, cfg.AI_FINAL_SCORING_RESERVE_USD, cfg.AI_USER_DAILY_CAP_USD, cfg.AI_GLOBAL_DAILY_CAP_USD]).toEqual(['claude-haiku-4-5', 0.6, 0.2, 2, 60]);
      expect(cfg.interviewCostEstimate).toEqual(est);
    }
  });

  it('prices the interview cost model on the standard card: its token shape is a total over many short calls, never one long prompt (review H55-SEC-1)', () => {
    // 200k input and 40k output at US$0.10 / 0.50: US$0.04 for the live share, not the 5x card's US$0.20.
    const est = estimateInterviewCost(HAIKU_55, MODEL_PRICING['claude-sonnet-5-5']!);
    expect(est).toEqual({ liveUsd: 0.04, finalizeUsd: 0.2, sessionCapUsd: 0.24, userDailyCapUsd: 0.92, globalDailyCapUsd: 24 });
    // Interviews on Haiku 5.5 (an open owner decision) would get the caps the price says, not caps about 1.67x higher.
    const cfg = loadConfig({ ...base, LLM_MODEL_SMALL: 'claude-haiku-5-5' });
    expect([cfg.AI_SESSION_CAP_USD, cfg.AI_FINAL_SCORING_RESERVE_USD, cfg.AI_USER_DAILY_CAP_USD, cfg.AI_GLOBAL_DAILY_CAP_USD]).toEqual([0.24, 0.2, 0.92, 24]);
    expect(cfg.interviewCostEstimate).toEqual(est);
    // One call whose own prompt is that long still pays the long-context card.
    expect(costUsd(HAIKU_55, { ...INTERVIEW_COST_MODEL.live, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0.2);
  });
});

describe('configuration: REASONING_MODEL_SMALL and the SMALL effort settings', () => {
  it('defaults to claude-haiku-5-5, writing at low effort and grading at medium (H55 Decide: intentional, was unset and medium/medium)', () => {
    const defaults = loadConfig(base);
    expect(defaults.REASONING_MODEL_SMALL).toBe('claude-haiku-5-5');
    expect(resolveModel(defaults, 'SMALL', 'reasoning')).toBe('claude-haiku-5-5');
    expect([defaults.REASONING_SMALL_EFFORT_GENERATION, defaults.REASONING_SMALL_EFFORT_EVALUATION]).toEqual(['low', 'medium']);
    expect(smallTierParams(defaults, 'generation')).toEqual({ thinking: true, effort: 'low' });
    expect(smallTierParams(defaults, 'evaluation')).toEqual({ thinking: true, effort: 'medium' });
    expect(loadConfig({ ...base, REASONING_SMALL_EFFORT_GENERATION: 'low', REASONING_SMALL_EFFORT_EVALUATION: 'high' })).toMatchObject({ REASONING_SMALL_EFFORT_GENERATION: 'low', REASONING_SMALL_EFFORT_EVALUATION: 'high' });
    expect(() => loadConfig({ ...base, REASONING_SMALL_EFFORT_GENERATION: 'max' })).toThrow(/REASONING_SMALL_EFFORT_GENERATION/);
  });

  it('must name a model in the verified registry, like the LLM_MODEL_* keys', () => {
    expect(h55.REASONING_MODEL_SMALL).toBe('claude-haiku-5-5');
    expect(() => loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-9-9' })).toThrow(/REASONING_MODEL_SMALL=claude-haiku-9-9 is not in the verified model registry/);
    const priced = loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-9-9', LLM_PRICING_OVERRIDES: JSON.stringify({ 'claude-haiku-9-9': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, adaptiveThinking: true, charsPerToken: 2 } }) });
    expect(priced.pricing['claude-haiku-9-9']).toMatchObject({ adaptiveThinking: true, charsPerToken: 2, supportsEffort: false });
  });

  it('a price override of a registered id changes only the fields it names: Haiku 5.5 keeps its thinking, effort, tokenizer and long-context card (review H55-SEC-3)', () => {
    // The override the docs used to suggest for claude-haiku-5-5: prices only.
    const prices = { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 };
    const cfg = loadConfig({ ...base, LLM_PRICING_OVERRIDES: JSON.stringify({ 'claude-haiku-5-5': prices }) });
    expect(cfg.pricing['claude-haiku-5-5']).toEqual(HAIKU_55);
    expect(smallTierParams(cfg, 'generation')).toEqual({ thinking: true, effort: 'low' });
    expect(smallTierParams(cfg, 'evaluation')).toEqual({ thinking: true, effort: 'medium' });
    expect(question('SMALL', cfg).maxOutputTokens).toBe(16_000);
    // A field the override names replaces the registry's.
    const changed = loadConfig({ ...base, LLM_PRICING_OVERRIDES: JSON.stringify({ 'claude-haiku-5-5': { ...prices, outputPerMTok: 0.6, maxOutputTokens: 64_000 } }) });
    expect(changed.pricing['claude-haiku-5-5']).toEqual({ ...HAIKU_55, outputPerMTok: 0.6, maxOutputTokens: 64_000 });
    // An id the registry lacks starts from no effort and 32k output tokens, as before; the registry itself is untouched.
    const fresh = loadConfig({ ...base, LLM_PRICING_OVERRIDES: JSON.stringify({ 'claude-haiku-9-9': prices }) });
    expect(fresh.pricing['claude-haiku-9-9']).toEqual({ ...prices, supportsEffort: false, maxOutputTokens: 32_000 });
    expect(MODEL_PRICING['claude-haiku-9-9']).toBeUndefined();
    expect(MODEL_PRICING['claude-haiku-5-5']!.outputPerMTok).toBe(0.5);
  });

  it('production boots with the default or another verified id; LLM_MODEL_SMALL stays required and is what interviews use', () => {
    const { LLM_MODEL_SMALL: _small, ...noSmall } = prod;
    expect(() => loadConfig({ ...noSmall, REASONING_MODEL_SMALL: 'claude-haiku-5-5' })).toThrow(/LLM_MODEL_SMALL: required in production/);
    // Render sets LLM_MODEL_SMALL only: Attack Reasoning gets Haiku 5.5 with no dashboard change, interviews keep Haiku 4.5.
    const cfg = loadConfig(prod);
    expect([cfg.LLM_MODEL_SMALL, cfg.REASONING_MODEL_SMALL, resolveModel(cfg, 'SMALL'), resolveModel(cfg, 'SMALL', 'reasoning')]).toEqual(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-5-5']);
    expect(resolveModel(loadConfig({ ...prod, REASONING_MODEL_SMALL: 'claude-haiku-4-5' }), 'SMALL', 'reasoning')).toBe('claude-haiku-4-5');
    expect(() => loadConfig({ ...prod, REASONING_MODEL_SMALL: 'claude-haiku-9-9' })).toThrow(/REASONING_MODEL_SMALL/);
  });
});

describe('model resolution: requests name a tier and a profile, one function names the model', () => {
  it('interviews (no profile) get LLM_MODEL_SMALL; Attack Reasoning gets REASONING_MODEL_SMALL, else LLM_MODEL_SMALL; LARGE is shared', () => {
    expect(resolveModel(h55, 'SMALL')).toBe('claude-haiku-4-5');
    expect(resolveModel(h55, 'SMALL', 'reasoning')).toBe('claude-haiku-5-5');
    expect(resolveModel(h55, 'LARGE', 'reasoning')).toBe('claude-sonnet-5-5');
    expect(resolveModel(h55, 'LARGE')).toBe('claude-sonnet-5-5');
    expect(resolveModel(h45, 'SMALL', 'reasoning')).toBe('claude-haiku-4-5');
    // An empty value follows LLM_MODEL_SMALL (outside Render, whose launcher drops empty values).
    expect(resolveModel(loadConfig({ ...base, REASONING_MODEL_SMALL: '' }), 'SMALL', 'reasoning')).toBe('claude-haiku-4-5');
    for (const port of [new FakeLlmAdapter(h55), new AnthropicLlmAdapter({ ...h55, ANTHROPIC_API_KEY: 'k' })]) {
      expect([port.modelFor('SMALL'), port.modelFor('SMALL', 'reasoning'), port.modelFor('LARGE', 'reasoning')]).toEqual(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
    }
  });

  it('every Attack Reasoning request carries the reasoning profile; an interview request carries none', () => {
    const item = evaluationItem();
    const ar = [
      question('SMALL', h55),
      question('LARGE', h55),
      generationRequest({ domain: CLOUD_SECURITY, seed: legacySeed, avoid: [], previousFailure: [], tryNumber: 1 }),
      evaluatorRequestBound(CLOUD_SECURITY, null),
      evaluatorRequestBound(CLOUD_SECURITY, null, undefined, 'LARGE'),
      challengerRequest(CLOUD_SECURITY, item, 'A', 'j', evaluatorOut()),
      reconcilerRequest(CLOUD_SECURITY, item, 'A', 'j', evaluatorOut(), null),
    ];
    for (const r of ar) expect(r.modelProfile).toBe('reasoning');
    const interview = clarifyRequest({ job: { title: 'SOC Analyst' } as JobProfile, question: 'q', message: 'm', earlier: [] });
    expect(interview.modelProfile).toBeUndefined();
    expect(new FakeLlmAdapter(h55).modelFor(interview.tier, interview.modelProfile)).toBe('claude-haiku-4-5');
  });

  it('LlmService estimates on the resolved model: Haiku 5.5 prices and characters per token for Attack Reasoning, Haiku 4.5 for the same request without the profile', () => {
    const llm = new LlmService(new FakeLlmAdapter(h55), null as never, h55);
    const req = question('SMALL', h55);
    const tokens55 = Math.ceil(promptChars(req) / 2);
    expect(llm.estimate(req)).toBeCloseTo((tokens55 * 0.1 + 16_000 * 0.5) / 1e6, 5);
    const asInterview = { ...req, modelProfile: undefined };
    expect(llm.estimate(asInterview)).toBeCloseTo((Math.ceil(promptChars(req) / 3) * 1 + 16_000 * 5) / 1e6, 5);
    // Price lookups fall back to the request's resolved model, never the interview SMALL model.
    expect(llm.priceOf('claude-unknown', req)).toBe(HAIKU_55);
    expect(llm.priceOf('claude-unknown', asInterview)).toBe(MODEL_PRICING['claude-haiku-4-5']);
  });
});

describe('request parameters on a thinking SMALL model', () => {
  it('Haiku 4.5 keeps exactly its parameters: no effort, 8,000 tokens and 90 s to write, 3,000 and 60 s to grade', () => {
    expect(smallTierParams(h45, 'generation')).toEqual({ thinking: false });
    expect(question('SMALL', h45)).toMatchObject({ tier: 'SMALL', maxOutputTokens: 8000, timeoutMs: 90_000 });
    expect(question('SMALL', h45).effort).toBeUndefined();
    const ev = evaluatorRequestBound(CLOUD_SECURITY, null, undefined, 'SMALL', smallTierParams(h45, 'evaluation'));
    expect(ev).toMatchObject({ maxOutputTokens: 3000, timeoutMs: 60_000 });
    expect(ev.effort).toBeUndefined();
  });

  it('Haiku 5.5 gets room for its thinking (16,000 / 8,000 tokens), longer timeouts and the configured effort; LARGE is unchanged', () => {
    expect(smallTierParams(h55, 'generation')).toEqual({ thinking: true, effort: 'low' });
    expect(question('SMALL', h55)).toMatchObject({ maxOutputTokens: 16_000, timeoutMs: 180_000, effort: 'low' });
    expect(evaluatorRequestBound(CLOUD_SECURITY, null, undefined, 'SMALL', smallTierParams(h55, 'evaluation'))).toMatchObject({ maxOutputTokens: 8000, timeoutMs: 120_000, effort: 'medium' });
    const tuned = loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-5-5', REASONING_SMALL_EFFORT_GENERATION: 'medium', REASONING_SMALL_EFFORT_EVALUATION: 'high' });
    expect(question('SMALL', tuned).effort).toBe('medium');
    expect(evaluatorRequestBound(CLOUD_SECURITY, null, undefined, 'SMALL', smallTierParams(tuned, 'evaluation')).effort).toBe('high');
    const large = question('LARGE', h55);
    expect(large).toMatchObject({ maxOutputTokens: 12_000, effort: 'medium' });
    expect(large.timeoutMs).toBeUndefined();
    expect(evaluatorRequestBound(CLOUD_SECURITY, null, undefined, 'LARGE', smallTierParams(h55, 'evaluation'))).toMatchObject({ maxOutputTokens: 3000, effort: 'medium' });
  });

  it('the Anthropic adapter sends Haiku 5.5 model, max_tokens, system, messages and output_config only: no thinking, sampling, prefill or fallbacks', async () => {
    const { adapter, sent } = anthropic(h55);
    await adapter.generateStructured(question('SMALL', h55), probe);
    const p = sent[0]!;
    expect(Object.keys(p).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(p).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16_000, output_config: { effort: 'low', format: { type: 'json_schema' } } });
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'fallbacks']) expect(p).not.toHaveProperty(key);
    // No assistant prefill: the conversation ends on the user's turn.
    expect((p.messages as { role: string }[]).at(-1)!.role).toBe('user');
    expect((p.messages as { role: string }[]).every((m) => m.role === 'user')).toBe(true);
  });

  it('the same Attack Reasoning request goes to Haiku 4.5 without effort when REASONING_MODEL_SMALL names it, and an interview request never reaches Haiku 5.5', async () => {
    const { adapter, sent } = anthropic(h45);
    await adapter.generateStructured(question('SMALL', h45), probe);
    // Even a request that asks for effort: Haiku 4.5 rejects it, so it is never sent.
    await adapter.generateStructured({ ...question('SMALL', h45), effort: 'high' }, probe);
    for (const p of sent) {
      expect(p).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 8000 });
      expect(p.output_config).toEqual({ format: { type: 'json_schema', schema: {} } });
    }
    const both = anthropic(h55);
    const interview = clarifyRequest({ job: { title: 'SOC Analyst' } as JobProfile, question: 'q', message: 'm', earlier: [] });
    await both.adapter.generate(interview);
    expect(both.sent[0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 250 });
    expect(both.sent[0]).not.toHaveProperty('output_config');
  });

  it('reads the answer by block type: a response that begins with a thinking block still parses', async () => {
    const { adapter } = anthropic(h55);
    await expect(adapter.generateStructured(question('SMALL', h55), probe)).resolves.toMatchObject({ value: { ok: true }, usage: { model: 'claude-haiku-5-5', inputTokens: 1200, outputTokens: 300 } });
  });

  it('the fake bills thinking as output on a thinking model only, by effort and within max_tokens', async () => {
    const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ tier: 'SMALL', modelProfile: 'reasoning', system: 's', messages: [{ role: 'user', content: 'u' }], maxOutputTokens: 1000, promptVersion: 't', ...over });
    const fake = new FakeLlmAdapter(h55);
    // 'OK' is one visible token.
    expect((await fake.generate(req({ effort: 'medium' }))).usage).toMatchObject({ model: 'claude-haiku-5-5', outputTokens: 2 });
    expect((await fake.generate(req({ effort: 'low' }))).usage.outputTokens).toBe(2);
    expect((await fake.generate(req({ effort: 'high' }))).usage.outputTokens).toBe(3);
    expect((await fake.generate(req({ maxOutputTokens: 1 }))).usage.outputTokens).toBe(1);
    // Haiku 4.5 (the interview SMALL model, and AR's when REASONING_MODEL_SMALL names it): no thinking.
    expect((await fake.generate(req({ modelProfile: undefined, effort: 'high' }))).usage).toMatchObject({ model: 'claude-haiku-4-5', outputTokens: 1 });
    expect((await new FakeLlmAdapter(h45).generate(req())).usage).toMatchObject({ model: 'claude-haiku-4-5', outputTokens: 1 });
    expect(fake.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']);
  });
});

describe('refusals (stop_reason refusal)', () => {
  it('the Anthropic adapter throws a SMALL refusal with its category and billed usage, and does not try a fallback model on SMALL', async () => {
    const cfg = loadConfig({ ...base, REASONING_MODEL_SMALL: 'claude-haiku-5-5', LLM_REFUSAL_FALLBACK_MODEL: 'claude-opus-5-5' });
    const { adapter, sent } = anthropic(cfg, (p) => message(String(p.model), 'refusal', { stop_details: { category: 'cyber' } }));
    const err = await adapter.generateStructured(question('SMALL', cfg), probe).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ kind: 'refusal', refusalCategory: 'cyber', usage: { model: 'claude-haiku-5-5', inputTokens: 1200, outputTokens: 300 } });
    expect(sent.map((p) => p.model)).toEqual(['claude-haiku-5-5']);
    expect(refusalOf(err)).toEqual({ category: 'cyber' });
  });

  it('LlmService turns it into LLM_OUTPUT_INVALID, records the billed refusal, and refusalOf() still reads the category through it', async () => {
    const fake = new FakeLlmAdapter(h55);
    const llm = new LlmService(fake, null as never, h55);
    const failed: unknown[] = [];
    // The ledger is not under test here: reservations and settlement are stubbed out, fail() is observed.
    Object.assign(llm as unknown as Record<string, unknown>, { reserve: async () => 1, settle: async () => undefined, fail: async (_id: number, _m: unknown, _r: unknown, e: unknown) => void failed.push(e) });
    fake.refuseNext('probe', 'cyber');
    const meta = { feature: 'reasoning.generate', owner: { userId: 'u', orgId: 'o' }, budget: 'reasoning' as const };
    const err = await llm.structured(meta, question('SMALL', h55), probe, { retryInvalid: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('LLM_OUTPUT_INVALID');
    expect(refusalOf(err)).toEqual({ category: 'cyber' });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'refusal', usage: { model: 'claude-haiku-5-5', outputTokens: 0 } });
    expect((failed[0] as { usage: { inputTokens: number } }).usage.inputTokens).toBeGreaterThan(0);
    // A refusal is not a schema failure: never repeated on the same model, whatever retryInvalid says.
    fake.reset();
    fake.refuseNext('probe');
    await expect(llm.structured(meta, question('SMALL', h55), probe)).rejects.toMatchObject({ code: 'LLM_OUTPUT_INVALID' });
    expect(fake.calls).toHaveLength(1);
    // Anything else is not a refusal.
    expect(refusalOf(new DomainError('LLM_OUTPUT_INVALID', { cause: new PortError('invalid_output', 'x') }))).toBeNull();
    expect(refusalOf(new PortError('refusal', 'x'))).toEqual({ category: null });
  });

  it('a SMALL refusal at stage 1 escalates (small_refused), even when the LARGE re-run flags integrity, and leaves no room for the audit', () => {
    const input = (over: Partial<EscalationInput> = {}): EscalationInput => ({
      mode: 'tiered',
      forced: false,
      selected: 'A',
      provisional: { total: 100, quoteDowngrades: 0 },
      evaluator: evaluatorOut(),
      justification: 'plain',
      center: 60,
      band: 8,
      ...over,
    });
    expect(escalationReasons(input())).toEqual([]);
    expect(escalationReasons(input({ smallRefused: true }))).toEqual(['small_refused']);
    expect(escalationReasons(input({ smallRefused: true, audit: true }))).toEqual(['small_refused']);
    expect(escalationReasons(input({ smallRefused: true, evaluator: { ...evaluatorOut(), integrity: { off_topic: false, instructs_grader: true, argues_for_option: null } } }))).toEqual(['small_refused']);
  });

  it('the evaluation job is sized for the refused path: a SMALL pass, then stage 1 again and the two later stages on LARGE', () => {
    const p = queuePolicy({ llmTimeoutMsLarge: 120_000, llmMaxRetries: 2, reasoningMaxGenerationTries: 2 });
    const perCall = 120 * 3 * 2;
    expect(p[JOBS.reasoningEvaluate].expireInSeconds).toBe(perCall * 4 + 60);
    // A SMALL call's worst case (two tries of the 120 s thinking timeout, each with the SDK's retries) fits in one LARGE call's.
    expect(2 * 120 * (1 + DEFAULT_TIMING.llmMaxRetries)).toBeLessThanOrEqual(perCall);
  });
});
