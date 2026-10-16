import { useEffect, useRef, useState } from 'react';
import type { InterviewerStatus } from './InterviewerStage';
import { speechBus, type SpokenWord } from './speechBus';
import { visemeAt, wordDuration, wordToVisemes, type Viseme } from './visemes';

/**
 * Alex as photographs: stills of the 3D interviewer (public/avatar/alex, made by e2e/capture-alex.mjs)
 * animated in the browser. Lip sync picks the mouth still for the spoken viseme, blinks swap in the
 * eyes-closed still, and the head turns between three photographed angles with a little sway on
 * top. No WebGL, so it works wherever the 3D model can't load (every server without the licensed
 * model, every browser).
 *
 * Lip sync, best source first: word timing from speech synthesis (speechBus); otherwise a natural
 * syllable rhythm while `speaking`. One requestAnimationFrame loop draws to a canvas; no React
 * render per frame. Reduced motion keeps the mouth (it carries meaning) and drops head motion.
 */

export interface PhotoManifest {
  version: number;
  width: number;
  height: number;
  yaws: number;
  mouths: number;
  blinks: number;
  smile: boolean;
}
export interface PhotoSet {
  manifest: PhotoManifest;
  /** Stills by frame key (`y1_m0_b0`, `smile`); every key in the manifest is present. */
  frames: Map<string, HTMLImageElement>;
}

export const PHOTO_DIR = `${import.meta.env.BASE_URL}avatar/alex/`;
export const frameKey = (yaw: number, mouth: number, blink: number) => `y${yaw}_m${mouth}_b${blink}`;

/** Mouth-open level (0..1) each viseme reads as on a jaw-only face. */
const MOUTH_LEVEL: Record<Viseme, number> = {
  sil: 0, PP: 0, FF: 0.12, TH: 0.18, DD: 0.3, kk: 0.32, CH: 0.28, SS: 0.14, nn: 0.22, RR: 0.3, aa: 1, E: 0.62, I: 0.42, O: 0.9, U: 0.55,
};
const FLAP: Viseme[] = ['aa', 'DD', 'E', 'nn', 'O', 'SS', 'I', 'PP', 'aa', 'kk', 'U', 'E'];

/** Nearest photographed mouth still for a 0..1 level. */
export const mouthIndex = (level: number, mouths: number) => Math.max(0, Math.min(mouths - 1, Math.round(level * (mouths - 1))));

let loading: Promise<PhotoSet | null> | null = null;
/** Loads the manifest and every still once per page; `null` when the photos aren't deployed. */
export function loadPhotoSet(): Promise<PhotoSet | null> {
  return (loading ??= (async () => {
    try {
      const res = await fetch(`${PHOTO_DIR}manifest.json`, { cache: 'force-cache' });
      if (!res.ok) return null;
      const manifest = (await res.json()) as PhotoManifest;
      if (!manifest?.yaws || !manifest.mouths || !manifest.blinks) return null;
      const keys: string[] = [];
      for (let y = 0; y < manifest.yaws; y++) for (let m = 0; m < manifest.mouths; m++) for (let b = 0; b < manifest.blinks; b++) keys.push(frameKey(y, m, b));
      if (manifest.smile) keys.push('smile');
      const frames = new Map<string, HTMLImageElement>();
      await Promise.all(keys.map((k) => new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { frames.set(k, img); resolve(); };
        img.onerror = () => reject(new Error(`missing still ${k}`));
        img.src = `${PHOTO_DIR}${k}.webp`;
      })));
      return { manifest, frames };
    } catch {
      return null;
    }
  })());
}
/** Tests only. */
export function resetPhotoSet() { loading = null; }

/** `undefined` while loading, `null` when unavailable. */
export function usePhotoSet(): PhotoSet | null | undefined {
  const [set, setSet] = useState<PhotoSet | null | undefined>(undefined);
  useEffect(() => { let on = true; void loadPhotoSet().then((s) => { if (on) setSet(s); }); return () => { on = false; }; }, []);
  return set;
}

export interface InterviewerPhotoProps {
  photos: PhotoSet;
  status: InterviewerStatus;
  speaking: boolean;
  candidateTyping?: boolean;
}

export function InterviewerPhoto({ photos, status, speaking, candidateTyping = false }: InterviewerPhotoProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ status, speaking, candidateTyping });
  live.current = { status, speaking, candidateTyping };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const { manifest, frames } = photos;
    el.width = manifest.width;
    el.height = manifest.height;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const centerYaw = Math.floor(manifest.yaws / 2);

    // Fit the still to its box: as tall as the art area allows, never wider than it (a percentage
    // height does not resolve inside the stage's grid, so the size is set from the box itself).
    const box = el.parentElement;
    const fit = () => {
      if (!box) return;
      const h = Math.max(0, box.clientHeight - 8);
      const w = Math.min(box.clientWidth, (h * manifest.width) / manifest.height);
      el.style.width = `${Math.floor(w)}px`;
      el.style.height = `${Math.floor((w * manifest.height) / manifest.width)}px`;
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' && box ? new ResizeObserver(fit) : null;
    if (box) ro?.observe(box);

    let word: { seq: Viseme[]; dur: number; at: number } | null = null;
    let lastWordAt = -Infinity;
    const off = speechBus.subscribe((w: SpokenWord | null) => {
      if (!w) { word = null; return; }
      word = { seq: wordToVisemes(w.word), dur: wordDuration(w.word, w.rate), at: w.at };
      lastWordAt = w.at;
    });

    let mouth = 0; // eased 0..1
    let nextBlink = performance.now() + 1800 + Math.random() * 2500;
    let blinkUntil = 0;
    let yaw = centerYaw;
    let nextTurn = performance.now() + 2500 + Math.random() * 4000;
    let drawn = '';
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { status: st, speaking: talking, candidateTyping: typing } = live.current;

      // ---- mouth: the viseme level, eased so it reads as speech rather than flicker ----
      let target = 0;
      if (talking) {
        if (word && now - lastWordAt < 1200) {
          const v = visemeAt(word.seq, word.dur, (now - word.at) / 1000);
          target = v ? MOUTH_LEVEL[v] : 0;
        } else {
          const t = now / 1000;
          const syllable = Math.floor(t * 6.2);
          const pause = Math.sin(t * 1.3) > 0.82;
          target = pause ? 0 : MOUTH_LEVEL[FLAP[syllable % FLAP.length]!];
        }
      }
      mouth += (target - mouth) * (target > mouth ? 0.55 : 0.4);

      // ---- blink every 2-6 s (~140 ms), sometimes doubled ----
      if (now >= nextBlink) {
        blinkUntil = now + 140;
        nextBlink = now + (Math.random() < 0.15 ? 350 : 2000 + Math.random() * 4000);
      }
      const blink = now < blinkUntil ? 1 : 0;

      // ---- head: turns between the photographed angles; thinking looks away ----
      if (!reduce && now >= nextTurn) {
        nextTurn = now + 2500 + Math.random() * 4500;
        if (st === 'evaluating') yaw = Math.random() < 0.5 ? 0 : manifest.yaws - 1;
        else if (st === 'asking' || st === 'listening') yaw = Math.random() < 0.7 ? centerYaw : Math.random() < 0.5 ? 0 : manifest.yaws - 1;
        else yaw = centerYaw;
      }
      if (reduce) yaw = centerYaw;

      // ---- pick and draw the still ----
      const smile = st === 'finished' && manifest.smile && mouth < 0.05 && !blink;
      const key = smile ? 'smile' : frameKey(yaw, mouthIndex(mouth, manifest.mouths), blink);
      if (key !== drawn) {
        const img = frames.get(key);
        if (img) {
          ctx.clearRect(0, 0, el.width, el.height);
          ctx.drawImage(img, 0, 0, el.width, el.height);
          drawn = key;
        }
      }

      // ---- sway, breathing and listening nods as a transform on the canvas ----
      if (!reduce) {
        const t = now / 1000;
        const sway = Math.sin(t * 0.7) * 1.4 + Math.sin(t * 1.9) * 0.5; // px
        const breathe = Math.sin(t * 1.25) * 0.9;
        const nod = typing && (st === 'listening' || st === 'preparing') ? Math.max(0, Math.sin(t * 2.3)) ** 3 * 4 : 0;
        const tilt = Math.sin(t * 0.45) * 0.8; // deg
        el.style.transform = `translate(${sway.toFixed(2)}px, ${(breathe + nod).toFixed(2)}px) rotate(${tilt.toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); off(); ro?.disconnect(); };
  }, [photos]);

  return <canvas ref={canvas} className="ivw-photo" role="img" aria-label="Alex, your interviewer" data-testid="interviewer-photo" />;
}
