import { ReasoningDomainKey } from '@threatready/contracts';
import { getDomain } from '../domains/index.js';
import { ATTACK_ENTERPRISE } from '../domain.types.js';
import { sampleOverlay } from './compose.js';
import { architectureText } from './text.js';
import { ARCHITECTURE_LEVELS, NODE_BOUNDS, type ArchitectureDef, type ArchitectureLevel } from './types.js';

/**
 * The library rules beyond the file shape (schema.ts): references, sizes, required content and
 * coverage (docs/ATTACK_REASONING_COST_DESIGN.md §2.2). Run on every file at load (index.ts), so a
 * broken library fails the boot and the tests, never a learner request.
 */

export const ARCHITECTURES_PER_LEVEL = 5;
/** Coverage rule: per level, every domain has surfaces in at least this many architectures… */
export const MIN_ARCHITECTURES_PER_BUCKET = 3;
/** …and each of those architectures has at least this many surfaces for the domain. */
export const MIN_SURFACES_PER_DOMAIN = 2;

const LEVEL_PREFIX: Record<ArchitectureLevel, string> = { beginner: 'b', intermediate: 'i', advanced: 'a' };

function dupes(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

/** Every rule one architecture must satisfy on its own; [] when valid. */
export function architectureErrors(arch: ArchitectureDef): string[] {
  const e: string[] = [];
  const at = (msg: string) => e.push(`${arch.id}: ${msg}`);
  const d = arch.diagram;
  const bounds = NODE_BOUNDS[arch.level];

  if (!arch.id.startsWith(LEVEL_PREFIX[arch.level])) at(`a ${arch.level} architecture id starts with "${LEVEL_PREFIX[arch.level]}"`);

  // Diagram: ids, references, sizes, a connected picture of normal flows.
  const boundaryIds = d.boundaries.map((b) => b.id);
  const nodeIds = d.nodes.map((n) => n.id);
  const originIds = arch.attackerOrigins.map((o) => o.id);
  for (const id of dupes(boundaryIds)) at(`duplicate boundary id "${id}"`);
  for (const id of dupes([...nodeIds, ...originIds])) at(`duplicate component or origin id "${id}"`);
  for (const id of dupes(d.edges.map((x) => x.id))) at(`duplicate edge id "${id}"`);
  for (const l of dupes(d.nodes.map((n) => n.label.toLowerCase()))) at(`two components share the label "${l}"`);
  const nodes = new Set(nodeIds);
  const origins = new Set(originIds);
  const boundaries = new Set(boundaryIds);
  if (d.nodes.length < bounds.nodes[0] || d.nodes.length > bounds.nodes[1]) at(`${arch.level} architectures have ${bounds.nodes[0]}-${bounds.nodes[1]} components (got ${d.nodes.length})`);
  if (d.boundaries.length < bounds.boundaries[0] || d.boundaries.length > bounds.boundaries[1]) at(`${arch.level} architectures have ${bounds.boundaries[0]}-${bounds.boundaries[1]} trust boundaries (got ${d.boundaries.length})`);
  for (const n of d.nodes) if (!boundaries.has(n.boundary)) at(`component "${n.id}" is in unknown boundary "${n.boundary}"`);
  for (const o of arch.attackerOrigins) if (!boundaries.has(o.boundary)) at(`origin "${o.id}" is in unknown boundary "${o.boundary}"`);
  for (const b of d.boundaries) {
    if (!d.nodes.some((n) => n.boundary === b.id) && !arch.attackerOrigins.some((o) => o.boundary === b.id)) at(`boundary "${b.id}" holds no component and no attacker origin`);
  }
  const pairs = new Set<string>();
  for (const x of d.edges) {
    if (!nodes.has(x.from)) at(`edge "${x.id}" starts at unknown component "${x.from}"`);
    if (!nodes.has(x.to)) at(`edge "${x.id}" ends at unknown component "${x.to}"`);
    if (x.from === x.to) at(`edge "${x.id}" loops on one component`);
    const pair = [x.from, x.to].sort().join('|');
    if (pairs.has(pair)) at(`two flows join ${x.from} and ${x.to} (merge them into one)`);
    pairs.add(pair);
  }
  if (d.edges.length < 3) at('at least three flows');
  // Connected: every component reachable from the first over drawn flows (either direction).
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const x of d.edges) {
    adj.get(x.from)?.push(x.to);
    adj.get(x.to)?.push(x.from);
  }
  const seen = new Set<string>(nodeIds.slice(0, 1));
  const queue = nodeIds.slice(0, 1);
  while (queue.length) for (const n of adj.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  const islands = nodeIds.filter((id) => !seen.has(id));
  if (islands.length) at(`components not connected to the rest by any flow: ${islands.join(', ')}`);
  const textLen = architectureText(arch).length;
  if (textLen > bounds.textChars) at(`architectureText is ${textLen} characters (at most ${bounds.textChars} for ${arch.level})`);

  // Identities, data stores, controls, trust, logs: every reference resolves.
  const known = (id: string) => nodes.has(id);
  for (const id of dupes(arch.identities.map((x) => x.id))) at(`duplicate identity id "${id}"`);
  for (const i of arch.identities) for (const id of i.nodeIds) if (!known(id)) at(`identity "${i.id}" names unknown component "${id}"`);
  for (const s of arch.dataStores) if (!known(s.nodeId)) at(`data store names unknown component "${s.nodeId}"`);
  for (const id of dupes(arch.dataStores.map((x) => x.nodeId))) at(`component "${id}" is described as a data store twice`);
  if (!arch.dataStores.some((s) => s.classification === 'regulated' || s.classification === 'confidential')) at('at least one regulated or confidential data store');
  for (const id of dupes(arch.controls.map((x) => x.id))) at(`duplicate control id "${id}"`);
  const drawn = new Map<string, Set<string>>(d.nodes.map((n) => [n.id, new Set(n.controls.map((c) => c.toLowerCase()))]));
  for (const c of arch.controls) {
    for (const id of c.nodeIds) if (!known(id)) at(`control "${c.id}" names unknown component "${id}"`);
    const label = c.label.toLowerCase();
    if (c.status === 'missing') {
      const shown = d.nodes.filter((n) => drawn.get(n.id)?.has(label)).map((n) => n.id);
      if (shown.length) at(`missing control "${c.id}" is drawn on ${shown.join(', ')}`);
    } else if (!c.nodeIds.some((id) => drawn.get(id)?.has(label))) at(`${c.status} control "${c.id}" ("${c.label}") is not drawn on any of its components`);
  }
  if (!arch.controls.some((c) => c.status === 'missing')) at('at least one missing control');
  for (const id of dupes(arch.trustRelationships.map((x) => x.id))) at(`duplicate trust relationship id "${id}"`);
  for (const t of arch.trustRelationships) {
    for (const id of [t.from, t.to]) if (!known(id) && !origins.has(id)) at(`trust relationship "${t.id}" names unknown component "${id}"`);
    if (t.from === t.to) at(`trust relationship "${t.id}" loops on one component`);
  }
  for (const id of dupes(arch.logSources.map((x) => x.id))) at(`duplicate log source id "${id}"`);
  for (const l of arch.logSources) for (const id of l.nodeIds) if (!known(id)) at(`log source "${l.id}" names unknown component "${id}"`);
  if (arch.level === 'advanced') {
    if (!arch.trustRelationships.some((t) => t.subtle)) at('advanced architectures have at least one subtle trust relationship');
    if (!arch.controls.some((c) => c.status !== 'missing' && c.limits)) at('advanced architectures have at least one present control whose limits make it not apply to some path');
  }

  // Attack surfaces: references, the domain's techniques and objectives, a drawable path per surface.
  const surfaceIds: string[] = [];
  for (const [key, surfaces] of Object.entries(arch.attackSurfaces)) {
    if (!surfaces) continue;
    const domain = getDomain(key);
    if (!ReasoningDomainKey.options.includes(key as ReasoningDomainKey) || !domain) {
      at(`attack surfaces for unknown domain "${key}"`);
      continue;
    }
    if (surfaces.length < MIN_SURFACES_PER_DOMAIN) at(`${key}: at least ${MIN_SURFACES_PER_DOMAIN} surfaces when the domain is listed (got ${surfaces.length})`);
    const fw = domain.framework ?? ATTACK_ENTERPRISE;
    const techniques = new Set(domain.techniques.map((t) => t.id));
    const objectives = new Set(domain.variation.objectives.map((o) => o.id));
    for (const s of surfaces) {
      const where = `${key}/${s.id}`;
      surfaceIds.push(s.id);
      for (const id of s.entryNodeIds) if (!known(id) && !origins.has(id)) at(`${where}: unknown entry "${id}"`);
      for (const id of [...s.targetNodeIds, ...s.viaNodeIds]) if (!known(id)) at(`${where}: unknown component "${id}"`);
      if (arch.level === 'beginner' && s.entryNodeIds.length !== 1) at(`${where}: a beginner surface has one obvious entry`);
      for (const t of s.techniques) {
        if (!fw.idPattern.test(t)) at(`${where}: "${t}" is not an ${fw.name} technique id`);
        else if (!techniques.has(t)) at(`${where}: technique ${t} is not in the ${key} technique list`);
      }
      for (const o of s.objectives ?? []) if (!objectives.has(o)) at(`${where}: objective "${o}" is not a ${key} objective`);
      if (s.objectives && s.objectives.length < 3) at(`${where}: list at least 3 objectives (or null for all)`);
      if (arch.level !== 'beginner') {
        const onPath = new Set([...s.entryNodeIds, ...s.viaNodeIds, ...s.targetNodeIds]);
        if (!arch.controls.some((c) => c.nodeIds.some((id) => onPath.has(id)))) at(`${where}: no control on the surface's components (at least one control must matter on the path)`);
      }
      if (!sampleOverlay(arch, s, arch.level)) at(`${where}: no attack path from an entry to a target fits the ${arch.level} step range`);
    }
  }
  for (const id of dupes(surfaceIds)) at(`duplicate surface id "${id}"`);
  return e;
}

/** domain -> level -> architectures with at least one surface for it (for coverage reports). */
export function coverageMatrix(defs: readonly ArchitectureDef[]): Record<string, Record<ArchitectureLevel, string[]>> {
  const m: Record<string, Record<ArchitectureLevel, string[]>> = {};
  for (const key of ReasoningDomainKey.options) {
    m[key] = { beginner: [], intermediate: [], advanced: [] };
    for (const a of defs) if ((a.attackSurfaces[key]?.length ?? 0) > 0) m[key]![a.level].push(`${a.id}(${a.attackSurfaces[key]!.length})`);
  }
  return m;
}

/** Every per-file rule plus the cross-file ones: unique ids and titles, 5 per level, and the coverage rule; [] when valid. */
export function libraryErrors(defs: readonly ArchitectureDef[]): string[] {
  const e: string[] = [];
  for (const a of defs) e.push(...architectureErrors(a));
  for (const id of dupes(defs.map((a) => a.id))) e.push(`library: duplicate architecture id "${id}"`);
  for (const t of dupes(defs.map((a) => a.title.toLowerCase()))) e.push(`library: duplicate title "${t}"`);
  for (const n of dupes(defs.map((a) => a.organisation.name.toLowerCase()))) e.push(`library: two architectures use the organisation "${n}"`);
  for (const level of ARCHITECTURE_LEVELS) {
    const at = defs.filter((a) => a.level === level);
    if (at.length !== ARCHITECTURES_PER_LEVEL) e.push(`library: ${ARCHITECTURES_PER_LEVEL} ${level} architectures expected (got ${at.length})`);
    for (const key of ReasoningDomainKey.options) {
      const covering = at.filter((a) => (a.attackSurfaces[key]?.length ?? 0) >= MIN_SURFACES_PER_DOMAIN);
      if (covering.length < MIN_ARCHITECTURES_PER_BUCKET) {
        e.push(`library: coverage ${key}/${level}: ${covering.length} architectures with at least ${MIN_SURFACES_PER_DOMAIN} surfaces (need ${MIN_ARCHITECTURES_PER_BUCKET}: ${covering.map((a) => a.id).join(', ') || 'none'})`);
      }
    }
  }
  return e;
}
