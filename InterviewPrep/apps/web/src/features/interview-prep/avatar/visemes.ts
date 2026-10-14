/**
 * Text-driven lip sync. Browser speech synthesis reports when each word starts but not its
 * phonemes, so each word is mapped from its spelling to a sequence of the 15 Oculus visemes
 * (the set the avatar's face carries) and spread over the word's estimated duration. English
 * spelling is only a rough guide to sound; the aim is plausible mouth shapes, not phonetics.
 */
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'] as const;
export type Viseme = (typeof VISEMES)[number];
export const visemeMorph = (v: Viseme) => `viseme_${v}`;

const DIGRAPHS: [string, Viseme[]][] = [
  ['tch', ['CH']],
  ['th', ['TH']],
  ['ch', ['CH']],
  ['sh', ['CH']],
  ['ph', ['FF']],
  ['ck', ['kk']],
  ['ng', ['nn']],
  ['qu', ['kk', 'U']],
  ['oo', ['U']],
  ['ou', ['aa', 'U']],
  ['ow', ['O', 'U']],
  ['ee', ['I']],
  ['ea', ['I']],
  ['ai', ['E', 'I']],
  ['ay', ['E', 'I']],
  ['oi', ['O', 'I']],
  ['oy', ['O', 'I']],
  ['wh', ['U']],
];
const SINGLE: Record<string, Viseme | null> = {
  a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I',
  p: 'PP', b: 'PP', m: 'PP',
  f: 'FF', v: 'FF',
  t: 'DD', d: 'DD',
  n: 'nn', l: 'nn',
  k: 'kk', g: 'kk', c: 'kk', q: 'kk', x: 'kk',
  s: 'SS', z: 'SS',
  j: 'CH',
  r: 'RR',
  w: 'U',
  h: null,
};

/** Spelling to visemes; consecutive duplicates collapse. */
export function wordToVisemes(word: string): Viseme[] {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return /\d/.test(word) ? ['aa', 'E'] : [];
  if (w.length > 3 && w.endsWith('e') && !/[aeiou]e$/.test(w)) w = w.slice(0, -1); // silent final e
  const out: Viseme[] = [];
  for (let i = 0; i < w.length; ) {
    const di = DIGRAPHS.find(([d]) => w.startsWith(d, i));
    if (di) {
      out.push(...di[1]);
      i += di[0].length;
      continue;
    }
    const v = SINGLE[w[i]!];
    if (v) out.push(v);
    i += 1;
  }
  return out.filter((v, i) => v !== out[i - 1]);
}

/** Rough spoken duration of a word at the given speech rate (seconds). */
export const wordDuration = (word: string, rate = 1) => Math.max(0.12, (0.05 + word.replace(/[^a-z0-9]/gi, '').length * 0.062) / rate);

const VOWELS = new Set<Viseme>(['aa', 'E', 'I', 'O', 'U']);
/** Peak weight per viseme: closures are full, vowels partly open (the jaw adds the rest). */
export const visemeWeight = (v: Viseme) => (v === 'PP' || v === 'FF' ? 0.95 : v === 'O' || v === 'U' ? 0.5 : VOWELS.has(v) ? 0.65 : 0.6);

/** The viseme active `t` seconds into a word, with vowels held a little longer than consonants. */
export function visemeAt(seq: Viseme[], duration: number, t: number): Viseme | null {
  if (!seq.length || t < 0 || t >= duration) return null;
  const lens = seq.map((v) => (VOWELS.has(v) ? 1.4 : 1));
  const total = lens.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < seq.length; i++) {
    acc += (lens[i]! / total) * duration;
    if (t < acc) return seq[i]!;
  }
  return seq.at(-1) ?? null;
}
