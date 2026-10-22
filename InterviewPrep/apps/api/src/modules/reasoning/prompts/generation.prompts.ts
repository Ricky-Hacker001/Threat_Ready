import { DiagramBoundaryKind, DiagramEdgeKind, DiagramNodeType, OptionId, OptionVerdict, ReasoningDifficulty } from '@threatready/contracts';
import { z } from 'zod';
import type { LlmRequest, StructuredSchema } from '../../../platform/ports/llm.port.js';
import { toOutputSchema } from '../../ai/json-schema.js';
import { arr, str } from '../../ai/prompts/common.js';
import { ATTACK_ENTERPRISE, type ReasoningDomain, type VariationSeed } from '../domain.types.js';
import type { GeneratorOutput } from '../item.types.js';
import { describeSeed } from '../seed.js';

/** Bump when the prompt or the item shape changes; stored on every item. */
export const GENERATOR_VERSION = 'gen.v2.2026-10-21';
export const GENERATION_PROMPT_VERSION = 'reasoning-generate.v2';

const DIFFICULTY_GUIDE: Record<ReasoningDifficulty, string> = {
  beginner: 'Architecture: 5 to 7 components in 2 or 3 trust boundaries, one obvious entry point. Attack: 1 or 2 steps that the narrative states plainly, with the evidence named (which log, which call). Question: one direct decision; the best option follows from one fact in the scenario; the three distractors are real controls that clearly address something else. Rubric: 6 points, each satisfiable in one sentence.',
  intermediate: 'Architecture: 7 to 10 components in 3 or 4 trust boundaries, one control that matters on the path. Attack: 2 or 3 steps crossing one boundary. Question: the best option needs the reader to trace the path and respect the constraint; distractors are sound controls that address the wrong step or break the constraint. Rubric: 7 to 9 points.',
  advanced: 'Architecture: 10 to 13 components in 4 or 5 trust boundaries, including a trust relationship (role assumption, shared credential, network peering, federation, a service-to-service token, an implicit trust between two systems) that most readers miss, and one control on the diagram that does not apply for a stated reason. Attack: 3 to 5 steps crossing two boundaries. Question: the best option depends on that trust relationship or on a second-order effect; two distractors must be defensible to a mid-level engineer and wrong only for a reason an expert would give. Rubric: 9 or 10 points, several requiring the trust relationship, the non-applicable control, or the second-order effect to be named. The reference answer must be precise about why each distractor fails.',
  expert: 'Architecture: 12 to 14 components in 5 trust boundaries with two interacting trust relationships. Attack: 4 to 6 steps. Question: the best option is right only because of an interaction between two components; three distractors are each defensible. Rubric: 10 points at expert depth.',
};

const id = str(40).transform((s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x');

export function generationSchema(): StructuredSchema<GeneratorOutput> {
  const schema = z.object({
    title: str(90),
    scenario: str(2200),
    attack_narrative: str(1800),
    objective: str(240),
    question: str(500),
    options: arr(z.object({ id: OptionId, text: str(360) }), 4),
    correct_option: OptionId,
    option_analysis: arr(z.object({ id: OptionId, verdict: OptionVerdict, why: str(400) }), 4),
    diagram: z.object({
      boundaries: arr(z.object({ id, label: str(60), kind: DiagramBoundaryKind }), 8),
      nodes: arr(
        z.object({ id, label: str(60), type: DiagramNodeType, boundary: id, detail: str(160).nullable(), compromised: z.boolean(), entry_point: z.boolean(), controls: arr(str(40), 5) }),
        18,
      ),
      edges: arr(z.object({ id, from: id, to: id, label: str(70), kind: DiagramEdgeKind }), 30),
      attack_path: arr(id, 10),
    }),
    rubric: arr(z.object({ id, dimension: z.enum(['reasoning', 'architecture', 'risk']), text: str(260), weight: z.enum(['1', '2', '3', '4', '5']), hint: str(280), explanation: str(360) }), 12),
    must_not_credit: arr(z.object({ id, claim: str(220), why: str(260), invalidates: arr(id, 6) }), 6),
    reference_answer: str(1800),
    techniques: arr(z.object({ id: str(16), name: str(80) }), 6),
    concepts: arr(str(60), 10),
    difficulty: ReasoningDifficulty,
  });
  return { name: 'reasoning_item', jsonSchema: toOutputSchema(schema), zod: schema as unknown as z.ZodType<GeneratorOutput> };
}

/** Hard shape limits per level, repeated in the request so the model counts against them. */
const SHAPE: Record<ReasoningDifficulty, string> = {
  beginner: 'attack_path: exactly 1 or 2 attack edges (count them; the attacker reaching the entry point counts as one). nodes: 5 to 7.',
  intermediate: 'attack_path: exactly 2 or 3 attack edges. nodes: 7 to 10.',
  advanced: 'attack_path: 3 to 5 attack edges. nodes: 10 to 13, at least 4 trust boundaries.',
  expert: 'attack_path: 4 to 6 attack edges. nodes: 12 to 14, 5 trust boundaries.',
};

export interface GenerationContext {
  domain: ReasoningDomain;
  seed: VariationSeed;
  /** Titles and questions the learner has already seen in this domain, to steer away from. */
  avoid: { title: string; question: string }[];
  /** Validation errors or similarity findings from the previous try, fed back for the regeneration. */
  previousFailure: string[];
  tryNumber: number;
}

export function generationRequest(ctx: GenerationContext): LlmRequest {
  const { domain, seed } = ctx;
  const d = describeSeed(domain, seed);
  const objectiveWeights = d.objective.weights ? Object.entries(d.objective.weights).map(([k, v]) => `${k} ${v}`).join(', ') : 'default';
  const fw = domain.framework ?? ATTACK_ENTERPRISE;
  const framing = domain.framing ?? 'an architecture diagram, an active attack';
  return {
    tier: 'LARGE',
    promptVersion: GENERATION_PROMPT_VERSION,
    // The item is a large JSON object (diagram, four options, rubric, reference answer): give it room,
    // at medium effort so generation stays within about a minute.
    maxOutputTokens: 16000,
    effort: 'medium',
    system: `You write one Attack Reasoning assessment item for ThreatReady: a realistic ${domain.title} scenario with ${framing}, one multiple-choice decision with four options, and a server-side rubric for grading a written justification. Experienced security engineers take it; the item must be technically correct in every detail, answerable from the scenario and diagram alone, and must not be guessable from option wording.

${domain.guidance}

Diagram rules (the diagram is data, rendered by the application; the learner reasons from it):
- boundaries: the trust boundaries present (kinds: internet, edge, dmz, vpc, private, data, identity, account, onprem, cicd, management). Every node belongs to exactly one boundary.
- nodes: the count the difficulty asks for (never more than 14), with short, specific labels (e.g. "exports-prod bucket", "deploy-prod role"), a type, the controls actually present on them (e.g. "MFA", "WAF", "private endpoint only"), and mark exactly the compromised ones and the entry point.
- edges: normal flows (kind data, auth or control) with labels like "HTTPS 443", "AssumeRole", "reads objects"; and attack edges (kind attack) describing each step the attacker takes. attack_path lists the attack edge ids in order, connected end to end, starting at the entry point.
- Use the exact node labels in the scenario and attack narrative wherever you refer to a component, so the text and the picture match.

Question rules:
- The scenario describes the business, the environment, the sensitive data and the controls in place (180-320 words). The attack narrative describes what happened, step by step, with the evidence an engineer would have (log lines, alerts, timestamps) (100-200 words). Neither may hint at the answer. Keep every text field tight; the whole item should stay compact.
- One assessment objective. The question asks exactly what the objective says; one decision, not several.
- Four options A-D of similar length and form (each 15-45 words). Exactly one best answer. The other three must be plausible to a competent engineer: real controls or actions that are wrong for this scenario because they address a later step, do not break the path shown, violate the constraint, or destroy evidence. No "all of the above", no joke options, no option that restates the question.
- option_analysis: for every option, a verdict (best, plausible = defensible runner-up, weak = helps little here, wrong = harmful or does not apply) and why, written to the learner in the second person.

Rubric rules (server-only, never shown before grading):
- 6 to 10 points. dimension reasoning (at least 3): what a sound justification states, uses as evidence, or rules out. dimension architecture (at least 2): the components, trust relationships, path steps and controls the learner must show they understood. dimension risk (at least 1): the trade-off, residual risk, evidence-preservation or business constraint a strong answer recognises.
- Each point: a specific statement (not "mentions security"), a weight 1-5 by importance, a hint written to the learner for when they miss it (actionable, scenario-specific), and an explanation for the expert answer.
- must_not_credit: 2 to 5 claims that sound right but are wrong in this scenario (for example a control that would not block this step), why, and which rubric point ids they invalidate when asserted.
- reference_answer: the expert justification for the best option, 120-220 words, in the second person, citing the diagram.
- techniques: the ${fw.name} techniques in play (ids and names; include the assigned one). ${fw.citeRule} concepts: 4-8 short concept names.

Difficulty: ${seed.difficulty}. ${DIFFICULTY_GUIDE[seed.difficulty]}
Scoring weights for this objective (for your information only; do not mention scoring in the item): ${objectiveWeights}.
Output only the JSON object described by the schema. Write in plain English; no markdown.`,
    messages: [
      {
        role: 'user',
        content: `Build the item from this variation (every element must appear in the scenario):
- Architecture topology: ${d.topology.label}. ${d.topology.guide}
- Attacker entry point: ${d.entryPoint.label}. ${d.entryPoint.guide}
- Assessment objective: ${d.objective.label}. ${d.objective.guide} The question must be: "${d.objective.question}" adapted to the scenario.
- Primary ${fw.name} technique: ${d.technique.id} ${d.technique.name}.
- Operational constraint: ${d.constraint.label}. ${d.constraint.guide}
- Level ${seed.difficulty}, hard limits: ${SHAPE[seed.difficulty]} The attack edges must chain end to end in attack_path order (each edge starts where the previous one ended).
- Vary the component vocabulary; candidates include: ${domain.variation.components.slice(0, 20).join(', ')}.
${ctx.avoid.length ? `\nThe learner has already seen these; make this one different in company, data, components and attack steps:\n${ctx.avoid.map((a) => `- ${a.title}: ${a.question}`).join('\n')}` : ''}${ctx.previousFailure.length ? `\n\nTry ${ctx.tryNumber}: the previous item was rejected. Fix every point:\n${ctx.previousFailure.map((e) => `- ${e}`).join('\n')}` : ''}`,
      },
    ],
  };
}
