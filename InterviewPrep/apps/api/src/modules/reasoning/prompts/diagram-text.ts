import type { DiagramData } from '@threatready/contracts';

/**
 * The diagram as the model reads it: the same JSON React Flow renders, flattened to lines, so the
 * picture and the prompt cannot drift apart (ADD L17b).
 */
export function diagramText(d: DiagramData): string {
  const boundary = new Map(d.boundaries.map((b) => [b.id, b]));
  const node = new Map(d.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  lines.push('Trust boundaries:');
  for (const b of d.boundaries) lines.push(`- ${b.id}: ${b.label} (${b.kind})`);
  lines.push('Components:');
  for (const n of d.nodes) {
    const flags = [n.entryPoint ? 'ENTRY POINT' : '', n.compromised ? 'COMPROMISED' : ''].filter(Boolean).join(', ');
    lines.push(`- ${n.id}: ${n.label} [${n.type}] in ${boundary.get(n.boundary)?.label ?? n.boundary}${flags ? ` (${flags})` : ''}${n.controls.length ? `; controls: ${n.controls.join(', ')}` : ''}${n.detail ? `; ${n.detail}` : ''}`);
  }
  lines.push('Flows:');
  for (const e of d.edges) lines.push(`- ${e.id}: ${node.get(e.from)?.label ?? e.from} -> ${node.get(e.to)?.label ?? e.to}: ${e.label} [${e.kind}]`);
  lines.push('Attack path (in order):');
  d.attackPath.forEach((id, i) => {
    const e = d.edges.find((x) => x.id === id);
    if (e) lines.push(`${i + 1}. ${node.get(e.from)?.label ?? e.from} -> ${node.get(e.to)?.label ?? e.to}: ${e.label}`);
  });
  return lines.join('\n');
}
