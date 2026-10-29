import type { DiagramBoundary, DiagramEdge, DiagramNode, ReasoningDifficulty, ReasoningDomainKey } from '@threatready/contracts';

/**
 * The architecture library (docs/ATTACK_REASONING_COST_DESIGN.md §2): 15 reviewed architectures,
 * 5 per level, that every generated question is written on. The model never draws a diagram; it
 * writes an attack overlay (entry node, compromised nodes, attack steps between existing node ids)
 * and code composes the diagram the client renders (compose.ts).
 *
 * This file has no runtime imports, so compose.ts (which only adds the constants below) can be
 * loaded by the client's layout test without the API's dependencies.
 */

export type ArchitectureLevel = 'beginner' | 'intermediate' | 'advanced';
export const ARCHITECTURE_LEVELS: readonly ArchitectureLevel[] = ['beginner', 'intermediate', 'advanced'];

/** 'expert' is served from the advanced pool (the contract's difficulty has four values, the library three). */
export const levelOf = (difficulty: ReasoningDifficulty | ArchitectureLevel): ArchitectureLevel => (difficulty === 'expert' ? 'advanced' : difficulty);

/** A library component: the contract's node without the flags the attack overlay sets. */
export type LibraryNode = Omit<DiagramNode, 'compromised' | 'entryPoint'>;
/** A normal flow; attack edges exist only in a composed diagram. */
export type LibraryEdge = Omit<DiagramEdge, 'kind'> & { kind: 'data' | 'auth' | 'control' };

/** Where an attack may start from outside the drawn components; drawn only when a question's path starts there. */
export interface AttackerOrigin {
  id: string;
  label: string;
  boundary: string;
  detail: string | null;
}

export type IdentityKind = 'human' | 'workload' | 'service' | 'federated' | 'machine' | 'vendor';
export interface LibraryIdentity {
  id: string;
  label: string;
  kind: IdentityKind;
  nodeIds: string[];
  privileges: string[];
  notes: string | null;
}

export type DataClassification = 'regulated' | 'confidential' | 'internal' | 'public';
export interface LibraryDataStore {
  nodeId: string;
  data: string;
  classification: DataClassification;
  regulations: string[];
}

export type ControlStatus = 'present' | 'partial' | 'missing';
export interface LibraryControl {
  id: string;
  /** For a present or partial control, the same text appears in `controls` of at least one of its nodes; a missing one appears on none. */
  label: string;
  nodeIds: string[];
  status: ControlStatus;
  covers: string;
  /** What the control does not cover (advanced: at least one present control has limits that matter). */
  limits: string | null;
}

export interface TrustRelationship {
  id: string;
  from: string;
  to: string;
  via: string;
  /** A trust that is easy to overlook (advanced levels must have one). */
  subtle: boolean;
  notes: string | null;
}

export interface LogSource {
  id: string;
  label: string;
  nodeIds: string[];
  records: string;
  gaps: string | null;
}

export interface AttackSurface {
  id: string;
  summary: string;
  /** Where the attacker gets in: node ids (or attacker origin ids). */
  entryNodeIds: string[];
  /** What the attacker is after. */
  targetNodeIds: string[];
  /** Components the path typically crosses between entry and target. */
  viaNodeIds: string[];
  /** Ids from the domain's technique list (ATLAS ids for ai_llm_security). */
  techniques: string[];
  /** A subset of the domain's objective ids; null = all of them. */
  objectives: string[] | null;
  notes: string | null;
}

export interface ArchitectureDef {
  $schema?: string;
  id: string;
  /** Bumped on any change to the file; items record the version they were written on. */
  version: number;
  level: ArchitectureLevel;
  title: string;
  organisation: { name: string; industry: string; size: string; summary: string };
  diagram: { boundaries: DiagramBoundary[]; nodes: LibraryNode[]; edges: LibraryEdge[] };
  attackerOrigins: AttackerOrigin[];
  identities: LibraryIdentity[];
  dataStores: LibraryDataStore[];
  controls: LibraryControl[];
  trustRelationships: TrustRelationship[];
  logSources: LogSource[];
  attackSurfaces: Partial<Record<ReasoningDomainKey, AttackSurface[]>>;
  /** For reviewers; never sent to the model. */
  reviewNotes: string | null;
}

/** What a generated question adds to its architecture: where the attacker got in and the steps they took. */
export interface AttackOverlay {
  entryNode: string;
  compromisedNodes: string[];
  steps: { from: string; to: string; label: string }[];
}

/** Attack steps a question may use per level. */
export const ATTACK_STEPS: Record<ArchitectureLevel, { min: number; max: number }> = {
  beginner: { min: 1, max: 2 },
  intermediate: { min: 2, max: 3 },
  advanced: { min: 3, max: 5 },
};

/**
 * Size bounds per level: components (attacker origins excluded), trust boundaries, and the length of
 * architectureText() (the cached prompt prefix).
 */
export const NODE_BOUNDS: Record<ArchitectureLevel, { nodes: [number, number]; boundaries: [number, number]; textChars: number }> = {
  beginner: { nodes: [7, 10], boundaries: [2, 4], textChars: 7_000 },
  intermediate: { nodes: [9, 13], boundaries: [3, 5], textChars: 10_000 },
  advanced: { nodes: [12, 16], boundaries: [4, 6], textChars: 14_000 },
};

/** Field length limits shared by the zod schema and the checks (the client lays labels out at these sizes). */
export const LIBRARY_LIMITS = {
  id: 40,
  title: 80,
  summaryMin: 250,
  summaryMax: 650,
  nodeLabel: 60,
  nodeDetail: 160,
  nodeControl: 32,
  nodeControls: 4,
  edgeLabel: 70,
  boundaryLabel: 40,
  stepLabel: 70,
  surfaceSummary: 240,
  text: 400,
} as const;
