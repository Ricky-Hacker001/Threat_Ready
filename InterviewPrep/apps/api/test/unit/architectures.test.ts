import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiagramData, ReasoningDomainKey } from '@threatready/contracts';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_LEVELS,
  ARCHITECTURES,
  ATTACK_STEPS,
  LIBRARY_VERSION,
  NODE_BOUNDS,
  architectureErrors,
  architectureShingles,
  architectureText,
  architecturesFor,
  composeDiagram,
  coverageMatrix,
  getArchitecture,
  libraryErrors,
  normaliseOverlay,
  parseArchitecture,
  pathKey,
  sampleOverlay,
  surfacesFor,
  validateOverlay,
  type ArchitectureDef,
  type AttackOverlay,
} from '../../src/modules/reasoning/architectures/index.js';
import { architectureJsonSchemaText } from '../../src/modules/reasoning/architectures/schema.js';
import { getDomain } from '../../src/modules/reasoning/domains/index.js';
import { shingles } from '../../src/modules/reasoning/similarity.js';
import { validateDiagram } from '../../src/modules/reasoning/validation.js';

/* The architecture library (docs/ATTACK_REASONING_COST_DESIGN.md §2, §11.1): 15 reviewed files, 5 per level,
 * that every generated question is written on. These tests are the contract for adding or editing a file. */

const DIR = fileURLToPath(new URL('../../src/modules/reasoning/architectures/', import.meta.url));
const FILES = readdirSync(DIR).filter((f) => /^[bia][1-5]-.*\.json$/.test(f)).sort();
const DOMAINS = ReasoningDomainKey.options;

const clone = (id: string): ArchitectureDef => structuredClone(getArchitecture(id)!) as ArchitectureDef;
const surfaces = (a: ArchitectureDef) => Object.entries(a.attackSurfaces).flatMap(([domain, list]) => list!.map((s) => ({ domain, s })));
/** The composed diagram in the generator's shape, for the existing diagram validator. */
const asGenerator = (d: DiagramData) => ({ boundaries: d.boundaries, nodes: d.nodes.map(({ entryPoint, ...n }) => ({ ...n, entry_point: entryPoint })), edges: d.edges, attack_path: d.attackPath });

describe('architecture library: files', () => {
  it('has 15 architectures, 5 per level, every file in the directory loaded, ids matching file names', () => {
    expect(FILES).toHaveLength(15);
    expect(ARCHITECTURES.map((a) => `${a.id}.json`)).toEqual(FILES);
    for (const level of ARCHITECTURE_LEVELS) expect(ARCHITECTURES.filter((a) => a.level === level)).toHaveLength(5);
    expect(new Set(ARCHITECTURES.map((a) => a.title)).size).toBe(15);
    expect(new Set(ARCHITECTURES.map((a) => a.organisation.name)).size).toBe(15);
    expect(LIBRARY_VERSION).toMatch(/^arch-lib\.v\d+\.\d{4}-\d{2}-\d{2}$/);
  });

  it('every file parses through the zod schema as it is on disk', () => {
    for (const f of FILES) {
      const a = parseArchitecture(JSON.parse(readFileSync(`${DIR}${f}`, 'utf8')), f);
      expect(a.$schema).toBe('./architecture.schema.json');
      expect(a.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('the loaded library is valid and frozen', () => {
    expect(libraryErrors()).toEqual([]);
    for (const a of ARCHITECTURES) expect(architectureErrors(a), a.id).toEqual([]);
    expect(Object.isFrozen(ARCHITECTURES)).toBe(true);
    expect(Object.isFrozen(ARCHITECTURES[0]!.diagram.nodes[0])).toBe(true);
  });

  it('architecture.schema.json is in sync with the zod schema (run scripts/architecture-schema.ts)', () => {
    expect(readFileSync(`${DIR}architecture.schema.json`, 'utf8')).toBe(architectureJsonSchemaText());
  });

  it('the schema rejects unknown keys, attack edges, attacker nodes and reserved edge ids, naming the file and path', () => {
    const raw = () => JSON.parse(readFileSync(`${DIR}${FILES[0]}`, 'utf8'));
    const extra = raw();
    extra.diagram.nodes[0].colour = 'red';
    expect(() => parseArchitecture(extra, 'x.json')).toThrow(/x\.json: diagram\.nodes\.0/);
    const attackEdge = raw();
    attackEdge.diagram.edges[0].kind = 'attack';
    expect(() => parseArchitecture(attackEdge, 'x.json')).toThrow(/diagram\.edges\.0\.kind/);
    const attackerNode = raw();
    attackerNode.diagram.nodes[0].type = 'attacker';
    expect(() => parseArchitecture(attackerNode, 'x.json')).toThrow(/diagram\.nodes\.0\.type/);
    const atk = raw();
    atk.diagram.edges[0].id = 'atk1';
    expect(() => parseArchitecture(atk, 'x.json')).toThrow(/reserved for attack steps/);
    const summary = raw();
    summary.organisation.summary = 'Too short.';
    expect(() => parseArchitecture(summary, 'x.json')).toThrow(/organisation\.summary/);
  });
});

describe('architecture library: per-level sizes and content', () => {
  for (const a of ARCHITECTURES) {
    it(`${a.id}: sizes, flows, required content`, () => {
      const b = NODE_BOUNDS[a.level];
      expect(a.diagram.nodes.length).toBeGreaterThanOrEqual(b.nodes[0]);
      expect(a.diagram.nodes.length).toBeLessThanOrEqual(b.nodes[1]);
      expect(a.diagram.boundaries.length).toBeGreaterThanOrEqual(b.boundaries[0]);
      expect(a.diagram.boundaries.length).toBeLessThanOrEqual(b.boundaries[1]);
      expect(architectureText(a).length).toBeLessThanOrEqual(b.textChars);
      expect(a.diagram.nodes.some((n) => (n.type as string) === 'attacker')).toBe(false);
      expect(a.diagram.edges.some((e) => (e.kind as string) === 'attack' || e.id.startsWith('atk'))).toBe(false);
      expect(a.dataStores.some((d) => d.classification === 'regulated' || d.classification === 'confidential')).toBe(true);
      expect(a.logSources.length).toBeGreaterThan(0);
      expect(a.controls.some((c) => c.status === 'missing')).toBe(true);
      if (a.level === 'advanced') {
        expect(a.trustRelationships.some((t) => t.subtle)).toBe(true);
        expect(a.controls.some((c) => c.status !== 'missing' && c.limits)).toBe(true);
      }
      // Every node label fits the client's node box and every flow label its label box.
      for (const n of a.diagram.nodes) expect(n.label.length, n.id).toBeLessThanOrEqual(60);
      for (const e of a.diagram.edges) expect(e.label.length, e.id).toBeLessThanOrEqual(70);
    });
  }
});

describe('architecture library: coverage', () => {
  it('per level, every domain has surfaces in at least 3 architectures with at least 2 surfaces each', () => {
    const matrix = coverageMatrix(ARCHITECTURES);
    const report = Object.entries(matrix).map(([k, v]) => `${k}: B ${v.beginner.join(' ')} | I ${v.intermediate.join(' ')} | A ${v.advanced.join(' ')}`).join('\n');
    for (const domain of DOMAINS) {
      for (const level of ARCHITECTURE_LEVELS) {
        const archs = architecturesFor(domain, level);
        expect(archs.length, `${domain}/${level}\n${report}`).toBeGreaterThanOrEqual(3);
        for (const a of archs) expect(surfacesFor(a, domain).length, `${a.id}/${domain}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('surface techniques come from the domain\'s list (ATLAS for AI) and objectives from its objective ids', () => {
    for (const a of ARCHITECTURES) {
      for (const { domain, s } of surfaces(a)) {
        const d = getDomain(domain)!;
        const techniques = new Set(d.techniques.map((t) => t.id));
        for (const t of s.techniques) expect(techniques.has(t), `${a.id}/${s.id}: ${t}`).toBe(true);
        if (domain === 'ai_llm_security') for (const t of s.techniques) expect(t).toMatch(/^AML\.T\d{4}/);
        const objectives = new Set(d.variation.objectives.map((o) => o.id));
        for (const o of s.objectives ?? []) expect(objectives.has(o), `${a.id}/${s.id}: ${o}`).toBe(true);
      }
    }
  });

  it('lookups: getArchitecture, architecturesFor (expert reads advanced), surfacesFor', () => {
    expect(getArchitecture('b1-online-shop')?.level).toBe('beginner');
    expect(getArchitecture('nope')).toBeUndefined();
    expect(architecturesFor('cloud_security', 'expert').map((a) => a.id)).toEqual(architecturesFor('cloud_security', 'advanced').map((a) => a.id));
    for (const a of architecturesFor('ai_llm_security', 'beginner')) expect(a.level).toBe('beginner');
    const arch = getArchitecture('b1-online-shop')!;
    expect(surfacesFor(arch, 'zero_trust')).toEqual([]);
    expect(surfacesFor(arch, 'cloud_security').map((s) => s.id)).toContain('leaked-deploy-key');
  });
});

describe('architecture library: every surface composes into a valid question diagram', () => {
  for (const a of ARCHITECTURES) {
    it(`${a.id}: sample attack paths normalise, validate and compose`, () => {
      for (const { domain, s } of surfaces(a)) {
        for (const variant of [0, 1, 2]) {
          const raw = sampleOverlay(a, s, a.level, { variant });
          expect(raw, `${a.id}/${domain}/${s.id}: no path within ${ATTACK_STEPS[a.level].min}-${ATTACK_STEPS[a.level].max} steps`).not.toBeNull();
          const { overlay } = normaliseOverlay(a, raw!);
          const v = validateOverlay(a, overlay, { level: a.level, surface: s });
          expect(v.errors, `${a.id}/${s.id}#${variant}`).toEqual([]);
          const d = composeDiagram(a, overlay);
          expect(DiagramData.safeParse(d).success).toBe(true);
          expect(validateDiagram(asGenerator(d)), `${a.id}/${s.id}#${variant}`).toEqual([]);
          expect(d.nodes.length).toBeLessThanOrEqual(18);
        }
      }
    });
  }
});

describe('composeDiagram, validateOverlay, normaliseOverlay, pathKey', () => {
  const b1 = getArchitecture('b1-online-shop')!;
  const fromOutside: AttackOverlay = {
    entryNode: 'deploy-key',
    compromisedNodes: ['deploy-key'],
    steps: [
      { from: 'attacker', to: 'deploy-key', label: 'uses the leaked key from a public repository' },
      { from: 'deploy-key', to: 'exports-bucket', label: 'downloads every order export' },
    ],
  };
  const fromInside: AttackOverlay = { entryNode: 'shop-app', compromisedNodes: ['shop-app'], steps: [{ from: 'shop-app', to: 'orders-api', label: 'replays a staff session' }] };

  it('adds the attacker origin only when the path starts there, sets the flags and appends atk edges in order', () => {
    const d = composeDiagram(b1, fromOutside);
    expect(d.nodes[0]).toMatchObject({ id: 'attacker', type: 'attacker', compromised: false, entryPoint: false, boundary: 'internet' });
    expect(d.nodes.find((n) => n.id === 'deploy-key')).toMatchObject({ entryPoint: true, compromised: true });
    expect(d.nodes.find((n) => n.id === 'exports-bucket')).toMatchObject({ entryPoint: false, compromised: false });
    expect(d.nodes.filter((n) => n.entryPoint)).toHaveLength(1);
    expect(d.edges.slice(0, b1.diagram.edges.length)).toEqual(b1.diagram.edges);
    expect(d.edges.slice(b1.diagram.edges.length)).toEqual([
      { id: 'atk1', from: 'attacker', to: 'deploy-key', label: 'uses the leaked key from a public repository', kind: 'attack' },
      { id: 'atk2', from: 'deploy-key', to: 'exports-bucket', label: 'downloads every order export', kind: 'attack' },
    ]);
    expect(d.attackPath).toEqual(['atk1', 'atk2']);
    const inside = composeDiagram(b1, fromInside);
    expect(inside.nodes.some((n) => n.type === 'attacker')).toBe(false);
    expect(inside.nodes).toHaveLength(b1.diagram.nodes.length);
    // The library objects are never mutated by composition.
    expect(getArchitecture('b1-online-shop')!.diagram.nodes.some((n) => 'compromised' in n)).toBe(false);
  });

  it('drops boundaries that hold no drawn component (an origin-only boundary appears only with its origin)', () => {
    const a = clone('a3-manufacturer-ot');
    expect(a.diagram.nodes.some((n) => n.boundary === 'internet')).toBe(false);
    const withoutOrigin = composeDiagram(a, { entryNode: 'office-pcs', compromisedNodes: [], steps: [{ from: 'office-pcs', to: 'jump-host', label: 'RDP with stolen credentials' }] });
    expect(withoutOrigin.boundaries.map((b) => b.id)).not.toContain('internet');
    const withOrigin = composeDiagram(a, { entryNode: 'office-pcs', compromisedNodes: [], steps: [{ from: 'attacker', to: 'office-pcs', label: 'phishing attachment opened' }] });
    expect(withOrigin.boundaries.map((b) => b.id)).toContain('internet');
  });

  it('validateOverlay accepts a grounded path and rejects every broken one', () => {
    const surface = surfacesFor(b1, 'cloud_security')[0]!;
    expect(validateOverlay(b1, fromOutside, { level: 'beginner', surface })).toEqual({ errors: [], warnings: [] });
    const err = (o: AttackOverlay, level: 'beginner' | 'intermediate' | 'advanced' = 'beginner', s = surface) => validateOverlay(b1, o, { level, surface: s }).errors.join(' | ');
    expect(err({ ...fromOutside, steps: [{ from: 'attacker', to: 'mainframe', label: 'x' }] })).toMatch(/unknown component "mainframe"/);
    expect(err({ ...fromOutside, steps: [fromOutside.steps[0]!, { from: 'shop-app', to: 'exports-bucket', label: 'x' }] })).toMatch(/must chain/);
    expect(err(fromOutside, 'advanced')).toMatch(/advanced questions use 3-5 attack steps \(got 2\)/);
    expect(err({ ...fromOutside, steps: [...fromOutside.steps, { from: 'exports-bucket', to: 'orders-api', label: 'x' }] })).toMatch(/beginner questions use 1-2/);
    expect(err({ ...fromOutside, compromisedNodes: ['orders-db'] })).toMatch(/"orders-db" is not on the attack path/);
    expect(err({ ...fromOutside, entryNode: 'exports-bucket' })).toMatch(/entry node must be the first component/);
    expect(err({ entryNode: 'shop-app', compromisedNodes: [], steps: [{ from: 'shop-app', to: 'shop-app', label: 'x' }] })).toMatch(/loops/);
    expect(err({ entryNode: 'deploy-key', compromisedNodes: [], steps: [{ from: 'deploy-key', to: 'shop-app', label: 'x' }, { from: 'shop-app', to: 'attacker', label: 'x' }] })).toMatch(/ends at unknown component "attacker"/);
    expect(err(fromInside, 'beginner', surfacesFor(b1, 'data_security')[0]!)).toMatch(/must use the surface "exports-exposure"/);
    expect(err({ ...fromOutside, steps: [fromOutside.steps[0]!, { ...fromOutside.steps[1]!, label: 'x'.repeat(71) }] })).toMatch(/longer than 70/);
  });

  it('a step with no drawn flow or trust relationship is a warning, not an error', () => {
    const v = validateOverlay(b1, { entryNode: 'shop-app', compromisedNodes: ['shop-app'], steps: [{ from: 'shop-app', to: 'orders-db', label: 'reads the database with app credentials' }] }, { level: 'beginner' });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/follows no drawn flow/);
  });

  it('normaliseOverlay reorders a shuffled chain, infers a missing entry node and drops duplicate compromised ids', () => {
    const shuffled: AttackOverlay = { entryNode: '', compromisedNodes: ['deploy-key', 'deploy-key'], steps: [fromOutside.steps[1]!, fromOutside.steps[0]!] };
    const { overlay, repairs } = normaliseOverlay(b1, shuffled);
    expect(overlay.steps).toEqual(fromOutside.steps);
    expect(overlay.entryNode).toBe('deploy-key');
    expect(overlay.compromisedNodes).toEqual(['deploy-key']);
    expect(repairs).toHaveLength(3);
    expect(validateOverlay(b1, overlay, { level: 'beginner' }).errors).toEqual([]);
    // Two separate chains are left alone for the validator to reject.
    const broken = { entryNode: 'deploy-key', compromisedNodes: [], steps: [{ from: 'ci', to: 'deploy-key', label: 'a' }, { from: 'shop-app', to: 'orders-api', label: 'b' }] };
    expect(normaliseOverlay(b1, broken).overlay.steps).toEqual(broken.steps);
  });

  it('pathKey is the architecture and the node path, stable across calls and label changes', () => {
    expect(pathKey(b1, fromOutside)).toBe('b1-online-shop:attacker>deploy-key>exports-bucket');
    expect(pathKey(b1, { ...fromOutside, steps: fromOutside.steps.map((s) => ({ ...s, label: 'other words' })) })).toBe(pathKey(b1, fromOutside));
    expect(pathKey(b1, fromInside)).toBe('b1-online-shop:shop-app>orders-api');
  });
});

describe('architectureText and architectureShingles', () => {
  it('is byte-identical across calls and copies, and never contains surfaces or review notes', () => {
    for (const a of ARCHITECTURES) {
      const text = architectureText(a);
      expect(architectureText(a)).toBe(text);
      expect(architectureText(clone(a.id))).toBe(text);
      expect(text).toContain(a.organisation.summary);
      for (const n of a.diagram.nodes) expect(text).toContain(`- ${n.id}: ${n.label} [${n.type}]`);
      for (const { s } of surfaces(a)) {
        expect(text.includes(s.summary), `${a.id}: surface "${s.id}" leaked into the prompt prefix`).toBe(false);
      }
      if (a.reviewNotes) expect(text.includes(a.reviewNotes)).toBe(false);
      expect(text).not.toMatch(/attackSurfaces|reviewNotes/);
    }
  });

  it('shingles are the word 3-grams of the text, so two questions on one architecture compare on what differs', () => {
    const a = getArchitecture('i3-b2b-saas')!;
    expect(architectureShingles(a)).toEqual(shingles(architectureText(a)));
    const shared = [...shingles(a.organisation.summary)];
    expect(shared.length).toBeGreaterThan(20);
    expect(shared.every((x) => architectureShingles(a).has(x))).toBe(true);
  });
});

describe('architectureErrors and libraryErrors catch broken files', () => {
  const errs = (mutate: (a: ArchitectureDef) => void, id = 'i1-fintech-payments') => {
    const a = clone(id);
    mutate(a);
    return architectureErrors(a).join(' | ');
  };

  it('diagram references, sizes and connectivity', () => {
    expect(errs((a) => (a.diagram.edges[0]!.to = 'ghost'))).toMatch(/ends at unknown component "ghost"/);
    expect(errs((a) => (a.diagram.nodes[0]!.boundary = 'ghost'))).toMatch(/unknown boundary "ghost"/);
    expect(errs((a) => a.diagram.nodes.push({ ...a.diagram.nodes[0]! }))).toMatch(/duplicate component or origin id/);
    expect(errs((a) => a.diagram.edges.push({ ...a.diagram.edges[0]!, id: 'e99' }))).toMatch(/two flows join/);
    expect(errs((a) => (a.diagram.nodes = a.diagram.nodes.slice(0, 5)))).toMatch(/9-13 components/);
    expect(errs((a) => a.diagram.boundaries.push({ id: 'spare', label: 'Spare', kind: 'private' }))).toMatch(/boundary "spare" holds no component/);
    expect(errs((a) => (a.diagram.edges = a.diagram.edges.filter((e) => e.from !== 'sso' && e.to !== 'sso')))).toMatch(/not connected to the rest by any flow: sso/);
    expect(errs((a) => (a.organisation.summary = a.organisation.summary.repeat(4)), 'b1-online-shop')).toMatch(/architectureText is \d+ characters/);
    expect(errs((a) => (a.level = 'beginner'))).toMatch(/starts with "b"/);
  });

  it('controls, trust, identities, logs and required content', () => {
    expect(errs((a) => (a.controls.find((c) => c.status === 'missing')!.label = 'mTLS'))).toMatch(/missing control "netpol" is drawn on gateway/);
    expect(errs((a) => (a.diagram.nodes.find((n) => n.id === 'gateway')!.controls = ['rate limits']))).toMatch(/present control "mtls" \("mTLS"\) is not drawn/);
    expect(errs((a) => (a.controls = a.controls.filter((c) => c.status !== 'missing')))).toMatch(/at least one missing control/);
    expect(errs((a) => (a.dataStores = a.dataStores.map((d) => ({ ...d, classification: 'internal' }))))).toMatch(/regulated or confidential/);
    expect(errs((a) => (a.trustRelationships[0]!.to = 'ghost'))).toMatch(/trust relationship "ci-oidc" names unknown component "ghost"/);
    expect(errs((a) => (a.identities[0]!.nodeIds = ['ghost']))).toMatch(/identity "merchant-certs" names unknown component/);
    expect(errs((a) => (a.logSources[0]!.nodeIds = ['ghost']))).toMatch(/log source "gateway-logs" names unknown component/);
    expect(errs((a) => (a.trustRelationships = a.trustRelationships.map((t) => ({ ...t, subtle: false }))), 'a1-hybrid-bank')).toMatch(/subtle trust relationship/);
    expect(errs((a) => (a.controls = a.controls.map((c) => ({ ...c, limits: null }))), 'a1-hybrid-bank')).toMatch(/limits make it not apply/);
  });

  it('surfaces: references, the domain\'s techniques and objectives, a drawable path, one obvious beginner entry', () => {
    expect(errs((a) => (a.attackSurfaces.cloud_security![0]!.techniques = ['T9999']))).toMatch(/technique T9999 is not in the cloud_security technique list/);
    expect(errs((a) => (a.attackSurfaces.ai_llm_security![0]!.techniques = ['T1078']))).toMatch(/"T1078" is not an ATLAS technique id/);
    expect(errs((a) => (a.attackSurfaces.cloud_security![0]!.objectives = ['break_the_path', 'contain_now', 'guess']))).toMatch(/objective "guess" is not a cloud_security objective/);
    expect(errs((a) => (a.attackSurfaces.cloud_security![0]!.targetNodeIds = ['ghost']))).toMatch(/unknown component "ghost"/);
    expect(errs((a) => (a.attackSurfaces.cloud_security = a.attackSurfaces.cloud_security!.slice(0, 1)))).toMatch(/at least 2 surfaces/);
    expect(errs((a) => (a.attackSurfaces.cloud_security![0]!.entryNodeIds = ['ci', 'deploy-key']), 'b1-online-shop')).toMatch(/one obvious entry/);
    expect(errs((a) => {
      const s = a.attackSurfaces.cloud_security![0]!;
      s.entryNodeIds = ['ci'];
      s.targetNodeIds = ['orders-db'];
      s.viaNodeIds = [];
    }, 'b1-online-shop')).toMatch(/no attack path from an entry to a target fits the beginner step range/);
    expect(errs((a) => {
      a.controls = a.controls.filter((c) => !c.nodeIds.includes('settlement') && !c.nodeIds.includes('card-vault'));
      a.diagram.nodes.forEach((n) => { if (['settlement', 'card-vault'].includes(n.id)) n.controls = []; });
      a.attackSurfaces.cloud_security![1]!.entryNodeIds = ['settlement'];
      a.attackSurfaces.cloud_security![1]!.targetNodeIds = ['card-vault'];
    })).toMatch(/no control on the surface's components/);
  });

  it('library rules: 5 per level, unique ids and titles, coverage per domain and level', () => {
    const lib = ARCHITECTURES.map((a) => structuredClone(a) as ArchitectureDef);
    expect(libraryErrors(lib)).toEqual([]);
    expect(libraryErrors(lib.slice(1)).join(' | ')).toMatch(/5 advanced architectures expected \(got 4\)/);
    const dupTitle = lib.map((a, i) => (i === 1 ? { ...a, title: lib[0]!.title } : a));
    expect(libraryErrors(dupTitle).join(' | ')).toMatch(/duplicate title/);
    const noAi = lib.map((a) => (a.level === 'beginner' ? { ...a, attackSurfaces: { ...a.attackSurfaces, ai_llm_security: undefined } } : a));
    expect(libraryErrors(noAi).join(' | ')).toMatch(/coverage ai_llm_security\/beginner: 0 architectures/);
  });
});
