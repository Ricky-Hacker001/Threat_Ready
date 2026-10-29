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
  /**
   * Authored walk-through of the components, boundaries and trust relationships the attack path crosses
   * and which controls apply (library questions, gen.v3). Used as the feedback's architecture analysis
   * when the reconciler did not run; absent on items generated before the architecture library.
   */
  architectureAnalysis?: string;
}

/** Everything the generator produced for one item, split as it is stored. */
export interface GeneratedItem {
  public: Omit<ReasoningItemPublic, 'id' | 'createdAt' | 'generatorVersion' | 'weights'>;
  private: ReasoningItemPrivate;
  weights: Weights;
  seed: VariationSeed;
  fingerprint: string;
  /** The library architecture the question was written on (reasoning_items.architecture_id); null/absent for legacy items. */
  architectureId?: string | null;
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

/**
 * The question writer's raw output for a library question (schema `reasoning_question`, gen.v3): the
 * item without the diagram and the scenario (both come from the architecture), plus the short situation,
 * the attack overlay on the architecture's node ids and the authored architecture analysis.
 */
export interface LibraryGeneratorOutput {
  title: string;
  /** What is happening at the company today and the constraint; code joins it after the organisation summary. */
  situation: string;
  attack_narrative: string;
  objective: string;
  question: string;
  options: { id: OptionId; text: string }[];
  correct_option: OptionId;
  option_analysis: { id: OptionId; verdict: OptionVerdict; why: string }[];
  attack: {
    entry_node: string;
    compromised_nodes: string[];
    steps: { from: string; to: string; label: string }[];
  };
  rubric: GeneratorOutput['rubric'];
  must_not_credit: GeneratorOutput['must_not_credit'];
  reference_answer: string;
  architecture_analysis: string;
  techniques: Technique[];
  concepts: string[];
  difficulty: ReasoningDifficulty;
}
