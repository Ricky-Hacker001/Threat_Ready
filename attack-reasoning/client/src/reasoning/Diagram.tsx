// Architecture diagram: structured data from the engine (never an image), rendered read-only with
// React Flow (ADD L29). Dagre lays it out as a layered, left-to-right graph with trust boundaries as
// clusters, so components never overlap; edges follow dagre's routed points and each label sits at
// the position dagre reserved for it, so labels do not land on nodes or on each other.
import { useEffect, useMemo, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { BaseEdge, Background, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type EdgeProps, type EdgeTypes, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DiagramData, DiagramEdge, DiagramNode } from './api';

const NODE_W = 200;
const GLYPH: Record<string, string> = { user: 'USR', client: 'CLI', external: 'EXT', web: 'WEB', api: 'API', service: 'SVC', identity: 'IDP', database: 'DB', queue: 'MQ', storage: 'OBJ', cloud: 'CLD', firewall: 'FW', gateway: 'GW', network: 'NET', control: 'CTL', attacker: 'ATK', secret: 'KEY', compute: 'CMP' };
const COLOUR: Record<DiagramEdge['kind'], string> = { attack: '#ef5a6f', data: '#7b8aa6', auth: '#4fb3a9', control: '#c5a24e' };

/** Estimated rendered height: a wrapped label and a row of flags make a node taller than the base. */
const nodeHeight = (n: DiagramNode) => 46 + (n.label.length > 20 ? 16 : 0) + (n.label.length > 40 ? 16 : 0) + (n.entryPoint || n.compromised || n.controls.length ? 24 : 0) + (n.controls.length > 1 && (n.entryPoint || n.compromised) ? 20 : 0);
/** Width an edge label needs, so dagre keeps that much room between the ranks it crosses. */
const labelWidth = (text: string) => Math.min(190, 24 + text.length * 6.2);

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
          <div className={`ar-edge-label ar-edge-label-${data.kind} ${attack ? 'is-attack' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${data.labelX}px, ${data.labelY}px)` }}>{data.label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes: NodeTypes = { component: ComponentNode, boundary: BoundaryNode };
const edgeTypes: EdgeTypes = { routed: RoutedEdge };

/**
 * Layered layout with trust boundaries as clusters. Dagre places nodes so they never overlap and
 * reserves space for edge labels; the attack path's edges get a little more weight so the story
 * reads left to right.
 */
export function layout(d: DiagramData): { nodes: Node[]; edges: Edge[]; size: { width: number; height: number } } {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 34, ranksep: 110, edgesep: 28, marginx: 16, marginy: 16, ranker: 'network-simplex' });
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
    g.setEdge(e.from, e.to, { width: labelWidth(text), height: 22, labelpos: 'c', weight: step ? 3 : 1, minlen: 1 }, e.id);
  }
  dagre.layout(g);

  const nodes: Node[] = [];
  for (const b of d.boundaries) {
    const c = g.node(`b:${b.id}`);
    if (!c) continue;
    nodes.push({ id: `b:${b.id}`, type: 'boundary', data: { label: b.label, kind: b.kind }, position: { x: c.x - c.width / 2, y: c.y - c.height / 2 }, style: { width: c.width, height: c.height }, draggable: false, selectable: false, zIndex: -1 });
  }
  for (const n of d.nodes) {
    const p = g.node(n.id);
    if (!p) continue;
    nodes.push({ id: n.id, type: 'component', data: { ...n }, position: { x: p.x - p.width / 2, y: p.y - p.height / 2 }, style: { width: p.width, height: p.height }, draggable: false, sourcePosition: Position.Right, targetPosition: Position.Left });
  }
  const edges: Edge[] = d.edges.map((e) => {
    const step = stepOf.get(e.id) ?? null;
    const attack = e.kind === 'attack';
    const r = g.edge(e.from, e.to, e.id) as { points?: { x: number; y: number }[]; x?: number; y?: number } | undefined;
    const points = r?.points ?? [];
    const mid = points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
    const text = step ? `${step}. ${e.label}` : e.label;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'routed',
      data: { kind: e.kind, points, label: text, labelX: r?.x ?? mid.x, labelY: r?.y ?? mid.y },
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
  return (
    <div className="ar-diagram">
      <div className="ar-flow" style={{ aspectRatio: `${ratio}`, minHeight: 340, maxHeight: 680 }} role="img" aria-label="Architecture diagram with the attack path">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            minZoom={0.2}
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
          <div className="ar-detail" aria-live="polite">
            <span className="tr-eyebrow">{selected.type} · {boundaryOf(selected.boundary)}</span>
            <strong>{selected.label}</strong>
            {selected.detail && <p>{selected.detail}</p>}
            <p className="tr-small"><b>Controls:</b> {selected.controls.length ? selected.controls.join(', ') : 'none shown'}</p>
            {(selected.entryPoint || selected.compromised) && <p className="tr-small">{selected.entryPoint ? 'This is where the attacker got in. ' : ''}{selected.compromised ? 'The attacker controls this component.' : ''}</p>}
          </div>
        ) : edge ? (
          <div className="ar-detail" aria-live="polite">
            <span className="tr-eyebrow">{edge.kind} flow</span>
            <strong>{nodeLabel(edge.from)} → {nodeLabel(edge.to)}</strong>
            <p>{edge.label}</p>
          </div>
        ) : (
          <div className="ar-detail">
            <span className="tr-eyebrow">Attack path</span>
            <ol className="ar-path">{path.map((e, i) => <li key={e.id}><b>{i + 1}.</b> {nodeLabel(e.from)} → {nodeLabel(e.to)}: {e.label}</li>)}</ol>
            <p className="tr-small tr-muted">Click a component or a flow for details. Use the controls to zoom, drag to pan.</p>
          </div>
        )}
      </div>
    </div>
  );
}
