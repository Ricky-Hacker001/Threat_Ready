/**
 * Builds the interviewer GLB from Renderpeople's free scanned character "Eric Rigged 001"
 * (photogrammetry scan, Extended Use Licence; see ASSET_LICENSE.md). Source files are not
 * committed. Download the free rigged FBX pack from https://renderpeople.com/free-3d-people/,
 * unzip `rp_eric_rigged_001_FBX.zip`, then:
 *
 *   RENDERPEOPLE_DIR=/path/to/eric npx tsx scripts/build-avatar-renderpeople.ts [out.glb]
 *
 * Eric's face is rigged with bones (eyelids, jaw, mouth corners, brows) rather than blendshapes,
 * so those bones are posed and skinned here to bake the contract's morph targets (blink,
 * mouthOpen, smile, browRaise). The scan is split by texture masks into skin, clothing and eyes so
 * the runtime can shade each properly. The licence requires that the model is not made easily
 * downloadable: the output is served by the API to signed-in users only, never from `public/`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  applyPose,
  assemble,
  bakeBoneMorph,
  buildClips,
  deg,
  DESK_Y,
  downscale,
  exportGlb,
  extractGeometry,
  flipGreen,
  loadFbx,
  map,
  normalizeRig,
  Poser,
  qAxis,
  readJpeg,
  setMorphs,
  standardMaterial,
  toJpeg,
  triangles,
  v3,
  type ArmNames,
  type WorldRot,
} from './avatar-lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.RENDERPEOPLE_DIR;
const FBX = SRC && join(SRC, 'rp_eric_rigged_001_yup_a.fbx');
if (!FBX || !existsSync(FBX)) throw new Error('Set RENDERPEOPLE_DIR to the unzipped rp_eric_rigged_001_FBX folder (see ASSET_LICENSE.md)');
const OUT = resolve(process.argv[2] ?? resolve(here, '../../api/assets/interviewer.glb'));
const TEX = (n: string) => join(SRC!, 'tex', `rp_eric_rigged_001_${n}.jpg`);
const CM = 0.01;

// ---------------------------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------------------------
const RENAME: Record<string, string> = {
  hip: 'Hips',
  spine_01: 'Spine',
  spine_02: 'Spine1',
  spine_03: 'Chest',
  neck: 'Neck',
  head: 'Head',
  jaw: 'Jaw',
  eye_l: 'LeftEye',
  eye_r: 'RightEye',
  eyelid_l: 'LeftEyelid',
  eyelid_r: 'RightEyelid',
  eyebrow_l: 'LeftEyebrow',
  eyebrow_r: 'RightEyebrow',
  mouth_l: 'LeftMouthCorner',
  mouth_r: 'RightMouthCorner',
  shoulder_l: 'LeftShoulder',
  upperarm_l: 'LeftUpperArm',
  lowerarm_l: 'LeftLowerArm',
  hand_l: 'LeftHand',
  shoulder_r: 'RightShoulder',
  upperarm_r: 'RightUpperArm',
  lowerarm_r: 'RightLowerArm',
  hand_r: 'RightHand',
  upperleg_l: 'LeftUpperLeg',
  lowerleg_l: 'LeftLowerLeg',
  foot_l: 'LeftFoot',
  upperleg_r: 'RightUpperLeg',
  lowerleg_r: 'RightLowerLeg',
  foot_r: 'RightFoot',
};
const { mesh: src } = loadFbx(FBX);
const rig = normalizeRig(src, (n) => RENAME[n] ?? n, CM);
{
  const head = rig.restWorld('Head');
  const eyeL = rig.restWorld('LeftEye');
  if (!(eyeL.z > head.z + 0.03 && eyeL.x > 0)) throw new Error('expected the character to face +Z with its left at +X');
}

const arm = (s: 'l' | 'r', S: 'Left' | 'Right'): ArmNames => ({
  shoulder: `${S}Shoulder`,
  upper: `${S}UpperArm`,
  lower: `${S}LowerArm`,
  hand: `${S}Hand`,
  middle: `middle_01_${s}`,
  index: `index_01_${s}`,
  pinky: `pinky_01_${s}`,
  fingers: ['index', 'middle', 'ring', 'pinky'].map((f) => [1, 2, 3].map((k) => `${f}_0${k}_${s}`)),
  thumb: [1, 2, 3].map((k) => `thumb_0${k}_${s}`),
});
const ARMS = { Left: arm('l', 'Left'), Right: arm('r', 'Right') } as const;

// ---------------------------------------------------------------------------------------------
// Textures (decoded once; also used to split the scan into skin and clothing)
// ---------------------------------------------------------------------------------------------
console.log('decoding 8K textures…');
const dif = readJpeg(TEX('dif'));
const mask1 = downscale(readJpeg(TEX('mask01')), 1024);
const mask2 = downscale(readJpeg(TEX('mask02')), 1024);
const difSmall = downscale(dif, 1024);

/** Skin where neither clothing mask is set and the colour is skin-like. */
function isSkinAt(u: number, v: number): boolean {
  const x = Math.min(1023, Math.max(0, Math.floor(u * 1024)));
  const y = Math.min(1023, Math.max(0, Math.floor((1 - v) * 1024)));
  const i = (y * 1024 + x) * 4;
  if (mask1.rgba[i]! > 100 || mask2.rgba[i]! > 100) return false;
  const r = difSmall.rgba[i]!;
  const g = difSmall.rgba[i + 1]!;
  const b = difSmall.rgba[i + 2]!;
  return r > 70 && r > g && r - b > 20;
}

// ---------------------------------------------------------------------------------------------
// Mesh split: eyes (driven by the eye bones), skin, clothing
// ---------------------------------------------------------------------------------------------
const sg = src.geometry;
const SI = sg.attributes.skinIndex!;
const SW = sg.attributes.skinWeight!;
const UV = sg.attributes.uv!;
const eyeBones = new Set(['LeftEye', 'RightEye'].map((n) => rig.bones.indexOf(rig.bone(n))));
const onEye = (i: number) => [0, 1, 2, 3].some((c) => eyeBones.has(SI.getComponent(i, c)) && SW.getComponent(i, c) > 0.5);
const isEyeTri = (i: number) => onEye(i) && onEye(i + 1) && onEye(i + 2);
const isSkinTri = (i: number) => {
  const u = (UV.getX(i) + UV.getX(i + 1) + UV.getX(i + 2)) / 3;
  const v = (UV.getY(i) + UV.getY(i + 1) + UV.getY(i + 2)) / 3;
  return isSkinAt(u, v);
};
const eyeVerts = triangles(src, isEyeTri);
const skinVerts = triangles(src, (i) => !isEyeTri(i) && isSkinTri(i));
const clothVerts = triangles(src, (i) => !isEyeTri(i) && !isSkinTri(i));

const { scene, add } = assemble(rig);
const skinGeo = extractGeometry(src, skinVerts, CM);
const clothGeo = extractGeometry(src, clothVerts, CM);
const eyeGeo = extractGeometry(src, eyeVerts, CM);

// Face expressions baked from the face bones (rotations about world axes at each bone).
const rotLocal = (n: string, q: THREE.Quaternion) => rig.bone(n).quaternion.premultiply(q);
const nudge = (n: string, d: THREE.Vector3) => rig.bone(n).position.add(d);
setMorphs(skinGeo, {
  blink: bakeBoneMorph(rig, skinGeo, () => {
    rotLocal('LeftEyelid', qAxis(1, 0, 0, deg(Number(process.env.BLINK_DEG ?? 34))));
    rotLocal('RightEyelid', qAxis(1, 0, 0, deg(Number(process.env.BLINK_DEG ?? 34))));
  }),
  mouthOpen: bakeBoneMorph(rig, skinGeo, () => rotLocal('Jaw', qAxis(1, 0, 0, deg(14)))),
  smile: bakeBoneMorph(rig, skinGeo, () => {
    nudge('LeftMouthCorner', v3(0.0025, 0.002, -0.0015));
    nudge('RightMouthCorner', v3(-0.0025, 0.002, -0.0015));
  }),
  browRaise: bakeBoneMorph(rig, skinGeo, () => {
    nudge('LeftEyebrow', v3(0, 0.005, 0.001));
    nudge('RightEyebrow', v3(0, 0.005, 0.001));
  }),
});

add('ClothesMesh', clothGeo, standardMaterial('Clothes'));
const skinMesh = add('SkinMesh', skinGeo, standardMaterial('Skin'));
add('EyeMesh', eyeGeo, standardMaterial('Eye', { roughness: 0.05 }));
console.log(`meshes: skin ${skinGeo.attributes.position!.count} v, clothes ${clothGeo.attributes.position!.count} v, eyes ${eyeGeo.attributes.position!.count} v`);

// ---------------------------------------------------------------------------------------------
// Seated pose and clips
// ---------------------------------------------------------------------------------------------
const seatDrop = rig.restWorld('Hips').y - 0.555;
const poser = new Poser(rig, seatDrop);
const LEAN = deg(4);
const seatedWorld: WorldRot = new Map();
seatedWorld.set('Spine', qAxis(1, 0, 0, LEAN));
seatedWorld.set('Chest', qAxis(1, 0, 0, LEAN * 1.6));
seatedWorld.set('Neck', qAxis(1, 0, 0, LEAN * 0.6));
seatedWorld.set('Head', qAxis(1, 0, 0, deg(-1)));
for (const s of ['Left', 'Right'] as const) {
  const side = s === 'Left' ? 1 : -1;
  seatedWorld.set(`${s}UpperLeg`, qAxis(1, 0, 0, deg(-86)).multiply(qAxis(0, 1, 0, side * deg(4))));
  seatedWorld.set(`${s}LowerLeg`, qAxis(1, 0, 0, deg(-4)));
  seatedWorld.set(`${s}Foot`, new THREE.Quaternion());
}
for (const s of ['Left', 'Right'] as const) {
  const side = s === 'Left' ? 1 : -1;
  const a = ARMS[s];
  seatedWorld.set(a.shoulder, qAxis(0, 0, 1, -side * deg(4)).multiply(qAxis(0, 1, 0, -side * deg(6))));
  const wrist = v3(side * 0.165, DESK_Y + 0.06, 0.37);
  const { elbow } = poser.solveArm(seatedWorld, a, wrist, v3(side * 0.6, -0.55, -0.6));
  poser.restHand(seatedWorld, a, side, v3(-side * 0.38, -0.12, 0.9), deg(40));
  console.log(`  ${s} arm: elbow ${elbow.toArray().map((x) => x.toFixed(3)).join(', ')}`);
}
const curls = (r: number, l: number) => new Map([...poser.fingerCurl(ARMS.Left, 1, l), ...poser.fingerCurl(ARMS.Right, -1, r)]);
const seatedLocal = poser.toLocal(seatedWorld, curls(0.7, 0.7));

const thinkWorld: WorldRot = new Map(seatedWorld);
{
  const jaw = poser.posedWorldPos(seatedWorld, 'Jaw');
  const chin = jaw.clone().add(v3(-0.005, -0.06, 0.085));
  const f1 = v3(0.25, 0.93, -0.2).normalize();
  const wrist = chin.clone().add(v3(-0.02, -0.035, 0.03)).addScaledVector(f1, -0.085);
  poser.solveArm(thinkWorld, ARMS.Right, wrist, v3(-0.45, -1, 0.35));
  poser.aimHand(thinkWorld, ARMS.Right, -1, f1, v3(0, 0.2, 1));
}
const thinkLocal = poser.toLocal(thinkWorld, curls(1.6, 0.7));
const hipsParent = rig.parentName('Hips');
const hips = rig.restWorld('Hips').sub(v3(0, seatDrop, 0)).sub(hipsParent ? rig.restWorld(hipsParent) : new THREE.Vector3());
const clips = buildClips({
  poser,
  seated: { local: seatedLocal, world: seatedWorld },
  think: { local: thinkLocal, world: thinkWorld },
  hips,
  faceMesh: 'SkinMesh',
  restingBlink: 0.08,
});
applyPose(rig, hips, seatedLocal);
void skinMesh;

// ---------------------------------------------------------------------------------------------
// Textures and export
// ---------------------------------------------------------------------------------------------
console.log('encoding textures…');
const color = { data: toJpeg(downscale(dif, 4096), 86), mime: 'image/jpeg' };
const normalRaw = downscale(readJpeg(TEX('norm')), 2048);
const normal = { data: toJpeg(process.env.NORMAL_FLIP_G ? flipGreen(normalRaw) : normalRaw, 90), mime: 'image/jpeg' };
const gloss = downscale(readJpeg(TEX('gloss')), 1024);
const rough = {
  data: toJpeg(
    map(gloss, (px, i) => {
      const r = 1 - (px[i]! / 255) * 0.85;
      px[i] = 0;
      px[i + 1] = Math.round(Math.min(0.95, Math.max(0.45, r)) * 255);
      px[i + 2] = 0;
    }),
    88,
  ),
  mime: 'image/jpeg',
};
for (const [k, t] of Object.entries({ color, normal, rough })) console.log(`  texture ${k}: ${(t.data.byteLength / 1024).toFixed(0)} KB`);

const out = await exportGlb(
  scene,
  clips,
  {
    Skin: { baseColor: color, normal, roughness: rough },
    Clothes: { baseColor: color, normal, roughness: rough },
    Eye: { baseColor: color },
  },
  {
    generator: 'ThreatReady build-avatar-renderpeople (Renderpeople Eric Rigged 001)',
    extras: { source: 'Renderpeople rp_eric_rigged_001', license: 'Renderpeople Extended Use Licence; not for redistribution or extraction' },
  },
);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${(out.byteLength / 1024 / 1024).toFixed(2)} MB)`);
