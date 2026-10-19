import { z } from './zod.js';

/**
 * Attack Reasoning (ADD L17b, LLD-20; Phase 1 spec). Everything here is what the browser may see.
 * Answer keys, rubrics, option analyses and reference answers live only in the API's private item
 * half and in prompts; no contract type carries them.
 */

/** The 15 planned domains. Only registered domains (see the API's domain registry) are available. */
export const ReasoningDomainKey = z
  .enum([
    'cloud_security',
    'identity_access',
    'application_security',
    'network_security',
    'security_operations',
    'incident_response',
    'devsecops_supply_chain',
    'container_kubernetes',
    'data_security',
    'threat_intelligence',
    'endpoint_security',
    'zero_trust',
    'api_security',
    'ai_llm_security',
    'grc_risk',
  ])
  .openapi('ReasoningDomainKey');
export type ReasoningDomainKey = z.infer<typeof ReasoningDomainKey>;

export const ReasoningDifficulty = z.enum(['beginner', 'intermediate', 'advanced', 'expert']).openapi('ReasoningDifficulty');
export type ReasoningDifficulty = z.infer<typeof ReasoningDifficulty>;

export const ReasoningAttemptState = z
  .enum(['generating', 'ready', 'evaluating', 'evaluated', 'generation_failed', 'evaluation_failed'])
  .openapi('ReasoningAttemptState');
export type ReasoningAttemptState = z.infer<typeof ReasoningAttemptState>;

export const ReasoningDimensionKey = z.enum(['correctness', 'reasoning', 'architecture', 'risk']).openapi('ReasoningDimensionKey');
export type ReasoningDimensionKey = z.infer<typeof ReasoningDimensionKey>;

export const OptionId = z.enum(['A', 'B', 'C', 'D']).openapi('OptionId');
export type OptionId = z.infer<typeof OptionId>;

export const REASONING_LIMITS = {
  justificationMinChars: 40,
  justificationMaxChars: 4_000,
} as const;

/* ---------------- Architecture diagram (structured data, rendered by React Flow) ---------------- */

export const DiagramNodeType = z
  .enum(['user', 'client', 'external', 'web', 'api', 'service', 'identity', 'database', 'queue', 'storage', 'cloud', 'firewall', 'gateway', 'network', 'control', 'attacker', 'secret', 'compute'])
  .openapi('DiagramNodeType');
export type DiagramNodeType = z.infer<typeof DiagramNodeType>;

export const DiagramBoundaryKind = z.enum(['internet', 'edge', 'dmz', 'vpc', 'private', 'data', 'identity', 'account', 'onprem', 'cicd', 'management']).openapi('DiagramBoundaryKind');
export type DiagramBoundaryKind = z.infer<typeof DiagramBoundaryKind>;

export const DiagramEdgeKind = z.enum(['data', 'auth', 'control', 'attack']).openapi('DiagramEdgeKind');
export type DiagramEdgeKind = z.infer<typeof DiagramEdgeKind>;

export const DiagramBoundary = z.object({ id: z.string(), label: z.string(), kind: DiagramBoundaryKind }).openapi('DiagramBoundary');
export type DiagramBoundary = z.infer<typeof DiagramBoundary>;

export const DiagramNode = z
  .object({
    id: z.string(),
    label: z.string(),
    type: DiagramNodeType,
    boundary: z.string(),
    /** One line shown on hover or click: what the component does and what it holds. */
    detail: z.string().nullable(),
    compromised: z.boolean(),
    entryPoint: z.boolean(),
    /** Security controls present on this component (e.g. "MFA", "WAF", "encryption at rest"). */
    controls: z.array(z.string()),
  })
  .openapi('DiagramNode');
export type DiagramNode = z.infer<typeof DiagramNode>;

export const DiagramEdge = z
  .object({ id: z.string(), from: z.string(), to: z.string(), label: z.string(), kind: DiagramEdgeKind })
  .openapi('DiagramEdge');
export type DiagramEdge = z.infer<typeof DiagramEdge>;

export const DiagramData = z
  .object({
    boundaries: z.array(DiagramBoundary),
    nodes: z.array(DiagramNode),
    edges: z.array(DiagramEdge),
    /** Ordered edge ids that make up the attack path shown on the diagram. */
    attackPath: z.array(z.string()),
  })
  .openapi('DiagramData');
export type DiagramData = z.infer<typeof DiagramData>;

/* ---------------- The question as the learner sees it ---------------- */

export const ReasoningOption = z.object({ id: OptionId, text: z.string() }).openapi('ReasoningOption');
export type ReasoningOption = z.infer<typeof ReasoningOption>;

export const Technique = z.object({ id: z.string(), name: z.string() }).openapi('Technique');
export type Technique = z.infer<typeof Technique>;

export const ReasoningItemPublic = z
  .object({
    id: z.uuid(),
    domain: ReasoningDomainKey,
    difficulty: ReasoningDifficulty,
    title: z.string(),
    /** The environment and the business context. */
    scenario: z.string(),
    /** What has happened or is happening: the incident or attack context. */
    attackNarrative: z.string(),
    /** The one thing this question assesses, in the learner's words. */
    objective: z.string(),
    question: z.string(),
    options: z.array(ReasoningOption),
    diagram: DiagramData,
    techniques: z.array(Technique),
    concepts: z.array(z.string()),
    /** Names of the scoring dimensions and their weights, so the learner knows what counts. */
    weights: z.record(ReasoningDimensionKey, z.number().int()),
    generatorVersion: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi('ReasoningItemPublic');
export type ReasoningItemPublic = z.infer<typeof ReasoningItemPublic>;

/* ---------------- Requests ---------------- */

export const CreateReasoningAttemptRequest = z.object({ domain: ReasoningDomainKey }).openapi('CreateReasoningAttemptRequest');
export type CreateReasoningAttemptRequest = z.infer<typeof CreateReasoningAttemptRequest>;

export const SubmitReasoningRequest = z
  .object({
    selectedOption: OptionId,
    justification: z.string().min(1).max(REASONING_LIMITS.justificationMaxChars),
    clientSubmissionId: z.uuid(),
  })
  .openapi('SubmitReasoningRequest');
export type SubmitReasoningRequest = z.infer<typeof SubmitReasoningRequest>;

/* ---------------- Views ---------------- */

export const ReasoningAttemptView = z
  .object({
    id: z.uuid(),
    domain: ReasoningDomainKey,
    state: ReasoningAttemptState,
    item: ReasoningItemPublic.nullable(),
    answer: z.object({ selectedOption: OptionId, justification: z.string(), submittedAt: z.iso.datetime() }).nullable(),
    /** Present once evaluated: the headline only; the full result has its own route. */
    result: z.object({ totalScore: z.number().int(), correct: z.boolean(), confidence: z.enum(['high', 'medium', 'low']) }).nullable(),
    failure: z.object({ code: z.string(), stage: z.enum(['generation', 'evaluation']) }).nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ReasoningAttemptView');
export type ReasoningAttemptView = z.infer<typeof ReasoningAttemptView>;

export const ReasoningAttemptSummary = z
  .object({
    id: z.uuid(),
    domain: ReasoningDomainKey,
    state: ReasoningAttemptState,
    title: z.string().nullable(),
    difficulty: ReasoningDifficulty.nullable(),
    totalScore: z.number().int().nullable(),
    correct: z.boolean().nullable(),
    createdAt: z.iso.datetime(),
    evaluatedAt: z.iso.datetime().nullable(),
  })
  .openapi('ReasoningAttemptSummary');
export type ReasoningAttemptSummary = z.infer<typeof ReasoningAttemptSummary>;

export const ReasoningAttemptList = z.object({ items: z.array(ReasoningAttemptSummary), nextCursor: z.string().nullable() }).openapi('ReasoningAttemptList');
export type ReasoningAttemptList = z.infer<typeof ReasoningAttemptList>;

export const PointStatus = z.enum(['met', 'partial', 'missed']).openapi('PointStatus');
export type PointStatus = z.infer<typeof PointStatus>;

export const DimensionResult = z
  .object({
    key: ReasoningDimensionKey,
    label: z.string(),
    weight: z.number().int(),
    score: z.number(),
    /** Evidence per rubric point: the point text, whether it was met, the grader's rationale and the quote from the justification. */
    evidence: z.array(z.object({ point: z.string(), status: PointStatus, rationale: z.string(), quote: z.string().nullable() })),
    notes: z.array(z.string()),
  })
  .openapi('DimensionResult');
export type DimensionResult = z.infer<typeof DimensionResult>;

export const OptionVerdict = z.enum(['best', 'plausible', 'weak', 'wrong']).openapi('OptionVerdict');
export type OptionVerdict = z.infer<typeof OptionVerdict>;

export const ReasoningResult = z
  .object({
    attemptId: z.uuid(),
    domain: ReasoningDomainKey,
    totalScore: z.number().int().min(0).max(100),
    correct: z.boolean(),
    selectedOption: OptionId,
    correctOption: OptionId,
    options: z.array(z.object({ id: OptionId, text: z.string(), verdict: OptionVerdict, why: z.string() })),
    dimensions: z.array(DimensionResult),
    feedback: z.object({
      decision: z.string(),
      reasoning: z.string(),
      gotRight: z.array(z.string()),
      missed: z.array(z.string()),
      whyBest: z.string(),
      whyAlternatives: z.array(z.object({ option: OptionId, why: z.string() })),
      architectureAnalysis: z.string(),
      expertExplanation: z.string(),
      improve: z.array(z.string()),
      incorrectClaims: z.array(z.object({ claim: z.string(), why: z.string() })),
    }),
    confidence: z.enum(['high', 'medium', 'low']),
    reviewFlag: z.boolean(),
    degraded: z.boolean(),
    notices: z.array(z.string()),
    scoring: z.object({ version: z.string(), weights: z.record(ReasoningDimensionKey, z.number().int()), notes: z.array(z.string()) }),
    techniques: z.array(Technique),
    concepts: z.array(z.string()),
    evaluatedAt: z.iso.datetime(),
  })
  .openapi('ReasoningResult');
export type ReasoningResult = z.infer<typeof ReasoningResult>;

export const ReasoningDomainStats = z
  .object({ attempts: z.number().int(), evaluated: z.number().int(), averageScore: z.number().int().nullable(), bestScore: z.number().int().nullable(), lastAttemptAt: z.iso.datetime().nullable() })
  .openapi('ReasoningDomainStats');
export type ReasoningDomainStats = z.infer<typeof ReasoningDomainStats>;

export const ReasoningDomainView = z
  .object({
    key: ReasoningDomainKey,
    title: z.string(),
    description: z.string(),
    track: z.string(),
    available: z.boolean(),
    difficulty: ReasoningDifficulty.nullable(),
    focus: z.array(z.string()),
    techniques: z.array(Technique),
    weights: z.record(ReasoningDimensionKey, z.number().int()).nullable(),
    stats: ReasoningDomainStats,
  })
  .openapi('ReasoningDomainView');
export type ReasoningDomainView = z.infer<typeof ReasoningDomainView>;

export const ReasoningDashboard = z
  .object({
    attempts: z.number().int(),
    evaluated: z.number().int(),
    inProgress: z.number().int(),
    averageScore: z.number().int().nullable(),
    bestScore: z.number().int().nullable(),
    correctRate: z.number().nullable(),
    dimensionAverages: z.array(z.object({ key: ReasoningDimensionKey, label: z.string(), average: z.number().nullable(), weight: z.number().int() })),
    scoreHistory: z.array(z.object({ attemptId: z.uuid(), score: z.number().int(), correct: z.boolean(), evaluatedAt: z.iso.datetime() })),
    recent: z.array(ReasoningAttemptSummary),
    byDomain: z.array(z.object({ domain: ReasoningDomainKey, title: z.string(), stats: ReasoningDomainStats })),
  })
  .openapi('ReasoningDashboard');
export type ReasoningDashboard = z.infer<typeof ReasoningDashboard>;

export const ReasoningStateEvent = z
  .object({ type: z.literal('state'), state: ReasoningAttemptState, version: z.number().int() })
  .openapi('ReasoningStateEvent');
export type ReasoningStateEvent = z.infer<typeof ReasoningStateEvent>;
