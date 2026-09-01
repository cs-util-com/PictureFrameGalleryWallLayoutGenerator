import { describe, it, expect } from 'vitest';
import { generateLayout, DEFAULT_OPTIONS } from '../src/layout.js';
import { isValidLayout, EPSILON } from '../src/constraints.js';
import { boundingBox } from '../src/geometry.js';

const inventory = [
  { w: 20, h: 30, count: 2 },
  { w: 13, h: 18, count: 2 },
  { w: 10, h: 15, count: 4 },
];

const run = (overrides = {}) =>
  generateLayout({
    inventory,
    wallW: 300,
    wallH: 200,
    gap: 7,
    seed: 1,
    options: DEFAULT_OPTIONS,
    ...overrides,
  });

describe('generateLayout: hard invariants', () => {
  // The whole point of the engine is that whatever it returns can actually be
  // hung on the wall. This sweeps the parameter space rather than spot-checking.
  it('never returns a layout that breaks a physical rule', () => {
    const walls = [
      [300, 200],
      [150, 220],
      [120, 100],
      [500, 120],
    ];
    const gaps = [0, 3, 7, 15];

    for (const [wallW, wallH] of walls) {
      for (const gap of gaps) {
        for (let seed = 0; seed < 6; seed++) {
          for (const useAll of [true, false]) {
            const result = generateLayout({
              inventory,
              wallW,
              wallH,
              gap,
              seed,
              options: { ...DEFAULT_OPTIONS, useAll },
            });
            const limits = { gap, wallW, wallH };
            expect(
              isValidLayout(result.frames, limits),
              `seed ${seed}, wall ${wallW}x${wallH}, gap ${gap}, useAll ${useAll}`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('keeps every frame on the wall', () => {
    for (let seed = 0; seed < 10; seed++) {
      const { frames } = run({ seed });
      for (const f of frames) {
        expect(f.x).toBeGreaterThanOrEqual(-EPSILON);
        expect(f.y).toBeGreaterThanOrEqual(-EPSILON);
        expect(f.x + f.w).toBeLessThanOrEqual(300 + EPSILON);
        expect(f.y + f.h).toBeLessThanOrEqual(200 + EPSILON);
      }
    }
  });

  it('only ever presents a frame at its real size or that size turned 90 degrees', () => {
    for (let seed = 0; seed < 10; seed++) {
      const { frames } = run({ seed, options: { ...DEFAULT_OPTIONS, allowRotation: true } });
      for (const f of frames) {
        const asIs = f.w === f.baseW && f.h === f.baseH;
        const turned = f.w === f.baseH && f.h === f.baseW;
        expect(asIs || turned).toBe(true);
        expect(f.rotated).toBe(!asIs || f.baseW === f.baseH ? f.rotated : false);
      }
    }
  });
});

describe('generateLayout: reproducibility', () => {
  it('produces an identical layout for the same seed and inputs', () => {
    const a = run({ seed: 4242 });
    const b = run({ seed: 4242 });
    expect(a.frames).toEqual(b.frames);
    expect(a.placed).toBe(b.placed);
  });

  it('produces different layouts for different seeds', () => {
    const a = run({ seed: 1 });
    const b = run({ seed: 2 });
    expect(a.frames).not.toEqual(b.frames);
  });

  it('is unaffected by how many times it has already been called', () => {
    const first = run({ seed: 9 });
    run({ seed: 10 });
    run({ seed: 11 });
    expect(run({ seed: 9 }).frames).toEqual(first.frames);
  });

  it('does not mutate the inventory it was given', () => {
    const rows = JSON.parse(JSON.stringify(inventory));
    run({ inventory: rows });
    expect(rows).toEqual(inventory);
  });
});

describe('generateLayout: options', () => {
  it('leaves every frame unrotated when rotation is disabled', () => {
    for (let seed = 0; seed < 10; seed++) {
      const { frames } = run({ seed, options: { ...DEFAULT_OPTIONS, allowRotation: false } });
      for (const f of frames) {
        expect(f.rotated).toBe(false);
        expect(f.w).toBe(f.baseW);
        expect(f.h).toBe(f.baseH);
      }
    }
  });

  it('hangs every frame when asked to and the wall has room', () => {
    const { frames, total } = run({ options: { ...DEFAULT_OPTIONS, useAll: true } });
    expect(frames).toHaveLength(total);
  });

  it('hangs a subset when not asked to use everything', () => {
    const relaxed = run({ options: { ...DEFAULT_OPTIONS, useAll: false } });
    expect(relaxed.placed).toBeLessThanOrEqual(relaxed.total);
  });

  it('lines up visibly more frames at the ordered end of the slider', () => {
    // An end-to-end check that the Style slider actually changes the result;
    // the energy term alone can look right while saturating in practice.
    const near = (a, b) => Math.abs(a - b) < 1.5;
    const alignedShare = (frames) => {
      let aligned = 0;
      let pairs = 0;
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) {
          pairs++;
          const a = frames[i];
          const b = frames[j];
          const x =
            near(a.x, b.x) ||
            near(a.x + a.w, b.x + b.w) ||
            near(a.x, b.x + b.w) ||
            near(a.x + a.w, b.x);
          const y =
            near(a.y, b.y) ||
            near(a.y + a.h, b.y + b.h) ||
            near(a.y, b.y + b.h) ||
            near(a.y + a.h, b.y);
          if (x || y) aligned++;
        }
      }
      return pairs ? aligned / pairs : 0;
    };

    const measure = (order) => {
      let sum = 0;
      let n = 0;
      for (let seed = 0; seed < 12; seed++) {
        const { frames } = generateLayout({
          inventory: [
            { w: 20, h: 30, count: 3 },
            { w: 13, h: 18, count: 3 },
            { w: 10, h: 15, count: 3 },
          ],
          wallW: 200,
          wallH: 160,
          gap: 6,
          seed,
          options: { ...DEFAULT_OPTIONS, useAll: true, order },
        });
        if (frames.length > 2) {
          sum += alignedShare(frames);
          n++;
        }
      }
      return sum / n;
    };

    expect(measure(1)).toBeGreaterThan(measure(0) * 1.5);
  });

  it('accepts both ends of the order slider', () => {
    for (const order of [0, 0.5, 1]) {
      const result = run({ options: { ...DEFAULT_OPTIONS, order } });
      expect(isValidLayout(result.frames, { gap: 7, wallW: 300, wallH: 200 })).toBe(true);
      expect(result.frames.length).toBeGreaterThan(0);
    }
  });
});

describe('generateLayout: composition', () => {
  it('centres the arrangement on the wall', () => {
    const { frames } = run({ seed: 3 });
    const box = boundingBox(frames);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(150, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(100, 6);
  });

  it('reports the bounding box and coverage of what it placed', () => {
    const result = run({ seed: 3 });
    const box = boundingBox(result.frames);
    expect(result.bbox.width).toBeCloseTo(box.width, 6);
    expect(result.bbox.height).toBeCloseTo(box.height, 6);
    const area = result.frames.reduce((s, f) => s + f.area, 0);
    expect(result.coverage).toBeCloseTo(area / (300 * 200), 6);
  });
});

describe('generateLayout: degenerate input', () => {
  it('returns an empty layout and says why when there are no frames', () => {
    const result = run({ inventory: [] });
    expect(result.frames).toEqual([]);
    expect(result.placed).toBe(0);
    expect(result.notices).toContain('empty-inventory');
  });

  it('returns an empty layout for an inventory of zero counts', () => {
    const result = run({ inventory: [{ w: 20, h: 30, count: 0 }] });
    expect(result.frames).toEqual([]);
    expect(result.notices).toContain('empty-inventory');
  });

  it('survives input that is not an inventory at all', () => {
    for (const bad of [undefined, null, 'frames', 7]) {
      const result = run({ inventory: bad });
      expect(result.frames).toEqual([]);
    }
  });

  it('drops frames and says so when they cannot all fit', () => {
    const tooMany = [{ w: 40, h: 50, count: 12 }];
    const result = generateLayout({
      inventory: tooMany,
      wallW: 120,
      wallH: 100,
      gap: 10,
      seed: 1,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });
    expect(result.placed).toBeLessThan(result.total);
    expect(result.notices).toContain('frames-dropped');
    expect(isValidLayout(result.frames, { gap: 10, wallW: 120, wallH: 100 })).toBe(true);
  });

  it('reports that nothing fits rather than returning an impossible layout', () => {
    const result = generateLayout({
      inventory: [{ w: 100, h: 100, count: 4 }],
      wallW: 60,
      wallH: 60,
      gap: 5,
      seed: 1,
      options: DEFAULT_OPTIONS,
    });
    expect(result.frames).toEqual([]);
    expect(result.notices).toContain('does-not-fit');
  });

  it('handles a single frame', () => {
    const result = run({ inventory: [{ w: 20, h: 30, count: 1 }] });
    expect(result.frames).toHaveLength(1);
    expect(isValidLayout(result.frames, { gap: 7, wallW: 300, wallH: 200 })).toBe(true);
  });

  it('handles a gap wider than the wall', () => {
    const result = generateLayout({
      inventory,
      wallW: 100,
      wallH: 100,
      gap: 50,
      seed: 1,
      options: DEFAULT_OPTIONS,
    });
    expect(isValidLayout(result.frames, { gap: 50, wallW: 100, wallH: 100 })).toBe(true);
  });

  it('rejects a wall with no usable size', () => {
    for (const [wallW, wallH] of [
      [0, 200],
      [-10, 200],
      [300, 0],
    ]) {
      const result = run({ wallW, wallH });
      expect(result.frames).toEqual([]);
      expect(result.notices).toContain('invalid-wall');
    }
  });
});

describe('generateLayout: cost', () => {
  const big = [
    { w: 30, h: 40, count: 10 },
    { w: 20, h: 30, count: 15 },
    { w: 13, h: 18, count: 15 },
  ];

  const layOutBig = () =>
    generateLayout({
      inventory: big,
      wallW: 400,
      wallH: 300,
      gap: 5,
      seed: 1,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });

  it('does a bounded amount of work on a large inventory', () => {
    // The original could spend hundreds of annealing runs on a dead end and
    // lock the browser tab. This counts the work rather than timing it: a
    // wall-clock assertion is at the mercy of the runner's speed and of
    // coverage instrumentation, which alone makes this suite ten times slower.
    const result = layOutBig();
    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.stats.energyEvaluations).toBeLessThan(40000);
    expect(result.stats.attempts).toBeLessThanOrEqual(3);
  });

  it('scales its effort with the frame count rather than exploding', () => {
    const small = generateLayout({
      inventory: [{ w: 20, h: 30, count: 6 }],
      wallW: 400,
      wallH: 300,
      gap: 5,
      seed: 1,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });
    const large = layOutBig();
    // Roughly seven times the frames must not mean orders of magnitude more
    // work -- that superlinear blow-up is what made the original unusable.
    expect(large.stats.energyEvaluations).toBeLessThan(small.stats.energyEvaluations * 6);
  });

  it('does not restart the whole search once per dropped frame', () => {
    // Shrinking the wall under a large inventory is an ordinary thing to do,
    // and dropping one frame per full search made it a tab-lock: 55 complete
    // 3-run searches, tens of seconds of blocked main thread.
    const result = generateLayout({
      inventory: [{ w: 30, h: 40, count: 60 }],
      wallW: 120,
      wallH: 100,
      gap: 5,
      seed: 1,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });
    expect(result.stats.attempts).toBeLessThan(12);
    expect(result.placed).toBeGreaterThan(0);
    expect(isValidLayout(result.frames, { gap: 5, wallW: 120, wallH: 100 })).toBe(true);
  });

  it('still finds close to as many frames as fit when it has to drop some', () => {
    // Searching for the count must not cost so much quality that the wall ends
    // up half empty.
    const result = generateLayout({
      inventory: [{ w: 30, h: 40, count: 60 }],
      wallW: 200,
      wallH: 160,
      gap: 4,
      seed: 3,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });
    expect(result.placed).toBeGreaterThanOrEqual(10);
  });

  it('stays responsive when the frames do not fit', () => {
    const started = Date.now();
    generateLayout({
      inventory: [{ w: 30, h: 40, count: 60 }],
      wallW: 120,
      wallH: 100,
      gap: 5,
      seed: 1,
      options: { ...DEFAULT_OPTIONS, useAll: true },
    });
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it('stays responsive in wall-clock terms too', () => {
    // Deliberately loose: this only catches a catastrophic regression, such as
    // a return to deep-cloning the layout on every iteration.
    const started = Date.now();
    layOutBig();
    expect(Date.now() - started).toBeLessThan(60000);
  });
});
