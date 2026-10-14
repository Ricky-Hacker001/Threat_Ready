/**
 * Builds the interviewer GLB from a Microsoft Rocketbox avatar (MIT licence,
 * https://github.com/microsoft/Microsoft-Rocketbox): an alternative to the default Renderpeople
 * scan that is less photoreal but carries 15 visemes for lip sync. Source files are not committed;
 * download them first (see ASSET_LICENSE.md), then:
 *
 *   ROCKETBOX_DIR=/path/to/Business_Male_01 npx tsx scripts/build-avatar-rocketbox.ts [out.glb]
 *
 * The directory must hold `Business_Male_01_facial.fbx` (the variant with blendshapes) and its
 * `Textures/*.tga`. The mesh is split into BodyMesh, HeadMesh (the only one with morph targets)
 * and an alpha DetailMesh (lashes, brows, hair edges); only the morphs the runtime uses are kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  applyPose,
  assemble,
  buildClips,
  clamp,
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
  standardMaterial,
  toJpeg,
  toPng,
  triangles,
  v3,
  type ArmNames,
  type MorphInput,
  type Raster,
  type WorldRot,
} from './avatar-lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.ROCKETBOX_DIR;
if (!SRC || !existsSync(join(SRC, 'Business_Male_01_facial.fbx'))) {
  throw new Error('Set ROCKETBOX_DIR to the folder holding Business_Male_01_facial.fbx and Textures/ (see ASSET_LICENSE.md)');
}
const OUT = resolve(process.argv[2] ?? resolve(here, '../../api/assets/interviewer.glb'));
const CM = 0.01;

// ---------------------------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------------------------
const RENAME: Record<string, string> = {
  Bip01_Pelvis: 'Hips',
  Bip01_Spine: 'Spine',
  Bip01_Spine1: 'Spine1',
  Bip01_Spine2: 'Chest',
  Bip01_Neck: 'Neck',
  Bip01_Head: 'Head',
  Bip01_LEye: 'LeftEye',
  Bip01_REye: 'RightEye',
  Bip01_MJaw: 'Jaw',
  Bip01_L_Clavicle: 'LeftShoulder',
  Bip01_L_UpperArm: 'LeftUpperArm',
  Bip01_L_Forearm: 'LeftLowerArm',
  Bip01_L_Hand: 'LeftHand',
  Bip01_R_Clavicle: 'RightShoulder',
  Bip01_R_UpperArm: 'RightUpperArm',
  Bip01_R_Forearm: 'RightLowerArm',
  Bip01_R_Hand: 'RightHand',
  Bip01_L_Thigh: 'LeftUpperLeg',
  Bip01_L_Calf: 'LeftLowerLeg',
  Bip01_L_Foot: 'LeftFoot',
  Bip01_R_Thigh: 'RightUpperLeg',
  Bip01_R_Calf: 'RightLowerLeg',
  Bip01_R_Foot: 'RightFoot',
};
const { mesh: src } = loadFbx(join(SRC, 'Business_Male_01_facial.fbx'));
const rig = normalizeRig(src, (n) => RENAME[n] ?? n.replace(/^Bip01_/, '').replace(/^Bip01$/, 'Root'), CM);

const arm = (p: 'L' | 'R', S: 'Left' | 'Right'): ArmNames => ({
  shoulder: `${S}Shoulder`,
  upper: `${S}UpperArm`,
  lower: `${S}LowerArm`,
  hand: `${S}Hand`,
  middle: `${p}_Finger2`,
  index: `${p}_Finger1`,
  pinky: `${p}_Finger4`,
  fingers: [1, 2, 3, 4].map((f) => [`${p}_Finger${f}`, `${p}_Finger${f}1`, `${p}_Finger${f}2`]),
  thumb: [`${p}_Finger0`, `${p}_Finger01`, `${p}_Finger02`],
});
const ARMS = { Left: arm('L', 'Left'), Right: arm('R', 'Right') } as const;

// ---------------------------------------------------------------------------------------------
// Meshes: only the head carries morphs (the 20 the runtime uses, of 175)
// ---------------------------------------------------------------------------------------------
const VISEME_SOURCES = ['Sil', 'PP', 'FF', 'TH', 'DD', 'KK', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'];
const MORPH_KEEP: Record<string, [string, number][]> = {
  blink: [['AK_09_EyeBlinkLeft', 1], ['AK_10_EyeBlinkRight', 1]],
  mouthOpen: [['AK_25_JawOpen', 1]],
  smile: [['MouthSmileLeft', 1], ['MouthSmileRight', 1]],
  browRaise: [['AK_03_BrowInnerUp', 1], ['AK_04_BrowOuterUpLeft', 0.6], ['AK_05_BrowOuterUpRight', 0.6]],
  squint: [['AK_19_EyeSquintLeft', 1], ['AK_20_EyeSquintRight', 1]],
  ...Object.fromEntries(
    VISEME_SOURCES.map((v, i) => [`viseme_${v === 'Sil' ? 'sil' : v === 'KK' ? 'kk' : v}`, [[`AA_VI_${String(i).padStart(2, '0')}_${v}`, 1]]]),
  ),
};
const srcMorphNames = Object.keys(src.morphTargetDictionary!);
const morphAttr = (needle: string) => {
  const i = srcMorphNames.findIndex((n) => n.includes(needle) && /\.AK_|\.AA_/.test(n));
  if (i < 0) throw new Error(`morph ${needle} not found`);
  return src.geometry.morphAttributes.position![i]!;
};
const morphs: MorphInput[] = Object.entries(MORPH_KEEP).map(([name, parts]) => {
  const attrs = parts.map(([needle, w]) => [morphAttr(needle), w] as const);
  return {
    name,
    delta: (i, out) => {
      out.set(0, 0, 0);
      for (const [a, w] of attrs) out.set(out.x + a.getX(i) * w, out.y + a.getY(i) * w, out.z + a.getZ(i) * w);
      return out;
    },
  };
});

const mats = src.material as THREE.Material[];
const groups = (re: RegExp) => src.geometry.groups.filter((gr) => re.test(mats[gr.materialIndex!]!.name)).map((gr) => ({ start: gr.start, count: gr.count }));
const all = () => true;
const bodyGeo = extractGeometry(src, triangles(src, all, groups(/body/i)), CM);
const headGeo = extractGeometry(src, triangles(src, all, groups(/head/i)), CM, morphs);
const alphaGeo = extractGeometry(src, triangles(src, all, groups(/opacity/i)), CM);

const { scene, add } = assemble(rig);
add('BodyMesh', bodyGeo, standardMaterial('Suit'));
const headMesh = add('HeadMesh', headGeo, standardMaterial('Skin'));
add('DetailMesh', alphaGeo, standardMaterial('Hair', { alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.75 }));
// relaxed lower lids by default (not animated by the clips; the runtime leaves it alone)
headMesh.morphTargetInfluences![headMesh.morphTargetDictionary!.squint!] = 0.22;
console.log(`meshes: body ${bodyGeo.attributes.position!.count} v, head ${headGeo.attributes.position!.count} v (${morphs.length} morphs), detail ${alphaGeo.attributes.position!.count} v`);

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
  seatedWorld.set(a.shoulder, qAxis(0, 0, 1, -side * deg(6)).multiply(qAxis(0, 1, 0, -side * deg(8))));
  poser.solveArm(seatedWorld, a, v3(side * 0.165, DESK_Y + 0.062, 0.37), v3(side * 0.6, -0.55, -0.6));
  poser.restHand(seatedWorld, a, side, v3(-side * 0.38, -0.12, 0.9), deg(40));
}
const curls = (r: number, l: number) => new Map([...poser.fingerCurl(ARMS.Left, 1, l), ...poser.fingerCurl(ARMS.Right, -1, r)]);
const seatedLocal = poser.toLocal(seatedWorld, curls(0.7, 0.7));

const thinkWorld: WorldRot = new Map(seatedWorld);
{
  const chin = poser.posedWorldPos(seatedWorld, 'Jaw').add(v3(-0.005, -0.055, 0.075));
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
  faceMesh: 'HeadMesh',
  restingBlink: 0.1,
});
applyPose(rig, hips, seatedLocal);

// ---------------------------------------------------------------------------------------------
// Textures (TGA sources)
// ---------------------------------------------------------------------------------------------
function readTga(file: string): Raster {
  const b = readFileSync(file);
  const idLen = b[0]!;
  const type = b[2]!;
  const w = b.readUInt16LE(12);
  const h = b.readUInt16LE(14);
  const bpp = b[16]! / 8;
  const topDown = (b[17]! & 0x20) !== 0;
  if (type !== 2 || (bpp !== 3 && bpp !== 4)) throw new Error(`${file}: unsupported TGA type ${type}/${bpp * 8}`);
  const rgba = new Uint8Array(w * h * 4);
  let o = 18 + idLen;
  for (let y = 0; y < h; y++) {
    const row = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++, o += bpp) {
      const d = (row * w + x) * 4;
      rgba[d] = b[o + 2]!;
      rgba[d + 1] = b[o + 1]!;
      rgba[d + 2] = b[o]!;
      rgba[d + 3] = bpp === 4 ? b[o + 3]! : 255;
    }
  }
  return { w, h, rgba };
}
const tex = (n: string) => readTga(join(SRC, 'Textures', n));
/** glTF metallicRoughness: roughness in G from the specular map (bright specular = smoother). */
const roughnessFromSpecular = (r: Raster, lo: number, hi: number) =>
  map(r, (px, i) => {
    const spec = (px[i]! + px[i + 1]! + px[i + 2]!) / (3 * 255);
    px[i] = 0;
    px[i + 1] = Math.round((hi - (hi - lo) * clamp(spec * 1.6, 0, 1)) * 255);
    px[i + 2] = 0;
    px[i + 3] = 255;
  });
/** Clears colour under fully transparent pixels and drops the lowest colour bits so PNG compresses well. */
const packAlpha = (r: Raster) =>
  map(r, (px, i) => {
    if (px[i + 3]! < 6) px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
    else for (let c = 0; c < 3; c++) px[i + c] = px[i + c]! & 0xf8;
  });
/** Wet eyes: near-zero roughness over the eyeballs' UV island (vertices driven by the eye bones). */
function glossEyes(r: Raster, rough: number): Raster {
  const si = headGeo.attributes.skinIndex!;
  const sw = headGeo.attributes.skinWeight!;
  const uv = headGeo.attributes.uv!;
  const out = { ...r, rgba: new Uint8Array(r.rgba) };
  for (const name of ['LeftEye', 'RightEye']) {
    const bi = rig.bones.indexOf(rig.bone(name));
    const b = new THREE.Box2();
    for (let v = 0; v < si.count; v++) for (let c = 0; c < 4; c++) if (si.getComponent(v, c) === bi && sw.getComponent(v, c) > 0.5) b.expandByPoint(new THREE.Vector2(uv.getX(v), uv.getY(v)));
    if (b.isEmpty()) continue;
    const cx = ((b.min.x + b.max.x) / 2) * r.w;
    const cy = ((b.min.y + b.max.y) / 2) * r.h;
    const rx = ((b.max.x - b.min.x) / 2) * r.w + 2;
    const ry = ((b.max.y - b.min.y) / 2) * r.h + 2;
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(r.h - 1, Math.ceil(cy + ry)); y++)
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(r.w - 1, Math.ceil(cx + rx)); x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) out.rgba[(y * r.w + x) * 4 + 1] = Math.round(rough * 255);
  }
  return out;
}
const jpg = (data: Uint8Array) => ({ data, mime: 'image/jpeg' });

const out = await exportGlb(
  scene,
  clips,
  {
    Suit: {
      baseColor: jpg(toJpeg(tex('m005_body_color.tga'), 84)),
      normal: jpg(toJpeg(downscale(flipGreen(tex('m005_body_normal.tga')), 1024), 90)),
      roughness: jpg(toJpeg(downscale(roughnessFromSpecular(tex('m005_body_specular.tga'), 0.55, 0.92), 512), 85)),
    },
    Skin: {
      baseColor: jpg(toJpeg(tex('m005_head_color.tga'), 88)),
      normal: jpg(toJpeg(flipGreen(tex('m005_head_normal.tga')), 88)),
      roughness: jpg(toJpeg(glossEyes(downscale(roughnessFromSpecular(tex('m005_head_specular.tga'), 0.42, 0.78), 1024), 0.06), 88)),
    },
    Hair: { baseColor: { data: toPng(packAlpha(tex('m005_opacity_color.tga'))), mime: 'image/png' } },
  },
  {
    generator: 'ThreatReady build-avatar-rocketbox (Microsoft Rocketbox Business_Male_01, MIT)',
    extras: { source: 'Microsoft Rocketbox Avatar Library, Business_Male_01', license: 'MIT License, Copyright (c) 2020 Microsoft' },
  },
);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${(out.byteLength / 1024 / 1024).toFixed(2)} MB)`);
