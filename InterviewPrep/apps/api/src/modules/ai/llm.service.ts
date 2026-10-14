import { Inject, Injectable } from '@nestjs/common';
import { llmCallLog } from '@threatready/db';
import { DomainError, llmPortErrorToDomain, PortError } from '@threatready/shared';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Database, type Tx } from '../../platform/db/database.js';
import { emitMetric, logger, requestContext } from '../../platform/logging/logger.js';
import { LLM_PORT, type LlmObject, type LlmPort, type LlmRequest, type LlmUsage, type StructuredSchema } from '../../platform/ports/llm.port.js';
import { costUsd, estimateTokens } from './pricing.js';

/**
 * Which tier-3 limits apply (ADD L12, LLD-18):
 *  - new_interview: global breaker, user-day cap, session cap. Parsing and planning.
 *  - live_turn: user-day cap and the session cap minus the final-scoring reserve. Breaker ignored,
 *    so live interviews finish when new ones are paused.
 *  - finalize: final scoring. Only the prompt ceiling applies, so a session always gets its report.
 */
export type BudgetPolicy = 'new_interview' | 'live_turn' | 'finalize';

export interface CallMeta {
  feature: string;
  owner: { userId: string; orgId: string };
  sourceId?: string;
  budget: BudgetPolicy;
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
          return { result: r, usage: r.usage };
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
        return { result: r.text, usage: r.usage };
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
      await this.fail(reservation, meta, err, Date.now() - started);
      throw this.toDomain(err);
    }
  }

  private async metered<R>(meta: CallMeta, req: LlmRequest, call: () => Promise<{ result: R; usage: LlmUsage }>): Promise<R> {
    const reservation = await this.reserve(meta, req);
    const started = Date.now();
    try {
      const { result, usage } = await call();
      await this.settle(reservation, meta, req, usage, Date.now() - started);
      return result;
    } catch (err) {
      await this.fail(reservation, meta, err, Date.now() - started);
      throw err;
    }
  }

  private ledger<T>(owner: CallMeta['owner'], fn: (tx: Tx) => Promise<T>): Promise<T> {
    // The API writes its ledger rows under RLS as the user; the worker uses its own role.
    return process.env.APP_ROLE === 'worker' ? this.db.system(fn) : this.db.user(owner, fn);
  }

  /** Reserve estimated cost before the call (tier 3). Throws a DomainError when a cap is reached. */
  private async reserve(meta: CallMeta, req: LlmRequest): Promise<number> {
    const model = this.port.modelFor(req.tier);
    const pricing = this.cfg.pricing[model]!;
    const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = estimateTokens(promptChars);
    if (inputTokens > PROMPT_TOKEN_CEILING) {
      logger.error({ feature: meta.feature, inputTokens }, 'prompt exceeds the 100K token ceiling');
      throw new DomainError('LLM_OUTPUT_INVALID', { message: 'The request was too large to process' });
    }
    const estimate = costUsd(pricing, { inputTokens, outputTokens: req.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

    return this.ledger(meta.owner, async (tx) => {
      await tx.sql.executeSql('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [meta.owner.userId]);
      if (meta.budget !== 'finalize') {
        const spentToday = await this.sum(tx, sql`user_id = ${meta.owner.userId} AND created_at >= date_trunc('day', now())`);
        if (spentToday + estimate > this.cfg.AI_USER_DAILY_CAP_USD) throw new DomainError('LLM_BUDGET_EXCEEDED', { details: { scope: 'user_day' } });
        if (meta.sourceId) {
          const reserve = meta.budget === 'live_turn' || meta.budget === 'new_interview' ? this.cfg.AI_FINAL_SCORING_RESERVE_USD : 0;
          const spentSession = await this.sum(tx, sql`source_id = ${meta.sourceId}`);
          if (spentSession + estimate > this.cfg.AI_SESSION_CAP_USD - reserve) {
            throw new DomainError('LLM_BUDGET_EXCEEDED', { details: { scope: 'session' } });
          }
        }
      }
      if (meta.budget === 'new_interview') {
        const { rows } = await tx.sql.executeSql('SELECT ai_spend_today_usd() AS total');
        const global = Number((rows[0] as { total: string }).total);
        if (global >= this.cfg.AI_GLOBAL_DAILY_CAP_USD) {
          emitMetric('AiBreakerOpen', 1, 'Count');
          throw new DomainError('AI_SERVICE_PAUSED');
        }
        if (global >= 0.8 * this.cfg.AI_GLOBAL_DAILY_CAP_USD) logger.warn({ global_spend_usd: global }, 'daily AI spend above 80% of the breaker');
      }
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

  private async sum(tx: Tx, where: ReturnType<typeof sql>): Promise<number> {
    const [r] = await tx.db
      .select({ total: sql<string>`COALESCE(SUM(COALESCE(${llmCallLog.costUsd}, ${llmCallLog.estimatedCostUsd})), 0)` })
      .from(llmCallLog)
      .where(sql`${where} AND status <> 'failed'`);
    return Number(r?.total ?? 0);
  }

  private async settle(id: number, meta: CallMeta, req: LlmRequest, usage: LlmUsage, latencyMs: number): Promise<void> {
    const pricing = this.cfg.pricing[usage.model] ?? this.cfg.pricing[this.port.modelFor(req.tier)]!;
    const cost = costUsd(pricing, usage);
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

  private async fail(id: number, meta: CallMeta, err: unknown, latencyMs: number): Promise<void> {
    const kind = err instanceof PortError ? err.kind : err instanceof DomainError ? err.code : 'unknown';
    emitMetric('LlmErrors', 1, 'Count', { Kind: kind });
    // status=failed excludes the row from spend totals. Provider-side partial billing on a failed
    // call is rare and small; the provider's own monthly cap remains the backstop (L12).
    await this.ledger(meta.owner, (tx) =>
      tx.db.update(llmCallLog).set({ status: 'failed', errorKind: kind, latencyMs, settledAt: sql`now()` }).where(eq(llmCallLog.id, id)),
    ).catch((e: unknown) => logger.error({ err: { message: (e as Error).message } }, 'could not mark llm call failed'));
  }

  private toDomain(err: unknown): Error {
    if (err instanceof DomainError) return err;
    if (err instanceof PortError) return llmPortErrorToDomain(err);
    return err as Error;
  }
}
