import { AI_CONSENT_VERSION } from '@threatready/contracts';
import type {
  Briefing,
  CreateUploadResponse,
  DocumentKind,
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
  ) {
    super(message);
  }
}

/** Messages come from a client catalogue keyed by code; the server message is the fallback. */
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Your session has ended. Sign in again to continue.',
  AUTH_ACCOUNT_REQUIRED: 'InterviewPrep needs a ThreatReady account. Create one to continue.',
  AUTH_PROVIDER_UNAVAILABLE: 'Sign-in is briefly unavailable. Try again in a moment.',
  RATE_LIMITED: 'You are going a little fast. Wait a moment and try again.',
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
  ENTITLEMENT_QUOTA_EXCEEDED: 'You have used this month’s interview quota.',
  INTERVIEW_TURN_IN_PROGRESS: 'Your previous answer is still being processed.',
  INTERVIEW_ANSWER_TOO_LONG: 'Answers are limited to 4,000 characters.',
  STORAGE_UPLOAD_EXPIRED: 'The upload link expired. Choose the file again.',
};

export const messageFor = (e: unknown): string =>
  e instanceof ApiError ? (MESSAGES[e.code] ?? e.message) : 'Something went wrong. Check your connection and try again.';

async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id');
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; retryable: boolean; request_id: string; details?: unknown } };
    if (body.error) return new ApiError(body.error.code, body.error.message, res.status, body.error.retryable, body.error.request_id ?? requestId, body.error.details);
  } catch {
    /* not JSON */
  }
  return new ApiError('INTERNAL_ERROR', 'Unexpected response from the server', res.status, res.status >= 500, requestId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries only when the envelope says retryable: three attempts, backoff with jitter. */
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
    if (err.retryable && attempt < 2 && err.code !== 'INTERVIEW_TURN_IN_PROGRESS') {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 500 * 2 ** attempt + Math.random() * 400);
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
};

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
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status === 403 ? 'STORAGE_UPLOAD_EXPIRED' : 'STORAGE_UNAVAILABLE', 'Upload failed', xhr.status, xhr.status >= 500, null)));
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Upload failed', 0, true, null));
    xhr.send(form);
  });
}
