import type {
  CandidateProfile,
  Difficulty,
  InterviewConfig,
  InterviewType,
  JobProfile,
  ProfileCorrections,
  SkillLevel,
  Track,
} from '@threatready/contracts';
import type { InterviewContent, ScenarioDef } from '../../platform/content/content.service.js';
import type { GapAnalysis } from '../ai/prompts/documents.prompts.js';
import { sectionOf, type InterviewPlan, type InterviewSection, type PlanItem, type PlanItemKind } from './plan.types.js';

export const PLAN_VERSION = 'plan.v1';

const MINUTES_PER_QUESTION: Record<Difficulty, number> = { beginner: 2.5, intermediate: 3, advanced: 3.5 };
const LEVEL_ORDER: SkillLevel[] = ['aware', 'working', 'proficient', 'expert'];
const JD_WEIGHT = { must: 3, should: 2, nice: 1 } as const;
const GAP_PRIORITY = { high: 2, medium: 1, low: 0.5 } as const;

/** Share of non-closing questions per kind, by interview type. */
const COMPOSITION: Record<InterviewType, Partial<Record<PlanItemKind, number>>> = {
  technical: { claim_verification: 0.35, jd_technical: 0.35, gap_probe: 0.2, problem_solving: 0.1 },
  behavioral: { behavioral: 0.8, claim_verification: 0.2 },
  system_design: { system_design: 0.7, claim_verification: 0.15, jd_technical: 0.15 },
  coding_discussion: { coding_discussion: 0.6, claim_verification: 0.2, jd_technical: 0.2 },
  cybersecurity_scenario: { scenario: 0.55, claim_verification: 0.25, gap_probe: 0.2 },
  mixed: { claim_verification: 0.3, gap_probe: 0.3, scenario: 0.2, behavioral: 0.2 },
};

/**
 * Question count from duration and difficulty. About four minutes go to the warm-up and wrap-up;
 * the rest is split into core questions with room for typed answers and follow-ups. The total
 * stays within the ADD's 12 questions and 18 turns.
 */
export function questionBudget(durationMin: number, difficulty: Difficulty) {
  const core = Math.max(2, Math.min(10, Math.round(((durationMin - 4) * 0.8) / MINUTES_PER_QUESTION[difficulty])));
  const mainQuestions = core + 2;
  const maxFollowUps = Math.max(1, Math.min(6, Math.ceil(core * 0.5)));
  return { mainQuestions, maxFollowUps, maxTurns: Math.min(18, mainQuestions + maxFollowUps) };
}

export interface PlannerInput {
  c: InterviewContent;
  candidate: CandidateProfile;
  job: JobProfile;
  gaps: GapAnalysis;
  config: InterviewConfig;
}

/** Applies the candidate's confirmed corrections. Only removals and level changes are accepted. */
export function applyCorrections(candidate: CandidateProfile, job: JobProfile, corr?: ProfileCorrections) {
  if (!corr) return { candidate, job };
  const removeC = new Set(corr.removeCandidateSkills);
  const removeJ = new Set(corr.removeRequiredSkills);
  return {
    candidate: {
      ...candidate,
      skills: candidate.skills
        .filter((s) => !removeC.has(s.skill_id))
        .map((s) => (corr.candidateSkillLevels[s.skill_id] ? { ...s, claimed_level: corr.candidateSkillLevels[s.skill_id]! } : s)),
    },
    job: { ...job, required_skills: job.required_skills.filter((s) => !removeJ.has(s.skill_id)) },
  };
}

function allocate(total: number, shares: Partial<Record<PlanItemKind, number>>): Map<PlanItemKind, number> {
  const entries = Object.entries(shares) as [PlanItemKind, number][];
  const sum = entries.reduce((n, [, v]) => n + v, 0);
  const exact = entries.map(([k, v]) => [k, (v / sum) * total] as const);
  const out = new Map<PlanItemKind, number>(exact.map(([k, v]) => [k, Math.floor(v)]));
  let left = total - [...out.values()].reduce((a, b) => a + b, 0);
  for (const [k] of [...exact].sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
    if (left <= 0) break;
    out.set(k, out.get(k)! + 1);
    left--;
  }
  return out;
}

function targetLevel(required: SkillLevel | undefined, difficulty: Difficulty): SkillLevel {
  const base = LEVEL_ORDER.indexOf(required ?? 'working');
  const idx = difficulty === 'beginner' ? Math.min(base, 1) : difficulty === 'intermediate' ? Math.min(Math.max(base, 1), 2) : Math.max(base, 2);
  return LEVEL_ORDER[idx]!;
}

/** Builds the interview plan in code (ADD §7 step 3). Deterministic for the same inputs. */
export function buildPlan(input: PlannerInput): InterviewPlan {
  const { c, candidate, job, gaps, config } = input;
  const role = c.roles.get(job.role_id) ?? c.roles.get('general_technical')!;
  const { mainQuestions, maxFollowUps, maxTurns } = questionBudget(config.durationMin, config.difficulty);
  const focus = new Set(config.focusSkillIds.filter((id) => c.skills.has(id)));

  // Skill priority: JD weight, role framework weight, gap size and the candidate's chosen focus.
  const required = new Map(job.required_skills.map((s) => [s.skill_id, s]));
  const gapBySkill = new Map(gaps.gaps.map((g) => [g.skill_id, g]));
  const score = (id: string): number =>
    (required.has(id) ? JD_WEIGHT[required.get(id)!.weight] : 0) +
    0.5 * (role.skills[id] ?? 0) +
    (gapBySkill.has(id) ? GAP_PRIORITY[gapBySkill.get(id)!.priority] : 0) +
    (focus.has(id) ? 3 : 0);
  const candidates = new Set<string>([...required.keys(), ...Object.keys(role.skills), ...focus]);
  const ranked = [...candidates].filter((id) => c.skills.has(id)).sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const isBehavioural = (id: string) => c.skills.get(id)?.category === 'Behavioural';
  const technicalRanked = ranked.filter((id) => !isBehavioural(id));

  const used = new Map<string, number>();
  const take = (pool: string[]): string | undefined => {
    const fresh = pool.find((id) => !used.has(id));
    const pick = fresh ?? [...pool].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
    if (pick) used.set(pick, (used.get(pick) ?? 0) + 1);
    return pick;
  };

  const claims = gaps.claims_to_verify.filter((cl) => c.skills.has(cl.skill_id));
  const claimFallback = candidate.skills
    .filter((s) => s.evidence.length > 0)
    .sort((a, b) => score(b.skill_id) - score(a.skill_id))
    .map((s) => ({ skill_id: s.skill_id, claim: `${c.skills.get(s.skill_id)?.label} experience`, evidence_quote: s.evidence[0]!.quote }));
  const claimQueue = [...claims, ...claimFallback];

  const gapQueue = [...gaps.gaps]
    .filter((g) => c.skills.has(g.skill_id))
    .sort((a, b) => GAP_PRIORITY[b.priority] - GAP_PRIORITY[a.priority] || score(b.skill_id) - score(a.skill_id))
    .map((g) => g.skill_id);

  const track: Track = config.track === 'general' ? role.track : config.track;
  const scenarioPool: ScenarioDef[] = [...(c.tracks[track]?.scenarios ?? []), ...c.tracks.general.scenarios].sort(
    (a, b) => score(b.skillId) - score(a.skillId),
  );
  const usedScenarios = new Set<string>();

  const behaviouralPool = [
    ...ranked.filter(isBehavioural),
    ...['beh.problem_solving', 'beh.collaboration', 'beh.ownership', 'beh.communication', 'beh.learning'].filter((id) => c.skills.has(id)),
  ];

  // Two slots are reserved: the introduction and the wrap-up.
  const counts = allocate(Math.max(1, mainQuestions - 2), COMPOSITION[config.interviewType]);
  const items: Omit<PlanItem, 'id' | 'seq' | 'section'>[] = [];
  const followUpLimit = config.difficulty === 'advanced' ? 2 : 1;
  const est = MINUTES_PER_QUESTION[config.difficulty];
  const lvl = (id: string) => targetLevel(required.get(id)?.level, config.difficulty);
  const base = (kind: PlanItemKind, skillId: string, intent: string, extra: Partial<PlanItem> = {}): Omit<PlanItem, 'id' | 'seq' | 'section'> => ({
    kind,
    skillId,
    targetLevel: lvl(skillId),
    intent,
    rubricId: c.rubrics.find((r) => r.questionTypes.includes(kind))!.id,
    followUpLimit,
    estMinutes: kind === 'scenario' || kind === 'system_design' ? est + 1 : est,
    ...extra,
  });

  for (const [kind, n] of counts) {
    for (let i = 0; i < n; i++) {
      switch (kind) {
        case 'claim_verification': {
          const cl = claimQueue.find((x) => !used.has(x.skill_id)) ?? claimQueue[0];
          if (cl) {
            used.set(cl.skill_id, (used.get(cl.skill_id) ?? 0) + 1);
            items.push(base(kind, cl.skill_id, `Verify the resume claim: ${cl.claim}`, { claim: cl.claim, evidenceQuote: cl.evidence_quote }));
          } else {
            const s = take(technicalRanked);
            if (s) items.push(base('jd_technical', s, `Assess ${c.skills.get(s)!.label}, required by the role`));
          }
          break;
        }
        case 'jd_technical':
        case 'coding_discussion':
        case 'system_design': {
          const pool = kind === 'system_design' ? ['swe.system_design', ...technicalRanked].filter((id) => c.skills.has(id)) : technicalRanked;
          const s = take(pool);
          if (s) {
            const intent =
              kind === 'system_design'
                ? `Assess system design reasoning involving ${c.skills.get(s)!.label}`
                : kind === 'coding_discussion'
                  ? `Discuss real code the candidate wrote using ${c.skills.get(s)!.label}`
                  : `Assess ${c.skills.get(s)!.label}, required by the role`;
            items.push(base(kind, s, intent));
          }
          break;
        }
        case 'gap_probe': {
          const focusTechnical = [...focus].filter((id) => !isBehavioural(id));
          const s = take([...new Set([...focusTechnical, ...gapQueue, ...technicalRanked])]);
          if (s) items.push(base(kind, s, `Probe a gap between the resume and the JD on ${c.skills.get(s)!.label}`));
          break;
        }
        case 'scenario':
        case 'problem_solving': {
          const sc = scenarioPool.find((x) => !usedScenarios.has(x.id)) ?? scenarioPool[0];
          if (sc) {
            usedScenarios.add(sc.id);
            used.set(sc.skillId, (used.get(sc.skillId) ?? 0) + 1);
            items.push(base(kind, sc.skillId, `Assess scenario reasoning: ${c.skills.get(sc.skillId)!.label}`, { scenarioSeed: sc.seed }));
          }
          break;
        }
        case 'behavioral': {
          const s = take(behaviouralPool);
          if (s) items.push({ ...base(kind, s, `Assess ${c.skills.get(s)!.label} with a real example`), targetLevel: 'working' });
          break;
        }
        default:
          break;
      }
    }
  }

  // Order like a real interview: background deep-dive, then technical depth, then a scenario,
  // then behavioural; questions on the same section stay together.
  const sectionOrder: InterviewSection[] = ['background', 'technical', 'scenario', 'behavioral'];
  const ordered = sectionOrder.flatMap((sec) => items.filter((i) => sectionOf(i.kind) === sec));
  // Every focus area the candidate chose gets at least one question.
  for (const id of focus) {
    if (ordered.some((i) => i.skillId === id)) continue;
    const kind: PlanItemKind = isBehavioural(id) ? 'behavioral' : 'gap_probe';
    const replaceAt = ordered.map((i) => i.kind).lastIndexOf(kind === 'behavioral' ? 'behavioral' : 'gap_probe');
    const at = replaceAt > 0 ? replaceAt : ordered.length - 1;
    const replacement = base(kind, id, `Focus area chosen by the candidate: ${c.skills.get(id)!.label}`);
    if (at > 0) ordered[at] = replacement;
    else ordered.push(replacement);
  }

  // Opening: a warm-up that lets the candidate frame their background, as real interviews do.
  const anchor = claimQueue[0];
  ordered.unshift({
    ...base('introduction', anchor?.skill_id ?? 'beh.communication', 'Warm-up: the candidate introduces their background and interest in the role'),
    // One follow-up on something they mention, as interviewers do after "tell me about yourself".
    followUpLimit: 1,
    targetLevel: 'working',
    estMinutes: 2.5,
  });
  ordered.push({
    ...base('closing', 'beh.communication', 'Wrap up: anything the candidate wants to add that the interview did not cover'),
    followUpLimit: 0,
    targetLevel: 'working',
    estMinutes: 2,
  });

  const planItems: PlanItem[] = ordered.map((it, i) => ({ ...it, id: `q${i + 1}`, seq: i + 1, section: sectionOf(it.kind) }));
  const distribution: Record<string, number> = {};
  for (const it of planItems) distribution[it.kind] = (distribution[it.kind] ?? 0) + 1;

  const claimSkills = planItems.filter((i) => i.kind === 'claim_verification').map((i) => c.skills.get(i.skillId)!.label);
  const gapSkills = planItems.filter((i) => i.kind === 'gap_probe').map((i) => c.skills.get(i.skillId)!.label);
  const objectives = [
    claimSkills.length ? `Verify resume claims: ${[...new Set(claimSkills)].join(', ')}` : null,
    `Assess the ${job.title} requirements most weighted in the job description`,
    gapSkills.length ? `Probe gaps against the JD: ${[...new Set(gapSkills)].join(', ')}` : null,
    distribution.scenario || distribution.problem_solving ? `Evaluate scenario reasoning for the ${c.tracks[track]?.label ?? 'role'} track` : null,
    distribution.behavioral ? 'Assess behavioural competencies with concrete examples' : null,
  ].filter((x): x is string => Boolean(x));

  return {
    planVersion: PLAN_VERSION,
    contentVersion: c.version,
    rubricVersion: c.rubricVersion,
    objectives,
    items: planItems,
    maxTurns,
    maxFollowUps,
    topicDistribution: distribution,
    followUpStrategy: `Up to ${followUpLimit} follow-up per question and ${maxFollowUps} in total, picking up what the candidate said: thin answers are clarified, solid ones probed, strong ones deepened; never after "I don't know", spread across the interview, and only with three or more minutes left.`,
  };
}
