/**
 * The frame inventory: what the user owns, and which of those frames a given
 * layout attempt should actually try to hang.
 *
 * The inventory is a list of rows ("two 20 × 30 frames"); the engine works on
 * *instances* ("this particular 20 × 30 frame"), which is what `expandInventory`
 * produces.
 */

/** Smallest number of frames a layout is still worth generating for. */
export const MIN_FRAMES = 3;

/**
 * Hard ceiling on instances. The annealer's energy function is O(n²) per
 * iteration, so this bounds the worst-case work and keeps the UI responsive
 * no matter what the user types into the count fields.
 */
export const MAX_FRAMES = 60;

/** Largest share of the wall the frames should cover when thinning is allowed. */
const MAX_COVERAGE = 0.4;

/** Smallest share of the available frames a thinned selection may keep. */
const MIN_KEEP_RATIO = 0.6;

const DEFAULT_W = 20;
const DEFAULT_H = 30;

const toInt = (value, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Coerces arbitrary user input into a well-formed inventory. Every downstream
 * module may assume the result holds finite, whole-centimetre, in-range values.
 *
 * @param {Array<{w:*, h:*, count:*, id?:*}>} rows
 * @returns {Array<{id:number, w:number, h:number, count:number}>}
 */
export function normalizeInventory(rows) {
  return rows.map((row, index) => ({
    id: Number.isFinite(row?.id) ? row.id : index + 1,
    w: clamp(toInt(row?.w, DEFAULT_W), 1, 500),
    h: clamp(toInt(row?.h, DEFAULT_H), 1, 500),
    count: clamp(toInt(row?.count, 0), 0, 99),
  }));
}

/** Total number of physical frames described by the inventory. */
export function totalFrameCount(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
}

/**
 * Expands inventory rows into individual placeable frames, largest first.
 *
 * Sorting by area matters: the first frame becomes the layout's anchor, and a
 * gallery wall reads best when the biggest piece is placed first.
 *
 * `baseW`/`baseH` keep the frame's real, unrotated size so that rotation can be
 * toggled freely without accumulating rounding drift.
 *
 * @param {Array} rows Normalized inventory rows.
 * @returns {Array} Frame instances, at most MAX_FRAMES of them.
 */
export function expandInventory(rows) {
  const frames = [];
  let id = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      frames.push({
        id: id++,
        rowId: row.id,
        baseW: row.w,
        baseH: row.h,
        w: row.w,
        h: row.h,
        area: row.w * row.h,
        rotated: false,
        x: 0,
        y: 0,
      });
    }
  }
  // Largest first, with the id as a tiebreaker so the order is fully determined
  // by the inventory rather than by the sort implementation.
  frames.sort((a, b) => b.area - a.area || a.id - b.id);
  return frames.slice(0, MAX_FRAMES);
}

/**
 * Chooses which frames this attempt should hang.
 *
 * With "use all frames" off, a gallery wall looks better when it does not try
 * to use every frame the user owns: the selection is thinned until the frames
 * cover at most MAX_COVERAGE of the wall, then a random count within the
 * remaining range is drawn, optionally nudged to an odd number.
 *
 * Thinning drops the *smallest* frames first, because a gallery wall is
 * anchored by its large pieces — losing the big ones changes the character of
 * the arrangement far more than losing a few small ones.
 *
 * @param {Array} frames Instances from expandInventory (largest first).
 * @param {{wallArea:number, useAll:boolean, preferOdd?:boolean, rng:object}} opts
 * @returns {Array} The subset to lay out, still largest first.
 */
export function selectFrames(frames, { wallArea, useAll, preferOdd = false, rng }) {
  if (frames.length === 0) return [];
  if (useAll) return frames.slice();

  const floor = Math.min(MIN_FRAMES, frames.length);
  const candidates = frames.slice();

  let area = candidates.reduce((sum, f) => sum + f.area, 0);
  while (candidates.length > floor && area / wallArea > MAX_COVERAGE) {
    area -= candidates.pop().area;
  }

  const minCount = Math.max(floor, Math.ceil(candidates.length * MIN_KEEP_RATIO));
  let target = minCount + rng.int(candidates.length - minCount + 1);

  if (preferOdd && target % 2 === 0) {
    // Nudge by one in whichever direction stays inside [minCount, candidates.length].
    const direction = rng.chance(0.5) ? 1 : -1;
    for (const delta of [direction, -direction]) {
      const nudged = target + delta;
      if (nudged >= minCount && nudged <= candidates.length) {
        target = nudged;
        break;
      }
    }
  }

  return candidates.slice(0, target);
}
