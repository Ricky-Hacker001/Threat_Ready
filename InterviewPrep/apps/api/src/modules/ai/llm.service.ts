import { Inject, Injectable } from '@nestjs/common';
import { llmCallLog } from '@threatready/db';
import { DomainError, llmPortErrorToDomain, PortError, secondsUntilUtcMidnight } from '@threatready/shared';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { emitMetric, logger, requestContext } from '../../platform/logging/logger.js';
import { LLM_PORT, type LlmObject, type LlmPort, type LlmRequest, type LlmUsage, type StructuredSchema } from '../../platform/ports/llm.port.js';
import { costUsd, estimateTokens } from './pricing.js';

/**
 * Which tier-3 limits apply (ADD L12, LLD-18):
 *  - new_interview: global breaker, user-day cap, session cap. Parsing and planning.
 *  - live_turn: user-day cap and the session cap minus the final-scoring reserve, plus the global
 *    breaker at 100% (the turn ends the interview gracefully on LLM_BUDGET_EXCEEDED).
 *  - finalize: final scoring and the later stages of a reasoning evaluation. No user or session cap,
 *    so a session that was allowed to start gets its report; the global breaker still applies with a
 *    10% grace (BREAKER_GRACE) so work already in flight completes while nothing new starts, and
 *    AI_FINALIZE_SOURCE_CAP_USD bounds one feature's spend on one session or attempt across retries.
 *  - reasoning: the first stage of a reasoning evaluation and on-demand question generation for a
 *    learner. User-day cap and the global breaker; no session cap (attempts are not sessions).
 *    On-demand generation passes `keepFreeUsd` so it never spends the room an evaluation needs.
 *  - pool: platform-owned question pool. Its own daily cap and the global breaker.
 * `check()` runs the same tests without reserving, so a service can refuse work before the learner
 * commits to it (opens a question, writes an answer) instead of failing it afterwards.
 */
export type BudgetPolicy = 'new_interview' | 'live_turn' | 'finalize' | 'reasoning' | 'pool';

/** Finalize-class work may run until the global spend reaches this multiple of the daily cap. */
const BREAKER_GRACE = 1.1;

export interface CallMeta {
  feature: string;
  owner: { userId: string; orgId: string };
  sourceId?: string;
  budget: BudgetPolicy;
  /**
   * Part of the user's daily cap this call must leave unspent. On-demand reasoning generation keeps
   * room for the first evaluation stage, so generating questions cannot lock a learner out of having
   * an answer they already wrote evaluated (audit TR-08).
   */
  keepFreeUsd?: number;
  /** Finalize only: spend support added to this source's AI_FINALIZE_SOURCE_CAP_USD (scripts/retry-report.ts --reset). */
  extraSourceCapUsd?: number;
}

/** Every daily budget (user, pool, breaker) restarts at 00:00 UTC. */
export function nextUtcDay(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

const PROMPT_TOKEN_CEILING = 100_000;

@Injectable()
export class LlmService {
  constructor(
    @Inject(LLM_PORT) private readonly port: LlmPort,
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  modelFor(tier: LlmRequest['tier']): string {
    return this.port.modelFor(tier);
  }

  /** Structured call with one retry on a schema failure (L17b convention reused for interviews). */
  async structured<T>(meta: CallMeta, req: LlmRequest, schema: StructuredSchema<T>): Promise<LlmObject<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.metered(meta, req, async () => {
          const r = await this.port.generateStructured(req, schema);
          return { result: r, usage: r.usage, extraUsage: r.extraUsage };
        });
      } catch (err) {
        if (attempt === 0 && err instanceof PortError && err.kind === 'invalid_output') {
          logger.warn({ feature: meta.feature, schema: schema.name }, 'structured output invalid; retrying once');
          continue;
        }
        throw this.toDomain(err);
      }
    }
  }

  async text(meta: CallMeta, req: LlmRequest): Promise<string> {
    try {
      return await this.metered(meta, req, async () => {
        const r = await this.port.generate(req);
        return { result: r.text, usage: r.usage, extraUsage: r.extraUsage };
      });
    } catch (err) {
      throw this.toDomain(err);
    }
  }

  /** Streams text chunks; settles the ledger when the stream ends or fails. */
  async *stream(meta: CallMeta, req: LlmRequest): AsyncIterable<string> {
    const reservation = await this.reserve(meta, req);
    const started = Date.now();
    let firstTokenAt: number | null = null;
    try {
      for await (const chunk of this.port.stream(req)) {
        if (chunk.type === 'text') {
          firstTokenAt ??= Date.now();
          yield chunk.text;
        } else {
          await this.settle(reservation, meta, req, chunk.usage, Date.now() - started);
        }
      }
      if (firstTokenAt) emitMetric('QuestionTimeToFirstTokenMs', firstTokenAt - started, 'Milliseconds', { Feature: meta.feature });
    } catch (err) {
      await this.fail(reservation, meta, req, err, Date.now() - started);
      throw this.toDomain(err);
    }
  }

  private async metered<R>(meta: CallMeta, req: LlmRequest, call: () => Promise<{ result: R; usage: LlmUsage; extraUsage?: LlmUsage[] }>): Promise<R> {
    const reservation = await this.reserve(meta, req);
    const started = Date.now();
    try {
      const { result, usage, extraUsage } = await call();
      await this.settle(reservation, meta, req, usage, Date.now() - started);
      if (extraUsage?.length) await this.recordExtra(meta, req, extraUsage);
      return result;
    } catch (err) {
      await this.fail(reservation, meta, req, err, Date.now() - started);
      throw err;
    }
  }

  /**
   * The provider reports dated ids for aliases (claude-haiku-4-5-20251001): price by the exact id, then
   * without the date suffix, then the tier's configured model; never another tier's (cheaper) price.
   */
  priceOf(model: string, tier: LlmRequest['tier']) {
    return this.cfg.pricing[model] ?? this.cfg.pricing[model.replace(/-\d{8}$/, '')] ?? this.cfg.pricing[this.port.modelFor(tier)]!;
  }

  /** Earlier billed messages of one call (a refused first try before the fallback answered): one failed row each, with its cost. */
  private async recordExtra(meta: CallMeta, req: LlmRequest, extra: LlmUsage[]): Promise<void> {
    await this.ledger(meta.owner, async (tx) => {
      for (const u of extra) {
        await tx.db.insert(llmCallLog).values({
          orgId: meta.owner.orgId,
          userId: meta.owner.userId,
          feature: meta.feature,
          sourceId: meta.sourceId,
          tier: req.tier,
          model: u.model,
          promptVersion: req.promptVersion,
          status: 'failed',
          errorKind: 'refusal',
          estimatedCostUsd: '0',
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          costUsd: costUsd(this.priceOf(u.model, req.tier), u).toFixed(6),
          settledAt: sql`now()`,
          requestId: requestContext.getStore()?.requestId,
        });
      }
    }).catch((e: unknown) => logger.error({ err: { message: (e as Error).message } }, 'could not record a refused message'));
  }

  private ledger<T>(owner: CallMeta['owner'], fn: (tx: Tx) => Promise<T>): Promise<T> {
    // The API writes its ledger rows under RLS as the user; the worker uses its own role.
    return process.env.APP_ROLE === 'worker' ? this.db.system(fn) : this.db.user(owner, fn);
  }

  /** Estimated cost of a call before it runs: the prompt at about 3 characters per token plus the whole output allowance. */
  estimate(req: LlmRequest, meta?: Pick<CallMeta, 'feature'>): number {
    const pricing = this.cfg.pricing[this.port.modelFor(req.tier)]!;
    const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = estimateTokens(promptChars);
    if (inputTokens > PROMPT_TOKEN_CEILING) {
      logger.error({ feature: meta?.feature, inputTokens }, 'prompt exceeds the 100K token ceiling');
      throw new DomainError('LLM_OUTPUT_INVALID', { message: 'The request was too large to process' });
    }
    return costUsd(pricing, { inputTokens, outputTokens: req.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }

  /**
   * The caps and the breaker a reservation of `estimateUsd` under `meta` would meet, without
   * reserving anything: throws the same DomainError the call itself would. Lets a service refuse new
   * work (a question opened, an answer submitted) with a clear 429/503 before the learner commits to it.
   * Pass the caller's transaction when it holds locks: a second connection taken while holding one
   * could wait on the pool behind requests that are waiting for that lock.
   */
  async check(meta: CallMeta, estimateUsd: number, tx?: Tx): Promise<void> {
    if (tx) return this.assertWithinBudget(tx, meta, estimateUsd, false);
    await this.ledger(meta.owner, (t) => this.assertWithinBudget(t, meta, estimateUsd, false));
  }

  /** Reserve estimated cost before the call (tier 3). Throws a DomainError when a cap is reached. */
  private async reserve(meta: CallMeta, req: LlmRequest): Promise<number> {
    const model = this.port.modelFor(req.tier);
    const estimate = this.estimate(req, meta);

    return this.ledger(meta.owner, async (tx) => {
      await tx.sql.executeSql('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [meta.owner.userId]);
      await this.assertWithinBudget(tx, meta, estimate, true);
      const [row] = await tx.db
        .insert(llmCallLog)
        .values({
          orgId: meta.owner.orgId,
          userId: meta.owner.userId,
          feature: meta.feature,
          sourceId: meta.sourceId,
          tier: req.tier,
          model,
          promptVersion: req.promptVersion,
          status: 'reserved',
          estimatedCostUsd: estimate.toFixed(6),
          requestId: requestContext.getStore()?.requestId,
        })
        .returning({ id: llmCallLog.id });
      return row!.id;
    });
  }

  /** The policy checks shared by reserve() and check(). */
  private async assertWithinBudget(tx: Tx, meta: CallMeta, estimate: number, reserving: boolean): Promise<void> {
    // Daily refusals say when the day resets (details.resetAt, and Retry-After through retryAfterSec).
    const day = (scope: string) => ({ retryAfterSec: secondsUntilUtcMidnight(), details: { scope, resetAt: nextUtcDay().toISOString() } });
    if (meta.budget === 'pool') {
      // Platform-owned question pool: its own daily cap instead of a learner's caps.
      const spentToday = await this.sum(tx, sql`user_id = ${meta.owner.userId} AND created_at >= date_trunc('day', now())`);
      if (spentToday + estimate > this.cfg.REASONING_POOL_DAILY_CAP_USD) throw new DomainError('LLM_BUDGET_EXCEEDED', day('pool_day'));
    } else if (meta.budget !== 'finalize') {
      const spentToday = await this.sum(tx, sql`user_id = ${meta.owner.userId} AND created_at >= date_trunc('day', now())`);
      if (spentToday + estimate > this.cfg.AI_USER_DAILY_CAP_USD - (meta.keepFreeUsd ?? 0)) throw new DomainError('LLM_BUDGET_EXCEEDED', day('user_day'));
      // Reasoning attempts are not interview sessions: the user-day cap and the attempt quota bound them.
      if (meta.sourceId && meta.budget !== 'reasoning') {
        const reserve = meta.budget === 'live_turn' || meta.budget === 'new_interview' ? this.cfg.AI_FINAL_SCORING_RESERVE_USD : 0;
        const spentSession = await this.sum(tx, sql`source_id = ${meta.sourceId}`);
        if (spentSession + estimate > this.cfg.AI_SESSION_CAP_USD - reserve) {
          throw new DomainError('LLM_BUDGET_EXCEEDED', { details: { scope: 'session' } });
        }
      }
    } else if (meta.sourceId && this.cfg.AI_FINALIZE_SOURCE_CAP_USD > 0) {
      // Finalize skips the user's caps so admitted work completes, but every retry of a report re-runs
      // its LARGE batches: one feature's spend on one session or attempt is bounded across all retries
      // (audit TR-08 IP-07). Terminal: callers stop instead of retrying (scope finalize_source).
      const spentSource = await this.sum(tx, sql`source_id = ${meta.sourceId} AND feature = ${meta.feature}`);
      if (spentSource + estimate > this.cfg.AI_FINALIZE_SOURCE_CAP_USD + (meta.extraSourceCapUsd ?? 0)) {
        throw new DomainError('LLM_BUDGET_EXCEEDED', { details: { scope: 'finalize_source' } });
      }
    }
    // The global breaker applies to every policy. New work (new_interview, pool, reasoning) stops at
    // the cap with AI_SERVICE_PAUSED; live turns stop at the cap with LLM_BUDGET_EXCEEDED (the turn
    // completes the interview); finalize-class work gets BREAKER_GRACE so sessions already in
    // 'evaluating' or 'scoring' can finish, then it stops too (audit 2026-10-15 §3.5).
    const { rows } = await tx.sql.executeSql('SELECT ai_spend_today_usd() AS total');
    const global = Number((rows[0] as { total: string }).total);
    const limit = meta.budget === 'finalize' ? BREAKER_GRACE * this.cfg.AI_GLOBAL_DAILY_CAP_USD : this.cfg.AI_GLOBAL_DAILY_CAP_USD;
    if (global >= limit) {
      if (reserving) emitMetric('AiBreakerOpen', 1, 'Count');
      if (meta.budget === 'live_turn' || meta.budget === 'finalize') throw new DomainError('LLM_BUDGET_EXCEEDED', day('global_day'));
      throw new DomainError('AI_SERVICE_PAUSED', day('global_day'));
    }
    if (reserving && global >= 0.8 * this.cfg.AI_GLOBAL_DAILY_CAP_USD) logger.warn({ global_spend_usd: global }, 'daily AI spend above 80% of the breaker');
  }

  /**
   * Spend = settled cost, or the reservation while a call is in flight, or the real cost of a call
   * that failed after the provider billed it (truncated, schema-invalid, timed out after tokens).
   * Only a failure with no usage is free. Same rule as ai_spend_today_usd() (migration 0010).
   */
  private async sum(tx: Tx, where: ReturnType<typeof sql>): Promise<number> {
    const [r] = await tx.db
      .select({ total: sql<string>`COALESCE(SUM(COALESCE(${llmCallLog.costUsd}, ${llmCallLog.estimatedCostUsd})), 0)` })
      .from(llmCallLog)
      .where(sql`${where} AND (status <> 'failed' OR ${llmCallLog.costUsd} IS NOT NULL)`);
    return Number(r?.total ?? 0);
  }

  private async settle(id: number, meta: CallMeta, req: LlmRequest, usage: LlmUsage, latencyMs: number): Promise<void> {
    const cost = costUsd(this.priceOf(usage.model, req.tier), usage);
    await this.ledger(meta.owner, (tx) =>
      tx.db
        .update(llmCallLog)
        .set({
          status: 'settled',
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: cost.toFixed(6),
          latencyMs,
          settledAt: sql`now()`,
        })
        .where(eq(llmCallLog.id, id)),
    );
    emitMetric('LlmLatencyMs', latencyMs, 'Milliseconds', { Feature: meta.feature, Tier: req.tier });
    emitMetric('LlmCostMicroUsd', Math.round(cost * 1e6), 'None', { Feature: meta.feature, Tier: req.tier });
    logger.info(
      { feature: meta.feature, tier: req.tier, model: usage.model, in: usage.inputTokens, out: usage.outputTokens, cache_read: usage.cacheReadTokens, cost_usd: cost, ms: latencyMs },
      'llm call settled',
    );
  }

  private async fail(id: number, meta: CallMeta, req: LlmRequest, err: unknown, latencyMs: number): Promise<void> {
    const kind = err instanceof PortError ? err.kind : err instanceof DomainError ? err.code : 'unknown';
    emitMetric('LlmErrors', 1, 'Count', { Kind: kind });
    // A failed call the provider still billed (truncated at max_tokens, schema-invalid output, a stream
    // cut off part-way) carries its usage on the error: record the real cost so every budget sum and
    // admin total includes it. Only a failure with no usage (nothing reached the model) leaves cost null.
    const usage = billedUsage(err);
    const cost = usage ? costUsd(this.priceOf(usage.model, req.tier), usage) : null;
    if (cost !== null) emitMetric('LlmBilledFailureMicroUsd', Math.round(cost * 1e6), 'None', { Feature: meta.feature });
    await this.ledger(meta.owner, (tx) =>
      tx.db
        .update(llmCallLog)
        .set({
          status: 'failed',
          errorKind: kind,
          latencyMs,
          settledAt: sql`now()`,
          ...(usage && cost !== null
            ? { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, costUsd: cost.toFixed(6) }
            : {}),
        })
        .where(eq(llmCallLog.id, id)),
    ).catch((e: unknown) => logger.error({ err: { message: (e as Error).message } }, 'could not mark llm call failed'));
    const extra = (err as { extraUsage?: unknown } | null)?.extraUsage;
    if (Array.isArray(extra) && extra.length) await this.recordExtra(meta, req, extra.map((u) => billedUsage({ usage: u })).filter((u): u is LlmUsage => u !== null));
  }

  private toDomain(err: unknown): Error {
    if (err instanceof DomainError) return err;
    if (err instanceof PortError) return llmPortErrorToDomain(err);
    return err as Error;
  }
}

/** The provider usage an adapter attached to a failed call (see `withUsage` in the LLM port). */
function billedUsage(err: unknown): LlmUsage | null {
  const u = (err as { usage?: Partial<LlmUsage> } | null)?.usage;
  if (!u || typeof u.model !== 'string' || typeof u.inputTokens !== 'number' || typeof u.outputTokens !== 'number') return null;
  if (u.inputTokens + u.outputTokens <= 0) return null;
  return { model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0 };
}
