/**
 * The frame inventory: what the user owns, and which of those frames a given
 * layout attempt should actually try to hang.
 *
 * The inventory is a list of rows ("two 20 × 30 frames"); the engine works on
 * *instances* ("this particular 20 × 30 frame"), which is what `expandInventory`
 * produces.
 *
 * Rows arrive from the URL as well as from the UI, so every entry point here
 * treats its input as untrusted and returns something well-formed rather than
 * throwing.
 */

/** Smallest number of frames a layout is still worth generating for. */
export const MIN_FRAMES = 3;

/**
 * Hard ceiling on instances. The annealer's energy function is O(n²) per
 * iteration, so this bounds the worst-case work and keeps the UI responsive
 * no matter what the user types into the count fields.
 */
export const MAX_FRAMES = 60;

/** Ceiling on inventory rows, so a hostile URL cannot allocate without bound. */
export const MAX_ROWS = 40;

/** Largest share of the wall the frames should cover when thinning is allowed. */
export const MAX_COVERAGE = 0.4;

/** Smallest share of the available frames a thinned selection may keep. */
export const MIN_KEEP_RATIO = 0.6;

const DEFAULT_W = 20;
const DEFAULT_H = 30;
const MAX_SIDE = 500;
const MAX_COUNT = 99;

/**
 * Coerces one field to a whole number, falling back when the value carries no
 * numeric intent.
 *
 * Blank values are treated as absent rather than as zero: an emptied
 * `<input type="number">` reports `''`, and `Number('')` is 0, which would
 * otherwise clamp to a 1 cm frame instead of restoring the default.
 */
const toInt = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  if (typeof value === 'boolean' || Array.isArray(value)) return fallback;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Coerces arbitrary user input into a well-formed inventory. Every downstream
 * module may assume the result holds finite, whole-centimetre, in-range values
 * and uniquely identified rows.
 *
 * @param {*} rows Anything; non-arrays yield an empty inventory.
 * @returns {Array<{id:number, w:number, h:number, count:number}>}
 */
export function normalizeInventory(rows) {
  if (!Array.isArray(rows)) return [];
  // Ids are assigned here rather than trusted from the input: they arrive from
  // the URL, and `rowId` is what groups frames together in the hanging list, so
  // a collision would merge unrelated rows.
  return rows.slice(0, MAX_ROWS).map((row, index) => ({
    id: index + 1,
    w: clamp(toInt(row?.w, DEFAULT_W), 1, MAX_SIDE),
    h: clamp(toInt(row?.h, DEFAULT_H), 1, MAX_SIDE),
    count: clamp(toInt(row?.count, 0), 0, MAX_COUNT),
  }));
}

/** Total number of physical frames described by the inventory. */
export function totalFrameCount(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => sum + (Number(row?.count) || 0), 0);
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
 * @param {*} rows Inventory rows; ideally normalized, but not required to be.
 * @returns {Array} Frame instances, at most MAX_FRAMES of them.
 */
export function expandInventory(rows) {
  if (!Array.isArray(rows)) return [];

  const frames = [];
  let id = 0;
  for (const row of rows) {
    const w = clamp(toInt(row?.w, DEFAULT_W), 1, MAX_SIDE);
    const h = clamp(toInt(row?.h, DEFAULT_H), 1, MAX_SIDE);
    // Bound the loop itself rather than only its result: an unnormalized
    // `count` of Infinity would otherwise never terminate.
    const count = clamp(toInt(row?.count, 0), 0, MAX_COUNT);
    for (let i = 0; i < count && frames.length < MAX_FRAMES * 2; i++) {
      frames.push({
        id: id++,
        rowId: Number.isInteger(row?.id) ? row.id : 0,
        baseW: w,
        baseH: h,
        w,
        h,
        area: w * h,
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
 * Independent copies of a frame list.
 *
 * The engine mutates frames in place — that is what keeps the annealer's inner
 * loop allocation-free — so anything that restarts the search must start from
 * its own copy.
 */
export function cloneFrames(frames) {
  return frames.map((f) => ({ ...f }));
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
 * the arrangement far more than losing a few small ones. The result is always a
 * prefix of the largest-first input.
 *
 * @param {Array} frames Instances from expandInventory (largest first).
 * @param {{wallW:number, wallH:number, useAll:boolean, preferOdd?:boolean,
 *          rng:object}} opts
 * @returns {Array} Caller-owned copies, still largest first. Empty when the
 *   wall has no usable area.
 */
export function selectFrames(frames, { wallW, wallH, useAll, preferOdd = false, rng }) {
  if (frames.length === 0) return [];

  // A wall with no area cannot be reasoned about — a negative or NaN size would
  // otherwise skip thinning entirely and produce a nonsense layout.
  const wallArea = wallW * wallH;
  if (!(wallArea > 0)) return [];

  if (useAll) return cloneFrames(frames);

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

  return cloneFrames(candidates.slice(0, target));
}
