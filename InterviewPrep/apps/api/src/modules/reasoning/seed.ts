import type { ReasoningDifficulty } from '@threatready/contracts';
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
