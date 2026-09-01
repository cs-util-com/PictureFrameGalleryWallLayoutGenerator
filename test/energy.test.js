import { describe, it, expect } from 'vitest';
import { createEnergyContext, computeEnergy } from '../src/energy.js';

const frame = (x, y, w, h, extra = {}) => ({
  x,
  y,
  w,
  h,
  baseW: extra.baseW ?? w,
  baseH: extra.baseH ?? h,
  area: (extra.baseW ?? w) * (extra.baseH ?? h),
  rotated: extra.rotated ?? false,
});

const ctx = (overrides = {}) =>
  createEnergyContext({
    wallW: 200,
    wallH: 200,
    gap: 5,
    order: 0.5,
    mixSizes: true,
    allowRotation: true,
    targetAspect: 1,
    ...overrides,
  });

const total = (frames, c = ctx()) => computeEnergy(frames, c).total;

describe('computeEnergy', () => {
  it('returns a finite total and one score per frame', () => {
    const frames = [frame(10, 10, 20, 30), frame(50, 10, 20, 30), frame(90, 10, 20, 30)];
    const result = computeEnergy(frames, ctx());
    expect(Number.isFinite(result.total)).toBe(true);
    expect(result.perFrame).toHaveLength(3);
    for (const score of result.perFrame) expect(Number.isFinite(score)).toBe(true);
  });

  it('does not mutate the frames it scores', () => {
    const frames = [frame(10, 10, 20, 30), frame(50, 10, 20, 30)];
    const snapshot = JSON.parse(JSON.stringify(frames));
    computeEnergy(frames, ctx());
    expect(frames).toEqual(snapshot);
  });

  it('is pure: the same input scores the same twice', () => {
    const frames = [frame(10, 10, 20, 30), frame(50, 40, 20, 30), frame(90, 10, 30, 30)];
    const c = ctx();
    expect(computeEnergy(frames, c).total).toBe(computeEnergy(frames, c).total);
  });

  it('handles an empty layout without producing NaN', () => {
    const result = computeEnergy([], ctx());
    expect(Number.isFinite(result.total)).toBe(true);
    expect(result.perFrame).toEqual([]);
  });

  it('handles a single frame without producing NaN', () => {
    expect(Number.isFinite(total([frame(50, 50, 20, 30)]))).toBe(true);
  });
});

describe('hard-constraint terms', () => {
  it('penalises overlapping frames more than separated ones', () => {
    const apart = [frame(10, 10, 20, 20), frame(60, 10, 20, 20)];
    const overlapping = [frame(10, 10, 20, 20), frame(20, 10, 20, 20)];
    expect(total(overlapping)).toBeGreaterThan(total(apart));
  });

  it('grows the overlap penalty with the overlapping area', () => {
    const slight = [frame(10, 10, 20, 20), frame(28, 10, 20, 20)];
    const heavy = [frame(10, 10, 20, 20), frame(12, 10, 20, 20)];
    const c = ctx();
    expect(computeEnergy(heavy, c).terms.overlap).toBeGreaterThan(
      computeEnergy(slight, c).terms.overlap
    );
  });

  it('penalises frames that are closer than the requested gap', () => {
    const c = ctx({ gap: 10 });
    const tooClose = [frame(10, 10, 20, 20), frame(33, 10, 20, 20)];
    const respectful = [frame(10, 10, 20, 20), frame(40, 10, 20, 20)];
    expect(computeEnergy(tooClose, c).terms.gap).toBeGreaterThan(0);
    expect(computeEnergy(respectful, c).terms.gap).toBe(0);
  });

  it('charges nothing for the gap term when the gap is zero', () => {
    const c = ctx({ gap: 0 });
    const touching = [frame(10, 10, 20, 20), frame(30, 10, 20, 20)];
    expect(computeEnergy(touching, c).terms.gap).toBe(0);
  });

  it('penalises frames that hang off the wall', () => {
    const c = ctx();
    const inside = [frame(10, 10, 20, 20), frame(60, 10, 20, 20)];
    const outside = [frame(-30, 10, 20, 20), frame(60, 10, 20, 20)];
    expect(computeEnergy(outside, c).terms.bounds).toBeGreaterThan(0);
    expect(computeEnergy(inside, c).terms.bounds).toBe(0);
  });

  it('attributes a violation to the frames responsible for it', () => {
    const frames = [frame(10, 10, 20, 20), frame(12, 10, 20, 20), frame(120, 120, 20, 20)];
    const { perFrame } = computeEnergy(frames, ctx());
    expect(perFrame[0]).toBeGreaterThan(perFrame[2]);
    expect(perFrame[1]).toBeGreaterThan(perFrame[2]);
  });
});

describe('aesthetic terms', () => {
  it('prefers a visually balanced arrangement over a lopsided one', () => {
    const c = ctx();
    // Symmetric: the visual weight sits on the arrangement's own centre line.
    const balanced = [frame(0, 40, 20, 20), frame(60, 40, 20, 20), frame(30, 0, 20, 20)];
    // Same silhouette, but all the mass is bunched to the left of it.
    const lopsided = [frame(0, 0, 40, 60), frame(60, 40, 10, 10), frame(70, 0, 10, 10)];
    expect(computeEnergy(balanced, c).terms.balanceX).toBeLessThan(
      computeEnergy(lopsided, c).terms.balanceX
    );
  });

  it('scores a symmetric arrangement as perfectly balanced', () => {
    const c = ctx();
    const symmetric = [frame(0, 40, 20, 20), frame(60, 40, 20, 20), frame(30, 0, 20, 20)];
    expect(computeEnergy(symmetric, c).terms.balanceX).toBeCloseTo(0, 10);
  });

  it('does not charge a frame sitting on the centre line as maximum imbalance', () => {
    const c = ctx();
    // Two frames either side plus one straddling the axis: still balanced.
    const straddling = [frame(0, 0, 20, 20), frame(60, 0, 20, 20), frame(30, 30, 20, 20)];
    expect(computeEnergy(straddling, c).terms.balanceX).toBeCloseTo(0, 10);
  });

  it('measures balance within the arrangement, not against the wall', () => {
    // The renderer centres the finished block on the wall, so where the block
    // happens to sit during annealing must not affect its balance score.
    const c = ctx();
    const atOrigin = [frame(0, 40, 20, 20), frame(60, 40, 20, 20), frame(30, 0, 20, 20)];
    const shifted = atOrigin.map((f) => ({ ...f, x: f.x + 90 }));
    expect(computeEnergy(shifted, c).terms.balanceX).toBeCloseTo(
      computeEnergy(atOrigin, c).terms.balanceX,
      10
    );
  });

  it('penalises large empty holes inside the arrangement', () => {
    const c = ctx();
    const tight = [frame(0, 0, 20, 20), frame(25, 0, 20, 20), frame(0, 25, 20, 20)];
    const scattered = [frame(0, 0, 20, 20), frame(160, 0, 20, 20), frame(0, 160, 20, 20)];
    expect(computeEnergy(scattered, c).terms.voids).toBeGreaterThan(
      computeEnergy(tight, c).terms.voids
    );
  });

  it('pulls the arrangement toward the target aspect ratio', () => {
    const wide = createEnergyContext({
      wallW: 200,
      wallH: 200,
      gap: 5,
      order: 0.5,
      mixSizes: false,
      allowRotation: false,
      targetAspect: 3,
    });
    const wideLayout = [frame(0, 90, 20, 20), frame(60, 90, 20, 20), frame(120, 90, 20, 20)];
    const squareLayout = [frame(0, 0, 20, 20), frame(60, 0, 20, 20), frame(0, 60, 20, 20)];
    expect(computeEnergy(wideLayout, wide).terms.aspect).toBeLessThan(
      computeEnergy(squareLayout, wide).terms.aspect
    );
  });

  it('rewards edge alignment in an ordered hang and penalises it in a salon hang', () => {
    // The slider is the main aesthetic control, so it has to have real range:
    // an ordered hang should pull frames into line and a salon hang should
    // actively avoid lining them up, rather than merely not rewarding it.
    const aligned = [frame(0, 0, 20, 20), frame(30, 0, 20, 20), frame(60, 0, 20, 20)];
    expect(computeEnergy(aligned, ctx({ order: 1 })).terms.alignment).toBeLessThan(0);
    expect(computeEnergy(aligned, ctx({ order: 0 })).terms.alignment).toBeGreaterThan(0);
  });

  it('is indifferent to alignment at the middle of the slider', () => {
    const aligned = [frame(0, 0, 20, 20), frame(30, 0, 20, 20), frame(60, 0, 20, 20)];
    expect(computeEnergy(aligned, ctx({ order: 0.5 })).terms.alignment).toBeCloseTo(0, 10);
  });

  it('keeps rewarding further alignment rather than saturating', () => {
    // Counting frames that have any aligned partner saturates almost at once:
    // most random layouts already have one. The gradient has to come from how
    // many *pairs* line up.
    const c = ctx({ order: 1 });
    const twoOfFour = [
      frame(0, 0, 20, 20),
      frame(30, 0, 20, 20),
      frame(7, 60, 20, 20),
      frame(64, 91, 20, 20),
    ];
    const allFour = [
      frame(0, 0, 20, 20),
      frame(30, 0, 20, 20),
      frame(0, 30, 20, 20),
      frame(30, 30, 20, 20),
    ];
    expect(computeEnergy(allFour, c).terms.alignment).toBeLessThan(
      computeEnergy(twoOfFour, c).terms.alignment
    );
  });

  it('charges nothing either way when no frames line up', () => {
    const scattered = [frame(0, 0, 20, 20), frame(37, 43, 14, 26), frame(71, 91, 18, 12)];
    expect(computeEnergy(scattered, ctx({ order: 1 })).terms.alignment).toBeCloseTo(0, 10);
    expect(computeEnergy(scattered, ctx({ order: 0 })).terms.alignment).toBeCloseTo(0, 10);
  });

  it('penalises long grid-like runs in salon mode but tolerates them when ordered', () => {
    const grid = [
      frame(0, 0, 20, 20),
      frame(30, 0, 20, 20),
      frame(60, 0, 20, 20),
      frame(90, 0, 20, 20),
      frame(120, 0, 20, 20),
    ];
    const salon = computeEnergy(grid, ctx({ order: 0 })).terms.rows;
    const ordered = computeEnergy(grid, ctx({ order: 1 })).terms.rows;
    expect(salon).toBeGreaterThan(0);
    expect(ordered).toBeLessThan(salon);
  });

  it('charges nothing for rotation mix when rotation is disabled', () => {
    const c = ctx({ allowRotation: false });
    const frames = [
      frame(0, 0, 20, 30),
      frame(40, 0, 20, 30),
      frame(80, 0, 20, 30),
      frame(120, 0, 20, 30),
    ];
    expect(computeEnergy(frames, c).terms.rotationMix).toBe(0);
  });

  it('penalises rotating either none or all of the rectangular frames', () => {
    const c = ctx({ allowRotation: true });
    const build = (rotatedCount) =>
      Array.from({ length: 4 }, (_, i) => {
        const rotated = i < rotatedCount;
        return frame(i * 45, 0, rotated ? 30 : 20, rotated ? 20 : 30, {
          baseW: 20,
          baseH: 30,
          rotated,
        });
      });
    const none = computeEnergy(build(0), c).terms.rotationMix;
    const mixed = computeEnergy(build(2), c).terms.rotationMix;
    const all = computeEnergy(build(4), c).terms.rotationMix;
    expect(mixed).toBe(0);
    expect(none).toBeGreaterThan(0);
    expect(all).toBeGreaterThan(0);
  });

  it('ignores rotation mix for square frames, which cannot be rotated meaningfully', () => {
    const c = ctx({ allowRotation: true });
    const squares = [
      frame(0, 0, 20, 20),
      frame(40, 0, 20, 20),
      frame(80, 0, 20, 20),
      frame(120, 0, 20, 20),
    ];
    expect(computeEnergy(squares, c).terms.rotationMix).toBe(0);
  });

  it('charges nothing for size dispersion when mixing is disabled', () => {
    const frames = [
      frame(0, 0, 40, 40),
      frame(50, 0, 40, 40),
      frame(0, 50, 10, 10),
      frame(50, 50, 10, 10),
    ];
    expect(computeEnergy(frames, ctx({ mixSizes: false })).terms.dispersion).toBe(0);
  });

  it('penalises segregating the big frames into their own corner', () => {
    const c = ctx({ mixSizes: true });
    // Big frames in a block on the left, small frames in a block on the right.
    const segregated = [
      frame(0, 0, 40, 40),
      frame(50, 0, 40, 40),
      frame(0, 50, 40, 40),
      frame(50, 50, 40, 40),
      frame(120, 0, 10, 10),
      frame(150, 0, 10, 10),
      frame(120, 30, 10, 10),
      frame(150, 30, 10, 10),
    ];
    // The same eight frames, sizes spread across the same area.
    const mixed = [
      frame(0, 0, 40, 40),
      frame(50, 0, 10, 10),
      frame(0, 50, 10, 10),
      frame(50, 50, 40, 40),
      frame(120, 0, 10, 10),
      frame(150, 0, 40, 40),
      frame(120, 30, 40, 40),
      frame(150, 60, 10, 10),
    ];
    expect(computeEnergy(segregated, c).terms.dispersion).toBeGreaterThan(0);
    expect(computeEnergy(mixed, c).terms.dispersion).toBeLessThan(
      computeEnergy(segregated, c).terms.dispersion
    );
  });

  it('catches segregation even when every frame sees the same neighbour mix', () => {
    // A row of two big then three small frames. The metric this replaced scored
    // this exactly 0 — every frame happens to have one big and two small
    // neighbours — despite the sizes being plainly sorted along the wall.
    const c = ctx({ mixSizes: true });
    const sortedRow = [
      frame(0, 0, 40, 40),
      frame(50, 0, 40, 40),
      frame(110, 0, 10, 10),
      frame(130, 0, 10, 10),
      frame(150, 0, 10, 10),
    ];
    expect(computeEnergy(sortedRow, c).terms.dispersion).toBeGreaterThan(0);
  });

  it('charges nothing when every frame is the same size', () => {
    const c = ctx({ mixSizes: true });
    const uniform = [
      frame(0, 0, 20, 20),
      frame(40, 0, 20, 20),
      frame(0, 40, 20, 20),
      frame(40, 40, 20, 20),
    ];
    expect(computeEnergy(uniform, c).terms.dispersion).toBe(0);
  });

  it('does not reward an artificial checkerboard below zero', () => {
    const c = ctx({ mixSizes: true });
    const alternating = [
      frame(0, 0, 40, 40),
      frame(50, 0, 10, 10),
      frame(70, 0, 40, 40),
      frame(120, 0, 10, 10),
      frame(140, 0, 40, 40),
    ];
    expect(computeEnergy(alternating, c).terms.dispersion).toBe(0);
  });
});
