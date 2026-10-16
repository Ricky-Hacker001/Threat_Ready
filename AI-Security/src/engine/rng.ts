/** Deterministic seeded RNG (mulberry32) + small helpers. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(minInclusive: number, maxInclusive: number): number {
    return Math.floor(this.next() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  /** Returns a shuffled copy (Fisher–Yates). */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
  /** Short uppercase-ish token, e.g. "7F3K9". */
  token(len = 5): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[this.int(0, alphabet.length - 1)];
    return s;
  }
}

/** Stable string hash -> 32-bit seed, so a scenarioId+attempt maps to a seed. */
export function hashSeed(...parts: (string | number)[]): number {
  const s = parts.join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
