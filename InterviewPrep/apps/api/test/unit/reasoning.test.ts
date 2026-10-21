import { describe, expect, it } from 'vitest';
import { fakeReasoningItem } from '../../src/platform/adapters/fake/reasoning.fake.js';
import { CLOUD_SECURITY } from '../../src/modules/reasoning/domains/cloud-security.js';
import { catalogue, getDomain, isAvailable } from '../../src/modules/reasoning/domains/index.js';
import { fingerprintOf, type VariationSeed } from '../../src/modules/reasoning/domain.types.js';
import type { GeneratorOutput, RubricPoint } from '../../src/modules/reasoning/item.types.js';
import { generationRequest, generationSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { DEFAULT_WEIGHTS, normaliseWeights, REASONING_SCORING_VERSION, scoreAttempt, type PointJudgement, type ScoringInput } from '../../src/modules/reasoning/scoring.js';
import { describeSeed, pickSeed } from '../../src/modules/reasoning/seed.js';
import { checkSimilarity, comparableText, jaccard, shingles } from '../../src/modules/reasoning/similarity.js';
import { mentionsLabel, normaliseGeneratorOutput, toGeneratedItem, validateDiagram, validateGeneratedItem } from '../../src/modules/reasoning/validation.js';

const seed = (over: Partial<VariationSeed> = {}): VariationSeed => ({ domain: 'cloud_security', difficulty: 'intermediate', topology: 'three_tier_web', entryPoint: 'leaked_access_key', objective: 'break_the_path', technique: 'T1078.004', constraint: 'change_freeze', ...over });

/** A valid generated item from the fake producer, parsed through the real output schema. */
function fakeItem(s: VariationSeed = seed()): GeneratorOutput {
  const req = generationRequest({ domain: CLOUD_SECURITY, seed: s, avoid: [], previousFailure: [], tryNumber: 1 });
  return generationSchema().zod.parse(fakeReasoningItem(req));
}

const rubric: RubricPoint[] = [
  { id: 'r1', dimension: 'reasoning', text: 'names the identity', weight: 5, hint: 'h1', explanation: 'e1' },
  { id: 'r2', dimension: 'reasoning', text: 'uses the log evidence', weight: 3, hint: 'h2', explanation: 'e2' },
  { id: 'r3', dimension: 'reasoning', text: 'compares alternatives', weight: 2, hint: 'h3', explanation: 'e3' },
  { id: 'a1', dimension: 'architecture', text: 'traces the path', weight: 3, hint: 'h4', explanation: 'e4' },
  { id: 'a2', dimension: 'architecture', text: 'load balancer not on path', weight: 1, hint: 'h5', explanation: 'e5' },
  { id: 'k1', dimension: 'risk', text: 'evidence and constraint', weight: 2, hint: 'h6', explanation: 'e6' },
];
const JUST = 'The attacker is using the deploy-prod role, as the audit log shows calls from an unknown address. Revoking that role and scoping its policy stops the download of exports and the pivot toward the database, while keeping the load balancer serving and preserving the audit log for forensics.';
const all = (status: 'met' | 'partial' | 'missed', quote: string | null = 'The attacker is using the deploy-prod role'): PointJudgement[] => rubric.map((p) => ({ pointId: p.id, status, rationale: 'r', quote: status === 'missed' ? null : quote }));
const base = (over: Partial<ScoringInput> = {}): ScoringInput => ({
  weights: DEFAULT_WEIGHTS,
  rubric,
  mustNotCredit: [{ id: 'm1', claim: 'the WAF would have blocked it', why: 'not on the path', invalidates: ['a2'] }],
  correctOption: 'B',
  selectedOption: 'B',
  selectedVerdict: 'best',
  partialCreditForPlausible: 0.25,
  justification: JUST,
  final: all('met'),
  evaluator: all('met'),
  assertedClaims: [],
  technicalErrors: [],
  challenger: { hallucinatedReferences: 0, fluentButWrong: false, missingCritical: 0 },
  integrity: { offTopic: false, instructsGrader: false, arguesForOption: null },
  degraded: false,
  ...over,
});

describe('attack reasoning: scoring engine', () => {
  it('weights always normalise to four integers summing to 100', () => {
    expect(normaliseWeights(null)).toEqual({ correctness: 30, reasoning: 40, architecture: 20, risk: 10 });
    const w = normaliseWeights({ correctness: 3, reasoning: 3, architecture: 3, risk: 1 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    expect(normaliseWeights({ correctness: 0, reasoning: 0, architecture: 0, risk: 0 })).toEqual(DEFAULT_WEIGHTS);
    expect(Object.values(normaliseWeights({ reasoning: 55 })).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('a correct answer with every point evidenced scores 100; a correct guess with nothing scores only the correctness weight', () => {
    const full = scoreAttempt(base());
    expect(full.total).toBe(100);
    expect(full.correct).toBe(true);
    expect(full.confidence).toBe('high');
    expect(full.reviewFlag).toBe(false);
    expect(full.version).toBe(REASONING_SCORING_VERSION);
    const guess = scoreAttempt(base({ final: all('missed'), evaluator: all('missed'), justification: 'B is right.' }));
    expect(guess.total).toBe(30);
    expect(guess.dimensions.find((d) => d.key === 'reasoning')!.score).toBe(0);
  });

  it('a wrong selection with sophisticated reasoning cannot reach a high score', () => {
    const wrong = scoreAttempt(base({ selectedOption: 'D', selectedVerdict: 'weak' }));
    expect(wrong.correct).toBe(false);
    // correctness 0 + reasoning capped at 60% of 40 + architecture 20 + risk 10
    expect(wrong.total).toBe(54);
    const plausible = scoreAttempt(base({ selectedOption: 'A', selectedVerdict: 'plausible' }));
    expect(plausible.dimensions.find((d) => d.key === 'correctness')!.score).toBe(7.5);
    expect(plausible.total).toBe(62);
    expect(plausible.total).toBeLessThan(scoreAttempt(base()).total);
  });

  it('withdraws credit whose evidence quote is not verbatim in the justification', () => {
    const out = scoreAttempt(base({ final: all('met', 'this sentence never appears'), evaluator: all('met', 'this sentence never appears') }));
    expect(out.total).toBe(30);
    expect(out.notes.join(' ')).toMatch(/withdrawn/);
    expect(out.dimensions.find((d) => d.key === 'reasoning')!.evidence.every((e) => e.status === 'missed')).toBe(true);
  });

  it('an asserted must-not-credit claim invalidates the points it lists', () => {
    const out = scoreAttempt(base({ assertedClaims: ['m1'] }));
    const arch = out.dimensions.find((d) => d.key === 'architecture')!;
    expect(arch.evidence.find((e) => e.point === 'load balancer not on path')!.status).toBe('missed');
    expect(arch.score).toBe(15); // 3 of 4 weight points
    expect(out.total).toBe(95);
  });

  it('a justification arguing for a different option is capped; a wrong decision caps reasoning', () => {
    const contra = scoreAttempt(base({ integrity: { offTopic: false, instructsGrader: false, arguesForOption: 'C' } }));
    expect(contra.dimensions.find((d) => d.key === 'reasoning')!.score).toBe(20);
    expect(contra.dimensions.find((d) => d.key === 'reasoning')!.notes.join(' ')).toMatch(/argues for option C/);
    expect(contra.total).toBe(80);
  });

  it('confirmed technical errors deduct from reasoning, capped at half', () => {
    const one = scoreAttempt(base({ technicalErrors: [{ quote: 'x', why: 'y' }] }));
    expect(one.dimensions.find((d) => d.key === 'reasoning')!.score).toBe(36);
    const many = scoreAttempt(base({ technicalErrors: Array.from({ length: 9 }, () => ({ quote: 'x', why: 'y' })) }));
    expect(many.dimensions.find((d) => d.key === 'reasoning')!.score).toBe(20);
  });

  it('grader-instructing or off-topic text earns nothing on the reasoning dimensions and is flagged for review', () => {
    const out = scoreAttempt(base({ integrity: { offTopic: false, instructsGrader: true, arguesForOption: null } }));
    expect(out.total).toBe(30);
    expect(out.reviewFlag).toBe(true);
    expect(out.confidence).toBe('low');
    const off = scoreAttempt(base({ integrity: { offTopic: true, instructsGrader: false, arguesForOption: null } }));
    expect(off.total).toBe(30);
  });

  it('confidence follows inter-stage disagreement and challenger findings; degraded results are flagged', () => {
    const medium = scoreAttempt(base({ evaluator: rubric.map((p, i) => ({ pointId: p.id, status: i < 2 ? 'partial' : 'met', rationale: 'r', quote: 'The attacker is using the deploy-prod role' })) }));
    expect(medium.confidence).toBe('medium');
    const low = scoreAttempt(base({ evaluator: all('missed') }));
    expect(low.confidence).toBe('low');
    expect(low.reviewFlag).toBe(true);
    const halluc = scoreAttempt(base({ challenger: { hallucinatedReferences: 1, fluentButWrong: false, missingCritical: 0 } }));
    expect(halluc.confidence).toBe('low');
    const degraded = scoreAttempt(base({ degraded: true }));
    expect(degraded.reviewFlag).toBe(true);
    expect(degraded.notes.join(' ')).toMatch(/Simplified scoring/);
  });

  it('length never adds points: a long justification with no evidenced points scores the same as a short one', () => {
    const long = scoreAttempt(base({ final: all('missed'), evaluator: all('missed'), justification: `${JUST} ${JUST} ${JUST} ${JUST}` }));
    const short = scoreAttempt(base({ final: all('missed'), evaluator: all('missed'), justification: 'B.' }));
    expect(long.total).toBe(short.total);
  });
});

describe('attack reasoning: generated-item validation', () => {
  it('accepts a well-formed item and splits it into public and private halves', () => {
    const out = fakeItem();
    const v = validateGeneratedItem(out, CLOUD_SECURITY, seed());
    expect(v.errors).toEqual([]);
    const item = toGeneratedItem(out, CLOUD_SECURITY, seed(), DEFAULT_WEIGHTS);
    expect(item.public.options.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(item.private.correctOption).toBe('B');
    expect(item.fingerprint).toBe('cloud_security|three_tier_web|leaked_access_key|break_the_path|T1078.004');
    expect(JSON.stringify(item.public)).not.toMatch(/rubric|correct|reference/i);
  });

  it('rejects the wrong number of options, duplicate options, length tells and answer leaks', () => {
    const three = fakeItem();
    three.options = three.options.slice(0, 3);
    expect(validateGeneratedItem(three, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/exactly four options/);
    const dup = fakeItem();
    dup.options[2]!.text = dup.options[1]!.text;
    expect(validateGeneratedItem(dup, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/say the same thing/);
    const tell = fakeItem();
    tell.options[1]!.text = `${tell.options[1]!.text} ${tell.options[1]!.text} ${tell.options[1]!.text}`;
    expect(validateGeneratedItem(tell, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/lengths differ/);
    const leak = fakeItem();
    leak.question = `${leak.question} The correct answer is B.`;
    expect(validateGeneratedItem(leak, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/must not point at the answer/);
    const wrongBest = fakeItem();
    wrongBest.correct_option = 'A';
    expect(validateGeneratedItem(wrongBest, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/best option must be the correct option/);
  });

  it('rejects broken diagrams: dangling references, disconnected or wrongly typed attack paths, no entry point', () => {
    const out = fakeItem();
    const d = out.diagram;
    expect(validateDiagram(d)).toEqual([]);
    expect(validateDiagram({ ...d, edges: [...d.edges, { id: 'x', from: 'app', to: 'ghost', label: 'l', kind: 'data' }] }).join(' ')).toMatch(/unknown node "ghost"/);
    expect(validateDiagram({ ...d, attack_path: ['a2', 'a1'] }).join(' ')).toMatch(/not connected/);
    expect(validateDiagram({ ...d, attack_path: ['e1'] }).join(' ')).toMatch(/kind "attack"/);
    expect(validateDiagram({ ...d, nodes: d.nodes.map((n) => ({ ...n, entry_point: false })) }).join(' ')).toMatch(/entry point/);
    expect(validateDiagram({ ...d, attack_path: ['zzz'] }).join(' ')).toMatch(/unknown edge/);
  });

  it('requires the narrative to name the components on the attack path and the assigned technique', () => {
    const out = fakeItem();
    out.scenario = 'A company runs a platform with many services and a database. '.repeat(6);
    out.attack_narrative = 'Something happened to an identity and data was downloaded from storage. '.repeat(3);
    const v = validateGeneratedItem(out, CLOUD_SECURITY, seed());
    expect(v.errors.join(' ')).toMatch(/consistency/);
    const tech = fakeItem();
    tech.techniques = [{ id: 'T1530', name: 'Data from Cloud Storage' }];
    expect(validateGeneratedItem(tech, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/assigned technique/);
    expect(mentionsLabel('the exports-prod bucket was read', 'exports-prod bucket')).toBe(true);
    expect(mentionsLabel('the Exports bucket was read', 'exports-prod bucket')).toBe(true);
    expect(mentionsLabel('nothing here', 'customer database')).toBe(false);
  });

  it('repairs mechanical omissions before validating: path edge kinds, a missing entry flag, the assigned technique', () => {
    const out = fakeItem();
    out.diagram.edges = out.diagram.edges.map((e) => (e.id === 'a1' ? { ...e, kind: 'data' as const } : e));
    out.diagram.nodes = out.diagram.nodes.map((n) => ({ ...n, entry_point: false }));
    out.techniques = [{ id: 'T1530', name: 'Data from Cloud Storage' }];
    expect(validateGeneratedItem(out, CLOUD_SECURITY, seed()).ok).toBe(false);
    const { out: fixed, repairs } = normaliseGeneratorOutput(out, CLOUD_SECURITY, seed());
    expect(repairs).toHaveLength(3);
    expect(fixed.diagram.edges.find((e) => e.id === 'a1')!.kind).toBe('attack');
    expect(fixed.diagram.nodes.find((n) => n.id === 'role')!.entry_point).toBe(true);
    expect(fixed.techniques[0]!.id).toBe('T1078.004');
    expect(validateGeneratedItem(fixed, CLOUD_SECURITY, seed()).errors).toEqual([]);
    // A path that starts at an outside node (attacker, client, internet boundary) is accepted.
    const outside = fakeItem();
    outside.diagram.edges.push({ id: 'a0', from: 'attacker', to: 'role', label: 'uses the leaked key', kind: 'attack' });
    outside.diagram.attack_path = ['a0', 'a1', 'a2'];
    expect(validateDiagram(outside.diagram)).toEqual([]);
  });

  it('requires enough rubric points per dimension and known must-not-credit targets', () => {
    const out = fakeItem();
    out.rubric = out.rubric.filter((p) => p.dimension !== 'risk');
    expect(validateGeneratedItem(out, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/at least one risk point/);
    const bad = fakeItem();
    bad.must_not_credit[0]!.invalidates = ['nope'];
    expect(validateGeneratedItem(bad, CLOUD_SECURITY, seed()).errors.join(' ')).toMatch(/unknown rubric point "nope"/);
  });
});

describe('attack reasoning: uniqueness', () => {
  it('seeds avoid what the learner has seen and rotate every part of the variation', () => {
    const rng = () => 0.42;
    const first = pickSeed(CLOUD_SECURITY, [], rng);
    const second = pickSeed(CLOUD_SECURITY, [first], rng);
    expect(fingerprintOf(second)).not.toBe(fingerprintOf(first));
    expect(second.topology).not.toBe(first.topology);
    expect(second.entryPoint).not.toBe(first.entryPoint);
    expect(second.objective).not.toBe(first.objective);
    const recent = [first, second];
    const third = pickSeed(CLOUD_SECURITY, recent, rng, new Set(recent.map(fingerprintOf)));
    expect(recent.map(fingerprintOf)).not.toContain(fingerprintOf(third));
    const d = describeSeed(CLOUD_SECURITY, third);
    expect(d.topology.label).toBeTruthy();
    expect(d.objective.question).toMatch(/\?$/);
  });

  it('items from different seeds read differently; the same text is caught by the similarity check', () => {
    const a = toGeneratedItem(fakeItem(seed()), CLOUD_SECURITY, seed(), DEFAULT_WEIGHTS);
    const bSeed = seed({ topology: 'data_lake', entryPoint: 'ssrf_metadata', objective: 'detect_first', technique: 'T1552.005', constraint: 'regulated_data' });
    const b = toGeneratedItem(fakeItem(bSeed), CLOUD_SECURITY, bSeed, DEFAULT_WEIGHTS);
    const sim = jaccard(shingles(comparableText(a.public)), shingles(comparableText(b.public)));
    expect(sim).toBeLessThan(0.35);
    const prev = [{ id: 'p1', fingerprint: a.fingerprint, text: comparableText(a.public) }];
    expect(checkSimilarity({ fingerprint: b.fingerprint, text: comparableText(b.public) }, prev, 0.35).tooSimilar).toBe(false);
    const same = checkSimilarity({ fingerprint: 'other', text: comparableText(a.public) }, prev, 0.35);
    expect(same.tooSimilar).toBe(true);
    expect(same.max).toBe(1);
    expect(checkSimilarity({ fingerprint: a.fingerprint, text: 'completely different words' }, prev, 0.35).fingerprintCollision).toBe(true);
  });
});

describe('attack reasoning: difficulty', () => {
  it('the seed carries the requested difficulty and the validator enforces its floors', () => {
    const adv = pickSeed(CLOUD_SECURITY, [], () => 0.1, new Set(), 'advanced');
    expect(adv.difficulty).toBe('advanced');
    const item = fakeItem(seed({ difficulty: 'advanced' }));
    expect(item.diagram.attack_path.length).toBeGreaterThanOrEqual(3);
    expect(validateGeneratedItem(item, CLOUD_SECURITY, seed({ difficulty: 'advanced' })).ok).toBe(true);
    const tooEasy = fakeItem(seed({ difficulty: 'intermediate' }));
    expect(validateGeneratedItem(tooEasy, CLOUD_SECURITY, seed({ difficulty: 'advanced' })).errors.join(' ')).toMatch(/advanced needs at least 3 attack steps/);
    const tooHard = fakeItem(seed({ difficulty: 'advanced' }));
    expect(validateGeneratedItem(tooHard, CLOUD_SECURITY, seed({ difficulty: 'beginner' })).errors.join(' ')).toMatch(/beginner allows at most 2/);
    const easy = fakeItem(seed({ difficulty: 'beginner' }));
    expect(validateGeneratedItem(easy, CLOUD_SECURITY, seed({ difficulty: 'beginner' })).ok).toBe(true);
  });
});

describe('attack reasoning: domain registry', () => {
  it('registers Cloud Security end to end and lists the fifteen planned domains', () => {
    expect(isAvailable('cloud_security')).toBe(true);
    expect(isAvailable('network_security')).toBe(false);
    expect(getDomain('cloud_security')?.skillIds).toContain('cloudsec.iam');
    const all = catalogue();
    expect(all).toHaveLength(15);
    expect(all.filter((d) => d.available).map((d) => d.key)).toEqual(['cloud_security']);
    const w = CLOUD_SECURITY.weights;
    expect(w.correctness + w.reasoning + w.architecture + w.risk).toBe(100);
    for (const t of CLOUD_SECURITY.techniques) expect(t.id).toMatch(/^T\d{4}(\.\d{3})?$/);
    for (const o of CLOUD_SECURITY.variation.objectives) expect(Object.values(normaliseWeights(o.weights, w)).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
