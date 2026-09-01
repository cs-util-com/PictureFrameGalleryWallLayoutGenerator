import { describe, it, expect } from 'vitest';
import {
  normalizeInventory,
  expandInventory,
  selectFrames,
  totalFrameCount,
  MIN_FRAMES,
  MAX_FRAMES,
} from '../src/inventory.js';
import { createRng } from '../src/prng.js';

const row = (w, h, count) => ({ w, h, count });

describe('normalizeInventory', () => {
  it('clamps dimensions and counts into the supported range', () => {
    const rows = normalizeInventory([row(0, -5, -2), row(9999, 9999, 999)]);
    expect(rows[0].w).toBeGreaterThanOrEqual(1);
    expect(rows[0].h).toBeGreaterThanOrEqual(1);
    expect(rows[0].count).toBe(0);
    expect(rows[1].count).toBeLessThanOrEqual(99);
  });

  it('replaces non-finite values with usable defaults', () => {
    const rows = normalizeInventory([{ w: NaN, h: undefined, count: 'x' }]);
    expect(Number.isFinite(rows[0].w)).toBe(true);
    expect(Number.isFinite(rows[0].h)).toBe(true);
    expect(Number.isFinite(rows[0].count)).toBe(true);
  });

  it('rounds to whole centimetres', () => {
    const rows = normalizeInventory([row(20.6, 30.4, 2.7)]);
    expect(rows[0]).toMatchObject({ w: 21, h: 30, count: 3 });
  });

  it('assigns a stable id to every row that lacks one', () => {
    const rows = normalizeInventory([row(10, 10, 1), row(20, 20, 1)]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe('totalFrameCount', () => {
  it('sums the counts', () => {
    expect(totalFrameCount([row(1, 1, 2), row(2, 2, 3)])).toBe(5);
  });
});

describe('expandInventory', () => {
  it('creates one instance per counted frame', () => {
    const frames = expandInventory([row(20, 30, 2), row(10, 15, 3)]);
    expect(frames).toHaveLength(5);
  });

  it('skips rows with a count of zero', () => {
    expect(expandInventory([row(20, 30, 0)])).toHaveLength(0);
  });

  it('sorts largest first so the anchor frame is the biggest', () => {
    const frames = expandInventory([row(10, 10, 1), row(50, 50, 1), row(30, 30, 1)]);
    expect(frames.map((f) => f.area)).toEqual([2500, 900, 100]);
  });

  it('gives every instance a unique id and records its unrotated size', () => {
    const frames = expandInventory([row(20, 30, 3)]);
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
    for (const f of frames) {
      expect(f).toMatchObject({ w: 20, h: 30, baseW: 20, baseH: 30, rotated: false, area: 600 });
    }
  });

  it('caps the number of instances so the engine cannot be swamped', () => {
    const frames = expandInventory([row(10, 10, 99), row(12, 12, 99)]);
    expect(frames.length).toBe(MAX_FRAMES);
  });

  it('produces frames that are independent objects', () => {
    const frames = expandInventory([row(20, 30, 2)]);
    frames[0].x = 5;
    expect(frames[1].x).toBe(0);
  });
});

describe('selectFrames', () => {
  const many = expandInventory([row(20, 30, 4), row(13, 18, 4), row(10, 15, 6)]);

  it('returns every frame when useAll is set', () => {
    const picked = selectFrames(many, { wallArea: 300 * 200, useAll: true, rng: createRng(1) });
    expect(picked).toHaveLength(many.length);
  });

  it('never returns more frames than it was given', () => {
    for (let seed = 0; seed < 25; seed++) {
      const picked = selectFrames(many, {
        wallArea: 300 * 200,
        useAll: false,
        rng: createRng(seed),
      });
      expect(picked.length).toBeLessThanOrEqual(many.length);
    }
  });

  it('thins the selection when the frames would crowd the wall', () => {
    const tinyWall = 60 * 60;
    const picked = selectFrames(many, { wallArea: tinyWall, useAll: false, rng: createRng(3) });
    const area = picked.reduce((s, f) => s + f.area, 0);
    expect(picked.length).toBeLessThan(many.length);
    expect(area).toBeLessThan(many.reduce((s, f) => s + f.area, 0));
  });

  it('keeps the largest frames when thinning, since they anchor the wall', () => {
    const picked = selectFrames(many, { wallArea: 80 * 80, useAll: false, rng: createRng(5) });
    expect(picked[0].area).toBe(many[0].area);
  });

  it('prefers an odd count when asked and the range allows it', () => {
    let odd = 0;
    const trials = 40;
    for (let seed = 0; seed < trials; seed++) {
      const picked = selectFrames(many, {
        wallArea: 300 * 200,
        useAll: false,
        preferOdd: true,
        rng: createRng(seed),
      });
      if (picked.length % 2 === 1) odd++;
    }
    expect(odd).toBeGreaterThan(trials * 0.8);
  });

  it('is deterministic for a given seed', () => {
    const a = selectFrames(many, { wallArea: 300 * 200, useAll: false, rng: createRng(77) });
    const b = selectFrames(many, { wallArea: 300 * 200, useAll: false, rng: createRng(77) });
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });

  it('does not thin below the minimum, even on an absurdly small wall', () => {
    const picked = selectFrames(many, { wallArea: 1, useAll: false, rng: createRng(9) });
    expect(picked.length).toBeGreaterThanOrEqual(Math.min(MIN_FRAMES, many.length));
  });

  it('passes through small inventories the engine could not thin anyway', () => {
    const two = expandInventory([row(20, 30, 2)]);
    const picked = selectFrames(two, { wallArea: 1, useAll: false, rng: createRng(1) });
    expect(picked).toHaveLength(2);
  });

  it('handles an empty inventory', () => {
    expect(selectFrames([], { wallArea: 100, useAll: false, rng: createRng(1) })).toEqual([]);
  });
});
