/**
 * Axis-aligned rectangle helpers.
 *
 * A rectangle is `{ x, y, w, h }` with the origin at the wall's top-left corner
 * and all units in centimetres. Frames are never rotated by arbitrary angles —
 * only swapped between portrait and landscape — so axis-aligned maths is exact.
 */

/**
 * Separation between two rectangles, in centimetres.
 *
 * Uses the larger of the two per-axis separations (a Chebyshev gap) rather than
 * the Euclidean distance, because that is what "the frames hang N cm apart"
 * means on a wall: two frames offset diagonally are as far apart as their
 * widest axis gap. The result is:
 *
 *   > 0  separated
 *   = 0  touching
 *   < 0  overlapping on both axes
 *
 * @returns {number}
 */
export function clearance(a, b) {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.max(dx, dy);
}

/** Per-axis separation, used by the repair pass to pick a push direction. */
export function axisSeparation(a, b) {
  return {
    dx: Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)),
    dy: Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)),
  };
}

/** Area of the intersection; 0 when the rectangles are disjoint or touching. */
export function overlapArea(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  return ix * iy;
}

/** True when the rectangles overlap with positive area. */
export function intersects(a, b) {
  return clearance(a, b) < 0;
}

/** Centre point of a rectangle. */
export function centerOf(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Bounding box over a list of rectangles.
 *
 * @returns {{minX, minY, maxX, maxY, width, height}|null} null when empty.
 */
export function boundingBox(rects) {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Moves a rectangle inside `[0, wallW] × [0, wallH]`, mutating it in place.
 * A rectangle larger than the wall is pinned to the origin rather than given a
 * negative coordinate, so downstream code never sees a frame at x < 0.
 */
export function clampToBounds(r, wallW, wallH) {
  r.x = Math.max(0, Math.min(r.x, wallW - r.w));
  r.y = Math.max(0, Math.min(r.y, wallH - r.h));
}

/**
 * Turns a frame 90°, keeping its centre fixed. Mutates in place and toggles
 * `rotated`. Applying it twice restores the original exactly, which is what
 * lets the annealer undo a rejected rotation without cloning state.
 */
export function rotateRect(r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const w = r.w;
  r.w = r.h;
  r.h = w;
  r.x = cx - r.w / 2;
  r.y = cy - r.h / 2;
  r.rotated = !r.rotated;
}
