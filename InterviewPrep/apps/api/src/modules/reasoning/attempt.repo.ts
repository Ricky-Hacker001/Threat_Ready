import type { ReasoningAttemptState, ReasoningAttemptView, ReasoningItemPublic } from '@threatready/contracts';
import { reasoningAttempts, reasoningEvaluations, reasoningItems } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/database.js';
import type { Weights } from './domain.types.js';
import type { GeneratedItem, ReasoningItemPrivate } from './item.types.js';

export type AttemptRow = typeof reasoningAttempts.$inferSelect;
export type ItemRow = typeof reasoningItems.$inferSelect;
export type EvaluationRow = typeof reasoningEvaluations.$inferSelect;

/** Scoped repository: an attempt is found only by (id, userId). A miss is 404, never 403 (ADD L7). */
export async function loadOwnedAttempt(tx: Tx, userId: string, id: string, forUpdate = false): Promise<AttemptRow> {
  const q = tx.db.select().from(reasoningAttempts).where(and(eq(reasoningAttempts.id, id), eq(reasoningAttempts.userId, userId)));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new DomainError('REASONING_ATTEMPT_NOT_FOUND');
  return row;
}

export async function loadItem(tx: Tx, id: string): Promise<ItemRow | null> {
  const [row] = await tx.db.select().from(reasoningItems).where(eq(reasoningItems.id, id));
  return row ?? null;
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
 * The only projection of an item the browser ever receives: the public column plus metadata.
 * The private column (answer key, rubric, option analysis, reference answer) is never read here.
 */
export function publicOf(item: ItemRow): ReasoningItemPublic {
  const p = item.public as GeneratedItem['public'];
  return {
    id: item.id,
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
    createdAt: item.createdAt.toISOString(),
  };
}

export const privateOf = (item: ItemRow): ReasoningItemPrivate => item.private as ReasoningItemPrivate;

export function attemptView(a: AttemptRow, item: ItemRow | null, ev: EvaluationRow | null): ReasoningAttemptView {
  return {
    id: a.id,
    domain: a.domain as ReasoningAttemptView['domain'],
    difficulty: a.difficulty as ReasoningAttemptView['difficulty'],
    state: a.state,
    prefetched: a.itemId !== null && a.generationTries === 0,
    item: item ? publicOf(item) : null,
    answer: a.selectedOption && a.justification && a.submittedAt ? { selectedOption: a.selectedOption as 'A', justification: a.justification, submittedAt: a.submittedAt.toISOString() } : null,
    result: ev ? { totalScore: ev.totalScore, correct: ev.correct, confidence: ev.confidence } : null,
    failure: a.failureCode ? { code: a.failureCode, stage: (a.failureStage === 'evaluation' ? 'evaluation' : 'generation') } : null,
    version: a.version,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}
