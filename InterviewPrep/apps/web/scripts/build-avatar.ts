/**
 * Procedurally builds the ThreatReady interviewer character and exports it as a binary glTF.
 *
 *   cd apps/web && npx tsx scripts/build-avatar.ts
 *
 * Output: apps/api/assets/interviewer.glb (Y-up, metres, character faces +Z, seated, origin on the
 * floor under the hips). Everything here is generated from code, so Aerovant owns the asset
 * outright: no third-party meshes, textures or scans are involved.
 *
 * Contents (see src/features/interview-prep/avatar/avatarContract.ts):
 *  - Skeleton with 13 named bones (rest pose = seated, forearms and hands resting on a desk at 0.72 m).
 *  - SkinnedMeshes: Body (clothing), HeadMesh (head + neck, with morph targets), Hands, Hair.
 *  - HeadMesh morph targets: blink, mouthOpen, smile, browRaise (position deltas only).
 *  - LeftEye / RightEye meshes parented to the Head bone (pupil looks down local +Z).
 *  - Clips: Idle, Talk, Listen, Think (bone quaternions, Chest breathing scale, morph weights).
 *
 * The geometry is built as "parts" (vertex lattices with per-vertex colour, skin weights and morph
 * deltas) that are merged per mesh. Colours are vertex colours, so no textures are needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  BONE_NAMES,
  CLIP_NAMES,
  EYE_MESH_NAMES,
  MORPH_NAMES,
  type BoneName,
  type MorphName,
} from '../src/features/interview-prep/avatar/avatarContract';

// ---------------------------------------------------------------------------------------------
// Node polyfills: GLTFExporter (binary) reads its Blob through FileReader, which Node lacks.
// ---------------------------------------------------------------------------------------------
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
const g = globalThis as unknown as { FileReader?: unknown };
if (typeof g.FileReader === 'undefined') g.FileReader = NodeFileReader;

// ---------------------------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------------------------
type Vec = [number, number, number];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, mu: number, s: number) => Math.exp(-((x - mu) ** 2) / (2 * s * s));
const gauss2 = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) =>
  Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));
const deg = (d: number) => (d * Math.PI) / 180;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const spow = (x: number, p: number) => Math.sign(x) * Math.abs(x) ** p;

/** Monotone cubic (Fritsch-Carlson) interpolation: smooth profiles without overshoot. */
function monotone(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [];
  const m: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (xIn: number) => {
    const x = clamp(xIn, xs[0]!, xs[n - 1]!);
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h * m[i + 1]!
    );
  };
}

/** Builds named monotone interpolators from a table whose first column is the key. */
function profile<K extends string>(keys: readonly K[], rows: number[][]): (x: number) => Record<K, number> {
  const xs = rows.map((r) => r[0]!);
  const fns = keys.map((_, k) => monotone(xs, rows.map((r) => r[k + 1]!)));
  return (x: number) => {
    const out = {} as Record<K, number>;
    keys.forEach((key, k) => (out[key] = fns[k]!(x)));
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// Palette (sRGB hex; converted to linear by THREE.Color)
// ---------------------------------------------------------------------------------------------
const col = (hex: string) => new THREE.Color(hex);
const C = {
  skin: col('#c8957a'),
  skinBlush: col('#c27f6c'),
  skinShadow: col('#9d6f5a'),
  lips: col('#a8645c'),
  mouth: col('#2a1414'),
  teeth: col('#e6e0d6'),
  brow: col('#2a1f19'),
  lash: col('#1b1411'),
  hair: col('#2b2019'),
  hairHi: col('#3a2c22'),
  blazer: col('#262b34'),
  lapel: col('#2c323c'),
  shirt: col('#e4e8ee'),
  shirtShade: col('#c9cfd8'),
  tie: col('#5c1e25'),
  tieHi: col('#6e2830'),
  button: col('#15171b'),
  pupil: col('#0a0a0c'),
  irisIn: col('#5b3f29'),
  irisOut: col('#3b281b'),
  limbal: col('#20170f'),
  sclera: col('#ebe6e1'),
  scleraBack: col('#c4b8b0'),
};
const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));

// ---------------------------------------------------------------------------------------------
// Geometry parts
// ---------------------------------------------------------------------------------------------
type Weights = Array<[BoneName, number]>;
interface Vert {
  p: THREE.Vector3;
  c: THREE.Color;
  w: Weights;
  /** morph deltas (relative) */
  m?: Partial<Record<MorphName, THREE.Vector3>>;
}
interface Part {
  verts: Vert[];
  tris: number[];
}

/** rows x cols vertex lattice; `wrap` connects the last column back to the first. */
function lattice(rows: number, cols: number, f: (i: number, j: number) => Vert, wrap = false): Part {
  const verts: Vert[] = [];
  const tris: number[] = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) verts.push(f(i, j));
  const cc = wrap ? cols : cols - 1;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cc; j++) {
      const a = i * cols + j;
      const b = i * cols + ((j + 1) % cols);
      const c = (i + 1) * cols + j;
      const d = (i + 1) * cols + ((j + 1) % cols);
      tris.push(a, c, b, b, c, d);
    }
  }
  return { verts, tris };
}

/** Makes face winding agree with an outward hint direction (sign of the summed agreement). */
function orient(part: Part, hint: (center: THREE.Vector3) => THREE.Vector3): Part {
  let score = 0;
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  const ctr = new THREE.Vector3();
  for (let t = 0; t < part.tris.length; t += 3) {
    const a = part.verts[part.tris[t]!]!.p;
    const b = part.verts[part.tris[t + 1]!]!.p;
    const c = part.verts[part.tris[t + 2]!]!.p;
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    ctr.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    score += n.dot(hint(ctr));
  }
  if (score < 0) {
    for (let t = 0; t < part.tris.length; t += 3) {
      const tmp = part.tris[t + 1]!;
      part.tris[t + 1] = part.tris[t + 2]!;
      part.tris[t + 2] = tmp;
    }
  }
  return part;
}
const awayFrom = (o: THREE.Vector3) => (p: THREE.Vector3) => p.clone().sub(o);
const awayFromAxisY = (cx: number, cz: number) => (p: THREE.Vector3) => v3(p.x - cx, 0, p.z - cz);

function normWeights(w: Weights): { idx: number[]; wt: number[] } {
  const merged = new Map<BoneName, number>();
  for (const [b, x] of w) if (x > 1e-4) merged.set(b, (merged.get(b) ?? 0) + x);
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = sorted.reduce((s, [, x]) => s + x, 0) || 1;
  const idx = [0, 0, 0, 0];
  const wt = [0, 0, 0, 0];
  sorted.forEach(([b, x], k) => {
    idx[k] = BONE_NAMES.indexOf(b);
    wt[k] = x / sum;
  });
  if (sorted.length === 0) wt[0] = 1;
  return { idx, wt };
}

function buildGeometry(parts: Part[], opts: { skinned: boolean; morphs?: readonly MorphName[] }): THREE.BufferGeometry {
  const pos: number[] = [];
  const colr: number[] = [];
  const si: number[] = [];
  const sw: number[] = [];
  const index: number[] = [];
  const morph: Record<string, number[]> = {};
  for (const name of opts.morphs ?? []) morph[name] = [];
  let base = 0;
  for (const part of parts) {
    for (const v of part.verts) {
      pos.push(v.p.x, v.p.y, v.p.z);
      colr.push(v.c.r, v.c.g, v.c.b);
      if (opts.skinned) {
        const { idx, wt } = normWeights(v.w);
        si.push(...idx);
        sw.push(...wt);
      }
      for (const name of opts.morphs ?? []) {
        const d = v.m?.[name];
        morph[name]!.push(d?.x ?? 0, d?.y ?? 0, d?.z ?? 0);
      }
    }
    for (const t of part.tris) index.push(t + base);
    base += part.verts.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Compact attributes keep the GLB small: RGBA16 normalised colours, 8-bit joints and weights.
  const c16 = new Uint16Array((colr.length / 3) * 4);
  for (let i = 0, k = 0; i < colr.length; i += 3, k += 4) {
    c16[k] = Math.round(clamp(colr[i]!, 0, 1) * 65535);
    c16[k + 1] = Math.round(clamp(colr[i + 1]!, 0, 1) * 65535);
    c16[k + 2] = Math.round(clamp(colr[i + 2]!, 0, 1) * 65535);
    c16[k + 3] = 65535;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c16, 4, true));
  if (opts.skinned) {
    const w8 = new Uint8Array(sw.length);
    for (let i = 0; i < sw.length; i += 4) {
      let sum = 0;
      let big = i;
      for (let k = 0; k < 4; k++) {
        w8[i + k] = Math.round(sw[i + k]! * 255);
        sum += w8[i + k]!;
        if (w8[i + k]! > w8[big]!) big = i + k;
      }
      w8[big] = w8[big]! + (255 - sum);
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(si), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(w8, 4, true));
  }
  geo.setIndex(index);
  if (opts.morphs?.length) {
    geo.morphTargetsRelative = true;
    geo.morphAttributes.position = opts.morphs.map((name) => {
      const a = new THREE.Float32BufferAttribute(morph[name]!, 3);
      a.name = name;
      return a;
    });
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Tube along a polyline/curve with parallel-transport frames and an elliptical radius profile. */
function tube(opts: {
  points: THREE.Vector3[];
  segments: number;
  radial: number;
  /** u in [0,1] along arc length -> [radius along frame normal, radius along binormal] */
  radius: (u: number, s: number, len: number) => [number, number];
  vert: (u: number, s: number, p: THREE.Vector3, around: number) => Omit<Vert, 'p'>;
  /** preferred "up" for the first frame normal */
  up?: THREE.Vector3;
}): Part {
  const curve = new THREE.CatmullRomCurve3(opts.points, false, 'centripetal');
  const len = curve.getLength();
  const n = opts.segments;
  const pts: THREE.Vector3[] = [];
  const tans: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push(curve.getPointAt(u));
    tans.push(curve.getTangentAt(u).normalize());
  }
  // parallel transport
  const normals: THREE.Vector3[] = [];
  const up = (opts.up ?? v3(0, 1, 0)).clone();
  let nrm = up.clone().sub(tans[0]!.clone().multiplyScalar(up.dot(tans[0]!)));
  if (nrm.lengthSq() < 1e-8) nrm = v3(1, 0, 0);
  nrm.normalize();
  normals.push(nrm.clone());
  for (let i = 1; i <= n; i++) {
    const axis = new THREE.Vector3().crossVectors(tans[i - 1]!, tans[i]!);
    const prev = normals[i - 1]!.clone();
    if (axis.lengthSq() > 1e-12) {
      const ang = Math.acos(clamp(tans[i - 1]!.dot(tans[i]!), -1, 1));
      prev.applyAxisAngle(axis.normalize(), ang);
    }
    normals.push(prev.normalize());
  }
  const part = lattice(
    n + 1,
    opts.radial,
    (i, j) => {
      const u = i / n;
      const a = (j / opts.radial) * Math.PI * 2;
      const [ra, rb] = opts.radius(u, u * len, len);
      const t = tans[i]!;
      const N = normals[i]!;
      const B = new THREE.Vector3().crossVectors(t, N).normalize();
      const p = pts[i]!.clone()
        .addScaledVector(N, Math.cos(a) * ra)
        .addScaledVector(B, Math.sin(a) * rb);
      return { p, ...opts.vert(u, u * len, p, a) };
    },
    true,
  );
  // orient using the nearest centre-line point
  return orient(part, (c) => {
    let best = pts[0]!;
    let bd = Infinity;
    for (const q of pts) {
      const d = q.distanceToSquared(c);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return c.clone().sub(best);
  });
}

/** Rounded end-cap radius multiplier for a tube of length `len` with end radius `r`. */
function capped(s: number, len: number, r0: number, r1: number, capStart = true, capEnd = true): number {
  let k = 1;
  if (capStart && s < r0) k = Math.min(k, Math.sqrt(Math.max(0, 1 - ((r0 - s) / r0) ** 2)));
  if (capEnd && s > len - r1) k = Math.min(k, Math.sqrt(Math.max(0, 1 - ((s - (len - r1)) / r1) ** 2)));
  return k;
}

/** Superellipsoid in a local frame (unit extents), returned in world space via `place`. */
function superellipsoid(opts: {
  rows: number;
  cols: number;
  e1: number; // vertical squareness (2 = round)
  e2: number; // horizontal squareness
  place: (x: number, y: number, z: number) => THREE.Vector3; // local unit coords -> world
  vert: (p: THREE.Vector3, lx: number, ly: number, lz: number) => Omit<Vert, 'p'>;
  center: THREE.Vector3;
}): Part {
  const part = lattice(
    opts.rows + 1,
    opts.cols,
    (i, j) => {
      const phi = -Math.PI / 2 + (i / opts.rows) * Math.PI;
      const th = (j / opts.cols) * Math.PI * 2;
      const cp = Math.cos(phi);
      const x = spow(cp, 2 / opts.e1) * spow(Math.cos(th), 2 / opts.e2);
      const z = spow(cp, 2 / opts.e1) * spow(Math.sin(th), 2 / opts.e2);
      const y = spow(Math.sin(phi), 2 / opts.e1);
      const p = opts.place(x, y, z);
      return { p, ...opts.vert(p, x, y, z) };
    },
    true,
  );
  return orient(part, awayFrom(opts.center));
}

/**
 * The head is modelled at life size and then scaled slightly about the Head joint: a marginally
 * larger head reads as friendlier and more natural at webcam framing distances.
 */
const HEAD_SCALE = 1.06;
function scaleParts(parts: Part[], pivot: THREE.Vector3, k: number): Part[] {
  for (const part of parts) {
    for (const v of part.verts) {
      v.p.sub(pivot).multiplyScalar(k).add(pivot);
      if (v.m) for (const d of Object.values(v.m)) d?.multiplyScalar(k);
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Skeleton (world-space rest positions; every bone has identity rest rotation)
// ---------------------------------------------------------------------------------------------
const BONES: Record<BoneName, { parent: BoneName | null; pos: Vec }> = {
  Hips: { parent: null, pos: [0, 0.55, 0] },
  Spine: { parent: 'Hips', pos: [0, 0.68, 0] },
  Chest: { parent: 'Spine', pos: [0, 0.86, 0] },
  Neck: { parent: 'Chest', pos: [0, 1.07, -0.01] },
  Head: { parent: 'Neck', pos: [0, 1.16, -0.01] },
  LeftShoulder: { parent: 'Chest', pos: [0.05, 1.04, -0.01] },
  LeftUpperArm: { parent: 'LeftShoulder', pos: [0.19, 1.03, -0.01] },
  LeftLowerArm: { parent: 'LeftUpperArm', pos: [0.222, 0.79, 0.07] },
  LeftHand: { parent: 'LeftLowerArm', pos: [0.15, 0.758, 0.33] },
  RightShoulder: { parent: 'Chest', pos: [-0.05, 1.04, -0.01] },
  RightUpperArm: { parent: 'RightShoulder', pos: [-0.19, 1.03, -0.01] },
  RightLowerArm: { parent: 'RightUpperArm', pos: [-0.222, 0.79, 0.07] },
  RightHand: { parent: 'RightLowerArm', pos: [-0.15, 0.758, 0.33] },
};
const bpos = (b: BoneName) => v3(...BONES[b].pos);
const DESK_Y = 0.72;

// ---------------------------------------------------------------------------------------------
// Head (head + neck lattice with sculpted features)
// ---------------------------------------------------------------------------------------------
const Y0 = 1.142; // chin bottom
const EYE_Y = 1.262;
const MOUTH_Y = 1.194;
const EYE_X = 0.032;
const EYE_R = 0.0118;
const MOUTH_HALF = 0.0245;

// h = y - Y0; F front z, B back z, M side z, W half width, nF/nB superellipse exponents
const headProfile = profile(
  ['F', 'B', 'M', 'W', 'nF', 'nB'] as const,
  [
    [-0.14, 0.044, -0.06, -0.01, 0.05, 2, 2],
    [-0.08, 0.044, -0.059, -0.01, 0.049, 2, 2],
    [-0.035, 0.045, -0.058, -0.01, 0.049, 2, 2],
    [-0.017, 0.049, -0.058, -0.01, 0.05, 1.9, 2],
    [-0.009, 0.06, -0.058, -0.01, 0.051, 1.7, 2],
    [-0.002, 0.074, -0.059, -0.009, 0.053, 1.6, 2],
    [0.004, 0.086, -0.06, -0.009, 0.052, 1.5, 2],
    [0.011, 0.094, -0.062, -0.009, 0.053, 1.5, 2],
    [0.022, 0.099, -0.064, -0.008, 0.057, 1.65, 2],
    [0.034, 0.102, -0.067, -0.008, 0.06, 1.75, 2.1],
    [0.048, 0.104, -0.071, -0.008, 0.064, 1.95, 2.1],
    [0.064, 0.104, -0.077, -0.008, 0.069, 2.2, 2.2],
    [0.085, 0.101, -0.085, -0.008, 0.075, 2.5, 2.2],
    [0.105, 0.098, -0.093, -0.008, 0.078, 2.6, 2.2],
    [0.125, 0.101, -0.099, -0.008, 0.079, 2.5, 2.2],
    [0.145, 0.1, -0.102, -0.008, 0.079, 2.4, 2.2],
    [0.165, 0.095, -0.102, -0.008, 0.077, 2.3, 2.2],
    [0.185, 0.085, -0.099, -0.009, 0.072, 2.2, 2.2],
    [0.203, 0.066, -0.09, -0.01, 0.062, 2.1, 2.1],
    [0.216, 0.044, -0.073, -0.011, 0.047, 2, 2],
    [0.224, 0.022, -0.049, -0.012, 0.028, 2, 2],
    [0.228, -0.012, -0.012, -0.012, 0, 2, 2],
  ],
);
const H_TOP = 0.228;

const noseP = monotone(
  [-0.058, -0.052, -0.046, -0.04, -0.034, -0.02, -0.005, 0.008, 0.02],
  [0, 0.006, 0.016, 0.0205, 0.019, 0.0135, 0.0085, 0.0045, 0],
);
const noseS = monotone([-0.058, -0.044, -0.036, -0.02, 0, 0.02], [0.0078, 0.0088, 0.008, 0.006, 0.0056, 0.0075]);

/** Facial sculpt displacement (mostly along +z) as a function of base position. */
function faceDisp(x: number, y: number, z0: number): { dx: number; dz: number } {
  const front = sstep(0.0, 0.05, z0);
  if (front <= 0) return { dx: 0, dz: 0 };
  const ax = Math.abs(x);
  const ny = y - EYE_Y;
  let dz = 0;
  let dx = 0;
  dz -= 0.0085 * gauss2(ax, y, EYE_X, EYE_Y + 0.001, 0.0125, 0.0095); // sockets
  dz += 0.004 * gauss2(ax, y, 0.03, EYE_Y + 0.02, 0.02, 0.006); // brow ridge
  dz += noseP(ny) * Math.exp(-(x * x) / (2 * noseS(ny) ** 2)); // nose
  dz += 0.006 * gauss2(ax, y, 0.0135, EYE_Y - 0.046, 0.0055, 0.0055); // alae
  const cheek = gauss2(ax, y, 0.047, EYE_Y - 0.022, 0.014, 0.012);
  dz += 0.004 * cheek;
  dx += Math.sign(x) * 0.003 * cheek;
  dz += 0.002 * gauss2(x, y, 0, MOUTH_Y + 0.008, 0.012, 0.006); // philtrum area
  dz -= 0.002 * gauss2(x, y, 0, MOUTH_Y - 0.014, 0.015, 0.004); // mentolabial groove
  dz += 0.005 * gauss2(x, y, 0, Y0 + 0.018, 0.012, 0.009); // chin
  dz -= 0.002 * gauss2(ax, y, MOUTH_HALF + 0.002, MOUTH_Y, 0.004, 0.004); // mouth corners
  return { dx: dx * front, dz: dz * front };
}

function headBase(h: number, phi: number): THREE.Vector3 {
  const p = headProfile(h);
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const n = c >= 0 ? p.nF : p.nB;
  const x = p.W * spow(s, 2 / n);
  const z = c >= 0 ? p.M + (p.F - p.M) * Math.abs(c) ** (2 / p.nF) : p.M + (p.B - p.M) * Math.abs(c) ** (2 / p.nB);
  return v3(x, Y0 + h, z);
}
function headPoint(h: number, phi: number): THREE.Vector3 {
  const b = headBase(h, phi);
  const d = faceDisp(b.x, b.y, b.z);
  return v3(b.x + d.dx, b.y, b.z + d.dz);
}
/** z of the (displaced) front surface at (x, y). */
function faceZ(x: number, y: number): number {
  const p = headProfile(y - Y0);
  const r = clamp(Math.abs(x) / Math.max(p.W, 1e-6), 0, 1);
  const s = r ** (p.nF / 2);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const z0 = p.M + (p.F - p.M) * c ** (2 / p.nF);
  return z0 + faceDisp(x, y, z0).dz;
}
function headNormal(h: number, phi: number): THREE.Vector3 {
  const e = 0.0015;
  const p = headPoint(h, phi);
  const du = headPoint(h, phi + 0.01).sub(headPoint(h, phi - 0.01));
  const dv = headPoint(Math.min(h + e, H_TOP), phi).sub(headPoint(h - e, phi));
  const n = new THREE.Vector3().crossVectors(du, dv).normalize();
  const out = p.clone().sub(v3(0, 1.25, -0.005));
  if (n.dot(out) < 0) n.negate();
  if (!Number.isFinite(n.x)) return out.normalize();
  return n;
}

const HEAD_COLS = 64;
const headPhi = (j: number) => {
  const s = -1 + (2 * j) / HEAD_COLS;
  return Math.PI * (0.5 * s + 0.5 * s * s * s);
};
const headRows: number[] = (() => {
  const rows: number[] = [];
  let h = -0.14;
  while (h < 0.215) {
    rows.push(h);
    h += h < -0.03 ? 0.014 : h < 0 ? 0.0045 : h < 0.16 ? 0.0033 : 0.0055;
  }
  rows.push(0.219, 0.2235, 0.2265, H_TOP);
  return rows;
})();

function headWeights(y: number): Weights {
  const toHead = sstep(1.12, 1.17, y);
  const toChest = 1 - sstep(1.0, 1.06, y);
  return [
    ['Head', toHead],
    ['Neck', (1 - toHead) * (1 - toChest)],
    ['Chest', (1 - toHead) * toChest],
  ];
}

function buildHeadLattice(): Part {
  const part = lattice(
    headRows.length,
    HEAD_COLS,
    (i, j) => {
      const h = headRows[i]!;
      const phi = headPhi(j);
      const b = headBase(h, phi);
      const p = headPoint(h, phi);
      const { x, y } = p;
      const ax = Math.abs(x);
      const front = sstep(0.0, 0.05, b.z);

      // colour: skin with subtle warmth on cheeks/nose and depth in the sockets
      let c = C.skin.clone();
      c = mix(c, C.skinBlush, 0.35 * gauss2(ax, y, 0.042, EYE_Y - 0.032, 0.014, 0.012) * front);
      c = mix(c, C.skinBlush, 0.3 * gauss2(x, y, 0, EYE_Y - 0.04, 0.008, 0.008) * front);
      c = mix(c, C.skinShadow, 0.35 * gauss2(ax, y, EYE_X + 0.003, EYE_Y + 0.004, 0.014, 0.01) * front);
      c = mix(c, C.skinShadow, 0.25 * (1 - sstep(Y0 - 0.03, Y0 + 0.005, y)) * sstep(1.06, 1.12, y));

      // morphs
      const m: Partial<Record<MorphName, THREE.Vector3>> = {};
      // mouthOpen: jaw drops, the slit between the lips caves in and darkens
      let jw = sstep(MOUTH_Y - 0.001, MOUTH_Y - 0.008, y) * sstep(-0.03, 0.05, b.z);
      jw *= 1 - sstep(Y0 - 0.005, Y0 - 0.04, y);
      jw *= 1 - sstep(0.045, 0.066, ax);
      const slit =
        (1 - sstep(0.0028, 0.0048, Math.abs(y - MOUTH_Y))) * (1 - sstep(MOUTH_HALF * 0.75, MOUTH_HALF * 0.98, ax)) * sstep(0.07, 0.09, b.z);
      m.mouthOpen = v3(0, -0.0105 * jw - 0.004 * slit, -0.0025 * jw - 0.013 * slit);
      c = mix(c, C.mouth, slit);
      // smile: mouth corners up/out, cheeks lift
      const corner = gauss2(ax, y, MOUTH_HALF + 0.001, MOUTH_Y + 0.002, 0.009, 0.008) * front;
      const cheek = gauss2(ax, y, 0.034, MOUTH_Y + 0.02, 0.012, 0.012) * front;
      m.smile = v3(Math.sign(x) * 0.0022 * corner, 0.0035 * corner + 0.0018 * cheek, 0.0012 * corner + 0.0022 * cheek);
      // browRaise
      const bw = gauss2(ax, y, 0.03, EYE_Y + 0.022, 0.022, 0.012) * front;
      const fh = gauss(y, EYE_Y + 0.045, 0.02) * front;
      m.browRaise = v3(0, 0.0045 * bw + 0.0012 * fh, 0);
      return { p, c, w: headWeights(y), m };
    },
    true,
  );
  return orient(part, awayFrom(v3(0, 1.25, -0.005)));
}

// Eye placement: protrude from the socket surface
const eyeSurfaceZ = faceZ(EYE_X, EYE_Y);
const EYE_Z = eyeSurfaceZ - EYE_R + 0.0058;
const eyeCenter = (side: 1 | -1) => v3(side * EYE_X, EYE_Y, EYE_Z);

function buildLids(side: 1 | -1): Part[] {
  const E = eyeCenter(side);
  const RL = EYE_R * 1.12;
  const dir = (a: number, e: number) => v3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const A = deg(78);
  const cols = 22;
  // upper lid: rows from tucked edge (k=0) to top (k=rows-1)
  const upperEdge = (a: number) => deg(21) - deg(14) * (a / A) ** 2;
  const closedEdge = (a: number) => deg(-19) + deg(6) * (a / A) ** 2;
  const top = deg(62);
  const rowsU = 9;
  const upperPoint = (a: number, k: number, edge: number) => {
    if (k === 0) return E.clone().addScaledVector(dir(a, edge - deg(2)), EYE_R * 1.02);
    const t = (k - 1) / (rowsU - 2);
    const e = lerp(edge, top, t ** 1.3);
    const r = RL * (1 + 0.04 * Math.sin(Math.PI * t));
    return E.clone().addScaledVector(dir(a, e), r);
  };
  const upper = lattice(rowsU, cols, (k, j) => {
    const a = side * lerp(-A, A, j / (cols - 1));
    const p = upperPoint(a, k, upperEdge(a));
    const pc = upperPoint(a, k, closedEdge(a));
    const lash = k <= 1 ? 1 : k === 2 ? 0.35 : 0;
    const c = mix(mix(C.skin, C.skinShadow, 0.25), C.lash, lash);
    const raise = upperPoint(a, k, upperEdge(a) + deg(5) * (1 - k / rowsU)).sub(p);
    return { p, c, w: [['Head', 1]], m: { blink: pc.sub(p), browRaise: raise } };
  });
  // lower lid
  const lowerEdge = (a: number) => deg(-30) + deg(12) * (a / A) ** 2;
  const rowsL = 6;
  const lowerPoint = (a: number, k: number, edge: number) => {
    if (k === 0) return E.clone().addScaledVector(dir(a, edge + deg(2)), EYE_R * 1.02);
    const t = (k - 1) / (rowsL - 2);
    return E.clone().addScaledVector(dir(a, lerp(edge, deg(-68), t)), RL * 0.98);
  };
  const lower = lattice(rowsL, cols, (k, j) => {
    const a = side * lerp(-A, A, j / (cols - 1));
    const p = lowerPoint(a, k, lowerEdge(a));
    const smile = lowerPoint(a, k, lowerEdge(a) + deg(7) * (1 - k / rowsL)).sub(p);
    const blink = lowerPoint(a, k, lowerEdge(a) + deg(5) * (1 - k / rowsL)).sub(p);
    const c = mix(C.skin, C.skinShadow, k <= 1 ? 0.45 : 0.15);
    return { p, c, w: [['Head', 1]], m: { smile, blink } };
  });
  return [orient(upper, awayFrom(E)), orient(lower, awayFrom(E))];
}

function buildBrow(side: 1 | -1): Part {
  const rows = 5;
  const cols = 18;
  const part = lattice(rows, cols, (i, j) => {
    const u = j / (cols - 1);
    const v = -1 + (2 * i) / (rows - 1);
    const x = side * (0.0125 + 0.037 * u);
    const yc = EYE_Y + 0.0175 + 0.0055 * Math.sin(Math.PI * u * 0.85) - 0.0025 * u;
    const th = 0.0031 - 0.0018 * u;
    const y = yc + v * th;
    const lift = 0.0011 * Math.sqrt(Math.max(0, 1 - v * v)) + 0.0004;
    const p = v3(x, y, faceZ(x, y) + lift);
    const raise = 0.0052 * (0.75 + 0.35 * (1 - u));
    // keep it on the skin while it moves up
    const pr = v3(x, y + raise, faceZ(x, y + raise) + lift);
    return { p, c: C.brow.clone(), w: [['Head', 1]], m: { browRaise: pr.sub(p), smile: v3(0, 0.0008 * u, 0) } };
  });
  return orient(part, () => v3(0, 0, 1));
}

function buildLips(): Part[] {
  const make = (upper: boolean): Part => {
    const cols = 34;
    const radial = 12;
    const part = lattice(
      cols,
      radial,
      (j, k) => {
        const u = -1 + (2 * j) / (cols - 1);
        const x = u * MOUTH_HALF;
        const taper = Math.max(0, 1 - u * u) ** 0.55;
        const bow = upper ? 0.0011 * (gauss(u, 0.2, 0.12) + gauss(u, -0.2, 0.12)) - 0.0006 * gauss(u, 0, 0.08) : 0;
        const yc = MOUTH_Y + (upper ? 0.0036 + bow : -0.0046) * taper;
        const ry = (upper ? 0.0037 : 0.0047) * taper;
        const rz = (upper ? 0.0034 : 0.0043) * taper;
        const zc = faceZ(x, MOUTH_Y) - 0.0016;
        // horizontal outward normal of the face along the mouth
        const dzdx = (faceZ(x + 0.001, MOUTH_Y) - faceZ(x - 0.001, MOUTH_Y)) / 0.002;
        const N = v3(-dzdx, 0, 1).normalize();
        const a = (k / radial) * Math.PI * 2;
        const p = v3(x, yc, zc).addScaledVector(v3(0, 1, 0), Math.sin(a) * ry).addScaledVector(N, Math.cos(a) * rz);
        const front = Math.max(0, Math.cos(a));
        const c = mix(mix(C.lips, C.skin, 0.55 * Math.abs(u) ** 3), C.skinBlush, 0.15 * (1 - front));
        const cornerW = u * u;
        const m: Partial<Record<MorphName, THREE.Vector3>> = {
          smile: v3(Math.sign(u) * 0.0026 * cornerW, 0.0038 * cornerW, -0.0012 * cornerW),
          mouthOpen: upper ? v3(0, 0.0022 * (1 - cornerW), 0.0004) : v3(0, -0.0125 * (1 - 0.65 * cornerW), -0.0022),
        };
        return { p, c, w: [['Head', 1]], m };
      },
      true,
    );
    return orient(part, (ctr) => v3(0, ctr.y - (MOUTH_Y + (upper ? 0.004 : -0.005)), ctr.z - (faceZ(ctr.x, MOUTH_Y) - 0.0016)));
  };
  return [make(true), make(false)];
}

function buildTeeth(): Part {
  const part = lattice(4, 20, (i, j) => {
    const u = -1 + (2 * j) / 19;
    const x = u * MOUTH_HALF * 0.78;
    const y = MOUTH_Y - 0.0032 + (i / 3) * 0.0095;
    const z = faceZ(x, MOUTH_Y) - 0.0062 - 0.004 * u * u;
    return { p: v3(x, y, z), c: mix(C.teeth, C.skinShadow, 0.5 * Math.abs(u) ** 2), w: [['Head', 1]] };
  });
  return orient(part, () => v3(0, 0, 1));
}

function buildEar(side: 1 | -1): Part {
  const he = EYE_Y - 0.016 - Y0;
  const pr = headProfile(he);
  const center = v3(side * (pr.W - 0.0005), Y0 + he, pr.M - 0.006);
  const rot = new THREE.Euler(-0.14, side * 0.32, side * 0.05);
  const q = new THREE.Quaternion().setFromEuler(rot);
  return superellipsoid({
    rows: 12,
    cols: 18,
    e1: 2.2,
    e2: 2.2,
    center,
    place: (x, y, z) => {
      // x: lateral thickness, y: height, z: depth; dish the outer face (concha)
      const dish = x > 0 ? 0.0042 * Math.exp(-((y / 0.7) ** 2 + ((z + 0.1) / 0.6) ** 2) * 2.2) : 0;
      const local = v3(x * 0.0072 - dish, y * 0.03 * (1 - 0.18 * Math.max(0, -y)), z * 0.018 * (1 - 0.25 * Math.max(0, -y)));
      local.x *= side;
      return local.applyQuaternion(q).add(center);
    },
    vert: () => ({ c: mix(C.skin, C.skinBlush, 0.35), w: [['Head', 1]] }),
  });
}

function buildEyeGeometry(): THREE.BufferGeometry {
  // lathe around +Z; theta measured from the front pole
  const rings: Array<[number, THREE.Color]> = [
    [0, C.pupil],
    [6.5, C.pupil],
    [8, C.irisIn],
    [16, C.irisIn],
    [24, C.irisOut],
    [27, C.limbal],
    [29, mix(C.sclera, C.limbal, 0.15)],
    [36, C.sclera],
    [70, C.sclera],
    [110, C.scleraBack],
    [150, C.scleraBack],
    [180, C.scleraBack],
  ];
  const cols = 32;
  const part = lattice(
    rings.length,
    cols,
    (i, j) => {
      const [thDeg, color] = rings[i]!;
      const th = deg(thDeg);
      const a = (j / cols) * Math.PI * 2;
      const bulge = thDeg < 28 ? 1 + 0.045 * Math.cos((thDeg / 28) * (Math.PI / 2)) : 1;
      const r = EYE_R * bulge;
      const p = v3(Math.sin(th) * Math.cos(a) * r, Math.sin(th) * Math.sin(a) * r, Math.cos(th) * r);
      return { p, c: color.clone(), w: [] };
    },
    true,
  );
  orient(part, (c) => c.clone());
  return buildGeometry([part], { skinned: false });
}

// ---------------------------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------------------------
const hairline = monotone(
  [0, 25, 40, 55, 70, 85, 95, 115, 140, 180].map(deg),
  [0.178, 0.182, 0.184, 0.163, 0.142, 0.128, 0.132, 0.118, 0.072, 0.04],
);
function buildHair(): Part {
  const rows = 24;
  const part = lattice(
    rows,
    HEAD_COLS,
    (i, j) => {
      const phi = headPhi(j);
      const hl = hairline(Math.abs(phi)) + 0.0022 * Math.sin(phi * 11) * sstep(deg(10), deg(40), Math.abs(phi));
      const t = i / (rows - 1);
      const h = lerp(hl, H_TOP, 1 - (1 - t) ** 1.6);
      const base = headPoint(h, phi);
      const n = headNormal(Math.min(h, H_TOP - 0.0005), phi);
      const crown = sstep(0.12, 0.21, h);
      const sweep = (phi < 0 ? 0.0025 : 0.001) * crown; // volume swept toward the right side
      const quiff = 0.006 * gauss(phi, 0.2, 0.45) * gauss(h, 0.195, 0.02);
      const part = -0.0035 * gauss(phi, deg(38), deg(4)) * sstep(0.17, 0.2, h); // side parting
      const edge = sstep(0, 0.4, t);
      const off = 0.0014 + edge * (0.0042 + 0.0078 * crown + sweep + quiff + part);
      const p = base.clone().addScaledVector(n, off);
      const c = mix(mix(C.hair, C.skinShadow, 0.45 * (1 - sstep(0, 0.12, t))), C.hairHi, 0.35 * crown * (0.5 + 0.5 * Math.cos(phi * 3)));
      return { p, c, w: [['Head', 1]] };
    },
    true,
  );
  return orient(part, awayFrom(v3(0, 1.25, -0.005)));
}

// ---------------------------------------------------------------------------------------------
// Torso & clothing
// ---------------------------------------------------------------------------------------------
const torsoProfile = profile(
  ['hw', 'DF', 'DB', 'n'] as const,
  [
    [0.45, 0.165, 0.105, 0.11, 2.6],
    [0.6, 0.155, 0.1, 0.105, 2.6],
    [0.72, 0.158, 0.106, 0.105, 2.6],
    [0.85, 0.172, 0.115, 0.11, 2.7],
    [0.93, 0.176, 0.112, 0.108, 2.8],
    [0.98, 0.178, 0.104, 0.1, 2.9],
    [1.01, 0.176, 0.09, 0.095, 3.0],
    [1.035, 0.163, 0.074, 0.085, 3.0],
    [1.055, 0.13, 0.066, 0.076, 2.6],
    [1.072, 0.096, 0.06, 0.068, 2.3],
    [1.085, 0.072, 0.057, 0.062, 2.1],
    [1.095, 0.064, 0.055, 0.06, 2.0],
  ],
);
const TORSO_TOP = 1.095;
function torsoFrontZ(x: number, y: number): number {
  const p = torsoProfile(y);
  const r = clamp(Math.abs(x) / p.hw, 0, 1);
  const s = r ** (p.n / 2);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  return p.DF * c ** (2 / p.n);
}
const vHalf = (y: number) => 0.004 + 0.064 * clamp((y - 0.8) / 0.27, 0, 1) ** 0.85;

function torsoWeights(x: number, y: number): Weights {
  const ax = Math.abs(x);
  const chest = sstep(0.74, 0.9, y);
  const spine = sstep(0.56, 0.68, y) * (1 - chest);
  const hips = 1 - spine - chest;
  const neck = sstep(1.08, 1.125, y) * 0.6;
  const sh = sstep(0.1, 0.16, ax) * sstep(0.96, 1.03, y) * 0.65;
  const shoulder: BoneName = x > 0 ? 'LeftShoulder' : 'RightShoulder';
  const rest = 1 - neck - sh;
  return [
    ['Hips', hips * rest],
    ['Spine', spine * rest],
    ['Chest', chest * rest],
    ['Neck', neck],
    [shoulder, sh],
  ];
}

function buildTorso(): Part {
  const rows = 44;
  const cols = 64;
  const part = lattice(
    rows,
    cols,
    (i, j) => {
      const y = lerp(0.55, TORSO_TOP, i / (rows - 1));
      const p = torsoProfile(y);
      const a = (j / cols) * Math.PI * 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      const x = p.hw * spow(s, 2 / p.n);
      const z = c >= 0 ? p.DF * Math.abs(c) ** (2 / p.n) : -p.DB * Math.abs(c) ** (2 / p.n);
      // subtle back-of-blazer seam darkening and lower fold shading
      const col = mix(C.blazer, C.button, 0.12 * (1 - sstep(0.5, 0.7, y)));
      return { p: v3(x, y, z), c: col, w: torsoWeights(x, y) };
    },
    true,
  );
  return orient(part, awayFromAxisY(0, 0));
}

function buildShirtFront(): Part {
  const rows = 26;
  const cols = 20;
  const part = lattice(rows, cols, (i, j) => {
    const y = lerp(0.77, TORSO_TOP + 0.002, i / (rows - 1));
    const u = -1 + (2 * j) / (cols - 1);
    const x = u * Math.min(vHalf(y) + 0.016, 0.82 * torsoProfile(y).hw);
    const z = torsoFrontZ(x, y) + 0.0012;
    const c = mix(C.shirt, C.shirtShade, 0.35 * Math.abs(u) + 0.25 * (1 - sstep(0.8, 0.95, y)));
    return { p: v3(x, y, z), c, w: torsoWeights(x, y) };
  });
  return orient(part, () => v3(0, 0, 1));
}

const lapelWidth = monotone(
  [0.785, 0.88, 0.955, 0.975, 0.99, 1.0, 1.03, 1.064],
  [0.016, 0.045, 0.058, 0.055, 0.034, 0.04, 0.04, 0.026],
);
function buildLapel(side: 1 | -1): Part {
  const rows = 34;
  const cols = 12;
  const part = lattice(rows, cols, (i, j) => {
    const y = lerp(0.785, 1.064, i / (rows - 1));
    const t = lerp(-0.12, 1.12, j / (cols - 1));
    const w = lapelWidth(y);
    const x = side * Math.min(vHalf(y) + clamp(t, 0, 1) * w, 0.86 * torsoProfile(y).hw);
    const raise = 0.0048 * sstep(-0.12, 0.08, t) * (1 - sstep(0.88, 1.12, t)) + 0.0008;
    const z = torsoFrontZ(x, y) + raise;
    const c = mix(C.lapel, C.blazer, sstep(0.7, 1.1, t) * 0.6);
    return { p: v3(x, y, z), c, w: torsoWeights(x, y) };
  });
  return orient(part, awayFromAxisY(0, -0.05));
}

const NECK_CZ = -0.009;
function buildShirtCollar(): Part[] {
  const yb = (phi: number) => 1.07 + 0.012 * (1 - Math.cos(phi)) * 0.5;
  // band
  const band = lattice(5, 48, (i, j) => {
    const phi = (j / 48) * Math.PI * 2;
    const y = yb(phi) + (i / 4) * 0.034;
    const r = 0.0605 - 0.0015 * (i / 4);
    const x = Math.sin(phi) * r;
    const z = NECK_CZ + Math.cos(phi) * r;
    return { p: v3(x, y, z), c: C.shirt.clone(), w: [['Neck', 0.6], ['Chest', 0.4]] };
  }, true);
  orient(band, awayFromAxisY(0, NECK_CZ));
  // turned-down leaves with collar points lying on the shirt front
  const leaf = (side: 1 | -1): Part => {
    const p = lattice(7, 22, (i, j) => {
      const phi = lerp(0.08, 0.8, j / 21);
      const v = i / 6;
      const leafH = 0.022 + 0.027 * gauss(phi, 0.42, 0.24);
      const yTop = yb(phi) + 0.034;
      const y = yTop - v * leafH;
      const r = 0.0615 + 0.011 * v ** 1.2;
      const x = side * Math.sin(phi) * r;
      let z = NECK_CZ + Math.cos(phi) * r;
      if (y < TORSO_TOP && Math.cos(phi) > 0) z = Math.max(z, torsoFrontZ(x, y) + 0.0045);
      const rim = Math.max(sstep(0.75, 1, v), 1 - sstep(0, 0.12, j / 21));
      const c = mix(C.shirt, C.shirtShade, 0.2 * v + 0.55 * rim);
      return { p: v3(x, y, z), c, w: [['Neck', 0.5 * (1 - v)], ['Chest', 0.5 + 0.5 * v]] };
    });
    return orient(p, awayFromAxisY(0, NECK_CZ - 0.01));
  };
  return [band, leaf(1), leaf(-1)];
}

function buildBlazerCollar(): Part {
  const part = lattice(6, 40, (i, j) => {
    const phi = lerp(1.25, Math.PI * 2 - 1.25, j / 39);
    const v = i / 5;
    const back = (1 - Math.cos(phi)) / 2; // 1 at back
    const yBot = 1.062 + 0.014 * back;
    const yTop = yBot + 0.03 + 0.016 * back;
    const y = lerp(yTop, yBot, v);
    const r = 0.068 + 0.013 * v;
    const x = Math.sin(phi) * r;
    let z = NECK_CZ + Math.cos(phi) * r - 0.004;
    // where the collar wraps forward it lies on the chest, over the shirt collar points
    if (Math.cos(phi) > 0 && y < TORSO_TOP) z = Math.max(z, torsoFrontZ(x, y) + 0.0065 * (1 - 0.5 * v));
    return { p: v3(x, y, z), c: mix(C.lapel, C.blazer, v), w: [['Neck', 0.35 * (1 - v)], ['Chest', 0.65 + 0.35 * v]] };
  });
  return orient(part, awayFromAxisY(0, NECK_CZ));
}

function buildTie(): Part[] {
  const blade = lattice(30, 11, (i, j) => {
    const y = lerp(0.745, 1.076, i / 29);
    const u = -1 + (2 * j) / 10;
    const hw = lerp(0.034, 0.0105, (y - 0.745) / 0.331);
    const x = u * hw;
    const z = torsoFrontZ(x, y) + 0.0042 + 0.0028 * (1 - u * u);
    const c = mix(C.tie, C.tieHi, 0.5 * (1 - Math.abs(u)) * (0.5 + 0.5 * Math.sin(y * 260 + u * 2)));
    return { p: v3(x, y, z), c, w: torsoWeights(x, y) };
  });
  orient(blade, () => v3(0, 0, 1));
  const kc = v3(0, 1.087, torsoFrontZ(0, 1.087) + 0.0075);
  const knot = superellipsoid({
    rows: 10,
    cols: 16,
    e1: 3.2,
    e2: 2.6,
    center: kc,
    place: (x, y, z) => {
      const taper = lerp(0.6, 1, (y + 1) / 2);
      return v3(x * 0.0145 * taper, y * 0.0145, z * 0.0072 - 0.002 * y).add(kc);
    },
    vert: (_p, _x, y) => ({ c: mix(C.tie, C.tieHi, 0.3 + 0.3 * y), w: [['Chest', 0.6], ['Neck', 0.4]] }),
  });
  return [blade, knot];
}

function buildButton(): Part {
  const bc = v3(0, 0.79, torsoFrontZ(0, 0.79) + 0.003);
  return superellipsoid({
    rows: 6,
    cols: 14,
    e1: 4,
    e2: 2,
    center: bc,
    place: (x, y, z) => v3(x * 0.0085, z * 0.0085, y * 0.0025).add(bc),
    vert: () => ({ c: C.button.clone(), w: [['Spine', 0.4], ['Chest', 0.6]] }),
  });
}

// ---------------------------------------------------------------------------------------------
// Arms & hands
// ---------------------------------------------------------------------------------------------
function armBones(side: 1 | -1) {
  const p = side > 0 ? 'Left' : 'Right';
  return {
    shoulder: `${p}Shoulder` as BoneName,
    upper: `${p}UpperArm` as BoneName,
    lower: `${p}LowerArm` as BoneName,
    hand: `${p}Hand` as BoneName,
  };
}
const handDir = (side: 1 | -1) => {
  const b = armBones(side);
  const d = bpos(b.hand).sub(bpos(b.lower));
  d.y = 0;
  d.normalize();
  // turn slightly further toward the centre and tilt down a touch
  d.applyAxisAngle(v3(0, 1, 0), -side * deg(6));
  d.y = -Math.tan(deg(5));
  return d.normalize();
};

function buildSleeve(side: 1 | -1): Part[] {
  const b = armBones(side);
  const S = bpos(b.upper);
  const E = bpos(b.lower);
  const W = bpos(b.hand);
  const fd = W.clone().sub(E).normalize();
  const sleeveEnd = W.clone().addScaledVector(fd, -0.012);
  const pts = [
    v3(side * 0.112, 1.036, -0.012),
    v3(side * 0.165, 1.041, -0.012),
    v3(side * 0.198, 1.0, -0.008),
    v3(side * 0.212, 0.9, 0.024),
    E.clone().add(v3(side * 0.004, 0.004, -0.012)),
    v3(side * 0.196, 0.779, 0.18),
    sleeveEnd,
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const len = curve.getLength();
  // arc-length positions of the joints
  const nearestS = (q: THREE.Vector3) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i <= 200; i++) {
      const d = curve.getPointAt(i / 200).distanceToSquared(q);
      if (d < bd) {
        bd = d;
        best = (i / 200) * len;
      }
    }
    return best;
  };
  const sS = nearestS(S);
  const sE = nearestS(E);
  const rProf = monotone(
    [0, 0.03, sS, sS + 0.05, sE - 0.03, sE + 0.03, len - 0.06, len - 0.008, len],
    [0.034, 0.046, 0.05, 0.05, 0.047, 0.045, 0.042, 0.041, 0.036],
  );
  const sleeve = tube({
    points: pts,
    segments: 46,
    radial: 22,
    up: v3(0, 0, 1),
    radius: (_u, s) => {
      const r = rProf(s);
      return [r, r * 0.96];
    },
    vert: (_u, s) => {
      const toUpper = sstep(0.0, sS + 0.02, s);
      const toLower = sstep(sE - 0.035, sE + 0.035, s);
      const w: Weights = [
        ['Chest', 0.35 * (1 - sstep(0, 0.04, s))],
        [b.shoulder, (1 - toUpper) * 0.9],
        [b.upper, toUpper * (1 - toLower)],
        [b.lower, toLower],
      ];
      const hem = sstep(len - 0.01, len, s);
      return { c: mix(C.blazer, C.button, 0.3 * hem), w };
    },
  });
  // shirt cuff
  const cuffPts = [W.clone().addScaledVector(fd, -0.032), W.clone().addScaledVector(fd, -0.012), W.clone().addScaledVector(fd, 0.003)];
  const cuff = tube({
    points: cuffPts,
    segments: 8,
    radial: 22,
    radius: (_u, s, l) => {
      const r = 0.0335 * (s > l - 0.004 ? lerp(1, 0.82, (s - (l - 0.004)) / 0.004) : 1);
      return [r, r * 0.92];
    },
    vert: (u) => ({ c: mix(C.shirt, C.shirtShade, 0.3), w: [[b.lower, 1 - 0.5 * u], [b.hand, 0.5 * u]] }),
  });
  return [sleeve, cuff];
}

function buildHand(side: 1 | -1): Part[] {
  const b = armBones(side);
  const W = bpos(b.hand);
  const f = handDir(side);
  const upWorld = v3(0, 1, 0);
  const s0 = new THREE.Vector3().crossVectors(f, upWorld).normalize();
  const u = new THREE.Vector3().crossVectors(s0, f).normalize();
  // thumb side points toward the body centre line
  const tS = s0.clone().multiplyScalar(Math.sign(-side * s0.x) || 1);
  const skinV = (w: Weights) => ({ c: C.skin.clone(), w });
  const parts: Part[] = [];

  // wrist
  parts.push(
    tube({
      points: [W.clone().addScaledVector(f, -0.034), W.clone().addScaledVector(f, -0.005), W.clone().addScaledVector(f, 0.024)],
      segments: 8,
      radial: 18,
      up: u,
      radius: (_uu, s, l) => {
        const k = capped(s, l, 0.006, 0.01, true, true);
        return [0.0185 * k, 0.026 * k];
      },
      vert: (uu) => skinV([[b.lower, 0.6 * (1 - uu)], [b.hand, 0.4 + 0.6 * uu]]),
    }),
  );

  // palm (superellipsoid in frame f/u/tS)
  const PC = W.clone().addScaledVector(f, 0.05).addScaledVector(u, -0.003);
  parts.push(
    superellipsoid({
      rows: 14,
      cols: 26,
      e1: 2.3,
      e2: 2.7,
      center: PC,
      place: (x, y, z) => {
        // local x along f, y along u, z along thumb side
        const along = (x + 1) / 2;
        const width = lerp(0.82, 1.0, sstep(0, 0.6, along));
        const dome = y > 0 ? 1 - 0.25 * Math.abs(z) : 1;
        return PC.clone()
          .addScaledVector(f, x * 0.05)
          .addScaledVector(u, y * 0.0135 * dome - 0.002 * x * x)
          .addScaledVector(tS, z * 0.043 * width);
      },
      vert: (_p, x) => skinV([[b.hand, 1], [b.lower, 0.15 * Math.max(0, -x)]]),
    }),
  );

  // fingers: [index, middle, ring, pinky] from the thumb side outward
  const fingers = [
    { off: 0.025, lens: [0.036, 0.022, 0.018], r: 0.0094, spread: 2 },
    { off: 0.0083, lens: [0.04, 0.024, 0.019], r: 0.0097, spread: 0 },
    { off: -0.0083, lens: [0.037, 0.023, 0.018], r: 0.0092, spread: -2 },
    { off: -0.0245, lens: [0.03, 0.019, 0.016], r: 0.0082, spread: -5 },
  ];
  const bends = [deg(-4), deg(10), deg(12)];
  let lowestTip = Infinity;
  for (const fg of fingers) {
    const knuckle = PC.clone().addScaledVector(f, 0.043).addScaledVector(tS, fg.off).addScaledVector(u, 0.0005);
    let dir = f.clone().applyAxisAngle(u, deg(fg.spread) * (tS.dot(s0) > 0 ? 1 : -1));
    const side3 = new THREE.Vector3().crossVectors(dir, u).normalize();
    const pts = [knuckle.clone().addScaledVector(dir, -0.014), knuckle.clone()];
    let cur = knuckle.clone();
    fg.lens.forEach((L, k) => {
      dir = dir.clone().applyAxisAngle(side3, -bends[k]!);
      cur = cur.clone().addScaledVector(dir, L);
      pts.push(cur.clone());
    });
    lowestTip = Math.min(lowestTip, cur.y - fg.r * 0.8);
    parts.push(
      tube({
        points: pts,
        segments: 14,
        radial: 10,
        up: u,
        radius: (uu, s, l) => {
          const k = capped(s, l, 0.004, fg.r * 0.85, false, true);
          const r = fg.r * lerp(1, 0.86, uu) * k;
          return [r * 0.92, r];
        },
        vert: (uu) => ({ c: mix(C.skin, C.skinBlush, 0.25 * sstep(0.7, 1, uu)), w: [[b.hand, 1]] }),
      }),
    );
  }

  // thumb
  {
    const base = PC.clone().addScaledVector(f, -0.008).addScaledVector(tS, 0.033).addScaledVector(u, -0.006);
    let dir = f.clone().applyAxisAngle(u, deg(26) * (tS.dot(s0) > 0 ? 1 : -1));
    dir.addScaledVector(u, -0.07).normalize();
    const pts = [base.clone().addScaledVector(dir, -0.01), base.clone()];
    let cur = base.clone();
    const lens = [0.032, 0.029, 0.024];
    lens.forEach((L, k) => {
      dir = dir.clone().applyAxisAngle(u, deg(k === 0 ? -6 : -14) * (tS.dot(s0) > 0 ? 1 : -1));
      cur = cur.clone().addScaledVector(dir, L);
      pts.push(cur.clone());
    });
    lowestTip = Math.min(lowestTip, cur.y - 0.009);
    parts.push(
      tube({
        points: pts,
        segments: 12,
        radial: 10,
        up: u,
        radius: (uu, s, l) => {
          const k = capped(s, l, 0.004, 0.009, false, true);
          const r = lerp(0.0125, 0.0095, uu) * k;
          return [r * 0.9, r];
        },
        vert: (uu) => ({ c: mix(C.skin, C.skinBlush, 0.2 * sstep(0.7, 1, uu)), w: [[b.hand, 1]] }),
      }),
    );
  }
  console.log(`  ${side > 0 ? 'left' : 'right'} hand lowest point y=${lowestTip.toFixed(4)} (desk ${DESK_Y})`);
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------------------------
type Euler3 = [number, number, number];
interface Pose {
  rot: Partial<Record<BoneName, Euler3>>;
  pre?: Partial<Record<BoneName, THREE.Quaternion>>;
  chestScale: Vec;
  morph: Record<MorphName, number>;
}
const TAU = Math.PI * 2;
/** Smooth 0..1..0 pulse inside [a, b] (zero outside), so clips loop cleanly. */
const pulse = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);
/** Smooth plateau: rises over [a, a+r], holds, falls over [b-r, b]. */
const plateau = (t: number, a: number, b: number, r: number) => sstep(a, a + r, t) * (1 - sstep(b - r, b, t));

function makeClip(name: string, duration: number, fps: number, sample: (t: number) => Pose): THREE.AnimationClip {
  const n = Math.round(duration * fps);
  const times: number[] = [];
  const quats: Record<string, number[]> = {};
  const scales: Record<string, number[]> = {};
  const morphs: Record<string, number[]> = {};
  const scaleBones: BoneName[] = ['Chest', 'Neck', 'LeftShoulder', 'RightShoulder'];
  for (const bn of BONE_NAMES) quats[bn] = [];
  for (const bn of scaleBones) scales[bn] = [];
  for (const mn of MORPH_NAMES) morphs[mn] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    times.push(t);
    const pose = sample(t);
    for (const bn of BONE_NAMES) {
      const r = pose.rot[bn] ?? [0, 0, 0];
      e.set(r[0], r[1], r[2], 'YXZ');
      q.setFromEuler(e);
      const pre = pose.pre?.[bn];
      if (pre) q.premultiply(pre);
      quats[bn]!.push(q.x, q.y, q.z, q.w);
    }
    const [sx, sy, sz] = pose.chestScale;
    scales.Chest!.push(sx, sy, sz);
    for (const bn of ['Neck', 'LeftShoulder', 'RightShoulder'] as const) scales[bn]!.push(1 / sx, 1 / sy, 1 / sz);
    for (const mn of MORPH_NAMES) morphs[mn]!.push(clamp(pose.morph[mn], 0, 1));
  }
  const tracks: THREE.KeyframeTrack[] = [];
  for (const bn of BONE_NAMES) tracks.push(new THREE.QuaternionKeyframeTrack(`${bn}.quaternion`, times, quats[bn]!));
  for (const bn of scaleBones) tracks.push(new THREE.VectorKeyframeTrack(`${bn}.scale`, times, scales[bn]!));
  for (const mn of MORPH_NAMES) tracks.push(new THREE.NumberKeyframeTrack(`HeadMesh.morphTargetInfluences[${mn}]`, times, morphs[mn]!));
  return new THREE.AnimationClip(name, duration, tracks);
}

/** Breathing shared by every clip; `k` cycles per clip. */
function breath(t: number, L: number, k: number) {
  const b = Math.sin((TAU * k * t) / L);
  const s = 0.5 + 0.5 * b;
  return { b, chestScale: [1 + 0.004 * s, 1 + 0.003 * s, 1 + 0.012 * s] as Vec };
}

/** Two-bone IK for the right arm so the hand rests near the chin in Think. */
function thinkArmPose(): Partial<Record<BoneName, THREE.Quaternion>> {
  const side = -1 as const;
  const b = armBones(side);
  const S = bpos(b.upper);
  const E0 = bpos(b.lower);
  const W0 = bpos(b.hand);
  const l1 = E0.distanceTo(S);
  const l2 = W0.distanceTo(E0);
  // hand orientation: fingers up toward the chin, back of the hand toward the camera
  const f1 = v3(0.28, 0.93, -0.22).normalize();
  const u1 = v3(0, 0.22, 1).sub(f1.clone().multiplyScalar(v3(0, 0.22, 1).dot(f1))).normalize();
  const knuckles = v3(-0.028, 1.108, 0.168);
  const T = knuckles.clone().addScaledVector(f1, -0.09);
  const d = Math.min(T.distanceTo(S), l1 + l2 - 1e-3);
  const a = T.clone().sub(S).normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const pole = v3(-0.45, -1, 0.35);
  const pp = pole.sub(a.clone().multiplyScalar(pole.dot(a))).normalize();
  const sinA = Math.sqrt(1 - cosA * cosA);
  const E1 = S.clone().addScaledVector(a, l1 * cosA).addScaledVector(pp, l1 * sinA);
  const qU = new THREE.Quaternion().setFromUnitVectors(E0.clone().sub(S).normalize(), E1.clone().sub(S).normalize());
  const fRest = W0.clone().sub(E0).applyQuaternion(qU).normalize();
  const qLw = new THREE.Quaternion().setFromUnitVectors(fRest, T.clone().sub(E1).normalize());
  const qL = qU.clone().invert().multiply(qLw).multiply(qU);
  // hand: rest frame -> desired frame
  const f0 = handDir(side);
  const s0 = new THREE.Vector3().crossVectors(f0, v3(0, 1, 0)).normalize();
  const u0 = new THREE.Vector3().crossVectors(s0, f0).normalize();
  const s1 = new THREE.Vector3().crossVectors(f1, u1).normalize();
  const M0 = new THREE.Matrix4().makeBasis(f0, u0, s0);
  const M1 = new THREE.Matrix4().makeBasis(f1, u1, s1);
  const Rh = new THREE.Quaternion().setFromRotationMatrix(M1.multiply(M0.transpose()));
  const qH = qLw.clone().multiply(qU).invert().multiply(Rh);
  console.log(`  think pose: elbow ${E1.toArray().map((x) => x.toFixed(3)).join(', ')}, wrist ${T.toArray().map((x) => x.toFixed(3)).join(', ')}`);
  return { [b.upper]: qU, [b.lower]: qL, [b.hand]: qH };
}

function buildClips(): THREE.AnimationClip[] {
  const morph0 = (): Record<MorphName, number> => ({ blink: 0, mouthOpen: 0, smile: 0, browRaise: 0 });

  const idle = makeClip('Idle', 6, 12, (t) => {
    const L = 6;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    return {
      chestScale,
      rot: {
        Spine: [0.004 * b, 0.012 * w(1, 1), 0.007 * w(1, 0)],
        Chest: [-0.01 * b, 0.006 * w(1, 2), 0],
        Neck: [0.006 * b, 0, 0],
        Head: [0.016 * w(1, 2) - 0.006 * b, 0.022 * w(1, 0.5), 0.011 * w(1, 2.4)],
        LeftShoulder: [0, 0, 0.012 * (0.5 + 0.5 * b)],
        RightShoulder: [0, 0, -0.012 * (0.5 + 0.5 * b)],
        LeftUpperArm: [0, 0, -0.01 * (0.5 + 0.5 * b)],
        RightUpperArm: [0, 0, 0.01 * (0.5 + 0.5 * b)],
        LeftHand: [0.01 * w(1, 1.3), 0, 0],
        RightHand: [0.01 * w(1, 2.1), 0, 0],
      },
      morph: { ...morph0(), smile: 0.1 },
    };
  });

  const talk = makeClip('Talk', 4.8, 12, (t) => {
    const L = 4.8;
    const { b, chestScale } = breath(t, L, 1);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    const nod = 0.045 * pulse(t, 0.3, 1.0) + 0.035 * pulse(t, 1.6, 2.2) + 0.05 * pulse(t, 2.9, 3.6) + 0.03 * pulse(t, 4.0, 4.6);
    const gR = pulse(t, 0.5, 2.3);
    const gL = pulse(t, 2.5, 4.3);
    return {
      chestScale,
      rot: {
        Spine: [0.03 + 0.008 * w(1, 0), 0.02 * w(1, 0.4), 0.006 * w(1, 1)],
        Chest: [-0.008 * b, 0.015 * (gL - gR), 0],
        Neck: [0.01, 0, 0],
        Head: [nod - 0.01, 0.045 * w(1, 0.2), 0.022 * w(1, 1.1)],
        LeftShoulder: [0, 0, 0.01 * gL],
        RightShoulder: [0, 0, -0.01 * gR],
        RightUpperArm: [-0.08 * gR, 0.05 * gR, 0.04 * gR],
        RightLowerArm: [-0.26 * gR, 0.12 * gR, 0],
        RightHand: [0.18 * gR, -0.1 * gR, -0.45 * gR],
        LeftUpperArm: [-0.06 * gL, -0.04 * gL, -0.03 * gL],
        LeftLowerArm: [-0.2 * gL, -0.1 * gL, 0],
        LeftHand: [0.15 * gL, 0.08 * gL, 0.35 * gL],
      },
      morph: { ...morph0(), smile: 0.12, browRaise: 0.4 * pulse(t, 0.25, 1.3) + 0.3 * pulse(t, 2.8, 3.7) },
    };
  });

  const listen = makeClip('Listen', 7, 12, (t) => {
    const L = 7;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    const nod = 0.06 * Math.sin(Math.PI * clamp((t - 2.0) / 0.9, 0, 1)) + 0.045 * Math.sin(Math.PI * clamp((t - 5.0) / 0.8, 0, 1));
    return {
      chestScale,
      rot: {
        Spine: [0.035 + 0.004 * b, 0.008 * w(1, 0), 0.006 * w(1, 1.5)],
        Chest: [-0.01 * b, 0, 0],
        Neck: [0.012, 0, 0],
        Head: [0.025 + nod, -0.03 + 0.015 * w(1, 0.7), 0.07 + 0.012 * w(1, 2)],
        LeftShoulder: [0, 0, 0.01 * (0.5 + 0.5 * b)],
        RightShoulder: [0, 0, -0.01 * (0.5 + 0.5 * b)],
        LeftHand: [0.012 * w(1, 0.3), 0, 0],
        RightHand: [0.012 * w(1, 1.9), 0, 0],
      },
      morph: { ...morph0(), smile: 0.22 + 0.06 * w(1, 0), browRaise: 0.12 + 0.25 * pulse(t, 1.8, 3.1) + 0.2 * pulse(t, 4.8, 5.9) },
    };
  });

  const armPose = thinkArmPose();
  const think = makeClip('Think', 8, 12, (t) => {
    const L = 8;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    const up = plateau(t, 0.3, 3.8, 0.7); // glance up-left
    const aside = plateau(t, 4.4, 7.7, 0.7); // glance aside
    const drift = 0.015 * w(1, 0.4);
    return {
      chestScale,
      pre: armPose,
      rot: {
        Spine: [-0.015 + 0.004 * b, -0.03, 0.005 * w(1, 0)],
        Chest: [-0.01 * b, -0.02, 0],
        Neck: [0.01, 0, 0],
        Head: [0.02 - 0.12 * up - 0.03 * aside + drift, 0.17 * up - 0.13 * aside, 0.05 + 0.02 * up],
        RightLowerArm: [0.02 * w(1, 0.8), 0, 0],
        RightHand: [0.03 * w(1, 2.2), 0, 0],
        LeftShoulder: [0, 0, 0.01 * (0.5 + 0.5 * b)],
        LeftHand: [0.01 * w(1, 0.5), 0, 0],
      },
      morph: { ...morph0(), browRaise: 0.1 + 0.4 * up + 0.15 * aside, smile: 0.04 },
    };
  });

  const clips = [idle, talk, listen, think];
  for (const c of clips) if (!CLIP_NAMES.includes(c.name as (typeof CLIP_NAMES)[number])) throw new Error(`unexpected clip ${c.name}`);
  return clips;
}

// ---------------------------------------------------------------------------------------------
// Assemble & export
// ---------------------------------------------------------------------------------------------
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(process.argv[2] ?? resolve(here, '../../api/assets/interviewer.glb'));

  console.log('Building interviewer…');
  const root = new THREE.Group();
  root.name = 'Interviewer';

  // skeleton
  const bones = new Map<BoneName, THREE.Bone>();
  for (const name of BONE_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bones.set(name, bone);
  }
  for (const name of BONE_NAMES) {
    const def = BONES[name];
    const bone = bones.get(name)!;
    const world = v3(...def.pos);
    if (def.parent) {
      bone.position.copy(world.sub(v3(...BONES[def.parent].pos)));
      bones.get(def.parent)!.add(bone);
    } else {
      bone.position.copy(world);
      root.add(bone);
    }
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(BONE_NAMES.map((n) => bones.get(n)!));

  const fabric = new THREE.MeshStandardMaterial({ name: 'Fabric', vertexColors: true, roughness: 0.84, metalness: 0 });
  const skin = new THREE.MeshStandardMaterial({ name: 'Skin', vertexColors: true, roughness: 0.52, metalness: 0 });
  const hairMat = new THREE.MeshStandardMaterial({ name: 'Hair', vertexColors: true, roughness: 0.62, metalness: 0 });
  const eyeMat = new THREE.MeshStandardMaterial({ name: 'Eye', vertexColors: true, roughness: 0.12, metalness: 0 });

  const addSkinned = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const mesh = new THREE.SkinnedMesh(geo, mat);
    mesh.name = name;
    root.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  };

  console.log('  body');
  const bodyParts: Part[] = [
    buildTorso(),
    buildShirtFront(),
    buildLapel(1),
    buildLapel(-1),
    buildBlazerCollar(),
    ...buildShirtCollar(),
    ...buildTie(),
    buildButton(),
    ...buildSleeve(1),
    ...buildSleeve(-1),
  ];
  addSkinned('Body', buildGeometry(bodyParts, { skinned: true }), fabric);

  console.log('  head');
  const headParts: Part[] = [
    buildHeadLattice(),
    ...buildLids(1),
    ...buildLids(-1),
    buildBrow(1),
    buildBrow(-1),
    ...buildLips(),
    buildTeeth(),
    buildEar(1),
    buildEar(-1),
  ];
  scaleParts(headParts, bpos('Head'), HEAD_SCALE);
  const headMesh = addSkinned('HeadMesh', buildGeometry(headParts, { skinned: true, morphs: MORPH_NAMES }), skin);
  headMesh.updateMorphTargets();
  console.log(`  eye centre z=${EYE_Z.toFixed(4)} (socket surface ${eyeSurfaceZ.toFixed(4)})`);

  console.log('  hands');
  addSkinned('Hands', buildGeometry([...buildHand(1), ...buildHand(-1)], { skinned: true }), skin);

  console.log('  hair');
  addSkinned('Hair', buildGeometry(scaleParts([buildHair()], bpos('Head'), HEAD_SCALE), { skinned: true }), hairMat);

  // eyes parented to the Head bone
  const eyeGeo = buildEyeGeometry().scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE);
  const headBone = bones.get('Head')!;
  EYE_MESH_NAMES.forEach((name, k) => {
    const side = k === 0 ? 1 : -1;
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.name = name;
    eye.position.copy(eyeCenter(side as 1 | -1).sub(bpos('Head')).multiplyScalar(HEAD_SCALE));
    headBone.add(eye);
  });

  console.log('  clips');
  const clips = buildClips();

  root.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true, animations: clips, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('expected binary glTF output');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(result));

  let tris = 0;
  let verts = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      verts += m.geometry.attributes.position!.count;
      console.log(`    ${m.name}: ${m.geometry.attributes.position!.count} verts`);
      tris += (m.geometry.index?.count ?? 0) / 3;
    }
  });
  console.log(`Wrote ${out}`);
  console.log(`  ${(result.byteLength / 1024).toFixed(1)} KiB, ${verts} vertices, ${tris} triangles, ${clips.length} clips`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
