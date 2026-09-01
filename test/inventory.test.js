import { describe, it, expect } from 'vitest';
import {
  normalizeInventory,
  expandInventory,
  selectFrames,
  totalFrameCount,
  cloneFrames,
  MIN_FRAMES,
  MAX_FRAMES,
  MAX_ROWS,
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
    expect(rows[0]).toMatchObject({ w: 20, h: 30, count: 0 });
  });

  it('falls back to the default size for a cleared input field', () => {
    // An emptied <input type="number"> reports '', which coerces to 0 and would
    // otherwise clamp to a 1 cm frame rather than falling back to the default.
    const rows = normalizeInventory([
      { w: '', h: null, count: 2 },
      { w: '   ', h: [], count: 1 },
    ]);
    expect(rows[0]).toMatchObject({ w: 20, h: 30 });
    expect(rows[1]).toMatchObject({ w: 20, h: 30 });
  });

  it('still accepts a genuine zero as the smallest allowed frame', () => {
    expect(normalizeInventory([{ w: 0, h: 0, count: 1 }])[0]).toMatchObject({ w: 1, h: 1 });
  });

  it('returns an empty inventory for input that is not an array', () => {
    for (const bad of [undefined, null, 'nope', 42, {}]) {
      expect(normalizeInventory(bad)).toEqual([]);
    }
  });

  it('treats a non-finite count as absent rather than as a huge number', () => {
    expect(normalizeInventory([{ w: 10, h: 10, count: Infinity }])[0].count).toBe(0);
    expect(normalizeInventory([{ w: 10, h: 10, count: -Infinity }])[0].count).toBe(0);
  });

  it('drops rows beyond the supported maximum', () => {
    const many = Array.from({ length: MAX_ROWS + 10 }, () => row(10, 10, 1));
    expect(normalizeInventory(many)).toHaveLength(MAX_ROWS);
  });

  it('rounds to whole centimetres', () => {
    const rows = normalizeInventory([row(20.6, 30.4, 2.7)]);
    expect(rows[0]).toMatchObject({ w: 21, h: 30, count: 3 });
  });

  it('assigns a unique id to every row', () => {
    const rows = normalizeInventory([row(10, 10, 1), row(20, 20, 1)]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('keeps ids unique even when only some rows arrive with one', () => {
    // Ids arrive from the URL, so collisions are the normal case rather than
    // the exotic one -- and rowId is what groups frames in the hanging list.
    const rows = normalizeInventory([
      { id: 2, w: 10, h: 10, count: 1 },
      { w: 20, h: 20, count: 1 },
      { id: -1.5, w: 30, h: 30, count: 1 },
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    for (const r of rows) expect(Number.isInteger(r.id)).toBe(true);
  });
});

describe('totalFrameCount', () => {
  it('sums the counts', () => {
    expect(totalFrameCount([row(1, 1, 2), row(2, 2, 3)])).toBe(5);
  });

  it('returns 0 for input that is not an array', () => {
    expect(totalFrameCount(undefined)).toBe(0);
  });
});

describe('cloneFrames', () => {
  it('returns independent copies', () => {
    const frames = expandInventory([row(20, 30, 2)]);
    const copy = cloneFrames(frames);
    copy[0].x = 99;
    copy[0].rotated = true;
    expect(frames[0].x).toBe(0);
    expect(frames[0].rotated).toBe(false);
  });

  it('preserves every field', () => {
    const frames = expandInventory([row(20, 30, 1)]);
    expect(cloneFrames(frames)).toEqual(frames);
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

  it('returns an empty list for input that is not an array', () => {
    expect(expandInventory(undefined)).toEqual([]);
  });

  it('cannot be made to hang by an unnormalized count', () => {
    // The loop bound itself must be finite, not just its result: `i < Infinity`
    // never terminates and exhausts the heap.
    expect(expandInventory([{ w: 10, h: 10, count: Infinity }])).toEqual([]);
    expect(expandInventory([{ w: 10, h: 10, count: 1e9 }]).length).toBe(MAX_FRAMES);
  });
});

describe('selectFrames', () => {
  const many = expandInventory([row(20, 30, 4), row(13, 18, 4), row(10, 15, 6)]);

  it('returns every frame when useAll is set', () => {
    const picked = selectFrames(many, { wallW: 300, wallH: 200, useAll: true, rng: createRng(1) });
    expect(picked).toHaveLength(many.length);
  });

  it('never returns more frames than it was given', () => {
    for (let seed = 0; seed < 25; seed++) {
      const picked = selectFrames(many, {
        wallW: 300,
        wallH: 200,
        useAll: false,
        rng: createRng(seed),
      });
      expect(picked.length).toBeLessThanOrEqual(many.length);
    }
  });

  it('thins the selection when the frames would crowd the wall', () => {
    const picked = selectFrames(many, { wallW: 60, wallH: 60, useAll: false, rng: createRng(3) });
    const area = picked.reduce((s, f) => s + f.area, 0);
    expect(picked.length).toBeLessThan(many.length);
    expect(area).toBeLessThan(many.reduce((s, f) => s + f.area, 0));
  });

  it('keeps the largest frames when thinning, since they anchor the wall', () => {
    // The result must be a prefix of the largest-first input: dropping the
    // biggest pieces instead of the smallest would change the whole character
    // of the arrangement.
    for (let seed = 0; seed < 20; seed++) {
      const picked = selectFrames(many, {
        wallW: 80,
        wallH: 80,
        useAll: false,
        rng: createRng(seed),
      });
      expect(picked.map((f) => f.id)).toEqual(many.slice(0, picked.length).map((f) => f.id));
    }
  });

  it('thins until the frames cover no more than 40% of the wall', () => {
    for (let seed = 0; seed < 20; seed++) {
      const wallW = 120;
      const wallH = 100;
      const picked = selectFrames(many, { wallW, wallH, useAll: false, rng: createRng(seed) });
      if (picked.length === many.length) continue;
      const area = picked.reduce((s, f) => s + f.area, 0);
      expect(area / (wallW * wallH)).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });

  it('keeps at least 60% of the frames it did not have to drop for crowding', () => {
    for (let seed = 0; seed < 20; seed++) {
      const picked = selectFrames(many, {
        wallW: 300,
        wallH: 200,
        useAll: false,
        rng: createRng(seed),
      });
      expect(picked.length).toBeGreaterThanOrEqual(Math.ceil(many.length * 0.6));
    }
  });

  it('returns frames the caller can mutate without corrupting the inventory', () => {
    // The annealer restarts several times from the same selection, so a shared
    // object would carry the previous restart's coordinates into the next one.
    const picked = selectFrames(many, { wallW: 300, wallH: 200, useAll: true, rng: createRng(1) });
    picked[0].x = 123;
    picked[0].rotated = true;
    expect(many[0].x).toBe(0);
    expect(many[0].rotated).toBe(false);
  });

  it('rejects a wall that has no usable area instead of laying out nonsense', () => {
    for (const [wallW, wallH] of [
      [0, 100],
      [-5, 100],
      [NaN, 100],
      [100, 0],
    ]) {
      expect(selectFrames(many, { wallW, wallH, useAll: false, rng: createRng(1) })).toEqual([]);
    }
  });

  it('prefers an odd count when asked and the range allows it', () => {
    let odd = 0;
    const trials = 40;
    for (let seed = 0; seed < trials; seed++) {
      const picked = selectFrames(many, {
        wallW: 300,
        wallH: 200,
        useAll: false,
        preferOdd: true,
        rng: createRng(seed),
      });
      if (picked.length % 2 === 1) odd++;
    }
    expect(odd).toBeGreaterThan(trials * 0.8);
  });

  it('is deterministic for a given seed', () => {
    const a = selectFrames(many, { wallW: 300, wallH: 200, useAll: false, rng: createRng(77) });
    const b = selectFrames(many, { wallW: 300, wallH: 200, useAll: false, rng: createRng(77) });
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });

  it('does not thin below the minimum, even on an absurdly small wall', () => {
    const picked = selectFrames(many, { wallW: 1, wallH: 1, useAll: false, rng: createRng(9) });
    expect(picked.length).toBeGreaterThanOrEqual(Math.min(MIN_FRAMES, many.length));
  });

  it('passes through small inventories the engine could not thin anyway', () => {
    const two = expandInventory([row(20, 30, 2)]);
    const picked = selectFrames(two, { wallW: 1, wallH: 1, useAll: false, rng: createRng(1) });
    expect(picked).toHaveLength(2);
  });

  it('handles an empty inventory', () => {
    expect(selectFrames([], { wallW: 10, wallH: 10, useAll: false, rng: createRng(1) })).toEqual(
      []
    );
  });
});
