/**
 * Error catalogue (ADD §10). Every failure reaches the client as one envelope:
 *   { "error": { "code", "message", "request_id", "retryable" } }
 * Messages here are safe to show; they never contain provider text, SQL or stack traces.
 */
export const ERROR_CATALOGUE = {
  AUTH_REQUIRED: { http: 401, retryable: false, message: 'Sign in to continue' },
  AUTH_FORBIDDEN: { http: 403, retryable: false, message: 'You do not have permission to do that' },
  AUTH_MFA_REQUIRED: { http: 403, retryable: false, message: 'Verify with your authenticator to continue' },
  AUTH_ACCOUNT_REQUIRED: { http: 403, retryable: false, message: 'Create a ThreatReady account to use InterviewPrep' },
  AUTH_PROVIDER_UNAVAILABLE: { http: 503, retryable: true, message: 'Sign-in is temporarily unavailable, try again shortly' },
  VALIDATION_FAILED: { http: 422, retryable: false, message: 'Some fields are invalid' },
  RATE_LIMITED: { http: 429, retryable: true, message: 'Too many requests, try again shortly' },

  RESUME_TOO_LARGE: { http: 413, retryable: false, message: 'The resume is larger than the 5 MB limit' },
  RESUME_UNSUPPORTED_TYPE: { http: 415, retryable: false, message: 'Upload a PDF or DOCX resume' },
  RESUME_UNREADABLE: { http: 422, retryable: false, message: 'We could not read text from this resume' },
  RESUME_NOT_FOUND: { http: 404, retryable: false, message: 'Resume not found' },
  JD_TOO_SHORT: { http: 422, retryable: false, message: 'The job description is too short to analyse' },
  JD_UNREADABLE: { http: 422, retryable: false, message: 'We could not read text from this job description' },
  JD_NOT_FOUND: { http: 404, retryable: false, message: 'Job description not found' },
  DOCUMENT_NOT_READY: { http: 409, retryable: true, message: 'The document is still being processed' },
  TEXT_TOO_LONG: { http: 413, retryable: false, message: 'The text is longer than the 30,000-character limit' },
  PARSE_IN_PROGRESS: { http: 409, retryable: true, message: 'Analysis is still in progress' },
  PARSE_FAILED: { http: 422, retryable: false, message: 'We could not analyse these documents' },

  LLM_TIMEOUT: { http: 504, retryable: true, message: 'The interviewer took too long to respond' },
  LLM_PROVIDER_UNAVAILABLE: { http: 503, retryable: true, message: 'The AI service is temporarily unavailable' },
  LLM_OUTPUT_INVALID: { http: 502, retryable: true, message: 'The AI service returned an unusable response' },
  LLM_BUDGET_EXCEEDED: { http: 429, retryable: false, message: 'The AI usage limit for this period has been reached' },
  AI_SERVICE_PAUSED: { http: 503, retryable: true, message: 'New interviews are paused for today; live interviews can finish' },

  INTERVIEW_SESSION_NOT_FOUND: { http: 404, retryable: false, message: 'Interview session not found' },
  INTERVIEW_SESSION_EXPIRED: { http: 410, retryable: false, message: 'This interview session has expired' },
  INTERVIEW_INVALID_STATE: { http: 409, retryable: false, message: 'That action is not available at this point in the interview' },
  INTERVIEW_LIMIT_REACHED: { http: 409, retryable: false, message: 'You have reached your interview limit' },
  INTERVIEW_TURN_IN_PROGRESS: { http: 409, retryable: true, message: 'Your previous answer is still being processed' },
  INTERVIEW_ANSWER_TOO_LONG: { http: 422, retryable: false, message: 'Answers are limited to 4,000 characters' },
  INTERVIEW_PAUSE_LIMIT_REACHED: { http: 409, retryable: false, message: 'You have used every pause allowed in this interview' },
  CLARIFICATION_LIMIT_REACHED: { http: 409, retryable: false, message: 'You can ask up to three clarifying questions per question' },
  REPORT_NOT_READY: { http: 409, retryable: true, message: 'The report is not ready yet' },
  REPORT_RETRY_LIMIT_REACHED: { http: 409, retryable: false, message: 'We could not generate this report after several attempts. Your answers are saved; contact support with the reference.' },

  REASONING_ATTEMPT_NOT_FOUND: { http: 404, retryable: false, message: 'Assessment attempt not found' },
  REASONING_DOMAIN_UNAVAILABLE: { http: 404, retryable: false, message: 'This domain is not available yet' },
  REASONING_INVALID_STATE: { http: 409, retryable: false, message: 'That action is not available at this point in the assessment' },
  REASONING_LIMIT_REACHED: { http: 409, retryable: false, message: 'Finish your open assessment before starting another' },
  REASONING_JUSTIFICATION_REQUIRED: { http: 422, retryable: false, message: 'Explain why you chose that option before submitting' },
  REASONING_ANSWER_TOO_LONG: { http: 422, retryable: false, message: 'Justifications are limited to 4,000 characters' },
  REASONING_GENERATION_FAILED: { http: 502, retryable: true, message: 'We could not generate a valid scenario this time; retry to generate another' },
  REASONING_EVALUATION_FAILED: { http: 502, retryable: true, message: 'Your answer is saved but could not be evaluated yet; retry the evaluation' },
  REASONING_DAILY_LIMIT_REACHED: { http: 429, retryable: false, message: 'You have used today’s evaluations; your answer is kept, submit it after the daily reset' },
  REASONING_DAILY_QUESTIONS_REACHED: { http: 429, retryable: false, message: 'You have opened today’s questions; new ones are available after the daily reset' },
  REASONING_RETRY_LIMIT_REACHED: { http: 409, retryable: false, message: 'This step has already been retried the maximum number of times; start a new question' },
  REASONING_SKIP_CONFIRMATION_REQUIRED: { http: 409, retryable: false, message: 'Starting another question skips your oldest unanswered one, which counts as 0; confirm to continue' },

  ENTITLEMENT_REQUIRED: { http: 402, retryable: false, message: 'Your plan does not include this feature' },
  ENTITLEMENT_QUOTA_EXCEEDED: { http: 403, retryable: false, message: 'Your plan quota for this period is used up' },

  STORAGE_UPLOAD_EXPIRED: { http: 410, retryable: false, message: 'The upload link has expired; start the upload again' },
  STORAGE_OBJECT_NOT_FOUND: { http: 404, retryable: false, message: 'The uploaded file was not found' },
  STORAGE_UNAVAILABLE: { http: 503, retryable: true, message: 'File storage is temporarily unavailable' },
  STORAGE_UPLOAD_CONFLICT: { http: 409, retryable: false, message: 'This upload link has already been used; start the upload again' },

  ASSET_NOT_AVAILABLE: { http: 404, retryable: false, message: 'This asset is not available' },

  INTERNAL_ERROR: { http: 500, retryable: true, message: 'Something went wrong on our side' },
} as const satisfies Record<string, { http: number; retryable: boolean; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; request_id: string; retryable: boolean; details?: unknown; retry_after_sec?: number };
}

/**
 * A domain failure with one catalogue code. Thrown by services, mapped to the envelope by the API filter.
 * `retryAfterSec` becomes the Retry-After header (429 and 503 always carry one); `retryable` overrides the
 * catalogue for one instance, e.g. a rate limit whose window is an hour is not worth an automatic retry.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryAfterSec?: number;
  private readonly retryableOverride?: boolean;
  constructor(code: ErrorCode, opts: { details?: unknown; cause?: unknown; message?: string; retryable?: boolean; retryAfterSec?: number } = {}) {
    super(opts.message ?? ERROR_CATALOGUE[code].message, { cause: opts.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = opts.details;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = Math.max(1, Math.ceil(opts.retryAfterSec));
    this.retryableOverride = opts.retryable;
  }
  get http(): number {
    return ERROR_CATALOGUE[this.code].http;
  }
  get retryable(): boolean {
    return this.retryableOverride ?? ERROR_CATALOGUE[this.code].retryable;
  }
}

/** Seconds until the next UTC midnight, when the daily AI budgets reset. */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export type PortErrorKind =
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_output'
  | 'refusal'
  | 'bad_request'
  | 'not_found'
  | 'auth';

/** Thrown by adapters (ADD LLD-19): a kind, a retry flag and the cause. Never shown to users. */
export class PortError extends Error {
  readonly kind: PortErrorKind;
  readonly retryable: boolean;
  constructor(kind: PortErrorKind, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'PortError';
    this.kind = kind;
    this.retryable = opts.retryable ?? (kind === 'timeout' || kind === 'unavailable' || kind === 'rate_limited');
  }
}

export function llmPortErrorToDomain(err: PortError): DomainError {
  switch (err.kind) {
    case 'timeout':
      return new DomainError('LLM_TIMEOUT', { cause: err });
    case 'invalid_output':
    case 'refusal':
      return new DomainError('LLM_OUTPUT_INVALID', { cause: err });
    default:
      return new DomainError('LLM_PROVIDER_UNAVAILABLE', { cause: err });
  }
}
