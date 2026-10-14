/**
 * Interview cost estimate from measured prompt sizes.
 *
 * Runs complete simulated interviews (15/30/45 minutes) through the real API, prompt builders and
 * planner, with the fake LlmPort capturing the exact size of every prompt the code sends. Input
 * tokens = measured characters / CHARS_PER_TOKEN. Output tokens per call type are stated
 * assumptions (the fake model's outputs are not representative). Prices come from the verified
 * model registry for the configured SMALL and LARGE models.
 *
 * Once real traffic exists, replace this with measured usage from llm_call_log:
 *   SELECT feature, tier, avg(input_tokens), avg(output_tokens), avg(cost_usd)
 *   FROM llm_call_log WHERE status = 'settled' GROUP BY 1, 2;
 *   SELECT avg(total) FROM (SELECT source_id, sum(cost_usd) total FROM llm_call_log
 *     WHERE status = 'settled' AND source_id IS NOT NULL GROUP BY 1) s;
 *
 * Usage: DATABASE_URL=... npx tsx scripts/estimate-cost.ts   (uses a throwaway test database)
 */
import { AI_CONSENT_VERSION } from '@threatready/contracts';
import '../test/setup-env.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { SessionView } from '@threatready/contracts';
import { costUsd, MODEL_PRICING } from '../src/modules/ai/pricing.js';
import { drainJobs, JD_TEXT, ORIGIN, resetDatabase, RESUME_TEXT, signUp, sse, startApp } from '../test/harness.js';
import { docxFrom, uploadDocument } from '../test/harness.js';

const CONSENT = { accepted: true, version: AI_CONSENT_VERSION } as const;

const CHARS_PER_TOKEN = 3.5; // conservative for English prose and JSON on current tokenizers

/** Assumed output tokens per call (thinking included for LARGE). */
const OUTPUT_TOKENS: Record<string, number> = {
  candidate_profile: 1800,
  job_profile: 900,
  gap_analysis: 2000, // ~1,200 JSON + ~800 thinking at effort low
  answer_evaluation: 380,
  question: 75,
  final_scoring_base: 2600, // summary/plan + thinking at effort medium
  final_scoring_per_turn: 520,
};

/** Typical lengths: a ~5,000-character resume and 150-250-word answers. */
const RESUME_EXTRA = Array.from({ length: 14 }, (_, i) =>
  `- Project ${i + 1}: led the rollout of a detection use case for credential abuse across 40 business units, wrote Splunk correlation searches, tuned thresholds with the SOC leads and cut false positives by ${10 + i}% over a quarter.`,
).join('\n');
const pad = (s: string) => `${s} ${'To give a concrete example from my last role, we saw this pattern during a password spraying campaign, and I walked the team through the evidence, the decision points and the follow-up hardening, including the detection changes and how we verified that they worked over the next two weeks.'.repeat(2)}`;

const ANSWERS_SHORT = [
  'In my role I handled this directly. I would scope the alert, correlate authentication logs across sources, look for spraying patterns from one address, enrich indicators with threat intelligence and escalate using the severity matrix, documenting each step.',
  'I would check the logs in Splunk and escalate it.',
  'First I confirm the scope and impact, then contain the affected accounts, preserve evidence, and coordinate with the IR lead before eradication and recovery. Afterwards we run a lessons-learned review and tune detections to cut false positives.',
];
const ANSWERS = ANSWERS_SHORT.map((a, i) => (i === 1 ? a : pad(a)));

async function main() {
  await resetDatabase();
  const t = await startApp({ INTERVIEW_MAX_OPEN_SESSIONS: '20', INTERVIEW_MONTHLY_QUOTA_FREE: '50', RATE_LIMIT_SCALE: '50' });
  const small = MODEL_PRICING[t.cfg.LLM_MODEL_SMALL]!;
  const large = MODEL_PRICING[t.cfg.LLM_MODEL_LARGE]!;
  const results: Record<string, unknown>[] = [];

  for (const durationMin of [15, 30, 45]) {
    t.llm.reset();
    const agent = await signUp(t);
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(`${RESUME_TEXT}\nPROJECTS\n${RESUME_EXTRA}\n${randomUUID()}`));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const created = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    await drainJobs(t, { only: ['interview.analyse'] });
    await agent.post(`/v1/interviews/${created.body.id}/plan`).set('Origin', ORIGIN).send({
      config: { interviewType: 'mixed', difficulty: 'intermediate', durationMin, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false },
    });
    let s = (await sse(agent, `/v1/interviews/${created.body.id}/start`)).events.find((e) => e.type === 'done') as { session: SessionView };
    let turns = 0;
    while (s.session.state === 'awaiting_answer' && turns < 30) {
      const r = await sse(agent, `/v1/interviews/${created.body.id}/turns`, { turnId: s.session.currentTurn!.turnId, answer: ANSWERS[turns % ANSWERS.length], clientSubmissionId: randomUUID() });
      s = r.events.find((e) => e.type === 'done') as { session: SessionView };
      turns++;
    }
    await drainJobs(t);

    let total = 0;
    const byCall: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number; tier: string }> = {};
    for (const c of t.llm.calls) {
      const name = c.name ?? c.kind;
      const inputTokens = Math.ceil(c.chars / CHARS_PER_TOKEN);
      const outputTokens = name === 'final_scoring' ? OUTPUT_TOKENS.final_scoring_base! + turns * OUTPUT_TOKENS.final_scoring_per_turn! : (OUTPUT_TOKENS[name] ?? 200);
      const cost = costUsd(c.tier === 'SMALL' ? small : large, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
      const row = (byCall[name] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tier: c.tier });
      row.calls++;
      row.inputTokens += inputTokens;
      row.outputTokens += outputTokens;
      row.costUsd = Math.round((row.costUsd + cost) * 1e6) / 1e6;
      total += cost;
    }
    results.push({ durationMin, turns, totalUsd: Math.round(total * 10000) / 10000, byCall });
    console.log(`\n${durationMin}-minute interview: ${turns} turns, estimated US$${total.toFixed(4)}`);
    console.table(byCall);
  }

  const out = { generatedAt: new Date().toISOString(), models: { SMALL: t.cfg.LLM_MODEL_SMALL, LARGE: t.cfg.LLM_MODEL_LARGE }, charsPerToken: CHARS_PER_TOKEN, outputTokenAssumptions: OUTPUT_TOKENS, results };
  writeFileSync(new URL('../../../docs/interviewprep-cost-estimate.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
  await t.close();
}

await main();
process.exit(0);
