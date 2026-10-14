import { RequirementWeight, Seniority, SkillLevel } from './enums.js';
import { z } from './zod.js';

const short = z.string().max(160);
const line = z.string().max(400);

/** Candidate profile (ADD §7 candidate_profile, extended with education/projects/accomplishments). */
export const CandidateProfile = z
  .object({
    schema_version: z.literal('1'),
    /** student: still studying or graduated within ~6 months with internships only. Absent on older profiles. */
    career_stage: z.enum(['student', 'early_career', 'experienced', 'senior']).nullable().optional(),
    headline: line.nullable(),
    years_experience: z.number().min(0).max(60).nullable(),
    current_role: short.nullable(),
    roles: z
      .array(
        z.object({
          title: short,
          organisation: short,
          kind: z.enum(['job', 'internship']),
          start: z.string().max(20).nullable(),
          end: z.string().max(20).nullable(),
          highlights: z.array(line).max(8),
        }),
      )
      .max(15),
    education: z.array(z.object({ qualification: short, institution: short, year: z.string().max(20).nullable() })).max(8),
    projects: z.array(z.object({ name: short, summary: line, technologies: z.array(short).max(15) })).max(10),
    certifications: z.array(short).max(20),
    technologies: z.array(short).max(60),
    skills: z
      .array(
        z.object({
          skill_id: z.string().max(80),
          claimed_level: SkillLevel,
          evidence: z.array(z.object({ quote: line })).max(3),
        }),
      )
      .max(40),
    accomplishments: z.array(line).max(12),
    unmapped_skills: z.array(short).max(40),
    parse_warnings: z.array(line).max(10),
  })
  .openapi('CandidateProfile');
export type CandidateProfile = z.infer<typeof CandidateProfile>;

/** Job profile (ADD §7 job_profile, extended with technical requirements and behavioural competencies). */
export const JobProfile = z
  .object({
    schema_version: z.literal('1'),
    title: short,
    role_id: z.string().max(60),
    seniority: Seniority,
    expected_experience: short.nullable(),
    required_skills: z
      .array(z.object({ skill_id: z.string().max(80), level: SkillLevel, weight: RequirementWeight }))
      .max(40),
    responsibilities: z.array(line).max(20),
    technical_requirements: z.array(line).max(20),
    tools: z.array(short).max(40),
    behavioral_competencies: z.array(short).max(12),
    unmapped_requirements: z.array(short).max(30),
  })
  .openapi('JobProfile');
export type JobProfile = z.infer<typeof JobProfile>;

/** Candidate corrections applied before planning. Only removals and level changes: no free text reaches a prompt. */
export const ProfileCorrections = z
  .object({
    removeCandidateSkills: z.array(z.string().max(80)).max(40).default([]),
    candidateSkillLevels: z.record(z.string().max(80), SkillLevel).default({}),
    removeRequiredSkills: z.array(z.string().max(80)).max(40).default([]),
  })
  .openapi('ProfileCorrections');
export type ProfileCorrections = z.infer<typeof ProfileCorrections>;
