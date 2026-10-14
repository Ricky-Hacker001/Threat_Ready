import { ContactShadows, Environment, Lightformer, RoundedBox } from '@react-three/drei';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

/*
 * A quiet, professional virtual interview room built entirely in code: no textures, no HDRs,
 * nothing fetched at runtime. Units are metres; the interviewer sits at the origin facing +Z,
 * the desk top is at 0.72 m.
 */

let rectLightsReady = false;
function ensureRectAreaLights() {
  if (!rectLightsReady) {
    RectAreaLightUniformsLib.init();
    rectLightsReady = true;
  }
}

const ACCENT = '#6d5dfc'; // brand accent (theme.css --accent)
const DESK_TOP = 0.72;

/** Seeded PRNG so the plant looks the same on every load. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Leaf: a lathe-free, slightly cupped ellipse blade with its base at the origin, pointing +Y. */
function useLeafGeometry() {
  return useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.05, 0.06, 0.045, 0.2, 0, 0.27);
    shape.bezierCurveTo(-0.045, 0.2, -0.05, 0.06, 0, 0);
    const geo = new THREE.ShapeGeometry(shape, 10);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, -9 * x * x + 0.12 * y * y); // cup across, arch along
    }
    geo.computeVertexNormals();
    return geo;
  }, []);
}

function Plant({ position, scale = 1, seed = 7 }: { position: [number, number, number]; scale?: number; seed?: number }) {
  const leaf = useLeafGeometry();
  const leaves = useMemo(() => {
    const rnd = mulberry32(seed);
    return Array.from({ length: 22 }, (_, i) => {
      const yaw = (i / 22) * Math.PI * 2 * 2.618 + rnd() * 0.4;
      const tilt = 0.25 + rnd() * 0.75;
      const s = 0.75 + rnd() * 0.55;
      const h = 0.02 + rnd() * 0.08;
      const shade = new THREE.Color().setHSL(0.31 + rnd() * 0.05, 0.32, 0.18 + rnd() * 0.08);
      return { yaw, tilt, s, h, shade };
    });
  }, [seed]);
  return (
    <group position={position} scale={scale}>
      {/* pot */}
      <mesh castShadow receiveShadow position={[0, 0.13, 0]}>
        <cylinderGeometry args={[0.13, 0.1, 0.26, 40]} />
        <meshStandardMaterial color="#2a2d33" roughness={0.75} />
      </mesh>
      <mesh position={[0, 0.258, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.118, 32]} />
        <meshStandardMaterial color="#1a1512" roughness={1} />
      </mesh>
      {leaves.map((l, i) => (
        <group key={i} position={[0, 0.25 + l.h, 0]} rotation={[0, l.yaw, 0]}>
          <mesh geometry={leaf} rotation={[l.tilt, 0, 0]} scale={l.s} castShadow>
            <meshStandardMaterial color={l.shade} roughness={0.6} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Books({ position }: { position: [number, number, number] }) {
  const books = useMemo(() => {
    const rnd = mulberry32(11);
    const palette = ['#3b4048', '#5a5f68', '#2d3138', '#6d6458', '#43383a', '#8a8378'];
    let x = 0;
    return Array.from({ length: 9 }, (_, i) => {
      const w = 0.022 + rnd() * 0.018;
      const h = 0.17 + rnd() * 0.07;
      const d = 0.13 + rnd() * 0.04;
      const b = { x: x + w / 2, w, h, d, color: palette[i % palette.length]!, lean: i === 8 ? -0.22 : 0 };
      x += w + 0.002;
      return b;
    });
  }, []);
  return (
    <group position={position}>
      {books.map((b, i) => (
        <mesh key={i} position={[b.x + (b.lean ? 0.03 : 0), b.h / 2, 0]} rotation={[0, 0, b.lean]} castShadow receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial color={b.color} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

function Laptop() {
  // placed on the interviewer's right, screen facing them; the lid's back faces the camera
  return (
    <group position={[-0.44, DESK_TOP, 0.56]} rotation={[0, 0.55, 0]}>
      <RoundedBox args={[0.32, 0.014, 0.22]} radius={0.005} smoothness={3} position={[0, 0.007, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#7d838c" metalness={0.65} roughness={0.38} />
      </RoundedBox>
      <group position={[0, 0.014, 0.11]} rotation={[-1.86, 0, 0]}>
        <RoundedBox args={[0.32, 0.008, 0.215]} radius={0.004} smoothness={3} position={[0, 0.004, -0.1075]} castShadow>
          <meshStandardMaterial color="#868c95" metalness={0.65} roughness={0.34} />
        </RoundedBox>
        {/* screen, facing the interviewer */}
        <mesh position={[0, -0.0005, -0.1075]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.29, 0.19]} />
          <meshBasicMaterial color="#1b2633" toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

function Desk() {
  return (
    <group>
      <RoundedBox args={[1.9, 0.036, 0.86]} radius={0.01} smoothness={4} position={[0, DESK_TOP - 0.018, 0.6]} receiveShadow castShadow>
        <meshStandardMaterial color="#4a3526" roughness={0.6} metalness={0} envMapIntensity={0.3} />
      </RoundedBox>
      {/* modesty panel */}
      <mesh position={[0, 0.38, 0.27]} receiveShadow>
        <boxGeometry args={[1.7, 0.62, 0.02]} />
        <meshStandardMaterial color="#1b1d21" roughness={0.9} />
      </mesh>
      <Laptop />
      {/* notepad + pen */}
      <group position={[0.4, DESK_TOP, 0.52]} rotation={[0, -0.22, 0]}>
        <mesh position={[0, 0.003, 0]} receiveShadow castShadow>
          <boxGeometry args={[0.15, 0.006, 0.21]} />
          <meshStandardMaterial color="#d9d5cc" roughness={0.92} />
        </mesh>
        <mesh position={[0.095, 0.006, 0.0]} rotation={[Math.PI / 2, 0, 0.12]} castShadow>
          <cylinderGeometry args={[0.0045, 0.0045, 0.14, 12]} />
          <meshStandardMaterial color="#1a1c20" roughness={0.35} metalness={0.4} />
        </mesh>
      </group>
      {/* mug */}
      <group position={[0.58, DESK_TOP, 0.34]}>
        <mesh position={[0, 0.047, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.039, 0.036, 0.094, 36]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.55} />
        </mesh>
        <mesh position={[0.045, 0.05, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <torusGeometry args={[0.022, 0.0055, 10, 24, Math.PI]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.55} />
        </mesh>
      </group>
    </group>
  );
}

function Chair() {
  return (
    <group position={[0, 0, -0.24]}>
      <RoundedBox args={[0.58, 0.68, 0.085]} radius={0.035} smoothness={4} position={[0, 0.96, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#17191d" roughness={0.92} />
      </RoundedBox>
      {/* frame */}
      <mesh position={[0, 0.6, -0.03]}>
        <boxGeometry args={[0.05, 0.12, 0.03]} />
        <meshStandardMaterial color="#0e0f12" roughness={0.5} metalness={0.5} />
      </mesh>
    </group>
  );
}

function Window() {
  const blinds = useMemo(() => Array.from({ length: 13 }, (_, i) => 0.9 + i * 0.096), []);
  return (
    <group position={[-1.25, 0, -1.49]}>
      {/* soft daylight pane */}
      <mesh position={[0, 1.5, 0]}>
        <planeGeometry args={[1.0, 1.3]} />
        <meshBasicMaterial color={new THREE.Color('#a9b9cf').multiplyScalar(0.46)} toneMapped />
      </mesh>
      {/* blinds, half-open */}
      {blinds.map((y, i) => (
        <mesh key={i} position={[0, y, 0.03]} rotation={[0.9, 0, 0]}>
          <boxGeometry args={[0.98, 0.05, 0.002]} />
          <meshStandardMaterial color="#c9ced6" roughness={0.8} emissive="#8492a6" emissiveIntensity={0.18} />
        </mesh>
      ))}
      {/* frame */}
      {[
        [0, 2.16, 1.08, 0.04],
        [0, 0.84, 1.08, 0.04],
        [-0.52, 1.5, 0.04, 1.36],
        [0.52, 1.5, 0.04, 1.36],
      ].map(([x, y, w, h], i) => (
        <mesh key={i} position={[x!, y!, 0.02]}>
          <boxGeometry args={[w!, h!, 0.05]} />
          <meshStandardMaterial color="#202328" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

function BackWall() {
  const slats = useMemo(() => Array.from({ length: 15 }, (_, i) => 0.62 + i * 0.075), []);
  return (
    <group>
      <mesh position={[0, 2, -1.5]} receiveShadow>
        <planeGeometry args={[10, 5]} />
        <meshStandardMaterial color="#1b1e23" roughness={0.95} />
      </mesh>
      {/* subtle inset panels behind the interviewer */}
      {[-0.32, 0.32].map((x) => (
        <mesh key={x} position={[x, 1.55, -1.495]}>
          <boxGeometry args={[0.6, 1.4, 0.01]} />
          <meshStandardMaterial color="#1f2228" roughness={0.9} />
        </mesh>
      ))}
      {/* slatted wood feature on the right */}
      <mesh position={[1.17, 1.5, -1.49]}>
        <boxGeometry args={[1.18, 1.9, 0.01]} />
        <meshStandardMaterial color="#121315" roughness={1} />
      </mesh>
      {slats.map((x) => (
        <mesh key={x} position={[x, 1.5, -1.47]} castShadow receiveShadow>
          <boxGeometry args={[0.042, 1.9, 0.03]} />
          <meshStandardMaterial color="#3a2a1f" roughness={0.7} />
        </mesh>
      ))}
      {/* floating shelf with books and a small plant, with a faint accent strip beneath */}
      <group position={[0.8, 1.22, -1.36]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.8, 0.03, 0.24]} />
          <meshStandardMaterial color="#26292f" roughness={0.6} />
        </mesh>
        <mesh position={[0, -0.0165, 0.06]}>
          <boxGeometry args={[0.72, 0.003, 0.01]} />
          <meshBasicMaterial color={new THREE.Color(ACCENT).multiplyScalar(0.45)} toneMapped={false} />
        </mesh>
        <Books position={[-0.33, 0.015, 0]} />
        <Plant position={[0.22, 0.015, 0]} scale={0.42} seed={3} />
      </group>
      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[10, 10]} />
        <meshStandardMaterial color="#121418" roughness={0.9} />
      </mesh>
      {/* floor plant by the window */}
      <Plant position={[-0.78, 0, -1.05]} scale={1.15} seed={7} />
    </group>
  );
}

function Lights() {
  const key = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set(0, 1.05, 0.1);
    return o;
  }, []);
  useLayoutEffect(() => {
    ensureRectAreaLights();
    if (key.current) key.current.target = target;
  }, [target]);
  return (
    <>
      <primitive object={target} />
      <hemisphereLight args={['#c3cee0', '#1a1513', 0.35]} />
      {/* soft key, front-left high, slightly warm */}
      <directionalLight
        ref={key}
        position={[1.5, 2.7, 2.5]}
        intensity={2.1}
        color="#fff1e4"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={2.5}
        shadow-bias={-0.0003}
        shadow-normalBias={0.02}
        shadow-camera-left={-1.1}
        shadow-camera-right={1.1}
        shadow-camera-top={1.1}
        shadow-camera-bottom={-1.1}
        shadow-camera-near={0.5}
        shadow-camera-far={7}
      />
      {/* cool fill from the other side */}
      <directionalLight position={[-2.2, 1.5, 2.2]} intensity={0.55} color="#d3defc" />
      {/* cool rim from behind / window side */}
      <directionalLight position={[-1.4, 2.3, -2.4]} intensity={2.4} color="#a9c1ff" />
      {/* window spill */}
      <rectAreaLight args={['#c3d2ea', 2.2, 1.0, 1.3]} position={[-1.25, 1.5, -1.42]} rotation={[0, Math.PI, 0]} />
      {/* very subtle warm brand accent: a low red kicker behind the right shoulder */}
      <pointLight position={[1.1, 1.0, -0.85]} intensity={0.22} distance={1.3} decay={2} color={ACCENT} />
      <directionalLight position={[1.8, 1.6, -1.8]} intensity={0.14} color={ACCENT} />
    </>
  );
}

/** Local lightformers only — gives skin, eyes and the laptop believable reflections offline. */
function LocalEnvironment() {
  return (
    <Environment resolution={128} frames={1} environmentIntensity={0.6}>
      <color attach="background" args={['#0c0d10']} />
      <Lightformer form="rect" intensity={1.6} color="#fff4ea" position={[0.5, 3, 2.5]} scale={[3, 1.4, 1]} target={[0, 1, 0]} />
      <Lightformer form="rect" intensity={1.2} color="#b9cbea" position={[-3, 1.6, -1.5]} scale={[1.2, 1.6, 1]} target={[0, 1, 0]} />
      <Lightformer form="rect" intensity={0.35} color="#dfe6f5" position={[-2.5, 1.2, 2.5]} scale={[2, 1, 1]} target={[0, 1, 0]} />
      <Lightformer form="circle" intensity={0.25} color={ACCENT} position={[2.6, 1.2, -1.6]} scale={0.6} target={[0, 1, 0]} />
    </Environment>
  );
}

export function Room() {
  return (
    <>
      <fog attach="fog" args={['#0f1115', 3.2, 8]} />
      <Lights />
      <LocalEnvironment />
      <BackWall />
      <Window />
      <Chair />
      <Desk />
      <ContactShadows position={[0, DESK_TOP + 0.0015, 0.6]} scale={[1.9, 0.86]} opacity={0.6} blur={2.4} far={0.55} resolution={512} color="#000000" />
    </>
  );
}
