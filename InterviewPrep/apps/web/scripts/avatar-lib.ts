/**
 * Shared machinery for the interviewer-avatar converters (`build-avatar-*.ts`): skeleton
 * normalisation, geometry extraction, seated-pose solving, the animation clips, texture encoding
 * and GLB export. A converter supplies the source-specific parts (bone names, mesh split, face
 * shapes, textures) and gets a GLB that satisfies `src/features/interview-prep/avatar/avatarContract.ts`.
 */
import { NodeIO, type Document } from '@gltf-transform/core';
import jpeg from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export const deg = (d: number) => (d * Math.PI) / 180;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const qAxis = (x: number, y: number, z: number, a: number) => new THREE.Quaternion().setFromAxisAngle(v3(x, y, z).normalize(), a);

/** The scene desk top (m); forearms rest on it. */
export const DESK_Y = 0.72;

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------
/** Loads an FBX without decoding textures (converters encode their own) and returns its skinned mesh. */
export function loadFbx(file: string): { root: THREE.Group; mesh: THREE.SkinnedMesh } {
  const manager = new THREE.LoadingManager();
  class StubTextureLoader extends THREE.Loader {
    override load(url: string): THREE.Texture {
      const t = new THREE.Texture();
      t.userData.url = url;
      return t;
    }
  }
  manager.addHandler(/\.(tga|png|jpe?g|dds|tiff?)$/i, new StubTextureLoader());
  const buf = readFileSync(file);
  const root = new FBXLoader(manager).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), file.replace(/[^/]+$/, ''));
  root.updateMatrixWorld(true);
  let mesh: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error(`${file}: no skinned mesh`);
  return { root, mesh };
}

// ---------------------------------------------------------------------------------------------
// Rig: bind-pose positions in metres, world-aligned bone axes, contract names
// ---------------------------------------------------------------------------------------------
export interface Rig {
  bones: THREE.Bone[];
  root: THREE.Bone;
  skeleton: THREE.Skeleton;
  bone(name: string): THREE.Bone;
  has(name: string): boolean;
  /** Bind-pose world position (m). */
  restWorld(name: string): THREE.Vector3;
  parentName(name: string): string | null;
}

/**
 * Rebuilds the source skeleton with identity rest rotations (bone axes = world axes) and the bind
 * pose as rest. Poses and clips can then be authored as rotations about world axes, whatever the
 * source rig's local frames are.
 */
export function normalizeRig(src: THREE.SkinnedMesh, nameOf: (sourceName: string) => string, scale: number): Rig {
  const srcBones = src.skeleton.bones;
  const bindPos = srcBones.map((_, i) => new THREE.Vector3().setFromMatrixPosition(src.skeleton.boneInverses[i]!.clone().invert()).multiplyScalar(scale));
  const bones = srcBones.map((b) => {
    const nb = new THREE.Bone();
    nb.name = nameOf(b.name);
    return nb;
  });
  const indexOf = new Map(srcBones.map((b, i) => [b, i]));
  let root: THREE.Bone | undefined;
  srcBones.forEach((b, i) => {
    const pi = b.parent ? indexOf.get(b.parent as THREE.Bone) : undefined;
    if (pi === undefined) {
      if (root) throw new Error('skeleton has more than one root');
      root = bones[i]!;
      bones[i]!.position.copy(bindPos[i]!);
    } else {
      bones[pi]!.add(bones[i]!);
      bones[i]!.position.copy(bindPos[i]!).sub(bindPos[pi]!);
    }
  });
  const byName = new Map(bones.map((b) => [b.name, b]));
  if (byName.size !== bones.length) throw new Error('duplicate bone names after renaming');
  const bone = (n: string) => {
    const b = byName.get(n);
    if (!b) throw new Error(`missing bone ${n}`);
    return b;
  };
  return {
    bones,
    root: root!,
    skeleton: new THREE.Skeleton(bones),
    bone,
    has: (n) => byName.has(n),
    restWorld: (n) => bindPos[bones.indexOf(bone(n))]!.clone(),
    parentName: (n) => ((bone(n).parent as THREE.Bone)?.isBone ? bone(n).parent!.name : null),
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------
export interface MorphInput {
  name: string;
  /** Delta for source vertex `i`, in source geometry space (before the bind matrix and scale). */
  delta(i: number, out: THREE.Vector3): THREE.Vector3;
}

/**
 * Copies the given source vertices (non-indexed triangles) into a new geometry in metres, with
 * glTF-style UVs, the 4 strongest skin weights and optional morph targets, then merges duplicates.
 */
export function extractGeometry(src: THREE.SkinnedMesh, vertices: ArrayLike<number>, scale: number, morphs: MorphInput[] = []): THREE.BufferGeometry {
  const sg = src.geometry;
  const bindM = src.bindMatrix;
  const nrmM = new THREE.Matrix3().getNormalMatrix(bindM);
  const dirM = new THREE.Matrix3().setFromMatrix4(bindM);
  const n = vertices.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const morphOut = morphs.map(() => new Float32Array(n * 3));
  const P = sg.attributes.position!;
  const N = sg.attributes.normal!;
  const UV = sg.attributes.uv!;
  const SI = sg.attributes.skinIndex!;
  const SW = sg.attributes.skinWeight!;
  const tmp = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const i = vertices[k]!;
    tmp.fromBufferAttribute(P, i).applyMatrix4(bindM).multiplyScalar(scale);
    pos.set([tmp.x, tmp.y, tmp.z], k * 3);
    tmp.fromBufferAttribute(N, i).applyMatrix3(nrmM).normalize();
    nrm.set([tmp.x, tmp.y, tmp.z], k * 3);
    // FBX UVs have their origin at the bottom left; glTF images are top-down.
    uv.set([UV.getX(i), 1 - UV.getY(i)], k * 2);
    const inf = [0, 1, 2, 3].map((c) => [SI.getComponent(i, c), SW.getComponent(i, c)] as const);
    const tot = inf.reduce((a, [, w]) => a + w, 0) || 1;
    inf.forEach(([b, w], c) => {
      si[k * 4 + c] = b;
      sw[k * 4 + c] = w / tot;
    });
    morphs.forEach((m, mi) => {
      m.delta(i, tmp).applyMatrix3(dirM).multiplyScalar(scale);
      morphOut[mi]!.set([tmp.x, tmp.y, tmp.z], k * 3);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (morphs.length) {
    geo.morphAttributes.position = morphOut.map((m) => new THREE.BufferAttribute(m, 3));
    geo.morphTargetsRelative = true;
  }
  const merged = mergeVertices(geo, 1e-5);
  // mergeVertices rebuilds the morph attributes without their names
  merged.morphAttributes.position?.forEach((a, i) => (a.name = morphs[i]!.name));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** All vertex indices of a non-indexed source geometry for which `keep(triangleFirstVertex)` holds. */
export function triangles(src: THREE.SkinnedMesh, keep: (firstVertex: number) => boolean, range?: { start: number; count: number }[]): number[] {
  const out: number[] = [];
  const ranges = range ?? [{ start: 0, count: src.geometry.attributes.position!.count }];
  for (const r of ranges) for (let i = r.start; i < r.start + r.count; i += 3) if (keep(i)) out.push(i, i + 1, i + 2);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------------------------------
export function standardMaterial(name: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, ...opts });
  m.name = name;
  return m;
}

export function assemble(rig: Rig) {
  const scene = new THREE.Scene();
  const avatar = new THREE.Group();
  avatar.name = 'Interviewer';
  scene.add(avatar);
  avatar.add(rig.root);
  avatar.updateMatrixWorld(true);
  rig.skeleton.calculateInverses();
  const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.SkinnedMesh => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    if (geo.morphAttributes.position) m.updateMorphTargets();
    m.bind(rig.skeleton, new THREE.Matrix4());
    avatar.add(m);
    return m;
  };
  return { scene, avatar, add };
}

/**
 * Bakes a bone-driven expression into a morph target: poses the bones with `pose`, skins every
 * vertex on the CPU and returns the delta from rest (in the geometry's space). Lets a model whose
 * face is rigged with bones (eyelids, jaw) satisfy the morph-based contract.
 */
export function bakeBoneMorph(rig: Rig, geo: THREE.BufferGeometry, pose: () => void): Float32Array {
  const P = geo.attributes.position!;
  const SI = geo.attributes.skinIndex!;
  const SW = geo.attributes.skinWeight!;
  const saved = rig.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
  rig.root.updateMatrixWorld(true);
  pose();
  rig.root.updateMatrixWorld(true);
  const skinM = rig.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, rig.skeleton.boneInverses[i]!));
  const out = new Float32Array(P.count * 3);
  const v = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    acc.set(0, 0, 0);
    for (let c = 0; c < 4; c++) {
      const w = SW.getComponent(i, c);
      if (w) acc.addScaledVector(t.copy(v).applyMatrix4(skinM[SI.getComponent(i, c)]!), w);
    }
    out.set([acc.x - v.x, acc.y - v.y, acc.z - v.z], i * 3);
  }
  rig.bones.forEach((b, i) => {
    b.position.copy(saved[i]!.p);
    b.quaternion.copy(saved[i]!.q);
  });
  rig.root.updateMatrixWorld(true);
  return out;
}

/** Adds named morph targets (relative deltas) to a geometry built without them. */
export function setMorphs(geo: THREE.BufferGeometry, morphs: Record<string, Float32Array>) {
  geo.morphAttributes.position = Object.entries(morphs).map(([name, d]) => {
    const a = new THREE.BufferAttribute(d, 3);
    a.name = name;
    return a;
  });
  geo.morphTargetsRelative = true;
}

// ---------------------------------------------------------------------------------------------
// Seated pose
// ---------------------------------------------------------------------------------------------
export type WorldRot = Map<string, THREE.Quaternion>;

export interface ArmNames {
  shoulder: string;
  upper: string;
  lower: string;
  hand: string;
  /** Bone at the base of the middle finger: gives the hand's rest direction. */
  middle: string;
  /** Finger chains (base to tip, excluding end bones) and the thumb chain. */
  fingers: string[][];
  thumb: string[];
  /** Bases of the index and little fingers: give the hand's rest across-direction. */
  index: string;
  pinky: string;
}

export class Poser {
  constructor(
    readonly rig: Rig,
    readonly seatDrop: number,
  ) {}

  worldOf(w: WorldRot, n: string): THREE.Quaternion {
    if (w.has(n)) return w.get(n)!;
    const p = this.rig.parentName(n);
    return p ? this.worldOf(w, p) : new THREE.Quaternion();
  }

  /** Seated world position of a bone, given the world rotations solved so far. */
  posedWorldPos(w: WorldRot, n: string): THREE.Vector3 {
    const p = this.rig.parentName(n);
    if (!p) return this.rig.restWorld(n).sub(v3(0, this.seatDrop, 0));
    const offset = this.rig.restWorld(n).sub(this.rig.restWorld(p)).applyQuaternion(this.worldOf(w, p));
    return this.posedWorldPos(w, p).add(offset);
  }

  /** Two-bone IK: world rotations for the upper and lower arm so the wrist reaches `target`. */
  solveArm(w: WorldRot, a: ArmNames, target: THREE.Vector3, pole: THREE.Vector3) {
    const r = this.rig;
    const S = this.posedWorldPos(w, a.upper);
    const l1 = r.restWorld(a.lower).distanceTo(r.restWorld(a.upper));
    const l2 = r.restWorld(a.hand).distanceTo(r.restWorld(a.lower));
    const d = Math.min(target.distanceTo(S), l1 + l2 - 1e-3);
    const dir = target.clone().sub(S).normalize();
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const pp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const E = S.clone().addScaledVector(dir, l1 * cosA).addScaledVector(pp, l1 * Math.sqrt(1 - cosA * cosA));
    const T = S.clone().addScaledVector(dir, d);
    // keep the shoulder's rotation underneath: the upper arm's world rotation includes it
    const parentQ = this.worldOf(w, r.parentName(a.upper)!);
    const restU = r.restWorld(a.lower).sub(r.restWorld(a.upper)).normalize().applyQuaternion(parentQ);
    const qU = new THREE.Quaternion().setFromUnitVectors(restU, E.clone().sub(S).normalize()).multiply(parentQ);
    const restL = r.restWorld(a.hand).sub(r.restWorld(a.lower)).normalize().applyQuaternion(qU);
    const qL = new THREE.Quaternion().setFromUnitVectors(restL, T.clone().sub(E).normalize()).multiply(qU);
    w.set(a.upper, qU);
    w.set(a.lower, qL);
    return { elbow: E, wrist: T };
  }

  /** Rest direction of the fingers and rest back-of-hand normal (both world). */
  handFrame(a: ArmNames, side: 1 | -1) {
    const r = this.rig;
    const f = r.restWorld(a.middle).sub(r.restWorld(a.hand)).normalize();
    const across = r.restWorld(a.index).sub(r.restWorld(a.pinky)).normalize();
    const back = new THREE.Vector3().crossVectors(across, f).multiplyScalar(side).normalize();
    return { f, back };
  }

  /**
   * Hand world rotation: continue the forearm with the smallest rotation (so the cuff does not
   * wring), aim the fingers at `fwd`, then roll part-way so the back of the hand faces up.
   */
  restHand(w: WorldRot, a: ArmNames, side: 1 | -1, fwd: THREE.Vector3, roll: number) {
    const { f } = this.handFrame(a, side);
    const qL = this.worldOf(w, a.lower);
    const along = f.clone().applyQuaternion(qL);
    const qH = new THREE.Quaternion().setFromUnitVectors(along, fwd.clone().normalize()).multiply(qL);
    const rolled = (x: number) => qAxis(fwd.x, fwd.y, fwd.z, x).multiply(qH.clone());
    const { back } = this.handFrame(a, side);
    const upness = (q: THREE.Quaternion) => back.clone().applyQuaternion(q).y;
    w.set(a.hand, upness(rolled(roll)) > upness(rolled(-roll)) ? rolled(roll) : rolled(-roll));
  }

  /** Aims a hand with an explicit frame: fingers along `fwd`, back of the hand toward `up`. */
  aimHand(w: WorldRot, a: ArmNames, side: 1 | -1, fwd: THREE.Vector3, up: THREE.Vector3) {
    const { f, back } = this.handFrame(a, side);
    const s0 = new THREE.Vector3().crossVectors(f, back);
    const f1 = fwd.clone().normalize();
    const u1 = up.clone().sub(f1.clone().multiplyScalar(up.dot(f1))).normalize();
    const s1 = new THREE.Vector3().crossVectors(f1, u1);
    const M0 = new THREE.Matrix4().makeBasis(f, back.clone().sub(f.clone().multiplyScalar(back.dot(f))).normalize(), s0.normalize());
    const M1 = new THREE.Matrix4().makeBasis(f1, u1, s1);
    w.set(a.hand, new THREE.Quaternion().setFromRotationMatrix(M1.multiply(M0.transpose())));
  }

  /** Relaxed finger curl as local rotations toward the palm. */
  fingerCurl(a: ArmNames, side: 1 | -1, amount: number): Map<string, THREE.Quaternion> {
    const out = new Map<string, THREE.Quaternion>();
    const r = this.rig;
    const { back } = this.handFrame(a, side);
    const angles = [18, 26, 16];
    a.fingers.forEach((chain, fi) => {
      chain.forEach((bn, j) => {
        const child = r.bone(bn).children.find((c) => (c as THREE.Bone).isBone);
        if (!child) return;
        const fdir = r.restWorld(child.name).sub(r.restWorld(bn)).normalize();
        const axis = new THREE.Vector3().crossVectors(back, fdir).normalize();
        out.set(bn, qAxis(axis.x, axis.y, axis.z, deg(angles[j] ?? 12) * amount * (0.85 + fi * 0.08)));
      });
    });
    a.thumb.slice(1).forEach((bn) => {
      const child = r.bone(bn).children.find((c) => (c as THREE.Bone).isBone);
      if (!child) return;
      const fdir = r.restWorld(child.name).sub(r.restWorld(bn)).normalize();
      const axis = new THREE.Vector3().crossVectors(back, fdir).normalize();
      out.set(bn, qAxis(axis.x, axis.y, axis.z, deg(10) * amount));
    });
    return out;
  }

  /** World rotations to local quaternions (plus local extras such as finger curls). */
  toLocal(w: WorldRot, extraLocal: Map<string, THREE.Quaternion>): Map<string, THREE.Quaternion> {
    const out = new Map<string, THREE.Quaternion>();
    for (const b of this.rig.bones) {
      const p = this.rig.parentName(b.name);
      const pw = p ? this.worldOf(w, p) : new THREE.Quaternion();
      const q = pw.clone().invert().multiply(this.worldOf(w, b.name));
      const extra = extraLocal.get(b.name);
      if (extra) q.multiply(extra);
      if (q.angleTo(new THREE.Quaternion()) > 1e-6) out.set(b.name, q);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Clips: keyframes = seated local rotation * offset about world axes
// ---------------------------------------------------------------------------------------------
const CLIP_BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand'];
export const FACE_MORPHS = ['blink', 'mouthOpen', 'smile', 'browRaise'] as const;
type Euler3 = [number, number, number];
export interface PoseSet {
  local: Map<string, THREE.Quaternion>;
  world: WorldRot;
}
interface Sample {
  rot: Partial<Record<string, Euler3>>;
  set: PoseSet;
  chestScale: [number, number, number];
  morph: Record<(typeof FACE_MORPHS)[number], number>;
}
const TAU = Math.PI * 2;
const pulse = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);
const plateau = (t: number, a: number, b: number, r: number) => sstep(a, a + r, t) * (1 - sstep(b - r, b, t));

export function buildClips(args: {
  poser: Poser;
  seated: PoseSet;
  think: PoseSet;
  /** Hips position (local to its parent) in the seated pose. */
  hips: THREE.Vector3;
  /** Name of the mesh carrying the face morphs. */
  faceMesh: string;
  /** Resting lid closure (0..1): wide-open lids read as staring. */
  restingBlink: number;
}): THREE.AnimationClip[] {
  const { poser, seated, think } = args;
  const keyed = [...new Set([...CLIP_BONES, ...seated.local.keys(), ...think.local.keys()])];
  const scaleBones = ['Chest', 'Neck', 'LeftShoulder', 'RightShoulder'];
  const morph0 = () => ({ blink: args.restingBlink, mouthOpen: 0, smile: 0, browRaise: 0 });

  function makeClip(name: string, duration: number, fps: number, sample: (t: number) => Sample): THREE.AnimationClip {
    const n = Math.round(duration * fps);
    const times: number[] = [];
    const quats: Record<string, number[]> = Object.fromEntries(keyed.map((b) => [b, []]));
    const scales: Record<string, number[]> = Object.fromEntries(scaleBones.map((b) => [b, []]));
    const morphs: Record<string, number[]> = Object.fromEntries(FACE_MORPHS.map((m) => [m, []]));
    const hipsPos: number[] = [];
    const e = new THREE.Euler();
    const off = new THREE.Quaternion();
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * duration;
      times.push(t);
      const s = sample(t);
      for (const bn of keyed) {
        const q = (s.set.local.get(bn) ?? new THREE.Quaternion()).clone();
        const r = s.rot[bn];
        if (r) {
          // offset about world axes at the bone: local * W^-1 * E * W
          const W = poser.worldOf(s.set.world, bn);
          e.set(r[0], r[1], r[2], 'YXZ');
          off.setFromEuler(e);
          q.multiply(W.clone().invert().multiply(off).multiply(W));
        }
        quats[bn]!.push(q.x, q.y, q.z, q.w);
      }
      hipsPos.push(args.hips.x, args.hips.y, args.hips.z);
      const [sx, sy, sz] = s.chestScale;
      scales.Chest!.push(sx, sy, sz);
      for (const bn of ['Neck', 'LeftShoulder', 'RightShoulder']) scales[bn]!.push(1 / sx, 1 / sy, 1 / sz);
      for (const mn of FACE_MORPHS) morphs[mn]!.push(clamp(s.morph[mn], 0, 1));
    }
    const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack('Hips.position', times, hipsPos)];
    for (const bn of keyed) tracks.push(new THREE.QuaternionKeyframeTrack(`${bn}.quaternion`, times, quats[bn]!));
    for (const bn of scaleBones) tracks.push(new THREE.VectorKeyframeTrack(`${bn}.scale`, times, scales[bn]!));
    for (const mn of FACE_MORPHS) tracks.push(new THREE.NumberKeyframeTrack(`${args.faceMesh}.morphTargetInfluences[${mn}]`, times, morphs[mn]!));
    return new THREE.AnimationClip(name, duration, tracks);
  }

  const breath = (t: number, L: number, k: number) => {
    const b = Math.sin((TAU * k * t) / L);
    const s = 0.5 + 0.5 * b;
    return { b, chestScale: [1 + 0.004 * s, 1 + 0.003 * s, 1 + 0.012 * s] as [number, number, number] };
  };

  const idle = makeClip('Idle', 6, 12, (t) => {
    const L = 6;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    return {
      set: seated,
      chestScale,
      rot: {
        Spine: [0.004 * b, 0.012 * w(1, 1), 0.007 * w(1, 0)],
        Chest: [-0.01 * b, 0.006 * w(1, 2), 0],
        Neck: [0.006 * b, 0, 0],
        Head: [0.016 * w(1, 2) - 0.006 * b, 0.022 * w(1, 0.5), 0.011 * w(1, 2.4)],
        LeftShoulder: [0, 0, 0.012 * (0.5 + 0.5 * b)],
        RightShoulder: [0, 0, -0.012 * (0.5 + 0.5 * b)],
        LeftHand: [0.01 * w(1, 1.3), 0, 0],
        RightHand: [0.01 * w(1, 2.1), 0, 0],
      },
      morph: { ...morph0(), smile: 0.12 },
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
      set: seated,
      chestScale,
      rot: {
        Spine: [0.03 + 0.008 * w(1, 0), 0.02 * w(1, 0.4), 0.006 * w(1, 1)],
        Chest: [-0.008 * b, 0.015 * (gL - gR), 0],
        Neck: [0.01, 0, 0],
        Head: [nod - 0.01, 0.045 * w(1, 0.2), 0.022 * w(1, 1.1)],
        LeftShoulder: [0, 0, 0.01 * gL],
        RightShoulder: [0, 0, -0.01 * gR],
        // forearms lift off the desk for a small open-hand gesture
        RightLowerArm: [-0.22 * gR, 0.1 * gR, 0],
        RightHand: [0.12 * gR, -0.1 * gR, -0.5 * gR],
        LeftLowerArm: [-0.18 * gL, -0.08 * gL, 0],
        LeftHand: [0.1 * gL, 0.08 * gL, 0.4 * gL],
      },
      morph: { ...morph0(), smile: 0.14, browRaise: 0.4 * pulse(t, 0.25, 1.3) + 0.3 * pulse(t, 2.8, 3.7) },
    };
  });

  const listen = makeClip('Listen', 7, 12, (t) => {
    const L = 7;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    const nod = 0.06 * Math.sin(Math.PI * clamp((t - 2.0) / 0.9, 0, 1)) + 0.045 * Math.sin(Math.PI * clamp((t - 5.0) / 0.8, 0, 1));
    return {
      set: seated,
      chestScale,
      rot: {
        Spine: [0.035 + 0.004 * b, 0.008 * w(1, 0), 0.006 * w(1, 1.5)],
        Chest: [-0.01 * b, 0, 0],
        Neck: [0.012, 0, 0],
        Head: [0.025 + nod, -0.03 + 0.015 * w(1, 0.7), 0.06 + 0.012 * w(1, 2)],
        LeftShoulder: [0, 0, 0.01 * (0.5 + 0.5 * b)],
        RightShoulder: [0, 0, -0.01 * (0.5 + 0.5 * b)],
        LeftHand: [0.012 * w(1, 0.3), 0, 0],
        RightHand: [0.012 * w(1, 1.9), 0, 0],
      },
      morph: { ...morph0(), smile: 0.22 + 0.06 * w(1, 0), browRaise: 0.12 + 0.25 * pulse(t, 1.8, 3.1) + 0.2 * pulse(t, 4.8, 5.9) },
    };
  });

  const thinking = makeClip('Think', 8, 12, (t) => {
    const L = 8;
    const { b, chestScale } = breath(t, L, 2);
    const w = (k: number, ph: number) => Math.sin((TAU * k * t) / L + ph);
    const up = plateau(t, 0.3, 3.8, 0.7);
    const aside = plateau(t, 4.4, 7.7, 0.7);
    const drift = 0.015 * w(1, 0.4);
    return {
      set: think,
      chestScale,
      rot: {
        Spine: [-0.015 + 0.004 * b, -0.03, 0.005 * w(1, 0)],
        Chest: [-0.01 * b, -0.02, 0],
        Neck: [0.01, 0, 0],
        Head: [0.02 - 0.12 * up - 0.03 * aside + drift, 0.17 * up - 0.13 * aside, 0.05 + 0.02 * up],
        RightHand: [0.03 * w(1, 2.2), 0, 0],
        LeftShoulder: [0, 0, 0.01 * (0.5 + 0.5 * b)],
        LeftHand: [0.01 * w(1, 0.5), 0, 0],
      },
      morph: { ...morph0(), browRaise: 0.1 + 0.4 * up + 0.15 * aside, smile: 0.04 },
    };
  });

  return [idle, talk, listen, thinking];
}

/** Applies the seated pose to the bones, so the exported rest pose sits even without animation. */
export function applyPose(rig: Rig, hips: THREE.Vector3, local: Map<string, THREE.Quaternion>) {
  rig.bone('Hips').position.copy(hips);
  for (const [n, q] of local) rig.bone(n).quaternion.copy(q);
  rig.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------
export interface Raster {
  w: number;
  h: number;
  rgba: Uint8Array;
}
export function readJpeg(file: string): Raster {
  const img = jpeg.decode(readFileSync(file), { maxMemoryUsageInMB: 4096, useTArray: true });
  return { w: img.width, h: img.height, rgba: img.data };
}
/** Box-filter downscale by an integer factor. */
export function downscale(r: Raster, size: number): Raster {
  const f = r.w / size;
  if (f <= 1) return r;
  if (!Number.isInteger(f)) throw new Error(`downscale ${r.w} -> ${size} is not an integer factor`);
  const out = new Uint8Array(size * size * 4);
  const ff = f * f;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = (y * f + dy) * r.w;
          for (let dx = 0; dx < f; dx++) s += r.rgba[(row + x * f + dx) * 4 + c]!;
        }
        out[(y * size + x) * 4 + c] = Math.round(s / ff);
      }
  return { w: size, h: size, rgba: out };
}
export function map(r: Raster, fn: (px: Uint8Array, i: number) => void): Raster {
  const out = new Uint8Array(r.rgba);
  for (let i = 0; i < out.length; i += 4) fn(out, i);
  return { w: r.w, h: r.h, rgba: out };
}
export const toJpeg = (r: Raster, q: number) => new Uint8Array(jpeg.encode({ width: r.w, height: r.h, data: Buffer.from(r.rgba) }, q).data);
export function toPng(r: Raster): Uint8Array {
  const png = new PNG({ width: r.w, height: r.h });
  png.data = Buffer.from(r.rgba);
  return new Uint8Array(PNG.sync.write(png, { colorType: 6 }));
}
/** Source normal maps in the DirectX convention (green = down) to glTF (green = up). */
export const flipGreen = (r: Raster) => map(r, (px, i) => (px[i + 1] = 255 - px[i + 1]!));

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------
export interface TextureSet {
  baseColor?: { data: Uint8Array; mime: string };
  normal?: { data: Uint8Array; mime: string };
  /** glTF metallicRoughness (roughness in G). */
  roughness?: { data: Uint8Array; mime: string };
}

/**
 * Exports the scene and clips with GLTFExporter, then attaches the encoded textures by material
 * name (identical images are shared), stores morph targets sparsely and records provenance.
 */
export async function exportGlb(
  scene: THREE.Scene,
  clips: THREE.AnimationClip[],
  textures: Record<string, TextureSet>,
  provenance: { generator: string; extras: Record<string, string> },
): Promise<Uint8Array> {
  const glb = (await new GLTFExporter().parseAsync(scene, { binary: true, animations: clips, onlyVisible: false })) as ArrayBuffer;
  const io = new NodeIO();
  const doc: Document = await io.readBinary(new Uint8Array(glb));
  const root = doc.getRoot();
  const cache = new Map<Uint8Array, ReturnType<Document['createTexture']>>();
  const tex = (name: string, t: { data: Uint8Array; mime: string }) => {
    let made = cache.get(t.data);
    if (!made) {
      made = doc.createTexture(name).setImage(t.data).setMimeType(t.mime);
      cache.set(t.data, made);
    }
    return made;
  };
  for (const m of root.listMaterials()) {
    const set = textures[m.getName()];
    if (!set) continue;
    if (set.baseColor) m.setBaseColorTexture(tex(`${m.getName()}_color`, set.baseColor));
    if (set.normal) m.setNormalTexture(tex(`${m.getName()}_normal`, set.normal));
    if (set.roughness) m.setMetallicRoughnessTexture(tex(`${m.getName()}_roughness`, set.roughness)).setRoughnessFactor(1).setMetallicFactor(0);
  }
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) for (const target of prim.listTargets()) for (const a of target.listAttributes()) a.setSparse(true);
  root.getAsset().generator = provenance.generator;
  root.getAsset().extras = provenance.extras;
  return io.writeBinary(doc);
}
