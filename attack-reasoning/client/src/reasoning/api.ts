// Client for the reasoning engine: /v1/reasoning/* on this origin (proxied to the ThreatReady monolith).
// The engine answers with the platform error envelope { error: { code, message, retryable, request_id } }.
import { ApiError, signIn, signUp } from '../api';

export type DomainKey = string;
export type OptionId = 'A' | 'B' | 'C' | 'D';
export type AttemptState = 'generating' | 'ready' | 'evaluating' | 'evaluated' | 'generation_failed' | 'evaluation_failed';
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
  id: string; domain: DomainKey; state: AttemptState; item: ItemPublic | null;
  answer: { selectedOption: OptionId; justification: string; submittedAt: string } | null;
  result: { totalScore: number; correct: boolean; confidence: 'high' | 'medium' | 'low' } | null;
  failure: { code: string; stage: 'generation' | 'evaluation' } | null;
  version: number; createdAt: string; updatedAt: string;
}
export interface AttemptSummary { id: string; domain: DomainKey; state: AttemptState; title: string | null; difficulty: string | null; totalScore: number | null; correct: boolean | null; createdAt: string; evaluatedAt: string | null }
export interface DimensionResult { key: DimensionKey; label: string; weight: number; score: number; evidence: { point: string; status: 'met' | 'partial' | 'missed'; rationale: string; quote: string | null }[]; notes: string[] }
export interface Result {
  attemptId: string; domain: DomainKey; totalScore: number; correct: boolean; selectedOption: OptionId; correctOption: OptionId;
  options: { id: OptionId; text: string; verdict: 'best' | 'plausible' | 'weak' | 'wrong'; why: string }[];
  dimensions: DimensionResult[];
  feedback: { decision: string; reasoning: string; gotRight: string[]; missed: string[]; whyBest: string; whyAlternatives: { option: OptionId; why: string }[]; architectureAnalysis: string; expertExplanation: string; improve: string[]; incorrectClaims: { claim: string; why: string }[] };
  confidence: 'high' | 'medium' | 'low'; reviewFlag: boolean; degraded: boolean; notices: string[];
  scoring: { version: string; weights: Record<DimensionKey, number>; notes: string[] }; techniques: Technique[]; concepts: string[]; evaluatedAt: string;
}
export interface DomainStats { attempts: number; evaluated: number; averageScore: number | null; bestScore: number | null; lastAttemptAt: string | null }
export interface DomainView { key: DomainKey; title: string; description: string; track: string; available: boolean; difficulty: string | null; focus: string[]; techniques: Technique[]; weights: Record<DimensionKey, number> | null; stats: DomainStats }
export interface Dashboard {
  attempts: number; evaluated: number; inProgress: number; averageScore: number | null; bestScore: number | null; correctRate: number | null;
  dimensionAverages: { key: DimensionKey; label: string; average: number | null; weight: number }[];
  scoreHistory: { attemptId: string; score: number; correct: boolean; evaluatedAt: string }[];
  recent: AttemptSummary[]; byDomain: { domain: DomainKey; title: string; stats: DomainStats }[];
}

/** Messages by engine error code; the server message is the fallback. */
const MESSAGES: Record<string, string> = {
  REASONING_LIMIT_REACHED: 'Finish your open assessment before starting another.',
  REASONING_JUSTIFICATION_REQUIRED: 'Explain why you chose that option before submitting (at least a couple of sentences).',
  REASONING_ANSWER_TOO_LONG: 'Justifications are limited to 4,000 characters.',
  REASONING_INVALID_STATE: 'That action is not available at this point in the assessment.',
  REASONING_DOMAIN_UNAVAILABLE: 'This domain is not available yet.',
  REASONING_GENERATION_FAILED: 'We could not generate a valid scenario this time. Retry to generate another.',
  REASONING_EVALUATION_FAILED: 'Your answer is saved but could not be evaluated yet. Retry the evaluation.',
  LLM_BUDGET_EXCEEDED: 'Today’s AI usage limit has been reached. Your attempt is saved; retry later.',
  AI_SERVICE_PAUSED: 'New assessments are paused for today. Attempts already in progress can finish.',
  LLM_PROVIDER_UNAVAILABLE: 'The AI service is temporarily unavailable. Your progress is saved.',
  RATE_LIMITED: 'You are going a little fast. Wait a moment and try again.',
  REASONING_ENGINE_UNAVAILABLE: 'The reasoning engine is not available right now.',
  UPSTREAM_UNAVAILABLE: 'The assessment service is restarting. Try again shortly.',
};
export const messageFor = (e: unknown): string => (e instanceof ApiError ? (MESSAGES[e.code ?? ''] ?? e.message) : 'Something went wrong. Check your connection and try again.');
export const FAILURE_MESSAGE = (code: string) => MESSAGES[code] ?? 'This step failed. You can retry it.';

async function engine<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1/reasoning${path}`, { method, credentials: 'include', cache: 'no-store', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach ThreatReady. Check your connection and retry.'); }
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 401) { signIn(); throw new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'); }
  const code: string | undefined = json?.error?.code;
  if (res.status === 403 && code === 'AUTH_ACCOUNT_REQUIRED') { signUp(); throw new ApiError(403, json.error.message, code); }
  if (!res.ok) throw new ApiError(res.status, json?.error?.message || `Request failed (${res.status})`, code);
  return json as T;
}

export const reasoning = {
  domains: () => engine<DomainView[]>('GET', '/domains'),
  dashboard: () => engine<Dashboard>('GET', '/dashboard'),
  list: (cursor?: string) => engine<{ items: AttemptSummary[]; nextCursor: string | null }>('GET', `/attempts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  create: (domain: DomainKey) => engine<AttemptView>('POST', '/attempts', { domain }),
  get: (id: string) => engine<AttemptView>('GET', `/attempts/${encodeURIComponent(id)}`),
  submit: (id: string, selectedOption: OptionId, justification: string, clientSubmissionId: string) => engine<AttemptView>('POST', `/attempts/${encodeURIComponent(id)}/submit`, { selectedOption, justification, clientSubmissionId }),
  retry: (id: string) => engine<AttemptView>('POST', `/attempts/${encodeURIComponent(id)}/retry`),
  result: (id: string) => engine<Result>('GET', `/attempts/${encodeURIComponent(id)}/result`),
};

export const DIMENSION_SHORT: Record<DimensionKey, string> = { correctness: 'Decision', reasoning: 'Reasoning', architecture: 'Architecture', risk: 'Risk & trade-offs' };
export const DOMAIN_SLUG = (key: string) => key.replace(/_/g, '-');
export const DOMAIN_KEY = (slug: string) => slug.replace(/-/g, '_');
