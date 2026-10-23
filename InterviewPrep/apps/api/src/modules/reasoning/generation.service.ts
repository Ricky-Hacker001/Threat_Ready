import { Inject, Injectable } from '@nestjs/common';
import type { ReasoningDifficulty } from '@threatready/contracts';
import { reasoningAttempts, reasoningItems, reasoningServed } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { LlmService, type CallMeta } from '../ai/llm.service.js';
import { getDomain, registeredDomains } from './domains/index.js';
import { fingerprintOf, type ReasoningDomain, type VariationSeed } from './domain.types.js';
import type { GeneratedItem } from './item.types.js';
import { GENERATION_PROMPT_VERSION, GENERATOR_VERSION, generationRequest, generationSchema } from './prompts/generation.prompts.js';
import { normaliseWeights } from './scoring.js';
import { pickSeed, type Rng } from './seed.js';
import { checkSimilarity, comparableText } from './similarity.js';
import { normaliseGeneratorOutput, toGeneratedItem, validateGeneratedItem } from './validation.js';

/** The platform account that owns pool generation in the AI ledger (migration 0009). */
export const POOL_USER_ID = 'threatready-reasoning-pool';
export const POOL_ORG_ID = '00000000-0000-4000-8000-0000000a11d0';
/** Difficulties the pool keeps a bucket for. */
export const POOL_DIFFICULTIES: readonly ReasoningDifficulty[] = ['beginner', 'intermediate', 'advanced'];

/**
 * The pool bucket a requested difficulty is served from. The contract also accepts 'expert', which
 * shares the 'advanced' bucket: without this every expert request missed the pool and queued a
 * 16k-token on-demand generation billed to the platform account (pool-budget DoS, audit §3.5).
 */
export function poolBucket(difficulty: string): ReasoningDifficulty {
  if (difficulty === 'expert') return 'advanced';
  return (POOL_DIFFICULTIES as readonly string[]).includes(difficulty) ? (difficulty as ReasoningDifficulty) : 'intermediate';
}

/** Budget codes that a job retry cannot fix: the attempt is marked failed with the code instead of retried. */
const TERMINAL_CODES = new Set(['LLM_BUDGET_EXCEEDED', 'AI_SERVICE_PAUSED', 'REASONING_DOMAIN_UNAVAILABLE']);

/** What a generation compares against so the new question is distinct from the rest of its bucket. */
interface Bank {
  seeds: VariationSeed[];
  texts: { id: string; fingerprint: string; text: string }[];
  avoid: { title: string; question: string }[];
}

type Generated = { ok: true; item: GeneratedItem; model: string; tries: number } | { ok: false; code: string; tries: number };

/**
 * Question generation (spec §2, §3). Questions live in a shared pool per domain and difficulty:
 * the refill job generates them ahead of time, several in parallel, so a learner normally gets one
 * instantly. Each question is validated in code and checked against the rest of its bucket; a
 * rejected one is regenerated with the reasons fed back. A provider failure is left to the queue's
 * retry policy; a budget stop ends the run with the reason.
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

  /* ---------------- Pool refill ---------------- */

  /**
   * Tops up the pool. With a domain and difficulty, that bucket; without, every bucket of every
   * registered domain (the schedule). A bucket is filled to REASONING_POOL_TARGET questions, and to
   * at least REASONING_POOL_MIN_AVAILABLE that the requesting learner has not been served, at most
   * REASONING_POOL_BATCH per run, generated in parallel.
   */
  async refillPool(req: { domain?: string; difficulty?: string; userId?: string } = {}): Promise<void> {
    const domains = req.domain ? [getDomain(req.domain)].filter((d): d is ReasoningDomain => Boolean(d)) : registeredDomains();
    for (const domain of domains) {
      const levels = req.difficulty ? POOL_DIFFICULTIES.filter((d) => d === poolBucket(req.difficulty!)) : POOL_DIFFICULTIES;
      for (const difficulty of levels) await this.refillBucket(domain, difficulty, req.userId);
    }
  }

  private async refillBucket(domain: ReasoningDomain, difficulty: ReasoningDifficulty, userId?: string): Promise<void> {
    // One refill per bucket at a time across workers: a session-level advisory lock on a dedicated connection.
    const lockClient = await this.db.pool.connect();
    const key = `reasoning-pool:${domain.key}:${difficulty}`;
    try {
      const { rows } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 99)) AS ok', [key]);
      if (!rows[0]?.ok) return;
      try {
        const need = await this.needed(domain.key, difficulty, userId);
        if (need <= 0) return;
        const started = Date.now();
        const bank = await this.bankFor(domain.key, difficulty);
        // Distinct seeds for the batch, chosen up front so parallel generations do not collide.
        const seeds: VariationSeed[] = [];
        const exclude = new Set(bank.seeds.map(fingerprintOf));
        for (let i = 0; i < need; i++) {
          const s = pickSeed(domain, [...bank.seeds, ...seeds], this.rng, exclude, difficulty);
          exclude.add(fingerprintOf(s));
          seeds.push(s);
        }
        const results = await Promise.all(
          seeds.map((seed) =>
            this.generateOne(domain, difficulty, bank, { sourceId: undefined, firstSeed: seed }).catch((err: unknown) => {
              logger.warn({ bucket: key, err: { name: (err as Error).name, message: (err as Error).message } }, 'pool generation failed');
              return { ok: false as const, code: 'REASONING_GENERATION_FAILED', tries: 0 };
            }),
          ),
        );
        let added = 0;
        for (const r of results) {
          if (!r.ok) continue;
          await this.db.system(({ db }) => db.insert(reasoningItems).values(this.itemRow(r.item, r.model)));
          added++;
        }
        emitMetric('ReasoningPoolAdded', added, 'Count', { Domain: domain.key, Difficulty: difficulty });
        logger.info({ bucket: key, requested: need, added, ms: Date.now() - started }, 'reasoning pool refilled');
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 99))', [key]).catch(() => undefined);
      }
    } finally {
      lockClient.release();
    }
  }

  /**
   * How many questions this bucket should gain now. A learner-triggered refill tops the bucket up for
   * that learner but never past REASONING_POOL_TARGET: the target bounds what one learner can make
   * the platform generate; past it, the learner's own daily cap pays for on-demand questions.
   */
  private async needed(domain: string, difficulty: string, userId?: string): Promise<number> {
    const [{ n: total } = { n: 0 }] = await this.db.system(({ db }) =>
      db.select({ n: count() }).from(reasoningItems).where(and(eq(reasoningItems.pool, true), eq(reasoningItems.domain, domain), eq(reasoningItems.difficulty, difficulty))),
    );
    const headroom = Math.max(0, this.cfg.REASONING_POOL_TARGET - total);
    let need = headroom;
    if (userId) {
      const available = await this.availableFor(userId, domain, difficulty);
      need = Math.min(Math.max(need, this.cfg.REASONING_POOL_MIN_AVAILABLE - available), headroom);
    }
    return Math.min(need, this.cfg.REASONING_POOL_BATCH);
  }

  /** Pool questions in a bucket that this learner has not been served. */
  async availableFor(userId: string, domain: string, difficulty: string): Promise<number> {
    const [{ n } = { n: 0 }] = await this.db.system(({ db }) =>
      db
        .select({ n: count() })
        .from(reasoningItems)
        .where(
          and(
            eq(reasoningItems.pool, true),
            eq(reasoningItems.domain, domain),
            eq(reasoningItems.difficulty, difficulty),
            sql`NOT EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${userId})`,
          ),
        ),
    );
    return n;
  }

  /* ---------------- On demand: only when the pool has nothing left for this learner ---------------- */

  async runGeneration(attemptId: string): Promise<void> {
    const [a] = await this.db.system(({ db }) => db.select().from(reasoningAttempts).where(eq(reasoningAttempts.id, attemptId)));
    if (!a || a.state !== 'generating') return;
    const domain = getDomain(a.domain);
    if (!domain) return this.markFailed(attemptId, 'REASONING_DOMAIN_UNAVAILABLE');
    const difficulty = poolBucket(a.difficulty);
    const bank = await this.bankFor(a.domain, difficulty);
    // On demand for one learner: charged to that learner's daily cap, not the platform pool account.
    const r = await this.generateOne(domain, difficulty, bank, {
      sourceId: a.id,
      owner: { userId: a.userId, orgId: a.orgId },
      onTry: (n) => this.db.system(({ db }) => db.update(reasoningAttempts).set({ generationTries: n, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId))),
    });
    if (!r.ok) return this.markFailed(attemptId, r.code);
    // The new question joins the pool for everyone else, and is recorded as served to this learner.
    await this.db.system(async ({ db }) => {
      const [row] = await db.insert(reasoningItems).values(this.itemRow(r.item, r.model)).returning({ id: reasoningItems.id });
      await db.insert(reasoningServed).values({ orgId: a.orgId, userId: a.userId, itemId: row!.id, attemptId: a.id }).onConflictDoNothing();
      await db
        .update(reasoningAttempts)
        .set({ state: 'ready', itemId: row!.id, failureCode: null, failureStage: null, updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.id, attemptId), eq(reasoningAttempts.state, 'generating')));
    });
  }

  async markFailed(attemptId: string, code: string): Promise<void> {
    await this.db.system(({ db }) =>
      db
        .update(reasoningAttempts)
        .set({ state: 'generation_failed', failureCode: code, failureStage: 'generation', updatedAt: new Date() })
        .where(and(eq(reasoningAttempts.id, attemptId), eq(reasoningAttempts.state, 'generating'))),
    );
  }

  /* ---------------- Shared ---------------- */

  /** The bucket's recent pool questions: seeds to steer away from, texts to compare with. */
  private async bankFor(domain: string, difficulty: string): Promise<Bank> {
    const rows = await this.db.system(({ db }) =>
      db
        .select({ id: reasoningItems.id, fingerprint: reasoningItems.fingerprint, seed: reasoningItems.seed, public: reasoningItems.public })
        .from(reasoningItems)
        .where(and(eq(reasoningItems.pool, true), eq(reasoningItems.domain, domain), eq(reasoningItems.difficulty, difficulty)))
        .orderBy(desc(reasoningItems.createdAt))
        .limit(80),
    );
    return {
      seeds: rows.map((r) => r.seed as VariationSeed),
      texts: rows.map((r) => ({ id: r.id, fingerprint: r.fingerprint, text: comparableText(r.public as GeneratedItem['public']) })),
      avoid: rows.slice(0, 8).map((r) => ({ title: (r.public as GeneratedItem['public']).title, question: (r.public as GeneratedItem['public']).question })),
    };
  }

  /**
   * One validated question that is distinct from the bank. The similarity check and the bank update
   * run synchronously after each model call, so parallel generations in one batch also stay distinct.
   */
  private async generateOne(
    domain: ReasoningDomain,
    difficulty: ReasoningDifficulty,
    bank: Bank,
    opts: { sourceId?: string; firstSeed?: VariationSeed; owner?: { userId: string; orgId: string }; onTry?: (n: number) => Promise<unknown> },
  ): Promise<Generated> {
    const meta: CallMeta = opts.owner
      ? { feature: 'reasoning.generate', owner: opts.owner, sourceId: opts.sourceId, budget: 'reasoning' }
      : { feature: 'reasoning.generate', owner: { userId: POOL_USER_ID, orgId: POOL_ORG_ID }, sourceId: opts.sourceId, budget: 'pool' };
    let feedback: string[] = [];
    const used = new Set(bank.seeds.map(fingerprintOf));
    const started = Date.now();
    for (let tryNumber = 1; tryNumber <= this.cfg.REASONING_MAX_GENERATION_TRIES; tryNumber++) {
      const seed = tryNumber === 1 && opts.firstSeed ? opts.firstSeed : pickSeed(domain, bank.seeds, this.rng, used, difficulty);
      used.add(fingerprintOf(seed));
      await opts.onTry?.(tryNumber);

      let value: Awaited<ReturnType<typeof this.llm.structured<ReturnType<typeof generationSchema>['zod']['_output']>>>;
      try {
        value = await this.llm.structured(meta, generationRequest({ domain, seed, avoid: bank.avoid, previousFailure: feedback, tryNumber }), generationSchema());
      } catch (err) {
        if (err instanceof DomainError && TERMINAL_CODES.has(err.code)) return { ok: false, code: err.code, tries: tryNumber };
        if (err instanceof DomainError && err.code === 'LLM_OUTPUT_INVALID' && tryNumber < this.cfg.REASONING_MAX_GENERATION_TRIES) {
          emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'schema' });
          feedback = ['The previous output did not match the required JSON structure; follow the schema exactly.'];
          continue;
        }
        throw err; // provider outage or timeout: the queue retries the job
      }

      const { out, repairs } = normaliseGeneratorOutput(value.value, domain, seed);
      if (repairs.length) logger.info({ source_id: opts.sourceId, try: tryNumber, repairs }, 'generated item normalised');
      const validation = validateGeneratedItem(out, domain, seed);
      if (!validation.ok) {
        emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'validation' });
        // Validator messages name components and rules, never a learner; they are what operators tune the prompt with.
        logger.warn({ source_id: opts.sourceId, difficulty, try: tryNumber, errors: validation.errors.length, reasons: validation.errors.slice(0, 6).map((e) => e.slice(0, 200)) }, 'generated item rejected by validation');
        feedback = validation.errors.slice(0, 12);
        continue;
      }
      const objective = domain.variation.objectives.find((o) => o.id === seed.objective);
      const item = toGeneratedItem(out, domain, seed, normaliseWeights(objective?.weights, domain.weights));
      const text = comparableText(item.public);
      const sim = checkSimilarity({ fingerprint: item.fingerprint, text }, bank.texts, this.cfg.REASONING_SIMILARITY_THRESHOLD);
      if (sim.tooSimilar) {
        emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: 'similarity' });
        logger.warn({ source_id: opts.sourceId, try: tryNumber, similarity: sim.max, collision: sim.fingerprintCollision }, 'generated item too similar to a pool question');
        feedback = [`The item was too similar to an existing question (similarity ${sim.max}). Change the company, the components, the attack steps and the options.`];
        continue;
      }
      bank.texts.push({ id: `pending:${item.fingerprint}`, fingerprint: item.fingerprint, text });
      bank.seeds.push(seed);
      emitMetric('ReasoningGenerationMs', Date.now() - started, 'Milliseconds', { Domain: domain.key, Difficulty: difficulty });
      logger.info({ source_id: opts.sourceId, difficulty, tries: tryNumber, warnings: validation.warnings.length, similarity: sim.max }, 'reasoning item generated');
      return { ok: true, item, model: value.usage.model, tries: tryNumber };
    }
    emitMetric('ReasoningGenerationFailed', 1, 'Count', { Domain: domain.key });
    return { ok: false, code: 'REASONING_GENERATION_FAILED', tries: this.cfg.REASONING_MAX_GENERATION_TRIES };
  }

  private itemRow(item: GeneratedItem, model: string): typeof reasoningItems.$inferInsert {
    return {
      orgId: null,
      userId: null,
      pool: true,
      domain: item.public.domain,
      difficulty: item.public.difficulty,
      fingerprint: item.fingerprint,
      seed: item.seed,
      public: item.public,
      private: item.private,
      weights: item.weights,
      generatorVersion: GENERATOR_VERSION,
      promptVersion: GENERATION_PROMPT_VERSION,
      model,
      tier: 'LARGE',
    };
  }
}
