import type { ZodType } from 'zod';
import {
  CreateTextDocumentRequest,
  CreateUploadRequest,
  CreateUploadResponse,
  DocumentView,
  UpdateDocumentTextRequest,
} from '../documents.js';
import {
  Briefing,
  ClarifyRequest,
  CreateInterviewRequest,
  EndInterviewRequest,
  PlanInterviewRequest,
  SessionList,
  SessionView,
  SubmitAnswerRequest,
} from '../interviews.js';
import { InterviewDashboard, InterviewReport, SignedDownload, SkillProgress } from '../reports.js';
import { Me, PlatformApps } from '../platform.js';
import {
  CreateReasoningAttemptRequest,
  ReasoningAttemptList,
  ReasoningAttemptView,
  ReasoningDashboard,
  ReasoningDomainView,
  ReasoningResult,
  SubmitReasoningRequest,
} from '../reasoning.js';
import { z } from '../zod.js';

export type Permission =
  | 'document:write'
  | 'document:read'
  | 'interview:create'
  | 'interview:read'
  | 'interview:take'
  | 'report:read'
  | 'skills:read'
  | 'reasoning:take'
  | 'reasoning:read';

/** Rate-limit classes for the tier-2 token buckets (ADD L12). */
export type RateClass = 'general' | 'upload' | 'interview_turn' | 'interview_create' | 'reasoning_create';

export interface RouteContract {
  id: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  summary: string;
  permission: Permission;
  rateClass: RateClass;
  body?: ZodType;
  response?: ZodType;
  /** text/event-stream responses */
  stream?: boolean;
  /** application/octet-stream responses */
  binary?: boolean;
  status?: number;
}

const json = <T extends ZodType>(s: T) => s;

/** Every InterviewPrep route. The API asserts at boot that each controller route appears here. */
export const ROUTES: RouteContract[] = [
  { id: 'createUpload', method: 'post', path: '/v1/documents', summary: 'Create a document and a presigned upload into quarantine', permission: 'document:write', rateClass: 'upload', body: CreateUploadRequest, response: CreateUploadResponse, status: 201 },
  { id: 'createTextDocument', method: 'post', path: '/v1/documents/text', summary: 'Create a job description from pasted text', permission: 'document:write', rateClass: 'upload', body: CreateTextDocumentRequest, response: DocumentView, status: 201 },
  { id: 'completeUpload', method: 'post', path: '/v1/documents/{id}/complete', summary: 'Confirm the browser finished uploading; queues extraction', permission: 'document:write', rateClass: 'general', response: DocumentView, status: 202 },
  { id: 'getDocument', method: 'get', path: '/v1/documents/{id}', summary: 'Document status and redacted extracted text', permission: 'document:read', rateClass: 'general', response: DocumentView },
  { id: 'updateDocumentText', method: 'patch', path: '/v1/documents/{id}/text', summary: 'Correct extraction errors in the text', permission: 'document:write', rateClass: 'general', body: UpdateDocumentTextRequest, response: DocumentView },
  { id: 'deleteDocument', method: 'delete', path: '/v1/documents/{id}', summary: 'Delete a document and its file', permission: 'document:write', rateClass: 'general', status: 204 },

  { id: 'createInterview', method: 'post', path: '/v1/interviews', summary: 'Create a session; queues resume and JD analysis', permission: 'interview:create', rateClass: 'interview_create', body: CreateInterviewRequest, response: SessionView, status: 202 },
  { id: 'listInterviews', method: 'get', path: '/v1/interviews', summary: 'Interview history, newest first', permission: 'interview:read', rateClass: 'general', response: SessionList },
  { id: 'getInterview', method: 'get', path: '/v1/interviews/{id}', summary: 'Session state, progress, timer and transcript (refresh recovery)', permission: 'interview:read', rateClass: 'general', response: SessionView },
  { id: 'streamInterviewEvents', method: 'get', path: '/v1/interviews/{id}/events', summary: 'SSE stream of session state changes (analysis and report jobs)', permission: 'interview:read', rateClass: 'general', stream: true },
  { id: 'getBriefing', method: 'get', path: '/v1/interviews/{id}/briefing', summary: 'Extracted profiles and recommended settings for confirmation', permission: 'interview:read', rateClass: 'general', response: Briefing },
  { id: 'planInterview', method: 'post', path: '/v1/interviews/{id}/plan', summary: 'Confirm details and configuration; builds the plan', permission: 'interview:take', rateClass: 'general', body: PlanInterviewRequest, response: SessionView },
  { id: 'startInterview', method: 'post', path: '/v1/interviews/{id}/start', summary: 'Start the interview; streams the first question', permission: 'interview:take', rateClass: 'interview_turn', stream: true },
  { id: 'askQuestion', method: 'post', path: '/v1/interviews/{id}/question', summary: 'Recover an interrupted question stream', permission: 'interview:take', rateClass: 'interview_turn', stream: true },
  { id: 'submitAnswer', method: 'post', path: '/v1/interviews/{id}/turns', summary: 'Submit an answer; streams evaluation status and the next question', permission: 'interview:take', rateClass: 'interview_turn', body: SubmitAnswerRequest, stream: true },
  { id: 'clarifyQuestion', method: 'post', path: '/v1/interviews/{id}/clarify', summary: 'Ask the interviewer a clarifying question about the current question; streams the reply', permission: 'interview:take', rateClass: 'interview_turn', body: ClarifyRequest, stream: true },
  { id: 'pauseInterview', method: 'post', path: '/v1/interviews/{id}/pause', summary: 'Pause the interview timer', permission: 'interview:take', rateClass: 'general', response: SessionView },
  { id: 'resumeInterview', method: 'post', path: '/v1/interviews/{id}/resume', summary: 'Resume a paused interview', permission: 'interview:take', rateClass: 'general', response: SessionView },
  { id: 'endInterview', method: 'post', path: '/v1/interviews/{id}/end', summary: 'End the interview and queue the report', permission: 'interview:take', rateClass: 'general', body: EndInterviewRequest, response: SessionView },
  { id: 'cancelInterview', method: 'post', path: '/v1/interviews/{id}/cancel', summary: 'Cancel a session that has not started', permission: 'interview:take', rateClass: 'general', response: SessionView },
  { id: 'getReport', method: 'get', path: '/v1/interviews/{id}/report', summary: 'The saved performance report', permission: 'report:read', rateClass: 'general', response: InterviewReport },
  { id: 'retryReport', method: 'post', path: '/v1/interviews/{id}/report/retry', summary: 'Re-queue a failed report job (idempotent)', permission: 'interview:take', rateClass: 'general', response: SessionView, status: 202 },
  { id: 'getReportPdf', method: 'get', path: '/v1/interviews/{id}/report/pdf', summary: 'Short-lived download link for the report PDF', permission: 'report:read', rateClass: 'general', response: SignedDownload },
  { id: 'getDashboard', method: 'get', path: '/v1/interview-prep/dashboard', summary: 'Dashboard aggregates from persisted data', permission: 'interview:read', rateClass: 'general', response: InterviewDashboard },
  { id: 'getInterviewerModel', method: 'get', path: '/v1/assets/interviewer-model', summary: 'The 3D interviewer model, AES-GCM encrypted per response (key and IV in X-Asset-Key / X-Asset-Iv); never cached. The licence forbids making it publicly downloadable.', permission: 'interview:read', rateClass: 'general', binary: true },
  { id: 'getPlatform', method: 'get', path: '/v1/platform', summary: 'Every ThreatReady app (names, URLs, status) for the shared header', permission: 'interview:read', rateClass: 'general', response: PlatformApps },
  { id: 'getMe', method: 'get', path: '/v1/me', summary: 'The signed-in ThreatReady user (identity from onboard.threatready.io)', permission: 'interview:read', rateClass: 'general', response: Me },
  { id: 'getMySkills', method: 'get', path: '/v1/skills/me', summary: 'Skill scores from interview evidence', permission: 'skills:read', rateClass: 'general', response: z.array(SkillProgress) },

  // Attack Reasoning (ADD L17b). Served to ar.threatready.io through its gateway; same guard chain.
  { id: 'listReasoningDomains', method: 'get', path: '/v1/reasoning/domains', summary: 'Every Attack Reasoning domain with availability and the user\'s statistics', permission: 'reasoning:read', rateClass: 'general', response: z.array(ReasoningDomainView) },
  { id: 'createReasoningAttempt', method: 'post', path: '/v1/reasoning/attempts', summary: 'Start an attempt in a domain; queues scenario generation', permission: 'reasoning:take', rateClass: 'reasoning_create', body: CreateReasoningAttemptRequest, response: ReasoningAttemptView, status: 202 },
  { id: 'listReasoningAttempts', method: 'get', path: '/v1/reasoning/attempts', summary: 'Assessment history, newest first', permission: 'reasoning:read', rateClass: 'general', response: ReasoningAttemptList },
  { id: 'getReasoningAttempt', method: 'get', path: '/v1/reasoning/attempts/{id}', summary: 'The attempt: scenario, diagram, question and options (never the answer key)', permission: 'reasoning:read', rateClass: 'general', response: ReasoningAttemptView },
  { id: 'streamReasoningEvents', method: 'get', path: '/v1/reasoning/attempts/{id}/events', summary: 'SSE stream of attempt state changes while generation or evaluation runs', permission: 'reasoning:read', rateClass: 'general', stream: true },
  { id: 'submitReasoningAnswer', method: 'post', path: '/v1/reasoning/attempts/{id}/submit', summary: 'Submit the selected option and the written justification; queues evaluation', permission: 'reasoning:take', rateClass: 'general', body: SubmitReasoningRequest, response: ReasoningAttemptView, status: 202 },
  { id: 'retryReasoningAttempt', method: 'post', path: '/v1/reasoning/attempts/{id}/retry', summary: 'Re-queue a failed generation or evaluation (idempotent)', permission: 'reasoning:take', rateClass: 'general', response: ReasoningAttemptView, status: 202 },
  { id: 'getReasoningResult', method: 'get', path: '/v1/reasoning/attempts/{id}/result', summary: 'Score breakdown and feedback once evaluated', permission: 'reasoning:read', rateClass: 'general', response: ReasoningResult },
  { id: 'getReasoningDashboard', method: 'get', path: '/v1/reasoning/dashboard', summary: 'Attack Reasoning progress and performance analytics', permission: 'reasoning:read', rateClass: 'general', response: ReasoningDashboard },
].map((r) => ({ ...r, body: r.body && json(r.body) })) as RouteContract[];

export const routeById = (id: string): RouteContract => {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown route contract ${id}`);
  return r;
};
