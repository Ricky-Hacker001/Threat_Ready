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
 * The technique taxonomy a domain cites. Most domains use MITRE ATT&CK Enterprise (the default);
 * AI & LLM Security uses MITRE ATLAS, whose ids look like AML.T0051.001. The validator checks every
 * technique id in a generated item against `idPattern`, and the generation prompt names `name`.
 */
export interface TechniqueFramework {
  name: string;
  idPattern: RegExp;
  /** One line for the generator: where the ids come from and what to cite. */
  citeRule: string;
}

export const ATTACK_ENTERPRISE: TechniqueFramework = {
  name: 'ATT&CK',
  idPattern: /^T\d{4}(\.\d{3})?$/,
  citeRule: 'Cite techniques from the MITRE ATT&CK Enterprise matrix only (ids like T1078 or T1078.004).',
};

export const ATLAS: TechniqueFramework = {
  name: 'ATLAS',
  idPattern: /^AML\.T\d{4}(\.\d{3})?$/,
  citeRule: 'Cite techniques from the MITRE ATLAS matrix only (ids like AML.T0051 or AML.T0051.001).',
};

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
  /** Technique taxonomy for this domain. Defaults to ATT&CK Enterprise when omitted. */
  framework?: TechniqueFramework;
  /**
   * What the diagram and the narrative depict, used in the generator's opening sentence. Defaults to
   * "an architecture diagram and an active attack". GRC, for example, depicts a control environment
   * with a live incident or audit finding; the engine is otherwise identical.
   */
  framing?: string;
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
  /** Library seeds: the architecture id. Legacy seeds: a topology id of the domain. */
  topology: string;
  /** Library seeds: the attack surface id. Legacy seeds: an entry point id of the domain. */
  entryPoint: string;
  objective: string;
  technique: string;
  constraint: string;
  /**
   * Library seeds only (gen.v3): the architecture and its version the question was written on, the
   * attack surface, and the structural key of the attack path once generated (`pathKey`).
   */
  architecture?: { id: string; version: number; surface: string; pathKey?: string };
}

export const fingerprintOf = (s: VariationSeed): string => [s.domain, s.topology, s.entryPoint, s.objective, s.technique].join('|');
