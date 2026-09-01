import { describe, it, expect } from 'vitest';
import { mulberry32, createRng } from '../src/prng.js';

describe('mulberry32', () => {
  it('produces values in [0, 1)', () => {
    const rand = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, mulberry32(1));
    const b = Array.from({ length: 20 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('is reasonably uniform across ten buckets', () => {
    const rand = mulberry32(7);
    const buckets = new Array(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rand() * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 50);
      expect(count).toBeLessThan(n / 10 + n / 50);
    }
  });
});

describe('mulberry32 golden vectors', () => {
  // The seed travels in the shared URL while the coordinates do not, so the
  // mapping from seed to output sequence is a persisted wire format: changing
  // it silently invalidates every link anyone has ever shared. These literals
  // pin that format. If they ever fail, the sequence changed -- treat it as a
  // breaking change, not a test to update.
  it('produces the documented sequence for seed 42', () => {
    const rand = mulberry32(42);
    expect(Array.from({ length: 5 }, rand)).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423,
    ]);
  });

  it('produces the documented values through the createRng helpers', () => {
    const rng = createRng(42);
    expect(rng.float()).toBe(0.6011037519201636);
    expect(rng.int(1000)).toBe(448);
    expect(rng.range(-5, 5)).toBe(3.5246579349040985);
    expect(rng.bell(2)).toBe(-0.2577190352603793);
  });
});

describe('createRng', () => {
  it('draws every helper from one shared stream', () => {
    // If each helper had its own generator, consuming a float first would not
    // shift what int() returns -- and two different call sequences would give
    // the same answers, which would make layouts irreproducible.
    const withFloatFirst = createRng(1);
    withFloatFirst.float();
    const shifted = withFloatFirst.int(1e9);

    const unshifted = createRng(1).int(1e9);
    expect(unshifted).toBe(Math.floor(mulberry32(1)() * 1e9));
    expect(shifted).not.toBe(unshifted);
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng(5);
    for (let i = 0; i < 100; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('chance is roughly calibrated to its probability', () => {
    const rng = createRng(11);
    let hits = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) if (rng.chance(0.3)) hits++;
    expect(hits / n).toBeGreaterThan(0.28);
    expect(hits / n).toBeLessThan(0.32);
  });

  it('exposes float, int, range and pick built on one stream', () => {
    const rng = createRng(99);
    expect(typeof rng.float()).toBe('number');

    for (let i = 0; i < 200; i++) {
      const n = rng.int(5);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }

    for (let i = 0; i < 200; i++) {
      const v = rng.range(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }

    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(items).toContain(rng.pick(items));
  });

  it('int(0) returns 0 rather than a negative index', () => {
    const rng = createRng(1);
    expect(rng.int(0)).toBe(0);
  });

  it('pick on an empty array returns undefined', () => {
    expect(createRng(1).pick([])).toBeUndefined();
  });

  it('is deterministic across identical call sequences', () => {
    const run = () => {
      const rng = createRng(2024);
      return [rng.float(), rng.int(100), rng.range(-5, 5), rng.bell(2)];
    };
    expect(run()).toEqual(run());
  });

  it('bell() has the spread of a three-uniform sum', () => {
    // The sum of k uniforms has variance k/12, so bell(1) must have a standard
    // deviation of sqrt(3/12) = 0.5. A two-uniform version would give 0.408.
    // The step size this produces is what keeps annealing jumps tight enough
    // that frames are not repeatedly thrown off the wall.
    const rng = createRng(13);
    const n = 40000;
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.bell(1);
      sum += v;
      sumSquares += v * v;
    }
    const sd = Math.sqrt(sumSquares / n - (sum / n) ** 2);
    expect(sd).toBeGreaterThan(0.49);
    expect(sd).toBeLessThan(0.51);
  });

  it('bell() is centred on zero and bounded by its spread', () => {
    const rng = createRng(3);
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const v = rng.bell(2);
      expect(Math.abs(v)).toBeLessThanOrEqual(3);
      sum += v;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
  });
});
