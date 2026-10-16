/**
 * Core domain types for the AI Security Lab simulation engine.
 *
 * Everything the learner does is evaluated against a data-driven ScenarioConfig.
 * The engine is deterministic: given the same seed + the same learner actions,
 * it always produces the same logs, outcomes and score. No external LLM is ever
 * called, and no attack payload is ever executed — outcomes are scripted.
 */

/* ----------------------------------------------------------------------- *
 * Roles, levels, architecture layers
 * ----------------------------------------------------------------------- */

export type Role =
  | "customer"
  | "intern"
  | "support"
  | "manager"
  | "attacker"
  | "defender";

export type Level = "foundation" | "intermediate" | "expert";

/** The eight architecture nodes + the shared monitoring band. */
export type NodeId =
  | "user" // User / Chat UI
  | "input" // Input Guard
  | "llm" // LLM + System Prompt
  | "output" // Output Guard
  | "docs" // Uploaded Documents
  | "rag" // RAG Store
  | "agent" // Agent Tools
  | "registry" // Model Registry
  | "logs"; // AI Logs & Monitoring (band)

/** Defensive layers in the guardrail panel. Mirror NodeIds where sensible. */
export type Layer =
  | "systemPrompt"
  | "inputGuard"
  | "outputGuard"
  | "ragStore"
  | "agentTools"
  | "plugins"
  | "modelRegistry"
  | "budget";

/* ----------------------------------------------------------------------- *
 * Guardrail configuration + control predicates
 * ----------------------------------------------------------------------- */

export type ControlValue =
  | boolean
  | number
  | string
  | string[]
  | Record<string, unknown>;

/** The learner's current defensive configuration: layer -> control key -> value. */
export type GuardrailConfig = {
  [L in Layer]?: Record<string, ControlValue>;
};

/** Safe, structured predicate over a single control value. No eval, ever. */
export type ControlOp =
  | "isTrue"
  | "isFalse"
  | "eq"
  | "neq"
  | "gte"
  | "lte"
  | "gt"
  | "lt"
  | "listIncludes" // value (string[]) includes `expected`
  | "listExcludes" // value (string[]) does NOT include `expected`
  | "nonEmpty" // array/string non-empty
  | "exists"; // key is set to anything

export interface ControlPredicate {
  layer: Layer;
  key: string;
  op: ControlOp;
  expected?: ControlValue;
  /** Human-readable label for explanations and tooltips. */
  label: string;
}

/* ----------------------------------------------------------------------- *
 * Log events
 * ----------------------------------------------------------------------- */

export type LogType =
  | "prompt"
  | "response"
  | "retrieval"
  | "toolcall"
  | "usage"
  | "supplychain";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface LogEvent {
  id: string;
  type: LogType;
  ts: number; // epoch ms (synthetic, scenario-relative)
  sessionId: string;
  severity: Severity;
  /** Hidden classification used for scoring; never shown as a giveaway label. */
  tags: string[];
  /** Whether this event is background noise (true) or scenario-relevant. */
  noise: boolean;
  fields: Record<string, string | number | boolean | null>;
}

/* ----------------------------------------------------------------------- *
 * Scenario configuration
 * ----------------------------------------------------------------------- */

/**
 * One attack or bypass variant. "defeatedBy" is in disjunctive normal form:
 * a list of sufficient control sets. The variant is CONTAINED when ANY one inner
 * set fully holds. So [[A],[B]] means "either A or B contains it"; [[A,B]] means
 * "you need both A and B". This lets a scenario require layered fixes while still
 * accepting a single sufficient control where that is genuinely enough.
 */
export interface AttackVariant {
  id: string;
  label: string;
  /** How the learner expresses it (template shown in the attacker workbench). */
  template: string;
  /** DNF: contained when ANY inner group fully holds. */
  defeatedBy: ControlPredicate[][];
  /** Log tags planted when this variant runs successfully (pre-fix). */
  evidenceTags: string[];
}

/** A legitimate request that must keep working after the fix. */
export interface BenignTest {
  id: string;
  label: string;
  prompt: string;
  /** If ANY predicate holds, this benign request is (wrongly) blocked. */
  brokenBy: ControlPredicate[];
}

/** Accepted evidence: a set of log tags the learner must mark. */
export interface EvidenceSpec {
  /** Tags that identify the accepted evidence events. */
  acceptedTags: string[];
  /** Minimum distinct accepted events the learner must mark for full credit. */
  minRequired: number;
}

/** What a correct detection rule must achieve against the scenario logs. */
export interface DetectionSpec {
  required: boolean;
  /** The rule must match events carrying ALL of these tags (at least one each). */
  mustMatchTags: string[];
  /** The rule may match at most this many noise events before it's "noisy". */
  maxBenignMatches: number;
  /** Fields the learner is expected to key on (for hints / validation help). */
  suggestedFields: string[];
}

export interface GuidanceFoundationStep {
  text: string;
}

export interface ReportMapping {
  owasp: string[];
  atlas: string[];
  iso: string[];
  extra?: string[];
  rootCause: string;
  /** Accepted node sequence for the expert attack-path reconstruction. */
  acceptedPath: NodeId[];
}

export interface MapConfig {
  hit: NodeId[]; // nodes the attack traverses / compromises
  detect: NodeId[]; // where evidence is found (usually ["logs"])
  fix: NodeId[]; // correct fix node(s)
}

export interface ScenarioConfig {
  id: string; // e.g. "T1-F"
  taskId: number; // 1..10
  taskTitle: string;
  level: Level;
  title: string; // sub-title, e.g. "Ask Nicely"
  role: Role; // role the learner starts the attack as
  story: string;
  objective: string;
  targetComponent: NodeId;
  estMinutes: number;

  /** Foundation = full steps; others draw hints / objective only. */
  foundationSteps: GuidanceFoundationStep[];
  hints: string[]; // intermediate (each costs points)

  map: MapConfig;

  /** The primary attack + its bypass variants (variants used at I/E). */
  attack: AttackVariant;
  bypassVariants: AttackVariant[];

  benignTests: BenignTest[];
  evidence: EvidenceSpec;
  detection: DetectionSpec;

  /** ALL must hold for full "fix at correct layer" credit. */
  requiredControls: ControlPredicate[];
  /** Controls that look plausible but are the wrong layer (deduction + map miss). */
  wrongLayerControls: ControlPredicate[];

  report: ReportMapping;

  /** Pre-applied guardrail state at the start (e.g. an input filter already on). */
  initialGuardrails?: GuardrailConfig;
}

/* ----------------------------------------------------------------------- *
 * Randomised per-attempt artefacts
 * ----------------------------------------------------------------------- */

export interface SyntheticCustomer {
  id: string;
  name: string;
  phone: string;
  maskedPan: string;
  balance: number;
  city: string;
}

export interface AttemptSecrets {
  canary: string;
  discountCode: string;
  internalApi: string;
  escalationPhone: string;
  poisonedDocId: string;
  maliciousPluginId: string;
}

/* ----------------------------------------------------------------------- *
 * Attempt state machine
 * ----------------------------------------------------------------------- */

export type Phase =
  | "created"
  | "briefing"
  | "recon"
  | "attack"
  | "detect"
  | "fix"
  | "retest"
  | "report"
  | "completed";

export interface TestResult {
  id: string;
  label: string;
  kind: "attack" | "bypass" | "benign" | "chain";
  passed: boolean; // attack/bypass: blocked=true; benign: still-works=true
  detail: string;
}

export interface RetestResult {
  ran: boolean;
  overall: boolean;
  results: TestResult[];
  overBlockCount: number;
  failureReason?: string;
}

export interface ScoreBreakdown {
  attackSucceeded: number;
  evidence: number;
  detectionRule: number;
  fixCorrectLayer: number;
  retestPass: number;
  benignWorks: number;
  expertReport: number;
  deductions: number;
  total: number;
  passed: boolean;
  lines: string[]; // human-readable explanation of each award/loss
}

export interface AttemptState {
  attemptId: string;
  scenarioId: string;
  level: Level;
  seed: number;
  role: Role;
  phase: Phase;
  startedAt: number;
  updatedAt: number;

  secrets: AttemptSecrets;
  logs: LogEvent[];

  // learner progress
  attackSucceeded: boolean;
  markedEvidenceIds: string[];
  detectionRuleId: string | null;
  guardrails: GuardrailConfig;
  mapFixSelection: NodeId | null; // intermediate
  reconstructedPath: NodeId[]; // expert
  reportInputs: Record<string, string>;
  reportFrameworkPick: { owasp: string[]; atlas: string[]; iso: string[] };

  hintsUsed: number;
  wrongLayerApplied: number;
  retestHistory: RetestResult[];
  retests: number;

  score: ScoreBreakdown | null;
  completed: boolean;
}
