import { PerformanceMonitor } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Effects } from './Effects';
import { loadInterviewerModel } from './loadModel';
import type { InterviewerStatus } from './InterviewerStage';
import { useDocumentVisible, usePrefersReducedMotion } from './mediaHooks';
import { Room } from './Room';
import { createRig, useInterviewerAnimation } from './useInterviewerAnimation';

export interface InterviewerSceneProps {
  status: InterviewerStatus;
  speaking: boolean;
  speechLevel?: number;
  candidateTyping?: boolean;
  onReady: () => void;
  onContextLost: () => void;
}

// Start fetching the model as soon as this chunk loads, in parallel with GPU warm-up.
void loadInterviewerModel().catch(() => undefined);

const CAMERA_POS: [number, number, number] = [0.3, 1.32, 2.05];
const LOOK_AT = new THREE.Vector3(0, 1.05, 0.22);
/** Visible frame height (m) at the look-at distance; widened on narrow viewports. */
const FRAME_H = 0.84;
const FRAME_MIN_W = 1.0;
/** The face: kept in focus by the depth of field. */
const FOCUS = new THREE.Vector3(-0.015, 1.28, 0.1);

/**
 * Cheap subsurface scattering for skin: light wraps past the terminator with a warm, reddish tint,
 * as it does through real skin (diffuse only, so highlights are unchanged).
 */
function addSubsurface(material: THREE.MeshPhysicalMaterial) {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
    'vec3 irradiance = dotNL * directLight.color;',
    `vec3 irradiance = dotNL * directLight.color;
	float sssWrap = saturate( ( dot( geometryNormal, directLight.direction ) + 0.55 ) / 1.55 );
	reflectedLight.directDiffuse += max( sssWrap - dotNL, 0.0 ) * directLight.color * vec3( 0.48, 0.2, 0.14 ) * BRDF_Lambert( material.diffuseColor );`,
  );
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk);
  };
  material.customProgramCacheKey = () => 'skin-sss-v1';
}

/**
 * Post-processing only where the GPU keeps up: weak or low-core devices start without it, and
 * `?fx=0` turns it off (support and comparison).
 */
const startHighQuality = () => {
  if (typeof window === 'undefined') return true;
  if (new URLSearchParams(window.location.search).get('fx') === '0') return false;
  return (navigator.hardwareConcurrency ?? 8) > 4;
};

/** Fixed, chest-up framing; keeps the subject in frame for any aspect ratio. No orbit controls. */
/** Development only: `?cam=face` frames the face closely, for checking the avatar asset. */
const faceCloseUp = () => import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cam') === 'face';

function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useLayoutEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const close = faceCloseUp();
    const target = close ? FOCUS : LOOK_AT;
    const dist = camera.position.distanceTo(target);
    const h = close ? 0.3 : Math.max(FRAME_H, FRAME_MIN_W / aspect);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h / 2 / dist));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height]);
  return null;
}

/** Loaded once; geometry is shared, the skeleton is cloned per mount. */
function Interviewer(props: Omit<InterviewerSceneProps, 'onContextLost'> & { reducedMotion: boolean }) {
  const gltf = use(loadInterviewerModel());
  const rig = useMemo(() => {
    const root = cloneSkinned(gltf.scene);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // skinned bounds come from the bind pose; gestures can leave them
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat?.isMeshStandardMaterial) return;
      if (mat.name === 'Skin') {
        // a touch of sheen reads as softer, less plastic skin
        const skin = new THREE.MeshPhysicalMaterial();
        // copy only the standard-material fields, then restore the physical shader defines
        THREE.MeshStandardMaterial.prototype.copy.call(skin, mat);
        skin.defines = { STANDARD: '', PHYSICAL: '' };
        skin.name = 'Skin';
        // The texture already carries real skin and hair colour; keep the sheen subtle and neutral
        // (it also covers the painted hair on the scalp).
        skin.sheen = 0.12;
        skin.sheenRoughness = 0.6;
        skin.sheenColor = new THREE.Color('#e8c4b4');
        skin.envMapIntensity = 0.5;
        addSubsurface(skin);
        mesh.material = skin;
      } else if (mat.name === 'Eye') {
        mat.envMapIntensity = 1.4;
        mesh.castShadow = false;
        // deep-set eyes sit in the brow's shadow-map shadow, which reads as black sockets at this
        // resolution; ambient occlusion still darkens them naturally
        mesh.receiveShadow = false;
      } else if (mat.name === 'Hair') {
        // hair is matte; faint card edges otherwise catch the cool rim light as a glassy fringe
        mat.envMapIntensity = 0.15;
        mat.roughness = 0.92;
        // hair strands and lashes are alpha cards: coverage-based edges look soft with MSAA
        if (mat.alphaTest > 0) {
          mat.alphaTest = 0.5;
          mat.alphaToCoverage = true;
        }
        mesh.castShadow = false;
      } else {
        mat.envMapIntensity = 0.45;
      }
    });
    return createRig(root, gltf.animations);
  }, [gltf]);

  useInterviewerAnimation(rig, {
    status: props.status,
    speaking: props.speaking,
    speechLevel: props.speechLevel,
    candidateTyping: props.candidateTyping,
    reducedMotion: props.reducedMotion,
  });

  const { onReady } = props;
  useEffect(() => {
    onReady();
  }, [onReady]);

  return <primitive object={rig.root} />;
}

/**
 * Reduced motion: the canvas renders on demand instead of every display frame. Frames are asked for
 * only where motion carries meaning: lip sync while Alex speaks (30 fps), a short burst after a status
 * change (the face settles into it) and one for a blink every few seconds. The body holds still.
 */
function DemandFrames({ speaking, status }: { speaking: boolean; status: InterviewerStatus }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const burst = (ms: number) => {
      cancelAnimationFrame(raf);
      const until = performance.now() + ms;
      const step = () => {
        invalidate();
        if (performance.now() < until) raf = requestAnimationFrame(step);
      };
      step();
    };
    burst(600);
    if (speaking) {
      const lips = window.setInterval(() => invalidate(), 1000 / 30);
      return () => {
        window.clearInterval(lips);
        cancelAnimationFrame(raf);
      };
    }
    const blink = () => {
      timer = window.setTimeout(() => {
        burst(300);
        blink();
      }, 3000 + Math.random() * 3000);
    };
    blink();
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [speaking, status, invalidate]);
  return null;
}

export default function InterviewerScene({ onContextLost, ...props }: InterviewerSceneProps) {
  const visible = useDocumentVisible();
  const reducedMotion = usePrefersReducedMotion();
  const [hq, setHq] = useState(startHighQuality);
  // Shadow maps cost every frame: only devices that start in high quality get them (fixed per mount;
  // switching them later would recompile every material).
  const [shadows] = useState(startHighQuality);
  const lostRef = useRef(onContextLost);
  lostRef.current = onContextLost;

  return (
    <Canvas
      className="ivw-canvas"
      aria-hidden="true"
      dpr={[1, 1.75]}
      // Stop rendering entirely while the tab is hidden; with reduced motion, render only on demand.
      frameloop={!visible ? 'never' : reducedMotion ? 'demand' : 'always'}
      shadows={shadows ? 'percentage' : false}
      camera={{ position: CAMERA_POS, fov: 24, near: 0.05, far: 30 }}
      // 'default' lets the browser keep a laptop on its integrated GPU (battery, heat) for one talking head.
      gl={{ antialias: true, powerPreference: 'default', alpha: false }}
      onCreated={({ gl, scene }) => {
        // plain render; the photographic Effects switch to AgX with their own grade
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        scene.background = new THREE.Color('#0f1115');
        gl.domElement.addEventListener(
          'webglcontextlost',
          (e) => {
            e.preventDefault();
            lostRef.current();
          },
          { once: true },
        );
      }}
    >
      <CameraRig />
      {reducedMotion ? (
        <DemandFrames speaking={props.speaking} status={props.status} />
      ) : (
        // drop the photographic effects if the frame rate falls (it can't be measured on demand frames)
        <PerformanceMonitor onDecline={() => setHq(false)} flipflops={2} onFallback={() => setHq(false)} />
      )}
      {hq && <Effects focus={FOCUS} />}
      <Room />
      <Suspense fallback={null}>
        <Interviewer {...props} reducedMotion={reducedMotion} />
      </Suspense>
    </Canvas>
  );
}
