import { z } from './zod.js';

export const InterviewType = z
  .enum(['technical', 'behavioral', 'system_design', 'coding_discussion', 'cybersecurity_scenario', 'mixed'])
  .openapi('InterviewType');
export type InterviewType = z.infer<typeof InterviewType>;

export const Difficulty = z.enum(['beginner', 'intermediate', 'advanced']).openapi('Difficulty');
export type Difficulty = z.infer<typeof Difficulty>;

export const DurationMin = z.union([z.literal(15), z.literal(30), z.literal(45)]).openapi('DurationMin');
export type DurationMin = z.infer<typeof DurationMin>;

/** realistic: no scores until the report. practice: brief feedback after each answer. */
export const InterviewMode = z.enum(['realistic', 'practice']).openapi('InterviewMode');
export type InterviewMode = z.infer<typeof InterviewMode>;

/** Cybersecurity tracks are configuration over one engine, not separate services. */
export const Track = z
  .enum(['soc_analyst', 'cloud_security', 'application_security', 'network_security', 'devsecops', 'general'])
  .openapi('Track');
export type Track = z.infer<typeof Track>;

export const SkillLevel = z.enum(['aware', 'working', 'proficient', 'expert']).openapi('SkillLevel');
export type SkillLevel = z.infer<typeof SkillLevel>;

export const Seniority = z.enum(['junior', 'mid', 'senior', 'lead']).openapi('Seniority');
export type Seniority = z.infer<typeof Seniority>;

export const RequirementWeight = z.enum(['must', 'should', 'nice']).openapi('RequirementWeight');
export type RequirementWeight = z.infer<typeof RequirementWeight>;

/**
 * Session state machine (ADD LLD-3) with two additions required by the product spec:
 * `profiled` (candidate confirms extracted details and configures) between parsing and planned.
 * The ADD's `created` state is not used because documents exist before the session.
 */
export const SessionState = z
  .enum([
    'parsing',
    'profiled',
    'planned',
    'asking',
    'awaiting_answer',
    'evaluating',
    'paused',
    'completed',
    'scoring',
    'report_ready',
    'failed',
    'expired',
    'cancelled',
  ])
  .openapi('SessionState');
export type SessionState = z.infer<typeof SessionState>;

export const TERMINAL_STATES: readonly SessionState[] = ['report_ready', 'failed', 'expired', 'cancelled'];
export const RESUMABLE_STATES: readonly SessionState[] = ['planned', 'asking', 'awaiting_answer', 'evaluating', 'paused'];

/** What the 3D interviewer shows. Derived from the session state; never stored. */
export const InterviewerStatus = z
  .enum(['preparing', 'asking', 'listening', 'evaluating', 'paused', 'finished'])
  .openapi('InterviewerStatus');
export type InterviewerStatus = z.infer<typeof InterviewerStatus>;

export const DocumentKind = z.enum(['resume', 'jd']).openapi('DocumentKind');
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DocumentStatus = z
  .enum(['awaiting_upload', 'extracting', 'extracted', 'failed'])
  .openapi('DocumentStatus');
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const UPLOAD_CONTENT_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
} as const;
export const UploadContentType = z
  .enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  .openapi('UploadContentType');
export type UploadContentType = z.infer<typeof UploadContentType>;

export const LIMITS = {
  uploadMaxBytes: 5 * 1024 * 1024,
  documentTextMaxChars: 30_000,
  jdMinChars: 200,
  answerMaxChars: 4_000,
  maxPdfPages: 15,
} as const;
