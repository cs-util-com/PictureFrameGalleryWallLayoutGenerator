/**
 * Deterministic pseudo-random number generation.
 *
 * Every random decision in the layout engine flows through a seeded stream so
 * that a given seed always reproduces the exact same wall. That is what makes a
 * shared link meaningful: the URL carries the seed, not the coordinates.
 */

/**
 * Mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * @param {number} seed Any integer; only the low 32 bits matter.
 * @returns {() => number} A function yielding floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wraps a seeded stream with the handful of helpers the engine needs. All
 * helpers draw from the same underlying stream, so the sequence of calls fully
 * determines the output.
 *
 * @param {number} seed
 */
export function createRng(seed) {
  const next = mulberry32(seed);

  return {
    /** Float in [0, 1). */
    float: next,

    /** Integer in [0, n). Returns 0 for n <= 0 so callers never index with -1. */
    int(n) {
      if (!(n > 0)) return 0;
      return Math.floor(next() * n);
    },

    /** Float in [min, max). */
    range(min, max) {
      return min + next() * (max - min);
    },

    /** Uniformly chosen element, or undefined for an empty array. */
    pick(items) {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },

    /** True with probability p. */
    chance(p) {
      return next() < p;
    },

    /**
     * Roughly normal value centred on 0, bounded by ±1.5 * spread. Built from
     * three uniforms (Bates distribution) — cheap and bounded, which matters
     * because unbounded jumps would repeatedly throw frames off the wall.
     */
    bell(spread) {
      return (next() + next() + next() - 1.5) * spread;
    },
  };
}
