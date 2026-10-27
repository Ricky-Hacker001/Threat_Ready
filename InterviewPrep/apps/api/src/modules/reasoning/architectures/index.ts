import type { ReasoningDifficulty, ReasoningDomainKey } from '@threatready/contracts';
import { libraryErrors as checkLibrary } from './checks.js';
import { parseArchitecture } from './schema.js';
import { levelOf, type ArchitectureDef, type ArchitectureLevel, type AttackSurface } from './types.js';
import b1 from './b1-online-shop.json' with { type: 'json' };
import b2 from './b2-accounting-office.json' with { type: 'json' };
import b3 from './b3-mobile-backend.json' with { type: 'json' };
import b4 from './b4-support-chatbot.json' with { type: 'json' };
import b5 from './b5-game-studio.json' with { type: 'json' };
import i1 from './i1-fintech-payments.json' with { type: 'json' };
import i2 from './i2-regional-hospital.json' with { type: 'json' };
import i3 from './i3-b2b-saas.json' with { type: 'json' };
import i4 from './i4-insurer-rag.json' with { type: 'json' };
import i5 from './i5-dev-platform.json' with { type: 'json' };
import a1 from './a1-hybrid-bank.json' with { type: 'json' };
import a2 from './a2-saas-at-scale.json' with { type: 'json' };
import a3 from './a3-manufacturer-ot.json' with { type: 'json' };
import a4 from './a4-ai-company.json' with { type: 'json' };
import a5 from './a5-health-exchange.json' with { type: 'json' };

export * from './types.js';
export { architectureText, architectureShingles } from './text.js';
export { adjacency, composeDiagram, normaliseOverlay, pathKey, pathNodeIds, sampleOverlay, shortestRoute, validateOverlay } from './compose.js';
export { architectureErrors, coverageMatrix } from './checks.js';
export { ArchitectureSchema, parseArchitecture } from './schema.js';

/**
 * The architecture library (docs/ATTACK_REASONING_COST_DESIGN.md §2). Bump LIBRARY_VERSION with any
 * change to a file (and that file's own `version`); items record the architecture version they were
 * written on, and their diagram is copied at generation, so an edit never changes an existing question.
 */
export const LIBRARY_VERSION = 'arch-lib.v1.2026-10-26';

const FILES: [string, unknown][] = [
  ['b1-online-shop.json', b1],
  ['b2-accounting-office.json', b2],
  ['b3-mobile-backend.json', b3],
  ['b4-support-chatbot.json', b4],
  ['b5-game-studio.json', b5],
  ['i1-fintech-payments.json', i1],
  ['i2-regional-hospital.json', i2],
  ['i3-b2b-saas.json', i3],
  ['i4-insurer-rag.json', i4],
  ['i5-dev-platform.json', i5],
  ['a1-hybrid-bank.json', a1],
  ['a2-saas-at-scale.json', a2],
  ['a3-manufacturer-ot.json', a3],
  ['a4-ai-company.json', a4],
  ['a5-health-exchange.json', a5],
];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function load(): readonly ArchitectureDef[] {
  const defs = FILES.map(([file, raw]) => {
    const def = parseArchitecture(raw, file);
    if (`${def.id}.json` !== file) throw new Error(`architecture ${file}: the id "${def.id}" must match the file name`);
    return def;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const errors = libraryErrors(defs);
  if (errors.length) throw new Error(`architecture library ${LIBRARY_VERSION} is invalid:\n- ${errors.join('\n- ')}`);
  return deepFreeze(defs);
}

/** Cross-file, per-file and domain-registry checks over the given definitions (the loaded library by default); [] when valid. */
export function libraryErrors(defs: readonly ArchitectureDef[] = ARCHITECTURES): string[] {
  return checkLibrary(defs);
}

/** All 15 architectures, sorted by id, parsed and checked at module load. */
export const ARCHITECTURES: readonly ArchitectureDef[] = load();
const byId = new Map(ARCHITECTURES.map((a) => [a.id, a]));

export const getArchitecture = (id: string): ArchitectureDef | undefined => byId.get(id);

/** The architectures of a level with attack surfaces for a domain (at least 3 by the coverage rule); 'expert' reads advanced. */
export function architecturesFor(domain: ReasoningDomainKey, level: ArchitectureLevel | ReasoningDifficulty): ArchitectureDef[] {
  const l = levelOf(level);
  return ARCHITECTURES.filter((a) => a.level === l && (a.attackSurfaces[domain]?.length ?? 0) > 0);
}

export function surfacesFor(arch: ArchitectureDef, domain: ReasoningDomainKey): AttackSurface[] {
  return [...(arch.attackSurfaces[domain] ?? [])];
}
