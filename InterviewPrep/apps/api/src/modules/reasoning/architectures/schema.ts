import { z } from 'zod';
import { DiagramBoundaryKind, DiagramNodeType, ReasoningDomainKey } from '@threatready/contracts';
import { LIBRARY_LIMITS as L, type ArchitectureDef } from './types.js';

/**
 * The library file format, the source of truth for types.ts and architecture.schema.json (written by
 * scripts/architecture-schema.ts; a unit test keeps it in sync). Shape and field limits only: the
 * cross-reference, size, content and coverage rules are in checks.ts.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes').max(L.id);
const Text = (max: number = L.text) => z.string().trim().min(1).max(max);
const NullableText = (max: number = L.text) => Text(max).nullable();

const LibraryNodeType = z.enum(DiagramNodeType.options.filter((t): t is Exclude<typeof t, 'attacker'> => t !== 'attacker') as [string, ...string[]]);

const Boundary = z.strictObject({ id: Id, label: Text(L.boundaryLabel), kind: z.enum(DiagramBoundaryKind.options) });

const Node = z.strictObject({
  id: Id,
  label: Text(L.nodeLabel),
  type: LibraryNodeType,
  boundary: Id,
  detail: NullableText(L.nodeDetail),
  controls: z.array(Text(L.nodeControl)).max(L.nodeControls),
});

const Edge = z.strictObject({
  id: Id.refine((s) => !s.startsWith('atk'), 'edge ids starting with "atk" are reserved for attack steps'),
  from: Id,
  to: Id,
  label: Text(L.edgeLabel),
  kind: z.enum(['data', 'auth', 'control']),
});

const Origin = z.strictObject({ id: Id, label: Text(L.nodeLabel), boundary: Id, detail: NullableText(L.nodeDetail) });

const Identity = z.strictObject({
  id: Id,
  label: Text(80),
  kind: z.enum(['human', 'workload', 'service', 'federated', 'machine', 'vendor']),
  nodeIds: z.array(Id).min(1),
  privileges: z.array(Text(160)).min(1),
  notes: NullableText(),
});

const DataStore = z.strictObject({
  nodeId: Id,
  data: Text(240),
  classification: z.enum(['regulated', 'confidential', 'internal', 'public']),
  regulations: z.array(Text(40)),
});

const Control = z.strictObject({
  id: Id,
  // A present or partial control's label is drawn on a node (so it also fits L.nodeControl); a missing one is not drawn.
  label: Text(60),
  nodeIds: z.array(Id).min(1),
  status: z.enum(['present', 'partial', 'missing']),
  covers: Text(),
  limits: NullableText(),
});

const Trust = z.strictObject({ id: Id, from: Id, to: Id, via: Text(120), subtle: z.boolean(), notes: NullableText() });

const Log = z.strictObject({ id: Id, label: Text(80), nodeIds: z.array(Id).min(1), records: Text(), gaps: NullableText() });

const Surface = z.strictObject({
  id: Id,
  summary: Text(L.surfaceSummary),
  entryNodeIds: z.array(Id).min(1),
  targetNodeIds: z.array(Id).min(1),
  viaNodeIds: z.array(Id),
  techniques: z.array(z.string().regex(/^(AML\.)?T\d{4}(\.\d{3})?$/, 'an ATT&CK or ATLAS technique id')).min(1).max(6),
  objectives: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/, "a domain objective id")).min(1).nullable(),
  notes: NullableText(),
});

export const ArchitectureSchema = z.strictObject({
  $schema: z.string().optional(),
  id: Id.regex(/^[bia][1-5]-/, 'b1-…b5- (beginner), i1-…i5- (intermediate), a1-…a5- (advanced)'),
  version: z.number().int().min(1),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  title: Text(L.title),
  organisation: z.strictObject({
    name: Text(80),
    industry: Text(80),
    size: Text(120),
    summary: z.string().trim().min(L.summaryMin).max(L.summaryMax).regex(/^[^\n]+$/, 'one paragraph'),
  }),
  diagram: z.strictObject({ boundaries: z.array(Boundary).min(1), nodes: z.array(Node).min(1), edges: z.array(Edge).min(1) }),
  attackerOrigins: z.array(Origin).min(1),
  identities: z.array(Identity).min(1),
  dataStores: z.array(DataStore).min(1),
  controls: z.array(Control).min(1),
  trustRelationships: z.array(Trust),
  logSources: z.array(Log).min(1),
  attackSurfaces: z.partialRecord(ReasoningDomainKey, z.array(Surface).min(1)),
  reviewNotes: NullableText(2000),
}) as unknown as z.ZodType<ArchitectureDef>;

/** Parses one library file; throws with the file name and every failing path. */
export function parseArchitecture(raw: unknown, file: string): ArchitectureDef {
  const r = ArchitectureSchema.safeParse(raw);
  if (!r.success) throw new Error(`architecture ${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** JSON Schema for editors (the "$schema" of every library file). */
export const architectureJsonSchema = (): unknown => z.toJSONSchema(ArchitectureSchema, { target: 'draft-2020-12', unrepresentable: 'any' });
/** The exact text of architecture.schema.json (scripts/architecture-schema.ts writes it; a unit test compares it). */
export const architectureJsonSchemaText = (): string => `${JSON.stringify({ title: 'ThreatReady Attack Reasoning architecture', ...(architectureJsonSchema() as object) }, null, 2)}\n`;
