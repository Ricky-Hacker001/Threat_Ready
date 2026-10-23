// Architecture diagram: structured data from the engine (never an image), rendered read-only with
// React Flow (ADD L29). Dagre lays it out as a layered, left-to-right graph with trust boundaries as
// clusters, so components never overlap; edges follow dagre's routed points and each label sits at
// the position dagre reserved for it, so labels do not land on nodes or on each other.
import { useEffect, useId, useMemo, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { BaseEdge, Background, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type EdgeTypes, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DiagramData, DiagramEdge, DiagramNode } from './api';

const NODE_W = 200;
const GLYPH: Record<string, string> = { user: 'USR', client: 'CLI', external: 'EXT', web: 'WEB', api: 'API', service: 'SVC', identity: 'IDP', database: 'DB', queue: 'MQ', storage: 'OBJ', cloud: 'CLD', firewall: 'FW', gateway: 'GW', network: 'NET', control: 'CTL', attacker: 'ATK', secret: 'KEY', compute: 'CMP', endpoint: 'EP', container: 'POD', pipeline: 'CI', repository: 'GIT', model: 'LLM', device: 'DEV', email: 'MAIL', siem: 'SIEM', saas: 'SAAS' };
// Platform tokens (app.css), so lines and arrowheads keep their contrast in the light theme too.
const COLOUR: Record<DiagramEdge['kind'], string> = { attack: 'var(--bad)', data: 'var(--text-3)', auth: 'var(--ar-teal)', control: 'var(--warn)' };

/** Estimated rendered height: a wrapped label and a row of flags make a node taller than the base. */
const nodeHeight = (n: DiagramNode) => 46 + (n.label.length > 20 ? 16 : 0) + (n.label.length > 40 ? 16 : 0) + (n.entryPoint || n.compromised || n.controls.length ? 24 : 0) + (n.controls.length > 1 && (n.entryPoint || n.compromised) ? 20 : 0);
/** Width an edge label needs, so dagre keeps that much room between the ranks it crosses. */
const labelWidth = (text: string) => Math.min(200, 24 + text.length * 6.2);
const LABEL_H = 22;

/* ---------------- Label deconfliction (post-layout) ----------------
 * Dagre reserves room for a label only inside its own edge's rank gap. Nothing stops another edge's
 * diagonal segment, a parallel edge between the same two nodes, or a neighbouring label from running
 * through that rectangle, which is what makes words sit on top of flow lines. After dagre runs we
 * place every label ourselves: try positions along the edge's own polyline (and just beside it),
 * score each against component rectangles, other edges' segments and labels already placed, and
 * keep the best. Attack steps are placed first because the story has to stay readable. */

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const rectsOverlap = (a: Rect, b: Rect, pad = 2) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/** Liang–Barsky style test: does the segment p→q pass through the rectangle (with padding)? */
function segmentHitsRect(p: Pt, q: Pt, r: Rect, pad = 3): boolean {
  const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad;
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const clip = (den: number, num: number): boolean => {
    if (den === 0) return num <= 0;
    const t = num / den;
    if (den > 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, p.x - x0) && clip(dx, x1 - p.x) && clip(-dy, p.y - y0) && clip(dy, y1 - p.y);
}

/** Point at arc-length fraction `t` of a polyline, plus the unit normal of the segment it falls on. */
function pointAt(pts: Pt[], t: number): { p: Pt; n: Pt } {
  if (pts.length === 1) return { p: pts[0]!, n: { x: 0, y: -1 } };
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y); lens.push(l); total += l; }
  let d = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i]!;
    if (d <= l || i === lens.length - 1) {
      const a = pts[i]!, b = pts[i + 1]!;
      const f = l === 0 ? 0 : d / l;
      const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      const n = l === 0 ? { x: 0, y: -1 } : { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
      return { p, n };
    }
    d -= l;
  }
  return { p: pts[pts.length - 1]!, n: { x: 0, y: -1 } };
}

/** Fractions along the edge to try, nearest the middle first so labels stay where the eye expects them. */
const FRACTIONS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
/** Perpendicular offsets: on the line (dagre's intent) first, then just above/below it. */
const OFFSETS = [0, 16, -16, 30, -30];

interface Placed { id: string; rect: Rect }

function placeLabels(
  edges: { id: string; points: Pt[]; label: string; attack: boolean; preferred: Pt }[],
  nodeRects: Rect[],
): Map<string, Pt> {
  const result = new Map<string, Pt>();
  const placed: Placed[] = [];
  // Attack steps first, then the widest labels, so the hardest-to-fit ones get the free space.
  const order = [...edges].sort((a, b) => Number(b.attack) - Number(a.attack) || labelWidth(b.label) - labelWidth(a.label));
  const segmentsOf = (e: { points: Pt[] }) => e.points.slice(1).map((q, i) => [e.points[i]!, q] as [Pt, Pt]);
  const allSegments = edges.map((e) => ({ id: e.id, segs: segmentsOf(e) }));

  for (const e of order) {
    if (!e.label) continue;
    const w = labelWidth(e.label), h = LABEL_H;
    const rectAt = (c: Pt): Rect => ({ x: c.x - w / 2, y: c.y - h / 2, w, h });
    const score = (r: Rect): number => {
      let s = 0;
      for (const n of nodeRects) if (rectsOverlap(r, n, 4)) s += 100;
      for (const p of placed) if (rectsOverlap(r, p.rect, 4)) s += 60;
      for (const o of allSegments) {
        if (o.id === e.id) continue;
        for (const [p, q] of o.segs) if (segmentHitsRect(p, q, r)) s += 25;
      }
      return s;
    };
    // Candidate 0 is dagre's own position; keep it when it is already clean.
    let best: { c: Pt; s: number } = { c: e.preferred, s: score(rectAt(e.preferred)) };
    if (best.s > 0 && e.points.length >= 2) {
      outer: for (const t of FRACTIONS) {
        const { p, n } = pointAt(e.points, t);
        for (const off of OFFSETS) {
          const c = { x: p.x + n.x * off, y: p.y + n.y * off };
          const s = score(rectAt(c)) + Math.abs(t - 0.5) * 8 + Math.abs(off) * 0.4; // mild preference for centre, on-line
          if (s < best.s) best = { c, s };
          if (best.s === 0) break outer;
        }
      }
    }
    result.set(e.id, best.c);
    placed.push({ id: e.id, rect: rectAt(best.c) });
  }
  return result;
}

/**
 * Parallel edges between the same two nodes come out of dagre on top of each other. Fan them apart
 * by a small perpendicular offset so each line, arrowhead and label is its own.
 */
function fanParallelEdges<T extends { from: string; to: string; points: Pt[] }>(edges: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const e of edges) { const k = [e.from, e.to].sort().join('|'); (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((e, i) => {
      const off = (i - (group.length - 1) / 2) * 14;
      if (off === 0 || e.points.length < 2) return;
      const a = e.points[0]!, b = e.points[e.points.length - 1]!;
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
      // Shift the interior points; keep the endpoints on their nodes.
      e.points = e.points.map((p, j) => (j === 0 || j === e.points.length - 1 ? p : { x: p.x + n.x * off, y: p.y + n.y * off }));
    });
  }
  return edges;
}

type ComponentData = DiagramNode & { [k: string]: unknown };
type BoundaryData = { label: string; kind: string; [k: string]: unknown };
type EdgeData = { kind: DiagramEdge['kind']; points: { x: number; y: number }[]; label: string; labelX: number; labelY: number; [k: string]: unknown };

function ComponentNode({ data, selected }: NodeProps<Node<ComponentData>>) {
  return (
    <div className={`ar-node ar-node-${data.type} ${data.compromised ? 'is-compromised' : ''} ${data.entryPoint ? 'is-entry' : ''} ${selected ? 'is-selected' : ''}`} title={data.detail ?? data.label}>
      <Handle type="target" position={Position.Left} className="ar-handle" />
      <Handle type="source" position={Position.Right} className="ar-handle" />
      <span className="ar-node-glyph">{GLYPH[data.type] ?? data.type.slice(0, 3).toUpperCase()}</span>
      <span className="ar-node-body">
        <span className="ar-node-label">{data.label}</span>
        <span className="ar-node-meta">
          {data.entryPoint && <b className="ar-flag ar-flag-entry">Entry</b>}
          {data.compromised && <b className="ar-flag ar-flag-bad">Compromised</b>}
          {data.controls.slice(0, 2).map((c) => <i key={c} className="ar-flag ar-flag-ctl">{c}</i>)}
          {data.controls.length > 2 && <i className="ar-flag ar-flag-ctl">+{data.controls.length - 2}</i>}
        </span>
      </span>
    </div>
  );
}

function BoundaryNode({ data }: NodeProps<Node<BoundaryData>>) {
  return <div className={`ar-boundary ar-boundary-${data.kind}`}><span className="ar-boundary-label">{data.label}</span></div>;
}

/** Edge drawn through dagre's routed points, with the label at dagre's reserved label position. */
function RoutedEdge({ id, data, markerEnd, style, selected }: EdgeProps<Edge<EdgeData>>) {
  if (!data) return null;
  const pts = data.points;
  const path = pts.length < 2 ? '' : `M ${pts[0]!.x} ${pts[0]!.y} ` + pts.slice(1).map((p, i) => {
    // Rounded corners: a short curve between consecutive segments keeps the route readable.
    const prev = pts[i]!;
    const mx = (prev.x + p.x) / 2;
    const my = (prev.y + p.y) / 2;
    return i === pts.length - 2 ? `L ${p.x} ${p.y}` : `Q ${prev.x} ${prev.y} ${mx} ${my}`;
  }).join(' ');
  const attack = data.kind === 'attack';
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} className={`ar-edge ar-edge-${data.kind} ${selected ? 'is-selected' : ''}`} />
      {data.label && (
        <EdgeLabelRenderer>
          <div className={`ar-edge-label ar-edge-label-${data.kind} ${attack ? 'is-attack' : ''}`} title={data.label} style={{ transform: `translate(-50%, -50%) translate(${data.labelX}px, ${data.labelY}px)` }}>{data.label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nodeTypes: NodeTypes = { component: ComponentNode, boundary: BoundaryNode };
const edgeTypes: EdgeTypes = { routed: RoutedEdge };

/**
 * Layered layout with trust boundaries as clusters. Dagre places nodes so they never overlap and
 * reserves space for edge labels; the attack path's edges get a little more weight so the story
 * reads left to right.
 */
export function layout(d: DiagramData): { nodes: Node[]; edges: Edge[]; size: { width: number; height: number } } {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  // edgesep is the vertical room dagre keeps between edges in one rank gap; a label is 22px tall, so
  // anything below ~40 lets two labels in the same gap touch.
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 120, edgesep: 44, marginx: 16, marginy: 16, ranker: 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  const stepOf = new Map<string, number>(d.attackPath.map((id, i) => [id, i + 1]));
  for (const b of d.boundaries) g.setNode(`b:${b.id}`, { label: b.label, clusterLabelPos: 'top', paddingTop: 44, paddingBottom: 18, paddingLeft: 18, paddingRight: 18 });
  for (const n of d.nodes) {
    g.setNode(n.id, { width: NODE_W, height: nodeHeight(n) });
    if (d.boundaries.some((b) => b.id === n.boundary)) g.setParent(n.id, `b:${n.boundary}`);
  }
  for (const e of d.edges) {
    const step = stepOf.get(e.id);
    const text = step ? `${step}. ${e.label}` : e.label;
    g.setEdge(e.from, e.to, { width: labelWidth(text), height: LABEL_H, labelpos: 'c', weight: step ? 3 : 1, minlen: 1 }, e.id);
  }
  dagre.layout(g);

  // Geometry for label placement: component rectangles and every edge's routed polyline.
  const nodeRects: Rect[] = d.nodes.map((n) => g.node(n.id)).filter(Boolean).map((p) => ({ x: p.x - p.width / 2, y: p.y - p.height / 2, w: p.width, h: p.height }));
  const routed = fanParallelEdges(d.edges.map((e) => {
    const r = g.edge(e.from, e.to, e.id) as { points?: Pt[]; x?: number; y?: number } | undefined;
    const points = r?.points ?? [];
    const mid = points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
    const step = stepOf.get(e.id);
    return { id: e.id, from: e.from, to: e.to, points, label: step ? `${step}. ${e.label}` : e.label, attack: e.kind === 'attack', preferred: { x: r?.x ?? mid.x, y: r?.y ?? mid.y } };
  }));
  const labelPos = placeLabels(routed, nodeRects);
  const routedById = new Map(routed.map((r) => [r.id, r]));

  const nodes: Node[] = [];
  for (const b of d.boundaries) {
    const c = g.node(`b:${b.id}`);
    if (!c) continue;
    nodes.push({ id: `b:${b.id}`, type: 'boundary', data: { label: b.label, kind: b.kind }, position: { x: c.x - c.width / 2, y: c.y - c.height / 2 }, style: { width: c.width, height: c.height }, draggable: false, selectable: false, zIndex: -1 });
  }
  for (const n of d.nodes) {
    const p = g.node(n.id);
    if (!p) continue;
    nodes.push({ id: n.id, type: 'component', data: { ...n }, position: { x: p.x - p.width / 2, y: p.y - p.height / 2 }, style: { width: p.width, height: p.height }, draggable: false, sourcePosition: Position.Right, targetPosition: Position.Left, zIndex: 4 });
  }
  const edges: Edge[] = d.edges.map((e) => {
    const attack = e.kind === 'attack';
    const r = routedById.get(e.id)!;
    const at = labelPos.get(e.id) ?? r.preferred;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'routed',
      data: { kind: e.kind, points: r.points, label: r.label, labelX: at.x, labelY: at.y },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: COLOUR[e.kind] },
      style: { strokeWidth: attack ? 2.4 : 1.4, stroke: COLOUR[e.kind], strokeDasharray: e.kind === 'auth' ? '6 4' : e.kind === 'control' ? '2 4' : undefined },
      animated: attack,
      zIndex: attack ? 2 : 1,
    };
  });
  const gl = g.graph() as { width?: number; height?: number };
  return { nodes, edges, size: { width: Math.max(1, gl.width ?? 1), height: Math.max(1, gl.height ?? 1) } };
}

/** fitView as a prop runs before custom nodes are measured; fit again on timers after mount and once nodes report ready. */
function FitOnReady({ signature }: { signature: string }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    const fit = () => { void fitView({ padding: 0.08, duration: 0 }); };
    const timers = [80, 300, 800, 1600].map((ms) => window.setTimeout(fit, ms));
    window.addEventListener('resize', fit);
    return () => { timers.forEach((t) => window.clearTimeout(t)); window.removeEventListener('resize', fit); };
  }, [fitView, signature]);
  useEffect(() => {
    if (ready) window.requestAnimationFrame(() => { void fitView({ padding: 0.08, duration: 0 }); });
  }, [ready, fitView, signature]);
  return null;
}

export function ArchitectureDiagram({ diagram }: { diagram: DiagramData }) {
  const { nodes, edges, size } = useMemo(() => layout(diagram), [diagram]);
  // The canvas follows the graph's shape (bounded), so a wide graph is not boxed into a tall frame.
  const ratio = Math.min(2.4, Math.max(1.1, size.width / size.height));
  const [selected, setSelected] = useState<DiagramNode | null>(null);
  const [edge, setEdge] = useState<DiagramEdge | null>(null);
  useEffect(() => { setSelected(null); setEdge(null); }, [diagram]);
  const boundaryOf = (id: string) => diagram.boundaries.find((b) => b.id === id)?.label ?? id;
  const nodeLabel = (id: string) => diagram.nodes.find((n) => n.id === id)?.label ?? id;
  const path = diagram.attackPath.map((id) => diagram.edges.find((e) => e.id === id)).filter((e): e is DiagramEdge => Boolean(e));
  const diagramKey = useMemo(() => diagram.nodes.map((n) => n.id).join('|'), [diagram]);
  const textId = useId();
  const stepOf = new Map(diagram.attackPath.map((id, i) => [id, i + 1]));
  return (
    <div className="ar-diagram">
      {/* Not role="img": the canvas holds focusable components and zoom controls. Its full content is also listed as text below. */}
      <div className="ar-flow" style={{ aspectRatio: `${ratio}`, minHeight: 340, maxHeight: 680 }} role="group" aria-label="Interactive architecture diagram with the attack path" aria-describedby={textId}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            // Low enough that a wide graph still fits a phone-width canvas; the text list below carries the details.
            minZoom={0.1}
            maxZoom={1.8}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            // The canvas sits in a scrolling page: the wheel scrolls the page; zoom with the controls or pinch, pan by drag.
            zoomOnScroll={false}
            panOnScroll={false}
            preventScrolling={false}
            zoomOnDoubleClick={false}
            onNodeClick={(_e, n) => { const found = diagram.nodes.find((x) => x.id === n.id); if (found) { setSelected(found); setEdge(null); } }}
            onEdgeClick={(_e, ed) => { const found = diagram.edges.find((x) => x.id === ed.id); if (found) { setEdge(found); setSelected(null); } }}
            onPaneClick={() => { setSelected(null); setEdge(null); }}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
            <FitOnReady signature={diagramKey} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <div className="ar-diagram-side">
        <div className="ar-legend" aria-label="Legend">
          <span><i className="ar-leg ar-leg-attack" />Attack step</span>
          <span><i className="ar-leg ar-leg-data" />Data flow</span>
          <span><i className="ar-leg ar-leg-auth" />Auth</span>
          <span><i className="ar-leg ar-leg-control" />Control</span>
          <span><b className="ar-flag ar-flag-entry">Entry</b> attacker entry point</span>
          <span><b className="ar-flag ar-flag-bad">Compromised</b> under attacker control</span>
        </div>
        {selected ? (
          <div className="ar-diagram-detail" aria-live="polite">
            <span className="tr-eyebrow">{selected.type} · {boundaryOf(selected.boundary)}</span>
            <strong>{selected.label}</strong>
            {selected.detail && <p>{selected.detail}</p>}
            <p className="tr-small"><b>Controls:</b> {selected.controls.length ? selected.controls.join(', ') : 'none shown'}</p>
            {(selected.entryPoint || selected.compromised) && <p className="tr-small">{selected.entryPoint ? 'This is where the attacker got in. ' : ''}{selected.compromised ? 'The attacker controls this component.' : ''}</p>}
          </div>
        ) : edge ? (
          <div className="ar-diagram-detail" aria-live="polite">
            <span className="tr-eyebrow">{edge.kind} flow</span>
            <strong>{nodeLabel(edge.from)} → {nodeLabel(edge.to)}</strong>
            <p>{edge.label}</p>
          </div>
        ) : (
          <div className="ar-diagram-detail">
            <span className="tr-eyebrow">Attack path</span>
            <ol className="ar-path">{path.map((e, i) => <li key={e.id}><b>{i + 1}.</b> {nodeLabel(e.from)} → {nodeLabel(e.to)}: {e.label}</li>)}</ol>
            <p className="tr-small tr-muted">Click a component or a flow for details. Use the controls to zoom, drag to pan. Every component and flow is also listed under the diagram.</p>
          </div>
        )}
      </div>
      <details className="ar-diagram-text" id={textId}>
        <summary>Diagram as text: {diagram.nodes.length} components and {diagram.edges.length} flows</summary>
        {diagram.boundaries.map((b) => {
          const inside = diagram.nodes.filter((n) => n.boundary === b.id);
          return inside.length ? <div key={b.id}><h3>{b.label}</h3><ul>{inside.map((n) => <li key={n.id}><b>{n.label}</b> ({n.type}){n.entryPoint ? ', attacker entry point' : ''}{n.compromised ? ', compromised' : ''}{n.controls.length ? `. Controls: ${n.controls.join(', ')}` : ''}{n.detail ? `. ${n.detail}` : ''}</li>)}</ul></div> : null;
        })}
        {diagram.nodes.some((n) => !diagram.boundaries.some((b) => b.id === n.boundary)) && <div><h3>Outside any boundary</h3><ul>{diagram.nodes.filter((n) => !diagram.boundaries.some((b) => b.id === n.boundary)).map((n) => <li key={n.id}><b>{n.label}</b> ({n.type}){n.entryPoint ? ', attacker entry point' : ''}{n.compromised ? ', compromised' : ''}</li>)}</ul></div>}
        <h3>Flows</h3>
        <ul>{diagram.edges.map((e) => <li key={e.id}>{stepOf.has(e.id) ? <b>Attack step {stepOf.get(e.id)}: </b> : <span>{e.kind === 'attack' ? 'Attack' : cap(e.kind)} flow: </span>}{nodeLabel(e.from)} → {nodeLabel(e.to)}, {e.label}</li>)}</ul>
      </details>
    </div>
  );
}
