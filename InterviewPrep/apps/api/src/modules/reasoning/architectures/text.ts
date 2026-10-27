import { shingles } from '../similarity.js';
import type { ArchitectureDef } from './types.js';

/**
 * The architecture as the question writer reads it: the cached, byte-stable prompt prefix
 * (docs/ATTACK_REASONING_COST_DESIGN.md §3.2). Deterministic: the same file always gives the same
 * text. Attack surfaces and review notes are never part of it (the request names only the seed's
 * surface, and review notes are for people).
 */
export function architectureText(arch: ArchitectureDef): string {
  const cached = textCache.get(arch);
  if (cached !== undefined) return cached;
  const label = new Map<string, string>([...arch.diagram.nodes.map((n) => [n.id, n.label] as const), ...arch.attackerOrigins.map((o) => [o.id, o.label] as const)]);
  const boundary = new Map(arch.diagram.boundaries.map((b) => [b.id, b.label]));
  const names = (ids: string[]) => ids.map((id) => label.get(id) ?? id).join(', ');
  const o = arch.organisation;
  const lines: string[] = [];
  lines.push(`Architecture ${arch.id} (${arch.level}): ${arch.title}`);
  lines.push(`Organisation: ${o.name}. ${o.industry}. ${o.size}.`);
  lines.push(o.summary);
  lines.push('', 'Trust boundaries:');
  for (const b of arch.diagram.boundaries) lines.push(`- ${b.id}: ${b.label} (${b.kind})`);
  lines.push('', 'Components (id: label [type] in boundary; controls drawn on it; what it does):');
  for (const n of arch.diagram.nodes) {
    lines.push(`- ${n.id}: ${n.label} [${n.type}] in ${boundary.get(n.boundary) ?? n.boundary}${n.controls.length ? `; controls: ${n.controls.join(', ')}` : '; no controls drawn'}${n.detail ? `; ${n.detail}` : ''}`);
  }
  lines.push('', 'Normal flows (from -> to: what flows [kind]):');
  for (const e of arch.diagram.edges) lines.push(`- ${e.from} -> ${e.to}: ${e.label} [${e.kind}]`);
  lines.push('', 'Attacker origins (not drawn unless the first attack step starts there):');
  for (const a of arch.attackerOrigins) lines.push(`- ${a.id}: ${a.label} in ${boundary.get(a.boundary) ?? a.boundary}${a.detail ? `; ${a.detail}` : ''}`);
  lines.push('', 'Identities:');
  for (const i of arch.identities) lines.push(`- ${i.label} (${i.kind}) on ${names(i.nodeIds)}: ${i.privileges.join('; ')}${i.notes ? `. ${i.notes}` : ''}`);
  lines.push('', 'Data stores:');
  for (const d of arch.dataStores) lines.push(`- ${label.get(d.nodeId) ?? d.nodeId}: ${d.data} (${d.classification}${d.regulations.length ? `; ${d.regulations.join(', ')}` : ''})`);
  lines.push('', 'Security controls (status on components: what it covers; its limits):');
  for (const c of arch.controls) lines.push(`- ${c.label} [${c.status}] on ${names(c.nodeIds)}: ${c.covers}${c.limits ? `; limits: ${c.limits}` : ''}`);
  if (arch.trustRelationships.length) {
    lines.push('', 'Trust relationships:');
    for (const t of arch.trustRelationships) lines.push(`- ${label.get(t.from) ?? t.from} -> ${label.get(t.to) ?? t.to} via ${t.via}${t.subtle ? ' (easy to overlook)' : ''}${t.notes ? `: ${t.notes}` : ''}`);
  }
  lines.push('', 'Log sources:');
  for (const l of arch.logSources) lines.push(`- ${l.label} (from ${names(l.nodeIds)}): records ${l.records}${l.gaps ? `; gaps: ${l.gaps}` : ''}`);
  const text = lines.join('\n');
  textCache.set(arch, text);
  return text;
}

/** Word 3-grams of architectureText: the shared vocabulary removed before comparing two questions on one architecture. */
export function architectureShingles(arch: ArchitectureDef): Set<string> {
  let s = shingleCache.get(arch);
  if (!s) {
    s = shingles(architectureText(arch));
    shingleCache.set(arch, s);
  }
  return s;
}

const textCache = new WeakMap<ArchitectureDef, string>();
const shingleCache = new WeakMap<ArchitectureDef, Set<string>>();
