/**
 * Turns a layout into instructions for actually hanging it.
 *
 * A picture on screen is not the deliverable — a list of nail positions is.
 * Everything here is measured in centimetres from the wall's top-left corner,
 * rounded to the nearest millimetre, which is as precisely as anyone can mark a
 * wall with a tape measure.
 */

import { boundingBox } from './geometry.js';

/**
 * How far a frame's centre may sit from the one that opened its row, as a share
 * of the frame's own height, and a floor in centimetres for small frames.
 *
 * Rows are banded on centre lines rather than top edges. A 40 cm and a 10 cm
 * frame hung on the same centre line have tops 15 cm apart, so banding by top
 * edge split exactly the mixed-size row that a Kantenhängung is built from —
 * and sent the reader back across the wall to pick up the frame it skipped.
 */
const ROW_TOLERANCE_RATIO = 0.5;
const ROW_TOLERANCE_MIN = 5;

/** Rounds to millimetres. */
const mm = (value) => Math.round(value * 10) / 10;

/**
 * Breaks a tie on the frames themselves rather than on their input position.
 *
 * Falling back to the array index would reintroduce exactly the defect the
 * banding removes: two frames sharing an x would swap places depending on the
 * order the engine happened to emit them in. Frames that match on all of these
 * are interchangeable — they occupy the same place and print the same row.
 */
const byGeometry = (a, b) => a.cy - b.cy || a.f.w - b.f.w || a.f.h - b.f.h || a.index - b.index;

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
  //
  // The rows are found by banding rather than by a tolerant comparator. "Within
  // 5 cm of" is not transitive — a ≈ b and b ≈ c does not give a ≈ c — and
  // Array.prototype.sort on a non-transitive comparator is free to return
  // anything. It did: over a sweep of random layouts, 14% of input permutations
  // of the same frames came back in a different hanging order.
  //
  // Sorting into a total order first and then sweeping into bands is transitive
  // by construction, so the plan depends only on where the frames are.
  const ordered = frames
    .map((f, index) => ({ f, index, cy: f.y + f.h / 2 }))
    .sort((a, b) => a.cy - b.cy || a.f.x - b.f.x || byGeometry(a, b));

  const bands = [];
  for (const entry of ordered) {
    const band = bands[bands.length - 1];
    // Measured against the centre that opened the band, not against the
    // previous frame: chaining neighbour-to-neighbour lets a long stagger drift
    // a whole row's worth without ever starting a new one.
    const tolerance = Math.max(ROW_TOLERANCE_MIN, entry.f.h * ROW_TOLERANCE_RATIO);
    if (band && entry.cy - band.cy <= tolerance) band.items.push(entry);
    else bands.push({ cy: entry.cy, items: [entry] });
  }
  for (const band of bands) band.items.sort((a, b) => a.f.x - b.f.x || byGeometry(a, b));
  const sequence = bands.flatMap((band) => band.items);

  const items = sequence.map(({ f, index }, position) => {
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
      // The number to actually mark. Measuring up from the floor beats
      // measuring down from a ceiling that is out of reach, often not level,
      // and frequently has coving.
      nailFromFloor: mm(wallH - (f.y + Math.min(drop, f.h))),
      // The frame's bottom edge, as a cross-check once it is hung.
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
        // The line to chalk on the wall before anything else: the height the
        // whole arrangement is anchored to.
        centerFromFloor: mm(wallH - (box.minY + box.maxY) / 2),
        fromFloor: mm(wallH - box.maxY),
        wallW: mm(wallW),
        wallH: mm(wallH),
      }
    : null;

  return { items, block };
}
