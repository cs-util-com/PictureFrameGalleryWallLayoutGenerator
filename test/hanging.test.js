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
