// Client for the reasoning engine: /v1/reasoning/* on this origin (proxied to the ThreatReady monolith).
// The engine answers with the platform error envelope { error: { code, message, retryable, request_id } };
// a gateway in front of it may answer { error: '…', code } instead. Both read the same here.
import { ApiError, retryAfterOf, signIn, signUp } from '../api';

export type DomainKey = string;
export type OptionId = 'A' | 'B' | 'C' | 'D';
export type AttemptState = 'generating' | 'ready' | 'evaluating' | 'evaluated' | 'generation_failed' | 'evaluation_failed' | 'abandoned';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export const DIFFICULTIES: { key: Difficulty; label: string; blurb: string }[] = [
  { key: 'beginner', label: 'Beginner', blurb: 'Small architecture, one or two attack steps, a direct decision.' },
  { key: 'intermediate', label: 'Intermediate', blurb: 'Several trust boundaries, a path to trace, a constraint to respect.' },
  { key: 'advanced', label: 'Advanced', blurb: 'A hidden trust relationship, a control that does not apply, two defensible distractors.' },
];
export type DimensionKey = 'correctness' | 'reasoning' | 'architecture' | 'risk';

export interface Technique { id: string; name: string }
export interface DiagramBoundary { id: string; label: string; kind: string }
export interface DiagramNode { id: string; label: string; type: string; boundary: string; detail: string | null; compromised: boolean; entryPoint: boolean; controls: string[] }
export interface DiagramEdge { id: string; from: string; to: string; label: string; kind: 'data' | 'auth' | 'control' | 'attack' }
export interface DiagramData { boundaries: DiagramBoundary[]; nodes: DiagramNode[]; edges: DiagramEdge[]; attackPath: string[] }

export interface ItemPublic {
  id: string; domain: DomainKey; difficulty: string; title: string; scenario: string; attackNarrative: string; objective: string; question: string;
  options: { id: OptionId; text: string }[]; diagram: DiagramData; techniques: Technique[]; concepts: string[]; weights: Record<DimensionKey, number>; generatorVersion: string; createdAt: string;
}
export interface AttemptView {
  id: string; domain: DomainKey; difficulty: string; state: AttemptState; prefetched: boolean; item: ItemPublic | null;
  /** answerSeconds: wall-clock time from the question being shown to the submission (information only). */
  answer: { selectedOption: OptionId; justification: string; submittedAt: string; answerSeconds: number | null } | null;
  result: { totalScore: number; correct: boolean; confidence: 'high' | 'medium' | 'low' } | null;
  failure: { code: string; stage: 'generation' | 'evaluation' } | null;
  /** Whether skipping this question once shown (or leaving it to expire) counts as 0; false for questions opened before that rule. */
  skipCounts: boolean;
  /** When an unanswered (ready) question is skipped automatically; null when it does not expire. */
  expiresAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export interface PoolStatus { domain: DomainKey; difficulty: Difficulty; available: number; refilling: boolean }
/** `countsAsZero`: a skipped question that was shown and counts as answered with 0 (the server decides). */
export interface AttemptSummary { id: string; domain: DomainKey; state: AttemptState; title: string | null; difficulty: string | null; totalScore: number | null; correct: boolean | null; countsAsZero: boolean; createdAt: string; evaluatedAt: string | null }
export interface DimensionResult { key: DimensionKey; label: string; weight: number; score: number; evidence: { point: string; status: 'met' | 'partial' | 'missed'; rationale: string; quote: string | null }[]; notes: string[] }
export interface Result {
  attemptId: string; domain: DomainKey; totalScore: number; correct: boolean; selectedOption: OptionId; correctOption: OptionId;
  options: { id: OptionId; text: string; verdict: 'best' | 'plausible' | 'weak' | 'wrong'; why: string }[];
  dimensions: DimensionResult[];
  feedback: { decision: string; reasoning: string; gotRight: string[]; missed: string[]; whyBest: string; whyAlternatives: { option: OptionId; why: string }[]; architectureAnalysis: string; expertExplanation: string; improve: string[]; incorrectClaims: { claim: string; why: string }[] };
  confidence: 'high' | 'medium' | 'low'; reviewFlag: boolean; degraded: boolean; notices: string[];
  scoring: { version: string; weights: Record<DimensionKey, number>; notes: string[] }; techniques: Technique[]; concepts: string[]; answerSeconds: number | null; evaluatedAt: string;
}
/** A skipped question that was shown counts in `attempts` and `skipped`, and as 0 in `averageScore`. */
export interface DomainStats { attempts: number; evaluated: number; skipped: number; averageScore: number | null; bestScore: number | null; lastAttemptAt: string | null }
export interface DomainView { key: DomainKey; title: string; description: string; track: string; available: boolean; difficulty: string | null; focus: string[]; techniques: Technique[]; weights: Record<DimensionKey, number> | null; stats: DomainStats }
export interface Dashboard {
  attempts: number; evaluated: number; skipped: number; inProgress: number; averageScore: number | null; bestScore: number | null; correctRate: number | null;
  dimensionAverages: { key: DimensionKey; label: string; average: number | null; weight: number }[];
  scoreHistory: { attemptId: string; score: number; correct: boolean; evaluatedAt: string }[];
  recent: AttemptSummary[]; byDomain: { domain: DomainKey; title: string; stats: DomainStats }[];
}

/** Messages by engine error code; the server message is the fallback. Budget and rate refusals are worded in `messageFor`. */
const MESSAGES: Record<string, string> = {
  REASONING_LIMIT_REACHED: 'Finish your open assessment before starting another.',
  REASONING_RETRY_LIMIT_REACHED: 'This step has already been retried the maximum number of times. It stays in your history; start a new question to continue.',
  REASONING_JUSTIFICATION_REQUIRED: 'Explain why you chose that option before submitting (at least a couple of sentences).',
  REASONING_ANSWER_TOO_LONG: 'Justifications are limited to 4,000 characters.',
  REASONING_INVALID_STATE: 'That action is not available at this point in the assessment.',
  REASONING_DOMAIN_UNAVAILABLE: 'This domain is not available yet.',
  REASONING_GENERATION_FAILED: 'We could not generate a valid scenario this time. Retry to generate another.',
  REASONING_EVALUATION_FAILED: 'Your answer is saved but could not be evaluated yet. Retry the evaluation.',
  REASONING_EVALUATION_DECLINED: 'The AI grader declined to evaluate this answer. It is saved; you can retry (it does not count against the retry limit) or start a new question.',
  LLM_PROVIDER_UNAVAILABLE: 'The AI service is temporarily unavailable. Your progress is saved.',
  REASONING_ENGINE_UNAVAILABLE: 'The reasoning engine is not available right now. Try again in a few minutes.',
  UPSTREAM_UNAVAILABLE: 'The assessment service is restarting. Try again shortly.',
  STARTING: 'ThreatReady is starting up. Try again in a few seconds.',
};

/** The next 00:00 UTC, when every daily AI budget and the evaluation quota reset. */
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); };
/** "00:00 UTC (05:30 your time)" for a reset at `iso`. */
export const resetText = (iso?: string | null) => `00:00 UTC (${new Date(iso || nextUtcMidnight()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} your time)`;
const resetOf = (e: ApiError) => { const d = e.details as { resetAt?: unknown } | undefined; return typeof d?.resetAt === 'string' ? d.resetAt : null; };
/** "in 20 s" / "in about 3 min" / "in about 2 h" from Retry-After seconds. */
export const waitText = (sec?: number) => (sec === undefined ? 'in a moment' : sec < 90 ? `in ${Math.max(1, sec)} s` : sec < 5400 ? `in about ${Math.ceil(sec / 60)} min` : `in about ${Math.round(sec / 3600)} h`);

/** What the learner reads for a failed call: what happened, what was kept, and when to try again. Never a raw code. */
export function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Check your connection and try again.';
  switch (e.code) {
    case 'REASONING_DAILY_LIMIT_REACHED': {
      const limit = (e.details as { limit?: unknown } | undefined)?.limit;
      return `You have used today’s ${typeof limit === 'number' ? `${limit} ` : ''}evaluations. Your answer was not submitted and is kept in this tab; evaluations reset at ${resetText(resetOf(e))}.`;
    }
    case 'REASONING_DAILY_QUESTIONS_REACHED': {
      const limit = (e.details as { limit?: unknown } | undefined)?.limit;
      return `You have opened today’s ${typeof limit === 'number' ? `${limit} ` : ''}questions. Your open questions stay available; new ones can be started after ${resetText(resetOf(e))}.`;
    }
    case 'LLM_BUDGET_EXCEEDED':
      return `You have reached today’s AI usage limit, so this could not start. Nothing was lost: a draft answer stays in this tab. The limit resets at ${resetText(resetOf(e))}.`;
    case 'AI_SERVICE_PAUSED':
      return `Attack Reasoning is paused for the rest of today because the platform’s daily AI budget is used up. Nothing was lost; try again after ${resetText(resetOf(e))}.`;
    case 'RATE_LIMITED':
      return `You are going a little fast. Try again ${waitText(e.retryAfterSec)}.`;
    default:
      return MESSAGES[e.code ?? ''] ?? e.message;
  }
}
/** The engine's answer for an attempt that does not exist or is someone else's (404, never 403), or for an id in the link that is not a UUID (422): a not-found page, not an error with a Retry. */
export const isNotFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.code === 'VALIDATION_FAILED');
/** Why a generation or evaluation step failed, for an attempt in a failed state (its code only). */
export function FAILURE_MESSAGE(code: string): string {
  if (code === 'LLM_BUDGET_EXCEEDED') return `Today’s AI usage limit was reached before this step could run. Retry after ${resetText()}; that retry does not count against the retry limit.`;
  if (code === 'AI_SERVICE_PAUSED') return `The platform’s daily AI budget ran out before this step could run. Retry after ${resetText()}; that retry does not count against the retry limit.`;
  return MESSAGES[code] ?? 'This step failed. You can retry it.';
}

async function engine<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1/reasoning${path}`, { method, credentials: 'include', cache: 'no-store', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach ThreatReady. Check your connection and retry.'); }
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 401) { signIn(); throw new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'); }
  // The engine's envelope { error: { code, message, details } }, or a gateway's flat { error: '…', code }.
  const err = json?.error;
  const code: string | undefined = typeof err === 'object' && err ? err.code : typeof json?.code === 'string' ? json.code : undefined;
  const message: string | undefined = typeof err === 'object' && err ? err.message : typeof err === 'string' ? err : undefined;
  if (res.status === 403 && code === 'AUTH_ACCOUNT_REQUIRED') { signUp(); throw new ApiError(403, message ?? 'Attack Reasoning needs a ThreatReady account.', code); }
  if (!res.ok) {
    const wait = retryAfterOf(res);
    const fallback = res.status === 429 ? `You are going a little fast. Try again ${waitText(wait)}.` : res.status === 503 ? `The assessment service is briefly unavailable. Try again ${waitText(wait)}.` : res.status >= 500 ? 'The assessment service had a problem. Try again in a moment.' : 'That did not work. Reload the page and try again.';
    throw new ApiError(res.status, message || fallback, code ?? (res.status === 429 ? 'RATE_LIMITED' : undefined), { retryAfterSec: wait, details: typeof err === 'object' && err ? err.details : undefined });
  }
  return json as T;
}

/**
 * A v4 UUID for submission ids. crypto.randomUUID exists only in secure contexts (HTTPS, localhost)
 * and newer browsers; getRandomValues works everywhere, and the engine requires a real UUID (audit TR-60).
 */
export function uuid(c: { getRandomValues<T extends ArrayBufferView>(a: T): T; randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const reasoning = {
  domains: () => engine<DomainView[]>('GET', '/domains'),
  dashboard: () => engine<Dashboard>('GET', '/dashboard'),
  list: (cursor?: string) => engine<{ items: AttemptSummary[]; nextCursor: string | null }>('GET', `/attempts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  /** `skipOldest`: the learner confirmed that starting this skips their oldest unanswered question (it counts as 0). */
  create: (domain: DomainKey, difficulty?: Difficulty, skipOldest?: boolean) => engine<AttemptView>('POST', '/attempts', skipOldest ? { domain, difficulty, skipOldest } : { domain, difficulty }),
  /** Ready questions in the shared pool this learner has not seen; asks the server to restock when low. `refilling`: more are on their way without starting one. */
  pool: (domain: DomainKey, difficulty?: Difficulty) => engine<PoolStatus>('POST', '/attempts/prefetch', { domain, difficulty }),
  abandon: (id: string) => engine<AttemptView>('POST', `/attempts/${encodeURIComponent(id)}/abandon`),
  get: (id: string) => engine<AttemptView>('GET', `/attempts/${encodeURIComponent(id)}`),
  submit: (id: string, selectedOption: OptionId, justification: string, clientSubmissionId: string) => engine<AttemptView>('POST', `/attempts/${encodeURIComponent(id)}/submit`, { selectedOption, justification, clientSubmissionId }),
  retry: (id: string) => engine<AttemptView>('POST', `/attempts/${encodeURIComponent(id)}/retry`),
  result: (id: string) => engine<Result>('GET', `/attempts/${encodeURIComponent(id)}/result`),
};

/**
 * Starts the next question. At the open-question limit the server refuses to skip the oldest
 * unanswered question (which counts as 0) unasked: the learner is asked, with the server's wording
 * naming that question, and only a yes starts it. Null: the learner said no (audit BIZ-09).
 */
export async function startQuestion(domain: DomainKey, difficulty: Difficulty, confirm: (message: string) => boolean = (m) => window.confirm(m)): Promise<AttemptView | null> {
  try {
    return await reasoning.create(domain, difficulty);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'REASONING_SKIP_CONFIRMATION_REQUIRED')) throw e;
    if (!confirm(`${e.message} Start the new question anyway?`)) return null;
    return reasoning.create(domain, difficulty, true);
  }
}

export const DIMENSION_SHORT: Record<DimensionKey, string> = { correctness: 'Decision', reasoning: 'Reasoning', architecture: 'Architecture', risk: 'Risk & trade-offs' };
export const DOMAIN_SLUG = (key: string) => key.replace(/_/g, '-');
export const DOMAIN_KEY = (slug: string) => slug.replace(/-/g, '_');

/**
 * An assessment session: from Start on a domain page until End. Next and Skip continue it. Kept in
 * this tab's sessionStorage; the summary page reads its start time from the URL, so it is linkable.
 */
export interface AssessmentSession { domain: string; difficulty: Difficulty; startedAt: string }
const SESSION_KEY = 'ar-assessment-session';
export const beginSession = (domain: string, difficulty: Difficulty): AssessmentSession => {
  const s = { domain, difficulty, startedAt: new Date(Date.now() - 1000).toISOString() };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  return s;
};
export const currentSession = (): AssessmentSession | null => { try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return v && typeof v.startedAt === 'string' ? v : null; } catch { return null; } };
export const endSession = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } };

/** The learner's chosen difficulty per domain, remembered in this browser. */
export const rememberedDifficulty = (domain: string): Difficulty => { try { const v = localStorage.getItem(`ar-difficulty:${domain}`); return v === 'beginner' || v === 'advanced' ? v : 'intermediate'; } catch { return 'intermediate'; } };
export const rememberDifficulty = (domain: string, d: Difficulty) => { try { localStorage.setItem(`ar-difficulty:${domain}`, d); } catch { /* storage unavailable */ } };
