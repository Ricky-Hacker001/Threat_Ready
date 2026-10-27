import type { ReasoningDifficulty } from '@threatready/contracts';
import { surfacesFor, type ArchitectureDef, type AttackSurface } from './architectures/index.js';
import { fingerprintOf, type ReasoningDomain, type VariationSeed } from './domain.types.js';

export type Rng = () => number;

/**
 * Picks the next variation for a learner: the combination whose parts they have seen least.
 * Topology, entry point and objective are each scored by how recently the learner met them; the
 * least-seen combination wins, with the technique and constraint drawn from the remaining pool.
 * Exact fingerprints already seen are excluded while any other combination remains.
 */
export function pickSeed(domain: ReasoningDomain, recent: VariationSeed[], rng: Rng = Math.random, exclude: Set<string> = new Set(), difficulty: ReasoningDifficulty = domain.difficulty): VariationSeed {
  const seen = (pick: (s: VariationSeed) => string) => {
    const m = new Map<string, number>();
    recent.forEach((s, i) => m.set(pick(s), (m.get(pick(s)) ?? 0) + (recent.length - i)));
    return m;
  };
  const topoSeen = seen((s) => s.topology);
  const entrySeen = seen((s) => s.entryPoint);
  const objSeen = seen((s) => s.objective);
  const techSeen = seen((s) => s.technique);
  const consSeen = seen((s) => s.constraint);
  const seenFingerprints = new Set([...recent.map(fingerprintOf), ...exclude]);
  const v = domain.variation;

  const leastSeen = <T extends { id: string }>(list: T[], seenMap: Map<string, number>): T[] => {
    const min = Math.min(...list.map((x) => seenMap.get(x.id) ?? 0));
    return list.filter((x) => (seenMap.get(x.id) ?? 0) === min);
  };
  const choose = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;

  // Up to 64 draws from the least-seen pools; fall back to any unseen combination, then to any.
  for (let i = 0; i < 64; i++) {
    const seed: VariationSeed = {
      domain: domain.key,
      difficulty,
      topology: choose(leastSeen(v.topologies, topoSeen)).id,
      entryPoint: choose(leastSeen(v.entryPoints, entrySeen)).id,
      objective: choose(leastSeen(v.objectives, objSeen)).id,
      technique: choose(leastSeen(domain.techniques, techSeen)).id,
      constraint: choose(leastSeen(v.constraints, consSeen)).id,
    };
    if (!seenFingerprints.has(fingerprintOf(seed))) return seed;
  }
  for (const topology of v.topologies)
    for (const entryPoint of v.entryPoints)
      for (const objective of v.objectives)
        for (const technique of domain.techniques) {
          const seed: VariationSeed = { domain: domain.key, difficulty, topology: topology.id, entryPoint: entryPoint.id, objective: objective.id, technique: technique.id, constraint: choose(v.constraints).id };
          if (!seenFingerprints.has(fingerprintOf(seed))) return seed;
        }
  return { domain: domain.key, difficulty, topology: choose(v.topologies).id, entryPoint: choose(v.entryPoints).id, objective: choose(v.objectives).id, technique: choose(domain.techniques).id, constraint: choose(v.constraints).id };
}

/** Human-readable seed for prompts and logs. */
export function describeSeed(domain: ReasoningDomain, s: VariationSeed) {
  const v = domain.variation;
  return {
    topology: v.topologies.find((x) => x.id === s.topology)!,
    entryPoint: v.entryPoints.find((x) => x.id === s.entryPoint)!,
    objective: v.objectives.find((x) => x.id === s.objective)!,
    technique: domain.techniques.find((x) => x.id === s.technique)!,
    constraint: v.constraints.find((x) => x.id === s.constraint)!,
  };
}

/**
 * The variation for a question written on the architecture library (gen.v3, design §3.1). `recent`
 * are the seeds to spread away from: the bucket's live questions for a pool refill (plus the seeds
 * already chosen in the batch), the learner's own questions for an on-demand generation. In order:
 *  1. the architecture with the fewest of them (so a bucket never fills from one architecture);
 *  2. its least-used attack surface for the domain;
 *  3. the least-used objective among the surface's (or the domain's) objectives;
 *  4. the least-used technique among the surface's techniques;
 *  5. the least-used constraint of the domain.
 * A fingerprint in `exclude` (or among `recent`) is rejected while another combination remains: up to
 * 64 draws, then an exhaustive pass in least-used order, then any (the quality gate's similarity check
 * still applies). For a library seed `topology` is the architecture id and `entryPoint` the surface id,
 * so the fingerprint reads domain|architecture|surface|objective|technique.
 * `avoidStructures` (`<architecture>|<surface>|<objective>` of live questions, review AR-BIZ-2) are
 * passed over like a used fingerprint while another combination remains: such a seed usually yields the
 * same attack path and objective, which the similarity check would reject only after a paid call.
 */
export function structureKeyOf(s: Pick<VariationSeed, 'topology' | 'entryPoint' | 'objective'>): string {
  return `${s.topology}|${s.entryPoint}|${s.objective}`;
}

export function pickLibrarySeed(
  domain: ReasoningDomain,
  level: ReasoningDifficulty,
  archs: readonly ArchitectureDef[],
  recent: readonly VariationSeed[],
  rng: Rng = Math.random,
  exclude: ReadonlySet<string> = new Set(),
  avoidStructures: ReadonlySet<string> = new Set(),
): VariationSeed {
  if (!archs.length) throw new Error(`no library architecture covers ${domain.key} at ${level}`);
  const count = (key: (s: VariationSeed) => string | null) => {
    const m = new Map<string, number>();
    for (const s of recent) {
      const k = key(s);
      if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const lib = (s: VariationSeed) => (s.architecture ? s : null);
  const archSeen = count((s) => lib(s)?.topology ?? null);
  const surfSeen = count((s) => (lib(s) ? `${s.topology}|${s.entryPoint}` : null));
  const objSeen = count((s) => s.objective);
  const techSeen = count((s) => s.technique);
  const consSeen = count((s) => s.constraint);
  const taken = new Set([...recent.map(fingerprintOf), ...exclude]);
  const choose = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
  /** The list sorted least-used first (stable for equal counts). */
  const byUse = <T>(list: readonly T[], key: (x: T) => string, seen: Map<string, number>): T[] => [...list].sort((a, b) => (seen.get(key(a)) ?? 0) - (seen.get(key(b)) ?? 0));
  const least = <T>(list: readonly T[], key: (x: T) => string, seen: Map<string, number>): T[] => {
    const min = Math.min(...list.map((x) => seen.get(key(x)) ?? 0));
    return list.filter((x) => (seen.get(key(x)) ?? 0) === min);
  };
  const objectiveIds = new Set(domain.variation.objectives.map((o) => o.id));
  const techniqueIds = new Set(domain.techniques.map((t) => t.id));
  const objectivesOf = (surface: AttackSurface) => {
    const own = (surface.objectives ?? []).filter((id) => objectiveIds.has(id));
    return own.length ? own : [...objectiveIds];
  };
  const techniquesOf = (surface: AttackSurface) => {
    const own = surface.techniques.filter((id) => techniqueIds.has(id));
    return own.length ? own : [...techniqueIds];
  };
  const make = (arch: ArchitectureDef, surface: AttackSurface, objective: string, technique: string, constraint: string): VariationSeed => ({
    domain: domain.key,
    difficulty: level,
    topology: arch.id,
    entryPoint: surface.id,
    objective,
    technique,
    constraint,
    architecture: { id: arch.id, version: arch.version, surface: surface.id },
  });
  const usable = archs.filter((a) => surfacesFor(a, domain.key).length > 0);
  if (!usable.length) throw new Error(`no attack surface for ${domain.key} at ${level}`);
  const constraints = domain.variation.constraints.map((c) => c.id);
  const id = (x: string) => x;

  const free = (seed: VariationSeed, structure: boolean) => !taken.has(fingerprintOf(seed)) && (!structure || !avoidStructures.has(structureKeyOf(seed)));
  for (let i = 0; i < 64; i++) {
    const arch = choose(least(usable, (a) => a.id, archSeen));
    const surface = choose(least(surfacesFor(arch, domain.key), (s) => `${arch.id}|${s.id}`, surfSeen));
    const seed = make(arch, surface, choose(least(objectivesOf(surface), id, objSeen)), choose(least(techniquesOf(surface), id, techSeen)), choose(least(constraints, id, consSeen)));
    if (free(seed, true)) return seed;
  }
  const constraint = choose(least(constraints, id, consSeen));
  for (const structure of avoidStructures.size ? [true, false] : [false])
    for (const arch of byUse(usable, (a) => a.id, archSeen))
      for (const surface of byUse(surfacesFor(arch, domain.key), (s) => `${arch.id}|${s.id}`, surfSeen))
        for (const objective of byUse(objectivesOf(surface), id, objSeen))
          for (const technique of byUse(techniquesOf(surface), id, techSeen)) {
            const seed = make(arch, surface, objective, technique, constraint);
            if (free(seed, structure)) return seed;
          }
  const arch = choose(usable);
  const surface = choose(surfacesFor(arch, domain.key));
  return make(arch, surface, choose(objectivesOf(surface)), choose(techniquesOf(surface)), constraint);
}
