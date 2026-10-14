import type { SqlExecutor } from '../db/database.js';

export const JOBS = {
  documentExtract: 'document.extract',
  interviewAnalyse: 'interview.analyse',
  interviewFinalScoring: 'interview.final_scoring',
  reportPdf: 'interview.report_pdf',
  skillsRecalculate: 'skills.recalculate',
  emailSend: 'email.send',
  interviewSweep: 'interview.sweep',
  deadLetter: 'dead_letter',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobContext {
  jobId: string;
  retryCount: number;
}

/** ADD §6 QueuePort. `tx` makes the enqueue part of the caller's transaction. */
export interface QueuePort {
  enqueue<T extends object>(job: JobName, data: T, opts: { key: string; runAt?: Date }, tx?: { queueSql: SqlExecutor }): Promise<void>;
  schedule(job: JobName, cron: string): Promise<void>;
  work<T>(job: JobName, handler: (data: T, ctx: JobContext) => Promise<void>): Promise<void>;
}

export const QUEUE_PORT = Symbol('QueuePort');
