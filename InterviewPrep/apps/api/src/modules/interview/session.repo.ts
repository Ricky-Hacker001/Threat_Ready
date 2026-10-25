import type { InterviewConfig, InterviewerStatus, SessionState, SessionView, TranscriptEntry } from '@threatready/contracts';
import { evaluations, interviewSessions, interviewTurns, llmCallLog, type SessionIntegrity } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, asc, eq, gt, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { ContentService } from '../../platform/content/content.service.js';
import type { Tx } from '../../platform/db/database.js';
import type { InterviewPlan, SessionProgress } from './plan.types.js';
import { emptyProgress } from './plan.types.js';
import { elapsedMs, remainingSec } from './timing.js';

export type SessionRow = typeof interviewSessions.$inferSelect;
/** A transition's column changes; `integrity` may be an atomic jsonb update (startPause, endPause, tabHidden). */
export type SessionPatch = Omit<Partial<typeof interviewSessions.$inferInsert>, 'integrity'> & { integrity?: SessionIntegrity | SQL };
export type TurnRow = typeof interviewTurns.$inferSelect;

/** Manual "generate again" attempts after a billed failure; then the report stays failed (contact support). */
export const MAX_REPORT_RETRIES = 3;
/** Failure code of a final scoring stopped at its per-session ceiling (AI_FINALIZE_SOURCE_CAP_USD): not retried. */
export const SCORING_CEILING_CODE = 'LLM_BUDGET_EXCEEDED';

export const planOf = (s: SessionRow) => s.plan as InterviewPlan | null;
export const integrityOf = (s: SessionRow): SessionIntegrity => (s.integrity ?? {}) as SessionIntegrity;
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
  patch: SessionPatch,
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

/**
 * Whether the latest final-scoring attempt reached the provider and was billed (settled, or failed with
 * a cost). A retry after an attempt that cost nothing (provider outage, AI paused for the day) is free.
 */
export async function scoringBilledSince(tx: Tx, sessionId: string, since: string | undefined): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: llmCallLog.id })
    .from(llmCallLog)
    .where(
      and(
        eq(llmCallLog.sourceId, sessionId),
        eq(llmCallLog.feature, 'interview.final_scoring'),
        or(eq(llmCallLog.status, 'settled'), isNotNull(llmCallLog.costUsd)),
        since ? gt(llmCallLog.createdAt, new Date(since)) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Attempts the learner has left for a failed report: an attempt counts only once it has been billed. */
export function reportRetriesLeft(retryReportCount: number, lastAttemptBilled: boolean): number {
  return retryReportCount + (lastAttemptBilled ? 1 : 0) <= MAX_REPORT_RETRIES ? Math.max(1, MAX_REPORT_RETRIES - retryReportCount) : 0;
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
    // A clarification whose reply is still streaming (empty answer) is not shown yet.
    clarifications: (t.clarifications ?? []).filter((c) => c.answer),
  };
}

/*
 * Integrity counters (pauses, tab switches) are changed with jsonb increments in the UPDATE itself,
 * never read-modify-write, so a tab-switch report and a turn's transition cannot overwrite each other
 * (migration 0011).
 */
const integrityInc = (field: keyof SessionIntegrity, by: number) =>
  sql`jsonb_build_object(${field}::text, COALESCE((${interviewSessions.integrity}->>${field}::text)::bigint, 0) + ${by}::bigint)`;

/** A pause starts: count it and remember when (idle auto-pauses are counted separately). */
export const startPause = (field: 'pauseCount' | 'idlePauseCount', at: Date) =>
  sql`${interviewSessions.integrity} || ${integrityInc(field, 1)} || jsonb_build_object('pausedAt', ${at.toISOString()}::text)`;

/** The pause in progress ends: its length is added to pausedMs. */
export const endPause = () =>
  sql`(${interviewSessions.integrity} - 'pausedAt') || jsonb_build_object('pausedMs',
    COALESCE((${interviewSessions.integrity}->>'pausedMs')::bigint, 0)
    + CASE WHEN ${interviewSessions.integrity} ? 'pausedAt'
        THEN GREATEST(0, (EXTRACT(EPOCH FROM (now() - (${interviewSessions.integrity}->>'pausedAt')::timestamptz)) * 1000)::bigint)
        ELSE 0 END)`;

export const tabHidden = (hiddenMs: number) =>
  sql`${interviewSessions.integrity} || ${integrityInc('tabHiddenCount', 1)} || ${integrityInc('tabHiddenMs', Math.max(0, Math.round(hiddenMs)))}`;

/** Total paused time, including the pause in progress. */
export function pausedMsOf(i: SessionIntegrity, now: Date = new Date()): number {
  return (i.pausedMs ?? 0) + (i.pausedAt ? Math.max(0, now.getTime() - new Date(i.pausedAt).getTime()) : 0);
}

export async function buildSessionView(tx: Tx, s: SessionRow, content: ContentService, roleTitle: string | null, maxPauses = 0): Promise<SessionView> {
  const plan = planOf(s);
  const config = configOf(s);
  const progress = progressOf(s);
  const turns = await loadTurns(tx, s.id);
  const transcript = turns.map((t) => toTranscriptEntry(t, content, plan));
  let current = s.currentTurnId ? transcript.find((t) => t.turnId === s.currentTurnId) ?? null : null;
  // Paused: the question is withheld until resume, so a pause cannot be used to research the answer
  // with the clock stopped (audit 2026-10-23 TR-24). The turn id and number stay for the UI.
  const hideCurrent = s.state === 'paused' && current !== null && current.answer === null;
  if (hideCurrent) current = { ...current!, question: '', clarifications: [], questionHidden: true };
  const integrity = integrityOf(s);
  const now = new Date();
  const clock = { activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince };
  const durationSec = (config?.durationMin ?? 0) * 60;

  let report: SessionView['report'] = { status: 'none', overallScore: null, retriesLeft: null };
  if (s.state === 'completed' || s.state === 'scoring') report = { status: 'pending', overallScore: null, retriesLeft: null };
  if (s.state === 'failed' && s.failureStage === 'scoring') {
    const billed = await scoringBilledSince(tx, s.id, progress.lastReportRetryAt);
    report = { status: 'failed', overallScore: null, retriesLeft: s.failureCode === SCORING_CEILING_CODE ? 0 : reportRetriesLeft(progress.retryReportCount ?? 0, billed) };
  }
  if (s.state === 'report_ready') {
    const [ev] = await tx.db.select({ score: evaluations.overallScore }).from(evaluations).where(eq(evaluations.sessionId, s.id)).limit(1);
    report = { status: 'ready', overallScore: ev?.score ?? null, retriesLeft: null };
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
    transcript: transcript.filter((t) => t.answer !== null || (t.turnId === s.currentTurnId && !hideCurrent)),
    report,
    integrity: {
      pauseCount: integrity.pauseCount ?? 0,
      pausedSec: Math.round(pausedMsOf(integrity, now) / 1000),
      maxPauses: maxPauses > 0 ? maxPauses : null,
      tabHiddenCount: integrity.tabHiddenCount ?? 0,
    },
    failure: s.failureCode ? { code: s.failureCode, stage: s.failureStage ?? 'unknown' } : null,
    createdAt: s.createdAt.toISOString(),
    startedAt: s.startedAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    endReason: s.endReason,
  };
}
