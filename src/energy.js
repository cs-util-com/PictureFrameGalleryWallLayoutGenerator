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
import { MAX_FRAMES } from './inventory.js';

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
  alignment: 8,
  // Not part of the total: this one only scores individual frames, to decide
  // which frame the annealer should try relocating.
  isolation: 50,
};

/** Two edges within this many centimetres count as aligned. */
const ALIGN_TOLERANCE = 1.5;

/**
 * How much of the void penalty is lifted at maximum `order`.
 *
 * Not all of it: even an ordered hang should stay a group rather than drifting
 * apart across the wall.
 */
const VOID_ORDER_FADE = 0.6;

/**
 * The cluster score that counts as fully aligned.
 *
 * A clean grid of n frames scores a little over 2(n-1)² across both axes, so
 * this puts a real grid at the top of the range while leaving ordinary layouts
 * a gradient to climb rather than a ceiling to sit against.
 */
const ALIGN_FULL_SCORE = (n) => 2 * (n - 1) ** 2;

/** A run of more than this many co-linear frames starts to read as a grid row. */
const ROW_TOLERANCE = 2;
const MAX_FREE_RUN = 3;

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
 *   `perFrame[i]` scores how badly placed frame i is, and is what the annealer
 *   uses to choose a frame to relocate. It is deliberately not a decomposition
 *   of `total`: it combines the frame's share of the hard penalties with how
 *   isolated it is.
 *
 *   Hard penalties alone are not enough. They fall to zero as soon as the
 *   layout is merely legal, after which every frame scores 0, the "worst"
 *   frame is always index 0, and the relocate move spends the rest of the run
 *   flinging the largest frame -- the composition's anchor -- around at random.
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
  // Closest neighbour for each frame, for the isolation score below.
  const nearest = new Array(n).fill(Infinity);

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

      if (cl < nearest[i]) nearest[i] = cl;
      if (cl < nearest[j]) nearest[j] = cl;
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

  // --- Voids: how fully the frames pack their own bounding box.
  //
  // This fades as `order` rises, for the same reason `rows` does. A grid of
  // mixed-size frames must leave slack in every cell — that regular negative
  // space *is* the Rasterhängung — so charging full price for it at maximum
  // "ordered" charged for the very thing being asked for. Density and structure
  // pull against each other, and at the ordered end structure should win.
  //
  // On its own this barely moves the output -- the grid seed does that work --
  // but it stops the cost function contradicting the slider.
  const boxArea = Math.max(1, (maxX - minX) * (maxY - minY));
  terms.voids =
    Math.max(0, (boxArea - totalArea) / totalArea) *
    WEIGHTS.voids *
    (1 - VOID_ORDER_FADE * ctx.order);

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

  // --- Alignment: what the Style slider actually controls. An ordered hang is
  // rewarded for lining frames up; a salon hang is penalised for it, so the
  // slider has range in both directions rather than merely withholding a bonus
  // at one end.
  //
  // Measured by how far the frames commit to *shared lines*, not by how many
  // pairs happen to agree. See `alignmentScore`.
  const orderBias = 2 * ctx.order - 1;
  const alignment = -alignmentScore(frames) * WEIGHTS.alignment * orderBias;
  terms.alignment = alignment === 0 ? 0 : alignment;

  // --- Isolation, per frame only. A frame sitting far from its nearest
  // neighbour is the one worth moving, whether or not it breaks any rule.
  // Measured against a typical frame's size so the score is scale-free.
  if (n > 1) {
    const typicalSize = Math.sqrt(totalArea / n);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(nearest[i])) continue;
      const excess = Math.max(0, nearest[i] - ctx.gap);
      perFrame[i] += (excess / typicalSize) * WEIGHTS.isolation;
    }
  }

  let total = 0;
  for (const value of Object.values(terms)) total += value;
  return { total, perFrame, terms };
}

/**
 * How far the frames commit to shared lines, from 0 (nothing lines up) to 1.
 *
 * Counting aligned *pairs* — which is what this did — rewards scattered local
 * agreement exactly as much as structure: six frames on one line and three
 * unrelated aligned pairs score the same per pair, so the annealer was never
 * paid to consolidate. It bought pair count instead, and the largest line it
 * would build on a nine-frame wall grew from 2.25 frames to only 3.00 across
 * the whole slider.
 *
 * Clustering the candidate lines and squaring each cluster's size fixes the
 * incentive: one line of six is worth 25 where three separate pairs are worth
 * 3. That is the difference between a Kantenhängung and a scatter of
 * coincidences. It also raises the ceiling on large arrangements: a k-by-k grid
 * now earns 3k/(k+1)² of the maximum where the pair ratio paid 2/(k+1). The
 * reward still thins as the wall grows, but far more slowly.
 *
 * O(n log n), and it replaces an O(n²) predicate in the annealer's hot loop.
 */
function alignmentScore(frames) {
  const n = frames.length;
  if (n < 2) return 0;

  // This runs on every energy evaluation, so it reuses scratch buffers and
  // packs each coordinate with its frame index into one sortable number rather
  // than allocating 6n objects per call. Written naively it doubled the cost of
  // computeEnergy (8.5 -> 18.3 µs on twenty frames), which the annealer pays
  // several million times per layout.
  const count = 3 * n;
  const coords = scratchCoords(count);
  const seen = scratchSeen(n);

  let score = 0;
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const at = axis === 0 ? f.x : f.y;
      const extent = axis === 0 ? f.w : f.h;
      // Near edge, centre line and far edge: a Kantenhängung uses all three.
      coords[i * 3] = pack(at, i);
      coords[i * 3 + 1] = pack(at + extent / 2, i);
      coords[i * 3 + 2] = pack(at + extent, i);
    }
    // Typed-array sort is numeric, and the packing keeps each coordinate's
    // frame index in the low bits so it survives the sort.
    coords.sort();

    // Sweep into clusters against the coordinate that opened each one, so the
    // banding is transitive and a long stagger cannot drift into one cluster.
    let start = 0;
    while (start < count) {
      const anchor = unpackValue(coords[start]);
      let end = start;
      let members = 0;
      // `seen` is stamped with the cluster's start index instead of being
      // cleared, so counting distinct frames costs nothing per cluster.
      const stamp = axis * count + start + 1;
      while (end < count && unpackValue(coords[end]) - anchor <= ALIGN_TOLERANCE) {
        const owner = unpackIndex(coords[end]);
        if (seen[owner] !== stamp) {
          seen[owner] = stamp;
          members++;
        }
        end++;
      }
      // A single frame's own edges falling in one cluster is not alignment.
      if (members > 1) score += (members - 1) * (members - 1);
      start = end;
    }
  }

  return Math.min(1, score / ALIGN_FULL_SCORE(n));
}

/**
 * Packs a centimetre coordinate and a frame index into one sortable double.
 *
 * The coordinate is quantised to 1/100 cm — far finer than ALIGN_TOLERANCE, and
 * finer than anyone can mark a wall — then shifted to leave room for the index
 * in the low digits. Everything stays an exact integer well inside 2^53.
 *
 * PACK_SCALE bounds the frame count: an index of PACK_SCALE or more would carry
 * into the coordinate bits. MAX_FRAMES (60) is well under it — see the
 * assertion below, which fails loudly rather than corrupting a layout.
 */
const PACK_SCALE = 128;
const PACK_QUANTUM = 100;
const pack = (value, index) => Math.round(value * PACK_QUANTUM) * PACK_SCALE + index;
const unpackValue = (key) => Math.floor(key / PACK_SCALE) / PACK_QUANTUM;
// Floored modulo, not `%`. Frames sit at negative coordinates while the
// annealer works, and JS `%` truncates toward zero -- `-127999 % 128` is -127,
// not 1 -- so a negative key produced a negative index. Indexing an Int32Array
// with that reads undefined and drops the write, which silently disabled the
// distinct-frame dedupe and made the score depend on where the group sat.
const unpackIndex = (key) => key - Math.floor(key / PACK_SCALE) * PACK_SCALE;

// Sized exactly, so `sort()` needs no per-call subarray view. The frame count
// is constant for a whole annealing run, so this allocates once per run.
// An index of PACK_SCALE or more would carry into the coordinate bits and
// silently corrupt every score. Fail loudly at load instead.
if (MAX_FRAMES >= PACK_SCALE) {
  throw new Error(`alignmentScore packing holds ${PACK_SCALE - 1} frames, not ${MAX_FRAMES}`);
}

let coordBuffer = new Float64Array(0);
const scratchCoords = (size) => {
  if (coordBuffer.length !== size) coordBuffer = new Float64Array(size);
  return coordBuffer;
};

let seenBuffer = new Int32Array(0);
const scratchSeen = (size) => {
  if (seenBuffer.length < size) seenBuffer = new Int32Array(size * 2);
  else seenBuffer.fill(0, 0, size);
  return seenBuffer;
};

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
