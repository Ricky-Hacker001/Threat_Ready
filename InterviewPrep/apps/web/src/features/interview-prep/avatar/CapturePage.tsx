import { Environment, Lightformer } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, use, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadInterviewerModel } from './loadModel';
import { createRig } from './useInterviewerAnimation';

/**
 * Development only (`/interview-prep/__capture`): renders Alex head-and-shoulders on a transparent
 * canvas and exposes `window.__alexCapture` so e2e/capture-alex.mjs can photograph him in each
 * mouth, blink and head pose. The stills become the 2D interviewer's photos (public/avatar/alex);
 * they are renders, not the 3D data (see ASSET_LICENSE.md).
 */

export interface CaptureParams {
  /** Head turn: -1 left, 0 straight at the camera, 1 right (±10°). */
  yaw: number;
  /** 0..1 mouthOpen morph. */
  mouth: number;
  /** 0..1 blink morph. */
  blink: number;
  smile: number;
}
interface CaptureApi {
  ready: boolean;
  set(p: Partial<CaptureParams>): void;
  /** The current frame as a WebP data URL (after the params have been rendered). */
  snap(): Promise<string>;
}
declare global {
  interface Window { __alexCapture?: CaptureApi }
}

const W = 600;
const H = 800;
const LOOK_AT = new THREE.Vector3(0, 1.2, 0.1);
const CAMERA_POS: [number, number, number] = [0.02, 1.25, 1.35];
const FRAME_H = 0.62; // metres visible at the subject
const YAW_STEP = THREE.MathUtils.degToRad(10);

function Subject() {
  const gltf = use(loadInterviewerModel());
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const params = useRef<CaptureParams>({ yaw: 0, mouth: 0, blink: 0, smile: 0.1 });
  const pending = useRef<{ frames: number; resolve: (s: string) => void }[]>([]);
  const rig = useMemo(() => {
    const root = cloneSkinned(gltf.scene);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat?.isMeshStandardMaterial) return;
      if (mat.name === 'Eye') { mat.envMapIntensity = 1.4; mesh.castShadow = false; mesh.receiveShadow = false; }
      else if (mat.name === 'Hair') { mat.envMapIntensity = 0.15; mat.roughness = 0.92; if (mat.alphaTest > 0) { mat.alphaTest = 0.5; mat.alphaToCoverage = true; } mesh.castShadow = false; }
      else mat.envMapIntensity = mat.name === 'Skin' ? 0.5 : 0.45;
    });
    const r = createRig(root, gltf.animations);
    // The seated pose comes from the Listen clip; hold one frame of it.
    const a = r.actions.Listen ?? r.actions.Idle;
    if (a) { a.play(); a.paused = true; a.time = 0.4; }
    r.mixer.update(0);
    return r;
  }, [gltf]);

  useEffect(() => {
    const dist = camera.position.distanceTo(LOOK_AT);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(FRAME_H / 2 / dist));
    camera.lookAt(LOOK_AT);
    camera.updateProjectionMatrix();
    window.__alexCapture = {
      ready: true,
      set: (p) => { params.current = { ...params.current, ...p }; },
      snap: () => new Promise((resolve) => pending.current.push({ frames: 4, resolve })),
    };
    return () => { delete window.__alexCapture; };
  }, [camera]);

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpE = useMemo(() => new THREE.Euler(), []);
  // The held clip has no head track, so the turn is applied to the bone's rest rotation each frame
  // rather than multiplied onto the previous frame (which would accumulate into a profile view).
  const headBase = useMemo(() => rig.head?.quaternion.clone(), [rig]);
  useFrame(() => {
    rig.mixer.update(1 / 60);
    const p = params.current;
    const infl = rig.face?.morphTargetInfluences;
    if (infl) {
      const set = (name: 'blink' | 'mouthOpen' | 'smile' | 'browRaise', v: number) => { const i = rig.morph[name]; if (i !== undefined) infl[i] = THREE.MathUtils.clamp(v, 0, 1); };
      set('blink', p.blink);
      set('mouthOpen', p.mouth);
      set('smile', p.smile - p.mouth * 0.15);
    }
    if (rig.head && headBase) {
      tmpE.set(0, p.yaw * YAW_STEP, 0, 'YXZ');
      rig.head.quaternion.copy(headBase).multiply(tmpQ.setFromEuler(tmpE));
      rig.head.updateWorldMatrix(false, true);
      for (const eye of rig.eyes) { eye.updateWorldMatrix(true, false); eye.lookAt(camera.position); }
    }
    for (const job of pending.current) job.frames -= 1;
    const done = pending.current.filter((j) => j.frames <= 0);
    if (done.length) {
      pending.current = pending.current.filter((j) => j.frames > 0);
      const url = gl.domElement.toDataURL('image/webp', 0.92);
      for (const j of done) j.resolve(url);
    }
  });

  return <primitive object={rig.root} />;
}

export default function CapturePage() {
  return (
    <div style={{ width: W, height: H, background: 'transparent' }}>
      <Canvas
        dpr={1}
        shadows="percentage"
        camera={{ position: CAMERA_POS, fov: 24, near: 0.05, far: 30 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false }}
        onCreated={({ gl, scene }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.setClearColor(0x000000, 0);
          scene.background = null;
        }}
        style={{ width: W, height: H }}
      >
        <Environment resolution={128} frames={1} environmentIntensity={0.6}>
          <Lightformer form="rect" intensity={1.6} color="#fff4ea" position={[0.5, 3, 2.5]} scale={[3, 1.4, 1]} target={[0, 1, 0]} />
          <Lightformer form="rect" intensity={1.2} color="#b9cbea" position={[-3, 1.6, -1.5]} scale={[1.2, 1.6, 1]} target={[0, 1, 0]} />
          <Lightformer form="rect" intensity={0.35} color="#dfe6f5" position={[-2.5, 1.2, 2.5]} scale={[2, 1, 1]} target={[0, 1, 0]} />
        </Environment>
        <ambientLight intensity={0.35} />
        <directionalLight position={[1.4, 2.6, 2.2]} intensity={2.4} color="#fff2e6" castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-1.8, 1.8, 1.4]} intensity={0.7} color="#cfe0ff" />
        <directionalLight position={[-0.6, 2.2, -1.6]} intensity={1.2} color="#e8eefc" />
        <Suspense fallback={null}>
          <Subject />
        </Suspense>
      </Canvas>
    </div>
  );
}
