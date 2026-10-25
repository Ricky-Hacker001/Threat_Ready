import { Inject, Injectable } from '@nestjs/common';
import {
  REASONING_LIMITS,
  type AppSummary,
  type CreateReasoningAttemptRequest,
  type OptionId,
  type ReasoningAttemptList,
  type ReasoningAttemptSummary,
  type ReasoningAttemptView,
  type ReasoningDashboard,
  type ReasoningDomainStats,
  type ReasoningDomainView,
  type ReasoningPoolStatus,
  type ReasoningResult,
  type SubmitReasoningRequest,
} from '@threatready/contracts';
import { llmCallLog, reasoningAttempts, reasoningEvaluations, reasoningItems, reasoningServed } from '@threatready/db';
import { DomainError, secondsUntilUtcMidnight } from '@threatready/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, like, lt, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { LlmService, nextUtcDay, type CallMeta } from '../ai/llm.service.js';
import type { Principal } from '../../platform/authz/principal.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { cursorBefore, cursorOf } from '../../platform/http/cursor.js';
import { CACHE_PORT, type CachePort } from '../../platform/ports/cache.port.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { answerSecondsOf, attemptView, loadEvaluation, loadItem, loadOwnedAttempt, publicOf, readyDeadline, transition, type AttemptRow } from './attempt.repo.js';
import { catalogue, getDomain, isAvailable } from './domains/index.js';
import { logger } from '../../platform/logging/logger.js';
import type { GeneratedItem } from './item.types.js';
import { evaluationItemOf, type StoredFeedback } from './evaluation.service.js';
import { GenerationService, poolBucket } from './generation.service.js';
import { evaluatorRequest, evaluatorRequestBound } from './prompts/evaluation.prompts.js';
import { DIMENSION_KEYS, DIMENSION_LABELS, normaliseWeights } from './scoring.js';

const OPEN_STATES = ['generating', 'ready', 'evaluating'] as const;
/** Failures the budget caused: the failed run never reached the model, so retrying one is not counted. */
const BUDGET_CODES = new Set(['LLM_BUDGET_EXCEEDED', 'AI_SERVICE_PAUSED']);
/** Refusals of a submission that lift at 00:00 UTC: the daily evaluation quota and both AI budgets. */
const SUBMIT_REFUSALS = new Set([...BUDGET_CODES, 'REASONING_DAILY_LIMIT_REACHED']);
/**
 * Attempts that count in the statistics: everything opened except a skip of a question the learner
 * never saw (skipped while it was still being generated, or after generation failed). A skipped
 * question that was shown counts as answered with 0, so skipping hard questions cannot raise an
 * average (audit BIZ-09). The rule is not retroactive: a question opened before it (skip_counts
 * false, migration 0014) was skipped under the promise that a skip does not count, and still does not.
 */
const SKIPPED = sql`(${reasoningAttempts.state} = 'abandoned' AND ${reasoningAttempts.itemId} IS NOT NULL AND ${reasoningAttempts.skipCounts})`;
const COUNTED = sql`(${reasoningAttempts.state} <> 'abandoned' OR ${SKIPPED})`;
const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const STATE_LABEL: Record<string, string> = {
  generating: 'Generating scenario',
  ready: 'Ready to answer',
  evaluating: 'Evaluating',
  evaluated: 'Evaluated',
  generation_failed: 'Generation failed',
  evaluation_failed: 'Evaluation failed',
  abandoned: 'Skipped',
};

/**
 * Attack Reasoning API (ADD L17b, LLD-20). Every query is scoped to the principal with RLS below.
 * The answer key and rubric are read only to build the result after evaluation.
 */
@Injectable()
export class ReasoningService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(GenerationService) private readonly gen: GenerationService,
  ) {}

  /**
   * The next question at the chosen difficulty. A random pool question this learner has never been
   * served is handed over at once and recorded as served, so it never comes back to them. Only when
   * the pool has nothing left for them is one generated on demand. Either way the bucket is topped up
   * in the background when the learner is running low. A question is handed out only when its
   * evaluation fits the learner's budget, so the refusal comes before they write an answer (TR-08).
   */
  async create(p: Principal, req: CreateReasoningAttemptRequest): Promise<ReasoningAttemptView> {
    if (!isAvailable(req.domain)) throw new DomainError('REASONING_DOMAIN_UNAVAILABLE');
    const domain = getDomain(req.domain)!;
    // The attempt records the bucket it is served from: 'expert' shares 'advanced' and is shown as such.
    const bucket = poolBucket(req.difficulty ?? domain.difficulty);
    const view = await this.db.user(p, async (tx) => {
      await this.lockLearner(tx, p);
      await this.makeRoom(tx, p, req.skipOldest === true);
      const [picked] = await tx.db
        .select()
        .from(reasoningItems)
        .where(
          and(
            eq(reasoningItems.pool, true),
            eq(reasoningItems.domain, req.domain),
            eq(reasoningItems.difficulty, bucket),
            sql`NOT EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${p.userId})`,
          ),
        )
        .orderBy(sql`random()`)
        .limit(1);
      if (picked) {
        await this.budgetCheck(tx, this.metaFor(p, 'reasoning.evaluator'), this.llm.estimate(evaluatorRequestBound(domain, evaluationItemOf(picked))));
        const [a] = await tx.db
          .insert(reasoningAttempts)
          .values({ orgId: p.orgId, userId: p.userId, domain: req.domain, difficulty: bucket, state: 'ready', itemId: picked.id, openedAt: new Date() })
          .returning();
        await tx.db.insert(reasoningServed).values({ orgId: p.orgId, userId: p.userId, itemId: picked.id, attemptId: a!.id });
        return attemptView(a!, picked, null, this.cfg.REASONING_READY_TTL_HOURS);
      }
      // On demand: the learner pays for the generation, which must leave room for the evaluation.
      await this.budgetCheck(tx, this.generationMeta(p, req.domain), this.gen.generationEstimateUsd(req.domain, bucket));
      const [a] = await tx.db.insert(reasoningAttempts).values({ orgId: p.orgId, userId: p.userId, domain: req.domain, difficulty: bucket, state: 'generating', openedAt: new Date() }).returning();
      await this.queue.enqueue(JOBS.reasoningGenerate, { kind: 'reasoning_generate', attemptId: a!.id }, { key: a!.id }, tx);
      return attemptView(a!, null, null, this.cfg.REASONING_READY_TTL_HOURS);
    });
    await this.requestRefill(p.userId, req.domain, bucket);
    return view;
  }

  /** Ready pool questions this learner has not seen at this domain and difficulty; asks for a refill when low. */
  async poolStatus(p: Principal, req: CreateReasoningAttemptRequest): Promise<ReasoningPoolStatus> {
    if (!isAvailable(req.domain)) throw new DomainError('REASONING_DOMAIN_UNAVAILABLE');
    const bucket = poolBucket(req.difficulty ?? getDomain(req.domain)!.difficulty);
    const available = await this.db.user(p, async (tx) => {
      const [{ n } = { n: 0 }] = await tx.db
        .select({ n: count() })
        .from(reasoningItems)
        .where(
          and(
            eq(reasoningItems.pool, true),
            eq(reasoningItems.domain, req.domain),
            eq(reasoningItems.difficulty, bucket),
            sql`NOT EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${p.userId})`,
          ),
        );
      return n;
    });
    // `refilling` is true only when more questions will really appear without the learner starting
    // one: the pool's budget can still pay for a generation today, and a refill was queued (the bucket
    // is below its target) or the schedule will grow the bucket for its active learners. Otherwise the
    // next start generates on demand (audit AR-REG2).
    let refilling = false;
    if (this.cfg.REASONING_POOL_ENABLED && available < this.cfg.REASONING_POOL_MIN_AVAILABLE && (await this.gen.poolCanGenerate(req.domain, bucket))) {
      refilling = (await this.requestRefill(p.userId, req.domain, bucket)) || (await this.gen.needed(req.domain, bucket).catch(() => 0)) > 0;
    }
    return { domain: req.domain, difficulty: bucket, available, refilling };
  }

  private metaFor(p: Principal, feature: string): CallMeta {
    return { feature, owner: { userId: p.userId, orgId: p.orgId }, budget: 'reasoning' };
  }

  /** On-demand generation's budget: the learner's, minus the room one evaluation needs. */
  private generationMeta(p: Principal, domain: string): CallMeta {
    return { ...this.metaFor(p, 'reasoning.generate'), keepFreeUsd: this.gen.evaluationRoomUsd(domain) };
  }

  /**
   * The learner's daily cap and the global breaker, checked without reserving (the call reserves
   * again when it runs), inside the caller's transaction (it holds the learner's lock). Refusals carry
   * the reset time and Attack Reasoning wording.
   */
  private async budgetCheck(tx: Tx, meta: CallMeta, estimateUsd: number): Promise<void> {
    try {
      await this.llm.check(meta, estimateUsd, tx);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const opts = { details: err.details, retryAfterSec: err.retryAfterSec };
      if (err.code === 'AI_SERVICE_PAUSED') throw new DomainError('AI_SERVICE_PAUSED', { ...opts, message: 'Attack Reasoning is paused for the rest of the day (UTC): the platform’s daily AI budget is used up. Your answers are kept.' });
      if (err.code === 'LLM_BUDGET_EXCEEDED') throw new DomainError('LLM_BUDGET_EXCEEDED', { ...opts, message: 'You have reached today’s AI usage limit. It resets at 00:00 UTC; your answers are kept.' });
      throw err;
    }
  }

  /**
   * Background refill of one bucket. Deduplicated per bucket per minute and capped per learner per
   * day (REASONING_USER_DAILY_REFILLS), so cycling through domains and difficulties cannot make the
   * platform generate without bound; the schedule refills the rest. Never fails the caller.
   */
  private async requestRefill(userId: string, domain: string, difficulty: string): Promise<boolean> {
    if (!this.cfg.REASONING_POOL_ENABLED) return false;
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${domain}:${difficulty}:${userId}:${minute}`;
    if ((await this.cache.get<boolean>(`reasoning:refill:${key}`)) !== null) return true; // already asked this minute
    // A learner never grows a bucket past its target: at the target there is nothing to queue, and
    // asking must not use up the learner's daily refills.
    if ((await this.gen.headroom(domain, difficulty).catch(() => 0)) <= 0) return false;
    const cap = this.cfg.REASONING_USER_DAILY_REFILLS;
    const today = cap > 0 ? await this.cache.incr(`rl:${userId}:reasoning_refill`, 86_400) : 0;
    if (cap > 0 && today > cap) {
      if (today === cap + 1) logger.warn({ user_id: userId }, 'reasoning pool refill cap reached for today');
      return false;
    }
    await this.cache.set(`reasoning:refill:${key}`, true, 60);
    return this.queue
      .enqueue(JOBS.reasoningPoolRefill, { kind: 'reasoning_pool_refill', domain, difficulty, userId }, { key })
      .then(() => true)
      .catch((err: unknown) => {
        logger.warn({ err: { message: (err as Error).message } }, 'reasoning pool refill not queued');
        return false;
      });
  }

  /**
   * Answers submitted for evaluation today (UTC); each one costs up to three LARGE calls. A retry of
   * an already-submitted answer passes `own = 1` because that answer is itself in the count. Callers
   * hold the learner's advisory lock, so concurrent submissions cannot all pass (audit AR-REG3).
   * REASONING_USER_DAILY_EVALUATIONS=0 means no daily limit.
   */
  private async assertEvaluationQuota(tx: Tx, p: Principal, own = 0): Promise<void> {
    const limit = this.cfg.REASONING_USER_DAILY_EVALUATIONS;
    if (limit <= 0) return;
    const dayStart = startOfUtcDay();
    const [{ n } = { n: 0 }] = await tx.db
      .select({ n: count() })
      .from(reasoningAttempts)
      .where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.submittedAt), gte(reasoningAttempts.submittedAt, dayStart)));
    if (n - own >= limit) {
      throw new DomainError('REASONING_DAILY_LIMIT_REACHED', {
        message: `You have used today’s ${limit} evaluations. Your answer is kept; submit it after 00:00 UTC.`,
        details: { limit, resetAt: nextUtcDay().toISOString() },
        retryAfterSec: secondsUntilUtcMidnight(),
      });
    }
  }

  /** Serialises one learner's create, submit and retry (the open-attempt cap and the daily quota are counted under it). */
  private lockLearner(tx: Tx, p: Principal) {
    return tx.sql.executeSql('SELECT pg_advisory_xact_lock(hashtextextended($1, 17))', [p.userId]);
  }

  /**
   * Opening a new question while at the open-attempt cap skips the oldest unanswered question (it
   * stays in history as Skipped and is never served again). Answers being evaluated are never touched.
   * A skip that counts as 0 happens only when the learner confirmed it (`skipOldest`): otherwise the
   * start is refused with the question it would skip, so no question turns into a 0 unasked (audit BIZ-09).
   */
  private async makeRoom(tx: Tx, p: Principal, skipOldest: boolean): Promise<void> {
    const open = await tx.db
      .select({
        id: reasoningAttempts.id,
        state: reasoningAttempts.state,
        domain: reasoningAttempts.domain,
        difficulty: reasoningAttempts.difficulty,
        counts: sql<boolean>`(${reasoningAttempts.skipCounts} AND ${reasoningAttempts.itemId} IS NOT NULL)`,
        title: sql<string | null>`${reasoningItems.public}->>'title'`,
      })
      .from(reasoningAttempts)
      .leftJoin(reasoningItems, eq(reasoningItems.id, reasoningAttempts.itemId))
      .where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.openedAt), inArray(reasoningAttempts.state, [...OPEN_STATES])))
      .orderBy(reasoningAttempts.createdAt);
    let excess = open.length - this.cfg.REASONING_MAX_OPEN_ATTEMPTS + 1;
    const skip: typeof open = [];
    for (const a of open) {
      if (excess <= 0) break;
      if (a.state !== 'ready') continue;
      skip.push(a);
      excess--;
    }
    if (excess > 0) throw new DomainError('REASONING_LIMIT_REACHED');
    const counted = skip.find((a) => a.counts);
    if (counted && !skipOldest) {
      throw new DomainError('REASONING_SKIP_CONFIRMATION_REQUIRED', {
        message: `You have ${this.cfg.REASONING_MAX_OPEN_ATTEMPTS} unanswered questions open. Starting another skips the oldest${counted.title ? `, “${counted.title}”` : ''}, which counts as 0 in your averages.`,
        details: { attemptId: counted.id, title: counted.title, domain: counted.domain, difficulty: counted.difficulty, maxOpen: this.cfg.REASONING_MAX_OPEN_ATTEMPTS },
      });
    }
    for (const a of skip) {
      await tx.db.update(reasoningAttempts).set({ state: 'abandoned', updatedAt: new Date(), version: sql`${reasoningAttempts.version} + 1` }).where(eq(reasoningAttempts.id, a.id));
    }
  }

  /** Skips an unanswered scenario. It leaves the open-attempt count and the history's scores. */
  async abandon(p: Principal, id: string): Promise<ReasoningAttemptView> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      if (a.state !== 'ready' && a.state !== 'generating' && a.state !== 'generation_failed') throw new DomainError('REASONING_INVALID_STATE');
      const next = await transition(tx, a, ['ready', 'generating', 'generation_failed'], { state: 'abandoned', openedAt: a.openedAt ?? new Date() });
      return attemptView(next, next.itemId ? await loadItem(tx, next.itemId) : null, null, this.cfg.REASONING_READY_TTL_HOURS);
    });
  }

  async get(p: Principal, id: string): Promise<ReasoningAttemptView> {
    return this.db.user(p, (tx) => this.view(tx, p, id));
  }

  async stateOf(p: Principal, id: string): Promise<{ state: AttemptRow['state']; version: number }> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id);
      return { state: a.state, version: a.version };
    });
  }

  private async view(tx: Tx, p: Principal, id: string): Promise<ReasoningAttemptView> {
    const a = await loadOwnedAttempt(tx, p.userId, id);
    const item = a.itemId ? await loadItem(tx, a.itemId) : null;
    const ev = a.state === 'evaluated' ? await loadEvaluation(tx, a.id) : null;
    return attemptView(a, item, ev, this.cfg.REASONING_READY_TTL_HOURS);
  }

  /**
   * Accepts an answer only when it can be evaluated: the daily quota and the learner's budget are
   * checked first, so a refusal leaves the attempt open with the answer unsent (the client keeps the
   * draft) instead of accepting it and failing later (audit TR-08, AR-REG4). Such a refusal keeps the
   * question open past the reset (holdOpen), so it cannot expire into a counted 0 (audit final review BIZ-07).
   */
  async submit(p: Principal, id: string, req: SubmitReasoningRequest): Promise<ReasoningAttemptView> {
    const out = await this.db.user(p, async (tx): Promise<{ view: ReasoningAttemptView } | { refused: DomainError }> => {
      await this.lockLearner(tx, p);
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      // Same submission again (retry after a lost response): the stored answer stands.
      if (a.clientSubmissionId === req.clientSubmissionId && a.state !== 'ready') return { view: await this.view(tx, p, id) };
      if (a.state !== 'ready' || !a.itemId) throw new DomainError('REASONING_INVALID_STATE');
      const justification = req.justification.replace(/\s+/g, ' ').trim();
      if (justification.length < REASONING_LIMITS.justificationMinChars) throw new DomainError('REASONING_JUSTIFICATION_REQUIRED');
      const item = await loadItem(tx, a.itemId);
      if (!item || !(item.public as GeneratedItem['public']).options.some((o) => o.id === req.selectedOption)) throw new DomainError('VALIDATION_FAILED', { details: [{ path: 'selectedOption', message: 'not one of the options' }] });
      try {
        await this.assertEvaluationQuota(tx, p);
        await this.budgetCheck(tx, this.metaFor(p, 'reasoning.evaluator'), this.llm.estimate(evaluatorRequest(getDomain(a.domain)!, evaluationItemOf(item), req.selectedOption, req.justification.trim())));
      } catch (err) {
        // Returned, not thrown, so the transaction commits the extended deadline before the refusal is sent.
        if (err instanceof DomainError && SUBMIT_REFUSALS.has(err.code)) return { refused: await this.holdOpen(tx, a, err) };
        throw err;
      }
      await transition(tx, a, ['ready'], {
        state: 'evaluating',
        selectedOption: req.selectedOption,
        justification: req.justification.trim(),
        clientSubmissionId: req.clientSubmissionId,
        submittedAt: new Date(),
      });
      await this.queue.enqueue(JOBS.reasoningEvaluate, { kind: 'reasoning_evaluate', attemptId: a.id }, { key: `${a.id}:${req.clientSubmissionId}` }, tx);
      return { view: await this.view(tx, p, id) };
    });
    if ('refused' in out) throw out.refused;
    return out.view;
  }

  /**
   * A submission refused until 00:00 UTC (SUBMIT_REFUSALS) leaves the question open with the answer
   * unsent. The refusal is the platform's, so the first one while the question is open moves its
   * automatic skip to REASONING_READY_TTL_HOURS after the reset (readyDeadline; the sweep applies the
   * same rule), and the refusal tells the learner until when. Recorded once, so it cannot be renewed
   * day after day while the question's answer key circulates (TR-42).
   */
  private async holdOpen(tx: Tx, a: AttemptRow, refusal: DomainError): Promise<DomainError> {
    const ttl = this.cfg.REASONING_READY_TTL_HOURS;
    const now = new Date();
    let deadline = readyDeadline(a, ttl);
    if (!deadline || deadline <= now) return refusal;
    if (!a.submitRefusedAt) {
      await tx.db
        .update(reasoningAttempts)
        .set({ submitRefusedAt: now })
        .where(and(eq(reasoningAttempts.id, a.id), eq(reasoningAttempts.state, 'ready'), isNull(reasoningAttempts.submitRefusedAt)));
      deadline = readyDeadline({ openedAt: a.openedAt, submitRefusedAt: now }, ttl)!;
    }
    const expiresAt = deadline.toISOString();
    return new DomainError(refusal.code, {
      message: `${refusal.message} This question stays open until ${expiresAt.slice(0, 16).replace('T', ' ')} UTC.`,
      details: { ...(refusal.details as Record<string, unknown> | undefined), expiresAt },
      retryAfterSec: refusal.retryAfterSec,
    });
  }

  /**
   * Re-queues a failed stage. Idempotent: the job key carries the attempt version. Each stage can be
   * retried REASONING_MAX_RETRIES times per attempt (a retry after a budget refusal is free: that run
   * never reached the model), and only when the budget allows the run (audit TR-08).
   */
  async retry(p: Principal, id: string): Promise<ReasoningAttemptView> {
    return this.db.user(p, async (tx) => {
      await this.lockLearner(tx, p);
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      const max = this.cfg.REASONING_MAX_RETRIES;
      const counted = BUDGET_CODES.has(a.failureCode ?? '') ? 0 : 1;
      if (a.state === 'generation_failed') {
        if (counted && max > 0 && a.generationRetries >= max) throw new DomainError('REASONING_RETRY_LIMIT_REACHED');
        await this.budgetCheck(tx, this.generationMeta(p, a.domain), this.gen.generationEstimateUsd(a.domain, a.difficulty));
        const next = await transition(tx, a, ['generation_failed'], { state: 'generating', failureCode: null, failureStage: null, generationTries: 0, generationRetries: a.generationRetries + counted });
        await this.queue.enqueue(JOBS.reasoningGenerate, { kind: 'reasoning_generate', attemptId: a.id }, { key: `${a.id}:retry:${next.version}` }, tx);
      } else if (a.state === 'evaluation_failed') {
        if (counted && max > 0 && a.evaluationRetries >= max) throw new DomainError('REASONING_RETRY_LIMIT_REACHED', { message: 'This answer could not be evaluated after several retries. It stays in your history; start a new question to continue.' });
        // A retry re-runs up to three LARGE calls: the same daily quota applies as to a submission.
        await this.assertEvaluationQuota(tx, p, a.submittedAt && a.submittedAt >= startOfUtcDay() ? 1 : 0);
        const item = a.itemId ? await loadItem(tx, a.itemId) : null;
        if (item && a.selectedOption && a.justification) {
          await this.budgetCheck(tx, this.metaFor(p, 'reasoning.evaluator'), this.llm.estimate(evaluatorRequest(getDomain(a.domain)!, evaluationItemOf(item), a.selectedOption as OptionId, a.justification)));
        }
        const next = await transition(tx, a, ['evaluation_failed'], { state: 'evaluating', failureCode: null, failureStage: null, evaluationRetries: a.evaluationRetries + counted });
        await this.queue.enqueue(JOBS.reasoningEvaluate, { kind: 'reasoning_evaluate', attemptId: a.id }, { key: `${a.id}:retry:${next.version}` }, tx);
      } else throw new DomainError('REASONING_INVALID_STATE');
      return this.view(tx, p, id);
    });
  }

  /** The correct answer and the feedback exist only after the learner's own reasoning was evaluated. */
  async result(p: Principal, id: string): Promise<ReasoningResult> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id);
      if (a.state !== 'evaluated' || !a.itemId) throw new DomainError('REASONING_INVALID_STATE', { message: 'The result is available once the evaluation has finished' });
      const [item, ev] = await Promise.all([loadItem(tx, a.itemId), loadEvaluation(tx, a.id)]);
      if (!item || !ev) throw new DomainError('REASONING_INVALID_STATE');
      const pub = publicOf(item, a);
      const stored = ev.feedback as StoredFeedback;
      const priv = item.private as GeneratedItem['private'];
      return {
        attemptId: a.id,
        domain: pub.domain,
        totalScore: ev.totalScore,
        correct: ev.correct,
        selectedOption: a.selectedOption as OptionId,
        correctOption: priv.correctOption,
        options: stored.options,
        dimensions: ev.dimensions as ReasoningResult['dimensions'],
        feedback: stored.feedback,
        confidence: ev.confidence,
        reviewFlag: ev.reviewFlag,
        degraded: ev.degraded,
        notices: stored.notices,
        scoring: { version: ev.scoringVersion, weights: pub.weights, notes: stored.scoringNotes },
        techniques: pub.techniques,
        concepts: pub.concepts,
        answerSeconds: answerSecondsOf(a),
        evaluatedAt: ev.createdAt.toISOString(),
      };
    });
  }

  async list(p: Principal, cursor: string | undefined, limit = 20): Promise<ReasoningAttemptList> {
    return this.db.user(p, async (tx) => {
      const before = cursorBefore(cursor);
      const rows = await this.summaryRows(tx, p.userId, before, limit + 1);
      const last = rows[limit - 1];
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit && last ? cursorOf(last.createdAt) : null };
    });
  }

  private async summaryRows(tx: Tx, userId: string, before: Date | null, limit: number): Promise<ReasoningAttemptSummary[]> {
    const rows = await tx.db
      .select({ a: reasoningAttempts, title: sql<string | null>`${reasoningItems.public}->>'title'`, difficulty: reasoningItems.difficulty, score: reasoningEvaluations.totalScore, correct: reasoningEvaluations.correct, evaluatedAt: reasoningEvaluations.createdAt })
      .from(reasoningAttempts)
      .leftJoin(reasoningItems, eq(reasoningItems.id, reasoningAttempts.itemId))
      .leftJoin(reasoningEvaluations, eq(reasoningEvaluations.attemptId, reasoningAttempts.id))
      .where(and(eq(reasoningAttempts.userId, userId), isNotNull(reasoningAttempts.openedAt), before ? lt(reasoningAttempts.createdAt, before) : undefined))
      .orderBy(desc(reasoningAttempts.createdAt))
      .limit(limit);
    return rows.map(({ a, title, difficulty, score, correct, evaluatedAt }) => ({
      id: a.id,
      domain: a.domain as ReasoningAttemptSummary['domain'],
      state: a.state,
      title: title ?? null,
      difficulty: ((difficulty ?? a.difficulty) as ReasoningAttemptSummary['difficulty']) ?? null,
      totalScore: score ?? null,
      correct: correct ?? null,
      countsAsZero: a.state === 'abandoned' && a.itemId !== null && a.skipCounts,
      createdAt: a.createdAt.toISOString(),
      evaluatedAt: evaluatedAt?.toISOString() ?? null,
    }));
  }

  private async statsByDomain(tx: Tx, userId: string): Promise<Map<string, ReasoningDomainStats>> {
    const rows = await tx.db
      .select({
        domain: reasoningAttempts.domain,
        attempts: count(),
        evaluated: sql<number>`count(${reasoningEvaluations.id})`.mapWith(Number),
        skipped: sql<number>`count(*) filter (where ${SKIPPED})`.mapWith(Number),
        sum: sql<number>`coalesce(sum(${reasoningEvaluations.totalScore}), 0)`.mapWith(Number),
        best: sql<number | null>`max(${reasoningEvaluations.totalScore})`.mapWith((v) => (v === null ? null : Number(v))),
        last: sql<Date | null>`max(${reasoningAttempts.createdAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
      })
      .from(reasoningAttempts)
      .leftJoin(reasoningEvaluations, eq(reasoningEvaluations.attemptId, reasoningAttempts.id))
      .where(and(eq(reasoningAttempts.userId, userId), isNotNull(reasoningAttempts.openedAt), COUNTED))
      .groupBy(reasoningAttempts.domain);
    return new Map(
      rows.map((r) => [r.domain, { attempts: r.attempts, evaluated: r.evaluated, skipped: r.skipped, averageScore: fairAverage(r.sum, r.evaluated, r.skipped), bestScore: r.best, lastAttemptAt: r.last?.toISOString() ?? null }]),
    );
  }

  async domains(p: Principal): Promise<ReasoningDomainView[]> {
    const stats = await this.db.user(p, (tx) => this.statsByDomain(tx, p.userId));
    const empty: ReasoningDomainStats = { attempts: 0, evaluated: 0, skipped: 0, averageScore: null, bestScore: null, lastAttemptAt: null };
    return catalogue().map((c) => {
      const d = getDomain(c.key);
      return {
        key: c.key,
        title: c.title,
        description: d?.description ?? c.description,
        track: c.track,
        available: c.available,
        difficulty: d?.difficulty ?? null,
        focus: d?.focus ?? [],
        techniques: d?.techniques.slice(0, 8) ?? [],
        weights: d ? normaliseWeights(d.weights) : null,
        stats: stats.get(c.key) ?? empty,
      };
    });
  }

  /** Progress and performance analytics from persisted evaluations only. */
  async dashboard(p: Principal): Promise<ReasoningDashboard> {
    return this.db.user(p, async (tx) => {
      const evals = await tx.db
        .select({ id: reasoningEvaluations.attemptId, score: reasoningEvaluations.totalScore, correct: reasoningEvaluations.correct, dims: reasoningEvaluations.dimensions, at: reasoningEvaluations.createdAt })
        .from(reasoningEvaluations)
        .where(eq(reasoningEvaluations.userId, p.userId))
        .orderBy(desc(reasoningEvaluations.createdAt))
        .limit(200);
      const [totals = { all: 0, skipped: 0 }] = await tx.db
        .select({ all: count(), skipped: sql<number>`count(*) filter (where ${SKIPPED})`.mapWith(Number) })
        .from(reasoningAttempts)
        .where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.openedAt), COUNTED));
      const [agg = { n: 0, sum: 0, correct: 0, best: null }] = await tx.db
        .select({
          n: count(),
          sum: sql<number>`coalesce(sum(${reasoningEvaluations.totalScore}), 0)`.mapWith(Number),
          correct: sql<number>`count(*) filter (where ${reasoningEvaluations.correct})`.mapWith(Number),
          best: sql<number | null>`max(${reasoningEvaluations.totalScore})`.mapWith((v) => (v === null ? null : Number(v))),
        })
        .from(reasoningEvaluations)
        .where(eq(reasoningEvaluations.userId, p.userId));
      const [{ n: open } = { n: 0 }] = await tx.db.select({ n: count() }).from(reasoningAttempts).where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.openedAt), inArray(reasoningAttempts.state, [...OPEN_STATES])));
      const recent = await this.summaryRows(tx, p.userId, null, 8);
      const stats = await this.statsByDomain(tx, p.userId);
      const sums: Record<string, { v: number; w: number; n: number }> = {};
      for (const e of evals) {
        for (const d of e.dims as { key: string; weight: number; score: number }[]) {
          const s = (sums[d.key] ??= { v: 0, w: 0, n: 0 });
          s.v += d.weight > 0 ? (d.score / d.weight) * 100 : 0;
          s.n += 1;
          s.w = d.weight;
        }
      }
      // Skipped questions count as answered with 0 and as not correct (audit BIZ-09).
      const counted = agg.n + totals.skipped;
      return {
        attempts: totals.all,
        evaluated: agg.n,
        skipped: totals.skipped,
        inProgress: open,
        averageScore: fairAverage(agg.sum, agg.n, totals.skipped),
        bestScore: agg.n ? agg.best : null,
        correctRate: counted ? Math.round((agg.correct / counted) * 100) / 100 : null,
        dimensionAverages: DIMENSION_KEYS.map((key) => ({ key, label: DIMENSION_LABELS[key], average: sums[key] ? Math.round(sums[key]!.v / sums[key]!.n) : null, weight: sums[key]?.w ?? normaliseWeights(null)[key] })),
        scoreHistory: [...evals].reverse().slice(-20).map((e) => ({ attemptId: e.id, score: e.score, correct: e.correct, evaluatedAt: e.at.toISOString() })),
        recent,
        byDomain: catalogue()
          .filter((c) => stats.has(c.key))
          .map((c) => ({ domain: c.key, title: c.title, stats: stats.get(c.key)! })),
      };
    });
  }

  /** What onboard shows on the profile overview and the admin console for the Attack Reasoning app. */
  async platformSummary(userId: string, appOrigin: string): Promise<AppSummary & { app: 'reasoning' }> {
    const p = { userId } as Principal;
    const dash = await this.dashboard(p);
    const usage = await this.db.user(p, async ({ db }) => {
      const cost = sql`COALESCE(${llmCallLog.costUsd}, CASE WHEN ${llmCallLog.status} = 'reserved' THEN ${llmCallLog.estimatedCostUsd} ELSE 0 END)`;
      const [r] = await db
        .select({
          calls: sql<number>`count(*) filter (where ${llmCallLog.status} <> 'failed')`.mapWith(Number),
          inputTokens: sql<number>`coalesce(sum(${llmCallLog.inputTokens}), 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(sum(${llmCallLog.outputTokens}), 0)`.mapWith(Number),
          cacheReadTokens: sql<number>`coalesce(sum(${llmCallLog.cacheReadTokens}), 0)`.mapWith(Number),
          cacheWriteTokens: sql<number>`coalesce(sum(${llmCallLog.cacheWriteTokens}), 0)`.mapWith(Number),
          costUsd: sql<number>`coalesce(sum(${cost}), 0)`.mapWith(Number),
        })
        .from(llmCallLog)
        .where(and(eq(llmCallLog.userId, userId), like(llmCallLog.feature, 'reasoning.%')));
      return r ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    });
    const origin = appOrigin.replace(/\/+$/, '');
    return {
      app: 'reasoning',
      stats: [
        { label: 'Assessments completed', value: dash.evaluated },
        { label: 'Average score', value: dash.averageScore ?? '—', hint: 'Mean total score; skipped questions count as 0' },
        { label: 'Best score', value: dash.bestScore ?? '—' },
        { label: 'Correct decisions', value: dash.correctRate === null ? '—' : `${Math.round(dash.correctRate * 100)}%`, hint: 'Share of answered and skipped questions decided correctly' },
        { label: 'Skipped', value: dash.skipped, hint: 'Questions shown but not answered; each counts as 0' },
        { label: 'In progress', value: dash.inProgress },
      ],
      items: dash.recent.slice(0, 10).map((s) => ({
        id: s.id,
        title: s.title ? `${s.title}` : `Attack Reasoning: ${STATE_LABEL[s.state] ?? s.state}`,
        status: STATE_LABEL[s.state] ?? s.state,
        score: s.totalScore,
        at: s.createdAt,
        url: `${origin}/attempts/${s.id}`,
      })),
      aiUsage: usage,
    };
  }
}

/** Mean score where every skipped question counts as 0; null before anything was answered or skipped. */
function fairAverage(sum: number, evaluated: number, skipped: number): number | null {
  return evaluated + skipped > 0 ? Math.round(sum / (evaluated + skipped)) : null;
}
