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

/**
 * Centimetres from the floor to the centre of the arrangement.
 *
 * Galleries hang the centre of a work — or of a whole cluster, treated as one
 * work — at average standing eye level. 145 cm is the long-standing museum
 * figure (the "57 inch rule") and the same number the German trade quotes as
 * 145–150 cm Boden bis Bildmitte.
 */
export const EYE_LEVEL = 145;

/** Independent annealing runs per frame count. The best valid one wins. */
const RUNS_PER_ATTEMPT = 6;

/**
 * Runs used while merely testing whether a frame count is feasible. Probing is
 * a yes/no question, so one run is enough; the winning count is then searched
 * properly with the full number of runs.
 */
const RUNS_PER_PROBE = 2;

/**
 * How far to climb back up after bisecting. A probe can fail on a count that is
 * actually feasible -- it is one stochastic run -- and the bisect then settles
 * below what the wall could hold. Retrying the next few counts with the full
 * number of runs recovers that, at a fraction of the cost of the old
 * one-search-per-frame scan.
 */
const MAX_CLIMB_STEPS = 8;

/** Independent runs at a given effort; never fewer than one. */
const runsFor = (work) => Math.max(1, Math.round(RUNS_PER_ATTEMPT * work));

/**
 * Annealing iterations for a frame count, before effort is applied.
 *
 * Scoring a layout is O(n^2), so the work budget caps iterations x pairs rather
 * than letting both grow together.
 */
const iterationsFor = (n) => {
  const requested = Math.min(MAX_ITERATIONS, BASE_ITERATIONS + ITERATIONS_PER_FRAME * n);
  const affordable = WORK_BUDGET / Math.max(1, n * n);
  return Math.max(MIN_ITERATIONS, Math.min(requested, affordable));
};

/** Annealing iterations, scaled with the number of frames. */
const BASE_ITERATIONS = 3000;
const ITERATIONS_PER_FRAME = 220;
const MAX_ITERATIONS = 20000;
const MIN_ITERATIONS = 4000;

/**
 * Ceiling on iterations x pair-comparisons for one run.
 *
 * Scoring a layout is O(n^2), so iterations that scale *up* with the frame
 * count make total work grow as n^3: sixty frames cost 36 times what fifteen
 * do. This caps the product instead, trading iterations for pair count at the
 * top of the range, where the arrangement is dominated by fitting the frames in
 * at all rather than by fine composition.
 */
const WORK_BUDGET = 45_000_000;

/** Annealing temperature schedule (geometric, from START down to END). */
const T_START = 1.0;
const T_END = 0.001;

/**
 * Polish: rounds of perturb-and-reanneal applied to the winning layout.
 *
 * Independent restarts each throw away everything the previous one learnt. An
 * iterated local search instead keeps the best composition found so far,
 * disturbs a few frames, and re-anneals from just warm enough to escape the
 * local minimum without discarding the arrangement -- which spends a long time
 * budget far better than simply running more independent searches.
 */
const POLISH_ROUNDS = 26;
/**
 * Rounds are scaled down on a crowded wall: each one costs O(n^2) per
 * iteration, so a full complement on sixty frames turns a long think into a
 * hang. This keeps the wall-clock cost roughly flat across inventory sizes.
 */
const POLISH_MIN_ROUNDS = 6;
const POLISH_ROUND_BUDGET = 1600;
const T_POLISH_START = 0.18;
const POLISH_ITERATION_SHARE = 0.4;
const POLISH_MAX_KICKS = 3;
/** How far a kicked frame is thrown, as a share of the group's own size. */
const POLISH_KICK_SPREAD = 0.07;

/** Candidate positions tried when seeding each non-anchor frame. */
const SEED_ATTEMPTS = 40;

/** Share of the envelope the frames should fill when seeding. */
const SEED_DENSITY_MIN = 0.55;
const SEED_DENSITY_RANGE = 0.17;

/** How far a near-alignment may be nudged to become an exact one, in cm. */
const ALIGN_SNAP_MAX = 1.5;

/**
 * Compaction: how many sweeps, and the step sizes tried per frame per sweep.
 *
 * Largest step first, so a frame with room to move covers it quickly and the
 * small steps only pay for the final closing-up.
 */
const COMPACT_PASSES = 14;
const COMPACT_STEPS = [4, 2, 1, 0.5];

/** Above this point on the Style slider, one run starts from a strict grid. */
const GRID_SEED_MIN_ORDER = 0.6;

/**
 * Starting temperature for the run seeded from a grid.
 *
 * Low enough that the run refines the grid -- fixing the rotation mix, easing
 * the silhouette -- instead of melting it back into a scatter.
 */
const T_GRID_START = 0.08;

/**
 * Generates a layout.
 *
 * @param {{inventory:*, wallW:number, wallH:number, gap:number, seed:number,
 *          options?:object}} params
 * @returns {{frames:Array, placed:number, total:number, notices:string[],
 *            bbox:object|null, coverage:number}}
 *   `notices` carries machine-readable reasons the result is not what was
 *   asked for: 'empty-inventory', 'invalid-wall', 'frames-dropped',
 *   'does-not-fit'. `stats` reports how much work the search did, which lets
 *   tests bound the cost deterministically instead of timing it.
 */
export function generateLayout({
  inventory,
  wallW,
  wallH,
  gap,
  seed,
  options,
  centreHeight = EYE_LEVEL,
  onProgress,
  effort = 1,
}) {
  // Optional, and called only at phase boundaries: the search is a long
  // synchronous block, so whoever runs it needs a way to say how far along it
  // is. A no-op keeps every call site free of null checks.
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  // How hard to look. One is what the app ships; the tests that sweep the
  // parameter space for legality rather than for beauty turn it down, because
  // a full-effort search of two hundred layouts is minutes of CPU for an
  // assertion that does not depend on any of it.
  const work = Math.max(0.02, Math.min(1, Number(effort) || 0));
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
  const anchor = Math.max(0, Number(centreHeight) || 0);

  report(0.02, 'Reading your frames');

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
  const candidates = selected;

  const limits = { gap: spacing, wallW: wall.w, wallH: wall.h };
  const stats = { energyEvaluations: 0, attempts: 0 };
  let best = null;

  // Find the largest number of frames that can actually be hung.
  //
  // Dropping one frame per full search made shrinking the wall under a large
  // inventory a tab-lock: 55 complete searches and tens of seconds of blocked
  // main thread. Because a layout that works for n frames also works for n-1
  // (they are the largest n-1 of the same set), feasibility is monotonic in the
  // count and can be bisected instead -- about six probes rather than 55.
  //
  // Fast path first: almost every real inventory fits on its wall, and testing
  // the whole set settles that in one search rather than bisecting up to it.
  stats.attempts++;
  report(0.05, 'Arranging the frames');
  best = searchLayout(candidates, wall, spacing, opts, rng, limits, stats, runsFor(work), work);
  if (best) {
    best = polish(best, wall, spacing, opts, rng, limits, stats, report, work);
    positionOnWall(best.frames, wall.w, wall.h, anchor);
    return describeResult(best, selected, total, wall, notices, stats);
  }

  let low = 1;
  let high = candidates.length - 1;
  let bestCount = 0;

  report(0.1, 'Working out how many will fit');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    stats.attempts++;
    const probe = searchLayout(
      candidates.slice(0, mid),
      wall,
      spacing,
      opts,
      rng,
      limits,
      stats,
      Math.max(1, Math.round(RUNS_PER_PROBE * work)),
      work
    );
    if (probe) {
      bestCount = mid;
      best = probe;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (!best) {
    return emptyResult(total, ['does-not-fit']);
  }

  // Climb back up: a failed probe may only have been unlucky.
  for (let step = 0; step < MAX_CLIMB_STEPS && bestCount < candidates.length; step++) {
    stats.attempts++;
    const higher = searchLayout(
      candidates.slice(0, bestCount + 1),
      wall,
      spacing,
      opts,
      rng,
      limits,
      stats,
      runsFor(work),
      work
    );
    if (!higher) break;
    bestCount++;
    best = higher;
  }

  // Search the settled count properly and keep the better result.
  stats.attempts++;
  const polished = searchLayout(
    candidates.slice(0, bestCount),
    wall,
    spacing,
    opts,
    rng,
    limits,
    stats,
    RUNS_PER_ATTEMPT
  );
  if (polished && polished.energy < best.energy) best = polished;

  best = polish(best, wall, spacing, opts, rng, limits, stats, report, work);
  positionOnWall(best.frames, wall.w, wall.h, anchor);
  return describeResult(best, selected, total, wall, notices, stats);
}

/** Packages a finished search into the engine's public result shape. */
function describeResult(best, selected, total, wall, notices, stats) {
  // Hanging fewer frames than the user owns is only worth reporting when it was
  // forced. With "use all frames" off, choosing a subset is the intended
  // behaviour, so the shortfall is measured against the selection, not the
  // whole inventory.
  if (best.frames.length < selected.length) notices.push('frames-dropped');

  const box = boundingBox(best.frames);
  const placedArea = best.frames.reduce((sum, f) => sum + f.area, 0);

  return {
    frames: best.frames,
    placed: best.frames.length,
    total,
    notices,
    bbox: box,
    coverage: placedArea / (wall.w * wall.h),
    stats,
  };
}

function emptyResult(total, notices) {
  return {
    frames: [],
    placed: 0,
    total,
    notices,
    bbox: null,
    coverage: 0,
    stats: { energyEvaluations: 0, attempts: 0 },
  };
}

/**
 * Runs several independent annealing attempts on one set of frames and returns
 * the best layout that survives repair, or null if none does.
 */
function searchLayout(
  candidates,
  wall,
  gap,
  opts,
  rng,
  limits,
  stats,
  runs = RUNS_PER_ATTEMPT,
  work = 1
) {
  const n = candidates.length;
  const iterations = Math.round(iterationsFor(n) * work);

  // Runs are compared under one shared context. Each run anneals against its
  // own randomly drawn target silhouette, so its own energy is measured from a
  // different reference point and the numbers are not comparable across runs.
  const commonCtx = createEnergyContext({
    wallW: wall.w,
    wallH: wall.h,
    gap,
    order: opts.order,
    mixSizes: opts.mixSizes,
    allowRotation: opts.allowRotation,
    targetAspect: wall.w / wall.h,
  });

  let best = null;
  for (let run = 0; run < runs; run++) {
    // Each run starts from its own copy: the engine mutates frames in place.
    const frames = cloneFrames(candidates);
    // Toward the ordered end of the slider, spend the first run starting from
    // an actual grid. Annealing from a random scatter essentially never finds
    // one -- landing every frame on a shared line within the alignment
    // tolerance is a needle -- so the engine could score a grid well (it now
    // does) and still never produce one. Runs are compared on energy, so a grid
    // that turns out worse than a free arrangement simply loses.
    let envelope = null;
    if (run === 0 && opts.order >= GRID_SEED_MIN_ORDER)
      envelope = seedGrid(frames, wall, gap, opts);
    const seededGrid = envelope !== null;
    if (!seededGrid) envelope = seedPlacement(frames, wall, gap, opts, rng);
    const ctx = createEnergyContext({
      wallW: wall.w,
      wallH: wall.h,
      gap,
      order: opts.order,
      mixSizes: opts.mixSizes,
      allowRotation: opts.allowRotation,
      targetAspect: envelope.aspect,
    });

    // A grid seed is already a good answer, so it is refined rather than
    // explored from. Annealing it from the full starting temperature simply
    // scrambled it: the measured largest shared line went *down*, from 3.00
    // frames to 2.75, because every grid was cooked back into a scatter.
    anneal(
      frames,
      ctx,
      rng,
      envelope,
      iterations,
      opts,
      stats,
      seededGrid ? T_GRID_START : T_START
    );
    settle(frames, limits, opts.order);

    if (!repairLayout(frames, limits)) continue;

    // Compaction only makes legal moves, but it changes what sits next to what,
    // so near-alignments are re-snapped afterwards and the result re-checked.
    compact(frames, limits);
    settle(frames, limits, opts.order);
    if (!repairLayout(frames, limits)) continue;

    stats.energyEvaluations++;
    const energy = computeEnergy(frames, commonCtx).total;
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
/**
 * Seeds a strict grid — a Rasterhängung — on a uniform pitch.
 *
 * Every frame is centred in its own identical cell, so all the cells in a
 * column share a vertical centre line and all those in a row share a horizontal
 * one, whatever sizes the frames are. That is what makes a grid of mixed sizes
 * read as a grid, and it is why the alignment score has to count centre lines.
 *
 * Cells are square when rotation is allowed, so the annealer can turn a frame
 * in place — `rotateRect` preserves the centre — to satisfy the rotation mix
 * without knocking the grid apart.
 *
 * @returns {object|null} The envelope, or null when no grid fits the wall, in
 *   which case the caller falls back to the ordinary random seed.
 */
/**
 * Iterated local search over the winning layout.
 *
 * The search proper takes the best of several independent runs, each starting
 * from nothing. That wastes a long time budget: every restart discards a whole
 * composition to roll the dice again. This instead holds on to the best
 * arrangement found and repeatedly disturbs a few frames and re-anneals from a
 * temperature warm enough to escape the local minimum but too cool to melt the
 * composition, keeping the result only when it scores better.
 *
 * Runs once, on the final layout, so the feasibility bisect stays cheap.
 */
function polish(best, wall, gap, opts, rng, limits, stats, report = () => {}, work = 1) {
  const ctx = createEnergyContext({
    wallW: wall.w,
    wallH: wall.h,
    gap,
    order: opts.order,
    mixSizes: opts.mixSizes,
    allowRotation: opts.allowRotation,
    targetAspect: wall.w / wall.h,
  });

  let bestFrames = best.frames;
  stats.energyEvaluations++;
  let bestEnergy = computeEnergy(bestFrames, ctx).total;
  const n = bestFrames.length;
  if (n < 2) return { frames: bestFrames, energy: bestEnergy };

  // Share the same work ceiling as the main search, so a big wall does not
  // turn a long think into a hang.
  const iterations = Math.max(50, Math.round(POLISH_ITERATION_SHARE * iterationsFor(n) * work));

  const rounds = Math.max(
    1,
    Math.round(
      Math.max(POLISH_MIN_ROUNDS, POLISH_ROUNDS * Math.min(1, POLISH_ROUND_BUDGET / (n * n))) * work
    )
  );

  for (let round = 0; round < rounds; round++) {
    // The search proper is roughly the first third of the wait; the rest of the
    // bar belongs to polishing, which is where most of the time now goes.
    report(0.35 + 0.6 * (round / rounds), 'Refining the composition');
    const trial = cloneFrames(bestFrames);
    const envelope = envelopeAround(trial, wall);

    // The kick: displace a few frames so the re-anneal starts somewhere new.
    // Without it every round would re-converge on the layout it started from.
    const kicks = 1 + rng.int(POLISH_MAX_KICKS);
    for (let k = 0; k < kicks; k++) {
      const f = trial[rng.int(n)];
      f.x += rng.bell(envelope.w * POLISH_KICK_SPREAD);
      f.y += rng.bell(envelope.h * POLISH_KICK_SPREAD);
    }

    anneal(trial, ctx, rng, envelope, iterations, opts, stats, T_POLISH_START);
    settle(trial, limits, opts.order);
    if (!repairLayout(trial, limits)) continue;
    compact(trial, limits);
    settle(trial, limits, opts.order);
    if (!repairLayout(trial, limits)) continue;

    stats.energyEvaluations++;
    const energy = computeEnergy(trial, ctx).total;
    if (energy < bestEnergy) {
      bestFrames = trial;
      bestEnergy = energy;
    }
  }

  report(0.97, 'Finishing up');
  return { frames: bestFrames, energy: bestEnergy };
}

/**
 * The region the polish rounds may move frames within: the group's own box,
 * grown a little so a frame can be relocated just outside the current
 * silhouette, and clamped to the wall.
 */
function envelopeAround(frames, wall) {
  const box = boundingBox(frames);
  if (!box) return { x: 0, y: 0, w: wall.w, h: wall.h, aspect: wall.w / wall.h };
  const padX = Math.min(box.width * 0.15, wall.w * 0.1);
  const padY = Math.min(box.height * 0.15, wall.h * 0.1);
  const x = Math.max(0, box.minX - padX);
  const y = Math.max(0, box.minY - padY);
  const w = Math.max(1, Math.min(wall.w - x, box.width + 2 * padX));
  const h = Math.max(1, Math.min(wall.h - y, box.height + 2 * padY));
  return { x, y, w, h, aspect: Math.max(0.1, w / h) };
}

/** Whether two frames sit on a shared edge or centre line, on either axis. */
function sharesLine(a, b) {
  const t = ALIGN_SNAP_MAX;
  return (
    Math.abs(a.x - b.x) < t ||
    Math.abs(a.x + a.w - (b.x + b.w)) < t ||
    Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < t ||
    Math.abs(a.y - b.y) < t ||
    Math.abs(a.y + a.h - (b.y + b.h)) < t ||
    Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < t
  );
}

/**
 * Pulls the arrangement together, and rounds it off in the process.
 *
 * The gap setting is a floor, not a target, and nothing else in the search
 * pulls frames back once annealing has pushed them apart: runs ended with
 * neighbours a median 10.7 cm apart where 7 cm was asked for, which reads as
 * scattered rather than as one group.
 *
 * Each frame is drawn toward the group's centre along its own radius. That
 * tightens the spacing and rounds the silhouette at the same time, because the
 * corners of a bounding box are its furthest points from the centre and so are
 * the first to close in — a gallery wall reads as deliberate when its outline
 * is an oval rather than a filled rectangle.
 *
 * Every step is checked and reverted if it would break a physical rule, so this
 * can only turn a legal layout into a tighter legal one.
 */
function compact(frames, limits) {
  if (frames.length < 2) return;

  // Tightening must not cost alignment. Pulling every frame toward the centre
  // walks them off the shared lines the annealer just built -- it dropped the
  // measured grid consolidation from 0.396 to 0.275 -- and `settle` can only
  // recover a nudge of a centimetre or two, far less than a compaction step.
  const linesShared = (index) => {
    const f = frames[index];
    let count = 0;
    for (let k = 0; k < frames.length; k++) {
      if (k === index) continue;
      if (sharesLine(f, frames[k])) count++;
    }
    return count;
  };

  for (let pass = 0; pass < COMPACT_PASSES; pass++) {
    const box = boundingBox(frames);
    if (!box) return;
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;

    // Outermost frames first: they have the furthest to travel, and letting an
    // inner frame move first would close the space the outer one needs.
    const byDistance = frames
      .map((f, i) => ({ i, d: Math.hypot(f.x + f.w / 2 - cx, f.y + f.h / 2 - cy) }))
      .sort((a, b) => b.d - a.d || a.i - b.i);

    let moved = false;
    for (const { i } of byDistance) {
      const f = frames[i];
      const dx = cx - (f.x + f.w / 2);
      const dy = cy - (f.y + f.h / 2);
      const distance = Math.hypot(dx, dy);
      if (distance < EPSILON) continue;

      for (const step of COMPACT_STEPS) {
        if (step > distance) continue;
        const savedX = f.x;
        const savedY = f.y;
        const before = linesShared(i);
        f.x += (dx / distance) * step;
        f.y += (dy / distance) * step;
        if (pairIsSafe(frames, i, i, limits) && linesShared(i) >= before) {
          moved = true;
          break;
        }
        f.x = savedX;
        f.y = savedY;
      }
    }
    if (!moved) break;
  }
}

function seedGrid(frames, wall, gap, opts) {
  const n = frames.length;
  if (n === 0) return null;

  let cellW = 0;
  let cellH = 0;
  for (const f of frames) {
    cellW = Math.max(cellW, f.baseW, opts.allowRotation ? f.baseH : 0);
    cellH = Math.max(cellH, f.baseH, opts.allowRotation ? f.baseW : 0);
  }
  cellW += gap;
  cellH += gap;

  // Choose the column count whose silhouette sits closest to the wall's shape,
  // measured in log space so "twice as wide" and "half as wide" cost the same.
  const wallAspect = wall.w / wall.h;
  let cols = 0;
  let bestScore = Infinity;
  for (let candidate = 1; candidate <= n; candidate++) {
    const rows = Math.ceil(n / candidate);
    const gridW = candidate * cellW - gap;
    const gridH = rows * cellH - gap;
    if (gridW > wall.w || gridH > wall.h) continue;
    const score = Math.abs(Math.log(gridW / gridH / wallAspect));
    if (score < bestScore) {
      bestScore = score;
      cols = candidate;
    }
  }
  if (cols === 0) return null;

  const rows = Math.ceil(n / cols);
  const gridW = cols * cellW - gap;
  const gridH = rows * cellH - gap;
  const originX = (wall.w - gridW) / 2;
  const originY = (wall.h - gridH) / 2;

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Centre a short last row rather than leaving it hanging to the left, which
    // reads as an accident rather than as a composition.
    const inRow = Math.min(cols, n - row * cols);
    const rowInset = ((cols - inRow) * cellW) / 2;
    f.x = originX + rowInset + col * cellW + (cellW - gap - f.w) / 2;
    f.y = originY + row * cellH + (cellH - gap - f.h) / 2;
  }

  return {
    x: originX,
    y: originY,
    w: gridW,
    h: gridH,
    aspect: Math.max(0.1, gridW / Math.max(0.1, gridH)),
  };
}

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
function anneal(frames, ctx, rng, envelope, iterations, opts, stats, tStart = T_START) {
  if (frames.length < 2) return;

  stats.energyEvaluations++;
  // Two per-frame buffers, swapped on acceptance. One would be wrong: the
  // accepted result's scores are read by `proposeMove` on every subsequent
  // iteration, however many proposals are rejected in between, so the buffer
  // being scored into must never be the one `current` is still holding.
  // `scratch` is always the one that is safe to overwrite.
  let scratch = new Array(frames.length).fill(0);
  let current = computeEnergy(frames, ctx, new Array(frames.length).fill(0));
  let bestEnergy = current.total;
  let bestState = captureState(frames);
  const distribution = buildMoveDistribution(frames, opts);

  for (let i = 0; i < iterations; i++) {
    const temperature = tStart * Math.pow(T_END / tStart, i / iterations);
    const move = proposeMove(frames, rng, envelope, current.perFrame, opts, distribution);
    if (!move) continue;

    stats.energyEvaluations++;
    const next = computeEnergy(frames, ctx, scratch);
    const delta = next.total - current.total;

    if (delta < 0 || rng.float() < Math.exp(-delta / temperature)) {
      scratch = current.perFrame;
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

/** Relative likelihood of each move being proposed, before filtering. */
const MOVE_WEIGHTS = [
  [MOVE_TRANSLATE, 0.45],
  [MOVE_ROTATE, 0.2],
  [MOVE_SWAP, 0.15],
  [MOVE_RELOCATE, 0.15],
  [MOVE_NUDGE_ALL, 0.05],
];

/**
 * Builds the move distribution for one run, leaving out moves that cannot
 * apply and sharing their probability among the rest.
 *
 * Without this, a run over identical unrotatable frames spends a third of its
 * iterations drawing a rotation or a swap that does nothing, scoring the
 * unchanged layout and moving on. Measured dead-iteration rates were 35% for
 * identical rectangles with rotation off, and 25% for all-square inventories.
 */
function buildMoveDistribution(frames, opts) {
  const canRotate = opts.allowRotation && frames.some((f) => f.baseW !== f.baseH);
  // Swapping is worthwhile whenever two frames differ in shape, not only in
  // area: a 10x60 and a 20x30 have the same area but trade places usefully.
  const canSwap = frames.some((f) => f.w !== frames[0].w || f.h !== frames[0].h);

  const applicable = MOVE_WEIGHTS.filter(([kind]) => {
    if (kind === MOVE_ROTATE) return canRotate;
    if (kind === MOVE_SWAP) return canSwap;
    return true;
  });

  const totalWeight = applicable.reduce((sum, [, weight]) => sum + weight, 0);
  const cumulative = [];
  let running = 0;
  for (const [kind, weight] of applicable) {
    running += weight / totalWeight;
    cumulative.push([kind, running]);
  }
  return cumulative;
}

/** Draws a move kind from a prepared distribution. */
function drawMoveKind(distribution, roll) {
  for (const [kind, threshold] of distribution) {
    if (roll < threshold) return kind;
  }
  return distribution[distribution.length - 1][0];
}

/**
 * Applies one random move and returns a record describing how to undo it.
 * Returns null only in the rare case where a drawn move turns out not to apply
 * to the particular frames it picked.
 */
function proposeMove(frames, rng, envelope, perFrame, opts, distribution) {
  const kind = drawMoveKind(distribution, rng.float());

  if (kind === MOVE_TRANSLATE) {
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

  if (kind === MOVE_ROTATE) {
    const rotatable = [];
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].baseW !== frames[i].baseH) rotatable.push(i);
    }
    if (rotatable.length === 0) return null;
    const i = rotatable[rng.int(rotatable.length)];
    rotateRect(frames[i]);
    return { kind: MOVE_ROTATE, i };
  }

  if (kind === MOVE_SWAP) {
    // Exchange the positions of two differently shaped frames.
    const i = rng.int(frames.length);
    const j = rng.int(frames.length);
    if (i === j) return null;
    if (frames[i].w === frames[j].w && frames[i].h === frames[j].h) return null;
    swapCenters(frames[i], frames[j]);
    return { kind: MOVE_SWAP, i, j };
  }

  if (kind === MOVE_RELOCATE) {
    // Move the worst-placed frame somewhere else entirely. `perFrame` comes
    // from the last accepted score, so this costs no extra energy evaluation.
    let worst = 0;
    for (let i = 1; i < perFrame.length; i++) {
      if (perFrame[i] > perFrame[worst]) worst = i;
    }
    // With nothing to choose between them, pick at random rather than always
    // landing on frame 0 -- which is the largest frame and the anchor.
    if (perFrame[worst] <= 0) worst = rng.int(frames.length);

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

  for (const axis of ['x', 'y']) {
    const size = axis === 'x' ? 'w' : 'h';

    // Every line a frame could be snapped onto: near edge, centre, far edge.
    // The centre matters as much as the edges — mixed-size frames hung on one
    // centre line share no edge at all.
    const coords = [];
    frames.forEach((f, i) => {
      coords.push({ at: f[axis], i, offset: 0 });
      coords.push({ at: f[axis] + f[size] / 2, i, offset: f[size] / 2 });
      coords.push({ at: f[axis] + f[size], i, offset: f[size] });
    });
    coords.sort((a, b) => a.at - b.at || a.i - b.i);

    let start = 0;
    while (start < coords.length) {
      const anchor = coords[start].at;
      let end = start;
      while (end < coords.length && coords[end].at - anchor <= tolerance) end++;
      const cluster = coords.slice(start, end);
      start = end;

      // Snap the whole cluster onto one consensus line rather than snapping
      // each pair to its own midpoint. Pairwise midpoints moved *both* frames
      // every time, so a frame already sitting on the line got walked off it by
      // its neighbours: three frames starting at 0.0, 1.0 and 2.0 settled at
      // 1.25, 0.875 and 0.875 — two on a line where all three had been within
      // one band.
      if (new Set(cluster.map((c) => c.i)).size < 2) continue;
      const target = cluster.reduce((sum, c) => sum + c.at, 0) / cluster.length;

      const moved = new Set();
      for (const c of cluster) {
        // One snap per frame per cluster: a small frame can offer two of its
        // own lines to the same band, and the second would undo the first.
        if (moved.has(c.i)) continue;
        moved.add(c.i);
        const f = frames[c.i];
        const saved = f[axis];
        f[axis] = target - c.offset;
        // Each frame is accepted or rejected on its own, so one blocked frame
        // no longer costs the rest of its row their alignment.
        if (!pairIsSafe(frames, c.i, c.i, limits)) f[axis] = saved;
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

/**
 * Internals exported for testing.
 *
 * The move/undo pair is the load-bearing part of the rewrite -- a move that is
 * not exactly reversed corrupts the search silently, while every end-to-end
 * assertion still passes, because the output stays legal. That is worth testing
 * directly rather than only through generateLayout.
 */
export const __testing = {
  proposeMove,
  undoMove,
  buildMoveDistribution,
  settle,
  MOVE_KINDS: {
    MOVE_TRANSLATE,
    MOVE_ROTATE,
    MOVE_SWAP,
    MOVE_RELOCATE,
    MOVE_NUDGE_ALL,
  },
};

/**
 * Slides the finished arrangement into its final place on the wall: centred
 * horizontally, and vertically so the group's centre sits at eye level.
 *
 * Galleries hang a whole cluster as though it were one picture, putting its
 * combined centre 145 cm up. Centring on the wall instead puts it at `wallH/2`,
 * which is only eye level on a 290 cm ceiling and is 20 cm low on a standard
 * 250 cm one — an error nobody can correct once the holes are drilled.
 *
 * @param {number} centreHeight Centimetres from the floor to the group's
 *   centre. Zero means "just centre it on the wall".
 */
function positionOnWall(frames, wallW, wallH, centreHeight) {
  const box = boundingBox(frames);
  if (!box) return;
  const dx = wallW / 2 - (box.minX + box.maxX) / 2;

  // `centreHeight` is measured up from the floor; y runs down from the ceiling.
  const targetY = centreHeight > 0 ? wallH - centreHeight : wallH / 2;
  let dy = targetY - (box.minY + box.maxY) / 2;

  // A tall group under a low ceiling cannot reach eye level. Keep it on the
  // wall rather than hanging frames through the ceiling or the floor; on a wall
  // too short to hold the group at all, the top edge wins.
  dy = Math.max(-box.minY, Math.min(dy, wallH - box.maxY));

  for (const f of frames) {
    f.x += dx;
    f.y += dy;
  }
}
