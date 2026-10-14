import type { CandidateProfile, Difficulty, DurationMin, InterviewType, JobProfile, Recommendation, Track } from '@threatready/contracts';
import type { InterviewContent } from '../../platform/content/content.service.js';

const SENIORITY_DIFFICULTY: Record<JobProfile['seniority'], Difficulty> = {
  junior: 'beginner',
  mid: 'intermediate',
  senior: 'advanced',
  lead: 'advanced',
};

const ORDER: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
/** The hardest difficulty that is still useful practice for a candidate at this stage. */
const STAGE_CAP: Record<NonNullable<CandidateProfile['career_stage']>, Difficulty> = {
  student: 'intermediate',
  early_career: 'advanced',
  experienced: 'advanced',
  senior: 'advanced',
};

/** Recommended settings from the job and the candidate, computed in code (no model call). */
export function recommend(c: InterviewContent, job: JobProfile, candidate?: CandidateProfile): Recommendation {
  const role = c.roles.get(job.role_id) ?? c.roles.get('general_technical')!;
  const fromJob = SENIORITY_DIFFICULTY[job.seniority];
  const cap = candidate?.career_stage ? STAGE_CAP[candidate.career_stage] : 'advanced';
  const difficulty = ORDER[Math.min(ORDER.indexOf(fromJob), ORDER.indexOf(cap))]!;
  const track: Track = role.track;
  const mustCount = job.required_skills.filter((s) => s.weight === 'must').length;
  let interviewType: InterviewType = role.defaultType;
  const rationale: string[] = [`${role.label} roles are usually assessed with ${label(interviewType)} questions.`];

  const designHeavy = job.required_skills.some((s) => s.skill_id === 'swe.system_design' && s.weight !== 'nice');
  if (designHeavy && (job.seniority === 'senior' || job.seniority === 'lead') && track === 'general') {
    interviewType = 'system_design';
    rationale.push('The job emphasises system design at a senior level.');
  }
  if (job.behavioral_competencies.length >= 4 && interviewType === 'technical') {
    interviewType = 'mixed';
    rationale.push('The job lists several behavioural competencies, so a mixed interview covers both.');
  }

  const durationMin: DurationMin = mustCount >= 8 || job.seniority === 'lead' ? 45 : mustCount <= 2 ? 15 : 30;
  rationale.push(
    difficulty === fromJob
      ? `Seniority "${job.seniority}" suggests ${difficulty} difficulty.`
      : `The role is ${job.seniority} level, but as a ${candidate?.career_stage?.replace('_', ' ')} you will get more from ${difficulty} questions first.`,
  );
  if (candidate?.career_stage === 'student') rationale.push('Questions will draw on your projects, coursework and internships.');
  rationale.push(`${mustCount} mandatory skill${mustCount === 1 ? '' : 's'} fit a ${durationMin}-minute interview.`);
  return { interviewType, difficulty, durationMin, track, rationale };
}

const label = (t: InterviewType) => t.replace(/_/g, ' ');
