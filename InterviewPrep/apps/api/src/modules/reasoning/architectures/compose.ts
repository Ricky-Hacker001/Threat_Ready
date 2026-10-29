import type { DiagramData, DiagramNode } from '@threatready/contracts';
import { ATTACK_STEPS, LIBRARY_LIMITS, type ArchitectureDef, type ArchitectureLevel, type AttackOverlay, type AttackSurface } from './types.js';

/**
 * A question's diagram is its architecture plus the attack overlay the model wrote
 * (docs/ATTACK_REASONING_COST_DESIGN.md §2.5). Code composes it, so the model can only reference
 * components that exist and the picture always matches the library.
 *
 * Runtime imports are limited to ./types.js: the client's layout test loads this file directly.
 */

const originIds = (arch: ArchitectureDef) => new Set(arch.attackerOrigins.map((o) => o.id));
const nodeIds = (arch: ArchitectureDef) => new Set(arch.diagram.nodes.map((n) => n.id));

/** The node ids an overlay's path visits, in order (an attacker origin first when the path starts there). */
export function pathNodeIds(overlay: AttackOverlay): string[] {
  if (!overlay.steps.length) return overlay.entryNode ? [overlay.entryNode] : [];
  return [overlay.steps[0]!.from, ...overlay.steps.map((s) => s.to)];
}

/** Puts steps listed out of order back into chain order, when they form exactly one chain. */
function chainOrder(steps: AttackOverlay['steps']): AttackOverlay['steps'] | null {
  if (steps.every((s, i) => i === 0 || steps[i - 1]!.to === s.from)) return null;
  const targets = new Set(steps.map((s) => s.to));
  const starts = steps.filter((s) => !targets.has(s.from));
  if (starts.length !== 1) return null;
  const chain = [starts[0]!];
  const left = steps.filter((s) => s !== starts[0]);
  while (left.length) {
    const i = left.findIndex((s) => s.from === chain[chain.length - 1]!.to);
    if (i < 0) return null;
    chain.push(left.splice(i, 1)[0]!);
  }
  return chain;
}

/** A step label within LIBRARY_LIMITS.stepLabel, cut at a word (never mid-word on the public diagram, review AR-BIZ-4). */
function clipLabel(label: string): string {
  const max = LIBRARY_LIMITS.stepLabel;
  if (label.length <= max) return label;
  const word = label.slice(0, max + 1).lastIndexOf(' ');
  return (word >= max / 2 ? label.slice(0, word) : label.slice(0, max)).replace(/[\s,;:.(-]+$/, '');
}

/**
 * Repairs mechanical omissions that carry no information the gate needs: steps listed out of chain
 * order are reordered, a missing or unknown entry node is inferred (the first component on the
 * path), duplicate compromised ids are dropped, labels are trimmed and clipped at a word. Since the
 * 27 Oct review (COST-1, AR-BIZ-9) also: a step from a component to itself is dropped, and a
 * compromised id that is a component but not on the path is dropped (the diagram marks only what the
 * path reaches). Everything else stays strict.
 */
export function normaliseOverlay(arch: ArchitectureDef, overlay: AttackOverlay): { overlay: AttackOverlay; repairs: string[] } {
  const repairs: string[] = [];
  let steps = overlay.steps.map((s) => ({ from: s.from.trim(), to: s.to.trim(), label: s.label.trim().replace(/\s+/g, ' ') }));
  if (steps.some((s) => s.label.length > LIBRARY_LIMITS.stepLabel)) {
    steps = steps.map((s) => ({ ...s, label: clipLabel(s.label) }));
    repairs.push('step labels clipped at a word');
  }
  const loops = steps.filter((s) => s.from === s.to).length;
  if (loops && loops < steps.length) {
    steps = steps.filter((s) => s.from !== s.to);
    repairs.push(`${loops} self-loop step${loops > 1 ? 's' : ''} dropped`);
  }
  const reordered = chainOrder(steps);
  if (reordered) {
    steps = reordered;
    repairs.push('attack steps reordered into chain order');
  }
  const origins = originIds(arch);
  const nodes = nodeIds(arch);
  const path = steps.length ? [steps[0]!.from, ...steps.map((s) => s.to)] : [];
  const firstNode = path.find((id) => !origins.has(id));
  let entryNode = overlay.entryNode?.trim() ?? '';
  if ((!entryNode || !nodes.has(entryNode)) && firstNode && nodes.has(firstNode)) {
    repairs.push(`entry node inferred: ${firstNode}`);
    entryNode = firstNode;
  }
  let compromised = [...new Set(overlay.compromisedNodes.map((id) => id.trim()))];
  if (compromised.length !== overlay.compromisedNodes.length) repairs.push('duplicate compromised nodes dropped');
  const onPath = new Set(path);
  const offPath = compromised.filter((id) => nodes.has(id) && !onPath.has(id));
  if (offPath.length && steps.length) {
    compromised = compromised.filter((id) => !offPath.includes(id));
    repairs.push(`compromised nodes off the path dropped: ${offPath.join(', ')}`);
  }
  return { overlay: { entryNode, compromisedNodes: compromised, steps }, repairs };
}

/**
 * The overlay rules on top of the diagram rules (validateDiagram): ids exist, the steps chain end to
 * end within the level's step range, no self-loops or repeated steps, the entry node is the first
 * component on the path, compromised nodes are on the path, and the path touches the seed surface.
 * A step between two components with no drawn flow or trust relationship is only a warning: real
 * attacks use paths that are not normal flows (SSRF to a metadata service, lateral movement).
 */
export function validateOverlay(arch: ArchitectureDef, overlay: AttackOverlay, opts: { level: ArchitectureLevel; surface?: AttackSurface }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const origins = originIds(arch);
  const nodes = nodeIds(arch);
  const { min, max } = ATTACK_STEPS[opts.level];
  const steps = overlay.steps;

  if (steps.length < min || steps.length > max) errors.push(`attack: ${opts.level} questions use ${min}-${max} attack steps (got ${steps.length})`);
  steps.forEach((s, i) => {
    const n = i + 1;
    if (!nodes.has(s.from) && !origins.has(s.from)) errors.push(`attack: step ${n} starts at unknown component "${s.from}"`);
    else if (origins.has(s.from) && i > 0) errors.push(`attack: only the first step may start at the attacker origin "${s.from}"`);
    if (!nodes.has(s.to)) errors.push(`attack: step ${n} ends at unknown component "${s.to}"`);
    if (s.from === s.to) errors.push(`attack: step ${n} loops on "${s.from}"`);
    if (!s.label.trim()) errors.push(`attack: step ${n} has no label`);
    else if (s.label.length > LIBRARY_LIMITS.stepLabel) errors.push(`attack: step ${n} label is longer than ${LIBRARY_LIMITS.stepLabel} characters`);
    if (i > 0 && steps[i - 1]!.to !== s.from) errors.push(`attack: step ${n} starts at "${s.from}" but step ${i} ended at "${steps[i - 1]!.to}" (the steps must chain)`);
    if (steps.findIndex((o) => o.from === s.from && o.to === s.to) !== i) errors.push(`attack: step ${n} repeats ${s.from} -> ${s.to}`);
  });

  const path = pathNodeIds(overlay);
  const firstNode = path.find((id) => !origins.has(id));
  if (!nodes.has(overlay.entryNode)) errors.push(`attack: entry node "${overlay.entryNode}" is not a component of ${arch.id}`);
  else if (steps.length && overlay.entryNode !== firstNode) errors.push(`attack: the entry node must be the first component on the path ("${firstNode}"), not "${overlay.entryNode}"`);
  const onPath = new Set(path);
  for (const id of overlay.compromisedNodes) {
    if (!nodes.has(id)) errors.push(`attack: compromised node "${id}" is not a component of ${arch.id}`);
    else if (!onPath.has(id)) errors.push(`attack: compromised node "${id}" is not on the attack path`);
  }
  const revisited = path.filter((id, i) => path.indexOf(id) !== i);
  if (revisited.length) warnings.push(`attack: the path visits ${[...new Set(revisited)].join(', ')} more than once`);

  if (opts.surface) {
    const touch = [...opts.surface.entryNodeIds, ...opts.surface.targetNodeIds];
    if (!touch.some((id) => onPath.has(id))) errors.push(`attack: the path must use the surface "${opts.surface.id}" (one of ${touch.join(', ')})`);
  }

  // Adjacency is advisory: a drawn flow or trust relationship in either direction.
  const adjacent = adjacency(arch);
  steps.forEach((s, i) => {
    if (origins.has(s.from) || !nodes.has(s.from) || !nodes.has(s.to)) return;
    if (!adjacent.get(s.from)?.has(s.to)) warnings.push(`attack: step ${i + 1} (${s.from} -> ${s.to}) follows no drawn flow or trust relationship`);
  });
  return { errors, warnings };
}

/** Undirected adjacency over the drawn flows and trust relationships (components only). */
export function adjacency(arch: ArchitectureDef): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>(arch.diagram.nodes.map((n) => [n.id, new Set<string>()]));
  const link = (a: string, b: string) => {
    m.get(a)?.add(b);
    m.get(b)?.add(a);
  };
  for (const e of arch.diagram.edges) link(e.from, e.to);
  for (const t of arch.trustRelationships) link(t.from, t.to);
  return m;
}

/**
 * The diagram a question shows: the library components with the overlay's flags, the attacker origin
 * only when the path starts there, the library flows, then one attack edge per step (atk1..atkN), and
 * the boundaries that hold at least one drawn component.
 */
export function composeDiagram(arch: ArchitectureDef, overlay: AttackOverlay): DiagramData {
  const compromised = new Set(overlay.compromisedNodes);
  const nodes: DiagramNode[] = arch.diagram.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    boundary: n.boundary,
    detail: n.detail,
    compromised: compromised.has(n.id) || n.id === overlay.entryNode,
    entryPoint: n.id === overlay.entryNode,
    controls: [...n.controls],
  }));
  const first = overlay.steps[0];
  const origin = first && arch.attackerOrigins.find((o) => o.id === first.from);
  if (origin) nodes.unshift({ id: origin.id, label: origin.label, type: 'attacker', boundary: origin.boundary, detail: origin.detail, compromised: false, entryPoint: false, controls: [] });
  const attackEdges = overlay.steps.map((s, i) => ({ id: `atk${i + 1}`, from: s.from, to: s.to, label: s.label, kind: 'attack' as const }));
  const used = new Set(nodes.map((n) => n.boundary));
  return {
    boundaries: arch.diagram.boundaries.filter((b) => used.has(b.id)).map((b) => ({ ...b })),
    nodes,
    edges: [...arch.diagram.edges.map((e) => ({ ...e })), ...attackEdges],
    attackPath: attackEdges.map((e) => e.id),
  };
}

/** The structural identity of an attack: `<arch id>:<node ids of the path joined by '>'>` (origins included). */
export function pathKey(arch: ArchitectureDef, overlay: AttackOverlay): string {
  return `${arch.id}:${pathNodeIds(overlay).join('>')}`;
}

/** Shortest route between two components over the drawn flows and trust relationships (breadth first, ids sorted for determinism). */
export function shortestRoute(arch: ArchitectureDef, from: string, to: string, avoid: ReadonlySet<string> = new Set()): string[] | null {
  if (from === to) return [from];
  const adj = adjacency(arch);
  const prev = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of [...(adj.get(cur) ?? [])].sort()) {
      if (prev.has(next) || (avoid.has(next) && next !== to)) continue;
      prev.set(next, cur);
      if (next === to) {
        const route = [to];
        while (route[0] !== from) route.unshift(prev.get(route[0]!)!);
        return route;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * A plausible overlay for a surface within the level's step range: a route from an entry through the
 * via components to a target over drawn flows, started from an attacker origin when that fits, and
 * extended past the target when the level needs more steps. Used by the library checks (every surface
 * must have one) and by tests and the fake generator; null when the surface cannot be drawn at this level.
 */
export function sampleOverlay(arch: ArchitectureDef, surface: AttackSurface, level: ArchitectureLevel, opts: { variant?: number } = {}): AttackOverlay | null {
  const { min, max } = ATTACK_STEPS[level];
  const origins = originIds(arch);
  const nodes = nodeIds(arch);
  const label = (id: string) => arch.diagram.nodes.find((n) => n.id === id)?.label ?? arch.attackerOrigins.find((o) => o.id === id)?.label ?? id;
  const variant = opts.variant ?? 0;
  const pick = <T>(list: T[], k: number): T[] => list.map((_, i) => list[(i + k) % list.length]!);
  const entries = pick(surface.entryNodeIds, variant);
  const targets = pick(surface.targetNodeIds, variant);

  const candidates: string[][] = [];
  for (const entry of entries) {
    const start = origins.has(entry) ? null : entry;
    for (const target of targets) {
      for (const useVia of [true, false]) {
        // entry -> via... -> target, each leg a shortest route avoiding what the path already holds.
        const stops = [...(start ? [start] : []), ...(useVia ? surface.viaNodeIds : []), target].filter((id, i, a) => a.indexOf(id) === i);
        let route: string[] | null = stops.length ? [stops[0]!] : null;
        for (let i = 1; route && i < stops.length; i++) {
          const leg = shortestRoute(arch, route[route.length - 1]!, stops[i]!, new Set(route));
          route = leg ? [...route, ...leg.slice(1)] : null;
        }
        if (!route) continue;
        const origin = origins.has(entry) ? entry : (arch.attackerOrigins[variant % arch.attackerOrigins.length]?.id ?? null);
        const withOrigin = origin ? [origin, ...route] : route;
        for (const r of [withOrigin, route]) {
          const path = [...r];
          // Too short: continue from the last component to one not yet on the path (vias and targets first).
          while (path.length - 1 < min) {
            const last = path[path.length - 1]!;
            const adj = [...(adjacency(arch).get(last) ?? [])].filter((id) => !path.includes(id)).sort();
            const prefer = adj.find((id) => surface.viaNodeIds.includes(id) || surface.targetNodeIds.includes(id)) ?? adj[0];
            if (!prefer) break;
            path.push(prefer);
          }
          const steps = path.length - 1;
          if (steps >= min && steps <= max && nodes.has(path[path.length - 1]!)) candidates.push(path);
        }
      }
    }
  }
  if (!candidates.length) return null;
  // Prefer a path that starts outside (an attacker origin), then the longest within range.
  candidates.sort((a, b) => Number(origins.has(b[0]!)) - Number(origins.has(a[0]!)) || b.length - a.length);
  const path = candidates[0]!;
  const steps = path.slice(1).map((to, i) => ({ from: path[i]!, to, label: `step ${i + 1}: attacker moves on to ${label(to)}`.slice(0, LIBRARY_LIMITS.stepLabel) }));
  const comp = path.filter((id) => nodes.has(id));
  return { entryNode: comp[0]!, compromisedNodes: comp.slice(0, -1), steps };
}
