import { describe, expect, it } from 'vitest';
import type { ReasoningDomainKey } from '@threatready/contracts';
import { ARCHITECTURES, architectureShingles, architecturesFor, architectureText, getArchitecture, pathNodeIds, surfacesFor, type ArchitectureDef, type ArchitectureLevel } from '../../src/modules/reasoning/architectures/index.js';
import { getDomain, registeredDomains } from '../../src/modules/reasoning/domains/index.js';
import { fingerprintOf, type ReasoningDomain, type VariationSeed } from '../../src/modules/reasoning/domain.types.js';
import type { LibraryGeneratorOutput } from '../../src/modules/reasoning/item.types.js';
import { GENERATION_PROMPT_VERSION, GENERATOR_VERSION, questionPrefix, questionRequest, questionSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { DEFAULT_WEIGHTS } from '../../src/modules/reasoning/scoring.js';
import { pickLibrarySeed, structureKeyOf } from '../../src/modules/reasoning/seed.js';
import { checkLibrarySimilarity, comparableText, jaccard, shingles } from '../../src/modules/reasoning/similarity.js';
import { mentionsLabel, normaliseLibraryOutput, toLibraryItem, validateLibraryItem } from '../../src/modules/reasoning/validation.js';
import { fakeReasoningQuestion } from '../../src/platform/adapters/fake/reasoning-question.fake.js';

/**
 * Questions on the architecture library (cost design 26 Oct 2026, §3): the seed picker, the writer's
 * request layout, the output schema, every rule of the quality gate with one failing fixture each, the
 * architecture-aware similarity check, and the stored item. No database, no model.
 */

interface Fixture {
  domain: ReasoningDomain;
  arch: ArchitectureDef;
  seed: VariationSeed;
  out: LibraryGeneratorOutput;
}

/** A seed on one architecture and surface (the first by default), with fixed objective, technique and constraint. */
function seedOn(domain: ReasoningDomain, arch: ArchitectureDef, surfaceIndex = 0, objective?: string): VariationSeed {
  const surface = surfacesFor(arch, domain.key)[surfaceIndex]!;
  const base = pickLibrarySeed(domain, arch.level, [arch], [], () => 0);
  const technique = surface.techniques.find((t) => domain.techniques.some((x) => x.id === t)) ?? base.technique;
  return { ...base, entryPoint: surface.id, objective: objective ?? base.objective, technique, architecture: { id: arch.id, version: arch.version, surface: surface.id } };
}

/** A schema-valid question from the fake writer for a seed. */
function fixture(domainKey: ReasoningDomainKey = 'cloud_security', level: ArchitectureLevel = 'beginner', surfaceIndex = 0, objective?: string, archIndex = 0): Fixture {
  const domain = getDomain(domainKey)!;
  const arch = architecturesFor(domain.key, level)[archIndex]!;
  const seed = seedOn(domain, arch, surfaceIndex, objective);
  const surface = surfacesFor(arch, domain.key).find((s) => s.id === seed.entryPoint)!;
  const req = questionRequest({ arch, domain, seed, surface, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 });
  return { domain, arch, seed, out: questionSchema(arch, domain).zod.parse(fakeReasoningQuestion(req)) };
}

/** The gate as GenerationService runs it: normalise, then validate. */
function gate(f: Fixture, mutate?: (o: LibraryGeneratorOutput) => void) {
  const out = structuredClone(f.out);
  mutate?.(out);
  const n = normaliseLibraryOutput(out, f.arch, f.domain, f.seed);
  return { ...validateLibraryItem(n.out, f.arch, f.domain, f.seed, n.overlay), repairs: n.repairs, out: n.out, overlay: n.overlay };
}
const errorsOf = (f: Fixture, mutate: (o: LibraryGeneratorOutput) => void) => gate(f, mutate).errors.join(' | ');

describe('architecture library questions: the seed', () => {
  const cloud = getDomain('cloud_security')!;

  it('spreads a bucket over its architectures, least-used surface first, with distinct fingerprints in a batch', () => {
    for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
      const archs = architecturesFor(cloud.key, level);
      if (archs.length < 2) continue;
      const batch: VariationSeed[] = [];
      for (let i = 0; i < archs.length; i++) batch.push(pickLibrarySeed(cloud, level, archs, batch, () => 0.37));
      // One question per architecture before any architecture gets a second.
      expect(new Set(batch.map((s) => s.topology)).size, level).toBe(archs.length);
      const more: VariationSeed[] = [...batch];
      for (let i = 0; i < 12; i++) more.push(pickLibrarySeed(cloud, level, archs, more, () => (i * 0.29) % 1, new Set(more.map(fingerprintOf))));
      expect(new Set(more.map(fingerprintOf)).size, level).toBe(more.length);
      for (const s of more) {
        expect(s.difficulty).toBe(level);
        expect(s.architecture).toEqual({ id: s.topology, version: getArchitecture(s.topology)!.version, surface: s.entryPoint });
      }
    }
  });

  it('takes the least-used surface of the chosen architecture, and objectives and techniques from the surface', () => {
    const archs = architecturesFor(cloud.key, 'beginner');
    const arch = archs.find((a) => surfacesFor(a, cloud.key).length >= 2)!;
    const [s1, s2] = surfacesFor(arch, cloud.key);
    const recent: VariationSeed[] = [seedOn(cloud, arch, 0), seedOn(cloud, arch, 0)];
    // Make every other architecture of the bucket look busier, so this one is chosen.
    for (const other of archs.filter((a) => a.id !== arch.id)) for (let i = 0; i < 3; i++) recent.push(seedOn(cloud, other, 0));
    const next = pickLibrarySeed(cloud, 'beginner', archs, recent, () => 0);
    expect(next.topology).toBe(arch.id);
    expect(next.entryPoint).toBe(s2!.id);
    expect(next.entryPoint).not.toBe(s1!.id);
    for (let i = 0; i < 20; i++) {
      const s = pickLibrarySeed(cloud, 'beginner', archs, [], () => i / 20);
      const surface = surfacesFor(getArchitecture(s.topology)!, cloud.key).find((x) => x.id === s.entryPoint)!;
      expect(surface.techniques).toContain(s.technique);
      expect(surface.objectives ?? cloud.variation.objectives.map((o) => o.id)).toContain(s.objective);
      expect(cloud.variation.constraints.map((c) => c.id)).toContain(s.constraint);
    }
  });

  it('honours the excluded fingerprints while another combination remains', () => {
    const archs = architecturesFor(cloud.key, 'beginner');
    const first = pickLibrarySeed(cloud, 'beginner', archs, [], () => 0);
    const second = pickLibrarySeed(cloud, 'beginner', archs, [], () => 0, new Set([fingerprintOf(first)]));
    expect(fingerprintOf(second)).not.toBe(fingerprintOf(first));
  });
});

describe('architecture library questions: the request', () => {
  const two = ARCHITECTURES.map((a) => ({ a, ds: Object.keys(a.attackSurfaces) as ReasoningDomainKey[] })).find((x) => x.ds.length >= 2)!;

  it('puts the writer rules and the architecture in a byte-stable prefix shared by every domain, the domain and level in system, the variation in the user message', () => {
    const [k1, k2] = two.ds;
    const d1 = getDomain(k1!)!;
    const d2 = getDomain(k2!)!;
    const req = (d: ReasoningDomain, tier: 'SMALL' | 'LARGE' = 'SMALL') => {
      const seed = seedOn(d, two.a);
      return questionRequest({ arch: two.a, domain: d, seed, surface: surfacesFor(two.a, d.key)[0]!, tier, avoid: [], previousFailure: [], tryNumber: 1 });
    };
    const r1 = req(d1);
    const r2 = req(d2);
    const r3 = req(d1, 'LARGE');
    expect(r1.systemPrefix).toBe(r2.systemPrefix);
    expect(r1.systemPrefix).toBe(r3.systemPrefix);
    expect(r1.systemPrefix).toBe(questionPrefix(two.a));
    expect(r1.systemPrefix).toContain(architectureText(two.a));
    expect(r1.systemPrefix).not.toContain(d1.title);
    expect(r1.system).toContain(d1.title);
    expect(r1.system).toContain(d1.guidance);
    expect(r1.system).not.toBe(r2.system);
    const u = r1.messages[0]!.content;
    expect(u).toContain(`- Architecture: ${two.a.id}`);
    expect(u).toContain(surfacesFor(two.a, d1.key)[0]!.summary);
    // No other domain's surfaces anywhere: the surfaces are never part of the architecture text.
    for (const [key, list] of Object.entries(two.a.attackSurfaces)) {
      for (const s of list ?? []) {
        if (key === d1.key && s.id === surfacesFor(two.a, d1.key)[0]!.id) continue;
        for (const part of [r1.systemPrefix!, r1.system, u]) expect(part.includes(s.summary), `${key}/${s.id}`).toBe(false);
      }
    }
    expect(two.a.reviewNotes ? r1.systemPrefix!.includes(two.a.reviewNotes) : false).toBe(false);
    // Tier parameters: Haiku without an effort and with room for a long item; Sonnet at medium effort.
    expect(r1).toMatchObject({ tier: 'SMALL', maxOutputTokens: 8000, timeoutMs: 90_000, promptVersion: GENERATION_PROMPT_VERSION });
    expect(r1.effort).toBeUndefined();
    expect(r3).toMatchObject({ tier: 'LARGE', maxOutputTokens: 12_000, effort: 'medium' });
    expect(GENERATOR_VERSION).toBe('gen.v3.2026-10-26');
    expect(GENERATION_PROMPT_VERSION).toBe('reasoning-generate.v5');
  });

  it('lists at most 8 questions to avoid and feeds the gate findings back on a retry, in the user message only', () => {
    const d = getDomain(two.ds[0]!)!;
    const seed = seedOn(d, two.a);
    const avoid = Array.from({ length: 12 }, (_, i) => ({ title: `Earlier question ${i}`, question: `What now ${i}?`, path: 'a > b', objective: 'detect_first' }));
    const r = questionRequest({ arch: two.a, domain: d, seed, surface: surfacesFor(two.a, d.key)[0]!, tier: 'LARGE', avoid, previousFailure: ['options: the best option is longer than every distractor'], tryNumber: 2 });
    const u = r.messages[0]!.content;
    expect(u.match(/^- Earlier question \d+:/gm)).toHaveLength(8);
    expect(u).toContain('[path: a > b; objective: detect_first]');
    expect(u).toMatch(/Try 2: the previous item was rejected by the quality check/);
    expect(u).toContain('the best option is longer than every distractor');
    expect(r.system + r.systemPrefix).not.toContain('Earlier question');
  });

  it('limits component, origin and technique ids to the architecture and the domain in the output schema', () => {
    const f = fixture();
    const schema = questionSchema(f.arch, f.domain);
    expect(schema.name).toBe('reasoning_question');
    expect(schema.zod.safeParse(f.out).success).toBe(true);
    const bad = (mutate: (o: LibraryGeneratorOutput) => void) => {
      const o = structuredClone(f.out);
      mutate(o);
      return schema.zod.safeParse(o).success;
    };
    expect(bad((o) => (o.attack.entry_node = 'ghost-node'))).toBe(false);
    expect(bad((o) => (o.attack.steps[0]!.to = 'ghost-node'))).toBe(false);
    expect(bad((o) => (o.techniques = [{ id: 'T9999', name: 'Invented' }]))).toBe(false);
    // An attacker origin may start the path, never end a step.
    const origin = f.arch.attackerOrigins[0]!.id;
    expect(bad((o) => (o.attack.steps[0]!.from = origin))).toBe(true);
    expect(bad((o) => (o.attack.steps[0]!.to = origin))).toBe(false);
    // The JSON schema sent to the provider carries the enums too.
    expect(JSON.stringify(schema.jsonSchema)).toContain(f.arch.diagram.nodes[0]!.id);
  });
});

describe('architecture library questions: the quality gate', () => {
  it('passes a well-formed question and stores the architecture, the composed diagram and the two-paragraph scenario', () => {
    const f = fixture();
    const g = gate(f);
    expect(g.errors).toEqual([]);
    const item = toLibraryItem(g.out, f.arch, f.domain, f.seed, DEFAULT_WEIGHTS, g.overlay);
    expect(item.architectureId).toBe(f.arch.id);
    expect(item.public.scenario).toBe(`${f.arch.organisation.summary}\n\n${g.out.situation}`);
    expect(item.public.diagram.attackPath).toEqual(g.overlay.steps.map((_, i) => `atk${i + 1}`));
    const ids = item.public.diagram.nodes.map((n) => n.id);
    for (const n of f.arch.diagram.nodes) expect(ids).toContain(n.id);
    expect(item.public.diagram.nodes.filter((n) => n.entryPoint).map((n) => n.id)).toEqual([g.overlay.entryNode]);
    expect(item.seed.architecture).toEqual({ id: f.arch.id, version: f.arch.version, surface: f.seed.entryPoint, pathKey: `${f.arch.id}:${pathNodeIds(g.overlay).join('>')}` });
    expect(item.fingerprint).toBe([f.domain.key, f.arch.id, f.seed.entryPoint, f.seed.objective, f.seed.technique].join('|'));
    expect(item.private.architectureAnalysis).toBe(g.out.architecture_analysis);
    expect(item.private.correctOption).toBe('B');
    expect(JSON.stringify(item.public)).not.toMatch(/rubric|correctOption|referenceAnswer|architectureAnalysis|optionAnalysis|mustNotCredit/);
    // Technique names come from the domain's list, whatever the writer called them.
    const renamed = gate(f, (o) => (o.techniques = o.techniques.map((t) => ({ ...t, name: 'whatever' }))));
    expect(renamed.out.techniques.every((t) => f.domain.techniques.some((d) => d.id === t.id && d.name === t.name))).toBe(true);
  });

  it('grounds the attack: steps chain within the level range, compromised components on the path, the seed surface touched', () => {
    const f = fixture();
    const steps = f.out.attack.steps;
    expect(errorsOf(f, (o) => (o.attack.steps = [...steps, { from: steps[0]!.from, to: steps[0]!.to, label: 'again' }, { from: steps[0]!.to, to: steps[0]!.from, label: 'back' }]))).toMatch(/beginner questions use 1-2 attack steps|repeats|chain/);
    expect(errorsOf(f, (o) => (o.attack.steps = []))).toMatch(/attack steps/);
    // A component marked compromised but not on the path is dropped (a repair since review COST-1, it used to reject the question).
    const offPath = f.arch.diagram.nodes.find((n) => !pathNodeIds({ entryNode: f.out.attack.entry_node, compromisedNodes: [], steps }).includes(n.id))!;
    const marked = gate(f, (o) => (o.attack.compromised_nodes = [...o.attack.compromised_nodes, offPath.id]));
    expect(marked.errors).toEqual([]);
    expect(marked.repairs.join(' ')).toMatch(/compromised nodes off the path dropped/);
    expect(marked.overlay.compromisedNodes).not.toContain(offPath.id);
    // A step from a component to itself is dropped too; a path of nothing but loops is still rejected.
    const looped = gate(f, (o) => (o.attack.steps = [...o.attack.steps, { from: steps.at(-1)!.to, to: steps.at(-1)!.to, label: 'stays put' }]));
    expect(looped.errors).toEqual([]);
    expect(looped.repairs.join(' ')).toMatch(/self-loop step dropped/);
    expect(errorsOf(f, (o) => (o.attack.steps = [{ from: steps[0]!.to, to: steps[0]!.to, label: 'loops' }]))).toMatch(/loops on/);
    // A long step label is clipped at a word for the public diagram, never mid-word.
    const long = gate(f, (o) => (o.attack.steps = o.attack.steps.map((x) => ({ ...x, label: 'uses the leaked deploy key from the public repository to list and then download every object' }))));
    expect(long.errors).toEqual([]);
    for (const st of long.overlay.steps) {
      expect(st.label.length).toBeLessThanOrEqual(70);
      expect('uses the leaked deploy key from the public repository to list and then download every object'.split(' ')).toContain(st.label.split(' ').at(-1));
    }
    // A path that touches none of the surface's entry or target components.
    const surface = surfacesFor(f.arch, f.domain.key).find((s) => s.id === f.seed.entryPoint)!;
    const touch = new Set([...surface.entryNodeIds, ...surface.targetNodeIds]);
    const edge = f.arch.diagram.edges.find((e) => !touch.has(e.from) && !touch.has(e.to))!;
    expect(errorsOf(f, (o) => (o.attack = { entry_node: edge.from, compromised_nodes: [edge.from], steps: [{ from: edge.from, to: edge.to, label: 'moves on' }] }))).toMatch(/must use the surface/);
    // Steps listed out of order but forming one chain are put back in order (a repair, not a rejection).
    const adv = fixture('cloud_security', 'advanced');
    const shuffled = gate(adv, (o) => (o.attack.steps = [...o.attack.steps].reverse()));
    expect(shuffled.repairs).toContain('attack steps reordered into chain order');
    expect(shuffled.errors).toEqual([]);
  });

  it('requires exactly one correct option that is the key, and at least one distractor that is not simply wrong', () => {
    const f = fixture();
    expect(errorsOf(f, (o) => (o.options = o.options.slice(0, 3)))).toMatch(/exactly four options/);
    expect(errorsOf(f, (o) => (o.option_analysis[0]!.verdict = 'best'))).toMatch(/exactly one option must be marked best/);
    expect(errorsOf(f, (o) => (o.correct_option = 'A'))).toMatch(/best option must be the correct option/);
    expect(errorsOf(f, (o) => o.option_analysis.forEach((a) => (a.verdict = a.id === o.correct_option ? 'best' : 'wrong')))).toMatch(/at least one distractor must be plausible or weak/);
  });

  it('rejects option tells: lengths, a longer key, all of the above, near-identical wording, options that name nothing or no path component', () => {
    const f = fixture();
    const entry = f.arch.diagram.nodes.find((n) => n.id === f.out.attack.entry_node)!.label;
    expect(errorsOf(f, (o) => (o.options[3]!.text = `Shut the ${entry}.`))).toMatch(/lengths differ too much/);
    expect(errorsOf(f, (o) => (o.options[1]!.text = `${o.options[1]!.text} Then document every step in the change record, tell the owners of the ${entry} and schedule a review.`))).toMatch(/more than 20% longer/);
    expect(errorsOf(f, (o) => (o.options[2]!.text = `None of the above actions would help with the ${entry} at this stage of the incident.`))).toMatch(/all\/none of the above/);
    expect(errorsOf(f, (o) => (o.options[2]!.text = o.options[1]!.text.replace(/again\.$/, 'ever.')))).toMatch(/worded almost the same/);
    expect(errorsOf(f, (o) => (o.options[3]!.text = 'Write a short note to the whole team about staying calm and careful today.'))).toMatch(/option D names no component or control/);
    const off = f.arch.diagram.nodes.filter((n) => !pathNodeIds({ entryNode: '', compromisedNodes: [], steps: f.out.attack.steps }).includes(n.id));
    expect(
      errorsOf(f, (o) =>
        o.options.forEach((x, i) => (x.text = `Change the settings of the ${off[i % off.length]!.label} so that it behaves more strictly than it does today in production (${x.id}).`)),
      ),
    ).toMatch(/at least two options must name a component on the attack path/);
  });

  it('rejects answer leakage in the public fields: leak phrases, option letters, the key copied word for word', () => {
    const f = fixture();
    expect(errorsOf(f, (o) => (o.question = `${o.question} The correct answer is B.`))).toMatch(/question: must not point at the answer/);
    expect(errorsOf(f, (o) => (o.situation = `${o.situation} Option B looks safest to the team.`))).toMatch(/situation: must not refer to an option by its letter/);
    // The narrative may state the evidence the reference answer and the analysis cite (review AR-BIZ-1: 4 of 9 real rejections)...
    expect(errorsOf(f, (o) => (o.attack_narrative = `${o.attack_narrative} ${o.reference_answer.split(' ').slice(10, 22).join(' ')}.`))).not.toMatch(/repeats the answer key/);
    expect(errorsOf(f, (o) => (o.situation = `${o.situation} ${o.architecture_analysis.split(' ').slice(4, 16).join(' ')}.`))).not.toMatch(/repeats the answer key/);
    // ...but not the reason the best option is right, word for word; the title, objective and question nothing of the key.
    const bestWhy = f.out.option_analysis.find((a) => a.id === f.out.correct_option)!.why;
    expect(errorsOf(f, (o) => (o.attack_narrative = `${o.attack_narrative} ${bestWhy.split(' ').slice(0, 12).join(' ')}.`))).toMatch(/attack_narrative: repeats the answer key word for word/);
    expect(errorsOf(f, (o) => (o.title = `${o.title} ${o.option_analysis[1]!.why.split(' ').slice(0, 9).join(' ')}`))).toMatch(/title: repeats the answer key/);
    expect(errorsOf(f, (o) => (o.question = `${o.question} ${o.reference_answer.split(' ').slice(10, 22).join(' ')}?`))).toMatch(/question: repeats the answer key/);
    // Evidence the best option's analysis shares with a distractor's is evidence, not the answer.
    const both = gate(f, (o) => {
      const shared = 'the cloud audit log records the policy change at the start of the window';
      o.option_analysis.forEach((a) => (a.why = `${a.why} Note that ${shared}.`));
      o.attack_narrative = `${o.attack_narrative} Later, ${shared}.`;
    });
    expect(both.errors.join(' ')).not.toMatch(/repeats the answer key/);
    // The architecture's own wording is shared by design and is never a leak.
    const summaryRun = f.arch.organisation.summary.split(' ').slice(0, 12).join(' ');
    const shared = gate(f, (o) => {
      o.situation = `${o.situation} ${summaryRun}.`;
      o.reference_answer = `${o.reference_answer} ${summaryRun}.`;
    });
    expect(shared.errors.join(' ')).not.toMatch(/repeats the answer key/);
  });

  it('checks the public step labels and concepts for leaks, and rejects a best option that reuses the narrative wording no distractor uses (review AR-SEC-3)', () => {
    const f = fixture();
    const bestWhy = f.out.option_analysis.find((a) => a.id === f.out.correct_option)!.why;
    expect(errorsOf(f, (o) => (o.attack.steps[0]!.label = 'the correct answer is to revoke it'))).toMatch(/attack step 1 label: must not point at the answer/);
    expect(errorsOf(f, (o) => (o.attack.steps[0]!.label = 'see option B for the fix'))).toMatch(/attack step 1 label: must not refer to an option/);
    expect(errorsOf(f, (o) => (o.attack.steps[0]!.label = bestWhy.split(' ').slice(0, 9).join(' ')))).toMatch(/attack step 1 label: repeats the answer key/);
    expect(errorsOf(f, (o) => (o.concepts = [...o.concepts.slice(0, 3), 'the best option is B']))).toMatch(/concept 4: must not point at the answer/);
    // The real Haiku case: the narrative and the best option both say the trust policy accepts tokens from any branch.
    const tell = 'trust policy accepts tokens from any branch not only main';
    expect(
      errorsOf(f, (o) => {
        o.attack_narrative = `${o.attack_narrative} The deploy role's ${tell}.`;
        const best = o.options.find((x) => x.id === o.correct_option)!;
        best.text = `${best.text.replace(/\.$/, '')}; its ${tell}.`.slice(0, 340);
      }),
    ).toMatch(/best option repeats the situation or narrative word for word/);
    // The same words in a distractor too: no tell.
    expect(
      errorsOf(f, (o) => {
        o.attack_narrative = `${o.attack_narrative} The deploy role's ${tell}.`;
        for (const x of o.options) if (x.id === o.correct_option || x.id === 'D') x.text = `${x.text.replace(/\.$/, '')}; its ${tell}.`.slice(0, 340);
      }),
    ).not.toMatch(/wording tell/);
    // Naming the same components as the narrative is not a tell: the labels are left out of the runs.
    const path = f.out.attack.steps.map((x) => f.arch.diagram.nodes.find((n) => n.id === x.to)?.label).filter(Boolean).join(' and the ');
    expect(errorsOf(f, (o) => (o.attack_narrative = `${o.attack_narrative} It went through the ${path}.`))).not.toMatch(/wording tell/);
  });

  it('a surface with several targets asks for one chain that ends at one of them (review AR-BIZ-9)', () => {
    const domain = getDomain('cloud_security')!;
    const arch = getArchitecture('b3-mobile-backend')!;
    const surface = surfacesFor(arch, domain.key).find((x) => x.targetNodeIds.length > 1)!;
    expect(surface, 'b3 has a multi-target cloud surface').toBeTruthy();
    const seed = { ...seedOn(domain, arch), entryPoint: surface.id, architecture: { id: arch.id, version: arch.version, surface: surface.id } };
    const user = questionRequest({ arch, domain, seed, surface, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 }).messages[0]!.content;
    expect(user).toMatch(/Target: one of .*The path is a single chain that ends at ONE of these targets/);
    const single = surfacesFor(arch, domain.key).find((x) => x.targetNodeIds.length === 1)!;
    const user1 = questionRequest({ arch, domain, seed: { ...seed, entryPoint: single.id }, surface: single, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 }).messages[0]!.content;
    expect(user1).not.toMatch(/ONE of these targets/);
    expect(questionPrefix(arch)).toMatch(/one chain, never a branch/);
  });

  it('every fake question on every architecture, surface and level passes the gate (the e2e suites rely on it)', () => {
    let n = 0;
    for (const domain of registeredDomains())
      for (const level of ['beginner', 'intermediate', 'advanced'] as const)
        for (const arch of architecturesFor(domain.key, level))
          for (const surface of surfacesFor(arch, domain.key)) {
            const seed = { ...seedOn(domain, arch), entryPoint: surface.id, architecture: { id: arch.id, version: arch.version, surface: surface.id } };
            const req = questionRequest({ arch, domain, seed, surface, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 });
            const raw = fakeReasoningQuestion(req);
            if (!raw) continue;
            const g = gate({ domain, arch, seed, out: questionSchema(arch, domain).zod.parse(raw) });
            expect(g.errors, `${domain.key} ${arch.id} ${surface.id}`).toEqual([]);
            n++;
          }
    expect(n).toBeGreaterThan(200);
  });

  it('requires the situation and narrative to name the path and the entry point', () => {
    const f = fixture();
    const errs = errorsOf(f, (o) => {
      o.situation = 'A company runs a platform with many services and a database, and the team is busy this week. '.repeat(3);
      o.attack_narrative = 'Something happened to an identity and data was downloaded from somewhere. '.repeat(3);
    });
    expect(errs).toMatch(/consistency: the situation and narrative must name the components on the attack path|consistency: the entry point/);
  });

  it('requires a complete rubric for the level, 2-5 must-not-credit claims, a reference answer and an architecture analysis', () => {
    const f = fixture();
    expect(errorsOf(f, (o) => (o.rubric = o.rubric.filter((p) => p.dimension !== 'risk')))).toMatch(/at least one risk point/);
    expect(errorsOf(f, (o) => (o.rubric = o.rubric.slice(0, 5)))).toMatch(/beginner questions need at least 6 points/);
    const adv = fixture('cloud_security', 'advanced');
    expect(errorsOf(adv, (o) => (o.rubric = o.rubric.slice(0, 8)))).toMatch(/advanced questions need at least 9 points/);
    expect(errorsOf(f, (o) => (o.must_not_credit = o.must_not_credit.slice(0, 1)))).toMatch(/must_not_credit: 2 to 5 claims/);
    expect(errorsOf(f, (o) => (o.must_not_credit[0]!.invalidates = ['nope']))).toMatch(/unknown rubric point "nope"/);
    expect(errorsOf(f, (o) => (o.reference_answer = 'Revoke it.'))).toMatch(/reference_answer: too short/);
    expect(errorsOf(f, (o) => (o.architecture_analysis = 'It crosses a boundary.'))).toMatch(/architecture_analysis: too short/);
    expect(errorsOf(f, (o) => (o.rubric[0]!.hint = 'Try harder.'))).toMatch(/needs a hint/);
  });

  it('adds the assigned technique when the writer left it out (a repair), and keeps difficulty a warning', () => {
    const f = fixture();
    const other = f.domain.techniques.find((t) => t.id !== f.seed.technique)!;
    const g = gate(f, (o) => {
      o.techniques = [{ id: other.id, name: other.name }];
      o.difficulty = 'advanced';
    });
    expect(g.repairs).toContain(`assigned technique ${f.seed.technique} added`);
    expect(g.errors).toEqual([]);
    expect(g.warnings.join(' ')).toMatch(/difficulty: the writer wrote advanced/);
  });
});

describe('architecture library questions: naming a component', () => {
  it('accepts singular or plural forms of a fixed label and whole-word acronyms, and still rejects a label that is not named', () => {
    expect(mentionsLabel('one staff laptop was compromised', 'staff laptops')).toBe(true);
    expect(mentionsLabel('the export bucket was read', 'customer export buckets')).toBe(false); // "customer" is missing
    expect(mentionsLabel('a customer export bucket was read', 'customer export buckets')).toBe(true);
    expect(mentionsLabel('the access policy allowed it', 'access policies')).toBe(true);
    expect(mentionsLabel('the cache was poisoned', 'session caches')).toBe(false);
    expect(mentionsLabel('the session cache was poisoned', 'session caches')).toBe(true);
    expect(mentionsLabel('orders were pulled from the ERP', 'cloud ERP')).toBe(true);
    expect(mentionsLabel('the WAF logged nothing', 'CDN with WAF')).toBe(true);
    expect(mentionsLabel('a werp happened', 'cloud ERP')).toBe(false); // whole words only
    expect(mentionsLabel('sign-in went through SSO', 'SSO')).toBe(true);
    expect(mentionsLabel('nothing relevant here', 'line PLCs')).toBe(false);
    expect(mentionsLabel('a line PLC stopped', 'line PLCs')).toBe(true);
  });
});

describe('architecture library questions: architecture-aware similarity', () => {
  const textOf = (f: Fixture) => {
    const g = gate(f);
    const item = toLibraryItem(g.out, f.arch, f.domain, f.seed, DEFAULT_WEIGHTS, g.overlay);
    return { item, text: comparableText(item.public), key: item.seed.architecture!.pathKey! };
  };

  it('two different questions on one architecture are not similar once its shared wording is set aside; the same text, path or fingerprint is caught', () => {
    const domain = getDomain('cloud_security')!;
    const arch = architecturesFor(domain.key, 'beginner').find((a) => surfacesFor(a, domain.key).length >= 2)!;
    const archIndex = architecturesFor(domain.key, 'beginner').indexOf(arch);
    const a = textOf(fixture('cloud_security', 'beginner', 0, 'break_the_path', archIndex));
    const b = textOf(fixture('cloud_security', 'beginner', 1, 'detect_first', archIndex));
    const sh = architectureShingles(arch);
    // The plain comparison is dominated by the organisation summary both scenarios start with...
    expect(jaccard(shingles(a.text), shingles(b.text))).toBeGreaterThan(0);
    const bank = (fingerprints: string[] = []) => ({ fingerprints: new Set(fingerprints), entries: [{ id: 'a', archId: arch.id, fingerprint: a.item.fingerprint, pathKey: a.key, objective: 'break_the_path', text: a.text }] });
    const diff = checkLibrarySimilarity({ fingerprint: b.item.fingerprint, archId: arch.id, pathKey: b.key, objective: 'detect_first', text: b.text }, bank(), 0.35, sh);
    expect(diff.tooSimilar, `similarity ${diff.max}`).toBe(false);
    const same = checkLibrarySimilarity({ fingerprint: 'other', archId: arch.id, pathKey: 'other', objective: 'other', text: a.text }, bank(), 0.35, sh);
    expect(same).toMatchObject({ tooSimilar: true, max: 1, nearest: 'a' });
    const path = checkLibrarySimilarity({ fingerprint: 'other', archId: arch.id, pathKey: a.key, objective: 'break_the_path', text: 'completely different words about another matter entirely' }, bank(), 0.35, sh);
    expect(path).toMatchObject({ tooSimilar: true, structureCollision: true, fingerprintCollision: false });
    // The same path for a different objective is a different question.
    expect(checkLibrarySimilarity({ fingerprint: 'other', archId: arch.id, pathKey: a.key, objective: 'contain_now', text: 'completely different words about another matter entirely' }, bank(), 0.35, sh).tooSimilar).toBe(false);
    const fp = checkLibrarySimilarity({ fingerprint: b.item.fingerprint, archId: arch.id, pathKey: 'x', objective: 'y', text: 'completely different words' }, bank([b.item.fingerprint]), 0.35, sh);
    expect(fp).toMatchObject({ tooSimilar: true, fingerprintCollision: true });
    // Two scenarios that share only the architecture's text are not similar.
    const summaryOnly = { scenario: arch.organisation.summary, attackNarrative: '', question: '', options: [] };
    const near = checkLibrarySimilarity({ fingerprint: 'x', archId: arch.id, pathKey: 'p1', objective: 'o1', text: comparableText(summaryOnly) }, { fingerprints: new Set(), entries: [{ id: 'z', archId: arch.id, fingerprint: 'y', pathKey: 'p2', objective: 'o2', text: comparableText(summaryOnly) }] }, 0.35, sh);
    expect(near.tooSimilar).toBe(false);
    // Review AR-BIZ-2: a retired question (structural: false) is no obstacle to its path and objective; text similarity still applies to it.
    const retired = { fingerprints: new Set<string>(), entries: [{ id: 'a', archId: arch.id, fingerprint: a.item.fingerprint, pathKey: a.key, objective: 'break_the_path', structural: false, text: a.text }] };
    expect(checkLibrarySimilarity({ fingerprint: 'other', archId: arch.id, pathKey: a.key, objective: 'break_the_path', text: 'completely different words about another matter entirely' }, retired, 0.35, sh)).toMatchObject({ tooSimilar: false, structureCollision: false });
    expect(checkLibrarySimilarity({ fingerprint: 'other', archId: arch.id, pathKey: 'p', objective: 'o', text: a.text }, retired, 0.35, sh).tooSimilar).toBe(true);
  });

  it('the seed picker passes over the architecture, surface and objective of live questions while another combination remains (review AR-BIZ-2)', () => {
    const domain = getDomain('cloud_security')!;
    const archs = architecturesFor(domain.key, 'beginner');
    const free = pickLibrarySeed(domain, 'beginner', archs, [], () => 0);
    const avoided = pickLibrarySeed(domain, 'beginner', archs, [], () => 0, new Set(), new Set([structureKeyOf(free)]));
    expect(structureKeyOf(avoided)).not.toBe(structureKeyOf(free));
    // Every combination avoided: it still returns a seed (the similarity check decides).
    const all = new Set<string>();
    for (const arch of archs) for (const surface of surfacesFor(arch, domain.key)) for (const o of domain.variation.objectives) all.add(structureKeyOf({ domain: domain.key, topology: arch.id, entryPoint: surface.id, objective: o.id }));
    expect(pickLibrarySeed(domain, 'beginner', archs, [], () => 0, new Set(), all)).toBeTruthy();
  });

  it('a live question of another domain whose surface crosses the same nodes, with the same objective, is a structure the picker passes over (review H55-COST-5)', () => {
    // The real H55 pair: cloud_security's leaked-deploy-key and incident_response's exports-download on b1 both
    // run deploy-key > exports-bucket, and both stored questions had one pathKey. By surface id the picker could
    // not see it, and the similarity check rejected the paid try as a structure collision.
    const live = { domain: 'cloud_security', topology: 'b1-online-shop', entryPoint: 'leaked-deploy-key', objective: 'contain_now' } as const;
    const next = { domain: 'incident_response', topology: 'b1-online-shop', entryPoint: 'exports-download', objective: 'contain_now' } as const;
    expect(structureKeyOf(next)).toBe(structureKeyOf(live));
    expect(structureKeyOf({ ...next, objective: 'preserve_first' })).not.toBe(structureKeyOf(live));
    expect(structureKeyOf({ ...next, entryPoint: 'shop-web-shell' })).not.toBe(structureKeyOf(live));
    // A surface the library no longer has keeps its id.
    expect(structureKeyOf({ ...live, entryPoint: 'retired-surface' })).toBe('b1-online-shop|retired-surface|contain_now');
    const ir = getDomain('incident_response')!;
    const b1 = [getArchitecture('b1-online-shop')!];
    expect(pickLibrarySeed(ir, 'beginner', b1, [], () => 0)).toMatchObject({ entryPoint: 'exports-download', objective: 'contain_now' });
    const avoided = pickLibrarySeed(ir, 'beginner', b1, [], () => 0, new Set(), new Set([structureKeyOf(live)]));
    expect(structureKeyOf(avoided)).not.toBe(structureKeyOf(live));
  });
});

describe('architecture library questions: the fake writer', () => {
  it('writes different text for different variations, from the request alone', () => {
    const a = fixture('cloud_security', 'beginner', 0, 'break_the_path');
    const b = fixture('cloud_security', 'beginner', 0, 'contain_now');
    expect(a.out.situation).not.toBe(b.out.situation);
    expect(a.out.question).not.toBe(b.out.question);
  });
});
