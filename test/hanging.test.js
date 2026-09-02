import { describe, it, expect } from 'vitest';
import { hangingPlan } from '../src/hanging.js';

const frame = (x, y, w, h, extra = {}) => ({
  x,
  y,
  w,
  h,
  baseW: extra.baseW ?? w,
  baseH: extra.baseH ?? h,
  area: w * h,
  rotated: extra.rotated ?? false,
});

const wall = { wallW: 300, wallH: 200 };

describe('hangingPlan', () => {
  it('describes every frame', () => {
    const frames = [frame(10, 10, 20, 30), frame(50, 10, 20, 30)];
    expect(hangingPlan(frames, wall).items).toHaveLength(2);
  });

  it('lists frames in reading order: top row first, then left to right', () => {
    const frames = [
      frame(100, 100, 20, 20), // bottom right
      frame(10, 100, 20, 20), // bottom left
      frame(100, 10, 20, 20), // top right
      frame(10, 10, 20, 20), // top left
    ];
    const positions = hangingPlan(frames, wall).items.map((i) => [i.left, i.top]);
    expect(positions).toEqual([
      [10, 10],
      [100, 10],
      [10, 100],
      [100, 100],
    ]);
  });

  it('treats frames within a row tolerance as the same row', () => {
    // Two frames whose tops differ by 2 cm still belong to one visual row, and
    // should be ordered left to right rather than by that 2 cm difference.
    const frames = [frame(100, 10, 20, 20), frame(10, 12, 20, 20)];
    expect(hangingPlan(frames, wall).items.map((i) => i.left)).toEqual([10, 100]);
  });

  // "Within 5 cm of" is not an equivalence relation, and sort() on a
  // non-transitive comparator may return anything. Before banding, 14% of
  // permutations of the same frames came back in a different order.
  it('gives the same order however the frames arrive', () => {
    const rnd = (s) => {
      let t = s + 0x6d2b79f5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const plan = (set) =>
      hangingPlan(set, wall)
        .items.map((i) => `${i.left},${i.top}`)
        .join('|');

    for (let trial = 0; trial < 40; trial++) {
      const n = 6 + Math.floor(rnd(trial * 7) * 6);
      const base = Array.from({ length: n }, (_, i) =>
        frame(
          Math.round(rnd(trial * 100 + i) * 200),
          Math.round(rnd(trial * 100 + i + 50) * 60),
          10,
          10
        )
      );
      const reference = plan(base);
      for (let p = 0; p < 8; p++) {
        const shuffled = [...base];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd(trial * 1000 + p * 10 + i) * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        expect(plan(shuffled)).toBe(reference);
      }
    }
  });

  it('keeps a mixed-size row together, because rows band on centre lines', () => {
    // A 40 cm and a 10 cm frame on one centre line have tops 15 cm apart.
    // Banding by top edge sent you across the wall and back to collect the
    // short one -- exactly the mixed-size row a Kantenhängung is built from.
    const frames = [
      frame(0, 100, 20, 40), // centre y 120
      frame(30, 115, 20, 10), // centre y 120
      frame(60, 100, 20, 40), // centre y 120
    ];
    expect(hangingPlan(frames, wall).items.map((i) => i.left)).toEqual([0, 30, 60]);
  });

  it('keeps a mixed-size row together whichever way the short frame sits', () => {
    // The band tolerance scaled to the *joining* frame's height, measured from
    // the opener's centre, which is asymmetric: a short frame sitting below a
    // tall row's centre line fell out of the band and you walked back for it.
    const rowWith = (shortY) => [
      frame(0, 80, 20, 40), // centre y 100
      frame(30, shortY, 20, 10),
      frame(60, 80, 20, 40), // centre y 100
    ];
    // The short frame is well inside the tall frames' span either way.
    expect(hangingPlan(rowWith(83), wall).items.map((i) => i.left)).toEqual([0, 30, 60]);
    expect(hangingPlan(rowWith(107), wall).items.map((i) => i.left)).toEqual([0, 30, 60]);
  });

  it('numbers the frames in the order they should be hung', () => {
    const frames = [frame(100, 10, 20, 20), frame(10, 10, 20, 20)];
    expect(hangingPlan(frames, wall).items.map((i) => i.number)).toEqual([1, 2]);
  });

  it('measures each frame from the left edge and the ceiling', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], wall).items;
    expect(item).toMatchObject({ left: 40, top: 25, right: 60, bottom: 55 });
  });

  it('reports the height of the frame above the floor', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], wall).items;
    // Wall is 200 cm tall, frame bottom is 55 cm below the ceiling.
    expect(item.fromFloor).toBe(145);
  });

  it('puts the nail on the frame centre line at the top edge by default', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], wall).items;
    expect(item.nailX).toBe(50);
    expect(item.nailY).toBe(25);
  });

  // Nobody measures down from a ceiling: it is out of reach, often not level,
  // and frequently has coving. This is the one number a person on a stepladder
  // actually needs, and it used to be the one number the table did not give.
  it('reports the nail height above the floor', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], { ...wall, hangerDrop: 6 }).items;
    expect(item.nailFromFloor).toBe(169);
    expect(item.nailFromFloor + item.nailY).toBe(wall.wallH);
  });

  it('keeps the nail height above the floor consistent with the ceiling figure', () => {
    const frames = [frame(0, 10, 20, 30), frame(50, 60, 13, 18), frame(90, 120, 10, 15)];
    for (const item of hangingPlan(frames, { ...wall, hangerDrop: 4 }).items) {
      expect(item.nailFromFloor).toBeCloseTo(wall.wallH - item.nailY, 6);
    }
  });

  it('reports the anchor line to mark before hanging anything', () => {
    const { block } = hangingPlan([frame(0, 40, 20, 30), frame(30, 50, 20, 30)], wall);
    // Group spans y 40..80, centre 60 below the ceiling, so 140 above the floor.
    expect(block.centerFromFloor).toBe(140);
  });

  it('drops the nail below the top edge when the hanger hangs slack', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], { ...wall, hangerDrop: 6 }).items;
    expect(item.nailY).toBe(31);
  });

  it('never puts the nail below the bottom of the frame', () => {
    const [item] = hangingPlan([frame(40, 25, 20, 30)], { ...wall, hangerDrop: 100 }).items;
    expect(item.nailY).toBe(55);
  });

  it('ignores a negative or nonsensical hanger drop', () => {
    for (const hangerDrop of [-5, NaN, 'x']) {
      const [item] = hangingPlan([frame(40, 25, 20, 30)], { ...wall, hangerDrop }).items;
      expect(item.nailY).toBe(25);
    }
  });

  it('labels each frame with the size it is actually hung at', () => {
    const upright = hangingPlan([frame(0, 0, 20, 30)], wall).items[0];
    const turned = hangingPlan([frame(0, 0, 30, 20, { baseW: 20, baseH: 30, rotated: true })], wall)
      .items[0];
    expect(upright.label).toBe('20 × 30 cm');
    expect(turned.label).toBe('30 × 20 cm');
    expect(turned.rotated).toBe(true);
  });

  it('rounds to millimetres, which is as precisely as anyone can measure a wall', () => {
    const [item] = hangingPlan([frame(40.06, 25.04, 20, 30)], wall).items;
    expect(item.left).toBe(40.1);
    expect(item.top).toBe(25);
    expect(Number.isInteger(item.nailX * 10)).toBe(true);
  });

  it('summarises the block so it can be positioned on the wall', () => {
    const frames = [frame(40, 20, 20, 30), frame(80, 20, 20, 30)];
    const { block } = hangingPlan(frames, wall);
    expect(block).toMatchObject({ left: 40, top: 20, width: 60, height: 30 });
    expect(block.centerX).toBe(70);
    expect(block.centerY).toBe(35);
  });

  it('returns an empty plan for an empty layout', () => {
    const plan = hangingPlan([], wall);
    expect(plan.items).toEqual([]);
    expect(plan.block).toBeNull();
  });
});
