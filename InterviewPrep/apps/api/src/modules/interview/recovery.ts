import { randomUUID } from 'node:crypto';
import { interviewTurns } from '@threatready/db';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../platform/db/database.js';
import { decideNext } from './adaptive.js';
import type { PendingTurn, SessionProgress } from './plan.types.js';
import { configOf, planOf, progressOf, transition, type SessionPatch, type SessionRow } from './session.repo.js';
import { remainingSec } from './timing.js';

/**
 * Longest an answer evaluation can take: a SMALL call (20 s) with the SDK's retries (up to
 * LLM_MAX_RETRIES=4) and their backoff, and LlmService's one structured retry, is under four and a
 * half minutes; the lease adds slack. Set when a turn enters evaluating.
 */
export const EVALUATING_LEASE_MS = 5 * 60_000;

export type CompleteFn = (tx: Tx, s: SessionRow, reason: string, extra?: SessionPatch) => Promise<SessionRow>;

/** True when a session has been 'evaluating' past its lease: the evaluation is presumed lost. */
export function evaluationStalled(s: SessionRow, now = Date.now()): boolean {
  if (s.state !== 'evaluating') return false;
  const lease = progressOf(s).evaluatingLeaseUntil;
  const until = lease ? new Date(lease).getTime() : s.lastActivityAt.getTime() + EVALUATING_LEASE_MS;
  return until < now;
}

/**
 * An evaluation that never finished (the process restarted, or the request died mid-call) must not
 * hold the interview in 'evaluating', blocking end, pause and an open-session slot for a day (audit
 * 2026-10-23 TR-23). The interview continues exactly as after a failed evaluation: no follow-up, the
 * next plan item (state 'asking' with its lease already expired, so the client's question recovery
 * generates it at once), or the end of the interview when the plan, turns or time are used up.
 */
export async function recoverStalledEvaluation(tx: Tx, s: SessionRow, complete: CompleteFn): Promise<SessionRow> {
  const plan = planOf(s);
  const config = configOf(s);
  const progress = progressOf(s);
  const [turn] = s.currentTurnId ? await tx.db.select().from(interviewTurns).where(eq(interviewTurns.id, s.currentTurnId)) : [];
  const updated: SessionProgress = { ...progress, evaluatingLeaseUntil: undefined };
  if (!plan || !config || !turn) return complete(tx, s, 'evaluation_lost', { progress: updated });
  await tx.db
    .update(interviewTurns)
    .set({ evaluationStatus: 'failed' })
    .where(and(eq(interviewTurns.id, turn.id), eq(interviewTurns.evaluationStatus, 'pending')));
  updated.runningSummary = [...progress.runningSummary, `Q${turn.questionNumber}${turn.kind === 'follow_up' ? ' follow-up' : ''}: answered (not assessed).`].slice(-12);
  const item = plan.items.find((i) => i.id === turn.planItemId);
  const remaining = remainingSec({ activeElapsedMs: s.activeElapsedMs, runningSince: null }, config.durationMin);
  const step = item
    ? decideNext({ plan, progress: updated, currentItem: item, evaluation: null, remainingSec: remaining, difficulty: config.difficulty })
    : ({ action: 'complete', reason: 'plan_complete' } as const);
  if (step.action !== 'next') return complete(tx, s, step.action === 'complete' ? step.reason : 'plan_complete', { progress: updated });
  const pending: PendingTurn = { turnId: randomUUID(), planItemId: step.item.id, kind: 'question', seq: turn.seq + 1, questionNumber: turn.questionNumber + 1, directive: step.directive };
  return transition(tx, s, ['evaluating'], {
    state: 'asking',
    progress: { ...updated, itemIndex: step.itemIndex, directive: step.directive, pendingTurn: pending, askingLeaseUntil: new Date(Date.now() - 1000).toISOString() },
    lastActivityAt: new Date(),
  });
}
