import { Inject, Injectable } from '@nestjs/common';
import type { DiagramData, ReasoningDifficulty, ReasoningDomainKey } from '@threatready/contracts';
import { reasoningAttempts, reasoningItems, reasoningServed } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database } from '../../platform/db/database.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import type { LlmObject, LlmTier } from '../../platform/ports/llm.port.js';
import { LlmService, refusalOf, type CallMeta } from '../ai/llm.service.js';
import { architectureShingles, architecturesFor, architectureText, getArchitecture, surfacesFor, type ArchitectureDef } from './architectures/index.js';
import { getDomain, registeredDomains } from './domains/index.js';
import { fingerprintOf, type ReasoningDomain, type VariationSeed } from './domain.types.js';
import type { GeneratedItem, LibraryGeneratorOutput } from './item.types.js';
import { evaluatorRequestBound, evaluatorTier } from './prompts/evaluation.prompts.js';
import { GENERATION_PROMPT_VERSION, GENERATOR_VERSION, questionRequest, questionSchema } from './prompts/generation.prompts.js';
import { normaliseWeights } from './scoring.js';
import { pickLibrarySeed, structureKeyOf, type Rng } from './seed.js';
import { checkLibrarySimilarity, comparableText, type LibraryBankEntry } from './similarity.js';
import { smallTierParams } from './small-tier.js';
import { normaliseLibraryOutput, toLibraryItem, validateLibraryItem } from './validation.js';

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

/** A line of the avoid list in the writer's prompt: a question already written on the architecture for the domain. */
interface AvoidLine {
  title: string;
  question: string;
  path: string;
  objective: string;
}

/**
 * What a generation compares against so the new question is distinct (design §3.6), for one bucket's
 * architectures. Pool refills read the live questions of the bucket and the latest
 * REASONING_LIBRARY_BANK_SIZE per architecture; an on-demand generation adds everything the learner had
 * on those architectures.
 */
interface Bank {
  /** The seeds the next ones spread away from: the bucket's live questions (pool) or the learner's own (on demand). */
  seeds: VariationSeed[];
  /** Fingerprints a new question must not share: live questions of the bucket, and on demand every question the learner was served. */
  fingerprints: Set<string>;
  /** Questions compared on attack path and wording. */
  entries: LibraryBankEntry[];
  /** Per architecture, the questions already written on it for this domain (newest first; the learner's first on demand). */
  avoid: Map<string, AvoidLine[]>;
  /** `<architecture>|<surface>|<objective>` of the structural entries (live, or the learner's), which the seed picker passes over (review AR-BIZ-2). */
  structures: Set<string>;
}

type Generated = { ok: true; item: GeneratedItem; model: string; tier: LlmTier; tries: number } | { ok: false; code: string; tries: number };

/** The labels along a stored diagram's attack path ("a > b > c"), for the avoid list. */
function pathLabels(d: DiagramData | undefined): string {
  if (!d?.attackPath?.length) return '';
  const label = new Map(d.nodes.map((n) => [n.id, n.label]));
  const edges = d.attackPath.map((id) => d.edges.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (!edges.length) return '';
  return [edges[0]!.from, ...edges.map((e) => e.to)].map((id) => label.get(id) ?? id).join(' > ');
}

/** What a warning is about, for the ReasoningGenerationWarning metric. */
const warningReason = (w: string) => (/follows no drawn flow/.test(w) ? 'non_adjacent_step' : /difficulty/.test(w) ? 'difficulty' : /advanced/.test(w) ? 'subtle_trust' : /consistency/.test(w) ? 'consistency' : 'other');

/**
 * Question generation (spec §2, §3; cost design 26 Oct 2026 §3). Questions live in a shared pool per
 * domain and difficulty: the refill job generates them ahead of time, several in parallel, so a learner
 * normally gets one instantly. Every question is written on one of the reviewed library architectures
 * (architectures/): the model writes the attack path on the architecture's components, a short
 * situation, the options and the answer key; code composes the diagram and the scenario. Each question
 * passes the quality gate (validation.ts) and the architecture-aware similarity check; the first try runs
 * on REASONING_GENERATION_FIRST_TIER (Haiku by default) and a rejected one is rewritten on LARGE with the
 * findings fed back, so a question costs at most REASONING_MAX_GENERATION_TRIES (2) billed calls. A
 * provider outage is left to the queue's retry policy; a budget stop ends the run with the reason.
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
  async refillPool(req: { domain?: string; difficulty?: string; userId?: string; max?: number } = {}): Promise<void> {
    if (!this.cfg.REASONING_POOL_ENABLED) return;
    const domains = req.domain ? [getDomain(req.domain)].filter((d): d is ReasoningDomain => Boolean(d)) : registeredDomains();
    // A learner-triggered refill carries the questions it reserved from the learner's daily allowance.
    const max = typeof req.max === 'number' && Number.isFinite(req.max) ? Math.max(0, Math.floor(req.max)) : undefined;
    for (const domain of domains) {
      const levels = req.difficulty ? POOL_DIFFICULTIES.filter((d) => d === poolBucket(req.difficulty!)) : POOL_DIFFICULTIES;
      for (const difficulty of levels) await this.refillBucket(domain, difficulty, req.userId, max);
    }
  }

  private async refillBucket(domain: ReasoningDomain, difficulty: ReasoningDifficulty, userId?: string, max?: number): Promise<void> {
    // One refill per bucket at a time across workers: a session-level advisory lock on a dedicated connection.
    const lockClient = await this.db.pool.connect();
    const key = `reasoning-pool:${domain.key}:${difficulty}`;
    try {
      const { rows } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 99)) AS ok', [key]);
      if (!rows[0]?.ok) return;
      try {
        const wanted = Math.min(await this.needed(domain.key, difficulty, userId), max ?? Number.POSITIVE_INFINITY);
        if (wanted <= 0) return;
        // Start only the ladders the pool's budget can finish (review COST-5): a first try whose rewrite
        // the cap would refuse is money spent for nothing, and a batch starts its ladders in parallel.
        const need = await this.affordableLadders(domain.key, difficulty, wanted);
        if (need <= 0) {
          logger.info({ bucket: key, requested: wanted }, 'reasoning pool refill skipped: the pool budget cannot finish a generation');
          return;
        }
        const started = Date.now();
        const bank = await this.bankFor(domain.key, difficulty);
        // Distinct seeds for the batch, chosen up front so parallel generations do not collide, and
        // spread over the bucket's architectures (the least-used architecture first). A refill a learner
        // triggered also stays off every fingerprint and attack structure that learner was served (review
        // AR-BIZ-11), so what it adds is servable to them.
        const archs = architecturesFor(domain.key, difficulty);
        const seeds: VariationSeed[] = [];
        const exclude = new Set(bank.fingerprints);
        if (userId) {
          const served = await this.servedBy(userId, domain.key, difficulty);
          const ids = new Set(served.map((x) => x.id));
          for (const x of served) {
            exclude.add(x.fingerprint);
            bank.fingerprints.add(x.fingerprint);
            if (x.seed.architecture) bank.structures.add(structureKeyOf(x.seed));
          }
          for (const e of bank.entries) if (ids.has(e.id)) e.structural = true;
        }
        for (let i = 0; i < need; i++) {
          const s = pickLibrarySeed(domain, difficulty, archs, [...bank.seeds, ...seeds], this.rng, exclude, bank.structures);
          exclude.add(fingerprintOf(s));
          bank.structures.add(structureKeyOf(s));
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
          await this.db.system(({ db }) => db.insert(reasoningItems).values(this.itemRow(r.item, r.model, r.tier)));
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
   * A question served REASONING_ITEM_MAX_SERVES times (2 by default) is retired (security patch 2, A5;
   * cost design §5): it no longer counts toward any of these sizes, so the refill backfills it. With
   * REASONING_SERVE_LEGACY_ITEMS=false, questions generated before the architecture library do not count either.
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

  /**
   * How many of `wanted` generation ladders the pool's daily cap and the breaker can pay for in full
   * (each at generationEstimateUsd, the whole ladder), checked without reserving (review COST-5).
   */
  private async affordableLadders(domainKey: string, difficulty: string, wanted: number): Promise<number> {
    const ladder = this.generationEstimateUsd(domainKey, difficulty);
    for (let k = wanted; k > 0; k--) {
      const ok = await this.llm.check(POOL_META, k * ladder).then(
        () => true,
        () => false,
      );
      if (ok) return k;
    }
    return 0;
  }

  /** Every question this learner was served in a bucket: its id, fingerprint and seed. */
  private async servedBy(userId: string, domain: string, difficulty: string): Promise<{ id: string; fingerprint: string; seed: VariationSeed }[]> {
    const { rows } = await this.db.system((tx) =>
      tx.sql.executeSql(`SELECT i.id, i.fingerprint, i.seed FROM reasoning_served s JOIN reasoning_items i ON i.id = s.item_id WHERE s.user_id = $1 AND i.domain = $2 AND i.difficulty = $3`, [userId, domain, difficulty]),
    );
    return rows as { id: string; fingerprint: string; seed: VariationSeed }[];
  }

  /** Questions a learner-triggered refill could still add to a bucket (it never grows one past the target). */
  async headroom(domain: string, difficulty: string): Promise<number> {
    return Math.max(0, this.cfg.REASONING_POOL_TARGET - (await this.demand(domain, difficulty)).total);
  }

  /**
   * A bucket's size in questions still in service (served fewer than REASONING_ITEM_MAX_SERVES times,
   * and servable: legacy questions only while REASONING_SERVE_LEGACY_ITEMS), whether it is in demand,
   * and how many of those questions are out of reach for the most-served of its recently active learners
   * (null when nobody was served from it in the demand window). Demand counts serves of retired
   * questions too: a bucket whose served questions all retired is still in use. Out of reach is what
   * ReasoningService.servable hides from them (review AR-BIZ-11): a live question they were served, or
   * one that shares a fingerprint, or an architecture, attack path and objective, with any question they
   * were ever served (retired ones included).
   */
  private async demand(domain: string, difficulty: string): Promise<{ total: number; mostSeen: number | null }> {
    const { rows } = await this.db.system((tx) =>
      tx.sql.executeSql(
        `WITH bucket AS (SELECT id, fingerprint, architecture_id, seed->'architecture'->>'pathKey' AS path_key, seed->>'objective' AS objective,
                                serve_count < $4 AND ($5 OR architecture_id IS NOT NULL) AS live
                         FROM reasoning_items WHERE pool AND domain = $1 AND difficulty = $2),
              active AS (SELECT DISTINCT s.user_id FROM reasoning_served s JOIN bucket b ON b.id = s.item_id WHERE s.served_at >= now() - make_interval(days => $3::int)),
              seen AS (SELECT s.user_id, j.id, j.fingerprint, j.architecture_id, j.seed->'architecture'->>'pathKey' AS path_key, j.seed->>'objective' AS objective
                       FROM reasoning_served s JOIN reasoning_items j ON j.id = s.item_id WHERE s.user_id IN (SELECT user_id FROM active))
         SELECT (SELECT count(*)::int FROM bucket WHERE live) AS total,
                (SELECT max((SELECT count(*) FROM bucket b WHERE b.live AND EXISTS (
                   SELECT 1 FROM seen x WHERE x.user_id = a.user_id
                     AND (x.id = b.id OR x.fingerprint = b.fingerprint OR (x.architecture_id = b.architecture_id AND x.path_key = b.path_key AND x.objective = b.objective)))))::int
                 FROM active a) AS most_seen`,
        [domain, difficulty, this.cfg.REASONING_POOL_DEMAND_DAYS, this.cfg.REASONING_ITEM_MAX_SERVES, this.cfg.REASONING_SERVE_LEGACY_ITEMS],
      ),
    );
    const r = rows[0] as { total: number | string; most_seen: number | string | null } | undefined;
    return { total: Number(r?.total ?? 0), mostSeen: r?.most_seen === null || r?.most_seen === undefined ? null : Number(r.most_seen) };
  }

  /**
   * The worst case of one generation for this bucket, for a budget check before it is queued: the
   * first try on REASONING_GENERATION_FIRST_TIER plus every later try on LARGE (the whole ladder), on the
   * bucket's largest architecture, so the pre-check admits only a generation the learner can afford to
   * finish. Estimates count the whole prompt (cached prefix included) and the full output allowance.
   */
  generationEstimateUsd(domainKey: string, difficulty: string): number {
    const domain = getDomain(domainKey);
    if (!domain) return 0;
    const bucket = poolBucket(difficulty);
    const archs = architecturesFor(domain.key, bucket);
    if (!archs.length) return 0;
    const arch = archs.reduce((a, b) => (architectureText(b).length > architectureText(a).length ? b : a));
    // A fixed seed keeps the estimate stable and the generator's random sequence untouched.
    const seed = pickLibrarySeed(domain, bucket, [arch], [], () => 0);
    const surface = surfacesFor(arch, domain.key).find((x) => x.id === seed.entryPoint)!;
    const small = smallTierParams(this.cfg, 'generation');
    const at = (tier: LlmTier) => this.llm.estimate(questionRequest({ arch, domain, seed, surface, tier, small, avoid: [], previousFailure: [], tryNumber: 1 }));
    const tries = this.cfg.REASONING_MAX_GENERATION_TRIES;
    return at(this.cfg.REASONING_GENERATION_FIRST_TIER) + (tries - 1) * at('LARGE');
  }

  /** What an on-demand generation leaves unspent of the learner's daily cap: room for one first-stage evaluation (on its tier and model). */
  evaluationRoomUsd(domainKey: string): number {
    const domain = getDomain(domainKey);
    return domain ? this.llm.estimate(evaluatorRequestBound(domain, null, undefined, evaluatorTier(this.cfg.REASONING_EVALUATION_MODE), smallTierParams(this.cfg, 'evaluation'))) : 0;
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
    // On demand for one learner: charged to that learner's daily cap, not the platform pool account,
    // and never into the room the evaluation of their answer will need (audit TR-08).
    const owner = { userId: a.userId, orgId: a.orgId };
    const keepFreeUsd = this.evaluationRoomUsd(a.domain);
    // The whole ladder must still fit when the job runs, not only when create() checked it: other
    // spend may have used the room since, and a first try whose rewrite is refused is wasted (review COST-5).
    const fits = await this.llm.check({ feature: 'reasoning.generate', owner, sourceId: a.id, budget: 'reasoning', keepFreeUsd }, this.generationEstimateUsd(a.domain, difficulty)).then(
      () => null,
      (err: unknown) => (err instanceof DomainError && TERMINAL_CODES.has(err.code) ? err.code : 'LLM_BUDGET_EXCEEDED'),
    );
    if (fits) return this.markFailed(attemptId, fits);
    const bank = await this.bankFor(a.domain, difficulty, a.userId);
    const r = await this.generateOne(domain, difficulty, bank, {
      sourceId: a.id,
      owner,
      keepFreeUsd,
      onTry: (n) => this.db.system(({ db }) => db.update(reasoningAttempts).set({ generationTries: n, updatedAt: new Date() }).where(eq(reasoningAttempts.id, attemptId))),
    });
    if (!r.ok) return this.markFailed(attemptId, r.code);
    // The new question joins the pool for everyone else, and is recorded as served to this learner (its
    // first serve: one seat is left under the 2-serve rule; the cap setting is not set here, so the
    // trigger only counts).
    await this.db.system(async ({ db }) => {
      const [row] = await db.insert(reasoningItems).values(this.itemRow(r.item, r.model, r.tier)).returning({ id: reasoningItems.id });
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
   * The similarity bank for a bucket (design §3.6), over the architectures that cover it: every live
   * question on them (any domain), the latest REASONING_LIBRARY_BANK_SIZE per architecture created in the
   * last REASONING_LIBRARY_BANK_DAYS (review AR-BIZ-2: by count alone the window of a saturated
   * architecture never moved) and, when
   * generating for one learner, every question that learner had on them (audit TR-59 carried over:
   * the learner's own history is always in the bank). Fingerprints that collide are the bucket's live
   * questions and, for a learner, everything they were served: retired questions are not obstacles for
   * the pool (they cannot be served again, and serving never gives a learner a fingerprint twice).
   */
  private async bankFor(domain: string, difficulty: string, userId?: string): Promise<Bank> {
    const archIds = architecturesFor(domain as ReasoningDomainKey, difficulty as ReasoningDifficulty).map((a) => a.id);
    const bank: Bank = { seeds: [], fingerprints: new Set(), entries: [], avoid: new Map(), structures: new Set() };
    if (!archIds.length) return bank;
    const { rows } = await this.db.system((tx) =>
      tx.sql.executeSql(
        `WITH x AS (
           SELECT i.*, row_number() OVER (PARTITION BY i.architecture_id ORDER BY i.created_at DESC) AS rn,
                  ($4::text IS NOT NULL AND (i.user_id = $4 OR EXISTS (SELECT 1 FROM reasoning_served s WHERE s.item_id = i.id AND s.user_id = $4))) AS mine
           FROM reasoning_items i WHERE i.architecture_id = ANY($1::text[]))
         SELECT id, domain, difficulty, fingerprint, seed, architecture_id, mine, (pool AND serve_count < $3) AS live,
                public->>'title' AS title, public->>'scenario' AS scenario, public->>'attackNarrative' AS narrative, public->>'question' AS question,
                public->'options' AS options, public->'diagram' AS diagram
         FROM x WHERE (rn <= $2 AND created_at >= now() - make_interval(days => $5::int)) OR (pool AND serve_count < $3) OR mine
         ORDER BY mine DESC, created_at DESC`,
        [archIds, this.cfg.REASONING_LIBRARY_BANK_SIZE, this.cfg.REASONING_ITEM_MAX_SERVES, userId ?? null, this.cfg.REASONING_LIBRARY_BANK_DAYS],
      ),
    );
    for (const raw of rows) {
      const r = raw as {
        id: string; domain: string; difficulty: string; fingerprint: string; seed: VariationSeed; architecture_id: string; mine: boolean; live: boolean;
        title: string; scenario: string; narrative: string; question: string; options: { text: string }[]; diagram: DiagramData;
      };
      const inBucket = r.domain === domain && r.difficulty === difficulty;
      if ((inBucket && r.live) || r.mine) bank.fingerprints.add(r.fingerprint);
      if (userId ? r.mine && r.domain === domain : inBucket && r.live) bank.seeds.push(r.seed);
      // Structure collisions only against live questions and the learner's own (review AR-BIZ-2): with
      // retired ones too, each architecture's window filled with paths no new question could take, for good.
      const structural = r.live || r.mine;
      bank.entries.push({
        id: r.id,
        archId: r.architecture_id,
        fingerprint: r.fingerprint,
        pathKey: r.seed.architecture?.pathKey ?? null,
        objective: r.seed.objective,
        structural,
        text: comparableText({ scenario: r.scenario ?? '', attackNarrative: r.narrative ?? '', question: r.question ?? '', options: r.options ?? [] }),
      });
      if (structural && r.seed.architecture) bank.structures.add(structureKeyOf(r.seed));
      if (r.domain === domain) {
        const lines = bank.avoid.get(r.architecture_id) ?? [];
        if (lines.length < 8) lines.push({ title: r.title, question: r.question, path: pathLabels(r.diagram), objective: r.seed.objective });
        bank.avoid.set(r.architecture_id, lines);
      }
    }
    return bank;
  }

  /** The next seed for this bucket, away from the bank's seeds, the fingerprints already used and the live structures. */
  private nextSeed(domain: ReasoningDomain, difficulty: ReasoningDifficulty, bank: Bank, used: ReadonlySet<string>): VariationSeed {
    return pickLibrarySeed(domain, difficulty, architecturesFor(domain.key, difficulty), bank.seeds, this.rng, used, bank.structures);
  }

  /**
   * One question that passes the quality gate and is distinct from the bank (design §3.5): try 1 on
   * REASONING_GENERATION_FIRST_TIER, every later try on LARGE with the gate's findings fed back (a fresh
   * seed when the rejection was a similarity or fingerprint collision). A schema failure or a refusal is
   * a gate failure: it is not repeated on the same tier (`retryInvalid: false`); a refusal (Haiku 5.5's
   * safety classifiers can decline an attack scenario) is counted with its category. The similarity check and
   * the bank update run synchronously after each model call, so parallel generations in one batch also
   * stay distinct. Every call is reserved and settled by LlmService, billed failures included.
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
    const maxTries = this.cfg.REASONING_MAX_GENERATION_TRIES;
    const used = new Set(bank.fingerprints);
    let seed = opts.firstSeed ?? this.nextSeed(domain, difficulty, bank, used);
    let feedback: string[] = [];
    const small = smallTierParams(this.cfg, 'generation');
    const started = Date.now();
    for (let tryNumber = 1; tryNumber <= maxTries; tryNumber++) {
      const tier: LlmTier = tryNumber === 1 ? this.cfg.REASONING_GENERATION_FIRST_TIER : 'LARGE';
      const model = this.llm.modelFor(tier, 'reasoning');
      used.add(fingerprintOf(seed));
      const arch: ArchitectureDef | undefined = getArchitecture(seed.topology);
      const surface = arch && surfacesFor(arch, domain.key).find((x) => x.id === seed.entryPoint);
      if (!arch || !surface) throw new Error(`generation seed names no library surface: ${seed.topology}/${seed.entryPoint}`);
      await opts.onTry?.(tryNumber);
      emitMetric('ReasoningGenerationAttempt', 1, 'Count', { Tier: tier, Model: model });
      const reject = (reason: string) => emitMetric('ReasoningGenerationRejected', 1, 'Count', { Reason: reason, Tier: tier, Model: model });

      let value: LlmObject<LibraryGeneratorOutput>;
      try {
        value = await this.llm.structured(
          meta,
          // Not marked for caching unless REASONING_PROMPT_CACHE: parallel seeds on different architectures and the tier switch mean nothing reads it back (review COST-2).
          { ...questionRequest({ arch, domain, seed, surface, tier, small, avoid: bank.avoid.get(arch.id) ?? [], previousFailure: feedback, tryNumber }), cache: this.cfg.REASONING_PROMPT_CACHE },
          questionSchema(arch, domain),
          { retryInvalid: false },
        );
      } catch (err) {
        if (err instanceof DomainError && TERMINAL_CODES.has(err.code)) return { ok: false, code: err.code, tries: tryNumber };
        const refusal = refusalOf(err);
        if (refusal) {
          // The model declined the scenario: billed (recorded by LlmService) and, like a gate failure, the
          // next try is LARGE; a refusal adds no finding to feed back.
          reject('refusal');
          emitMetric('ReasoningRefusal', 1, 'Count', { Stage: 'generation', Model: model, Category: refusal.category ?? 'unknown' });
          logger.warn({ source_id: opts.sourceId, difficulty, try: tryNumber, tier, model, architecture: arch.id, category: refusal.category }, 'question writer declined the request');
          continue;
        }
        if (err instanceof DomainError && err.code === 'LLM_OUTPUT_INVALID') {
          // Schema failure or truncation: billed (recorded by LlmService) and a gate failure.
          reject('schema');
          logger.warn({ source_id: opts.sourceId, difficulty, try: tryNumber, tier }, 'generated question failed the schema');
          feedback = ['The previous output did not match the required JSON structure or was cut off; follow the schema exactly, use only the listed component, origin and technique ids, and keep every field within its length.'];
          continue;
        }
        throw err; // provider outage or timeout: the queue retries the job
      }

      const { out, overlay, repairs } = normaliseLibraryOutput(value.value, arch, domain, seed);
      if (repairs.length) logger.info({ source_id: opts.sourceId, try: tryNumber, repairs }, 'generated question normalised');
      const check = validateLibraryItem(out, arch, domain, seed, overlay);
      for (const w of check.warnings) emitMetric('ReasoningGenerationWarning', 1, 'Count', { Reason: warningReason(w) });
      if (!check.ok) {
        reject('validation');
        // Gate messages name components and rules, never a learner; they are what operators tune the prompt with.
        logger.warn({ source_id: opts.sourceId, difficulty, try: tryNumber, tier, architecture: arch.id, errors: check.errors.length, reasons: check.errors.slice(0, 6).map((e) => e.slice(0, 200)) }, 'generated question rejected by the quality gate');
        feedback = check.errors.slice(0, 12);
        continue;
      }
      const objective = domain.variation.objectives.find((o) => o.id === seed.objective);
      const item = toLibraryItem(out, arch, domain, seed, normaliseWeights(objective?.weights, domain.weights), overlay);
      const text = comparableText(item.public);
      const key = item.seed.architecture!.pathKey!;
      const sim = checkLibrarySimilarity({ fingerprint: item.fingerprint, archId: arch.id, pathKey: key, objective: seed.objective, text }, bank, this.cfg.REASONING_SIMILARITY_THRESHOLD, architectureShingles(arch));
      if (sim.tooSimilar) {
        reject('similarity');
        logger.warn({ source_id: opts.sourceId, try: tryNumber, tier, architecture: arch.id, similarity: sim.max, collision: sim.fingerprintCollision, structure: sim.structureCollision }, 'generated question too similar to an existing one');
        feedback = [
          sim.structureCollision
            ? `A question with the same attack path and objective already exists on this architecture. Take a different path through the architecture and follow the new variation.`
            : `The question was too similar to one already written on this architecture (similarity ${sim.max}). Change the attack path, the situation, the evidence and the options; follow the new variation.`,
        ];
        if (tryNumber < maxTries) seed = this.nextSeed(domain, difficulty, bank, used);
        continue;
      }
      bank.entries.push({ id: `pending:${item.fingerprint}`, archId: arch.id, fingerprint: item.fingerprint, pathKey: key, objective: seed.objective, structural: true, text });
      bank.fingerprints.add(item.fingerprint);
      bank.structures.add(structureKeyOf(item.seed));
      bank.seeds.push(item.seed);
      const lines = bank.avoid.get(arch.id) ?? [];
      bank.avoid.set(arch.id, [{ title: item.public.title, question: item.public.question, path: pathLabels(item.public.diagram), objective: seed.objective }, ...lines].slice(0, 8));
      emitMetric('ReasoningGenerationStored', 1, 'Count', { Tier: tier, Model: model });
      emitMetric('ReasoningGenerationMs', Date.now() - started, 'Milliseconds', { Domain: domain.key, Difficulty: difficulty });
      logger.info({ source_id: opts.sourceId, difficulty, architecture: arch.id, tries: tryNumber, tier, model: value.usage.model, warnings: check.warnings.length, similarity: sim.max }, 'reasoning item generated');
      return { ok: true, item, model: value.usage.model, tier, tries: tryNumber };
    }
    emitMetric('ReasoningGenerationFailed', 1, 'Count', { Domain: domain.key });
    return { ok: false, code: 'REASONING_GENERATION_FAILED', tries: maxTries };
  }

  /** The stored row, with the tier and model of the call that produced the question and the architecture it was written on. */
  private itemRow(item: GeneratedItem, model: string, tier: LlmTier): typeof reasoningItems.$inferInsert {
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
      architectureId: item.architectureId ?? null,
      generatorVersion: GENERATOR_VERSION,
      promptVersion: GENERATION_PROMPT_VERSION,
      model,
      tier,
    };
  }
}
