import { RequirementWeight, Seniority, SkillLevel, type CandidateProfile, type JobProfile } from '@threatready/contracts';
import { z } from 'zod';
import type { InterviewContent } from '../../../platform/content/content.service.js';
import type { LlmRequest, StructuredSchema } from '../../../platform/ports/llm.port.js';
import { toOutputSchema } from '../json-schema.js';
import { arr, enumOf, INJECTION_RULES, str } from './common.js';
import { untrusted } from '../json-schema.js';

export const PARSER_VERSION = 'p2.2026-10-12';
export const PARSE_PROMPT_VERSION = 'parse.v2';
export const GAP_PROMPT_VERSION = 'gap.v1';

function skillCatalogue(c: InterviewContent): string {
  return [...c.skills.values()].map((s) => `${s.id}: ${s.label} (also: ${s.aliases.slice(0, 6).join(', ')})`).join('\n');
}

// ---------- Resume -> candidate_profile (SMALL) ----------

export function candidateProfileSchema(c: InterviewContent): StructuredSchema<CandidateProfile> {
  const skillIds = [...c.skills.keys()];
  const schema = z.object({
    schema_version: z.literal('1'),
    career_stage: z.enum(['student', 'early_career', 'experienced', 'senior']).nullable(),
    headline: str(400).nullable(),
    years_experience: z
      .number()
      .nullable()
      .transform((n) => (n === null ? null : Math.min(60, Math.max(0, Math.round(n * 10) / 10)))),
    current_role: str(160).nullable(),
    roles: arr(
      z.object({
        title: str(160),
        organisation: str(160),
        kind: z.enum(['job', 'internship']),
        start: str(20).nullable(),
        end: str(20).nullable(),
        highlights: arr(str(400), 8),
      }),
      15,
    ),
    education: arr(z.object({ qualification: str(160), institution: str(160), year: str(20).nullable() }), 8),
    projects: arr(z.object({ name: str(160), summary: str(400), technologies: arr(str(160), 15) }), 10),
    certifications: arr(str(160), 20),
    technologies: arr(str(160), 60),
    skills: arr(
      z.object({ skill_id: enumOf(skillIds), claimed_level: SkillLevel, evidence: arr(z.object({ quote: str(400) }), 3) }),
      40,
    ),
    accomplishments: arr(str(400), 12),
    unmapped_skills: arr(str(160), 40),
    parse_warnings: arr(str(400), 10),
  });
  return { name: 'candidate_profile', jsonSchema: toOutputSchema(schema), zod: schema as unknown as z.ZodType<CandidateProfile> };
}

/** The model has no clock; dates in a resume are judged against this. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function resumeParseRequest(c: InterviewContent, resumeText: string, today: string = todayIso()): LlmRequest {
  return {
    tier: 'SMALL',
    promptVersion: PARSE_PROMPT_VERSION,
    maxOutputTokens: 4000,
    system: `You extract a structured candidate profile from a resume for an interview-practice platform.

${INJECTION_RULES}

Today's date is ${today}. Judge every date in the resume against it (a date before today is in the past).

Extraction rules:
- Use only information stated in the resume. Do not infer employers, dates, or skills that are not written.
- career_stage: student (still studying, or graduated within the last 6 months, with only internships or projects), early_career (under about 3 years of full-time work), experienced (3-8 years), senior (8+ years or clear senior/lead roles).
- years_experience: full-time employment only, summed across roles up to today. Internships, coursework and projects do not count (use 0 when there is no full-time work).
- Contact details have already been replaced with markers like [EMAIL]; never reconstruct them.
- "roles": jobs and internships (kind = internship when stated or obvious from the title). Dates as YYYY-MM or YYYY; end = "present" if current.
- "skills": map demonstrated skills to the skill catalogue ids below. claimed_level reflects what the resume evidences:
  aware (mentioned only), working (used in a project or job), proficient (owned or delivered significant work), expert (led, designed, taught or is recognised for it).
  Each skill needs 1-3 evidence quotes copied verbatim from the resume (exact words, short).
- Skills that do not fit the catalogue go in "unmapped_skills".
- "technologies": tools, languages, platforms and frameworks named in the resume.
- "parse_warnings": only problems with reading the document itself (garbled or unreadable sections, missing dates you could not resolve, a mostly empty resume). Never comment on the candidate's career, experience level or choices; leave it empty when the document read cleanly.

Skill catalogue:
${skillCatalogue(c)}`,
    messages: [{ role: 'user', content: `Extract the candidate profile from this resume.\n\n${untrusted('untrusted_resume', resumeText)}` }],
  };
}

// ---------- JD -> job_profile (SMALL) ----------

export function jobProfileSchema(c: InterviewContent): StructuredSchema<JobProfile> {
  const schema = z.object({
    schema_version: z.literal('1'),
    title: str(160),
    role_id: enumOf([...c.roles.keys()]),
    seniority: Seniority,
    expected_experience: str(160).nullable(),
    required_skills: arr(z.object({ skill_id: enumOf([...c.skills.keys()]), level: SkillLevel, weight: RequirementWeight }), 40),
    responsibilities: arr(str(400), 20),
    technical_requirements: arr(str(400), 20),
    tools: arr(str(160), 40),
    behavioral_competencies: arr(str(160), 12),
    unmapped_requirements: arr(str(160), 30),
  });
  return { name: 'job_profile', jsonSchema: toOutputSchema(schema), zod: schema as unknown as z.ZodType<JobProfile> };
}

export function jdParseRequest(c: InterviewContent, jdText: string): LlmRequest {
  const roles = [...c.roles.values()].map((r) => `${r.id}: ${r.label}`).join('\n');
  return {
    tier: 'SMALL',
    promptVersion: PARSE_PROMPT_VERSION,
    maxOutputTokens: 3000,
    system: `You extract structured requirements from a job description for an interview-practice platform.

${INJECTION_RULES}

Extraction rules:
- role_id: the closest role from the list below; use general_technical when none fits.
- seniority: junior (0-2 years or entry level), mid (2-5), senior (5+ or senior title), lead (leads a team or function).
- required_skills: map requirements to the skill catalogue. weight = must (required, mandatory), should (preferred, strong plus), nice (bonus, familiarity).
  level = the depth the role needs (aware, working, proficient, expert).
- technical_requirements: concrete technical expectations in the JD's words, shortened.
- behavioral_competencies: soft skills or behaviours the JD asks for (for example stakeholder communication, ownership).
- Requirements that do not fit the catalogue go in unmapped_requirements.

Roles:
${roles}

Skill catalogue:
${skillCatalogue(c)}`,
    messages: [{ role: 'user', content: `Extract the job profile from this job description.\n\n${untrusted('untrusted_job_description', jdText)}` }],
  };
}

// ---------- Gap analysis (LARGE) ----------

export interface GapAnalysis {
  claims_to_verify: { skill_id: string; claim: string; evidence_quote: string }[];
  gaps: {
    skill_id: string;
    required_level: z.infer<typeof SkillLevel>;
    claimed_level: z.infer<typeof SkillLevel> | 'none';
    priority: 'high' | 'medium' | 'low';
    reason: string;
  }[];
  strengths: string[];
}

export function gapAnalysisSchema(c: InterviewContent): StructuredSchema<GapAnalysis> {
  const ids = enumOf([...c.skills.keys()]);
  const schema = z.object({
    claims_to_verify: arr(z.object({ skill_id: ids, claim: str(200), evidence_quote: str(400) }), 8),
    gaps: arr(
      z.object({
        skill_id: ids,
        required_level: SkillLevel,
        claimed_level: z.enum(['aware', 'working', 'proficient', 'expert', 'none']),
        priority: z.enum(['high', 'medium', 'low']),
        reason: str(240),
      }),
      12,
    ),
    strengths: arr(ids, 8),
  });
  return { name: 'gap_analysis', jsonSchema: toOutputSchema(schema), zod: schema as unknown as z.ZodType<GapAnalysis> };
}

export function gapAnalysisRequest(
  c: InterviewContent,
  candidate: CandidateProfile,
  job: JobProfile,
): LlmRequest {
  const role = c.roles.get(job.role_id) ?? c.roles.get('general_technical')!;
  const framework = Object.entries(role.skills)
    .map(([id, w]) => `${id} (${c.skills.get(id)?.label}) weight ${w}`)
    .join('\n');
  return {
    tier: 'LARGE',
    promptVersion: GAP_PROMPT_VERSION,
    maxOutputTokens: 6000,
    effort: 'low',
    system: `You compare a candidate profile with a job profile to plan a mock technical interview.

${INJECTION_RULES}

Return:
- claims_to_verify: up to 8 resume claims most relevant to the job that an interviewer should verify. "claim" is a short neutral paraphrase (e.g. "deployed microservices on Kubernetes"); evidence_quote is copied verbatim from the candidate profile's highlights or evidence.
- gaps: skills the job needs where the candidate's evidence is missing or below the required level. priority reflects the job weight (must > should > nice) and the size of the gap.
- strengths: skill ids where the candidate clearly meets or exceeds the job's needs.
Use only skill ids from the catalogue present in either profile or in the role framework.

Role framework for ${role.label}:
${framework}`,
    messages: [
      {
        role: 'user',
        content: `${untrusted('untrusted_candidate_profile', JSON.stringify(candidate))}\n\n${untrusted('untrusted_job_profile', JSON.stringify(job))}`,
      },
    ],
  };
}
