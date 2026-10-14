import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BONE_NAMES,
  CLIP_NAMES,
  EYE_MESH_NAMES,
  MORPH_NAMES,
  VISEME_MORPH_NAMES,
} from '../src/features/interview-prep/avatar/avatarContract';

// Served by the API (licence: never a public file).
const GLB = resolve(__dirname, '../../api/assets/interviewer.glb');

function parse(buffer: ArrayBuffer): Promise<GLTF> {
  // Images cannot be decoded under jsdom: textures are replaced by placeholders (their presence
  // is checked from the glTF JSON below).
  const loader = new GLTFLoader().register(() => ({ name: 'stub-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  return new Promise((ok, fail) => loader.parse(buffer, '', ok, fail));
}

describe('interviewer.glb asset contract', () => {
  let gltf: GLTF;

  beforeAll(async () => {
    const file = readFileSync(GLB);
    // Copy into an ArrayBuffer from this realm: GLTFLoader branches on `instanceof ArrayBuffer`,
    // and a Node Buffer's backing store fails that check under jsdom.
    const buffer = new ArrayBuffer(file.byteLength);
    new Uint8Array(buffer).set(file);
    gltf = await parse(buffer);
  });

  it('stays small enough to ship', () => {
    expect(statSync(GLB).size).toBeLessThan(6 * 1024 * 1024);
  });

  it('carries embedded colour and normal textures', () => {
    const json = gltf.parser.json as { images?: unknown[]; materials?: { name?: string; normalTexture?: unknown; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[] };
    expect(json.images?.length ?? 0).toBeGreaterThanOrEqual(3);
    const skin = json.materials?.find((m) => m.name === 'Skin');
    expect(skin?.pbrMetallicRoughness?.baseColorTexture).toBeDefined();
    expect(skin?.normalTexture).toBeDefined();
  });

  it('has the contract bones in one skeleton', () => {
    const bones = new Set<string>();
    gltf.scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.add(o.name);
    });
    for (const name of BONE_NAMES) expect(bones, `bone ${name}`).toContain(name);

    const skinned: THREE.SkinnedMesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
    });
    expect(skinned.length).toBeGreaterThanOrEqual(3);
    for (const mesh of skinned) {
      expect(mesh.skeleton.bones.map((b) => b.name)).toEqual(expect.arrayContaining([...BONE_NAMES]));
      expect(mesh.skeleton.bones[0]).toBe(skinned[0]!.skeleton.bones[0]); // one shared skeleton
    }
  });

  it('has the 4 animation clips with tracks', () => {
    const names = gltf.animations.map((c) => c.name);
    for (const clip of CLIP_NAMES) expect(names, `clip ${clip}`).toContain(clip);
    for (const clip of gltf.animations) {
      expect(clip.duration).toBeGreaterThan(1);
      expect(clip.tracks.some((t) => t.name.endsWith('.quaternion'))).toBe(true);
      expect(clip.tracks.some((t) => t.name.includes('morphTargetInfluences'))).toBe(true);
    }
  });

  it('has the 4 face morph targets on a skinned head mesh', () => {
    let face: THREE.Mesh | undefined;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && 'blink' in m.morphTargetDictionary) face = m;
    });
    expect(face).toBeDefined();
    expect((face as THREE.SkinnedMesh).isSkinnedMesh).toBe(true);
    for (const morph of MORPH_NAMES) expect(Object.keys(face!.morphTargetDictionary!)).toContain(morph);
    // visemes are optional, but all-or-nothing
    const visemes = VISEME_MORPH_NAMES.filter((v) => v in face!.morphTargetDictionary!);
    expect([0, VISEME_MORPH_NAMES.length]).toContain(visemes.length);
  });

  it('has eyes parented under the Head bone', () => {
    for (const name of EYE_MESH_NAMES) {
      const eye = gltf.scene.getObjectByName(name);
      expect(eye, name).toBeDefined();
      let p = eye!.parent;
      let underHead = false;
      while (p) {
        if (p.name === 'Head' && (p as THREE.Bone).isBone) underHead = true;
        p = p.parent;
      }
      expect(underHead, `${name} under Head`).toBe(true);
    }
  });

  it('is seated, Y-up, in metres and faces +Z', () => {
    gltf.scene.updateMatrixWorld(true);
    const head = new THREE.Vector3();
    const hips = new THREE.Vector3();
    gltf.scene.getObjectByName('Head')!.getWorldPosition(head);
    gltf.scene.getObjectByName('Hips')!.getWorldPosition(hips);
    expect(head.y).toBeGreaterThan(1.0);
    expect(head.y).toBeLessThan(1.5);
    expect(hips.y).toBeGreaterThan(0.4);
    expect(hips.y).toBeLessThan(0.7);
    // the eyes sit in front of the head joint, i.e. the character faces +Z
    const eye = new THREE.Vector3();
    gltf.scene.getObjectByName('LeftEye')!.getWorldPosition(eye);
    expect(eye.z).toBeGreaterThan(head.z + 0.05);
    expect(eye.x).toBeGreaterThan(0); // character's left is +X
  });
});
