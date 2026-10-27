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

/* ---------------- gen.v3: architecture-aware similarity (design §3.6) ---------------- */

/** A question a new library question is compared with. */
export interface LibraryBankEntry {
  id: string;
  /** Null for items generated before the architecture library. */
  archId: string | null;
  fingerprint: string;
  /** The structural identity of the attack (`<arch>:<path>`), null for legacy items. */
  pathKey: string | null;
  objective: string;
  text: string;
  /**
   * Whether the entry counts for the structure rule (review AR-BIZ-2): live questions and, on demand,
   * the learner's own. A retired question can never be served again, so it is no obstacle to another
   * question with its path and objective; the learner's near-duplicate guard lives at serve time
   * (ReasoningService.servable). Absent means true. Text similarity uses every entry.
   */
  structural?: boolean;
  /** Shingles of `text`, and the same without its architecture's shingles: computed once per bank. */
  shingles?: Set<string>;
  bare?: Set<string>;
}

export interface LibrarySimilarityVerdict extends SimilarityVerdict {
  /** Same architecture, same attack path and same objective as a question in the bank. */
  structureCollision: boolean;
}

/** `a` without the shingles in `remove`: the architecture's own wording is not evidence that two questions are alike. */
export function withoutShingles(a: Set<string>, remove: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (!remove.has(x)) out.add(x);
  return out;
}

/**
 * A candidate library question against the bank (design §3.6):
 *  - fingerprint: equal to one in `fingerprints` (live questions of the bucket; on demand also every
 *    question the learner was served) is a collision;
 *  - structure: the same architecture, attack path and objective as a structural bank entry (a live
 *    question, or the learner's own) is a collision;
 *  - text: Jaccard of word 3-grams at or above `threshold`, after removing the architecture's own
 *    shingles from both sides (questions on one architecture share its vocabulary), is too similar.
 */
export function checkLibrarySimilarity(
  candidate: { fingerprint: string; archId: string; pathKey: string; objective: string; text: string },
  bank: { fingerprints: ReadonlySet<string>; entries: LibraryBankEntry[] },
  threshold: number,
  archShingles: Set<string>,
): LibrarySimilarityVerdict {
  const cand = withoutShingles(shingles(candidate.text), archShingles);
  let max = 0;
  let nearest: string | null = null;
  let structureCollision = false;
  const fingerprintCollision = bank.fingerprints.has(candidate.fingerprint);
  for (const e of bank.entries) {
    if (e.structural !== false && e.archId === candidate.archId && e.pathKey === candidate.pathKey && e.objective === candidate.objective) structureCollision = true;
    e.shingles ??= shingles(e.text);
    const other = e.archId === candidate.archId ? (e.bare ??= withoutShingles(e.shingles, archShingles)) : e.shingles;
    const s = jaccard(cand, other);
    if (s > max) {
      max = s;
      nearest = e.id;
    }
  }
  return { tooSimilar: fingerprintCollision || structureCollision || max >= threshold, max: Math.round(max * 1000) / 1000, nearest, fingerprintCollision, structureCollision };
}
