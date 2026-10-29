import type { DiagramData, OptionId } from '@threatready/contracts';
import { architectureText, composeDiagram, levelOf, normaliseOverlay, pathKey, pathNodeIds, surfacesFor, validateOverlay, type ArchitectureDef, type AttackOverlay } from './architectures/index.js';
import { ATTACK_ENTERPRISE, fingerprintOf, type ReasoningDomain, type VariationSeed, type Weights } from './domain.types.js';
import type { GeneratedItem, GeneratorOutput, LibraryGeneratorOutput } from './item.types.js';
import { LIBRARY_LEVEL_LIMITS } from './prompts/generation.prompts.js';
import { qualityChecks } from './quality.js';
import { jaccard, shingles } from './similarity.js';

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
const LEAK_PATTERNS = [/correct (answer|option)/i, /best (answer|option) is/i, /\boption [a-d] is (correct|right|best)/i, /\(correct\)/i, /\bthe answer is\b/i];
const BANNED_OPTION = /^(all|none) of the above/i;
const GENERIC = new Set(['the', 'and', 'for', 'with', 'from', 'prod', 'service', 'server', 'cloud', 'main', 'primary', 'public', 'private', 'internal', 'external', 'app', 'web', 'data', 'store', 'user', 'users', 'role', 'account', 'system', 'tier', 'node', 'host', 'api']);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A word without its plural ending, so "staff laptops" is named by "a staff laptop" and "policies" by
 * "policy" (library labels are fixed and often plural; the text a model writes about them is not).
 */
const stem = (w: string): string => {
  if (w.length < 4 || w.endsWith('ss')) return w;
  if (w.endsWith('ies')) return w.slice(0, -3);
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') ? w.slice(0, -1) : w;
};

/**
 * A label counts as mentioned when it appears verbatim, or every one of its specific words does (in
 * the singular or the plural). A label with no specific word of 4+ letters ("cloud ERP", "CDN with WAF",
 * "SSO") counts when one of its non-generic 3-letter words appears as a whole word.
 */
export function mentionsLabel(text: string, label: string): boolean {
  const t = norm(text);
  const l = norm(label);
  if (!l) return true;
  if (t.includes(l)) return true;
  const words = l.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w));
  if (!words.length) {
    const short = l.split(' ').filter((w) => w.length === 3 && !GENERIC.has(w));
    const padded = ` ${t} `;
    return short.length ? short.some((w) => padded.includes(` ${w} `)) : t.includes(l);
  }
  return words.every((w) => t.includes(stem(w)));
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

  // Techniques and concepts: ids must belong to the domain's framework (ATT&CK by default, ATLAS for AI).
  const fw = domain.framework ?? ATTACK_ENTERPRISE;
  if (!out.techniques.length) errors.push(`techniques: name at least one ${fw.name} technique`);
  for (const t of out.techniques) if (!fw.idPattern.test(t.id)) errors.push(`techniques: "${t.id}" is not a ${fw.name} technique id`);
  if (!out.techniques.some((t) => t.id === seed.technique)) errors.push(`techniques: the assigned technique ${seed.technique} must be among the techniques in play`);
  if (out.techniques.length > 6) warnings.push('techniques: more than six listed');
  if (out.difficulty !== seed.difficulty) warnings.push(`difficulty: generator wrote ${out.difficulty}, seed asked for ${seed.difficulty}`);

  // Content quality (quality.ts): answer given away in the visible text, a timeline that runs
  // backwards, misstated regulation figures, distractors not shown to fail. Run after the structural
  // rules so one regeneration gets every reason at once (the feedback keeps the first twelve).
  for (const f of qualityChecks(out)) (f.severity === 'error' ? errors : warnings).push(f.message);

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

/* ---------------- gen.v3: the quality gate for questions on the architecture library (design §3.4) ---------------- */

/** The overlay a library question carries, as the model wrote it. */
export const overlayOf = (out: LibraryGeneratorOutput): AttackOverlay => ({ entryNode: out.attack.entry_node, compromisedNodes: out.attack.compromised_nodes, steps: out.attack.steps });

/** A composed diagram in the shape validateDiagram reads. */
export function asGeneratorDiagram(d: DiagramData): GeneratorOutput['diagram'] {
  return {
    boundaries: d.boundaries,
    nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, boundary: n.boundary, detail: n.detail, compromised: n.compromised, entry_point: n.entryPoint, controls: n.controls })),
    edges: d.edges,
    attack_path: d.attackPath,
  };
}

/** Runs of this many consecutive words shared by a private field and a public one count as leakage. */
const LEAK_RUN = 8;
/** Runs of this many words (outside component and control labels) the best option shares with the situation or narrative and no distractor does: a wording tell (review AR-SEC-3). */
const TELL_RUN = 6;
/** "option B", "answer C": a reference to an option by its letter outside the options. Capital letters only, so the article "a" never matches. */
const OPTION_REF = /\b[Oo]ption\s+[A-D]\b|\b[Aa]nswer\s+[A-D]\b|\b[Cc]hoice\s+[A-D]\b/;
const runs = (text: string, n = LEAK_RUN): Set<string> => {
  const w = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};
/** `text` normalised with every component, origin and control label replaced by one placeholder word, so runs never span a label. */
function withoutLabels(text: string, labels: readonly string[]): string {
  let t = ` ${norm(text)} `;
  for (const l of labels) t = t.split(` ${l} `).join(' \u0000 ');
  return t.trim();
}
/** Runs of `n` words that contain no label placeholder. */
const plainRuns = (text: string, labels: readonly string[], n: number): Set<string> => {
  const out = new Set<string>();
  const w = withoutLabels(text, labels).split(' ').filter(Boolean);
  for (let i = 0; i + n <= w.length; i++) {
    const run = w.slice(i, i + n);
    if (!run.includes('\u0000')) out.add(run.join(' '));
  }
  return out;
};
const archRuns = new WeakMap<ArchitectureDef, Map<number, Set<string>>>();
/** Word runs of the architecture text: wording every question on the architecture may share, never a leak. */
function architectureRuns(arch: ArchitectureDef, n = LEAK_RUN): Set<string> {
  let byLength = archRuns.get(arch);
  if (!byLength) archRuns.set(arch, (byLength = new Map()));
  let r = byLength.get(n);
  if (!r) byLength.set(n, (r = runs(architectureText(arch), n)));
  return r;
}

/** Component labels, attacker-origin labels and control labels an option may name. */
function namedThings(arch: ArchitectureDef): string[] {
  return [...new Set([...arch.diagram.nodes.map((n) => n.label), ...arch.diagram.nodes.flatMap((n) => n.controls), ...arch.controls.map((c) => c.label)].filter((l) => norm(l).length >= 3))];
}

/**
 * Repairs that carry no information the gate needs: the overlay's mechanical omissions (normaliseOverlay:
 * chain order, an inferred entry node, duplicate compromised ids), technique names taken from the domain's
 * list, duplicate technique ids dropped, and the assigned technique added (the item was built around it).
 */
export function normaliseLibraryOutput(out: LibraryGeneratorOutput, arch: ArchitectureDef, domain: ReasoningDomain, seed: VariationSeed): { out: LibraryGeneratorOutput; overlay: AttackOverlay; repairs: string[] } {
  const { overlay, repairs } = normaliseOverlay(arch, overlayOf(out));
  const known = new Map(domain.techniques.map((t) => [t.id, t]));
  let techniques = out.techniques.filter((t, i) => out.techniques.findIndex((x) => x.id === t.id) === i).map((t) => known.get(t.id) ?? t);
  if (techniques.length !== out.techniques.length) repairs.push('duplicate techniques dropped');
  if (!techniques.some((t) => t.id === seed.technique)) {
    const t = known.get(seed.technique);
    if (t) {
      techniques = [t, ...techniques].slice(0, 6);
      repairs.push(`assigned technique ${t.id} added`);
    }
  }
  return {
    out: { ...out, attack: { entry_node: overlay.entryNode, compromised_nodes: overlay.compromisedNodes, steps: overlay.steps }, techniques },
    overlay,
    repairs,
  };
}

export interface LibraryValidation extends ValidationResult {
  /** The composed diagram when the attack is grounded (null when the overlay itself failed). */
  diagram: DiagramData | null;
}

/**
 * The quality gate (design §3.4), run on every model output after normaliseLibraryOutput. Any error fails
 * the gate and the question is rewritten (once, by the stronger tier). The similarity check (rule 9)
 * runs in GenerationService against the bank.
 */
export function validateLibraryItem(out: LibraryGeneratorOutput, arch: ArchitectureDef, domain: ReasoningDomain, seed: VariationSeed, overlay: AttackOverlay = overlayOf(out)): LibraryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const level = levelOf(seed.difficulty);
  const nodeById = new Map(arch.diagram.nodes.map((n) => [n.id, n]));
  const origins = new Set(arch.attackerOrigins.map((o) => o.id));

  // 2. Grounded attack: the overlay on this architecture, and the composed diagram.
  const surface = surfacesFor(arch, domain.key).find((s) => s.id === seed.entryPoint);
  if (!surface) errors.push(`attack: the architecture ${arch.id} has no ${domain.key} surface "${seed.entryPoint}"`);
  const ov = validateOverlay(arch, overlay, { level, surface });
  errors.push(...ov.errors);
  warnings.push(...ov.warnings);
  let diagram: DiagramData | null = null;
  if (!ov.errors.length) {
    diagram = composeDiagram(arch, overlay);
    errors.push(...validateDiagram(asGeneratorDiagram(diagram)));
  }
  const pathNodes = pathNodeIds(overlay)
    .filter((id) => !origins.has(id))
    .map((id) => nodeById.get(id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));

  // 3. One correct option.
  const ids = out.options.map((o) => o.id);
  if (out.options.length !== 4 || OPTION_IDS.some((id) => ids.filter((x) => x === id).length !== 1)) errors.push('options: exactly four options with ids A, B, C and D are required');
  if (!OPTION_IDS.includes(out.correct_option)) errors.push('correct_option must be one of A-D');
  const analysisIds = out.option_analysis.map((a) => a.id);
  if (OPTION_IDS.some((id) => analysisIds.filter((x) => x === id).length !== 1)) errors.push('option_analysis must cover every option exactly once');
  const best = out.option_analysis.filter((a) => a.verdict === 'best');
  if (best.length !== 1) errors.push('option_analysis: exactly one option must be marked best');
  else if (best[0]!.id !== out.correct_option) errors.push('option_analysis: the best option must be the correct option');
  if (!out.option_analysis.some((a) => a.id !== out.correct_option && (a.verdict === 'plausible' || a.verdict === 'weak'))) errors.push('option_analysis: at least one distractor must be plausible or weak, not every one wrong');

  // 4. Plausible options, no tells.
  for (const o of out.options) {
    const len = o.text.trim().length;
    if (len < 15) errors.push(`options: option ${o.id} is too short to be a real choice`);
    if (len > 360) errors.push(`options: option ${o.id} is longer than 360 characters`);
    if (BANNED_OPTION.test(o.text.trim())) errors.push(`options: option ${o.id} uses "all/none of the above"`);
  }
  const texts = out.options.map((o) => norm(o.text));
  if (new Set(texts).size !== texts.length) errors.push('options: two options say the same thing');
  const lens = out.options.map((o) => o.text.trim().length).filter((n) => n > 0);
  if (lens.length === 4 && Math.max(...lens) / Math.min(...lens) > 2.5) errors.push('options: option lengths differ too much (the longest must not give the answer away)');
  const correct = out.options.find((o) => o.id === out.correct_option);
  const distractors = out.options.filter((o) => o.id !== out.correct_option);
  if (correct && distractors.length) {
    const longest = Math.max(...distractors.map((o) => o.text.trim().length));
    if (correct.text.trim().length > longest * 1.2) errors.push(`options: the best option (${correct.id}) is more than 20% longer than every distractor, a length tell`);
  }
  const sh = out.options.map((o) => shingles(o.text));
  for (let i = 0; i < sh.length; i++)
    for (let j = i + 1; j < sh.length; j++) if (jaccard(sh[i]!, sh[j]!) >= 0.6) errors.push(`options: options ${out.options[i]!.id} and ${out.options[j]!.id} are worded almost the same`);
  const things = namedThings(arch);
  for (const o of out.options) if (!things.some((l) => mentionsLabel(o.text, l))) errors.push(`options: option ${o.id} names no component or control of the architecture (use their labels)`);
  const onPath = out.options.filter((o) => pathNodes.some((n) => mentionsLabel(o.text, n.label)));
  if (pathNodes.length && onPath.length < 2) errors.push('options: at least two options must name a component on the attack path, so naming the path is not a tell');

  // 5. No answer leakage in the public fields. The attack-step labels (drawn on the diagram) and the
  // concepts are public too (review AR-SEC-3).
  const stepLabels = overlay.steps.map((st, i) => [`attack step ${i + 1} label`, st.label] as const);
  const publicProse = [
    ['title', out.title],
    ['situation', out.situation],
    ['attack_narrative', out.attack_narrative],
    ['objective', out.objective],
    ['question', out.question],
  ] as const;
  const conceptFields = out.concepts.map((c, i) => [`concept ${i + 1}`, c] as const);
  for (const [field, text] of [...publicProse, ...stepLabels, ...conceptFields, ...out.options.map((o) => [`option ${o.id}`, o.text] as const)]) {
    if (LEAK_PATTERNS.some((p) => p.test(text))) errors.push(`${field}: must not point at the answer`);
  }
  for (const [field, text] of [...publicProse, ...stepLabels, ...conceptFields]) if (OPTION_REF.test(text)) errors.push(`${field}: must not refer to an option by its letter`);
  // Word-for-word runs of the answer key (review AR-BIZ-1). The title, objective and question must not
  // share one with any of it. The situation, the narrative and the step labels state the evidence, which
  // the key cites by design ("the audit log records the policy change"), so they are checked only
  // against the best option's analysis, less what a distractor's analysis also says: that is where the
  // reason the answer is right lives.
  const shared = architectureRuns(arch);
  const secret = new Set<string>();
  for (const t of [out.reference_answer, out.architecture_analysis, ...out.option_analysis.map((a) => a.why)]) for (const r of runs(t)) if (!shared.has(r)) secret.add(r);
  const distractorWhy = new Set<string>();
  for (const a of out.option_analysis) if (a.id !== out.correct_option) for (const r of runs(a.why)) distractorWhy.add(r);
  const bestWhy = new Set<string>();
  for (const a of out.option_analysis) if (a.id === out.correct_option) for (const r of runs(a.why)) if (!shared.has(r) && !distractorWhy.has(r)) bestWhy.add(r);
  const keyChecks: (readonly [string, string, Set<string>])[] = [
    ['title', out.title, secret],
    ['objective', out.objective, secret],
    ['question', out.question, secret],
    ['situation', out.situation, bestWhy],
    ['attack_narrative', out.attack_narrative, bestWhy],
    ...stepLabels.map(([f, t]) => [f, t, bestWhy] as const),
  ];
  for (const [field, text, against] of keyChecks) {
    const hit = [...runs(text)].find((r) => against.has(r));
    if (hit) errors.push(`${field}: repeats the answer key word for word ("${hit}")`);
  }
  // The best option must not reuse the situation's or the narrative's wording that no distractor uses
  // (review AR-SEC-3): a run of TELL_RUN words outside component and control labels.
  const labels = [...new Set([...namedThings(arch), ...arch.attackerOrigins.map((o) => o.label)].map(norm).filter(Boolean))].sort((a, b) => b.length - a.length);
  const bestOption = out.options.find((o) => o.id === out.correct_option);
  if (bestOption) {
    const context = plainRuns(`${out.situation}\n${out.attack_narrative}`, labels, TELL_RUN);
    const others = new Set<string>();
    for (const o of out.options) if (o.id !== bestOption.id) for (const r of plainRuns(o.text, labels, TELL_RUN)) others.add(r);
    const archTell = architectureRuns(arch, TELL_RUN);
    const tell = [...plainRuns(bestOption.text, labels, TELL_RUN)].find((r) => context.has(r) && !others.has(r) && !archTell.has(r));
    if (tell) errors.push(`options: the best option repeats the situation or narrative word for word ("${tell}") and no other option does, a wording tell`);
  }

  // Lengths of what the learner reads.
  if (out.situation.trim().length < 200) errors.push('situation: too short (what is happening today and the constraint, 80-150 words)');
  if (out.attack_narrative.trim().length < 120) errors.push('attack_narrative: too short (what happened, step by step)');
  if (out.question.trim().length < 20) errors.push('question: too short');
  if (out.title.trim().length < 8) errors.push('title: too short');

  // 6. Narrative consistency: the text (not the shared organisation summary) names the path.
  const visible = `${out.situation}\n${out.attack_narrative}\n${out.question}`;
  const unmentioned = pathNodes.filter((n) => !mentionsLabel(visible, n.label));
  if (pathNodes.length && unmentioned.length / pathNodes.length > 0.3) {
    errors.push(`consistency: the situation and narrative must name the components on the attack path (missing: ${unmentioned.map((n) => `"${n.label}"`).join(', ')})`);
  } else if (unmentioned.length) warnings.push(`consistency: not named in the narrative: ${unmentioned.map((n) => n.label).join(', ')}`);
  const entry = nodeById.get(overlay.entryNode);
  if (entry && !mentionsLabel(visible, entry.label)) errors.push(`consistency: the entry point "${entry.label}" must be named in the situation or narrative`);

  // 7. Rubric complete.
  const limits = LIBRARY_LEVEL_LIMITS[level];
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
  if (out.rubric.length < limits.rubricMin) errors.push(`rubric: ${level} questions need at least ${limits.rubricMin} points (got ${out.rubric.length})`);
  if (out.rubric.length > 12) errors.push('rubric: at most twelve points');
  const mIds = new Set<string>();
  for (const m of out.must_not_credit) {
    if (mIds.has(m.id)) errors.push(`must_not_credit: duplicate id "${m.id}"`);
    mIds.add(m.id);
    for (const inv of m.invalidates) if (!rIds.has(inv)) errors.push(`must_not_credit: "${m.id}" invalidates unknown rubric point "${inv}"`);
  }
  if (out.must_not_credit.length < limits.mncMin || out.must_not_credit.length > limits.mncMax) errors.push(`must_not_credit: ${limits.mncMin} to ${limits.mncMax} claims (got ${out.must_not_credit.length})`);
  if (out.reference_answer.trim().length < 150) errors.push('reference_answer: too short for an expert explanation');
  if (out.architecture_analysis.trim().length < 150) errors.push('architecture_analysis: too short (the components, boundaries, trust relationships and controls on the path)');

  // 8. Techniques.
  const fw = domain.framework ?? ATTACK_ENTERPRISE;
  if (!out.techniques.length) errors.push(`techniques: name at least one ${fw.name} technique`);
  for (const t of out.techniques) if (!fw.idPattern.test(t.id)) errors.push(`techniques: "${t.id}" is not a ${fw.name} technique id`);
  if (!out.techniques.some((t) => t.id === seed.technique)) errors.push(`techniques: the assigned technique ${seed.technique} must be among the techniques in play`);
  if (out.techniques.length > 6) errors.push('techniques: at most six');

  // Warnings: logged with a metric, never a rejection.
  if (out.difficulty !== level) warnings.push(`difficulty: the writer wrote ${out.difficulty}, the seed asked for ${level}`);
  if (level === 'advanced') {
    const subtle = arch.trustRelationships.filter((t) => t.subtle).flatMap((t) => [t.from, t.to]);
    const labels = subtle.map((id) => nodeById.get(id)?.label).filter((l): l is string => Boolean(l));
    if (labels.length && !labels.some((l) => mentionsLabel(out.reference_answer, l))) warnings.push('advanced: the reference answer names no component of a trust relationship marked easy to overlook');
  }
  return { ok: errors.length === 0, errors, warnings, diagram };
}

/** Splits a library question into the stored public and private halves; the diagram and scenario come from the architecture. */
export function toLibraryItem(out: LibraryGeneratorOutput, arch: ArchitectureDef, domain: ReasoningDomain, seed: VariationSeed, weights: Weights, overlay: AttackOverlay = overlayOf(out)): GeneratedItem {
  const known = new Map(domain.techniques.map((t) => [t.id, t]));
  const stored: VariationSeed = {
    ...seed,
    topology: arch.id,
    architecture: { id: arch.id, version: arch.version, surface: seed.entryPoint, pathKey: pathKey(arch, overlay) },
  };
  return {
    public: {
      domain: domain.key,
      difficulty: seed.difficulty,
      title: out.title,
      // Two paragraphs: the architecture's organisation summary, then what is happening today (rendered with pre-line).
      scenario: `${arch.organisation.summary}\n\n${out.situation}`,
      attackNarrative: out.attack_narrative,
      objective: out.objective,
      question: out.question,
      options: OPTION_IDS.map((id) => out.options.find((o) => o.id === id)!),
      diagram: composeDiagram(arch, overlay),
      techniques: out.techniques.map((t) => known.get(t.id) ?? t),
      concepts: out.concepts,
    },
    private: {
      correctOption: out.correct_option,
      optionAnalysis: OPTION_IDS.map((id) => out.option_analysis.find((a) => a.id === id)!),
      rubric: out.rubric.map((p) => ({ id: p.id, dimension: p.dimension, text: p.text, weight: Number(p.weight), hint: p.hint, explanation: p.explanation })),
      mustNotCredit: out.must_not_credit,
      referenceAnswer: out.reference_answer,
      architectureAnalysis: out.architecture_analysis,
    },
    weights,
    seed: stored,
    fingerprint: fingerprintOf(stored),
    architectureId: arch.id,
  };
}
