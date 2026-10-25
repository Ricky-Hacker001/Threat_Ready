import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ClarifyRequest, Difficulty, PracticeFeedback, SubmitAnswerRequest } from '@threatready/contracts';
import { interviewSessions, interviewTurns } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Principal } from '../../platform/authz/principal.js';
import { CRITERIA, ContentService } from '../../platform/content/content.service.js';
import { Database } from '../../platform/db/database.js';
import type { SseStream } from '../../platform/http/sse.js';
import { emitMetric, logger } from '../../platform/logging/logger.js';
import { LlmService, type CallMeta } from '../ai/llm.service.js';
import { quoteIsIn } from '../ai/prompts/common.js';
import { clarifyRequest, questionRequest, turnEvaluationRequest, turnEvaluationSchema, type TurnEvaluation } from '../ai/prompts/interview.prompts.js';
import { decideNext, meanLevel } from './adaptive.js';
import { analysisOf } from './analysis.service.js';
import { InterviewService } from './interview.service.js';
import { rubricKindFor, type InterviewPlan, type PendingTurn, type PlanItem, type SessionProgress } from './plan.types.js';
import { EVALUATING_LEASE_MS } from './recovery.js';
import { configOf, loadOwnedSession, loadTurns, planOf, progressOf, transition, type SessionRow, type TurnRow } from './session.repo.js';
import { remainingSec, startClock, stopClock } from './timing.js';

const ASKING_LEASE_MS = 45_000;
const EVALUATION_TIMEOUT_MS = 20_000;
const QUESTION_TIMEOUT_MS = 30_000;
const MAX_QUESTION_CHARS = 700;
const MAX_CLARIFICATIONS = 3;

/**
 * The live interview loop (ADD LLD-5). Model calls happen outside database transactions; each
 * state change is a short guarded transaction. A slow or failed evaluation never ends the
 * interview: it only skips the follow-up (LLD-3).
 */
@Injectable()
export class TurnService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(InterviewService) private readonly interviews: InterviewService,
  ) {}

  /** planned -> asking, then streams the first question. Idempotent for a running session. */
  async start(p: Principal, id: string, sse: SseStream): Promise<void> {
    const result = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state !== 'planned') return { session: s, startedNow: false };
      const plan = planOf(s)!;
      const pending: PendingTurn = { turnId: randomUUID(), planItemId: plan.items[0]!.id, kind: 'question', seq: 1, questionNumber: 1, directive: 'standard' };
      const next = await transition(tx, s, ['planned'], {
        state: 'asking',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        progress: { ...progressOf(s), pendingTurn: pending, askingLeaseUntil: leaseUntil() },
      });
      return { session: next, startedNow: true };
    });
    if (result.startedNow) return this.askPending(p, result.session, sse);
    if (result.session.state === 'asking') return this.ask(p, id, sse);
    return this.finishWithView(p, result.session.id, sse);
  }

  /** Recovery: regenerate a question whose stream was interrupted (LLD-3 asking -> asking, retry once). */
  async ask(p: Principal, id: string, sse: SseStream): Promise<void> {
    const s = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state !== 'asking') return s;
      const progress = progressOf(s);
      if (progress.askingLeaseUntil && new Date(progress.askingLeaseUntil).getTime() > Date.now()) {
        throw new DomainError('INTERVIEW_TURN_IN_PROGRESS');
      }
      return transition(tx, s, ['asking'], { progress: { ...progress, askingLeaseUntil: leaseUntil() } }, 'INTERVIEW_TURN_IN_PROGRESS');
    });
    if (s.state === 'asking') return this.askPending(p, s, sse);
    return this.finishWithView(p, s.id, sse);
  }

  async submit(p: Principal, id: string, req: SubmitAnswerRequest, sse: SseStream): Promise<void> {
    // 1. Store the answer and move to evaluating in one short transaction.
    const stored = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      const [replay] = await tx.db
        .select({ id: interviewTurns.id })
        .from(interviewTurns)
        .where(and(eq(interviewTurns.sessionId, s.id), eq(interviewTurns.clientSubmissionId, req.clientSubmissionId)));
      if (replay) {
        // The same submission again (network retry): never stored or evaluated twice.
        if (s.state === 'evaluating' || s.state === 'asking') throw new DomainError('INTERVIEW_TURN_IN_PROGRESS');
        return { replay: true as const, session: s };
      }
      if (s.state === 'evaluating' || s.state === 'asking') throw new DomainError('INTERVIEW_TURN_IN_PROGRESS');
      if (s.state !== 'awaiting_answer' || s.currentTurnId !== req.turnId) throw new DomainError('INTERVIEW_INVALID_STATE');

      const [turn] = await tx.db
        .update(interviewTurns)
        .set({ answer: req.answer, answeredAt: new Date(), clientSubmissionId: req.clientSubmissionId, evaluationStatus: 'pending' })
        .where(and(eq(interviewTurns.id, req.turnId), eq(interviewTurns.sessionId, s.id), isNull(interviewTurns.answer)))
        .returning();
      if (!turn) throw new DomainError('INTERVIEW_INVALID_STATE');
      const clock = stopClock({ activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince });
      // The lease lets a lost evaluation (process restart mid-call) be recovered instead of blocking the session (recovery.ts).
      const progress = { ...progressOf(s), evaluatingLeaseUntil: new Date(Date.now() + EVALUATING_LEASE_MS).toISOString() };
      const next = await transition(tx, s, ['awaiting_answer'], { state: 'evaluating', ...clock, lastActivityAt: new Date(), progress }, 'INTERVIEW_TURN_IN_PROGRESS');
      return { replay: false as const, session: next, turn };
    });
    if (stored.replay) return this.finishWithView(p, stored.session.id, sse);
    const { session, turn } = stored;
    sse.send({ type: 'evaluating' });

    const plan = planOf(session)!;
    const config = configOf(session)!;
    const progress = progressOf(session);
    const item = plan.items.find((i) => i.id === turn.planItemId)!;

    // 2. Provisional evaluation on SMALL.
    let evaluation: TurnEvaluation | null = null;
    let evaluationStatus: 'done' | 'failed' = 'failed';
    let budgetExhausted = false;
    const started = Date.now();
    try {
      const meta: CallMeta = { feature: 'interview.turn_evaluation', owner: { userId: p.userId, orgId: p.orgId }, sourceId: session.id, budget: 'live_turn' };
      evaluation = await this.evaluate(meta, { ...item, kind: rubricKindFor(item, turn.kind) }, config.difficulty, stripOpening(turn.question), req.answer);
      evaluationStatus = 'done';
    } catch (err) {
      if (err instanceof DomainError && err.code === 'LLM_BUDGET_EXCEEDED') budgetExhausted = true;
      logger.warn({ session_id: session.id, code: (err as DomainError).code ?? 'unknown' }, 'turn evaluation unavailable; continuing without follow-up');
    }
    emitMetric('TurnEvaluationLatencyMs', Date.now() - started, 'Milliseconds');

    // 3. Decide in code, persist, then either complete or ask the next question.
    const level = meanLevel(evaluation);
    const updated: SessionProgress = {
      ...progress,
      evaluatingLeaseUntil: undefined,
      recentLevels: level === null ? progress.recentLevels : [...progress.recentLevels, level].slice(-6),
      runningSummary: [...progress.runningSummary, summaryLine(this.content, item, turn, evaluation)].slice(-12),
      integrityFlags: progress.integrityFlags + (evaluation?.answer_integrity.instructs_grader ? 1 : 0),
    };
    const remaining = remainingSec({ activeElapsedMs: session.activeElapsedMs, runningSince: null }, config.durationMin);
    const step = budgetExhausted
      ? ({ action: 'complete', reason: 'budget_cap' } as const)
      : decideNext({ plan, progress: updated, currentItem: item, evaluation, remainingSec: remaining, difficulty: config.difficulty, answer: req.answer });
    // Warm-up and wrap-up are conversational; skill feedback on them would be noise.
    const feedback = config.mode === 'practice' && evaluation && item.kind !== 'introduction' && item.kind !== 'closing' ? practiceFeedback(this.content, item, evaluation) : null;

    const after = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, session.id);
      await tx.db.update(interviewTurns).set({ turnEvaluation: evaluation, evaluationStatus, practiceFeedback: feedback }).where(eq(interviewTurns.id, turn.id));
      if (step.action === 'complete') {
        return this.interviews.complete(tx, s, step.reason, { progress: updated });
      }
      const pending: PendingTurn =
        step.action === 'follow_up'
          ? {
              turnId: randomUUID(),
              planItemId: item.id,
              kind: 'follow_up',
              seq: turn.seq + 1,
              questionNumber: turn.questionNumber,
              directive: step.directive,
              followUpFocus: step.focus,
              missingConcepts: step.missingConcepts,
            }
          : { turnId: randomUUID(), planItemId: step.item.id, kind: 'question', seq: turn.seq + 1, questionNumber: turn.questionNumber + 1, directive: step.directive };
      const next: SessionProgress = {
        ...updated,
        itemIndex: step.action === 'next' ? step.itemIndex : updated.itemIndex,
        followUpsUsed: updated.followUpsUsed + (step.action === 'follow_up' ? 1 : 0),
        perItemFollowUps:
          step.action === 'follow_up' ? { ...updated.perItemFollowUps, [item.id]: (updated.perItemFollowUps[item.id] ?? 0) + 1 } : updated.perItemFollowUps,
        directive: step.directive,
        pendingTurn: pending,
        askingLeaseUntil: leaseUntil(),
      };
      return transition(tx, s, ['evaluating'], { state: 'asking', progress: next, lastActivityAt: new Date() });
    });

    if (feedback) sse.send({ type: 'feedback', turnId: turn.id, feedback });
    if (after.state === 'asking') return this.askPending(p, after, sse);
    return this.finishWithView(p, after.id, sse);
  }

  /**
   * A clarifying question from the candidate about the current question (repeat, rephrase,
   * scenario detail). Streams the interviewer's reply and stores it on the turn. The answer clock
   * keeps running, as in a real interview.
   */
  async clarify(p: Principal, id: string, req: ClarifyRequest, sse: SseStream): Promise<void> {
    // The clarification's slot is taken before the model is asked, in one guarded UPDATE: parallel
    // requests cannot all pass the count and each pay for a reply (audit 2026-10-23 TR-08). The reply
    // is written into that slot afterwards; until then its answer is empty and it is not shown.
    const { session, turn, slot } = await this.db.user(p, async (tx) => {
      const s = await loadOwnedSession(tx, p.userId, id);
      if (s.state !== 'awaiting_answer' || s.currentTurnId !== req.turnId) throw new DomainError('INTERVIEW_INVALID_STATE');
      const [t] = await tx.db.select().from(interviewTurns).where(and(eq(interviewTurns.id, req.turnId), eq(interviewTurns.sessionId, s.id)));
      if (!t || t.answer) throw new DomainError('INTERVIEW_INVALID_STATE');
      const entry = { question: req.message, answer: '', at: new Date().toISOString() };
      const [claimed] = await tx.db
        .update(interviewTurns)
        .set({ clarifications: sql`${interviewTurns.clarifications} || ${JSON.stringify([entry])}::jsonb` })
        .where(and(eq(interviewTurns.id, t.id), sql`jsonb_array_length(${interviewTurns.clarifications}) < ${MAX_CLARIFICATIONS}`))
        .returning({ n: sql<number>`jsonb_array_length(${interviewTurns.clarifications})` });
      if (!claimed) throw new DomainError('CLARIFICATION_LIMIT_REACHED');
      return { session: s, turn: t, slot: Number(claimed.n) - 1 };
    });

    const analysis = analysisOf(session)!;
    let reply = '';
    try {
      const meta: CallMeta = { feature: 'interview.clarify', owner: { userId: p.userId, orgId: p.orgId }, sourceId: session.id, budget: 'live_turn' };
      const earlier = turn.clarifications.filter((c) => c.answer);
      const request = clarifyRequest({ job: analysis.job, question: stripOpening(turn.question), message: req.message, earlier });
      for await (const chunk of this.llm.stream(meta, { ...request, timeoutMs: QUESTION_TIMEOUT_MS })) {
        if (reply.length >= MAX_QUESTION_CHARS) continue;
        reply += chunk;
        sse.send({ type: 'reply.delta', text: chunk });
      }
      reply = cleanQuestion(reply);
      if (reply.length < 3) throw new Error('empty reply');
    } catch (err) {
      logger.warn({ session_id: session.id, code: (err as DomainError).code ?? (err as Error).message }, 'clarification failed; repeating the question');
      reply = `Sure. Here's the question again: ${stripOpening(turn.question)}`;
      sse.send({ type: 'question.reset' });
      sse.send({ type: 'reply.delta', text: reply });
    }

    await this.db.user(p, async (tx) => {
      // Entries are only ever appended, so the slot's index is stable.
      await tx.db
        .update(interviewTurns)
        .set({ clarifications: sql`jsonb_set(${interviewTurns.clarifications}, ${`{${slot},answer}`}::text[], to_jsonb(${reply}::text))` })
        .where(eq(interviewTurns.id, turn.id));
      await tx.db.update(interviewSessions).set({ lastActivityAt: new Date() }).where(eq(interviewSessions.id, session.id));
    });
    return this.finishWithView(p, session.id, sse);
  }

  private async evaluate(meta: CallMeta, item: PlanItem, difficulty: Difficulty, question: string, answer: string): Promise<TurnEvaluation> {
    const rubric = this.content.rubricFor(item.kind);
    const criteria = CRITERIA.filter((c) => rubric.weights[c] > 0);
    const concepts = this.content.skill(item.skillId)?.concepts ?? [];
    const req = turnEvaluationRequest({ c: this.content.interview, item, difficulty, criteria, guidance: rubric.guidance, question, answer });
    const { value } = await this.llm.structured(meta, { ...req, timeoutMs: EVALUATION_TIMEOUT_MS }, turnEvaluationSchema(criteria, concepts));
    return verifyTurnQuotes(value, answer);
  }

  /** Generates, streams and stores the pending question, then returns to awaiting_answer. */
  private async askPending(p: Principal, s: SessionRow, sse: SseStream): Promise<void> {
    const plan = planOf(s)!;
    const config = configOf(s)!;
    const progress = progressOf(s);
    const pending = progress.pendingTurn!;
    const item = plan.items.find((i) => i.id === pending.planItemId)!;
    const turns = await this.db.user(p, (tx) => loadTurns(tx, s.id));
    const existing = turns.find((t) => t.seq === pending.seq);
    if (existing) {
      // Generated by a concurrent request that stopped before the state change.
      await this.storeQuestion(p, s.id, pending, existing.question, existing.questionSource);
      return this.finishWithView(p, s.id, sse);
    }

    const topic = item.kind === 'closing' ? 'Wrap-up' : item.kind === 'introduction' ? 'Introduction' : this.content.skillLabel(item.skillId);
    sse.send({ type: 'question.start', turnId: pending.turnId, kind: pending.kind, questionNumber: pending.questionNumber, topic });
    const intro = pending.seq === 1 ? openingLine(p.name, config.durationMin, analysisOf(s)!.roleTitle, plan) : '';
    if (intro) sse.send({ type: 'question.delta', text: intro });

    let text = '';
    let source: 'model' | 'template' = 'model';
    const analysis = analysisOf(s)!;
    try {
      const req = questionRequest({
        c: this.content.interview,
        config,
        job: analysis.job,
        candidate: analysis.candidate,
        item,
        kind: pending.kind,
        directive: pending.directive,
        followUpFocus: pending.followUpFocus,
        missingConcepts: pending.missingConcepts,
        // The stored first question carries the spoken greeting with the learner's name; prompts get the question only.
        window: turns.slice(-4).map((t) => ({ question: stripOpening(t.question), answer: t.answer, topic: t.planItemId })),
        summary: progress.runningSummary,
        askedSoFar: turns.map((t) => stripOpening(t.question)),
        previousSection: plan.items.find((i) => i.id === turns.at(-1)?.planItemId)?.section,
      });
      const meta: CallMeta = { feature: 'interview.question', owner: { userId: p.userId, orgId: p.orgId }, sourceId: s.id, budget: 'live_turn' };
      // The stream is not aborted when the browser disconnects: the question is stored either way,
      // so a refresh picks it up instead of paying for it twice.
      for await (const chunk of this.llm.stream(meta, { ...req, timeoutMs: QUESTION_TIMEOUT_MS })) {
        if (text.length >= MAX_QUESTION_CHARS) continue;
        text += chunk;
        sse.send({ type: 'question.delta', text: chunk });
      }
      text = cleanQuestion(text);
      if (text.length < 10) throw new Error('empty question');
    } catch (err) {
      // A deterministic template keeps the interview moving and costs nothing.
      logger.warn({ session_id: s.id, code: (err as DomainError).code ?? (err as Error).message }, 'question generation failed; using template');
      source = 'template';
      text = templateQuestion(this.content, item, pending);
      sse.send({ type: 'question.reset' });
      sse.send({ type: 'question.delta', text: `${intro}${text}` });
    }
    await this.storeQuestion(p, s.id, pending, `${intro}${text}`, source);
    return this.finishWithView(p, s.id, sse);
  }

  private async storeQuestion(p: Principal, sessionId: string, pending: PendingTurn, question: string, source: 'model' | 'template'): Promise<void> {
    await this.db.user(p, async (tx) => {
      const current = await loadOwnedSession(tx, p.userId, sessionId);
      if (current.state !== 'asking') return;
      await tx.db
        .insert(interviewTurns)
        .values({
          id: pending.turnId,
          orgId: current.orgId,
          userId: current.userId,
          sessionId: current.id,
          seq: pending.seq,
          planItemId: pending.planItemId,
          kind: pending.kind,
          questionNumber: pending.questionNumber,
          question,
          questionSource: source,
        })
        .onConflictDoNothing();
      const [turn] = await tx.db.select({ id: interviewTurns.id }).from(interviewTurns).where(and(eq(interviewTurns.sessionId, current.id), eq(interviewTurns.seq, pending.seq)));
      const progress = progressOf(current);
      const clock = startClock({ activeElapsedMs: current.activeElapsedMs, runningSince: null });
      await transition(tx, current, ['asking'], {
        state: 'awaiting_answer',
        currentTurnId: turn!.id,
        ...clock,
        lastActivityAt: new Date(),
        progress: { ...progress, pendingTurn: undefined, askingLeaseUntil: undefined, turnsUsed: pending.seq, questionNumber: pending.questionNumber },
      });
    });
  }

  private async finishWithView(p: Principal, id: string, sse: SseStream): Promise<void> {
    const view = await this.db.user(p, async (tx) => this.interviews.view(tx, await loadOwnedSession(tx, p.userId, id)));
    sse.send({ type: 'done', session: view });
  }
}

const leaseUntil = () => new Date(Date.now() + ASKING_LEASE_MS).toISOString();

/** ADD §7 step 3 applied to provisional evaluations: a level needs a verbatim quote from the answer. */
export function verifyTurnQuotes(ev: TurnEvaluation, answer: string): TurnEvaluation {
  return {
    ...ev,
    criteria: ev.criteria.map((c) => (c.level !== '0' && !quoteIsIn(c.evidence_quote, answer) ? { ...c, level: '0' as const, evidence_quote: null } : c)),
    concepts_demonstrated: ev.concepts_demonstrated.filter((c) => quoteIsIn(c.evidence_quote, answer)),
  };
}

/** One line per answered turn for the running summary held by the application (ADD L14). */
function summaryLine(content: ContentService, item: PlanItem, turn: TurnRow, ev: TurnEvaluation | null): string {
  const label = item.kind === 'closing' ? 'wrap-up' : item.kind === 'introduction' ? 'introduction' : content.skillLabel(item.skillId);
  const tag = `Q${turn.questionNumber}${turn.kind === 'follow_up' ? ' follow-up' : ''} on ${label}`;
  if (!ev) return `${tag}: answered (not assessed).`;
  const level = meanLevel(ev)!;
  const shown = ev.concepts_demonstrated.map((c) => c.concept_id.replace(/_/g, ' ')).slice(0, 3).join(', ') || 'none';
  const missing = ev.concepts_missing.map((c) => c.replace(/_/g, ' ')).slice(0, 3).join(', ') || 'none';
  const band = level >= 3.4 ? 'strong' : level >= 2 ? 'partial' : 'weak';
  return `${tag}: ${band}; covered ${shown}; missing ${missing}.`;
}

function practiceFeedback(content: ContentService, item: PlanItem, ev: TurnEvaluation): PracticeFeedback {
  const label = (id: string) => id.replace(/_/g, ' ');
  return {
    demonstrated: ev.concepts_demonstrated.map((c) => label(c.concept_id)).slice(0, 5),
    missing: ev.concepts_missing.map(label).slice(0, 5),
    tip: ev.practice_tip ?? (ev.concepts_missing[0] ? `Consider covering ${label(ev.concepts_missing[0])} for ${content.skillLabel(item.skillId)}.` : null),
  };
}

/** A real interviewer's opening: greeting, the role, an agenda from the actual plan, and permission to think aloud. */
export function openingLine(name: string, durationMin: number, roleTitle: string, plan: InterviewPlan): string {
  const first = name.trim().split(/\s+/)[0] || 'there';
  const sections = new Set(plan.items.map((i) => i.section));
  const parts = [
    'start with your background',
    sections.has('technical') ? 'go through some technical questions' : null,
    sections.has('scenario') ? 'work through a scenario together' : null,
    sections.has('behavioral') ? 'talk about how you work with others' : null,
  ].filter((x): x is string => Boolean(x));
  const agenda = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, then ${parts.at(-1)}` : parts[0];
  return `Hi ${first}, I'm Alex, and I'll be interviewing you for the ${roleTitle} role today. Thanks for making the time. We have about ${durationMin} minutes: we'll ${agenda}, and leave a little time at the end. Feel free to think out loud. `;
}

/**
 * The stored first question includes the spoken greeting (with the learner's first name); every prompt
 * gets the question itself, so the name never reaches the model outside the redaction path.
 */
export const stripOpening = (q: string) => q.replace(/^Hi .*?Feel free to think out loud\.\s*/s, '');

export function cleanQuestion(raw: string): string {
  return raw
    .replace(/^[\s"'`*#>-]+|[\s"'`*]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
}

export function templateQuestion(content: ContentService, item: PlanItem, pending: PendingTurn): string {
  const t = content.interview.templates;
  const skill = content.skillLabel(item.skillId);
  if (pending.kind === 'follow_up') {
    const tpl = pending.directive === 'deepen' ? t.follow_up_deepen! : t.follow_up_clarify!;
    return tpl.replace('{focus}', pending.followUpFocus ?? skill);
  }
  const tpl = t[item.kind] ?? t.jd_technical!;
  return tpl
    .replace('{skill}', skill)
    .replace('{claim}', item.claim ?? `your work with ${skill}`)
    .replace('{scenario}', item.scenarioSeed ?? `a realistic problem involving ${skill}.`);
}
