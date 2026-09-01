import { describe, it, expect } from 'vitest';
import { findViolations, isValidLayout, repairLayout, EPSILON } from '../src/constraints.js';
import { clearance } from '../src/geometry.js';

const frame = (x, y, w, h) => ({ x, y, w, h, baseW: w, baseH: h, area: w * h, rotated: false });
const limits = (gap = 5, wallW = 200, wallH = 200) => ({ gap, wallW, wallH });

const minClearance = (frames) => {
  let min = Infinity;
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++)
      min = Math.min(min, clearance(frames[i], frames[j]));
  return min;
};

const allInBounds = (frames, wallW, wallH) =>
  frames.every(
    (f) =>
      f.x >= -EPSILON &&
      f.y >= -EPSILON &&
      f.x + f.w <= wallW + EPSILON &&
      f.y + f.h <= wallH + EPSILON
  );

describe('findViolations', () => {
  it('reports nothing for a valid layout', () => {
    const frames = [frame(10, 10, 20, 20), frame(50, 10, 20, 20)];
    const v = findViolations(frames, limits());
    expect(v.count).toBe(0);
    expect(v.overlaps).toEqual([]);
    expect(v.tooClose).toEqual([]);
    expect(v.outOfBounds).toEqual([]);
  });

  it('reports overlapping pairs', () => {
    const frames = [frame(10, 10, 20, 20), frame(20, 10, 20, 20)];
    expect(findViolations(frames, limits()).overlaps).toEqual([[0, 1]]);
  });

  it('reports pairs that are separated but closer than the gap', () => {
    const frames = [frame(10, 10, 20, 20), frame(32, 10, 20, 20)];
    const v = findViolations(frames, limits(5));
    expect(v.overlaps).toEqual([]);
    expect(v.tooClose).toEqual([[0, 1]]);
  });

  it('reports frames that leave the wall on any side', () => {
    const frames = [frame(-1, 10, 20, 20), frame(190, 10, 20, 20), frame(60, 195, 20, 20)];
    expect(findViolations(frames, limits(0)).outOfBounds).toEqual([0, 1, 2]);
  });

  it('accepts a clearance exactly equal to the gap', () => {
    const frames = [frame(0, 0, 20, 20), frame(25, 0, 20, 20)];
    expect(findViolations(frames, limits(5)).count).toBe(0);
  });

  it('accepts touching frames when the gap is zero', () => {
    const frames = [frame(0, 0, 20, 20), frame(20, 0, 20, 20)];
    expect(findViolations(frames, limits(0)).count).toBe(0);
  });

  it('tolerates floating point noise rather than rejecting on it', () => {
    const frames = [frame(0, 0, 20, 20), frame(25 - EPSILON / 2, 0, 20, 20)];
    expect(findViolations(frames, limits(5)).count).toBe(0);
  });

  it('handles empty and single-frame layouts', () => {
    expect(findViolations([], limits()).count).toBe(0);
    expect(findViolations([frame(10, 10, 20, 20)], limits()).count).toBe(0);
  });
});

describe('isValidLayout', () => {
  it('agrees with findViolations', () => {
    const good = [frame(10, 10, 20, 20), frame(50, 10, 20, 20)];
    const bad = [frame(10, 10, 20, 20), frame(20, 10, 20, 20)];
    expect(isValidLayout(good, limits())).toBe(true);
    expect(isValidLayout(bad, limits())).toBe(false);
  });
});

describe('repairLayout', () => {
  it('pushes overlapping frames apart to at least the requested gap', () => {
    const frames = [frame(50, 50, 20, 20), frame(58, 52, 20, 20)];
    expect(repairLayout(frames, limits(5))).toBe(true);
    expect(minClearance(frames)).toBeGreaterThanOrEqual(5 - EPSILON);
  });

  it('resolves a crowded pile of frames', () => {
    const frames = [];
    for (let i = 0; i < 8; i++) frames.push(frame(80 + i, 80 + i * 2, 20, 25));
    expect(repairLayout(frames, limits(4))).toBe(true);
    expect(minClearance(frames)).toBeGreaterThanOrEqual(4 - EPSILON);
    expect(allInBounds(frames, 200, 200)).toBe(true);
  });

  it('brings frames that hang off the wall back inside it', () => {
    const frames = [frame(-40, -30, 20, 20), frame(195, 190, 20, 20), frame(90, 90, 20, 20)];
    expect(repairLayout(frames, limits(5))).toBe(true);
    expect(allInBounds(frames, 200, 200)).toBe(true);
  });

  it('leaves an already valid layout valid', () => {
    const frames = [frame(10, 10, 20, 20), frame(50, 10, 20, 20), frame(90, 10, 20, 20)];
    expect(repairLayout(frames, limits(5))).toBe(true);
    expect(isValidLayout(frames, limits(5))).toBe(true);
  });

  it('does not move a layout that is already valid', () => {
    const frames = [frame(10, 10, 20, 20), frame(50, 10, 20, 20)];
    const before = JSON.parse(JSON.stringify(frames));
    repairLayout(frames, limits(5));
    expect(frames).toEqual(before);
  });

  it('never changes frame sizes or rotation', () => {
    const frames = [frame(50, 50, 20, 30), frame(55, 55, 20, 30), frame(60, 60, 20, 30)];
    frames[1].rotated = true;
    repairLayout(frames, limits(6));
    expect(frames.map((f) => [f.w, f.h, f.rotated])).toEqual([
      [20, 30, false],
      [20, 30, true],
      [20, 30, false],
    ]);
  });

  it('reports failure instead of looping forever when the frames cannot fit', () => {
    // Three 80 cm frames needing a 50 cm gap cannot fit on a 100 cm wall.
    const frames = [frame(0, 0, 80, 80), frame(5, 5, 80, 80), frame(10, 10, 80, 80)];
    expect(repairLayout(frames, limits(50, 100, 100))).toBe(false);
  });

  it('separates frames stacked at exactly the same position', () => {
    const frames = [frame(90, 90, 20, 20), frame(90, 90, 20, 20), frame(90, 90, 20, 20)];
    expect(repairLayout(frames, limits(5))).toBe(true);
    expect(minClearance(frames)).toBeGreaterThanOrEqual(5 - EPSILON);
  });

  it('breaks the tie the same way every time it is run', () => {
    // Coincident frames have no natural push direction. If the tie-break is not
    // deterministic, the same seed stops reproducing the same wall.
    const build = () => [frame(90, 90, 20, 20), frame(90, 90, 20, 20), frame(90, 90, 20, 20)];
    const a = build();
    const b = build();
    repairLayout(a, limits(5));
    repairLayout(b, limits(5));
    expect(a).toEqual(b);
  });

  it('is deterministic', () => {
    const build = () => [frame(50, 50, 20, 20), frame(56, 53, 20, 25), frame(61, 60, 30, 20)];
    const a = build();
    const b = build();
    repairLayout(a, limits(5));
    repairLayout(b, limits(5));
    expect(a).toEqual(b);
  });

  it('handles empty and single-frame layouts', () => {
    expect(repairLayout([], limits())).toBe(true);
    const one = [frame(-10, -10, 20, 20)];
    expect(repairLayout(one, limits(5))).toBe(true);
    expect(allInBounds(one, 200, 200)).toBe(true);
  });
});
