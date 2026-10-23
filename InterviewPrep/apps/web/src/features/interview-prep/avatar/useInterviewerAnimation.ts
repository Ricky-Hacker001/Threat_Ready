import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { CLIP_NAMES, EYE_MESH_NAMES, type ClipName, type MorphName } from './avatarContract';
import { clipForStatus } from './clipMapping';
import type { InterviewerStatus } from './InterviewerStage';
import { speechBus } from './speechBus';
import { VISEMES, visemeAt, visemeMorph, visemeWeight, wordDuration, wordToVisemes, type Viseme } from './visemes';

export { LISTEN_IDLE_AFTER_S, clipForStatus } from './clipMapping';
const FADE_S = 0.45;
const FADE_THINK_S = 0.8;

export interface InterviewerRig {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<ClipName, THREE.AnimationAction>>;
  head?: THREE.Object3D;
  eyes: THREE.Object3D[];
  face?: THREE.Mesh;
  morph: Partial<Record<MorphName, number>>;
}

/** Locates the contract parts in a loaded model and creates the mixer + actions. */
export function createRig(root: THREE.Object3D, clips: THREE.AnimationClip[]): InterviewerRig {
  const mixer = new THREE.AnimationMixer(root);
  const actions: InterviewerRig['actions'] = {};
  for (const name of CLIP_NAMES) {
    const clip = THREE.AnimationClip.findByName(clips, name);
    if (clip) actions[name] = mixer.clipAction(clip);
  }
  let face: THREE.Mesh | undefined;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!face && m.isMesh && m.morphTargetDictionary && 'blink' in m.morphTargetDictionary) face = m;
  });
  const eyes = EYE_MESH_NAMES.map((n) => root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
  // `Head` is a bone; skip same-named non-bones a replacement asset might contain.
  let head: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!head && o.name === 'Head' && (o as THREE.Bone).isBone) head = o;
  });
  head ??= root.getObjectByName('Head');
  const morph: InterviewerRig['morph'] = {};
  if (face?.morphTargetDictionary) {
    for (const [k, v] of Object.entries(face.morphTargetDictionary)) morph[k as MorphName] = v;
  }
  return { root, mixer, actions, head, eyes, face, morph };
}

export interface AnimationInputs {
  status: InterviewerStatus;
  speaking: boolean;
  speechLevel?: number;
  candidateTyping?: boolean;
  reducedMotion: boolean;
}

// ---- tiny deterministic value noise --------------------------------------------------------
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const noise1 = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) + (hash(i + 1) - hash(i)) * u;
};
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface ProceduralState {
  rig?: InterviewerRig;
  t: number;
  current?: ClipName;
  /** The reduced-motion setting the current clip was started with. */
  reduced?: boolean;
  lastTypingAt: number;
  nextBlink: number;
  blinkStart: number;
  doubleBlink: boolean;
  mouth: number;
  gazeYaw: number;
  gazePitch: number;
  sacYaw: number;
  sacPitch: number;
  sacTargetYaw: number;
  sacTargetPitch: number;
  nextSaccade: number;
  think: number;
  smileExtra: number;
  /** The word being spoken, for viseme lip sync (times on the `t` clock). */
  word?: { seq: Viseme[]; start: number; dur: number };
  lastWordAt: number;
  vis: Partial<Record<Viseme, number>>;
}

const MAX_EYE_ANGLE = 0.42;
const tmpV = new THREE.Vector3();
const tmpHead = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const IDENTITY = new THREE.Quaternion();

/**
 * Drives the interviewer: crossfades clips from the interview status and layers procedural
 * motion on top (blinks, mouth from a level signal, camera gaze with micro-saccades, typing nods).
 * Must be called inside an R3F <Canvas>.
 */
export function useInterviewerAnimation(rig: InterviewerRig | null, inputs: AnimationInputs): void {
  const latest = useRef(inputs);
  latest.current = inputs;
  const state = useMemo<ProceduralState>(
    () => ({
      t: 0,
      lastTypingAt: 0,
      nextBlink: rand(1, 3),
      blinkStart: -10,
      doubleBlink: false,
      mouth: 0,
      gazeYaw: 0,
      gazePitch: 0,
      sacYaw: 0,
      sacPitch: 0,
      sacTargetYaw: 0,
      sacTargetPitch: 0,
      nextSaccade: 1,
      think: 0,
      smileExtra: 0,
      lastWordAt: -10,
      vis: {},
    }),
    [],
  );

  // Word starts from speech synthesis (see speechBus) drive the visemes.
  useEffect(
    () =>
      speechBus.subscribe((w) => {
        if (!w) {
          state.word = undefined;
          return;
        }
        const lag = Math.max(0, (performance.now() - w.at) / 1000);
        state.word = { seq: wordToVisemes(w.word), start: state.t - lag, dur: wordDuration(w.word, w.rate) };
        state.lastWordAt = state.t;
      }),
    [state],
  );

  useEffect(() => {
    if (!rig) return;
    return () => {
      // Stop (but keep cached) so a StrictMode re-mount can simply play again.
      rig.mixer.stopAllAction();
      state.current = undefined;
    };
  }, [rig, state]);

  useFrame(({ camera }, delta) => {
    if (!rig) return;
    const dt = Math.min(delta, 1 / 20);
    const inp = latest.current;
    const s = state;
    if (s.rig !== rig) {
      s.rig = rig;
      s.current = undefined;
    }
    s.t += dt;
    if (inp.candidateTyping) s.lastTypingAt = s.t;

    // ---- clip selection & crossfade ------------------------------------------------------
    const wanted = clipForStatus(inp.status, { quietFor: s.t - s.lastTypingAt, reducedMotion: inp.reducedMotion });
    const next = rig.actions[wanted] ?? rig.actions.Idle;
    const reduced = Boolean(inp.reducedMotion);
    if (next && s.current !== wanted) {
      const prev = s.current ? rig.actions[s.current] : undefined;
      const fade = wanted === 'Think' || s.current === 'Think' ? FADE_THINK_S : FADE_S;
      next.reset();
      // With reduced motion the Idle clip holds its first frame: a natural still pose, with no
      // sway or breathing. Blinks and lip sync (below) stay, because they carry meaning.
      next.setEffectiveTimeScale(reduced ? 0 : 1);
      next.setEffectiveWeight(1);
      next.play();
      if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
      else next.fadeIn(fade);
      s.current = wanted;
      s.reduced = reduced;
    } else if (next && s.reduced !== reduced) {
      // The setting changed mid-session: freeze or resume the clip already playing.
      next.setEffectiveTimeScale(reduced ? 0 : 1);
      s.reduced = reduced;
    }
    rig.mixer.update(dt);

    // ---- face morphs ----------------------------------------------------------------------
    const infl = rig.face?.morphTargetInfluences;
    if (infl) {
      // blink every 2-6 s (~150 ms), sometimes doubled
      if (s.t >= s.nextBlink) {
        s.blinkStart = s.t;
        s.doubleBlink = Math.random() < 0.15;
        s.nextBlink = s.t + rand(2, 6);
      }
      const BLINK = 0.15;
      let ph = (s.t - s.blinkStart) / BLINK;
      if (s.doubleBlink && ph > 1.3 && ph < 2.3) ph -= 1.3;
      const blink = ph >= 0 && ph <= 1 ? Math.sin(Math.PI * ph) ** 0.7 : 0;

      // Lip sync: visemes from the spoken words when the model has them and speech reports word
      // timing; otherwise the mouth opens with the level signal or syllable-rate noise.
      const morphIndex = rig.morph as Record<string, number | undefined>;
      const hasVisemes = morphIndex[visemeMorph('aa')] !== undefined;
      const wordTimed = inp.speaking && hasVisemes && s.t - s.lastWordAt < 1.2;
      const current = wordTimed && s.word ? visemeAt(s.word.seq, s.word.dur, s.t - s.word.start) : null;
      if (hasVisemes) {
        for (const v of VISEMES) {
          const goal = current === v ? visemeWeight(v) : 0;
          const cur = s.vis[v] ?? 0;
          s.vis[v] = damp(cur, goal, goal > cur ? 30 : 16, dt);
          const i = morphIndex[visemeMorph(v)];
          if (i !== undefined) infl[i] = s.vis[v]!;
        }
      }
      let target = 0;
      if (wordTimed) {
        // a little jaw under open vowels; the viseme shapes do the rest
        target = current === 'aa' ? 0.14 : current === 'O' || current === 'E' ? 0.08 : current ? 0.03 : 0;
      } else if (inp.speaking) {
        if (typeof inp.speechLevel === 'number' && Number.isFinite(inp.speechLevel)) {
          target = THREE.MathUtils.clamp(inp.speechLevel, 0, 1) * 0.85;
        } else {
          const syll = noise1(s.t * 9.3);
          const phrase = noise1(s.t * 1.15 + 17.3);
          target = phrase > 0.22 ? 0.06 + 0.72 * THREE.MathUtils.clamp((syll - 0.2) * 1.35, 0, 1) : 0.04;
        }
        if (hasVisemes) target *= 0.45; // this face's jaw-open shape is large
      }
      s.mouth = damp(s.mouth, target, target > s.mouth ? 32 : 17, dt);
      s.smileExtra = damp(s.smileExtra, inp.status === 'finished' ? 0.25 : 0, 2, dt);

      const set = (name: MorphName, v: number) => {
        const i = rig.morph[name];
        if (i !== undefined) infl[i] = THREE.MathUtils.clamp(v, 0, 1);
      };
      const get = (name: MorphName) => {
        const i = rig.morph[name];
        return i !== undefined ? (infl[i] ?? 0) : 0;
      };
      set('blink', Math.max(get('blink'), blink));
      set('mouthOpen', Math.max(get('mouthOpen') * 0.3, s.mouth));
      set('smile', get('smile') + s.smileExtra - s.mouth * 0.15);
    }

    // ---- head gaze toward the camera, with damped micro-saccades ------------------------
    const head = rig.head;
    if (head) {
      head.updateWorldMatrix(true, false);
      head.getWorldPosition(tmpHead);
      rig.root.worldToLocal(tmpHead);
      tmpCam.copy(camera.position);
      rig.root.worldToLocal(tmpCam);
      tmpV.subVectors(tmpCam, tmpHead);
      const yaw = Math.atan2(tmpV.x, tmpV.z);
      const pitch = Math.atan2(tmpV.y, Math.hypot(tmpV.x, tmpV.z));
      const motion = inp.reducedMotion ? 0 : 1;

      if (s.t >= s.nextSaccade) {
        s.nextSaccade = s.t + rand(0.6, 2.6);
        s.sacTargetYaw = motion * rand(-0.035, 0.035);
        s.sacTargetPitch = motion * rand(-0.02, 0.02);
      }
      s.sacYaw = damp(s.sacYaw, s.sacTargetYaw, 28, dt);
      s.sacPitch = damp(s.sacPitch, s.sacTargetPitch, 28, dt);
      s.gazeYaw = damp(s.gazeYaw, THREE.MathUtils.clamp(yaw, -0.6, 0.6) * 0.5 + s.sacYaw * 0.25, 3.5, dt);
      s.gazePitch = damp(s.gazePitch, THREE.MathUtils.clamp(pitch, -0.4, 0.4) * 0.45 + s.sacPitch * 0.25, 3.5, dt);

      tmpE.set(-s.gazePitch, s.gazeYaw, 0, 'YXZ');
      head.quaternion.multiply(tmpQ.setFromEuler(tmpE));

      // listening micro-motion: small nods while the candidate types
      if (inp.candidateTyping && !inp.reducedMotion && (inp.status === 'listening' || inp.status === 'preparing')) {
        const nod = Math.max(0, Math.sin(s.t * 2.3)) ** 3 * 0.028;
        head.quaternion.multiply(tmpQ.setFromAxisAngle(tmpV.set(1, 0, 0), nod));
      }
      head.updateWorldMatrix(false, true);

      // ---- eyes: look at the camera (or drift with the head while thinking) --------------
      s.think = damp(s.think, inp.status === 'evaluating' && !inp.reducedMotion ? 1 : 0, 2.5, dt);
      tmpTarget.copy(camera.position);
      if (s.think > 0.001) {
        head.getWorldPosition(tmpHead);
        tmpFwd.set(0, 0.35, 1).applyQuaternion(head.getWorldQuaternion(tmpQ)).normalize();
        tmpV.copy(tmpHead).addScaledVector(tmpFwd, 2);
        tmpTarget.lerp(tmpV, s.think);
      }
      // saccade offset expressed at the target distance
      const dist = tmpTarget.distanceTo(head.getWorldPosition(tmpHead));
      tmpTarget.x += Math.sin(s.sacYaw) * dist;
      tmpTarget.y += Math.sin(s.sacPitch) * dist;
      for (const eye of rig.eyes) {
        eye.updateWorldMatrix(true, false);
        eye.lookAt(tmpTarget);
        const ang = eye.quaternion.angleTo(IDENTITY);
        if (ang > MAX_EYE_ANGLE) eye.quaternion.copy(IDENTITY).slerp(eye.quaternion, MAX_EYE_ANGLE / ang);
      }
    }
  });
}
