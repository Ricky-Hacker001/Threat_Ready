import { Inject, Injectable } from '@nestjs/common';
import type { AiUsageTotals, AppAiUsage, AppSummary } from '@threatready/contracts';
import { llmCallLog } from '@threatready/db';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { Database } from '../../platform/db/database.js';
import { SkillsService } from '../skills/skills.service.js';

const STATE_LABEL: Record<string, string> = {
  parsing: 'Preparing',
  profiled: 'Preparing',
  planned: 'Ready to start',
  asking: 'In progress',
  awaiting_answer: 'In progress',
  evaluating: 'In progress',
  paused: 'Paused',
  completed: 'Scoring',
  scoring: 'Scoring',
  report_ready: 'Report ready',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * Cost of a call: the settled cost when known; the reservation while the call is still in flight
 * (as the daily budget counts it); nothing for a call that failed before any tokens were billed.
 */
const COST = sql`COALESCE(${llmCallLog.costUsd}, CASE WHEN ${llmCallLog.status} = 'reserved' THEN ${llmCallLog.estimatedCostUsd} ELSE 0 END)`;

const totals = (r: Record<string, unknown>): AiUsageTotals => ({
  calls: Number(r.calls ?? 0),
  inputTokens: Number(r.input_tokens ?? 0),
  outputTokens: Number(r.output_tokens ?? 0),
  cacheReadTokens: Number(r.cache_read_tokens ?? 0),
  cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
  costUsd: Number(r.cost_usd ?? 0),
});

const add = (a: AiUsageTotals, b: AiUsageTotals): AiUsageTotals => ({
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd + b.costUsd,
});
const zero = (): AiUsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });

/**
 * What onboard.threatready.io shows about InterviewPrep: the learner's profile overview and the
 * admin console's token and cost figures. InterviewPrep keeps the detail (dashboard, history,
 * reports); these are summaries of the same persisted data.
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async summary(userId: string): Promise<AppSummary> {
    // Only userId is read on these paths; RLS scopes every query to it.
    const p = { userId } as Principal;
    const dash = await this.skills.dashboard(p);
    const usage = await this.db.user(p, async ({ db }) => {
      const [r] = await db
        .select({
          calls: sql<number>`count(*) filter (where ${llmCallLog.status} <> 'failed')`.mapWith(Number),
          input_tokens: sql<number>`coalesce(sum(${llmCallLog.inputTokens}), 0)`.mapWith(Number),
          output_tokens: sql<number>`coalesce(sum(${llmCallLog.outputTokens}), 0)`.mapWith(Number),
          cache_read_tokens: sql<number>`coalesce(sum(${llmCallLog.cacheReadTokens}), 0)`.mapWith(Number),
          cache_write_tokens: sql<number>`coalesce(sum(${llmCallLog.cacheWriteTokens}), 0)`.mapWith(Number),
          cost_usd: sql<number>`coalesce(sum(${COST}), 0)`.mapWith(Number),
        })
        .from(llmCallLog)
        .where(eq(llmCallLog.userId, userId));
      return totals(r ?? {});
    });

    const origin = this.cfg.APP_ORIGIN.replace(/\/+$/, '');
    const best = dash.scoreHistory.length ? Math.max(...dash.scoreHistory.map((s) => s.score)) : null;
    const last = dash.scoreHistory.at(-1)?.score ?? null;
    return {
      app: 'interview',
      stats: [
        { label: 'Interviews completed', value: dash.completedCount },
        { label: 'Average score', value: dash.averageScore ?? '—', hint: 'Mean overall score across scored interviews' },
        { label: 'Latest score', value: last ?? '—' },
        { label: 'Best score', value: best ?? '—' },
        { label: 'This month', value: `${dash.usage.interviewsThisMonth} / ${dash.usage.monthlyQuota}`, hint: 'Interviews started this month against the monthly quota' },
        { label: 'In progress', value: dash.resumable.length },
      ],
      items: dash.recent.slice(0, 10).map((s) => ({
        id: s.id,
        title: s.roleTitle ? `Mock interview: ${s.roleTitle}` : 'Mock interview',
        status: STATE_LABEL[s.state] ?? s.state,
        score: s.overallScore,
        at: s.createdAt,
        url: `${origin}/interview-prep/sessions/${s.id}${s.state === 'report_ready' ? '/report' : ''}`,
      })),
      aiUsage: usage,
    };
  }

  /** Every user's LLM usage in [from, to), optionally one user. Read through platform_llm_usage() (migration 0005). */
  async aiUsage(from: Date, to: Date, userId: string | null): Promise<AppAiUsage> {
    const rows = await this.db.system(async ({ sql: exec }) => {
      const r = await exec.executeSql('SELECT * FROM platform_llm_usage($1, $2, $3)', [from.toISOString(), to.toISOString(), userId]);
      return r.rows as Record<string, unknown>[];
    });

    const users = new Map<string, AiUsageTotals & { userId: string; lastCallAt: string | null }>();
    const byModel = new Map<string, AiUsageTotals & { model: string }>();
    const byFeature = new Map<string, AiUsageTotals & { feature: string }>();
    for (const r of rows) {
      const t = totals(r);
      const uid = String(r.user_id);
      const lastAt = r.last_call_at ? new Date(r.last_call_at as string).toISOString() : null;
      const u = users.get(uid) ?? { ...zero(), userId: uid, lastCallAt: null };
      users.set(uid, { ...add(u, t), userId: uid, lastCallAt: !u.lastCallAt || (lastAt && lastAt > u.lastCallAt) ? lastAt : u.lastCallAt });
      const model = String(r.model);
      byModel.set(model, { ...add(byModel.get(model) ?? zero(), t), model });
      const feature = String(r.feature);
      byFeature.set(feature, { ...add(byFeature.get(feature) ?? zero(), t), feature });
    }
    const byCost = <T extends AiUsageTotals>(a: T, b: T) => b.costUsd - a.costUsd;
    return {
      app: 'interview',
      users: [...users.values()].sort(byCost),
      byModel: [...byModel.values()].sort(byCost),
      byFeature: [...byFeature.values()].sort(byCost),
    };
  }
}
