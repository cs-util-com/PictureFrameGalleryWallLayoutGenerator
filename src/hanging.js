/**
 * Turns a layout into instructions for actually hanging it.
 *
 * A picture on screen is not the deliverable — a list of nail positions is.
 * Everything here is measured in centimetres from the wall's top-left corner,
 * rounded to the nearest millimetre, which is as precisely as anyone can mark a
 * wall with a tape measure.
 */

import { boundingBox } from './geometry.js';

/** Frames whose tops differ by less than this belong to the same visual row. */
const ROW_TOLERANCE = 5;

/** Rounds to millimetres. */
const mm = (value) => Math.round(value * 10) / 10;

/**
 * Builds the hanging plan.
 *
 * @param {Array} frames Placed frames.
 * @param {{wallW:number, wallH:number, hangerDrop?:number}} params
 *   `hangerDrop` is how far below the frame's top edge the hook or taut wire
 *   sits — measure it on the frame itself and the nail positions come out
 *   right first time.
 * @returns {{items:Array, block:object|null}}
 */
export function hangingPlan(frames, { wallW, wallH, hangerDrop = 0 }) {
  const drop = Number.isFinite(Number(hangerDrop)) ? Math.max(0, Number(hangerDrop)) : 0;

  // Hang in reading order: whole top row left to right, then the next row down.
  // Sorting purely by `y` would interleave rows whose frames are a few
  // centimetres out of line with each other.
  const ordered = frames
    .map((f, index) => ({ f, index }))
    .sort((a, b) => {
      if (Math.abs(a.f.y - b.f.y) > ROW_TOLERANCE) return a.f.y - b.f.y;
      return a.f.x - b.f.x || a.index - b.index;
    });

  const items = ordered.map(({ f, index }, position) => {
    const left = mm(f.x);
    const top = mm(f.y);
    return {
      number: position + 1,
      index,
      label: `${mm(f.w)} × ${mm(f.h)} cm`,
      w: mm(f.w),
      h: mm(f.h),
      rotated: Boolean(f.rotated),
      left,
      top,
      right: mm(f.x + f.w),
      bottom: mm(f.y + f.h),
      centerX: mm(f.x + f.w / 2),
      centerY: mm(f.y + f.h / 2),
      // The nail sits on the frame's centre line; the hanger's slack decides
      // how far below the top edge. It can never fall below the frame itself.
      nailX: mm(f.x + f.w / 2),
      nailY: mm(f.y + Math.min(drop, f.h)),
      // Useful when marking up from the floor rather than down from a ceiling
      // that may not be level.
      fromFloor: mm(wallH - (f.y + f.h)),
    };
  });

  const box = boundingBox(frames);
  const block = box
    ? {
        left: mm(box.minX),
        top: mm(box.minY),
        right: mm(box.maxX),
        bottom: mm(box.maxY),
        width: mm(box.width),
        height: mm(box.height),
        centerX: mm((box.minX + box.maxX) / 2),
        centerY: mm((box.minY + box.maxY) / 2),
        fromFloor: mm(wallH - box.maxY),
        wallW: mm(wallW),
        wallH: mm(wallH),
      }
    : null;

  return { items, block };
}
