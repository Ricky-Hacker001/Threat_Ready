/**
 * Question uniqueness (spec §2). Two layers: the variation seed is chosen away from what the
 * learner has seen (seed.ts), and the generated text is compared with their previous items here.
 * Shingles are word 3-grams over the scenario, narrative, question and options; Jaccard above the
 * configured threshold (default 0.35) means "the same question in different words".
 */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'by', 'at', 'as', 'it', 'its', 'that', 'this', 'from', 'into']);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function shingles(text: string, n = 3): Set<string> {
  const t = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The text an item is compared on: what the learner reads, not the rubric. */
export function comparableText(item: { scenario: string; attackNarrative: string; question: string; options: { text: string }[] }): string {
  return [item.scenario, item.attackNarrative, item.question, ...item.options.map((o) => o.text)].join('\n');
}

export interface SimilarityVerdict {
  tooSimilar: boolean;
  /** Highest similarity to a previous item, and which one. */
  max: number;
  nearest: string | null;
  fingerprintCollision: boolean;
}

export function checkSimilarity(
  candidate: { fingerprint: string; text: string },
  previous: { id: string; fingerprint: string; text: string }[],
  threshold: number,
): SimilarityVerdict {
  const cand = shingles(candidate.text);
  let max = 0;
  let nearest: string | null = null;
  let fingerprintCollision = false;
  for (const p of previous) {
    if (p.fingerprint === candidate.fingerprint) fingerprintCollision = true;
    const s = jaccard(cand, shingles(p.text));
    if (s > max) {
      max = s;
      nearest = p.id;
    }
  }
  return { tooSimilar: fingerprintCollision || max >= threshold, max: Math.round(max * 1000) / 1000, nearest, fingerprintCollision };
}
