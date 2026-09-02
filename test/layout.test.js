import { describe, it, expect } from 'vitest';
import { generateLayout, DEFAULT_OPTIONS } from '../src/layout.js';
import { isValidLayout, EPSILON } from '../src/constraints.js';
import { boundingBox, clearance } from '../src/geometry.js';

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
        // The flag must agree with the dimensions: the renderer and the hanging
        // plan both label frames from it, so a stale flag mislabels the output.
        if (f.baseW !== f.baseH) expect(f.rotated).toBe(turned);
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

  it('builds real structure at the ordered end, not just more aligned pairs', () => {
    // The energy function can score a grid correctly and the search still never
    // find one: landing every frame on a shared line within the tolerance is a
    // needle for a random-scatter seed. This measures the same consolidation
    // the energy rewards -- candidate lines clustered, each cluster's distinct
    // frame count squared -- so it catches the search failing even when the
    // cost function is right.
    const TOLERANCE = 1.5;
    const consolidation = (frames) => {
      const n = frames.length;
      if (n < 2) return 0;
      let total = 0;
      for (const axis of ['x', 'y']) {
        const size = axis === 'x' ? 'w' : 'h';
        const coords = [];
        frames.forEach((f, i) => {
          coords.push([f[axis], i], [f[axis] + f[size] / 2, i], [f[axis] + f[size], i]);
        });
        coords.sort((a, b) => a[0] - b[0]);
        let start = 0;
        while (start < coords.length) {
          const anchor = coords[start][0];
          const members = new Set();
          let end = start;
          while (end < coords.length && coords[end][0] - anchor <= TOLERANCE) {
            members.add(coords[end][1]);
            end++;
          }
          if (members.size > 1) total += (members.size - 1) ** 2;
          start = end;
        }
      }
      return total / (2 * (n - 1) ** 2);
    };

    const measure = (order) => {
      let sum = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const { frames } = generateLayout({
          inventory: [
            { w: 20, h: 30, count: 3 },
            { w: 13, h: 18, count: 3 },
            { w: 10, h: 15, count: 3 },
          ],
          wallW: 250,
          wallH: 250,
          gap: 7,
          seed,
          options: { ...DEFAULT_OPTIONS, useAll: true, preferOdd: false, order },
        });
        sum += consolidation(frames);
      }
      return sum / 12;
    };

    // Without a grid seed this sat at 0.24; the salon end is around 0.07.
    expect(measure(1)).toBeGreaterThan(0.3);
    expect(measure(1)).toBeGreaterThan(measure(0) * 3);
  });

  // Shared helpers for the two composition tests below.
  const sweep = (order, measureOne) => {
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 15; seed++) {
      const { frames } = generateLayout({
        inventory,
        wallW: 250,
        wallH: 250,
        gap: 7,
        seed,
        options: { ...DEFAULT_OPTIONS, useAll: true, preferOdd: false, order },
      });
      if (frames.length < 3) continue;
      sum += measureOne(frames);
      n++;
    }
    return sum / n;
  };

  const medianNeighbourGap = (frames) => {
    const nearest = frames.map((a, i) =>
      Math.min(...frames.filter((_, j) => j !== i).map((b) => clearance(a, b)))
    );
    return nearest.sort((x, y) => x - y)[Math.floor(nearest.length / 2)];
  };

  it('groups the frames at the spacing asked for, not far beyond it', () => {
    // The gap setting is a minimum the engine must respect, but nothing used
    // to pull frames back together once annealing had pushed them apart, so
    // the ordered end drifted to a 10.7 cm median against the 7 cm requested
    // and the arrangement read as scattered rather than as one group.
    for (const order of [0, 0.5, 1]) {
      const median = sweep(order, medianNeighbourGap);
      expect(median, `order ${order}`).toBeGreaterThanOrEqual(7 - EPSILON);
      expect(median, `order ${order}`).toBeLessThan(9.5);
    }
  });

  it('rounds the outline instead of filling the corners of a rectangle', () => {
    // A gallery wall reads as a deliberate cluster when its silhouette is
    // rounded; a frame pushed into the corner of the bounding box is what
    // makes an arrangement look like a filled rectangle. This measures how far
    // outside the ellipse inscribed in its own bounding box each frame reaches.
    const cornerness = (frames) => {
      const box = boundingBox(frames);
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      const a = Math.max(1, box.width / 2);
      const b = Math.max(1, box.height / 2);
      let sum = 0;
      for (const f of frames) {
        let worst = 0;
        for (const [px, py] of [
          [f.x, f.y],
          [f.x + f.w, f.y],
          [f.x, f.y + f.h],
          [f.x + f.w, f.y + f.h],
        ]) {
          worst = Math.max(worst, Math.hypot((px - cx) / a, (py - cy) / b));
        }
        sum += Math.max(0, worst - 1);
      }
      return sum / frames.length;
    };

    // Measured at 0.156 to 0.165 across the slider before the silhouette term.
    for (const order of [0, 0.5]) {
      expect(sweep(order, cornerness), `order ${order}`).toBeLessThan(0.1);
    }
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
  it('centres the arrangement horizontally on the wall', () => {
    const { frames } = run({ seed: 3 });
    const box = boundingBox(frames);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(150, 6);
  });

  // The gallery convention is to put the centre of the whole group at eye
  // level, 145 cm up. Centring on the wall instead — which is what this did
  // before — hangs everything (145 - wallH/2) too low: 20 cm on a standard
  // 250 cm ceiling, 45 cm on the app's own default wall.
  it('puts the centre of the group at eye level, not the middle of the wall', () => {
    for (const wallH of [220, 240, 250, 260, 300]) {
      const { frames } = run({ wallH, seed: 3, centreHeight: 145 });
      const box = boundingBox(frames);
      const centreAboveFloor = wallH - (box.minY + box.maxY) / 2;
      expect(centreAboveFloor).toBeCloseTo(145, 6);
    }
  });

  it('keeps a group that cannot reach eye level on the wall', () => {
    // A short wall cannot put a tall group's centre at 145 cm without pushing
    // frames off the top; the anchor has to yield rather than hang them
    // through the ceiling.
    const { frames } = run({ wallH: 60, wallW: 400, seed: 3, centreHeight: 145 });
    const box = boundingBox(frames);
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
    expect(box.maxY).toBeLessThanOrEqual(60 + 1e-6);
  });

  it('falls back to centring on the wall when no eye level is given', () => {
    const { frames } = run({ seed: 3, centreHeight: 0 });
    const box = boundingBox(frames);
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
