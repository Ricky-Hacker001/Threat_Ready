import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { layout } from '../client/src/reasoning/Diagram';
import type { DiagramData } from '../client/src/reasoning/api';

/* The engine's architecture library (InterviewPrep/apps/api/src/modules/reasoning/architectures): every
 * question's diagram is one of these 15 architectures plus an attack overlay, composed by the engine's own
 * compose.ts. Every architecture, composed with a sample attack path for each of its attack surfaces, must
 * lay out with no edge label on a component, on another label, or on another edge's line (the geometry of
 * diagram-layout.test.ts). A failure here means: shorten that architecture's labels or flows, never loosen
 * the check. Sample step labels are long enough to take the widest label box. */

const LIB = fileURLToPath(new URL('../../InterviewPrep/apps/api/src/modules/reasoning/architectures/', import.meta.url));

type Level = 'beginner' | 'intermediate' | 'advanced';
interface Surface { id: string; entryNodeIds: string[]; targetNodeIds: string[]; viaNodeIds: string[] }
interface Arch { id: string; level: Level; diagram: { nodes: unknown[] }; attackSurfaces: Record<string, Surface[]> }
interface Overlay { entryNode: string; compromisedNodes: string[]; steps: { from: string; to: string; label: string }[] }
interface Compose {
  composeDiagram(arch: Arch, overlay: Overlay): DiagramData;
  sampleOverlay(arch: Arch, surface: Surface, level: Level, opts?: { variant?: number }): Overlay | null;
}

// Loaded at run time from the engine's source (types are erased by the transform), so this package's
// typecheck does not pull in the engine's dependencies.
const compose = (await import(/* @vite-ignore */ `${LIB}compose.ts`)) as Compose;
const library: Arch[] = readdirSync(LIB)
  .filter((f) => /^[bia][1-5]-[a-z0-9-]+\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(`${LIB}${f}`, 'utf8')) as Arch);

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

function collisions(d: DiagramData): string[] {
  const { nodes, edges } = layout(d);
  const nodeRects: Rect[] = nodes.filter((n) => n.type === 'component').map((n) => ({ x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) }));
  const labels = edges.map((e) => { const data = e.data as { label: string; labelX: number; labelY: number; points: Pt[] }; const w = labelWidth(data.label); return { id: e.id, rect: { x: data.labelX - w / 2, y: data.labelY - LABEL_H / 2, w, h: LABEL_H }, points: data.points }; });
  const out: string[] = [];
  if (labels.length !== d.edges.length) out.push(`${labels.length} labels for ${d.edges.length} flows`);
  for (const l of labels) {
    if (nodeRects.some((r) => overlap(l.rect, r))) out.push(`${l.id} on a component`);
    for (const o of labels) if (o.id !== l.id && o.id > l.id && overlap(l.rect, o.rect)) out.push(`${l.id} on label ${o.id}`);
    for (const o of labels) {
      if (o.id === l.id) continue;
      for (let i = 1; i < o.points.length; i++) if (segHits(o.points[i - 1]!, o.points[i]!, l.rect)) { out.push(`${l.id} on line ${o.id}`); break; }
    }
  }
  return out;
}

describe('architecture library diagrams lay out cleanly', () => {
  it('the library has 15 architectures, 5 per level', () => {
    expect(library.map((a) => a.id)).toHaveLength(15);
    for (const level of ['beginner', 'intermediate', 'advanced']) expect(library.filter((a) => a.level === level)).toHaveLength(5);
  });

  for (const arch of library) {
    it(`${arch.id}: every surface's sample attack path`, () => {
      const seen = new Set<string>();
      const problems: string[] = [];
      for (const [domain, surfaces] of Object.entries(arch.attackSurfaces)) {
        for (const s of surfaces) {
          for (const variant of [0, 1]) {
            const overlay = compose.sampleOverlay(arch, s, arch.level, { variant });
            if (!overlay) { problems.push(`${domain}/${s.id}: no sample path`); continue; }
            const key = overlay.steps.map((x) => `${x.from}>${x.to}`).join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            const found = collisions(compose.composeDiagram(arch, overlay));
            if (found.length) problems.push(`${domain}/${s.id} [${key}]: ${found.join(', ')}`);
          }
        }
      }
      expect(seen.size).toBeGreaterThan(0);
      expect(problems, problems.join('\n')).toEqual([]);
    }, 30_000); // CPU-bound layout: up to 1.4 s idle here, 5.4 s under load; vitest's 5 s default flakes
  }
});
