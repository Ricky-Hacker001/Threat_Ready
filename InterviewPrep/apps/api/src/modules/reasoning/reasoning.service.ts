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
import { DomainError } from '@threatready/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, like, lt, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { cursorBefore, cursorOf } from '../../platform/http/cursor.js';
import { CACHE_PORT, type CachePort } from '../../platform/ports/cache.port.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { attemptView, ITEM_COLUMNS, loadEvaluation, loadItem, loadItemPrivate, loadOwnedAttempt, publicOf, transition, type AttemptRow } from './attempt.repo.js';
import { catalogue, getDomain, isAvailable } from './domains/index.js';
import { logger } from '../../platform/logging/logger.js';
import type { StoredFeedback } from './evaluation.service.js';
import { poolBucket } from './generation.service.js';
import { DIMENSION_KEYS, DIMENSION_LABELS, normaliseWeights } from './scoring.js';

const OPEN_STATES = ['generating', 'ready', 'evaluating'] as const;
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
  ) {}

  /**
   * The next question at the chosen difficulty. A random pool question this learner has never been
   * served is handed over at once and recorded as served, so it never comes back to them. Only when
   * the pool has nothing left for them is one generated on demand. Either way the bucket is topped up
   * in the background when the learner is running low.
   */
  async create(p: Principal, req: CreateReasoningAttemptRequest): Promise<ReasoningAttemptView> {
    if (!isAvailable(req.domain)) throw new DomainError('REASONING_DOMAIN_UNAVAILABLE');
    const difficulty = req.difficulty ?? getDomain(req.domain)!.difficulty;
    // The attempt keeps the requested difficulty (the contract value); the pool is read by bucket.
    const bucket = poolBucket(difficulty);
    const view = await this.db.user(p, async (tx) => {
      await tx.sql.executeSql('SELECT pg_advisory_xact_lock(hashtextextended($1, 17))', [p.userId]);
      await this.makeRoom(tx, p);
      const [picked] = await tx.db
        .select(ITEM_COLUMNS)
        .from(reasoningItems)
        .where(
          and(
            eq(reasoningItems.pool, true),
            eq(reasoningItems.domain, req.domain),
            eq(reasoningItems.difficulty, bucket),
            // Retired once enough learners have seen it: bounds how far one answer key travels (A5).
            lt(reasoningItems.serveCount, this.cfg.REASONING_ITEM_MAX_SERVES),
            sql`NOT EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${p.userId})`,
          ),
        )
        .orderBy(sql`random()`)
        .limit(1);
      if (picked) {
        const [a] = await tx.db
          .insert(reasoningAttempts)
          .values({ orgId: p.orgId, userId: p.userId, domain: req.domain, difficulty, state: 'ready', itemId: picked.id, openedAt: new Date() })
          .returning();
        await tx.db.insert(reasoningServed).values({ orgId: p.orgId, userId: p.userId, itemId: picked.id, attemptId: a!.id });
        return attemptView(a!, picked, null);
      }
      const { rows } = await tx.sql.executeSql('SELECT ai_spend_today_usd() AS total');
      if (Number((rows[0] as { total: string }).total) >= this.cfg.AI_GLOBAL_DAILY_CAP_USD) throw new DomainError('AI_SERVICE_PAUSED');
      const [a] = await tx.db.insert(reasoningAttempts).values({ orgId: p.orgId, userId: p.userId, domain: req.domain, difficulty, state: 'generating', openedAt: new Date() }).returning();
      await this.queue.enqueue(JOBS.reasoningGenerate, { kind: 'reasoning_generate', attemptId: a!.id }, { key: a!.id }, tx);
      return attemptView(a!, null, null);
    });
    await this.requestRefill(p.userId, req.domain, bucket);
    return view;
  }

  /** Ready pool questions this learner has not seen at this domain and difficulty; asks for a refill when low. */
  async poolStatus(p: Principal, req: CreateReasoningAttemptRequest): Promise<ReasoningPoolStatus> {
    if (!isAvailable(req.domain)) throw new DomainError('REASONING_DOMAIN_UNAVAILABLE');
    const difficulty = req.difficulty ?? getDomain(req.domain)!.difficulty;
    const bucket = poolBucket(difficulty);
    const available = await this.db.user(p, async (tx) => {
      const [{ n } = { n: 0 }] = await tx.db
        .select({ n: count() })
        .from(reasoningItems)
        .where(
          and(
            eq(reasoningItems.pool, true),
            eq(reasoningItems.domain, req.domain),
            eq(reasoningItems.difficulty, bucket),
            lt(reasoningItems.serveCount, this.cfg.REASONING_ITEM_MAX_SERVES),
            sql`NOT EXISTS (SELECT 1 FROM ${reasoningServed} s WHERE s.item_id = ${reasoningItems.id} AND s.user_id = ${p.userId})`,
          ),
        );
      return n;
    });
    let refilling = this.cfg.REASONING_POOL_ENABLED && available < this.cfg.REASONING_POOL_MIN_AVAILABLE;
    if (refilling) refilling = await this.requestRefill(p.userId, req.domain, bucket);
    return { domain: req.domain, difficulty, available, refilling };
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
    const today = await this.cache.incr(`rl:${userId}:reasoning_refill`, 86_400);
    if (today > this.cfg.REASONING_USER_DAILY_REFILLS) {
      if (today === this.cfg.REASONING_USER_DAILY_REFILLS + 1) logger.warn({ user_id: userId }, 'reasoning pool refill cap reached for today');
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
   * an already-submitted answer passes `own = 1` because that answer is itself in the count.
   */
  private async assertEvaluationQuota(tx: Tx, p: Principal, own = 0): Promise<void> {
    const dayStart = startOfUtcDay();
    const [{ n } = { n: 0 }] = await tx.db
      .select({ n: count() })
      .from(reasoningAttempts)
      .where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.submittedAt), gte(reasoningAttempts.submittedAt, dayStart)));
    if (n - own >= this.cfg.REASONING_USER_DAILY_EVALUATIONS) {
      throw new DomainError('LLM_BUDGET_EXCEEDED', { message: 'You have reached today’s evaluation limit; try again tomorrow', details: { scope: 'reasoning_day' } });
    }
  }

  /**
   * Opening a new question while at the open-attempt cap skips the oldest unanswered question (it
   * stays in history as Skipped and is never served again). Answers being evaluated are never touched.
   */
  private async makeRoom(tx: Tx, p: Principal): Promise<void> {
    const open = await tx.db
      .select({ id: reasoningAttempts.id, state: reasoningAttempts.state })
      .from(reasoningAttempts)
      .where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.openedAt), inArray(reasoningAttempts.state, [...OPEN_STATES])))
      .orderBy(reasoningAttempts.createdAt);
    let excess = open.length - this.cfg.REASONING_MAX_OPEN_ATTEMPTS + 1;
    for (const a of open) {
      if (excess <= 0) break;
      if (a.state !== 'ready') continue;
      await tx.db.update(reasoningAttempts).set({ state: 'abandoned', updatedAt: new Date(), version: sql`${reasoningAttempts.version} + 1` }).where(eq(reasoningAttempts.id, a.id));
      excess--;
    }
    if (excess > 0) throw new DomainError('REASONING_LIMIT_REACHED');
  }

  /** Skips an unanswered scenario. It leaves the open-attempt count and the history's scores. */
  async abandon(p: Principal, id: string): Promise<ReasoningAttemptView> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      if (a.state !== 'ready' && a.state !== 'generating' && a.state !== 'generation_failed') throw new DomainError('REASONING_INVALID_STATE');
      const next = await transition(tx, a, ['ready', 'generating', 'generation_failed'], { state: 'abandoned', openedAt: a.openedAt ?? new Date() });
      return attemptView(next, next.itemId ? await loadItem(tx, next.itemId) : null, null);
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
    return attemptView(a, item, ev);
  }

  async submit(p: Principal, id: string, req: SubmitReasoningRequest): Promise<ReasoningAttemptView> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      // Same submission again (retry after a lost response): the stored answer stands.
      if (a.clientSubmissionId === req.clientSubmissionId && a.state !== 'ready') return this.view(tx, p, id);
      if (a.state !== 'ready' || !a.itemId) throw new DomainError('REASONING_INVALID_STATE');
      const justification = req.justification.replace(/\s+/g, ' ').trim();
      if (justification.length < REASONING_LIMITS.justificationMinChars) throw new DomainError('REASONING_JUSTIFICATION_REQUIRED');
      const item = await loadItem(tx, a.itemId);
      if (!item || !publicOf(item).options.some((o) => o.id === req.selectedOption)) throw new DomainError('VALIDATION_FAILED', { details: [{ path: 'selectedOption', message: 'not one of the options' }] });
      await this.assertEvaluationQuota(tx, p);
      await transition(tx, a, ['ready'], {
        state: 'evaluating',
        selectedOption: req.selectedOption,
        justification: req.justification.trim(),
        clientSubmissionId: req.clientSubmissionId,
        submittedAt: new Date(),
      });
      await this.queue.enqueue(JOBS.reasoningEvaluate, { kind: 'reasoning_evaluate', attemptId: a.id }, { key: `${a.id}:${req.clientSubmissionId}` }, tx);
      return this.view(tx, p, id);
    });
  }

  /** Re-queues a failed stage. Idempotent: the job key carries the attempt version. */
  async retry(p: Principal, id: string): Promise<ReasoningAttemptView> {
    return this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id, true);
      if (a.state === 'generation_failed') {
        const next = await transition(tx, a, ['generation_failed'], { state: 'generating', failureCode: null, failureStage: null, generationTries: 0 });
        await this.queue.enqueue(JOBS.reasoningGenerate, { kind: 'reasoning_generate', attemptId: a.id }, { key: `${a.id}:retry:${next.version}` }, tx);
      } else if (a.state === 'evaluation_failed') {
        // A retry re-runs up to three LARGE calls: the same daily quota applies as to a submission.
        await this.assertEvaluationQuota(tx, p, a.submittedAt && a.submittedAt >= startOfUtcDay() ? 1 : 0);
        const next = await transition(tx, a, ['evaluation_failed'], { state: 'evaluating', failureCode: null, failureStage: null });
        await this.queue.enqueue(JOBS.reasoningEvaluate, { kind: 'reasoning_evaluate', attemptId: a.id }, { key: `${a.id}:retry:${next.version}` }, tx);
      } else throw new DomainError('REASONING_INVALID_STATE');
      return this.view(tx, p, id);
    });
  }

  /** The correct answer and the feedback exist only after the learner's own reasoning was evaluated. */
  async result(p: Principal, id: string): Promise<ReasoningResult> {
    const { a, item, ev } = await this.db.user(p, async (tx) => {
      const a = await loadOwnedAttempt(tx, p.userId, id);
      if (a.state !== 'evaluated' || !a.itemId) throw new DomainError('REASONING_INVALID_STATE', { message: 'The result is available once the evaluation has finished' });
      const [item, ev] = await Promise.all([loadItem(tx, a.itemId), loadEvaluation(tx, a.id)]);
      if (!item || !ev) throw new DomainError('REASONING_INVALID_STATE');
      return { a, item, ev };
    });
    // The answer key is read with the owner role, only after the learner's evaluated attempt on this
    // item was confirmed above: the API role cannot select the column at all (migration 0011).
    const priv = await this.db.system((tx) => loadItemPrivate(tx, item.id));
    if (!priv) throw new DomainError('REASONING_INVALID_STATE');
    const pub = publicOf(item);
    const stored = ev.feedback as StoredFeedback;
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
      evaluatedAt: ev.createdAt.toISOString(),
    };
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
        avg: sql<number | null>`avg(${reasoningEvaluations.totalScore})`.mapWith((v) => (v === null ? null : Math.round(Number(v)))),
        best: sql<number | null>`max(${reasoningEvaluations.totalScore})`.mapWith((v) => (v === null ? null : Number(v))),
        last: sql<Date | null>`max(${reasoningAttempts.createdAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
      })
      .from(reasoningAttempts)
      .leftJoin(reasoningEvaluations, eq(reasoningEvaluations.attemptId, reasoningAttempts.id))
      .where(and(eq(reasoningAttempts.userId, userId), isNotNull(reasoningAttempts.openedAt), sql`${reasoningAttempts.state} <> 'abandoned'`))
      .groupBy(reasoningAttempts.domain);
    return new Map(rows.map((r) => [r.domain, { attempts: r.attempts, evaluated: r.evaluated, averageScore: r.avg, bestScore: r.best, lastAttemptAt: r.last?.toISOString() ?? null }]));
  }

  async domains(p: Principal): Promise<ReasoningDomainView[]> {
    const stats = await this.db.user(p, (tx) => this.statsByDomain(tx, p.userId));
    const empty: ReasoningDomainStats = { attempts: 0, evaluated: 0, averageScore: null, bestScore: null, lastAttemptAt: null };
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
      const [{ n: total } = { n: 0 }] = await tx.db.select({ n: count() }).from(reasoningAttempts).where(and(eq(reasoningAttempts.userId, p.userId), isNotNull(reasoningAttempts.openedAt), sql`${reasoningAttempts.state} <> 'abandoned'`));
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
      const avg = evals.length ? Math.round(evals.reduce((n, e) => n + e.score, 0) / evals.length) : null;
      return {
        attempts: total,
        evaluated: evals.length,
        inProgress: open,
        averageScore: avg,
        bestScore: evals.length ? Math.max(...evals.map((e) => e.score)) : null,
        correctRate: evals.length ? Math.round((evals.filter((e) => e.correct).length / evals.length) * 100) / 100 : null,
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
        { label: 'Average score', value: dash.averageScore ?? '—', hint: 'Mean total score across evaluated attempts' },
        { label: 'Best score', value: dash.bestScore ?? '—' },
        { label: 'Correct decisions', value: dash.correctRate === null ? '—' : `${Math.round(dash.correctRate * 100)}%` },
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
