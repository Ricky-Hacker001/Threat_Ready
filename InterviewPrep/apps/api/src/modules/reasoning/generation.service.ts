import { Inject, Injectable } from '@nestjs/common';
import { reasoningAttempts, reasoningItems } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, desc, eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { LlmService } from '../ai/llm.service.js';
import { getDomain } from './domains/index.js';
import type { VariationSeed } from './domain.types.js';
import type { GeneratedItem } from './item.types.js';
import { GENERATION_PROMPT_VERSION, GENERATOR_VERSION, generationRequest, generationSchema } from './prompts/generation.prompts.js';
import { normaliseWeights } from './scoring.js';
import { pickSeed, type Rng } from './seed.js';
import { checkSimilarity, comparableText } from './similarity.js';
import { normaliseGeneratorOutput, toGeneratedItem, validateGeneratedItem } from './validation.js';

/** Budget codes that a job retry cannot fix: the attempt is marked failed with the code instead of retried. */
const TERMINAL_CODES = new Set(['LLM_BUDGET_EXCEEDED', 'AI_SERVICE_PAUSED', 'REASONING_DOMAIN_UNAVAILABLE']);

/**
 * Worker: generates the unique item for an attempt (spec §2, §3). A rejected generation (validation,
 * similarity) is regenerated in-process with the errors fed back; a provider failure is left to the
 * queue's retry policy; a budget stop marks the attempt failed with the reason.
 */
@Injectable()
export class GenerationService {
  /** Injectable for tests; Math.random in production. */
  rng: Rng = Math.random;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async runGeneration(attemptId: string): Promise<void> {
    const [a] = await this.db.system(({ db }) => db.select().from(reasoningAttempts).where(eq(reasoningAttempts.id, attemptId)));
    if (!a || a.state !== 'generating') return;
    const domain = getDomain(a.domain);
    if (!domain) return this.markFailed(attemptId, 'REASONING_DOMAIN_UNAVAILABLE');

    const previous = await this.db.system(({ db }) =>
      db
        .select({ id: reasoningItems.id, fingerprint: reasoningItems.fingerprint, seed: reasoningItems.seed, public: reasoningItems.public })
        .from(reasoningItems)
        .where(and(eq(reasoningItems.userId, a.userId), eq(reasoningItems.domain, a.domain)))
        .orderBy(desc(reasoningItems.createdAt))
        .limit(40),
    );
    const recentSeeds = previous.map((p) => p.seed as VariationSeed);
    const avoid = previous.slice(0, 8).map((p) => {
      const pub = p.public as GeneratedItem['public'];
      return { title: pub.title, question: pub.question };
    });
    const previousText = previous.map((p) => ({ id: p.id, fingerprint: p.fingerprint, text: comparableText(p.public as GeneratedItem['public']) }));
    const meta = { feature: 'reasoning.generate', owner: { userId: a.userId, orgId: a.orgId }, sourceId: a.id, budget: 'new_interview' as const };

    let feedback: string[] = [];
    const used = new Set<string>();
    const started = Date.now();
    for (let tryNumber = 1; tryNumber <= this.cfg.REASONING_MAX_GENERATION_TRIES; tryNumber++) {
      const seed = pickSeed(domain, recentSeeds, this.rng, used);
      used.add([seed.domain, seed.topology, seed.entryPoint, seed.objective, seed.technique].join('|'));
      await this.db.system(({ db }) => db.update(reasoningAttempts).set({ generationTries: tryNumber, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId)));

      let value: Awaited<ReturnType<typeof this.llm.structured<ReturnType<typeof generationSchema>['zod']['_output']>>>;
      try {
        value = await this.llm.structured(meta, generationRequest({ domain, seed, avoid, previousFailure: feedback, tryNumber }), generationSchema());
      } catch (err) {
        if (err instanceof DomainError && TERMINAL_CODES.has(err.code)) return this.markFailed(attemptId, err.code);
        if (err instanceof DomainError && err.code === 'LLM_OUTPUT_INVALID' && tryNumber < this.cfg.REASONING_MAX_GENERATION_TRIES) {
          emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'schema' });
          feedback = ['The previous output did not match the required JSON structure; follow the schema exactly.'];
          continue;
        }
        throw err; // provider outage or timeout: the queue retries the job
      }

      const { out, repairs } = normaliseGeneratorOutput(value.value, domain, seed);
      if (repairs.length) logger.info({ attempt_id: attemptId, try: tryNumber, repairs }, 'generated item normalised');
      const validation = validateGeneratedItem(out, domain, seed);
      if (!validation.ok) {
        emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'validation' });
        // Validator messages name components and rules, never the learner; they are what operators tune the prompt with.
        logger.warn({ attempt_id: attemptId, try: tryNumber, errors: validation.errors.length, reasons: validation.errors.slice(0, 6).map((e) => e.slice(0, 200)) }, 'generated item rejected by validation');
        feedback = validation.errors.slice(0, 12);
        continue;
      }
      const objective = domain.variation.objectives.find((o) => o.id === seed.objective);
      const item = toGeneratedItem(out, domain, seed, normaliseWeights(objective?.weights, domain.weights));
      const sim = checkSimilarity({ fingerprint: item.fingerprint, text: comparableText(item.public) }, previousText, this.cfg.REASONING_SIMILARITY_THRESHOLD);
      if (sim.tooSimilar) {
        emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'similarity' });
        logger.warn({ attempt_id: attemptId, try: tryNumber, similarity: sim.max, collision: sim.fingerprintCollision }, 'generated item too similar to a previous one');
        feedback = [`The item was too similar to one the learner has already seen (similarity ${sim.max}). Change the company, the components, the attack steps and the options.`];
        continue;
      }

      await this.db.system(async ({ db }) => {
        const [row] = await db
          .insert(reasoningItems)
          .values({
            orgId: a.orgId,
            userId: a.userId,
            domain: a.domain,
            difficulty: item.public.difficulty,
            fingerprint: item.fingerprint,
            seed: item.seed,
            public: item.public,
            private: item.private,
            weights: item.weights,
            generatorVersion: GENERATOR_VERSION,
            promptVersion: GENERATION_PROMPT_VERSION,
            model: value.usage.model,
            tier: 'LARGE',
          })
          .returning({ id: reasoningItems.id });
        await db
          .update(reasoningAttempts)
          .set({ state: 'ready', itemId: row!.id, failureCode: null, failureStage: null, updatedAt: new Date() })
          .where(and(eq(reasoningAttempts.id, attemptId), eq(reasoningAttempts.state, 'generating')));
      });
      emitMetric('ReasoningGenerationMs', Date.now() - started, 'Milliseconds', { Domain: domain.key });
      logger.info({ attempt_id: attemptId, tries: tryNumber, warnings: validation.warnings.length, similarity: sim.max }, 'reasoning item generated');
      return;
    }
    emitMetric('ReasoningGenerationFailed', 1, 'Count', { Domain: domain.key });
    await this.markFailed(attemptId, 'REASONING_GENERATION_FAILED');
  }

  async markFailed(attemptId: string, code: string): Promise<void> {
    await this.db.system(({ db }) =>
      db
        .update(reasoningAttempts)
        .set({ state: 'generation_failed', failureCode: code, failureStage: 'generation', updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.id, attemptId), eq(reasoningAttempts.state, 'generating'))),
    );
  }
}
