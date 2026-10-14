import { Inject, Injectable } from '@nestjs/common';
import { RESUMABLE_STATES, type InterviewDashboard, type SkillProgress } from '@threatready/contracts';
import { evaluations, interviewSessions, memberships, skillEvidence, skillScores, skills } from '@threatready/db';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { countsTowardQuota } from '../interview/quota.js';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import type { Principal } from '../../platform/authz/principal.js';
import { Database } from '../../platform/db/database.js';
import { analysisOf } from '../interview/analysis.service.js';

/** Recency half-life for skill scores: evidence from 60 days ago counts half. */
const HALF_LIFE_DAYS = 60;

/**
 * Skill graph (ADD §6 skills). Written only by evidence events; InterviewPrep writes interview
 * evidence, and the same tables receive lab and Attack Reasoning evidence.
 */
@Injectable()
export class SkillsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Worker: recompute skill_scores for a user from all evidence, weighted by recency. */
  async recalculate(userId: string): Promise<void> {
    await this.db.system(async ({ db }) => {
      const [m] = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
      if (!m) return;
      const rows = await db.select().from(skillEvidence).where(eq(skillEvidence.userId, userId));
      const now = Date.now();
      const agg = new Map<string, { num: number; den: number; n: number; last: Date }>();
      for (const e of rows) {
        const ageDays = (now - e.createdAt.getTime()) / 86_400_000;
        const w = Number(e.weight) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
        const a = agg.get(e.skillId) ?? { num: 0, den: 0, n: 0, last: e.createdAt };
        a.num += e.score * w;
        a.den += w;
        a.n += 1;
        if (e.createdAt > a.last) a.last = e.createdAt;
        agg.set(e.skillId, a);
      }
      for (const [skillId, a] of agg) {
        const score = Math.round(a.den > 0 ? a.num / a.den : 0);
        await db
          .insert(skillScores)
          .values({ userId, skillId, orgId: m.orgId, score, evidenceCount: a.n, lastEvidenceAt: a.last })
          .onConflictDoUpdate({
            target: [skillScores.userId, skillScores.skillId],
            set: { score, evidenceCount: a.n, lastEvidenceAt: a.last, computedAt: sql`now()` },
          });
      }
    });
  }

  async mySkills(p: Principal): Promise<SkillProgress[]> {
    return this.db.user(p, async ({ db }) => {
      const rows = await db
        .select({ s: skillScores, label: skills.label, category: skills.category })
        .from(skillScores)
        .innerJoin(skills, eq(skills.id, skillScores.skillId))
        .where(eq(skillScores.userId, p.userId))
        .orderBy(desc(skillScores.score));
      return rows.map(({ s, label, category }) => ({
        skillId: s.skillId,
        label,
        category,
        score: s.score,
        evidenceCount: s.evidenceCount,
        lastEvidenceAt: s.lastEvidenceAt.toISOString(),
      }));
    });
  }

  /** Dashboard from persisted data only; empty states when nothing exists yet. */
  async dashboard(p: Principal): Promise<InterviewDashboard> {
    const mine = await this.mySkills(p);
    return this.db.user(p, async ({ db }) => {
      const scored = await db
        .select({ sessionId: evaluations.sessionId, score: evaluations.overallScore, at: evaluations.createdAt })
        .from(evaluations)
        .where(eq(evaluations.userId, p.userId))
        .orderBy(asc(evaluations.createdAt));
      const sessions = await db
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.userId, p.userId))
        .orderBy(desc(interviewSessions.updatedAt))
        .limit(40);
      const scoreBySession = new Map(scored.map((s) => [s.sessionId, s.score]));
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const [{ n: thisMonth } = { n: 0 }] = await db
        .select({ n: count() })
        .from(interviewSessions)
        .where(and(eq(interviewSessions.userId, p.userId), gte(interviewSessions.createdAt, monthStart), countsTowardQuota));
      const resumable = sessions.filter((s) => [...RESUMABLE_STATES, 'profiled', 'parsing'].includes(s.state));
      const avg = scored.length ? Math.round(scored.reduce((n, s) => n + s.score, 0) / scored.length) : null;
      return {
        completedCount: scored.length,
        averageScore: avg,
        skillsDemonstrated: mine.filter((s) => s.score >= 70).slice(0, 8),
        skillsToImprove: [...mine].filter((s) => s.score < 55).sort((a, b) => a.score - b.score).slice(0, 8),
        resumable: resumable.slice(0, 5).map((s) => ({ id: s.id, roleTitle: analysisOf(s)?.roleTitle ?? null, state: s.state, updatedAt: s.updatedAt.toISOString() })),
        recent: sessions.slice(0, 8).map((s) => ({
          id: s.id,
          roleTitle: analysisOf(s)?.roleTitle ?? null,
          state: s.state,
          overallScore: scoreBySession.get(s.id) ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
        scoreHistory: scored.slice(-12).map((s) => ({ sessionId: s.sessionId, score: s.score, completedAt: s.at.toISOString() })),
        usage: { interviewsThisMonth: thisMonth, monthlyQuota: this.cfg.INTERVIEW_MONTHLY_QUOTA_FREE },
      };
    });
  }

  /** Used by tests and the sweeper to look up sessions in specific states. */
  static readonly activeStates = inArray;
}
