/**
 * The rules a finished layout must obey, and a pass that repairs a layout that
 * does not obey them.
 *
 * These are the *physical* constraints — frames cannot overlap, must respect the
 * requested spacing, and must stay on the wall. Everything else the engine
 * cares about (balance, silhouette, rotation mix) is taste, lives in the energy
 * function, and must never block a layout from being shown.
 *
 * Keeping that distinction is what makes the engine reliable. The original
 * treated the aesthetic rotation-mix rule as a hard invariant, so a layout that
 * was physically perfect could be thrown away and the whole search restarted —
 * up to 300 annealing runs of a dead end.
 */

import { clearance, axisSeparation, clampToBounds } from './geometry.js';

/** Slack for floating-point comparisons, in centimetres. Well below 1 mm. */
export const EPSILON = 0.01;

/** How many push-apart sweeps the repair pass will attempt before giving up. */
const MAX_REPAIR_PASSES = 60;

/**
 * Lists every rule a layout breaks.
 *
 * @param {Array} frames
 * @param {{gap:number, wallW:number, wallH:number}} limits
 * @returns {{overlaps:Array<[number,number]>, tooClose:Array<[number,number]>,
 *           outOfBounds:number[], count:number}}
 */
export function findViolations(frames, { gap, wallW, wallH }) {
  const overlaps = [];
  const tooClose = [];
  const outOfBounds = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (
      f.x < -EPSILON ||
      f.y < -EPSILON ||
      f.x + f.w > wallW + EPSILON ||
      f.y + f.h > wallH + EPSILON
    ) {
      outOfBounds.push(i);
    }

    for (let j = i + 1; j < frames.length; j++) {
      const cl = clearance(f, frames[j]);
      if (cl < -EPSILON) overlaps.push([i, j]);
      else if (cl < gap - EPSILON) tooClose.push([i, j]);
    }
  }

  return {
    overlaps,
    tooClose,
    outOfBounds,
    count: overlaps.length + tooClose.length + outOfBounds.length,
  };
}

/** True when the layout breaks no physical rule. */
export function isValidLayout(frames, limits) {
  return findViolations(frames, limits).count === 0;
}

/**
 * Repairs a layout in place by repeatedly pushing crowded frames apart and
 * clamping them back onto the wall.
 *
 * Each sweep separates every offending pair along whichever axis they are
 * already furthest apart on — the cheapest direction to fix — and then pulls
 * escapees back inside the wall. Clamping can re-introduce crowding, hence the
 * repeated sweeps.
 *
 * This runs after annealing so the search can concentrate on composition and
 * treat the hard constraints as something that gets cleaned up afterwards,
 * rather than as a pass/fail gate on the whole attempt.
 *
 * @param {Array} frames Mutated in place. Sizes and rotation are never changed.
 * @param {{gap:number, wallW:number, wallH:number}} limits
 * @returns {boolean} Whether the layout is valid now. False means the frames
 *   genuinely do not fit and the caller should try with fewer of them.
 */
export function repairLayout(frames, limits) {
  const { gap, wallW, wallH } = limits;
  if (frames.length === 0) return true;

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    if (isValidLayout(frames, limits)) return true;

    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        separate(frames[i], frames[j], gap);
      }
    }
    for (const f of frames) clampToBounds(f, wallW, wallH);
  }

  return isValidLayout(frames, limits);
}

/**
 * Pushes two frames apart until their clearance reaches `gap`, moving each by
 * half the shortfall.
 */
function separate(a, b, gap) {
  const cl = clearance(a, b);
  if (cl >= gap - EPSILON) return;

  const { dx, dy } = axisSeparation(a, b);
  // Clearance is the larger of the two axis separations, so the cheapest way to
  // reach `gap` is to widen the axis that is already the more separated one.
  const useX = dx >= dy;
  const shortfall = gap - (useX ? dx : dy);
  const shift = shortfall / 2;

  const axis = useX ? 'x' : 'y';
  const size = useX ? 'w' : 'h';
  const centreA = a[axis] + a[size] / 2;
  const centreB = b[axis] + b[size] / 2;

  // Frames sitting at exactly the same centre have no natural push direction;
  // break the tie the same way every time so repair stays deterministic.
  const aFirst = centreA !== centreB ? centreA < centreB : true;
  if (aFirst) {
    a[axis] -= shift;
    b[axis] += shift;
  } else {
    a[axis] += shift;
    b[axis] -= shift;
  }
}
