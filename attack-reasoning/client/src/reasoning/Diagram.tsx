// Architecture diagram: structured data from the engine (never an image), rendered read-only with
// React Flow (ADD L29). Trust boundaries are columns ordered from the internet inward; attack edges
// are red, numbered and animated; a click shows a component's detail and controls.
import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DiagramData, DiagramEdge, DiagramNode } from './api';

const NODE_W = 196;
/** Estimated rendered height: a wrapped label and a row of flags make a node taller than the base. */
const nodeHeight = (n: DiagramNode) => 44 + (n.label.length > 20 ? 16 : 0) + (n.label.length > 40 ? 16 : 0) + (n.entryPoint || n.compromised || n.controls.length ? 24 : 0) + (n.controls.length > 1 && (n.entryPoint || n.compromised) ? 20 : 0);
const PAD = 18;
const PAD_TOP = 40;
const VGAP = 22;
const COL_GAP = 96;
const ROW_GAP = 70;
const RANK: Record<string, number> = { internet: 0, edge: 1, dmz: 1, cicd: 2, vpc: 3, private: 4, management: 5, data: 6, identity: 7, account: 7, onprem: 8 };
const GLYPH: Record<string, string> = { user: 'USR', client: 'CLI', external: 'EXT', web: 'WEB', api: 'API', service: 'SVC', identity: 'IDP', database: 'DB', queue: 'MQ', storage: 'OBJ', cloud: 'CLD', firewall: 'FW', gateway: 'GW', network: 'NET', control: 'CTL', attacker: 'ATK', secret: 'KEY', compute: 'CMP' };

type ComponentData = DiagramNode & { step: number | null; [k: string]: unknown };
type BoundaryData = { label: string; kind: string; [k: string]: unknown };

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

const nodeTypes: NodeTypes = { component: ComponentNode, boundary: BoundaryNode };

/** fitView as a prop runs before custom nodes are measured; fit again once they are. */
function FitOnReady({ signature }: { signature: string }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!ready) return undefined;
    // Measured sizes settle a frame or two after the nodes report ready; fit twice to be safe.
    const t1 = window.setTimeout(() => { void fitView({ padding: 0.1, duration: 0 }); }, 60);
    const t2 = window.setTimeout(() => { void fitView({ padding: 0.1, duration: 0 }); }, 400);
    const onResize = () => { void fitView({ padding: 0.1, duration: 0 }); };
    window.addEventListener('resize', onResize);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.removeEventListener('resize', onResize); };
  }, [ready, fitView, signature]);
  return null;
}

/** Deterministic layout: one column per trust boundary, components stacked; no layout library needed. */
export function layout(d: DiagramData): { nodes: Node[]; edges: Edge[] } {
  const order = [...d.boundaries].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || d.boundaries.indexOf(a) - d.boundaries.indexOf(b));
  const stepOf = new Map<string, number>(d.attackPath.map((id, i) => [id, i + 1]));
  const nodes: Node[] = [];
  // Boundaries flow left to right, wrapping into rows of at most four so the picture keeps a readable
  // aspect ratio when fitted to the canvas (one long row would shrink every node).
  const perRow = order.length <= 4 ? order.length : Math.ceil(order.length / Math.ceil(order.length / 4));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  order.forEach((b, idx) => {
    if (idx > 0 && idx % perRow === 0) {
      x = 0;
      y += rowHeight + ROW_GAP;
      rowHeight = 0;
    }
    const members = d.nodes.filter((n) => n.boundary === b.id);
    const heights = members.map(nodeHeight);
    const height = PAD_TOP + Math.max(60, heights.reduce((a, h) => a + h, 0) + Math.max(0, members.length - 1) * VGAP) + PAD;
    rowHeight = Math.max(rowHeight, height);
    nodes.push({ id: `b:${b.id}`, type: 'boundary', data: { label: b.label, kind: b.kind }, position: { x, y }, style: { width: NODE_W + 2 * PAD, height }, draggable: false, selectable: false, zIndex: -1 });
    let cy = PAD_TOP;
    members.forEach((n, i) => {
      nodes.push({ id: n.id, type: 'component', parentId: `b:${b.id}`, extent: 'parent', position: { x: PAD, y: cy }, data: { ...n, step: null }, draggable: false, sourcePosition: Position.Right, targetPosition: Position.Left });
      cy += heights[i]! + VGAP;
    });
    x += NODE_W + 2 * PAD + COL_GAP;
  });
  const edges: Edge[] = d.edges.map((e) => {
    const step = stepOf.get(e.id) ?? null;
    const attack = e.kind === 'attack';
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      label: step ? `${step}. ${e.label}` : e.label,
      animated: attack,
      className: `ar-edge ar-edge-${e.kind}`,
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 6,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: attack ? '#ef5a6f' : '#7b8aa6' },
      style: { strokeWidth: attack ? 2.4 : 1.4, stroke: attack ? '#ef5a6f' : e.kind === 'auth' ? '#4fb3a9' : e.kind === 'control' ? '#c5a24e' : '#7b8aa6', strokeDasharray: e.kind === 'auth' ? '6 4' : e.kind === 'control' ? '2 4' : undefined },
      data: { kind: e.kind, step },
    };
  });
  return { nodes, edges };
}

export function ArchitectureDiagram({ diagram, height = 520 }: { diagram: DiagramData; height?: number }) {
  const { nodes, edges } = useMemo(() => layout(diagram), [diagram]);
  const [selected, setSelected] = useState<DiagramNode | null>(null);
  const [edge, setEdge] = useState<DiagramEdge | null>(null);
  useEffect(() => { setSelected(null); setEdge(null); }, [diagram]);
  const boundaryOf = (id: string) => diagram.boundaries.find((b) => b.id === id)?.label ?? id;
  const nodeLabel = (id: string) => diagram.nodes.find((n) => n.id === id)?.label ?? id;
  const path = diagram.attackPath.map((id) => diagram.edges.find((e) => e.id === id)).filter((e): e is DiagramEdge => Boolean(e));
  const diagramKey = useMemo(() => diagram.nodes.map((n) => n.id).join('|'), [diagram]);
  return (
    <div className="ar-diagram">
      <div className="ar-flow" style={{ height }} role="img" aria-label="Architecture diagram with the attack path">
        <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          maxZoom={1.6}
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
            <p className="tr-small tr-muted">Click a component or a flow for details. Scroll to zoom, drag to pan.</p>
          </div>
        )}
      </div>
    </div>
  );
}
