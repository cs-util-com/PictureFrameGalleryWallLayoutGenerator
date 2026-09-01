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

describe('createRng', () => {
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
