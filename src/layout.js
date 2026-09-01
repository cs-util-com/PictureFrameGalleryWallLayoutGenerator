/**
 * The layout engine.
 *
 * Given an inventory, a wall and a seed, it produces an arrangement of frames
 * that can actually be hung: no overlaps, the requested spacing respected, and
 * everything on the wall.
 *
 * The search runs in four stages:
 *
 *   1. *Select*  — decide which frames this attempt will hang.
 *   2. *Seed*    — place them roughly, inside a target envelope.
 *   3. *Anneal*  — improve the composition by simulated annealing.
 *   4. *Settle*  — snap near-alignments, then repair any physical violation.
 *
 * Only stage 4 decides whether a layout is usable. Stages 2 and 3 are free to
 * produce something imperfect, which is why the engine terminates predictably
 * rather than restarting the whole search whenever a run comes out untidy.
 */

import { createRng } from './prng.js';
import { boundingBox, clearance, rotateRect } from './geometry.js';
import { computeEnergy, createEnergyContext } from './energy.js';
import { repairLayout, EPSILON } from './constraints.js';
import { normalizeInventory, expandInventory, selectFrames, cloneFrames } from './inventory.js';

/** The settings a fresh session starts with. */
export const DEFAULT_OPTIONS = Object.freeze({
  allowRotation: true,
  useAll: false,
  preferOdd: true,
  mixSizes: true,
  // 0 = salon / Petersburger hang, 1 = ordered, grid-like hang.
  order: 0.5,
});

/** Independent annealing runs per frame count. The best valid one wins. */
const RUNS_PER_ATTEMPT = 3;

/** Annealing iterations, scaled with the number of frames. */
const BASE_ITERATIONS = 1200;
const ITERATIONS_PER_FRAME = 90;
const MAX_ITERATIONS = 6000;

/** Annealing temperature schedule (geometric, from START down to END). */
const T_START = 1.0;
const T_END = 0.001;

/** Candidate positions tried when seeding each non-anchor frame. */
const SEED_ATTEMPTS = 40;

/** Share of the envelope the frames should fill when seeding. */
const SEED_DENSITY_MIN = 0.55;
const SEED_DENSITY_RANGE = 0.17;

/** How far a near-alignment may be nudged to become an exact one, in cm. */
const ALIGN_SNAP_MAX = 1.5;

/**
 * Generates a layout.
 *
 * @param {{inventory:*, wallW:number, wallH:number, gap:number, seed:number,
 *          options?:object}} params
 * @returns {{frames:Array, placed:number, total:number, notices:string[],
 *            bbox:object|null, coverage:number}}
 *   `notices` carries machine-readable reasons the result is not what was
 *   asked for: 'empty-inventory', 'invalid-wall', 'frames-dropped',
 *   'does-not-fit'.
 */
export function generateLayout({ inventory, wallW, wallH, gap, seed, options }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rows = normalizeInventory(inventory);
  const available = expandInventory(rows);
  const total = available.length;
  const notices = [];

  const wall = {
    w: Math.max(0, Number(wallW) || 0),
    h: Math.max(0, Number(wallH) || 0),
  };
  const spacing = Math.max(0, Number(gap) || 0);

  if (!(wall.w > 0) || !(wall.h > 0)) {
    return emptyResult(total, ['invalid-wall']);
  }
  if (total === 0) {
    return emptyResult(total, ['empty-inventory']);
  }

  const rng = createRng(Number.isFinite(seed) ? seed : 0);
  const selected = selectFrames(available, {
    wallW: wall.w,
    wallH: wall.h,
    useAll: opts.useAll,
    preferOdd: opts.preferOdd,
    rng,
  });
  let candidates = selected;

  const limits = { gap: spacing, wallW: wall.w, wallH: wall.h };
  let best = null;

  // Try the chosen frames; if none of the runs can be made valid, the frames
  // genuinely do not fit, so drop the smallest and try again. Each pass removes
  // one frame, so this terminates in at most `candidates.length` passes.
  while (candidates.length > 0 && !best) {
    best = searchLayout(candidates, wall, spacing, opts, rng, limits);
    if (!best) candidates = candidates.slice(0, candidates.length - 1);
  }

  if (!best) {
    return emptyResult(total, ['does-not-fit']);
  }

  // Hanging fewer frames than the user owns is only worth reporting when it was
  // forced. With "use all frames" off, choosing a subset is the intended
  // behaviour, so the shortfall is measured against the selection, not the
  // whole inventory.
  if (best.frames.length < selected.length) notices.push('frames-dropped');

  centerOnWall(best.frames, wall.w, wall.h);

  const box = boundingBox(best.frames);
  const placedArea = best.frames.reduce((sum, f) => sum + f.area, 0);

  return {
    frames: best.frames,
    placed: best.frames.length,
    total,
    notices,
    bbox: box,
    coverage: placedArea / (wall.w * wall.h),
  };
}

function emptyResult(total, notices) {
  return { frames: [], placed: 0, total, notices, bbox: null, coverage: 0 };
}

/**
 * Runs several independent annealing attempts on one set of frames and returns
 * the best layout that survives repair, or null if none does.
 */
function searchLayout(candidates, wall, gap, opts, rng, limits) {
  const iterations = Math.min(
    MAX_ITERATIONS,
    BASE_ITERATIONS + ITERATIONS_PER_FRAME * candidates.length
  );

  let best = null;
  for (let run = 0; run < RUNS_PER_ATTEMPT; run++) {
    // Each run starts from its own copy: the engine mutates frames in place.
    const frames = cloneFrames(candidates);
    const envelope = seedPlacement(frames, wall, gap, opts, rng);
    const ctx = createEnergyContext({
      wallW: wall.w,
      wallH: wall.h,
      gap,
      order: opts.order,
      mixSizes: opts.mixSizes,
      allowRotation: opts.allowRotation,
      targetAspect: envelope.aspect,
    });

    anneal(frames, ctx, rng, envelope, iterations, opts);
    settle(frames, limits, opts.order);

    if (!repairLayout(frames, limits)) continue;

    const energy = computeEnergy(frames, ctx).total;
    if (!best || energy < best.energy) best = { frames, energy };
  }
  return best;
}

/**
 * Places frames roughly, inside an envelope sized to hold them at a plausible
 * density and shaped roughly like the wall.
 *
 * The largest frame anchors the composition slightly off-centre — a perfectly
 * centred anchor reads as accidental — and the rest are dropped into the
 * envelope, each taking the best of a few random positions.
 *
 * @returns {{x:number, y:number, w:number, h:number, aspect:number}}
 */
function seedPlacement(frames, wall, gap, opts, rng) {
  if (opts.allowRotation) {
    for (const f of frames) {
      if (f.baseW !== f.baseH && rng.chance(0.5)) rotateRect(f);
    }
  }

  const frameArea = frames.reduce((sum, f) => sum + f.area, 0);
  const density = SEED_DENSITY_MIN + rng.float() * SEED_DENSITY_RANGE;
  const wallAspect = wall.w / wall.h;
  const aspect = wallAspect * rng.range(0.75, 1.35);

  let h = Math.sqrt(frameArea / density / aspect);
  let w = aspect * h;
  w = Math.min(w, Math.max(1, wall.w - 2 * gap));
  h = Math.min(h, Math.max(1, wall.h - 2 * gap));

  const envelope = {
    x: (wall.w - w) / 2,
    y: (wall.h - h) / 2,
    w,
    h,
    aspect: Math.max(0.1, w / Math.max(0.1, h)),
  };

  // Anchor: the biggest frame, nudged off the wall's centre.
  const anchor = frames[0];
  anchor.x = wall.w / 2 + (rng.chance(0.5) ? -1 : 1) * rng.range(0.05, 0.15) * w - anchor.w / 2;
  anchor.y = wall.h / 2 + (rng.chance(0.5) ? -1 : 1) * rng.range(0, 0.1) * h - anchor.h / 2;

  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    let bestX = f.x;
    let bestY = f.y;
    let bestViolation = Infinity;

    for (let attempt = 0; attempt < SEED_ATTEMPTS; attempt++) {
      f.x = envelope.x + rng.float() * envelope.w - f.w / 2;
      f.y = envelope.y + rng.float() * envelope.h - f.h / 2;

      let violation = 0;
      for (let j = 0; j < i; j++) {
        const cl = clearance(f, frames[j]);
        if (cl < gap) violation += gap - cl;
      }
      if (violation === 0) {
        bestViolation = 0;
        bestX = f.x;
        bestY = f.y;
        break;
      }
      if (violation < bestViolation) {
        bestViolation = violation;
        bestX = f.x;
        bestY = f.y;
      }
    }

    f.x = bestX;
    f.y = bestY;
  }

  return envelope;
}

/**
 * Simulated annealing over the composition.
 *
 * Moves are applied directly to `frames` and undone when rejected, rather than
 * scoring a cloned copy. The original engine deep-cloned the entire layout
 * twice per iteration via JSON round-trips — tens of thousands of clones per
 * layout — which is what made large inventories lock the browser tab.
 */
function anneal(frames, ctx, rng, envelope, iterations, opts) {
  if (frames.length < 2) return;

  let current = computeEnergy(frames, ctx);
  let bestEnergy = current.total;
  let bestState = captureState(frames);

  for (let i = 0; i < iterations; i++) {
    const temperature = T_START * Math.pow(T_END / T_START, i / iterations);
    const move = proposeMove(frames, rng, envelope, current.perFrame, opts);
    if (!move) continue;

    const next = computeEnergy(frames, ctx);
    const delta = next.total - current.total;

    if (delta < 0 || rng.float() < Math.exp(-delta / temperature)) {
      current = next;
      if (next.total < bestEnergy) {
        bestEnergy = next.total;
        bestState = captureState(frames);
      }
    } else {
      undoMove(frames, move);
    }
  }

  restoreState(frames, bestState);
}

const MOVE_TRANSLATE = 0;
const MOVE_ROTATE = 1;
const MOVE_SWAP = 2;
const MOVE_RELOCATE = 3;
const MOVE_NUDGE_ALL = 4;

/**
 * Applies one random move and returns a record describing how to undo it.
 * Returns null when the drawn move does not apply (for example a rotation when
 * every frame is square).
 */
function proposeMove(frames, rng, envelope, perFrame, opts) {
  const roll = rng.float();

  if (roll < 0.45) {
    // Shift one frame. The step shrinks as `order` rises, so an ordered wall
    // makes fine adjustments and a salon wall explores more freely.
    const i = rng.int(frames.length);
    const sigma = Math.max(1, envelope.w * 0.02) * (2.5 - 1.5 * opts.order);
    const dx = rng.bell(sigma);
    const dy = rng.bell(sigma);
    frames[i].x += dx;
    frames[i].y += dy;
    return { kind: MOVE_TRANSLATE, i, dx, dy };
  }

  if (roll < 0.65) {
    if (!opts.allowRotation) return null;
    const rotatable = [];
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].baseW !== frames[i].baseH) rotatable.push(i);
    }
    if (rotatable.length === 0) return null;
    const i = rotatable[rng.int(rotatable.length)];
    rotateRect(frames[i]);
    return { kind: MOVE_ROTATE, i };
  }

  if (roll < 0.8) {
    // Exchange the positions of two differently sized frames.
    const i = rng.int(frames.length);
    const j = rng.int(frames.length);
    if (i === j || frames[i].area === frames[j].area) return null;
    swapCenters(frames[i], frames[j]);
    return { kind: MOVE_SWAP, i, j };
  }

  if (roll < 0.95) {
    // Move the worst-placed frame somewhere else entirely. `perFrame` comes
    // from the last accepted score, so this costs no extra energy evaluation.
    let worst = 0;
    for (let i = 1; i < perFrame.length; i++) {
      if (perFrame[i] > perFrame[worst]) worst = i;
    }
    const f = frames[worst];
    const record = { kind: MOVE_RELOCATE, i: worst, x: f.x, y: f.y };
    f.x = envelope.x + rng.float() * envelope.w - f.w / 2;
    f.y = envelope.y + rng.float() * envelope.h - f.h / 2;
    return record;
  }

  // Slide the whole arrangement, which lets it recentre without having to move
  // each frame past the others one at a time.
  const dx = rng.bell(envelope.w * 0.01);
  const dy = rng.bell(envelope.h * 0.01);
  for (const f of frames) {
    f.x += dx;
    f.y += dy;
  }
  return { kind: MOVE_NUDGE_ALL, dx, dy };
}

function undoMove(frames, move) {
  switch (move.kind) {
    case MOVE_TRANSLATE:
      frames[move.i].x -= move.dx;
      frames[move.i].y -= move.dy;
      break;
    case MOVE_ROTATE:
      // rotateRect is its own inverse.
      rotateRect(frames[move.i]);
      break;
    case MOVE_SWAP:
      swapCenters(frames[move.i], frames[move.j]);
      break;
    case MOVE_RELOCATE:
      frames[move.i].x = move.x;
      frames[move.i].y = move.y;
      break;
    case MOVE_NUDGE_ALL:
      for (const f of frames) {
        f.x -= move.dx;
        f.y -= move.dy;
      }
      break;
  }
}

/** Exchanges two frames' centre points, keeping each frame's own size. */
function swapCenters(a, b) {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  a.x = bcx - a.w / 2;
  a.y = bcy - a.h / 2;
  b.x = acx - b.w / 2;
  b.y = acy - b.h / 2;
}

/**
 * A flat snapshot of the mutable parts of a layout. Only taken when a run finds
 * a new best, which is rare compared with the number of iterations.
 */
function captureState(frames) {
  const state = new Float64Array(frames.length * 5);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    state[i * 5] = f.x;
    state[i * 5 + 1] = f.y;
    state[i * 5 + 2] = f.w;
    state[i * 5 + 3] = f.h;
    state[i * 5 + 4] = f.rotated ? 1 : 0;
  }
  return state;
}

function restoreState(frames, state) {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    f.x = state[i * 5];
    f.y = state[i * 5 + 1];
    f.w = state[i * 5 + 2];
    f.h = state[i * 5 + 3];
    f.rotated = state[i * 5 + 4] === 1;
  }
}

/**
 * Turns near-alignments into exact ones.
 *
 * Annealing lands frames a few millimetres from sharing an edge, which reads as
 * sloppy rather than deliberate. Each candidate snap is applied and kept only
 * if it does not create a violation; the tolerance scales with `order`, so a
 * salon hang is left alone.
 */
function settle(frames, limits, order) {
  const tolerance = ALIGN_SNAP_MAX * order;
  if (tolerance <= 0.1 || frames.length < 2) return;

  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i];
      const b = frames[j];

      // Every way two frames can share an edge line: near edges, far edges, and
      // each frame's near edge against the other's far edge.
      const pairings = [
        ['x', 0, 0],
        ['x', a.w, b.w],
        ['x', 0, b.w],
        ['x', a.w, 0],
        ['y', 0, 0],
        ['y', a.h, b.h],
        ['y', 0, b.h],
        ['y', a.h, 0],
      ];

      for (const [axis, offsetA, offsetB] of pairings) {
        const edgeA = a[axis] + offsetA;
        const edgeB = b[axis] + offsetB;
        if (Math.abs(edgeA - edgeB) > tolerance) continue;

        const savedA = a[axis];
        const savedB = b[axis];
        const target = (edgeA + edgeB) / 2;
        a[axis] = target - offsetA;
        b[axis] = target - offsetB;

        if (!pairIsSafe(frames, i, j, limits)) {
          a[axis] = savedA;
          b[axis] = savedB;
        }
      }
    }
  }
}

/**
 * Whether frames i and j sit legally, given everything else.
 *
 * Only the two moved frames are re-checked, against each other and against the
 * rest — the other pairs cannot have changed, so a full O(n²) sweep per snap
 * attempt would be wasted work.
 */
function pairIsSafe(frames, i, j, limits) {
  for (const index of [i, j]) {
    const f = frames[index];
    if (
      f.x < -EPSILON ||
      f.y < -EPSILON ||
      f.x + f.w > limits.wallW + EPSILON ||
      f.y + f.h > limits.wallH + EPSILON
    ) {
      return false;
    }
    for (let k = 0; k < frames.length; k++) {
      if (k === index || (index === j && k === i)) continue;
      if (clearance(f, frames[k]) < limits.gap - EPSILON) return false;
    }
  }
  return true;
}

/** Slides the finished arrangement so its bounding box sits centred on the wall. */
function centerOnWall(frames, wallW, wallH) {
  const box = boundingBox(frames);
  if (!box) return;
  const dx = wallW / 2 - (box.minX + box.maxX) / 2;
  const dy = wallH / 2 - (box.minY + box.maxY) / 2;
  for (const f of frames) {
    f.x += dx;
    f.y += dy;
  }
}
