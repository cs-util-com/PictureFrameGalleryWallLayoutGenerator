/**
 * The cost function the layout engine minimises.
 *
 * Energy is the sum of two kinds of term:
 *
 *   - *Hard* terms (overlap, gap, bounds) describe physical impossibilities.
 *     They are weighted an order of magnitude above everything else so the
 *     annealer never trades a collision for a prettier composition.
 *   - *Soft* terms describe taste: balance, density, silhouette, and how much
 *     grid-like structure the arrangement should show.
 *
 * Lower is better, and terms may be negative (alignment is a reward).
 */

import { clearance, overlapArea } from './geometry.js';

/**
 * Term weights. Kept in one place so the balance between "physically wrong" and
 * "merely ugly" is legible and adjustable.
 */
export const WEIGHTS = {
  overlap: 1000,
  gap: 400,
  bounds: 1000,
  balanceX: 3,
  balanceY: 1,
  voids: 2.5,
  aspect: 1.5,
  rows: 4,
  dispersion: 2,
  rotationMix: 3,
  alignment: 2,
};

/** Two edges within this many centimetres count as aligned. */
const ALIGN_TOLERANCE = 1.5;

/** A run of more than this many co-linear frames starts to read as a grid row. */
const ROW_TOLERANCE = 2;
const MAX_FREE_RUN = 3;

/** Share of aligned frames beyond which extra alignment stops earning credit. */
const ALIGN_REWARD_CAP = 0.4;

/** Floor on the pairwise distance used to weight the size-mixing term, so two
 * frames at the same centre cannot produce an infinite weight. */
const MIN_NEIGHBOUR_DISTANCE = 1;

/**
 * Bundles the parameters that stay constant for a whole annealing run.
 *
 * @param {{wallW:number, wallH:number, gap:number, order:number,
 *          mixSizes:boolean, allowRotation:boolean, targetAspect:number}} params
 */
export function createEnergyContext(params) {
  return {
    wallW: params.wallW,
    wallH: params.wallH,
    gap: params.gap,
    // 0 = salon / Petersburger hang, 1 = ordered grid-like hang.
    order: Math.max(0, Math.min(1, params.order)),
    mixSizes: Boolean(params.mixSizes),
    allowRotation: Boolean(params.allowRotation),
    targetAspect: Math.max(0.1, params.targetAspect || 1),
  };
}

const emptyTerms = () => ({
  overlap: 0,
  gap: 0,
  bounds: 0,
  balanceX: 0,
  balanceY: 0,
  voids: 0,
  aspect: 0,
  rows: 0,
  dispersion: 0,
  rotationMix: 0,
  alignment: 0,
});

/**
 * Scores a layout. Pure: never mutates `frames`.
 *
 * @param {Array} frames Placed frame instances.
 * @param {object} ctx From createEnergyContext.
 * @returns {{total:number, perFrame:number[], terms:object}}
 *   `perFrame[i]` is frame i's share of the hard penalties, which the annealer
 *   uses to pick the worst-placed frame to relocate.
 */
export function computeEnergy(frames, ctx) {
  const n = frames.length;
  const terms = emptyTerms();
  const perFrame = new Array(n).fill(0);
  if (n === 0) return { total: 0, perFrame, terms };

  let totalArea = 0;
  for (const f of frames) totalArea += f.area;
  // Guard against a degenerate inventory; every penalty is area-relative.
  if (totalArea <= 0) totalArea = 1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const aligned = new Set();

  for (let i = 0; i < n; i++) {
    const a = frames[i];

    // --- Bounds: how much of the frame hangs off the wall. ---
    const outX = Math.max(0, -a.x) + Math.max(0, a.x + a.w - ctx.wallW);
    const outY = Math.max(0, -a.y) + Math.max(0, a.y + a.h - ctx.wallH);
    if (outX > 0 || outY > 0) {
      const escaped = outX * a.h + outY * a.w;
      const penalty = (escaped / totalArea) * WEIGHTS.bounds;
      terms.bounds += penalty;
      perFrame[i] += penalty;
    }

    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x + a.w > maxX) maxX = a.x + a.w;
    if (a.y + a.h > maxY) maxY = a.y + a.h;

    for (let j = i + 1; j < n; j++) {
      const b = frames[j];
      const cl = clearance(a, b);

      if (cl < 0) {
        // --- Overlap: frames cannot occupy the same wall. ---
        const penalty = (overlapArea(a, b) / totalArea) * WEIGHTS.overlap;
        terms.overlap += penalty;
        perFrame[i] += penalty;
        perFrame[j] += penalty;
      } else if (ctx.gap > 0 && cl < ctx.gap) {
        // --- Gap: frames closer than the requested spacing. ---
        const penalty = ((ctx.gap - cl) / ctx.gap) * WEIGHTS.gap;
        terms.gap += penalty;
        perFrame[i] += penalty;
        perFrame[j] += penalty;
      }

      if (sharesEdge(a, b)) {
        aligned.add(i);
        aligned.add(j);
      }
    }
  }

  // --- Balance: does the arrangement carry equal visual weight either side of
  // its own centre? Measured as the offset between the area centroid and the
  // bounding-box centre. The original engine instead bucketed each frame wholly
  // left or right of the centre line, which charged a frame sitting *on* the
  // axis as maximum imbalance and gave the annealer a step function to climb
  // rather than a gradient to follow.
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  let momentX = 0;
  let momentY = 0;
  for (const f of frames) {
    momentX += f.area * (f.x + f.w / 2);
    momentY += f.area * (f.y + f.h / 2);
  }
  const halfWidth = Math.max(1, (maxX - minX) / 2);
  const halfHeight = Math.max(1, (maxY - minY) / 2);
  // Horizontal imbalance is far more noticeable on a wall than vertical.
  terms.balanceX = (Math.abs(momentX / totalArea - centerX) / halfWidth) * WEIGHTS.balanceX;
  terms.balanceY = (Math.abs(momentY / totalArea - centerY) / halfHeight) * WEIGHTS.balanceY;

  // --- Voids: empty space trapped inside the arrangement's silhouette. ---
  const boxArea = Math.max(1, (maxX - minX) * (maxY - minY));
  terms.voids = Math.max(0, (boxArea - totalArea) / totalArea) * WEIGHTS.voids;

  // --- Aspect: keep the silhouette near the shape the run is aiming for.
  // Measured in log space so "twice as wide" and "half as wide" cost the same.
  const aspect = Math.max(0.1, (maxX - minX) / Math.max(0.1, maxY - minY));
  terms.aspect = Math.abs(Math.log(aspect / ctx.targetAspect)) * WEIGHTS.aspect;

  // --- Rows: long co-linear runs read as a grid. A salon hang should avoid
  // them; an ordered hang is allowed to have them, so the penalty fades out as
  // `order` rises. (The original engine charged for rows even at maximum order,
  // which fought the very structure the slider was asking for.)
  terms.rows = rowPenalty(frames) * (1 - ctx.order);

  // --- Dispersion: sizes should be mixed across the wall rather than sorted
  // into a big-frames corner and a small-frames corner.
  if (ctx.mixSizes && n > MAX_FREE_RUN) {
    terms.dispersion = dispersionPenalty(frames);
  }

  // --- Rotation mix: when rotation is allowed, using it for none or all of the
  // rectangular frames looks accidental; a mix looks deliberate.
  if (ctx.allowRotation) {
    terms.rotationMix = rotationMixPenalty(frames);
  }

  // --- Alignment: a reward (negative), scaled by how ordered the user wants
  // the wall to be. Capped so the annealer cannot chase alignment forever.
  const alignRatio = Math.min(aligned.size / n, ALIGN_REWARD_CAP);
  const alignReward = alignRatio * WEIGHTS.alignment * ctx.order;
  terms.alignment = alignReward === 0 ? 0 : -alignReward;

  let total = 0;
  for (const value of Object.values(terms)) total += value;
  return { total, perFrame, terms };
}

/** True when the two frames share a horizontal or vertical edge line. */
function sharesEdge(a, b) {
  const t = ALIGN_TOLERANCE;
  const ax =
    Math.abs(a.x - b.x) < t ||
    Math.abs(a.x + a.w - (b.x + b.w)) < t ||
    Math.abs(a.x - (b.x + b.w)) < t ||
    Math.abs(a.x + a.w - b.x) < t;
  const ay =
    Math.abs(a.y - b.y) < t ||
    Math.abs(a.y + a.h - (b.y + b.h)) < t ||
    Math.abs(a.y - (b.y + b.h)) < t ||
    Math.abs(a.y + a.h - b.y) < t;
  return ax || ay;
}

/**
 * Charges for runs of more than MAX_FREE_RUN frames sharing a centre line or a
 * top edge. Quadratic in the excess, so one long row costs more than two short
 * ones.
 */
function rowPenalty(frames) {
  const lines = [
    frames.map((f) => f.y + f.h / 2),
    frames.map((f) => f.x + f.w / 2),
    frames.map((f) => f.y),
  ];
  let penalty = 0;
  for (const values of lines) {
    for (const run of longRuns(values)) {
      penalty += (run - MAX_FREE_RUN) ** 2;
    }
  }
  return (penalty / frames.length) * WEIGHTS.rows;
}

/**
 * Lengths of clusters longer than MAX_FREE_RUN, where a cluster is a set of
 * values each within ROW_TOLERANCE of the previous one.
 *
 * The comparison is against the previous *value*, not the value that started
 * the cluster: three frames at 0, 2 and 4 cm all sit on one visual line even
 * though 4 is more than ROW_TOLERANCE from 0.
 */
function longRuns(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const runs = [];
  let length = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= ROW_TOLERANCE) {
      length++;
    } else {
      if (length > MAX_FREE_RUN) runs.push(length);
      length = 1;
    }
  }
  if (length > MAX_FREE_RUN) runs.push(length);
  return runs;
}

/**
 * Measures how strongly similar sizes clump together, as Moran's I over frame
 * areas with inverse-distance weights:
 *
 *    I > 0  like sizes sit next to like sizes (big-frame corner, small-frame
 *           corner) — exactly what "mix sizes" is meant to prevent
 *    I ~ 0  sizes are spread evenly across the wall
 *    I < 0  sizes strictly alternate
 *
 * Only positive autocorrelation is charged for. Rewarding negative values would
 * push the annealer toward artificial checkerboards, which is not what mixing
 * means either.
 *
 * This replaces the original "variance of each frame's mean neighbour area",
 * which needed a per-frame sort inside the annealer's inner loop and scored
 * some genuinely segregated layouts as perfectly mixed (any arrangement where
 * every frame happens to see the same neighbour mix scores exactly zero).
 */
function dispersionPenalty(frames) {
  const n = frames.length;
  const cx = frames.map((f) => f.x + f.w / 2);
  const cy = frames.map((f) => f.y + f.h / 2);

  let mean = 0;
  for (const f of frames) mean += f.area;
  mean /= n;

  const deviation = frames.map((f) => f.area - mean);
  let variance = 0;
  for (const d of deviation) variance += d * d;
  // Every frame the same size: there is nothing to mix.
  if (variance <= 0) return 0;

  let numerator = 0;
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = Math.hypot(cx[i] - cx[j], cy[i] - cy[j]);
      const weight = 1 / Math.max(distance, MIN_NEIGHBOUR_DISTANCE);
      // Each unordered pair contributes to both (i, j) and (j, i).
      weightSum += 2 * weight;
      numerator += 2 * weight * deviation[i] * deviation[j];
    }
  }
  if (weightSum <= 0) return 0;

  const moransI = (n / weightSum) * (numerator / variance);
  return Math.max(0, moransI) * WEIGHTS.dispersion;
}

/**
 * Charges for a rotation split outside roughly a quarter-to-three-quarters
 * range. Square frames are ignored: rotating them changes nothing.
 */
function rotationMixPenalty(frames) {
  const rectangular = frames.filter((f) => f.baseW !== f.baseH);
  if (rectangular.length < MAX_FREE_RUN) return 0;

  const rotated = rectangular.filter((f) => f.rotated).length;
  const { min, max } = rotationBounds(rectangular.length);

  let distance = 0;
  if (rotated < min) distance = min - rotated;
  else if (rotated > max) distance = rotated - max;
  return distance * distance * WEIGHTS.rotationMix;
}

/** Acceptable number of rotated frames for a given count of rectangular ones. */
export function rotationBounds(count) {
  if (count === 3) return { min: 1, max: 2 };
  return { min: count * 0.25, max: count * 0.75 };
}
