// Deterministic PRNG utilities. Every log line is a pure function of
// (case seed, time slot), so a case's log stream can be regenerated
// identically after a server restart.

function hashStr(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';

export function rng(...keys) {
  const f = mulberry32(hashStr(keys.join('|')));
  const api = {
    f,
    int: (a, b) => a + Math.floor(f() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    chance: (p) => f() < p,
    weighted(items) {
      // items: [[weight, value], ...]
      let total = 0;
      for (const [w] of items) total += w;
      let x = f() * total;
      for (const [w, v] of items) {
        x -= w;
        if (x < 0) return v;
      }
      return items[items.length - 1][1];
    },
    hex(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += HEX[Math.floor(f() * 16)];
      return s;
    },
  };
  return api;
}

// Stable hex digest-looking string derived from a label (for synthetic hashes).
export function fakeSha256(label) {
  return rng('sha256', label).hex(64);
}
