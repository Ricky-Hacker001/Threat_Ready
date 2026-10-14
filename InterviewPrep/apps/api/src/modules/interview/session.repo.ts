import type { InterviewConfig, InterviewerStatus, SessionState, SessionView, TranscriptEntry } from '@threatready/contracts';
import { evaluations, interviewSessions, interviewTurns } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ContentService } from '../../platform/content/content.service.js';
import type { Tx } from '../../platform/db/database.js';
import type { InterviewPlan, SessionProgress } from './plan.types.js';
import { emptyProgress } from './plan.types.js';
import { elapsedMs, remainingSec } from './timing.js';

export type SessionRow = typeof interviewSessions.$inferSelect;
export type TurnRow = typeof interviewTurns.$inferSelect;

export const planOf = (s: SessionRow) => s.plan as InterviewPlan | null;
export const configOf = (s: SessionRow) => s.config as InterviewConfig | null;
export const progressOf = (s: SessionRow): SessionProgress => ({ ...emptyProgress(), ...(s.progress as Partial<SessionProgress>) });

/** Scoped repository: a session is found only by (id, userId). A miss is 404, never 403 (L7). */
export async function loadOwnedSession(tx: Tx, userId: string, id: string, forUpdate = false): Promise<SessionRow> {
  const q = tx.db.select().from(interviewSessions).where(and(eq(interviewSessions.id, id), eq(interviewSessions.userId, userId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new DomainError('INTERVIEW_SESSION_NOT_FOUND');
  return row;
}

export async function loadTurns(tx: Tx, sessionId: string): Promise<TurnRow[]> {
  return tx.db.select().from(interviewTurns).where(eq(interviewTurns.sessionId, sessionId)).orderBy(asc(interviewTurns.seq));
}

/**
 * Guarded state transition: succeeds only from the expected states, bumps the version, and
 * returns the new row. Concurrent requests cannot both advance the same session.
 */
export async function transition(
  tx: Tx,
  s: SessionRow,
  from: readonly SessionState[],
  patch: Partial<typeof interviewSessions.$inferInsert>,
  conflict: 'INTERVIEW_INVALID_STATE' | 'INTERVIEW_TURN_IN_PROGRESS' = 'INTERVIEW_INVALID_STATE',
): Promise<SessionRow> {
  const [row] = await tx.db
    .update(interviewSessions)
    .set({ ...patch, version: sql`${interviewSessions.version} + 1`, updatedAt: new Date() })
    .where(and(eq(interviewSessions.id, s.id), inArray(interviewSessions.state, [...from]), eq(interviewSessions.version, s.version)))
    .returning();
  if (!row) throw new DomainError(conflict);
  return row;
}

export function interviewerStatus(state: SessionState): InterviewerStatus {
  switch (state) {
    case 'asking':
      return 'asking';
    case 'awaiting_answer':
      return 'listening';
    case 'evaluating':
      return 'evaluating';
    case 'paused':
      return 'paused';
    case 'parsing':
    case 'profiled':
    case 'planned':
      return 'preparing';
    default:
      return 'finished';
  }
}

export function toTranscriptEntry(t: TurnRow, content: ContentService, plan: InterviewPlan | null): TranscriptEntry {
  const item = plan?.items.find((i) => i.id === t.planItemId);
  return {
    turnId: t.id,
    seq: t.seq,
    kind: t.kind,
    questionNumber: t.questionNumber,
    topic: item ? (item.kind === 'closing' ? 'Wrap-up' : item.kind === 'introduction' ? 'Introduction' : content.skillLabel(item.skillId)) : 'Interview',
    question: t.question,
    answer: t.answer,
    askedAt: t.askedAt.toISOString(),
    answeredAt: t.answeredAt?.toISOString() ?? null,
    practiceFeedback: (t.practiceFeedback as TranscriptEntry['practiceFeedback']) ?? null,
    clarifications: t.clarifications ?? [],
  };
}

export async function buildSessionView(tx: Tx, s: SessionRow, content: ContentService, roleTitle: string | null): Promise<SessionView> {
  const plan = planOf(s);
  const config = configOf(s);
  const progress = progressOf(s);
  const turns = await loadTurns(tx, s.id);
  const transcript = turns.map((t) => toTranscriptEntry(t, content, plan));
  const current = s.currentTurnId ? transcript.find((t) => t.turnId === s.currentTurnId) ?? null : null;
  const now = new Date();
  const clock = { activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince };
  const durationSec = (config?.durationMin ?? 0) * 60;

  let report: SessionView['report'] = { status: 'none', overallScore: null };
  if (s.state === 'completed' || s.state === 'scoring') report = { status: 'pending', overallScore: null };
  if (s.state === 'failed' && s.failureStage === 'scoring') report = { status: 'failed', overallScore: null };
  if (s.state === 'report_ready') {
    const [ev] = await tx.db.select({ score: evaluations.overallScore }).from(evaluations).where(eq(evaluations.sessionId, s.id)).limit(1);
    report = { status: 'ready', overallScore: ev?.score ?? null };
  }

  return {
    id: s.id,
    state: s.state,
    interviewerStatus: interviewerStatus(s.state),
    roleTitle,
    config,
    progress: {
      questionNumber: progress.questionNumber,
      plannedQuestions: plan?.items.length ?? 0,
      turnsUsed: progress.turnsUsed,
      maxTurns: plan?.maxTurns ?? 0,
    },
    timing: {
      durationSec,
      activeElapsedSec: Math.round(elapsedMs(clock, now) / 1000),
      remainingSec: config ? remainingSec(clock, config.durationMin, now) : 0,
      serverNow: now.toISOString(),
      runningSince: s.runningSince?.toISOString() ?? null,
    },
    currentTurn: s.state === 'awaiting_answer' || s.state === 'paused' ? current : null,
    transcript: transcript.filter((t) => t.answer !== null || t.turnId === s.currentTurnId),
    report,
    failure: s.failureCode ? { code: s.failureCode, stage: s.failureStage ?? 'unknown' } : null,
    createdAt: s.createdAt.toISOString(),
    startedAt: s.startedAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    endReason: s.endReason,
  };
}
