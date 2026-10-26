import { Inject, Injectable } from '@nestjs/common';
import type { ReasoningDifficulty } from '@threatready/contracts';
import { reasoningAttempts, reasoningItems, reasoningServed } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { LlmService, type CallMeta } from '../ai/llm.service.js';
import { getDomain, registeredDomains } from './domains/index.js';
import { fingerprintOf, type ReasoningDomain, type VariationSeed } from './domain.types.js';
import type { GeneratedItem } from './item.types.js';
import { evaluatorRequestBound } from './prompts/evaluation.prompts.js';
import { GENERATION_PROMPT_VERSION, GENERATOR_VERSION, generationRequest, generationSchema } from './prompts/generation.prompts.js';
import { normaliseWeights } from './scoring.js';
import { pickSeed, type Rng } from './seed.js';
import { checkSimilarity, comparableText } from './similarity.js';
import { normaliseGeneratorOutput, toGeneratedItem, validateGeneratedItem } from './validation.js';

/** The platform account that owns pool generation in the AI ledger (migration 0009). */
export const POOL_USER_ID = 'threatready-reasoning-pool';
export const POOL_ORG_ID = '00000000-0000-4000-8000-0000000a11d0';
/** Pool generation's ledger entry: the platform account, on the pool's own daily cap. */
const POOL_META: CallMeta = { feature: 'reasoning.generate', owner: { userId: POOL_USER_ID, orgId: POOL_ORG_ID }, budget: 'pool' };
/** Difficulties the pool keeps a bucket for. */
export const POOL_DIFFICULTIES: readonly ReasoningDifficulty[] = ['beginner', 'intermediate', 'advanced'];

/**
 * The pool bucket a requested difficulty is served from. The contract also accepts 'expert', which
 * shares the 'advanced' bucket: without this every expert request missed the pool and queued a
 * 16k-token on-demand generation billed to the platform account (pool-budget DoS, audit §3.5). The
 * attempt records the bucket, so the difficulty shown is the difficulty served.
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
   * registered domain. How many a bucket gains is `needed()`; at most REASONING_POOL_BATCH per run,
   * generated in parallel. A no-op while the pool is disabled, including for jobs a persisted
   * schedule still enqueues.
   */
  async refillPool(req: { domain?: string; difficulty?: string; userId?: string } = {}): Promise<void> {
    if (!this.cfg.REASONING_POOL_ENABLED) return;
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
   * How many questions this bucket should gain now (demand-driven, audit TR-10):
   *  - a learner-triggered refill (`userId`) tops the bucket up to REASONING_POOL_TARGET, never past
   *    it, so one learner cycling through buckets cannot make the platform generate without bound;
   *  - the schedule keeps a bucket served in the last REASONING_POOL_DEMAND_DAYS at the target and any
   *    other bucket at REASONING_POOL_IDLE_TARGET. While one of a bucket's recently active learners has
   *    fewer than REASONING_POOL_MIN_AVAILABLE questions left unseen, it grows that bucket past the
   *    target, up to REASONING_POOL_MAX_ITEMS, on the pool budget. On-demand generation (billed to the
   *    learner) covers them until the next scheduled run.
   * A question served REASONING_ITEM_MAX_SERVES times is retired (security patch 2, A5): it no longer
   * counts toward any of these sizes, so the refill backfills it.
   */
  async needed(domain: string, difficulty: string, userId?: string): Promise<number> {
    if (!this.cfg.REASONING_POOL_ENABLED) return 0;
    const d = await this.demand(domain, difficulty);
    if (userId) return Math.min(Math.max(0, this.cfg.REASONING_POOL_TARGET - d.total), this.cfg.REASONING_POOL_BATCH);
    let need = Math.max(0, (d.mostSeen === null ? this.cfg.REASONING_POOL_IDLE_TARGET : this.cfg.REASONING_POOL_TARGET) - d.total);
    if (d.mostSeen !== null) {
      const shortfall = this.cfg.REASONING_POOL_MIN_AVAILABLE - (d.total - d.mostSeen);
      need = Math.max(need, Math.min(shortfall, this.cfg.REASONING_POOL_MAX_ITEMS - d.total));
    }
    return Math.min(need, this.cfg.REASONING_POOL_BATCH);
  }

  /** Questions a learner-triggered refill could still add to a bucket (it never grows one past the target). */
  async headroom(domain: string, difficulty: string): Promise<number> {
    return Math.max(0, this.cfg.REASONING_POOL_TARGET - (await this.demand(domain, difficulty)).total);
  }

  /**
   * A bucket's size in questions still in service (served fewer than REASONING_ITEM_MAX_SERVES times),
   * whether it is in demand, and how many of those questions the most-served of its recently active
   * learners has seen (null when nobody was served from it in the demand window). Demand counts serves
   * of retired questions too: a bucket whose served questions all retired is still in use.
   */
  private async demand(domain: string, difficulty: string): Promise<{ total: number; mostSeen: number | null }> {
    const { rows } = await this.db.system((tx) =>
      tx.sql.executeSql(
        `WITH bucket AS (SELECT id, serve_count < $4 AS live FROM reasoning_items WHERE pool AND domain = $1 AND difficulty = $2),
              active AS (SELECT DISTINCT s.user_id FROM reasoning_served s JOIN bucket b ON b.id = s.item_id WHERE s.served_at >= now() - make_interval(days => $3::int))
         SELECT (SELECT count(*)::int FROM bucket WHERE live) AS total,
                (SELECT max((SELECT count(*) FROM reasoning_served s JOIN bucket b ON b.id = s.item_id AND b.live WHERE s.user_id = a.user_id))::int FROM active a) AS most_seen`,
        [domain, difficulty, this.cfg.REASONING_POOL_DEMAND_DAYS, this.cfg.REASONING_ITEM_MAX_SERVES],
      ),
    );
    const r = rows[0] as { total: number | string; most_seen: number | string | null } | undefined;
    return { total: Number(r?.total ?? 0), mostSeen: r?.most_seen === null || r?.most_seen === undefined ? null : Number(r.most_seen) };
  }

  /** The cost of one on-demand generation call for this bucket, for a budget check before it is queued. */
  generationEstimateUsd(domainKey: string, difficulty: string): number {
    const domain = getDomain(domainKey);
    if (!domain) return 0;
    const bucket = poolBucket(difficulty);
    // Any seed gives a prompt of about the same size; a fixed one keeps the estimate stable and the generator's random sequence untouched.
    return this.llm.estimate(generationRequest({ domain, seed: pickSeed(domain, [], () => 0, new Set(), bucket), avoid: [], previousFailure: [], tryNumber: 1 }));
  }

  /** What an on-demand generation leaves unspent of the learner's daily cap: room for one first-stage evaluation. */
  evaluationRoomUsd(domainKey: string): number {
    const domain = getDomain(domainKey);
    return domain ? this.llm.estimate(evaluatorRequestBound(domain, null)) : 0;
  }

  /**
   * Whether the pool's daily cap and the global breaker still allow one generation for this bucket
   * today (checked without reserving). When they do not, no refill can arrive before the daily reset.
   */
  async poolCanGenerate(domainKey: string, difficulty: string): Promise<boolean> {
    return this.llm.check(POOL_META, this.generationEstimateUsd(domainKey, difficulty)).then(
      () => true,
      () => false,
    );
  }

  /* ---------------- On demand: only when the pool has nothing left for this learner ---------------- */

  async runGeneration(attemptId: string): Promise<void> {
    const [a] = await this.db.system(({ db }) => db.select().from(reasoningAttempts).where(eq(reasoningAttempts.id, attemptId)));
    if (!a || a.state !== 'generating') return;
    const domain = getDomain(a.domain);
    if (!domain) return this.markFailed(attemptId, 'REASONING_DOMAIN_UNAVAILABLE');
    const difficulty = poolBucket(a.difficulty);
    const bank = await this.bankFor(a.domain, difficulty, a.userId);
    // On demand for one learner: charged to that learner's daily cap, not the platform pool account,
    // and never into the room the evaluation of their answer will need (audit TR-08).
    const r = await this.generateOne(domain, difficulty, bank, {
      sourceId: a.id,
      owner: { userId: a.userId, orgId: a.orgId },
      keepFreeUsd: this.evaluationRoomUsd(a.domain),
      onTry: (n) => this.db.system(({ db }) => db.update(reasoningAttempts).set({ generationTries: n, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId))),
    });
    if (!r.ok) return this.markFailed(attemptId, r.code);
    // The new question joins the pool for everyone else, and is recorded as served to this learner.
    await this.db.system(async ({ db }) => {
      const [row] = await db.insert(reasoningItems).values(this.itemRow(r.item, r.model)).returning({ id: reasoningItems.id });
      await db.insert(reasoningServed).values({ orgId: a.orgId, userId: a.userId, itemId: row!.id, attemptId: a.id }).onConflictDoNothing();
      await db
        .update(reasoningAttempts)
        // Opened now: the question was not readable before, and answer time and expiry count from here.
        .set({ state: 'ready', itemId: row!.id, failureCode: null, failureStage: null, openedAt: new Date(), updatedAt: new Date() })
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

  /**
   * What a new question is compared with: the bucket's latest 80 pool questions (seeds to steer away
   * from, texts to compare), the domain's latest 40 at the other difficulties and, when generating for
   * one learner, every question that learner has had in the domain at any level (audit TR-59). The
   * extra texts are compared on wording only: the variation fingerprint does not include the
   * difficulty, so sharing one with another level is not a repeat.
   */
  private async bankFor(domain: string, difficulty: string, userId?: string): Promise<Bank> {
    const cols = { id: reasoningItems.id, fingerprint: reasoningItems.fingerprint, seed: reasoningItems.seed, public: reasoningItems.public };
    const { rows, others, seen } = await this.db.system(async ({ db }) => ({
      rows: await db
        .select(cols)
        .from(reasoningItems)
        .where(and(eq(reasoningItems.pool, true), eq(reasoningItems.domain, domain), eq(reasoningItems.difficulty, difficulty)))
        .orderBy(desc(reasoningItems.createdAt))
        .limit(80),
      others: await db
        .select(cols)
        .from(reasoningItems)
        .where(and(eq(reasoningItems.pool, true), eq(reasoningItems.domain, domain), ne(reasoningItems.difficulty, difficulty)))
        .orderBy(desc(reasoningItems.createdAt))
        .limit(40),
      seen: userId
        ? await db
            .select(cols)
            .from(reasoningItems)
            .where(and(eq(reasoningItems.domain, domain), sql`(${reasoningItems.userId} = ${userId} OR EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${userId}))`))
            .orderBy(desc(reasoningItems.createdAt))
            .limit(300)
        : [],
    }));
    const known = new Set(rows.map((r) => r.id));
    const extra = [...seen, ...others].filter((r) => !known.has(r.id) && Boolean(known.add(r.id)));
    return {
      seeds: rows.map((r) => r.seed as VariationSeed),
      texts: [
        ...rows.map((r) => ({ id: r.id, fingerprint: r.fingerprint, text: comparableText(r.public as GeneratedItem['public']) })),
        ...extra.map((r) => ({ id: r.id, fingerprint: '', text: comparableText(r.public as GeneratedItem['public']) })),
      ],
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
    opts: { sourceId?: string; firstSeed?: VariationSeed; owner?: { userId: string; orgId: string }; keepFreeUsd?: number; onTry?: (n: number) => Promise<unknown> },
  ): Promise<Generated> {
    const meta: CallMeta = opts.owner
      ? { feature: 'reasoning.generate', owner: opts.owner, sourceId: opts.sourceId, budget: 'reasoning', keepFreeUsd: opts.keepFreeUsd }
      : { ...POOL_META, sourceId: opts.sourceId };
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
