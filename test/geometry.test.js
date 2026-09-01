import { describe, it, expect } from 'vitest';
import {
  clearance,
  overlapArea,
  intersects,
  boundingBox,
  centerOf,
  clampToBounds,
  rotateRect,
} from '../src/geometry.js';

const rect = (x, y, w, h) => ({ x, y, w, h });

describe('clearance', () => {
  it('returns the horizontal gap for side-by-side rectangles', () => {
    expect(clearance(rect(0, 0, 10, 10), rect(15, 0, 10, 10))).toBe(5);
  });

  it('returns the vertical gap for stacked rectangles', () => {
    expect(clearance(rect(0, 0, 10, 10), rect(0, 13, 10, 10))).toBe(3);
  });

  it('is symmetric', () => {
    const a = rect(0, 0, 10, 20);
    const b = rect(4, 30, 7, 3);
    expect(clearance(a, b)).toBe(clearance(b, a));
  });

  it('returns 0 for rectangles that touch exactly', () => {
    expect(clearance(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(0);
  });

  it('is negative only when the rectangles genuinely overlap', () => {
    expect(clearance(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBeLessThan(0);
    // Diagonally offset but separated on both axes: still a positive gap.
    expect(clearance(rect(0, 0, 10, 10), rect(20, 20, 10, 10))).toBeGreaterThan(0);
  });

  it('uses the larger axis separation for diagonal neighbours', () => {
    // 10 apart horizontally, 3 apart vertically -> the frames are 10 apart.
    expect(clearance(rect(0, 0, 10, 10), rect(20, 13, 10, 10))).toBe(10);
  });
});

describe('overlapArea', () => {
  it('is zero for disjoint rectangles', () => {
    expect(overlapArea(rect(0, 0, 10, 10), rect(20, 0, 10, 10))).toBe(0);
  });

  it('is zero for touching rectangles', () => {
    expect(overlapArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(0);
  });

  it('measures the intersection of overlapping rectangles', () => {
    expect(overlapArea(rect(0, 0, 10, 10), rect(6, 6, 10, 10))).toBe(16);
  });

  it('returns the smaller area when one rectangle contains the other', () => {
    expect(overlapArea(rect(0, 0, 10, 10), rect(2, 2, 3, 4))).toBe(12);
  });
});

describe('intersects', () => {
  it('agrees with a negative clearance', () => {
    const pairs = [
      [rect(0, 0, 10, 10), rect(5, 5, 10, 10)],
      [rect(0, 0, 10, 10), rect(10, 0, 10, 10)],
      [rect(0, 0, 10, 10), rect(20, 20, 5, 5)],
    ];
    for (const [a, b] of pairs) {
      expect(intersects(a, b)).toBe(clearance(a, b) < 0);
    }
  });
});

describe('boundingBox', () => {
  it('returns null for an empty list', () => {
    expect(boundingBox([])).toBeNull();
  });

  it('spans all rectangles', () => {
    const box = boundingBox([rect(10, 5, 10, 10), rect(0, 20, 4, 4), rect(30, 0, 2, 2)]);
    expect(box).toEqual({ minX: 0, minY: 0, maxX: 32, maxY: 24, width: 32, height: 24 });
  });
});

describe('centerOf', () => {
  it('returns the geometric centre', () => {
    expect(centerOf(rect(10, 20, 4, 8))).toEqual({ x: 12, y: 24 });
  });
});

describe('clampToBounds', () => {
  it('leaves a rectangle that already fits untouched', () => {
    const r = rect(10, 10, 20, 20);
    clampToBounds(r, 100, 100);
    expect(r).toEqual(rect(10, 10, 20, 20));
  });

  it('pushes a rectangle back inside the wall', () => {
    const r = rect(-5, 95, 20, 20);
    clampToBounds(r, 100, 100);
    expect(r.x).toBe(0);
    expect(r.y).toBe(80);
  });

  it('pins oversized rectangles to the origin instead of producing negatives', () => {
    const r = rect(-5, -5, 200, 200);
    clampToBounds(r, 100, 100);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('rotateRect', () => {
  it('swaps width and height while keeping the centre fixed', () => {
    const r = { x: 10, y: 10, w: 20, h: 40, rotated: false };
    const before = centerOf(r);
    rotateRect(r);
    expect(r.w).toBe(40);
    expect(r.h).toBe(20);
    expect(r.rotated).toBe(true);
    expect(centerOf(r)).toEqual(before);
  });

  it('is its own inverse', () => {
    const r = { x: 3, y: 7, w: 20, h: 40, rotated: false };
    const copy = { ...r };
    rotateRect(r);
    rotateRect(r);
    expect(r).toEqual(copy);
  });
});
