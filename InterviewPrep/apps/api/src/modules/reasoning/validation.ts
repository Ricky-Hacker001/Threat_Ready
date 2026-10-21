import type { DiagramData, OptionId } from '@threatready/contracts';
import { fingerprintOf, type ReasoningDomain, type VariationSeed, type Weights } from './domain.types.js';
import type { GeneratedItem, GeneratorOutput } from './item.types.js';

/**
 * Code validation of a generated item before it is stored or shown (spec §2, §3). AI generation is
 * not uncontrolled randomness: an item that fails here is regenerated with the errors fed back.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const OPTION_IDS: OptionId[] = ['A', 'B', 'C', 'D'];
const TECHNIQUE_ID = /^T\d{4}(\.\d{3})?$/;
const LEAK_PATTERNS = [/correct (answer|option)/i, /best (answer|option) is/i, /\boption [a-d] is (correct|right|best)/i, /\(correct\)/i, /\bthe answer is\b/i];
const BANNED_OPTION = /^(all|none) of the above/i;
const GENERIC = new Set(['the', 'and', 'for', 'with', 'from', 'prod', 'service', 'server', 'cloud', 'main', 'primary', 'public', 'private', 'internal', 'external', 'app', 'web', 'data', 'store', 'user', 'users', 'role', 'account', 'system', 'tier', 'node', 'host', 'api']);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A label counts as mentioned when it appears verbatim, or every one of its specific words does. */
export function mentionsLabel(text: string, label: string): boolean {
  const t = norm(text);
  const l = norm(label);
  if (!l) return true;
  if (t.includes(l)) return true;
  const words = l.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w));
  if (!words.length) return t.includes(l);
  return words.every((w) => t.includes(w));
}

export function validateDiagram(d: GeneratorOutput['diagram']): string[] {
  const errors: string[] = [];
  const bIds = new Set<string>();
  for (const b of d.boundaries) {
    if (bIds.has(b.id)) errors.push(`diagram: duplicate boundary id "${b.id}"`);
    bIds.add(b.id);
  }
  if (d.boundaries.length < 2) errors.push('diagram: at least two trust boundaries are required');
  const nIds = new Set<string>();
  for (const n of d.nodes) {
    if (nIds.has(n.id)) errors.push(`diagram: duplicate node id "${n.id}"`);
    nIds.add(n.id);
    if (!bIds.has(n.boundary)) errors.push(`diagram: node "${n.id}" references unknown boundary "${n.boundary}"`);
    if (!n.label.trim()) errors.push(`diagram: node "${n.id}" has an empty label`);
  }
  if (d.nodes.length < 4) errors.push('diagram: at least four nodes are required');
  if (d.nodes.length > 18) errors.push('diagram: at most eighteen nodes');
  const eIds = new Map<string, GeneratorOutput['diagram']['edges'][number]>();
  for (const e of d.edges) {
    if (eIds.has(e.id)) errors.push(`diagram: duplicate edge id "${e.id}"`);
    eIds.set(e.id, e);
    if (!nIds.has(e.from)) errors.push(`diagram: edge "${e.id}" starts at unknown node "${e.from}"`);
    if (!nIds.has(e.to)) errors.push(`diagram: edge "${e.id}" ends at unknown node "${e.to}"`);
    if (e.from === e.to) errors.push(`diagram: edge "${e.id}" loops on one node`);
  }
  if (d.edges.length < 3) errors.push('diagram: at least three edges are required');
  if (!d.attack_path.length) errors.push('diagram: the attack path is empty');
  const path = d.attack_path.map((id) => eIds.get(id));
  path.forEach((e, i) => {
    if (!e) errors.push(`diagram: attack path references unknown edge "${d.attack_path[i]}"`);
  });
  const pathEdges = path.filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (pathEdges.some((e) => e.kind !== 'attack')) errors.push('diagram: every attack-path edge must have kind "attack"');
  for (let i = 1; i < pathEdges.length; i++) {
    if (pathEdges[i]!.from !== pathEdges[i - 1]!.to) errors.push(`diagram: attack path is not connected between "${pathEdges[i - 1]!.id}" and "${pathEdges[i]!.id}"`);
  }
  const entry = d.nodes.filter((n) => n.entry_point);
  if (!entry.length) errors.push('diagram: no node is marked as the attacker entry point');
  const first = pathEdges[0];
  if (first) {
    // The path may begin at the attacker's position (an outside node) or at the entry point itself.
    const start = d.nodes.find((n) => n.id === first.from);
    const boundary = start && d.boundaries.find((b) => b.id === start.boundary);
    const outside = start && (['attacker', 'external', 'client', 'user'].includes(start.type) || boundary?.kind === 'internet');
    if (start && !start.entry_point && !outside) errors.push('diagram: the attack path must start at the entry point or at the attacker');
  }
  if (!d.nodes.some((n) => n.compromised || n.entry_point)) errors.push('diagram: no compromised component');
  if (!d.edges.some((e) => e.kind !== 'attack')) errors.push('diagram: show normal data or auth flows, not only the attack');
  return errors;
}

/**
 * Repairs mechanical omissions that carry no information the validator needs to judge: edges listed
 * in the attack path are attack steps by definition; a path with no flagged entry point enters at its
 * first non-attacker node; the assigned technique is in play because the item was built around it.
 * Everything else (connectivity, references, options, leakage, consistency, rubric) stays strict.
 */
export function normaliseGeneratorOutput(out: GeneratorOutput, domain: ReasoningDomain, seed: VariationSeed): { out: GeneratorOutput; repairs: string[] } {
  const repairs: string[] = [];
  const d = out.diagram;
  const path = new Set(d.attack_path);
  const edges = d.edges.map((e) => (path.has(e.id) && e.kind !== 'attack' ? (repairs.push(`edge ${e.id} typed as attack`), { ...e, kind: 'attack' as const }) : e));
  // The attack edges listed out of order but forming one chain: put them in chain order.
  let attackPath = d.attack_path;
  const pathEdges = attackPath.map((id) => edges.find((e) => e.id === id)).filter((e): e is (typeof edges)[number] => Boolean(e));
  const connected = pathEdges.every((e, i) => i === 0 || pathEdges[i - 1]!.to === e.from);
  if (!connected && pathEdges.length === attackPath.length) {
    const targets = new Set(pathEdges.map((e) => e.to));
    const starts = pathEdges.filter((e) => !targets.has(e.from));
    if (starts.length === 1) {
      const chain = [starts[0]!];
      while (chain.length < pathEdges.length) {
        const next = pathEdges.find((e) => !chain.includes(e) && e.from === chain[chain.length - 1]!.to);
        if (!next) break;
        chain.push(next);
      }
      if (chain.length === pathEdges.length) {
        attackPath = chain.map((e) => e.id);
        repairs.push('attack path reordered into chain order');
      }
    }
  }
  let nodes = d.nodes;
  if (!nodes.some((n) => n.entry_point)) {
    const firstEdge = edges.find((e) => e.id === d.attack_path[0]);
    const outside = (id: string) => {
      const n = nodes.find((x) => x.id === id);
      const b = n && d.boundaries.find((x) => x.id === n.boundary);
      return !n || ['attacker', 'external', 'client', 'user'].includes(n.type) || b?.kind === 'internet';
    };
    const entryId = firstEdge ? (outside(firstEdge.from) ? firstEdge.to : firstEdge.from) : nodes.find((n) => n.compromised)?.id;
    if (entryId) {
      nodes = nodes.map((n) => (n.id === entryId ? { ...n, entry_point: true, compromised: true } : n));
      repairs.push(`entry point inferred: ${entryId}`);
    }
  }
  let techniques = out.techniques;
  if (!techniques.some((t) => t.id === seed.technique)) {
    const t = domain.techniques.find((x) => x.id === seed.technique);
    if (t) {
      techniques = [t, ...techniques].slice(0, 6);
      repairs.push(`assigned technique ${t.id} added`);
    }
  }
  return { out: { ...out, diagram: { ...d, edges, nodes, attack_path: attackPath }, techniques }, repairs };
}

export function validateGeneratedItem(out: GeneratorOutput, domain: ReasoningDomain, seed: VariationSeed): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Options: four, A-D, distinct, plausible lengths, no tells.
  const ids = out.options.map((o) => o.id);
  if (out.options.length !== 4 || OPTION_IDS.some((id) => ids.filter((x) => x === id).length !== 1)) errors.push('options: exactly four options with ids A, B, C and D are required');
  const texts = out.options.map((o) => norm(o.text));
  if (new Set(texts).size !== texts.length) errors.push('options: two options say the same thing');
  for (const o of out.options) {
    if (o.text.trim().length < 15) errors.push(`options: option ${o.id} is too short to be a real choice`);
    if (BANNED_OPTION.test(o.text.trim())) errors.push(`options: option ${o.id} uses "all/none of the above"`);
  }
  const lens = out.options.map((o) => o.text.trim().length).filter((n) => n > 0);
  if (lens.length === 4 && Math.max(...lens) / Math.min(...lens) > 2.5) errors.push('options: option lengths differ too much (the longest must not give the answer away)');
  if (!OPTION_IDS.includes(out.correct_option)) errors.push('correct_option must be one of A-D');
  const analysisIds = out.option_analysis.map((a) => a.id);
  if (OPTION_IDS.some((id) => !analysisIds.includes(id))) errors.push('option_analysis must cover every option');
  const best = out.option_analysis.filter((a) => a.verdict === 'best');
  if (best.length !== 1) errors.push('option_analysis: exactly one option must be marked best');
  else if (best[0]!.id !== out.correct_option) errors.push('option_analysis: the best option must be the correct option');

  // Leakage: the learner-visible text must not name the answer.
  for (const [field, text] of [['scenario', out.scenario], ['attack_narrative', out.attack_narrative], ['question', out.question], ['objective', out.objective]] as const) {
    if (LEAK_PATTERNS.some((p) => p.test(text))) errors.push(`${field}: must not point at the answer`);
  }
  if (out.scenario.trim().length < 200) errors.push('scenario: too short to reason from (give the environment and its data)');
  if (out.attack_narrative.trim().length < 120) errors.push('attack_narrative: too short (what happened, step by step)');
  if (out.question.trim().length < 20) errors.push('question: too short');

  // Diagram integrity and consistency with the narrative.
  errors.push(...validateDiagram(out.diagram));
  const visible = `${out.scenario}\n${out.attack_narrative}\n${out.question}`;
  const edgeById = new Map(out.diagram.edges.map((e) => [e.id, e]));
  const nodeById = new Map(out.diagram.nodes.map((n) => [n.id, n]));
  const pathNodeIds = new Set<string>();
  for (const id of out.diagram.attack_path) {
    const e = edgeById.get(id);
    if (e) {
      pathNodeIds.add(e.from);
      pathNodeIds.add(e.to);
    }
  }
  const pathNodes = [...pathNodeIds].map((id) => nodeById.get(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
  const unmentioned = pathNodes.filter((n) => n.type !== 'attacker' && !mentionsLabel(visible, n.label));
  if (pathNodes.length && unmentioned.length / pathNodes.length > 0.3) {
    errors.push(`consistency: the narrative must name the components on the attack path (missing: ${unmentioned.map((n) => `"${n.label}"`).join(', ')})`);
  } else if (unmentioned.length) warnings.push(`consistency: not named in the narrative: ${unmentioned.map((n) => n.label).join(', ')}`);
  const entry = out.diagram.nodes.find((n) => n.entry_point);
  if (entry && !mentionsLabel(visible, entry.label)) errors.push(`consistency: the entry point "${entry.label}" must be named in the narrative`);

  // Rubric: enough points per dimension, unique ids, bounded weights.
  const rIds = new Set<string>();
  for (const p of out.rubric) {
    if (rIds.has(p.id)) errors.push(`rubric: duplicate point id "${p.id}"`);
    rIds.add(p.id);
    if (p.text.trim().length < 15) errors.push(`rubric: point "${p.id}" is too vague`);
    if (p.hint.trim().length < 15) errors.push(`rubric: point "${p.id}" needs a hint the learner can act on`);
  }
  const count = (dim: string) => out.rubric.filter((p) => p.dimension === dim).length;
  if (count('reasoning') < 3) errors.push('rubric: at least three reasoning points');
  if (count('architecture') < 2) errors.push('rubric: at least two architecture points');
  if (count('risk') < 1) errors.push('rubric: at least one risk point');
  if (out.rubric.length > 12) errors.push('rubric: at most twelve points');
  const mIds = new Set<string>();
  for (const m of out.must_not_credit) {
    if (mIds.has(m.id)) errors.push(`must_not_credit: duplicate id "${m.id}"`);
    mIds.add(m.id);
    for (const inv of m.invalidates) if (!rIds.has(inv)) errors.push(`must_not_credit: "${m.id}" invalidates unknown rubric point "${inv}"`);
  }
  if (out.must_not_credit.length > 6) errors.push('must_not_credit: at most six claims');
  if (out.reference_answer.trim().length < 150) errors.push('reference_answer: too short for an expert explanation');

  // Difficulty: the architecture and the attack must be as demanding as the level promises.
  const steps = out.diagram.attack_path.length;
  const nodeCount = out.diagram.nodes.length;
  if (seed.difficulty === 'advanced' && (steps < 3 || nodeCount < 9)) errors.push(`difficulty: advanced needs at least 3 attack steps and 9 components (got ${steps} and ${nodeCount})`);
  if (seed.difficulty === 'expert' && (steps < 4 || nodeCount < 11)) errors.push(`difficulty: expert needs at least 4 attack steps and 11 components (got ${steps} and ${nodeCount})`);
  if (seed.difficulty === 'intermediate' && (steps < 2 || nodeCount < 6)) errors.push(`difficulty: intermediate needs at least 2 attack steps and 6 components (got ${steps} and ${nodeCount})`);
  if (seed.difficulty === 'beginner' && steps > 2) errors.push(`difficulty: beginner allows at most 2 attack steps (got ${steps})`);

  // Techniques and concepts.
  if (!out.techniques.length) errors.push('techniques: name at least one ATT&CK technique');
  for (const t of out.techniques) if (!TECHNIQUE_ID.test(t.id)) errors.push(`techniques: "${t.id}" is not an ATT&CK technique id`);
  if (!out.techniques.some((t) => t.id === seed.technique)) errors.push(`techniques: the assigned technique ${seed.technique} must be among the techniques in play`);
  if (out.techniques.length > 6) warnings.push('techniques: more than six listed');
  if (out.difficulty !== seed.difficulty) warnings.push(`difficulty: generator wrote ${out.difficulty}, seed asked for ${seed.difficulty}`);

  return { ok: errors.length === 0, errors, warnings };
}

/** Splits the generator's output into the stored public and private halves. */
export function toGeneratedItem(out: GeneratorOutput, domain: ReasoningDomain, seed: VariationSeed, weights: Weights): GeneratedItem {
  const diagram: DiagramData = {
    boundaries: out.diagram.boundaries,
    nodes: out.diagram.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, boundary: n.boundary, detail: n.detail, compromised: n.compromised, entryPoint: n.entry_point, controls: n.controls })),
    edges: out.diagram.edges,
    attackPath: out.diagram.attack_path,
  };
  return {
    public: {
      domain: domain.key,
      difficulty: seed.difficulty,
      title: out.title,
      scenario: out.scenario,
      attackNarrative: out.attack_narrative,
      objective: out.objective,
      question: out.question,
      options: OPTION_IDS.map((id) => out.options.find((o) => o.id === id)!),
      diagram,
      techniques: out.techniques,
      concepts: out.concepts,
    },
    private: {
      correctOption: out.correct_option,
      optionAnalysis: OPTION_IDS.map((id) => out.option_analysis.find((a) => a.id === id)!),
      rubric: out.rubric.map((p) => ({ id: p.id, dimension: p.dimension, text: p.text, weight: Number(p.weight), hint: p.hint, explanation: p.explanation })),
      mustNotCredit: out.must_not_credit,
      referenceAnswer: out.reference_answer,
    },
    weights,
    seed,
    fingerprint: fingerprintOf(seed),
  };
}
