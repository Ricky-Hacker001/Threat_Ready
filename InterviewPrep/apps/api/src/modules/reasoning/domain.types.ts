import type { ReasoningDifficulty, ReasoningDimensionKey, ReasoningDomainKey, Technique } from '@threatready/contracts';

/** Points per scoring dimension; the four always sum to 100 (checked by normaliseWeights). */
export type Weights = Record<ReasoningDimensionKey, number>;

export interface VariationChoice {
  id: string;
  label: string;
  /** Guidance to the generator for this choice (what to build, what to vary). */
  guide: string;
}

export interface ObjectiveChoice extends VariationChoice {
  /** The decision the question must ask for, so every objective yields a different kind of MCQ. */
  question: string;
  /** Optional weight override for questions built on this objective (still sums to 100 after normalisation). */
  weights?: Partial<Weights>;
}

/**
 * A domain is configuration over one engine (ADD §8.7: packs are content, the engine is shared).
 * Generation, validation, similarity, evaluation, scoring, persistence, the API and the UI never
 * branch on the domain key; they read this definition.
 */
export interface ReasoningDomain {
  key: ReasoningDomainKey;
  title: string;
  description: string;
  /** Track label as published on threatready.io (the catalogue groups scenarios by it). */
  track: string;
  difficulty: ReasoningDifficulty;
  /** What this domain assesses, shown on the landing page. */
  focus: string[];
  /** Skill ids from content/interview/skills.json that receive evidence from this domain. */
  skillIds: string[];
  weights: Weights;
  scoring: {
    /** Fraction of the correctness points awarded for an option the rubric marks `plausible`. */
    partialCreditForPlausible: number;
  };
  /** ATT&CK techniques the generator may draw on. Generated items must reference at least one. */
  techniques: Technique[];
  variation: {
    topologies: VariationChoice[];
    entryPoints: VariationChoice[];
    objectives: ObjectiveChoice[];
    constraints: VariationChoice[];
    /** Component vocabulary the generator should vary across items (names, not a fixed list to use in full). */
    components: string[];
  };
  /** Domain-specific rules for the generator (what realistic means here, what to avoid). */
  guidance: string;
}

/** Catalogue entry for a domain that is planned but not registered yet. */
export interface DomainCatalogueEntry {
  key: ReasoningDomainKey;
  title: string;
  description: string;
  track: string;
}

export interface VariationSeed {
  domain: ReasoningDomainKey;
  difficulty: ReasoningDifficulty;
  topology: string;
  entryPoint: string;
  objective: string;
  technique: string;
  constraint: string;
}

export const fingerprintOf = (s: VariationSeed): string => [s.domain, s.topology, s.entryPoint, s.objective, s.technique].join('|');
