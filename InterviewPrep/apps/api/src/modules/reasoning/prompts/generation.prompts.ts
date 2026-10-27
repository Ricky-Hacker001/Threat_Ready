import { DiagramBoundaryKind, DiagramEdgeKind, DiagramNodeType, OptionId, OptionVerdict, ReasoningDifficulty } from '@threatready/contracts';
import { z } from 'zod';
import type { LlmRequest, LlmTier, StructuredSchema } from '../../../platform/ports/llm.port.js';
import { toOutputSchema } from '../../ai/json-schema.js';
import { arr, enumOf, prose, str } from '../../ai/prompts/common.js';
import { architectureText, ATTACK_STEPS, levelOf, type ArchitectureDef, type AttackSurface } from '../architectures/index.js';
import { ATTACK_ENTERPRISE, type ReasoningDomain, type VariationSeed } from '../domain.types.js';
import type { GeneratorOutput, LibraryGeneratorOutput } from '../item.types.js';
import { describeSeed } from '../seed.js';

/**
 * Bump when the prompt or the item shape changes; stored on every item. v3 (26 Oct 2026): questions
 * are written on the architecture library (questionSchema/questionRequest); the v2 builders below
 * (generationSchema/generationRequest, a model-drawn diagram) are kept for the items generated before it
 * and for tests that need a legacy item. Prompt v4 (review 27 Oct 2026): options back to 15-45 words,
 * learner-facing fields with room for the lengths asked for and clipped at a sentence or word (AR-BIZ-4),
 * a surface with several targets is one chain ending at one of them (AR-BIZ-9). The item shape is unchanged.
 */
export const GENERATOR_VERSION = 'gen.v3.2026-10-26';
export const GENERATION_PROMPT_VERSION = 'reasoning-generate.v4';

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

/* ---------------- gen.v3: questions on the architecture library (design §3) ---------------- */

/** Rubric points, must-not-credit claims and step range per level (the quality gate checks the same numbers). */
export const LIBRARY_LEVEL_LIMITS: Record<'beginner' | 'intermediate' | 'advanced', { rubricMin: number; rubricMax: number; mncMin: number; mncMax: number }> = {
  beginner: { rubricMin: 6, rubricMax: 8, mncMin: 2, mncMax: 5 },
  intermediate: { rubricMin: 7, rubricMax: 9, mncMin: 2, mncMax: 5 },
  advanced: { rubricMin: 9, rubricMax: 10, mncMin: 2, mncMax: 5 },
};

const LIBRARY_LEVEL_GUIDE: Record<'beginner' | 'intermediate' | 'advanced', string> = {
  beginner:
    'Level beginner. Attack: 1 or 2 steps that the narrative states plainly, with the evidence named (which log, which call). Question: one direct decision; the best option follows from one fact in the situation or the narrative; the three distractors are real controls or actions that clearly address something else. Rubric: 6 to 8 points, each satisfiable in one sentence.',
  intermediate:
    'Level intermediate. Attack: 2 or 3 steps crossing at least one trust boundary, past one control that matters on the path (say why it did not stop the step). Question: the best option needs the reader to trace the path and respect the constraint; distractors are sound controls that address the wrong step or break the constraint. Rubric: 7 to 9 points.',
  advanced:
    'Level advanced. Attack: 3 to 5 steps crossing two trust boundaries. Build the path on the trust relationship marked "easy to overlook", or on a present control whose limits make it not apply to this path, and make the best option depend on it or on a second-order effect. Two distractors must be defensible to a mid-level engineer and wrong only for a reason an expert would give. Rubric: 9 or 10 points, several requiring that trust relationship, the non-applicable control or the second-order effect to be named. The reference answer must name the trust relationship or the control and be precise about why each distractor fails.',
};

const WRITER_RULES = `You write one Attack Reasoning assessment item for ThreatReady on a fixed, reviewed reference architecture: an attack in progress on that architecture, one multiple-choice decision with four options, and a server-side rubric for grading a written justification. Experienced security engineers take it. The item must be technically correct in every detail, answerable from the architecture, the situation and the narrative alone, and not guessable from option wording.

The application draws the diagram from the architecture and your "attack" field, and shows the organisation summary as the first paragraph of the scenario. You do not draw anything.

Fields:
- title: a short, specific title (at most 12 words); never names the answer.
- situation: 80-150 words on what is happening at the organisation today and the operational constraint. Do not restate the organisation summary; add what is new (a project, a change, an alert, a deadline).
- attack: the path the attacker takes on this architecture: one chain, never a branch. steps: ordered {from, to, label}; each step starts where the previous one ended; the first step may start at an attacker origin; labels are short (at most 70 characters, for example "uses the leaked key to list the bucket"). entry_node: the first component (not an origin) on the path. compromised_nodes: the components the attacker controls or has read, all on the path. Use only the component and origin ids listed in the architecture.
- attack_narrative: 100-170 words, what happened step by step, naming every component on the path by its label and the evidence an engineer would have (which log source shows which call, with times). It must not hint at the answer.
- objective and question: the assessment objective, and the one decision the question asks for.
- options A-D: four options of similar length and form (each 15-45 words). Exactly one best answer. Each option names at least one component or control of the architecture by its label, and at least two options name components on the attack path, so naming the path is never a tell. The best option must not be the longest. The other three are plausible to a competent engineer: real controls or actions that are wrong here because they address a later step, do not break the path shown, violate the constraint, or destroy evidence. No "all of the above", no joke options, no option that restates the question, no reference to an option by its letter anywhere else.
- correct_option and option_analysis: for every option a verdict (best; plausible = a defensible runner-up; weak = helps little here; wrong = harmful or does not apply) and why, written to the learner in the second person. Exactly one best, and at least one distractor is plausible or weak.
- rubric (server-only): points with dimension reasoning (at least 3: what a sound justification states, uses as evidence, or rules out), architecture (at least 2: the components, trust relationships, path steps and controls the learner must show they understood) and risk (at least 1: the trade-off, residual risk, evidence preservation or constraint a strong answer recognises). Each point: a specific statement (not "mentions security"), a weight 1-5 by importance, a hint written to the learner for when they miss it (actionable, scenario-specific), and an explanation for the expert answer. Point ids are short and unique.
- must_not_credit: 2 to 5 claims that sound right but are wrong for this architecture and attack (for example a control that would not block this step), why, and which rubric point ids they invalidate when asserted.
- reference_answer: the expert justification for the best option, 120-220 words, second person, citing components by label.
- architecture_analysis: 80-140 words, second person: the components, trust boundaries and trust relationships the path crosses, which controls apply to it and which do not, and why.
- techniques: the techniques in play, by id from the domain's list (include the assigned one). concepts: 4-8 short concept names.
- difficulty: the level you were given.

Never copy a sentence of the reference answer, the option analysis or the architecture analysis into the title, situation, narrative, objective or question. Keep every text field tight. Output only the JSON object described by the schema, in plain English, no markdown.`;

/**
 * The output schema of a library question (`reasoning_question`): the item without the diagram and
 * the scenario, plus the situation, the attack overlay and the architecture analysis. Component ids,
 * origin ids and technique ids are schema enums, so the model cannot reference a component that does
 * not exist or invent a technique id.
 */
export function questionSchema(arch: ArchitectureDef, domain: ReasoningDomain): StructuredSchema<LibraryGeneratorOutput> {
  const nodeIds = arch.diagram.nodes.map((n) => n.id);
  const fromIds = [...nodeIds, ...arch.attackerOrigins.map((o) => o.id)];
  const techniqueIds = domain.techniques.map((t) => t.id);
  const schema = z.object({
    title: str(90),
    situation: str(1100),
    attack_narrative: str(1400),
    objective: str(240),
    question: str(500),
    // Caps sized above what the prompt asks for (review AR-BIZ-4): an over-long option reaches the gate
    // (more than 360 characters is rejected, not cut on the question screen); a step label is clipped
    // at a word to 70 characters by normaliseOverlay; the analyses end at a sentence or a word.
    options: arr(z.object({ id: OptionId, text: str(480) }), 4),
    correct_option: OptionId,
    option_analysis: arr(z.object({ id: OptionId, verdict: OptionVerdict, why: prose(600) }), 4),
    attack: z.object({
      entry_node: enumOf(nodeIds),
      compromised_nodes: arr(enumOf(nodeIds), 6),
      steps: arr(z.object({ from: enumOf(fromIds), to: enumOf(nodeIds), label: str(140) }), 6),
    }),
    rubric: arr(z.object({ id, dimension: z.enum(['reasoning', 'architecture', 'risk']), text: str(260), weight: z.enum(['1', '2', '3', '4', '5']), hint: str(280), explanation: str(360) }), 12),
    must_not_credit: arr(z.object({ id, claim: str(220), why: str(260), invalidates: arr(id, 6) }), 6),
    reference_answer: prose(1800),
    architecture_analysis: prose(1200),
    techniques: arr(z.object({ id: enumOf(techniqueIds), name: str(80) }), 6),
    concepts: arr(str(60), 10),
    difficulty: ReasoningDifficulty,
  });
  return { name: 'reasoning_question', jsonSchema: toOutputSchema(schema), zod: schema as unknown as z.ZodType<LibraryGeneratorOutput> };
}

export interface QuestionContext {
  arch: ArchitectureDef;
  domain: ReasoningDomain;
  seed: VariationSeed;
  surface: AttackSurface;
  tier: LlmTier;
  /** Questions already written on this architecture for this domain: steer away from their path, objective and wording. */
  avoid: { title: string; question: string; path: string; objective: string }[];
  /** The quality gate's findings on the previous try, fed back for the retry. */
  previousFailure: string[];
  tryNumber: number;
}

/** Request parameters per tier: Haiku writes first (no effort parameter, a longer timeout than the SMALL default), Sonnet retries. */
const TIER_PARAMS: Record<LlmTier, Pick<LlmRequest, 'maxOutputTokens' | 'effort' | 'timeoutMs'>> = {
  SMALL: { maxOutputTokens: 8000, timeoutMs: 90_000 },
  LARGE: { maxOutputTokens: 12_000, effort: 'medium' },
};

/** The stable, cacheable first system block: the writer's rules and the architecture. Byte-identical for every question on one architecture. */
export function questionPrefix(arch: ArchitectureDef): string {
  return `${WRITER_RULES}\n\nThe architecture (fixed; never add, remove or rename components; refer to components by their labels; use component and origin ids only in the attack fields):\n${architectureText(arch)}`;
}

/**
 * The request for one library question, in three layers from most to least stable (design §3.2):
 * the writer rules and the architecture (`systemPrefix`, cached per architecture), the domain and the
 * level (`system`), and the variation with the avoid list and any gate findings (the user message).
 * Nothing time- or request-specific goes into the two system blocks.
 */
export function questionRequest(ctx: QuestionContext): LlmRequest {
  const { arch, domain, seed, surface } = ctx;
  const level = levelOf(seed.difficulty);
  const fw = domain.framework ?? ATTACK_ENTERPRISE;
  const framing = domain.framing ?? 'an architecture diagram and an active attack';
  const objective = domain.variation.objectives.find((o) => o.id === seed.objective) ?? domain.variation.objectives[0]!;
  const technique = domain.techniques.find((t) => t.id === seed.technique) ?? domain.techniques[0]!;
  const constraint = domain.variation.constraints.find((c) => c.id === seed.constraint) ?? domain.variation.constraints[0]!;
  const label = (id: string) => arch.diagram.nodes.find((n) => n.id === id)?.label ?? arch.attackerOrigins.find((o) => o.id === id)?.label ?? id;
  const named = (ids: string[]) => (ids.length ? ids.map((id) => `${label(id)} (${id})`).join(', ') : 'none');
  // A surface with several targets is still one chain (review AR-BIZ-9): it ends at one of them.
  const targets =
    surface.targetNodeIds.length > 1
      ? `one of ${named(surface.targetNodeIds)}. The path is a single chain that ends at ONE of these targets; you may say in the narrative that the others are reachable too, but do not add a branch to them or mark them compromised`
      : named(surface.targetNodeIds);
  const steps = ATTACK_STEPS[level];
  const limits = LIBRARY_LEVEL_LIMITS[level];
  const objectiveWeights = objective.weights ? Object.entries(objective.weights).map(([k, v]) => `${k} ${v}`).join(', ') : 'default';
  const system = `Domain: ${domain.title}. The question depicts ${framing}, on the fixed architecture.

${domain.guidance}
Where these rules talk about the diagram or its components, they mean the fixed architecture: never add or rename a component.
Techniques: ${fw.citeRule} Use ids from this domain's list: ${domain.techniques.map((t) => `${t.id} ${t.name}`).join('; ')}.

${LIBRARY_LEVEL_GUIDE[level]}`;
  const user = `Write one ${domain.title} question (domain ${domain.key}) on this variation; every element must appear in the item:
- Architecture: ${arch.id}
- Attack surface (${surface.id}): ${surface.summary} Entry: ${named(surface.entryNodeIds)}. Via: ${named(surface.viaNodeIds)}. Target: ${targets}.${surface.notes ? ` ${surface.notes}` : ''}
- Assessment objective (${objective.id}): ${objective.label}. ${objective.guide} The question must be: "${objective.question}" adapted to the situation.
- Primary ${fw.name} technique: ${technique.id} ${technique.name}.
- Operational constraint (${constraint.id}): ${constraint.label}. ${constraint.guide}
- Level ${level}, hard limits: attack.steps ${steps.min} to ${steps.max} (count them), chained end to end; the path uses at least one of the surface's entry or target components; rubric ${limits.rubricMin} to ${limits.rubricMax} points; must_not_credit ${limits.mncMin} to ${limits.mncMax} claims; difficulty "${level}".
- Scoring weights for this objective (for your information only; never mention scoring in the item): ${objectiveWeights}.${
    ctx.avoid.length
      ? `\n\nQuestions already written on this architecture for this domain; make this one different in attack path, objective and wording:\n${ctx.avoid
          .slice(0, 8)
          .map((a) => `- ${a.title}: ${a.question} [path: ${a.path}; objective: ${a.objective}]`)
          .join('\n')}`
      : ''
  }${ctx.previousFailure.length ? `\n\nTry ${ctx.tryNumber}: the previous item was rejected by the quality check. Fix every point:\n${ctx.previousFailure.map((e) => `- ${e}`).join('\n')}` : ''}`;
  return {
    tier: ctx.tier,
    promptVersion: GENERATION_PROMPT_VERSION,
    ...TIER_PARAMS[ctx.tier],
    systemPrefix: questionPrefix(arch),
    system,
    messages: [{ role: 'user', content: user }],
  };
}
