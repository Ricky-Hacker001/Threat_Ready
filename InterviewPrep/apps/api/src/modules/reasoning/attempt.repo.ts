import type { ReasoningAttemptState, ReasoningAttemptView, ReasoningItemPublic } from '@threatready/contracts';
import { reasoningAttempts, reasoningEvaluations, reasoningItems } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/database.js';
import type { Weights } from './domain.types.js';
import type { GeneratedItem, ReasoningItemPrivate } from './item.types.js';

export type AttemptRow = typeof reasoningAttempts.$inferSelect;
/** A question as the API may see it: every column except `private` (A5; the API role has no privilege on it, migration 0016). */
export type ItemRow = Omit<typeof reasoningItems.$inferSelect, 'private'>;
export type EvaluationRow = typeof reasoningEvaluations.$inferSelect;

/**
 * Projection for every reasoning_items read in a learner's transaction. The answer key column is
 * never listed: since migration 0016 (security patch 2) selecting it as tr_app_user is a privilege
 * error, so a `select()` of the whole row would fail rather than leak.
 */
const { private: _private, ...publicColumns } = getTableColumns(reasoningItems);
export const ITEM_COLUMNS = publicColumns;

/** Scoped repository: an attempt is found only by (id, userId). A miss is 404, never 403 (ADD L7). */
export async function loadOwnedAttempt(tx: Tx, userId: string, id: string, forUpdate = false): Promise<AttemptRow> {
  const q = tx.db.select().from(reasoningAttempts).where(and(eq(reasoningAttempts.id, id), eq(reasoningAttempts.userId, userId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new DomainError('REASONING_ATTEMPT_NOT_FOUND');
  return row;
}

export async function loadItem(tx: Tx, id: string): Promise<ItemRow | null> {
  const [row] = await tx.db.select(ITEM_COLUMNS).from(reasoningItems).where(eq(reasoningItems.id, id));
  return row ?? null;
}

/**
 * The answer key for one question, read with the owner role (never inside a learner's transaction).
 * Callers check the learner owns an evaluated attempt on the item first. The API's budget pre-checks
 * do not read it: they estimate an evaluation at the item-context bound (evaluatorRequestBound).
 */
export async function loadItemPrivate(tx: Tx, id: string): Promise<ReasoningItemPrivate | null> {
  const [row] = await tx.db.select({ private: reasoningItems.private }).from(reasoningItems).where(eq(reasoningItems.id, id));
  return row ? (row.private as ReasoningItemPrivate) : null;
}

export async function loadEvaluation(tx: Tx, attemptId: string): Promise<EvaluationRow | null> {
  const [row] = await tx.db.select().from(reasoningEvaluations).where(eq(reasoningEvaluations.attemptId, attemptId));
  return row ?? null;
}

/** Guarded state transition with optimistic concurrency; concurrent requests cannot both advance an attempt. */
export async function transition(tx: Tx, a: AttemptRow, from: readonly ReasoningAttemptState[], patch: Partial<typeof reasoningAttempts.$inferInsert>): Promise<AttemptRow> {
  const [row] = await tx.db
    .update(reasoningAttempts)
    .set({ ...patch, version: sql`${reasoningAttempts.version} + 1`, updatedAt: new Date() })
    .where(and(eq(reasoningAttempts.id, a.id), inArray(reasoningAttempts.state, [...from]), eq(reasoningAttempts.version, a.version)))
    .returning();
  if (!row) throw new DomainError('REASONING_INVALID_STATE');
  return row;
}

/**
 * The only projection of an item the browser ever receives: the public column plus metadata, as part
 * of one attempt. The private column (answer key, rubric, option analysis, reference answer) is never
 * read here. A pool question is shared by many learners, so its stable id and exact creation time are
 * never sent: the id is the attempt's and the date is the day only, so a cohort cannot match questions
 * (and swap answer keys) by a machine key (audit TR-42).
 */
export function publicOf(item: ItemRow, attempt: Pick<AttemptRow, 'id'>): ReasoningItemPublic {
  const p = item.public as GeneratedItem['public'];
  const day = new Date(item.createdAt);
  day.setUTCHours(0, 0, 0, 0);
  return {
    id: attempt.id,
    domain: p.domain,
    difficulty: p.difficulty,
    title: p.title,
    scenario: p.scenario,
    attackNarrative: p.attackNarrative,
    objective: p.objective,
    question: p.question,
    options: p.options.map((o) => ({ id: o.id, text: o.text })),
    diagram: p.diagram,
    techniques: p.techniques,
    concepts: p.concepts,
    weights: item.weights as Weights,
    generatorVersion: item.generatorVersion,
    createdAt: day.toISOString(),
  };
}

/** Wall-clock seconds from the moment the question could be read to the answer's submission (informational). */
export function answerSecondsOf(a: Pick<AttemptRow, 'openedAt' | 'submittedAt'>): number | null {
  if (!a.openedAt || !a.submittedAt) return null;
  return Math.max(0, Math.round((a.submittedAt.getTime() - a.openedAt.getTime()) / 1000));
}

/**
 * When an unanswered question is skipped automatically (REASONING_READY_TTL_HOURS after it was shown;
 * null when the TTL is 0). After a submission the daily quota or an AI budget refused, never before
 * REASONING_READY_TTL_HOURS past the next 00:00 UTC, when those reset (audit final review BIZ-07). The
 * sweep in JobsService applies the same rule in SQL.
 */
export function readyDeadline(a: Pick<AttemptRow, 'openedAt' | 'submitRefusedAt'>, readyTtlHours: number): Date | null {
  if (!a.openedAt || readyTtlHours <= 0) return null;
  const ttl = readyTtlHours * 3600_000;
  let at = a.openedAt.getTime() + ttl;
  if (a.submitRefusedAt) {
    const reset = new Date(a.submitRefusedAt);
    reset.setUTCHours(24, 0, 0, 0);
    at = Math.max(at, reset.getTime() + ttl);
  }
  return new Date(at);
}

/**
 * The browser's view of one attempt. `readyTtlHours` (REASONING_READY_TTL_HOURS) dates the automatic
 * skip of an unanswered question, so the learner is told before it happens (audit BIZ-09).
 */
export function attemptView(a: AttemptRow, item: ItemRow | null, ev: EvaluationRow | null, readyTtlHours = 0): ReasoningAttemptView {
  return {
    id: a.id,
    domain: a.domain as ReasoningAttemptView['domain'],
    difficulty: a.difficulty as ReasoningAttemptView['difficulty'],
    state: a.state,
    prefetched: a.itemId !== null && a.generationTries === 0,
    item: item ? publicOf(item, a) : null,
    answer: a.selectedOption && a.justification && a.submittedAt ? { selectedOption: a.selectedOption as 'A', justification: a.justification, submittedAt: a.submittedAt.toISOString(), answerSeconds: answerSecondsOf(a) } : null,
    result: ev ? { totalScore: ev.totalScore, correct: ev.correct, confidence: ev.confidence } : null,
    failure: a.failureCode ? { code: a.failureCode, stage: (a.failureStage === 'evaluation' ? 'evaluation' : 'generation') } : null,
    skipCounts: a.skipCounts,
    expiresAt: a.state === 'ready' ? (readyDeadline(a, readyTtlHours)?.toISOString() ?? null) : null,
    version: a.version,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
