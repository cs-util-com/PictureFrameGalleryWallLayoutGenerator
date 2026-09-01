/**
 * Everything that defines a wall, encoded compactly enough to live in a URL.
 *
 * The URL carries the full state rather than just the seed, so a shared link
 * reproduces the exact layout the sender was looking at — the same seed against
 * a different inventory or wall produces a completely different arrangement.
 *
 * Both entry points treat their input as untrusted: a URL can be edited by
 * hand, and stored data can outlive the code that wrote it.
 */

import { normalizeInventory, MAX_ROWS } from './inventory.js';

const STORAGE_KEY = 'gallery-wall:state';

/** Bumped only when stored data can no longer be read; older data is discarded. */
const STORAGE_VERSION = 1;

const LIMITS = {
  wall: { min: 20, max: 2000 },
  gap: { min: 0, max: 100 },
  seed: { min: 0, max: 2147483647 },
};

/** The wall a first-time visitor sees. */
export const DEFAULT_STATE = Object.freeze({
  inventory: [
    { w: 20, h: 30, count: 2 },
    { w: 13, h: 18, count: 2 },
    { w: 10, h: 15, count: 4 },
  ],
  wallW: 300,
  wallH: 200,
  gap: 7,
  seed: 0,
  options: Object.freeze({
    allowRotation: true,
    useAll: false,
    preferOdd: true,
    mixSizes: true,
    order: 0.5,
  }),
});

const clamp = (value, { min, max }) => Math.max(min, Math.min(max, value));

/**
 * Reads one numeric parameter, clamped into range.
 *
 * A missing parameter is `null`, and `Number(null)` is 0 — so without this
 * guard an absent width would clamp to the 20 cm minimum instead of falling
 * back to the default.
 */
const intOr = (raw, fallback, range) => {
  if (raw === null || raw === undefined || raw === '') return clamp(fallback, range);
  if (typeof raw === 'string' && raw.trim() === '') return clamp(fallback, range);
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return clamp(fallback, range);
  return clamp(n, range);
};

const flag = (raw, fallback) => (raw === '1' ? true : raw === '0' ? false : fallback);

/**
 * Encodes state as a query string (without the leading `?`).
 *
 * Parameters are single letters and the inventory is packed as
 * `WxHxCOUNT_WxHxCOUNT`, which keeps a shared link short enough to paste into a
 * message without it wrapping.
 */
export function encodeState(state) {
  const params = new URLSearchParams();
  params.set('i', state.inventory.map((r) => `${r.w}x${r.h}x${r.count}`).join('_'));
  params.set('w', String(state.wallW));
  params.set('h', String(state.wallH));
  params.set('g', String(state.gap));
  params.set('s', String(state.seed));
  params.set('o', String(Math.round(state.options.order * 100)));
  params.set('r', state.options.allowRotation ? '1' : '0');
  params.set('a', state.options.useAll ? '1' : '0');
  params.set('d', state.options.preferOdd ? '1' : '0');
  params.set('m', state.options.mixSizes ? '1' : '0');
  // Underscores and the size separator survive as themselves; encoding them
  // would triple the length of the inventory parameter for no benefit.
  return params.toString().replace(/%5F/g, '_');
}

/**
 * Decodes a query string back into state, substituting defaults for anything
 * missing, malformed or out of range.
 *
 * @param {string|undefined} search With or without a leading `?`.
 */
export function decodeState(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
  const defaults = DEFAULT_STATE;

  const inventory = parseInventory(params.get('i'));

  return {
    inventory: inventory.length > 0 ? inventory : defaults.inventory.map((r) => ({ ...r })),
    wallW: intOr(params.get('w'), defaults.wallW, LIMITS.wall),
    wallH: intOr(params.get('h'), defaults.wallH, LIMITS.wall),
    gap: intOr(params.get('g'), defaults.gap, LIMITS.gap),
    seed: intOr(params.get('s'), defaults.seed, LIMITS.seed),
    options: {
      allowRotation: flag(params.get('r'), defaults.options.allowRotation),
      useAll: flag(params.get('a'), defaults.options.useAll),
      preferOdd: flag(params.get('d'), defaults.options.preferOdd),
      mixSizes: flag(params.get('m'), defaults.options.mixSizes),
      order: intOr(params.get('o'), defaults.options.order * 100, { min: 0, max: 100 }) / 100,
    },
  };
}

/** Parses `WxHxCOUNT_WxHxCOUNT`, discarding anything that is not three numbers. */
function parseInventory(raw) {
  if (!raw) return [];
  const rows = raw
    // Bound the work before parsing: a hostile URL should not be able to make
    // the app allocate one object per megabyte of query string.
    .split('_')
    .slice(0, MAX_ROWS)
    .map((part) => {
      const [w, h, count] = part.split('x');
      if (w === undefined || h === undefined || count === undefined) return null;
      return { w, h, count };
    })
    .filter(Boolean);
  return normalizeInventory(rows).map(({ w, h, count }) => ({ w, h, count }));
}

/**
 * Saves state for the next visit. Storage can be unavailable or full — in a
 * private window it throws on access — and failing to remember a setting is
 * never worth breaking the app over.
 */
export function saveState(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, state }));
  } catch {
    // Nothing to do: the app works fine without persistence.
  }
}

/**
 * Loads previously saved state.
 *
 * @returns {object|null} null when there is nothing usable to restore, which
 *   the caller should read as "start from the defaults".
 */
export function loadState(storage) {
  let parsed;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || parsed.version !== STORAGE_VERSION || !parsed.state) return null;

  // Stored data can predate the current validation rules, so it goes through
  // the same normalisation as a hand-edited URL.
  return decodeState(encodeState(withDefaults(parsed.state)));
}

/** Fills any gaps in a partial state object so it can be encoded. */
function withDefaults(state) {
  const inventory = normalizeInventory(state.inventory).map(({ w, h, count }) => ({ w, h, count }));
  return {
    inventory: inventory.length > 0 ? inventory : DEFAULT_STATE.inventory.map((r) => ({ ...r })),
    wallW: intOr(state.wallW, DEFAULT_STATE.wallW, LIMITS.wall),
    wallH: intOr(state.wallH, DEFAULT_STATE.wallH, LIMITS.wall),
    gap: intOr(state.gap, DEFAULT_STATE.gap, LIMITS.gap),
    seed: intOr(state.seed, DEFAULT_STATE.seed, LIMITS.seed),
    options: { ...DEFAULT_STATE.options, ...(state.options || {}) },
  };
}
