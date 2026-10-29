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

/**
 * A short, readable account of the attack path for a learner (review AR-BIZ-10): what an older question
 * (written before the architecture library, with no authored architecture analysis) shows as the
 * architecture analysis of a single-pass result, in place of the machine listing above. Component
 * labels and step labels only: no ids, type tags or flags.
 */
export function attackPathSummary(d: DiagramData): string {
  const node = new Map(d.nodes.map((n) => [n.id, n]));
  const name = (id: string) => node.get(id)?.label ?? id;
  const boundary = new Map(d.boundaries.map((b) => [b.id, b.label]));
  const steps = d.attackPath.map((id) => d.edges.find((x) => x.id === id)).filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (!steps.length) return 'The diagram shows the components involved and the flows between them; trace how the attacker reached the affected component and which controls sit on that route.';
  const sentence = (s: string) => s.replace(/[\s.]+$/, '');
  const parts = steps.map((e, i) => `${i === 0 ? 'First' : i === steps.length - 1 ? 'Finally' : 'Then'}, from the ${name(e.from)} to the ${name(e.to)}: ${sentence(e.label)}.`);
  const crossed = [...new Set(steps.flatMap((e) => [node.get(e.from)?.boundary, node.get(e.to)?.boundary]).filter((b): b is string => Boolean(b)))].map((b) => boundary.get(b) ?? b);
  const entry = d.nodes.find((n) => n.entryPoint);
  const compromised = d.nodes.filter((n) => n.compromised && !n.entryPoint).map((n) => n.label);
  const controls = [...new Set(steps.flatMap((e) => [...(node.get(e.from)?.controls ?? []), ...(node.get(e.to)?.controls ?? [])]))];
  return [
    `The attack takes ${steps.length} step${steps.length === 1 ? '' : 's'} on the diagram.`,
    ...parts,
    entry ? `It enters at the ${entry.label}${compromised.length ? ` and reaches the ${compromised.join(', the ')}` : ''}.` : '',
    crossed.length > 1 ? `On the way it crosses ${crossed.join(', ')}.` : '',
    controls.length ? `Controls on the components along the path: ${controls.slice(0, 6).join(', ')}; ask which of them applies to each step.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
