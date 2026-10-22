import { describe, expect, it } from 'vitest';
import { layout } from '../client/src/reasoning/Diagram';
import type { DiagramData } from '../client/src/reasoning/api';
import { dense, fan, realistic } from '../client/src/dev/diagram-fixtures';

/* Geometry checks on the post-dagre label placement: no edge label may sit on another edge's line,
 * on a component, or on another label. These are the overlaps that were visible in the browser. */

type Rect = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
const LABEL_H = 22;
const labelWidth = (text: string) => Math.min(200, 24 + text.length * 6.2);
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function segHits(p: Pt, q: Pt, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const clip = (den: number, num: number) => { if (den === 0) return num <= 0; const t = num / den; if (den > 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } return true; };
  return clip(-dx, p.x - r.x) && clip(dx, r.x + r.w - p.x) && clip(-dy, p.y - r.y) && clip(dy, r.y + r.h - p.y);
}

function collisions(d: DiagramData) {
  const { nodes, edges } = layout(d);
  const nodeRects: Rect[] = nodes.filter((n) => n.type === 'component').map((n) => ({ x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) }));
  const labels = edges.map((e) => { const data = e.data as { label: string; labelX: number; labelY: number; points: Pt[] }; const w = labelWidth(data.label); return { id: e.id, rect: { x: data.labelX - w / 2, y: data.labelY - LABEL_H / 2, w, h: LABEL_H }, points: data.points }; });
  const onNode: string[] = [], onLabel: string[] = [], onLine: string[] = [];
  for (const l of labels) {
    if (nodeRects.some((r) => overlap(l.rect, r))) onNode.push(l.id);
    for (const o of labels) if (o.id !== l.id && o.id > l.id && overlap(l.rect, o.rect)) onLabel.push(`${l.id}~${o.id}`);
    for (const o of labels) {
      if (o.id === l.id) continue;
      for (let i = 1; i < o.points.length; i++) if (segHits(o.points[i - 1]!, o.points[i]!, l.rect)) { onLine.push(`${l.id} on ${o.id}`); break; }
    }
  }
  return { onNode, onLabel, onLine, labelCount: labels.length };
}

describe('architecture diagram label placement', () => {
  for (const [name, d] of [['dense advanced item', dense], ['fan-out gap', fan], ['realistic pool item', realistic]] as const) {
    it(`${name}: no label sits on a component, another label, or another edge's line`, () => {
      const c = collisions(d);
      expect(c.labelCount).toBe(d.edges.length);
      expect(c.onNode, `labels over components: ${c.onNode.join(', ')}`).toEqual([]);
      expect(c.onLabel, `labels over labels: ${c.onLabel.join(', ')}`).toEqual([]);
      expect(c.onLine, `labels over other lines: ${c.onLine.join(', ')}`).toEqual([]);
    });
  }

  it('parallel edges between the same two nodes no longer share a route', () => {
    const { edges } = layout(dense);
    const pts = (id: string) => (edges.find((e) => e.id === id)!.data as { points: Pt[] }).points;
    const a = pts('e11'), b = pts('a2'); // web->meta: data + attack
    const interiorA = a.slice(1, -1), interiorB = b.slice(1, -1);
    expect(interiorA.length).toBeGreaterThan(0);
    const minGap = Math.min(...interiorA.map((p, i) => Math.hypot(p.x - (interiorB[i]?.x ?? p.x), p.y - (interiorB[i]?.y ?? p.y))));
    expect(minGap).toBeGreaterThanOrEqual(10);
  });

  it('every label stays within reach of its own edge (not flung across the canvas)', () => {
    const { edges } = layout(dense);
    for (const e of edges) {
      const data = e.data as { labelX: number; labelY: number; points: Pt[] };
      const dmin = Math.min(...data.points.map((p) => Math.hypot(p.x - data.labelX, p.y - data.labelY)));
      // The furthest allowed: half a long segment plus the largest perpendicular offset.
      expect(dmin, `label for ${e.id} drifted ${dmin.toFixed(0)}px from its edge`).toBeLessThan(140);
    }
  });
});
