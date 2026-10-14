import { Inject, Injectable } from '@nestjs/common';
import type { CandidateProfile, JobProfile, Recommendation } from '@threatready/contracts';
import { candidateProfiles, interviewSessions, jobDescriptions, jobProfiles, resumes } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import { ContentService } from '../../platform/content/content.service.js';
import { Database } from '../../platform/db/database.js';
import { logger } from '../../platform/logging/logger.js';
import { LlmService, type CallMeta } from '../ai/llm.service.js';
import { quoteIsIn } from '../ai/prompts/common.js';
import {
  candidateProfileSchema,
  gapAnalysisRequest,
  gapAnalysisSchema,
  jdParseRequest,
  jobProfileSchema,
  PARSE_PROMPT_VERSION,
  PARSER_VERSION,
  resumeParseRequest,
  type GapAnalysis,
} from '../ai/prompts/documents.prompts.js';
import { recommend } from './recommendation.js';

/** Stored on interview_sessions.analysis. */
export interface SessionAnalysis {
  roleTitle: string;
  candidate: CandidateProfile;
  job: JobProfile;
  gaps: GapAnalysis;
  recommendation: Recommendation;
  /** Set at planning time when the candidate confirmed or corrected the profiles. */
  confirmedAt?: string;
}

export const analysisOf = (s: { analysis: unknown }) => s.analysis as SessionAnalysis | null;

/**
 * Worker job: resume and JD -> profiles -> gap analysis (ADD LLD-4). Raw document text crosses to
 * the LLM once per (document, text hash, parser version); later prompts carry only the profiles.
 */
@Injectable()
export class AnalysisService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(ContentService) private readonly content: ContentService,
  ) {}

  async run(sessionId: string, isFinalAttempt: boolean): Promise<void> {
    const [s] = await this.db.system(({ db }) => db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)));
    if (!s || s.state !== 'parsing') return; // idempotent: already analysed, cancelled or failed
    const meta: CallMeta = { feature: 'interview.analysis', owner: { userId: s.userId, orgId: s.orgId }, sourceId: s.id, budget: 'new_interview' };
    const c = this.content.interview;

    try {
      const [resume] = await this.db.system(({ db }) => db.select().from(resumes).where(eq(resumes.id, s.resumeId!)));
      const [jd] = await this.db.system(({ db }) => db.select().from(jobDescriptions).where(eq(jobDescriptions.id, s.jobDescriptionId!)));
      if (!resume?.extractedText || !resume.textHash) throw new DomainError('RESUME_NOT_FOUND');
      if (!jd?.extractedText || !jd.textHash) throw new DomainError('JD_NOT_FOUND');

      const candidate = await this.candidateProfile(meta, resume);
      const job = await this.jobProfile(meta, jd);

      const gapSchema = gapAnalysisSchema(c);
      const { value: raw } = await this.llm.structured(meta, gapAnalysisRequest(c, candidate.profile, job.profile), gapSchema);
      const gaps: GapAnalysis = {
        ...raw,
        // Every claim's evidence must be a verbatim substring of the resume (ADD §7 quote check).
        claims_to_verify: raw.claims_to_verify.filter((cl) => quoteIsIn(cl.evidence_quote, resume.extractedText!)),
      };
      const analysis: SessionAnalysis = {
        roleTitle: job.profile.title,
        candidate: candidate.profile,
        job: job.profile,
        gaps,
        recommendation: recommend(c, job.profile, candidate.profile),
      };
      await this.db.system(({ db }) =>
        db
          .update(interviewSessions)
          .set({ state: 'profiled', analysis, candidateProfileId: candidate.id, jobProfileId: job.id, updatedAt: new Date(), lastActivityAt: new Date() })
          .where(and(eq(interviewSessions.id, sessionId), eq(interviewSessions.state, 'parsing'))),
      );
    } catch (err) {
      const terminal = err instanceof DomainError && !err.retryable;
      if (terminal || isFinalAttempt) {
        const code = err instanceof DomainError && err.code !== 'LLM_OUTPUT_INVALID' ? err.code : 'PARSE_FAILED';
        await this.markFailed(sessionId, code);
        logger.warn({ session_id: sessionId, code }, 'analysis failed');
        return;
      }
      throw err; // the queue retries once (two parse attempts, LLD-3)
    }
  }

  async markFailed(sessionId: string, code: string): Promise<void> {
    await this.db.system(({ db }) =>
      db
        .update(interviewSessions)
        .set({ state: 'failed', failureCode: code, failureStage: 'analysis', updatedAt: new Date() })
        .where(and(eq(interviewSessions.id, sessionId), eq(interviewSessions.state, 'parsing'))),
    );
  }

  private async candidateProfile(meta: CallMeta, resume: typeof resumes.$inferSelect) {
    const [cached] = await this.db.system(({ db }) =>
      db
        .select()
        .from(candidateProfiles)
        .where(and(eq(candidateProfiles.resumeId, resume.id), eq(candidateProfiles.textHash, resume.textHash!), eq(candidateProfiles.parserVersion, PARSER_VERSION))),
    );
    if (cached) return { id: cached.id, profile: cached.profile as CandidateProfile };

    const c = this.content.interview;
    const { value } = await this.llm.structured(meta, resumeParseRequest(c, resume.extractedText!), candidateProfileSchema(c));
    // Drop evidence quotes that are not verbatim in the resume; keep the skill with no evidence.
    const profile: CandidateProfile = {
      ...value,
      skills: value.skills.map((sk) => ({ ...sk, evidence: sk.evidence.filter((e) => quoteIsIn(e.quote, resume.extractedText!)) })),
    };
    const [row] = await this.db.system(({ db }) =>
      db
        .insert(candidateProfiles)
        .values({
          orgId: resume.orgId,
          userId: resume.userId,
          resumeId: resume.id,
          textHash: resume.textHash!,
          profile,
          parserVersion: PARSER_VERSION,
          promptVersion: PARSE_PROMPT_VERSION,
          model: this.llm.modelFor('SMALL'),
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (row) return { id: row.id, profile };
    const [again] = await this.db.system(({ db }) =>
      db.select().from(candidateProfiles).where(and(eq(candidateProfiles.resumeId, resume.id), eq(candidateProfiles.textHash, resume.textHash!))),
    );
    return { id: again!.id, profile: again!.profile as CandidateProfile };
  }

  private async jobProfile(meta: CallMeta, jd: typeof jobDescriptions.$inferSelect) {
    const [cached] = await this.db.system(({ db }) =>
      db
        .select()
        .from(jobProfiles)
        .where(and(eq(jobProfiles.jobDescriptionId, jd.id), eq(jobProfiles.textHash, jd.textHash!), eq(jobProfiles.parserVersion, PARSER_VERSION))),
    );
    if (cached) return { id: cached.id, profile: cached.profile as JobProfile };

    const c = this.content.interview;
    const { value } = await this.llm.structured(meta, jdParseRequest(c, jd.extractedText!), jobProfileSchema(c));
    const [row] = await this.db.system(({ db }) =>
      db
        .insert(jobProfiles)
        .values({
          orgId: jd.orgId,
          userId: jd.userId,
          jobDescriptionId: jd.id,
          textHash: jd.textHash!,
          profile: value,
          parserVersion: PARSER_VERSION,
          promptVersion: PARSE_PROMPT_VERSION,
          model: this.llm.modelFor('SMALL'),
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (row) return { id: row.id, profile: value };
    const [again] = await this.db.system(({ db }) =>
      db.select().from(jobProfiles).where(and(eq(jobProfiles.jobDescriptionId, jd.id), eq(jobProfiles.textHash, jd.textHash!))),
    );
    return { id: again!.id, profile: again!.profile as JobProfile };
  }
}
