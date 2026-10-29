import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ReasoningAttemptView, ReasoningResult } from '@threatready/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, ORIGIN, resetDatabase, signUp, startApp, type Agent, type TestApp } from './harness.js';

/**
 * Real-model check of the Attack Reasoning pipeline (a question written on the architecture library:
 * Haiku first, one Sonnet rewrite when the quality gate rejects it; the tiered evaluation: one Haiku
 * pass, the Sonnet challenger and reconciler only when escalated) against Anthropic. Opt in with
 * REAL_LLM=1; it reads ANTHROPIC_API_KEY from the environment or ../../.env. Measured 27 Oct 2026: a
 * Haiku try about US$0.02-0.026, a Sonnet rewrite about US$0.046-0.054, a single-pass evaluation about
 * US$0.013 (an escalated one about US$0.09), so a run costs up to about US$0.17. Everything else in
 * the suite uses the deterministic fake driver.
 */
const enabled = process.env.REAL_LLM === '1';

function apiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const line = readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    return line?.slice('ANTHROPIC_API_KEY='.length).trim();
  } catch {
    return undefined;
  }
}

describe.skipIf(!enabled)('attack reasoning against the real model (REAL_LLM=1)', () => {
  let t: TestApp;
  let learner: Agent;
  beforeAll(async () => {
    await resetDatabase();
    t = await startApp({ LLM_DRIVER: 'anthropic', ANTHROPIC_API_KEY: apiKey() ?? '', LLM_VERIFY_MODELS_ON_BOOT: 'false', RATE_LIMIT_SCALE: '20' });
    learner = await signUp(t, 'Real Model Tester');
  }, 120_000);
  afterAll(async () => t?.close());

  it('generates a valid Cloud Security item and evaluates a reasoned answer end to end', async () => {
    const created = await learner.post('/v1/reasoning/attempts').set('Origin', ORIGIN).send({ domain: 'cloud_security' });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    await drainJobs(t, { only: ['reasoning.generate'] });
    const got = await learner.get(`/v1/reasoning/attempts/${created.body.id}`);
    const a = got.body as ReasoningAttemptView;
    const { rows } = await t.pool.query('SELECT generation_tries, failure_code FROM reasoning_attempts WHERE id = $1', [a.id]);
    console.log('generation:', a.state, 'tries', rows[0].generation_tries, rows[0].failure_code ?? '');
    expect(a.state, JSON.stringify(a.failure)).toBe('ready');
    const item = a.item!;
    console.log('item:', item.title, '|', item.question);
    console.log('diagram:', item.diagram.nodes.length, 'nodes', item.diagram.edges.length, 'edges', item.diagram.attackPath.length, 'attack steps');
    expect(item.options).toHaveLength(4);
    expect(item.diagram.attackPath.length).toBeGreaterThan(0);

    // Since TR-42 the public item id is the attempt's; the shared question is reached through the attempt.
    const { rows: priv } = await t.pool.query('SELECT i.private FROM reasoning_attempts a JOIN reasoning_items i ON i.id = a.item_id WHERE a.id = $1', [a.id]);
    const correct = priv[0].private.correctOption as 'A' | 'B' | 'C' | 'D';
    const entry = item.diagram.nodes.find((n) => n.entryPoint)?.label ?? 'the entry point';
    const pathNodes = item.diagram.attackPath.map((id) => item.diagram.edges.find((e) => e.id === id)!).map((e) => `${item.diagram.nodes.find((n) => n.id === e.from)?.label} to ${item.diagram.nodes.find((n) => n.id === e.to)?.label}`);
    const chosen = item.options.find((o) => o.id === correct)!;
    const justification = `I choose option ${correct}: ${chosen.text} The attacker entered through ${entry}, and the diagram shows the path ${pathNodes.join(', then ')}. ${item.attackNarrative.split('. ').slice(0, 2).join('. ')}. This option acts on that path directly rather than on a component the attacker is not using, it keeps the logs and the compromised identity available for forensics, and it respects the constraint in the scenario. The other options either act too broadly, wait while the attacker is active, or touch a component that is not on the attack path.`;
    const sub = await learner.post(`/v1/reasoning/attempts/${a.id}/submit`).set('Origin', ORIGIN).send({ selectedOption: correct, justification, clientSubmissionId: randomUUID() });
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);
    await drainJobs(t, { only: ['reasoning.evaluate'] });
    const res = await learner.get(`/v1/reasoning/attempts/${a.id}/result`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body as ReasoningResult;
    console.log('result:', r.totalScore, 'correct', r.correct, 'confidence', r.confidence, 'review', r.reviewFlag, 'degraded', r.degraded);
    console.log('dimensions:', r.dimensions.map((d) => `${d.key} ${d.score}/${d.weight}`).join(', '));
    console.log('decision:', r.feedback.decision);
    expect(r.correct).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.totalScore).toBeGreaterThanOrEqual(30);
    expect(r.feedback.whyAlternatives).toHaveLength(3);
    const { rows: ledger } = await t.pool.query('SELECT feature, status, cost_usd, latency_ms FROM llm_call_log WHERE source_id = $1 ORDER BY id', [a.id]);
    console.log('ledger:', ledger.map((l) => `${l.feature} ${l.status} $${Number(l.cost_usd).toFixed(4)} ${l.latency_ms}ms`).join(' | '));
    expect(ledger.every((l) => l.status === 'settled')).toBe(true);
  }, 600_000);
});
