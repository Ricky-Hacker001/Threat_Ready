import type { DiagramData, OptionId, OptionVerdict, ReasoningDifficulty, ReasoningDimensionKey, ReasoningItemPublic, Technique } from '@threatready/contracts';
import type { VariationSeed, Weights } from './domain.types.js';

/** A rubric point the evaluator must find evidence for. Only `reasoning`, `architecture` and `risk` carry points; correctness is the option. */
export type RubricDimension = Exclude<ReasoningDimensionKey, 'correctness'>;

export interface RubricPoint {
  id: string;
  dimension: RubricDimension;
  /** What a sound justification states or uses. */
  text: string;
  weight: number;
  /** Shown to the learner when the point is missed (authored, scenario-specific). */
  hint: string;
  /** Shown with the expert explanation. */
  explanation: string;
}

export interface MustNotCredit {
  id: string;
  /** A claim that sounds right but is wrong for this scenario. */
  claim: string;
  why: string;
  /** Rubric point ids that cannot be credited when the justification asserts this claim. */
  invalidates: string[];
}

/** Server-only half of an item. Never serialised to the browser. */
export interface ReasoningItemPrivate {
  correctOption: OptionId;
  optionAnalysis: { id: OptionId; verdict: OptionVerdict; why: string }[];
  rubric: RubricPoint[];
  mustNotCredit: MustNotCredit[];
  referenceAnswer: string;
}

/** Everything the generator produced for one item, split as it is stored. */
export interface GeneratedItem {
  public: Omit<ReasoningItemPublic, 'id' | 'createdAt' | 'generatorVersion' | 'weights'>;
  private: ReasoningItemPrivate;
  weights: Weights;
  seed: VariationSeed;
  fingerprint: string;
}

/** The generator's raw structured output (snake_case, as the model writes it). */
export interface GeneratorOutput {
  title: string;
  scenario: string;
  attack_narrative: string;
  objective: string;
  question: string;
  options: { id: OptionId; text: string }[];
  correct_option: OptionId;
  option_analysis: { id: OptionId; verdict: OptionVerdict; why: string }[];
  diagram: {
    boundaries: DiagramData['boundaries'];
    nodes: { id: string; label: string; type: DiagramData['nodes'][number]['type']; boundary: string; detail: string | null; compromised: boolean; entry_point: boolean; controls: string[] }[];
    edges: DiagramData['edges'];
    attack_path: string[];
  };
  rubric: { id: string; dimension: RubricDimension; text: string; weight: '1' | '2' | '3' | '4' | '5'; hint: string; explanation: string }[];
  must_not_credit: { id: string; claim: string; why: string; invalidates: string[] }[];
  reference_answer: string;
  techniques: Technique[];
  concepts: string[];
  difficulty: ReasoningDifficulty;
}
