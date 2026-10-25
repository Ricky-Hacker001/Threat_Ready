import { AI_CONSENT_VERSION } from '@threatready/contracts';
import type {
  Briefing,
  CreateUploadResponse,
  DocumentKind,
  DocumentList,
  DocumentView,
  InterviewDashboard,
  InterviewReport,
  Me,
  PlanInterviewRequest,
  PlatformApps,
  SessionList,
  SessionView,
  SignedDownload,
  SkillProgress,
  TabHiddenRequest,
  TurnStreamEvent,
  UploadContentType,
} from '@threatready/contracts';

/** Client-side mirror of the API error envelope (ADD §10). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly requestId: string | null,
    readonly details?: unknown,
    /** When the server said to try again (epoch ms, from Retry-After), or null when it didn't say. */
    readonly retryAt: number | null = null,
  ) {
    super(message);
  }
}

/** Longer waits are shown as this (a week): a bad clock or header must not print a nonsense date. */
const MAX_RETRY_WAIT_MS = 7 * 24 * 3600_000;
const clampWait = (ms: number) => Math.min(Math.max(0, ms), MAX_RETRY_WAIT_MS);

/**
 * Retry-After in ms from now: delta-seconds (a fraction is tolerated) or an HTTP date; null when
 * absent or unreadable. Bare numbers never go through Date.parse, which reads "5.5" as a date.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return clampWait(Math.ceil(Number(v)) * 1000);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? clampWait(at - now) : null;
}

/** retry_after_sec from an error envelope or stream event, as an epoch-ms retryAt (null when unusable). */
export function retryAtFromSeconds(sec: unknown, now = Date.now()): number | null {
  return typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 ? now + clampWait(Math.ceil(sec) * 1000) : null;
}

/** Waits up to this long are retried automatically; a longer Retry-After is shown to the learner instead. */
const AUTO_RETRY_MAX_WAIT_MS = 10_000;

/** Messages come from a client catalogue keyed by code; the server message is the fallback. */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your session has ended. Sign in again to continue.',
  AUTH_ACCOUNT_REQUIRED: 'InterviewPrep needs a ThreatReady account. Create one to continue.',
  AUTH_PROVIDER_UNAVAILABLE: 'Sign-in is briefly unavailable. Try again in a moment.',
  RATE_LIMITED: 'You are going a little fast. Wait a moment and try again.',
  NETWORK_ERROR: 'We could not reach ThreatReady. Check your connection and try again.',
  SERVICE_UNAVAILABLE: 'InterviewPrep is briefly unavailable. Try again in a moment.',
  // The platform gateway's own answers while InterviewPrep starts, restarts or stalls (deploy/gateway.mjs).
  STARTING: 'InterviewPrep is starting up. Try again in a few seconds.',
  UPSTREAM_UNAVAILABLE: 'InterviewPrep is restarting. Try again shortly.',
  UPSTREAM_TIMEOUT: 'InterviewPrep took too long to answer. Try again in a moment.',
  RESUME_TOO_LARGE: 'That file is larger than 5 MB.',
  RESUME_UNSUPPORTED_TYPE: 'Upload a PDF or DOCX file.',
  RESUME_UNREADABLE: 'We could not read text from that file.',
  JD_TOO_SHORT: 'The job description needs at least 200 characters.',
  JD_UNREADABLE: 'We could not read text from that job description.',
  PARSE_FAILED: 'We could not analyse these documents. Check the extracted text and try again.',
  LLM_TIMEOUT: 'The interviewer took too long to respond. Try again.',
  LLM_PROVIDER_UNAVAILABLE: 'The AI service is temporarily unavailable. Your progress is saved.',
  LLM_OUTPUT_INVALID: 'The AI service returned an unusable response. Try again.',
  LLM_BUDGET_EXCEEDED: 'You have reached today’s AI usage limit. Your progress is saved.',
  AI_SERVICE_PAUSED: 'New interviews are paused for today. Interviews already in progress can finish.',
  INTERVIEW_LIMIT_REACHED: 'Finish or cancel an open interview before starting another.',
  REPORT_RETRY_LIMIT_REACHED: 'We could not generate this report after several tries. Your answers are saved; contact support and quote the reference below.',
  CLARIFICATION_LIMIT_REACHED: 'You can ask up to three clarifying questions per question.',
  ENTITLEMENT_QUOTA_EXCEEDED: 'You have used this month’s interview quota.',
  INTERVIEW_TURN_IN_PROGRESS: 'Your previous answer is still being processed.',
  INTERVIEW_ANSWER_TOO_LONG: 'Answers are limited to 4,000 characters.',
  INTERVIEW_PAUSE_LIMIT_REACHED: 'You have used every pause allowed in this interview.',
  STORAGE_UPLOAD_EXPIRED: 'The upload link expired. Choose the file again.',
  STORAGE_UPLOAD_CONFLICT: 'This upload was already sent. Choose the file again to upload it once more.',
  TEXT_TOO_LONG: 'That text is longer than 30,000 characters. Shorten it and try again.',
  STORAGE_UNAVAILABLE: 'The upload did not go through. Check your connection and choose the file again.',
};

/** "in 40 seconds", "in about 12 minutes", "at 4:05 pm", "on 24 Oct at 9:00 am": when the learner can try again. */
export function whenRetry(retryAt: number, now = Date.now()): string {
  if (!Number.isFinite(retryAt)) return 'later';
  const s = Math.round(clampWait(retryAt - now) / 1000);
  if (s < 60) return s <= 1 ? 'in a moment' : `in ${s} seconds`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `in about ${m} minute${m === 1 ? '' : 's'}`;
  }
  const at = new Date(now + clampWait(retryAt - now));
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date(now).toDateString() ? `at ${time}` : `on ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

/** Limits and outages with a Retry-After say when to try again, never just "wait a moment". */
const WAIT_MESSAGES: Record<string, (when: string) => string> = {
  RATE_LIMITED: (when) => `You have reached the limit for this for now. You can try again ${when}.`,
  AUTH_PROVIDER_UNAVAILABLE: (when) => `Sign-in is briefly unavailable. Try again ${when}.`,
  SERVICE_UNAVAILABLE: (when) => `InterviewPrep is briefly unavailable. Try again ${when}.`,
  STARTING: (when) => `InterviewPrep is starting up. Try again ${when}.`,
  UPSTREAM_UNAVAILABLE: (when) => `InterviewPrep is restarting. Try again ${when}.`,
  UPSTREAM_TIMEOUT: (when) => `InterviewPrep took too long to answer. Try again ${when}.`,
};

/** The message's own closing "try again …" clause, which a retry time replaces instead of repeating. */
const TRY_AGAIN_CLAUSE = /\b(try again)\b[^.!?]*[.!?]?\s*$/i;

export function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Check your connection and try again.';
  const base = MESSAGES[e.code] ?? e.message;
  // Only limits and outages (429/503, also as stream errors) carry a retry time.
  if (e.retryAt == null) return base;
  const when = whenRetry(e.retryAt);
  // Sign-in checks queued for a shared network (a classroom behind one address): not this learner's own limit.
  if (e.code === 'RATE_LIMITED' && (e.details as { reason?: unknown } | undefined)?.reason === 'busy') return `Many people on your network are signing in at once. Try again ${when}.`;
  const wait = WAIT_MESSAGES[e.code];
  if (wait) return wait(when);
  // "… Try again in a moment." becomes "… Try again in 40 seconds.", never "… Try again in a moment. Try again in 40 seconds."
  if (TRY_AGAIN_CLAUSE.test(base)) return base.replace(TRY_AGAIN_CLAUSE, (_m, t: string) => `${t} ${when}.`);
  return `${base.replace(/\s*$/, '')} Try again ${when}.`;
}

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id');
  const wait = retryAfterMs(res.headers.get('retry-after'));
  const retryAt = wait == null ? null : Date.now() + wait;
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; retryable: boolean; request_id: string; details?: unknown; retry_after_sec?: number } };
    if (body.error) {
      // The envelope repeats Retry-After as retry_after_sec (a proxy can drop or hide the header).
      const at = retryAt ?? retryAtFromSeconds(body.error.retry_after_sec);
      return new ApiError(body.error.code, body.error.message, res.status, body.error.retryable, body.error.request_id ?? requestId, body.error.details, at);
    }
  } catch {
    /* not JSON */
  }
  // A proxy in front of the API (gateway, platform) can answer without the envelope.
  if (res.status === 429) return new ApiError('RATE_LIMITED', 'Too many requests', 429, true, requestId, undefined, retryAt);
  if (res.status === 503) return new ApiError('SERVICE_UNAVAILABLE', 'Service unavailable', 503, true, requestId, undefined, retryAt);
  return new ApiError('INTERNAL_ERROR', 'Unexpected response from the server', res.status, res.status >= 500, requestId, undefined, retryAt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries only when the envelope says retryable: three attempts, backoff with jitter. A Retry-After is
 * honoured in full; one longer than AUTO_RETRY_MAX_WAIT_MS is not waited out but returned (with
 * retryAt), so the page can say when to try again.
 */
async function request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (attempt < 2) {
      await sleep(400 * 2 ** attempt + Math.random() * 300);
      return request<T>(method, path, body, attempt + 1);
    }
    throw new ApiError('NETWORK_ERROR', 'Network error', 0, true, null);
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const err = await toApiError(res);
    // /v1/me reports "no session" to its caller instead; everything else sends the user to sign in.
    if (err.status === 401 && path !== '/v1/me') window.dispatchEvent(new CustomEvent('tr:auth-required'));
    if (err.code === 'AUTH_ACCOUNT_REQUIRED') window.dispatchEvent(new CustomEvent('tr:account-required'));
    const wait = err.retryAt == null ? null : Math.max(0, err.retryAt - Date.now());
    // A gateway timeout on a write may still have been applied by InterviewPrep: never send it twice.
    const mayHaveApplied = err.code === 'UPSTREAM_TIMEOUT' && method !== 'GET';
    if (err.retryable && attempt < 2 && err.code !== 'INTERVIEW_TURN_IN_PROGRESS' && !mayHaveApplied && (wait == null || wait <= AUTO_RETRY_MAX_WAIT_MS)) {
      await sleep(wait != null ? wait + Math.random() * 250 : 500 * 2 ** attempt + Math.random() * 400);
      return request<T>(method, path, body, attempt + 1);
    }
    throw err;
  }
  return (await res.json()) as T;
}

/** POST whose response is an SSE stream (ADD L5: the answer is a POST, the response streams). */
export async function streamTurn(path: string, body: unknown, onEvent: (e: TurnStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) throw await toApiError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let terminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue; // heartbeat comment
      const event = JSON.parse(data.slice(6)) as TurnStreamEvent;
      if (event.type === 'done' || event.type === 'error') terminal = true;
      onEvent(event);
    }
  }
  if (!terminal) throw new ApiError('STREAM_INTERRUPTED', 'The connection dropped before the turn finished', 0, true, null);
}

export const api = {
  me: () => request<Me>('GET', '/v1/me'),
  platform: () => request<PlatformApps>('GET', '/v1/platform'),
  dashboard: () => request<InterviewDashboard>('GET', '/v1/interview-prep/dashboard'),
  mySkills: () => request<SkillProgress[]>('GET', '/v1/skills/me'),
  listSessions: (cursor?: string) => request<SessionList>('GET', `/v1/interviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  session: (id: string) => request<SessionView>('GET', `/v1/interviews/${id}`),
  briefing: (id: string) => request<Briefing>('GET', `/v1/interviews/${id}/briefing`),
  createSession: (resumeDocumentId: string, jdDocumentId: string) =>
    request<SessionView>('POST', '/v1/interviews', { resumeDocumentId, jdDocumentId, aiProcessingConsent: { accepted: true, version: AI_CONSENT_VERSION } }),
  plan: (id: string, body: PlanInterviewRequest) => request<SessionView>('POST', `/v1/interviews/${id}/plan`, body),
  pause: (id: string) => request<SessionView>('POST', `/v1/interviews/${id}/pause`),
  resume: (id: string) => request<SessionView>('POST', `/v1/interviews/${id}/resume`),
  end: (id: string) => request<SessionView>('POST', `/v1/interviews/${id}/end`, { reason: 'candidate_ended' }),
  cancel: (id: string) => request<SessionView>('POST', `/v1/interviews/${id}/cancel`),
  report: (id: string) => request<InterviewReport>('GET', `/v1/interviews/${id}/report`),
  retryReport: (id: string) => request<SessionView>('POST', `/v1/interviews/${id}/report/retry`),
  reportPdf: (id: string) => request<SignedDownload>('GET', `/v1/interviews/${id}/report/pdf`),
  document: (id: string) => request<DocumentView>('GET', `/v1/documents/${id}`),
  createUpload: (kind: DocumentKind, contentType: UploadContentType, sizeBytes: number) =>
    request<CreateUploadResponse>('POST', '/v1/documents', { kind, contentType, sizeBytes }),
  completeUpload: (id: string) => request<DocumentView>('POST', `/v1/documents/${id}/complete`),
  pasteJd: (text: string) => request<DocumentView>('POST', '/v1/documents/text', { kind: 'jd', text }),
  updateText: (id: string, text: string) => request<DocumentView>('PATCH', `/v1/documents/${id}/text`, { text }),
  /** Deletes the document, its stored file and its extracted text (owner only; refused while an interview uses it). */
  deleteDocument: (id: string) => request<void>('DELETE', `/v1/documents/${id}`),
  /**
   * The learner's documents, newest first, without their text. An API that predates the route answers
   * 404, which `documentsListUnsupported` recognises so the page can hide the list.
   */
  listDocuments: () => request<DocumentList>('GET', '/v1/documents'),
  /** Records that the interview tab was hidden mid-interview (noted in the report). Older APIs answer 404. */
  tabHidden: (id: string, hiddenMs: number) => request<void>('POST', `/v1/interviews/${id}/tab-hidden`, { hiddenMs } satisfies TabHiddenRequest),
};

/** True when the API predates GET /v1/documents (no such route). */
export const documentsListUnsupported = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405) && !['RESUME_NOT_FOUND', 'JD_NOT_FOUND'].includes(e.code);

/** Browser -> storage upload with progress, using the presigned POST from the API. */
export function uploadToStorage(upload: CreateUploadResponse['upload'], file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.withCredentials = false;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(uploadError(xhr)));
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Upload failed', 0, true, null));
    xhr.send(form);
  });
}

/** A failed storage upload: an expired policy, a rate limit (with when to try again) or storage trouble. */
function uploadError(xhr: XMLHttpRequest): ApiError {
  let requestId: string | null = null;
  try {
    requestId = (JSON.parse(xhr.responseText) as { error?: { request_id?: string } }).error?.request_id ?? null;
  } catch {
    /* S3 answers in XML */
  }
  if (xhr.status === 403) return new ApiError('STORAGE_UPLOAD_EXPIRED', 'Upload failed', 403, false, requestId);
  if (xhr.status === 429) {
    const wait = retryAfterMs(xhr.getResponseHeader('retry-after'));
    return new ApiError('RATE_LIMITED', 'Too many uploads', 429, false, requestId, undefined, wait == null ? null : Date.now() + wait);
  }
  return new ApiError('STORAGE_UNAVAILABLE', 'Upload failed', xhr.status, xhr.status >= 500, requestId);
}
