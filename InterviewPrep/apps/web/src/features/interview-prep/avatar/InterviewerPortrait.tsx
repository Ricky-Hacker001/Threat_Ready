import { useEffect, useRef } from 'react';
import type { InterviewerStatus } from './InterviewerStage';
import { speechBus, type SpokenWord } from './speechBus';
import { visemeAt, wordDuration, wordToVisemes, type Viseme } from './visemes';

/**
 * Alex, the 2D interviewer: an illustrated portrait whose mouth follows the spoken question.
 * Works in every browser (SVG, no WebGL), so it is the interviewer whenever the 3D model is not
 * available.
 *
 * Lip sync, best source first:
 *  1. Word timing from speech synthesis (speechBus): each word becomes visemes over its length.
 *  2. Browsers/voices that send no word events (e.g. Chrome's network voices): a natural
 *     syllable rhythm while `speaking`, so the mouth never freezes mid-question.
 * All motion runs in one requestAnimationFrame loop writing SVG attributes; no React render per
 * frame. Reduced-motion users keep the mouth (it carries meaning) but lose head motion.
 */

/** Mouth geometry: width and opening (px in the 320×320 viewBox) and how rounded the lips are. */
interface MouthShape {
  w: number;
  open: number;
  round: number;
  teeth: boolean;
}
const SHAPES: Record<Viseme, MouthShape> = {
  sil: { w: 30, open: 0, round: 0, teeth: false },
  PP: { w: 27, open: 0, round: 0, teeth: false },
  FF: { w: 28, open: 3, round: 0, teeth: true },
  TH: { w: 29, open: 4, round: 0, teeth: true },
  DD: { w: 30, open: 5, round: 0, teeth: true },
  kk: { w: 30, open: 6, round: 0, teeth: true },
  CH: { w: 24, open: 6, round: 0.5, teeth: true },
  SS: { w: 31, open: 3, round: 0, teeth: true },
  nn: { w: 30, open: 4, round: 0, teeth: true },
  RR: { w: 25, open: 6, round: 0.6, teeth: false },
  aa: { w: 32, open: 13, round: 0, teeth: true },
  E: { w: 34, open: 8, round: 0, teeth: true },
  I: { w: 35, open: 6, round: 0, teeth: true },
  O: { w: 22, open: 12, round: 1, teeth: false },
  U: { w: 18, open: 8, round: 1, teeth: false },
};
const REST: MouthShape = { w: 30, open: 0, round: 0, teeth: false };
const FLAP: Viseme[] = ['aa', 'DD', 'E', 'nn', 'O', 'SS', 'I', 'PP', 'aa', 'kk', 'U', 'E'];

const MOUTH_X = 160;
const MOUTH_Y = 197;

/** Lips as one closed path: upper and lower lip curves meeting at the corners. */
function lipsPath(m: MouthShape): string {
  const hw = m.w / 2;
  const smile = m.open < 1 ? 2.2 : 1; // corners lift a little when the mouth is closed
  const l = MOUTH_X - hw;
  const r = MOUTH_X + hw;
  const top = MOUTH_Y - m.open * 0.35 - 1.5;
  const bottom = MOUTH_Y + m.open * 0.65 + 2.5;
  const k = hw * (0.55 + m.round * 0.35); // control spread: rounder lips bulge more
  return [
    `M${l} ${MOUTH_Y - smile}`,
    `C${MOUTH_X - k} ${top - 2}, ${MOUTH_X - 3} ${top}, ${MOUTH_X} ${top + 1}`,
    `C${MOUTH_X + 3} ${top}, ${MOUTH_X + k} ${top - 2}, ${r} ${MOUTH_Y - smile}`,
    `C${MOUTH_X + k} ${bottom + 1}, ${MOUTH_X - k} ${bottom + 1}, ${l} ${MOUTH_Y - smile}`,
    'Z',
  ].join(' ');
}

/** The dark opening inside the lips (empty when closed). */
function openingPath(m: MouthShape): string {
  if (m.open < 0.8) return '';
  const hw = m.w / 2 - 3;
  const top = MOUTH_Y - m.open * 0.3;
  const bottom = MOUTH_Y + m.open * 0.6;
  const k = hw * (0.6 + m.round * 0.3);
  return `M${MOUTH_X - hw} ${MOUTH_Y} C${MOUTH_X - k} ${top}, ${MOUTH_X + k} ${top}, ${MOUTH_X + hw} ${MOUTH_Y} C${MOUTH_X + k} ${bottom}, ${MOUTH_X - k} ${bottom}, ${MOUTH_X - hw} ${MOUTH_Y} Z`;
}

const mix = (a: MouthShape, b: MouthShape, t: number): MouthShape => ({
  w: a.w + (b.w - a.w) * t,
  open: a.open + (b.open - a.open) * t,
  round: a.round + (b.round - a.round) * t,
  teeth: t < 0.5 ? a.teeth : b.teeth,
});

export interface InterviewerPortraitProps {
  status: InterviewerStatus;
  speaking: boolean;
  /** candidate is typing or talking: small attentive nods */
  candidateTyping?: boolean;
}

export function InterviewerPortrait({ status, speaking, candidateTyping = false }: InterviewerPortraitProps) {
  const head = useRef<SVGGElement>(null);
  const lips = useRef<SVGPathElement>(null);
  const opening = useRef<SVGPathElement>(null);
  const teeth = useRef<SVGRectElement>(null);
  const lids = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  // Latest props for the animation loop without restarting it.
  const live = useRef({ status, speaking, candidateTyping });
  live.current = { status, speaking, candidateTyping };

  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let word: { seq: Viseme[]; dur: number; at: number } | null = null;
    let lastWordAt = -Infinity;
    const off = speechBus.subscribe((w: SpokenWord | null) => {
      if (!w) {
        word = null;
        return;
      }
      word = { seq: wordToVisemes(w.word), dur: wordDuration(w.word, w.rate), at: w.at };
      lastWordAt = w.at;
    });

    let current: MouthShape = REST;
    let nextBlink = performance.now() + 1800 + Math.random() * 2500;
    let blinkUntil = 0;
    let raf = 0;

    const frame = (now: number) => {
      const { status: st, speaking: talking, candidateTyping: typing } = live.current;

      // ---- mouth ----
      let target: MouthShape = REST;
      if (talking) {
        const fromWords = word && now - lastWordAt < 1200;
        if (fromWords && word) {
          const v = visemeAt(word.seq, word.dur, (now - word.at) / 1000);
          target = v ? SHAPES[v] : SHAPES.sil;
        } else {
          // No word events from this browser/voice: syllables at a natural ~6/s with small pauses.
          const t = now / 1000;
          const syllable = Math.floor(t * 6.2);
          const pause = Math.sin(t * 1.3) > 0.82;
          target = pause ? SHAPES.sil : SHAPES[FLAP[syllable % FLAP.length]!];
        }
      }
      current = mix(current, target, 0.38); // ease between shapes so motion reads as speech, not flicker
      lips.current?.setAttribute('d', lipsPath(current));
      opening.current?.setAttribute('d', openingPath(current));
      if (teeth.current) teeth.current.style.opacity = current.teeth && current.open > 2.5 ? '1' : '0';

      // ---- blink ----
      if (now > nextBlink) {
        blinkUntil = now + 130;
        nextBlink = now + 2600 + Math.random() * 3800;
      }
      if (lids.current) lids.current.style.transform = `scaleY(${now < blinkUntil ? 1 : 0})`;

      // ---- gaze and head ----
      if (eyes.current) {
        const away = st === 'evaluating' ? -2.2 : 0; // glances down-left while thinking
        eyes.current.style.transform = `translate(${away}px, ${st === 'evaluating' ? 1.2 : 0}px)`;
      }
      if (head.current && !reduce) {
        const t = now / 1000;
        const breathe = Math.sin(t * 1.1) * 0.8;
        const nod = typing ? Math.max(0, Math.sin(t * 2.4)) * 2.2 : 0;
        const talk = talking ? Math.sin(t * 3.1) * 0.7 : 0;
        head.current.style.transform = `translateY(${breathe + nod}px) rotate(${talk}deg)`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, []);

  return (
    <svg className="ivw-portrait" viewBox="0 0 320 320" preserveAspectRatio="xMidYMax meet" role="img" aria-label="Alex, your interviewer">
      {/* shoulders, shirt, tie */}
      <path className="ivw-p-coat" d="M36 330 C40 266 84 238 132 231 L160 228 L188 231 C236 238 280 266 284 330 Z" />
      <path className="ivw-p-shirt" d="M136 230 L160 288 L184 230 L172 224 L148 224 Z" />
      <path className="ivw-p-collar" d="M146 222 L160 240 L150 250 L138 232 Z" />
      <path className="ivw-p-collar" d="M174 222 L160 240 L170 250 L182 232 Z" />
      <path className="ivw-p-tie" d="M155 240 L165 240 L168 250 L163 290 L157 290 L152 250 Z" />
      <path className="ivw-p-lapel" d="M136 230 L114 240 L146 276 L160 290 Z" />
      <path className="ivw-p-lapel" d="M184 230 L206 240 L174 276 L160 290 Z" />
      {/* neck */}
      <path className="ivw-p-skin-shade" d="M143 196 L177 196 L179 230 L160 240 L141 230 Z" />
      <g ref={head} className="ivw-p-head">
        {/* ears */}
        <ellipse className="ivw-p-skin-shade" cx="112" cy="164" rx="7.5" ry="13" />
        <ellipse className="ivw-p-skin-shade" cx="208" cy="164" rx="7.5" ry="13" />
        {/* face, with a soft jaw shadow */}
        <path className="ivw-p-skin" d="M160 102 C193 102 211 127 210 162 C209 194 189 221 160 221 C131 221 111 194 110 162 C109 127 127 102 160 102 Z" />
        <path className="ivw-p-jaw" d="M122 190 C132 210 146 219 160 219 C174 219 188 210 198 190 C190 205 176 214 160 214 C144 214 130 205 122 190 Z" />
        {/* hair: side part with volume */}
        <path className="ivw-p-hair" d="M108 160 C100 112 126 88 164 88 C200 88 220 112 212 158 C208 138 202 126 192 120 C176 112 156 116 146 110 C140 122 128 128 116 132 C112 140 109 150 108 160 Z" />
        <path className="ivw-p-hair-part" d="M146 110 C150 104 158 98 168 95" />
        {/* brows */}
        <path className="ivw-p-brow" d="M127 145 C135 139 145 139 152 143" />
        <path className="ivw-p-brow" d="M168 143 C175 139 185 139 193 145" />
        {/* eyes */}
        <g>
          <ellipse className="ivw-p-eye-white" cx="140" cy="160" rx="9.5" ry="6" />
          <ellipse className="ivw-p-eye-white" cx="180" cy="160" rx="9.5" ry="6" />
          <g ref={eyes} className="ivw-p-eyes">
            <circle className="ivw-p-iris" cx="140" cy="160" r="4.6" />
            <circle className="ivw-p-iris" cx="180" cy="160" r="4.6" />
            <circle className="ivw-p-pupil" cx="140" cy="160" r="2" />
            <circle className="ivw-p-pupil" cx="180" cy="160" r="2" />
            <circle className="ivw-p-glint" cx="141.6" cy="158.3" r="1.2" />
            <circle className="ivw-p-glint" cx="181.6" cy="158.3" r="1.2" />
          </g>
          {/* upper lash lines give the eyes definition at small sizes */}
          <path className="ivw-p-lash" d="M130 159 C134 152.5 146 152.5 150 159" />
          <path className="ivw-p-lash" d="M170 159 C174 152.5 186 152.5 190 159" />
          {/* eyelids (blink) */}
          <g ref={lids} className="ivw-p-lids">
            <ellipse className="ivw-p-skin" cx="140" cy="160" rx="10.5" ry="7" />
            <ellipse className="ivw-p-skin" cx="180" cy="160" rx="10.5" ry="7" />
          </g>
        </g>
        {/* nose */}
        <path className="ivw-p-nose" d="M160 164 C158 174 154 180 155 183 C157 186 163 186 165 183" />
        {/* mouth: lips, then the opening and teeth drawn inside them */}
        <path ref={lips} className="ivw-p-lips" d={lipsPath(REST)} />
        <path ref={opening} className="ivw-p-mouth-in" d="" />
        <rect ref={teeth} className="ivw-p-teeth" x={MOUTH_X - 9} y={MOUTH_Y - 3} width="18" height="3.2" rx="1.2" />
      </g>
      <title>Alex, your interviewer</title>
      <desc>{`Interviewer status: ${status}`}</desc>
    </svg>
  );
}

export default InterviewerPortrait;
