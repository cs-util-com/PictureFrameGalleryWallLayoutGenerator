import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE, encodeState, decodeState, saveState, loadState } from '../src/state.js';

const custom = {
  inventory: [
    { w: 30, h: 40, count: 3 },
    { w: 13, h: 18, count: 1 },
  ],
  wallW: 250,
  wallH: 180,
  gap: 4,
  hangerDrop: 2.5,
  centreHeight: 150,
  seed: 987654,
  options: { allowRotation: false, useAll: true, preferOdd: false, mixSizes: true, order: 0.25 },
};

describe('encodeState / decodeState', () => {
  it('round-trips a complete state', () => {
    expect(decodeState(encodeState(custom))).toEqual(custom);
  });

  it('round-trips the defaults', () => {
    expect(decodeState(encodeState(DEFAULT_STATE))).toEqual(DEFAULT_STATE);
  });

  it('is stable: encoding a decoded state gives the same string', () => {
    const once = encodeState(custom);
    expect(encodeState(decodeState(once))).toBe(once);
  });

  it('produces a query string short enough to share', () => {
    expect(encodeState(custom).length).toBeLessThan(120);
  });

  it('carries the seed exactly, since it is what reproduces the layout', () => {
    for (const seed of [0, 1, 9999999, 2147483647]) {
      expect(decodeState(encodeState({ ...custom, seed })).seed).toBe(seed);
    }
  });

  it('accepts a leading question mark', () => {
    const encoded = encodeState(custom);
    expect(decodeState('?' + encoded)).toEqual(decodeState(encoded));
  });

  it('preserves every inventory row', () => {
    const many = {
      ...custom,
      inventory: [
        { w: 10, h: 15, count: 4 },
        { w: 20, h: 30, count: 2 },
        { w: 50, h: 70, count: 1 },
      ],
    };
    expect(decodeState(encodeState(many)).inventory).toEqual(many.inventory);
  });

  it('round-trips every order value the slider can produce', () => {
    for (let percent = 0; percent <= 100; percent++) {
      const state = { ...custom, options: { ...custom.options, order: percent / 100 } };
      expect(decodeState(encodeState(state)).options.order).toBeCloseTo(percent / 100, 10);
    }
  });

  it('round-trips every combination of the boolean options', () => {
    for (let bits = 0; bits < 16; bits++) {
      const options = {
        ...custom.options,
        allowRotation: Boolean(bits & 1),
        useAll: Boolean(bits & 2),
        preferOdd: Boolean(bits & 4),
        mixSizes: Boolean(bits & 8),
      };
      expect(decodeState(encodeState({ ...custom, options })).options).toEqual(options);
    }
  });
});

describe('the hook drop', () => {
  it('travels in the link, because the nail table is the deliverable', () => {
    expect(decodeState(encodeState(custom)).hangerDrop).toBe(2.5);
  });

  it('keeps half-centimetre precision', () => {
    for (const drop of [0, 0.5, 1, 2.5, 7.5, 50]) {
      expect(decodeState(encodeState({ ...custom, hangerDrop: drop })).hangerDrop).toBe(drop);
    }
  });

  it('defaults to zero and clamps nonsense', () => {
    expect(decodeState('').hangerDrop).toBe(0);
    expect(decodeState('k=-40').hangerDrop).toBeGreaterThanOrEqual(0);
    expect(decodeState('k=99999').hangerDrop).toBeLessThanOrEqual(50);
    expect(Number.isFinite(decodeState('k=abc').hangerDrop)).toBe(true);
  });
});

describe('the eye-level anchor', () => {
  it('travels in the link', () => {
    expect(decodeState(encodeState({ ...custom, centreHeight: 152 })).centreHeight).toBe(152);
  });

  it('defaults to the 145 cm gallery standard', () => {
    expect(decodeState('').centreHeight).toBe(145);
  });

  it('treats zero as "centre on the wall" rather than as a height', () => {
    expect(decodeState('c=0').centreHeight).toBe(0);
  });

  it('clamps nonsense', () => {
    expect(decodeState('c=-40').centreHeight).toBeGreaterThanOrEqual(0);
    expect(decodeState('c=99999').centreHeight).toBeLessThanOrEqual(400);
    expect(Number.isFinite(decodeState('c=abc').centreHeight)).toBe(true);
  });
});

describe('decodeState: untrusted input', () => {
  it('falls back to defaults for an empty query string', () => {
    expect(decodeState('')).toEqual(DEFAULT_STATE);
    expect(decodeState(undefined)).toEqual(DEFAULT_STATE);
  });

  it('fills in defaults for parameters that are missing', () => {
    const decoded = decodeState('s=42');
    expect(decoded.seed).toBe(42);
    expect(decoded.wallW).toBe(DEFAULT_STATE.wallW);
    expect(decoded.inventory).toEqual(DEFAULT_STATE.inventory);
  });

  it('ignores junk values rather than producing a broken state', () => {
    const decoded = decodeState('w=abc&h=-50&g=nope&s=xyz&o=999&i=garbage');
    expect(decoded.wallW).toBeGreaterThan(0);
    expect(decoded.wallH).toBeGreaterThan(0);
    expect(decoded.gap).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(decoded.seed)).toBe(true);
    expect(decoded.options.order).toBeGreaterThanOrEqual(0);
    expect(decoded.options.order).toBeLessThanOrEqual(1);
  });

  it('clamps an out-of-range wall and gap', () => {
    const decoded = decodeState('w=99999&h=1&g=99999');
    expect(decoded.wallW).toBeLessThanOrEqual(2000);
    expect(decoded.wallH).toBeGreaterThanOrEqual(20);
    expect(decoded.gap).toBeLessThanOrEqual(100);
  });

  it('never returns an inventory row with a zero or negative size', () => {
    const decoded = decodeState('i=0x0x2_-5x-5x1');
    for (const row of decoded.inventory) {
      expect(row.w).toBeGreaterThan(0);
      expect(row.h).toBeGreaterThan(0);
      expect(row.count).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls back to the default inventory when every row is unusable', () => {
    expect(decodeState('i=').inventory).toEqual(DEFAULT_STATE.inventory);
  });

  it('does not let a hostile URL allocate without bound', () => {
    const huge = 'i=' + Array.from({ length: 5000 }, () => '10x10x99').join('_');
    const decoded = decodeState(huge);
    expect(decoded.inventory.length).toBeLessThanOrEqual(40);
  });
});

describe('saveState / loadState', () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  };

  it('round-trips through storage', () => {
    const storage = fakeStorage();
    saveState(storage, custom);
    expect(loadState(storage)).toEqual(custom);
  });

  it('returns null when nothing has been saved', () => {
    expect(loadState(fakeStorage())).toBeNull();
  });

  it('returns null rather than throwing on corrupt stored data', () => {
    const storage = fakeStorage();
    storage.setItem('gallery-wall:state', '{not json');
    expect(loadState(storage)).toBeNull();
  });

  it('ignores stored data written by an incompatible version', () => {
    const storage = fakeStorage();
    storage.setItem('gallery-wall:state', JSON.stringify({ version: 999, state: custom }));
    expect(loadState(storage)).toBeNull();
  });

  it('normalises whatever it loads, so old data cannot poison the app', () => {
    const storage = fakeStorage();
    saveState(storage, { ...custom, wallW: -10, inventory: [{ w: 'x', h: null, count: 500 }] });
    const loaded = loadState(storage);
    expect(loaded.wallW).toBeGreaterThan(0);
    expect(loaded.inventory[0].count).toBeLessThanOrEqual(99);
  });

  it('survives storage that throws, as in private browsing modes', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {},
    };
    expect(() => saveState(hostile, custom)).not.toThrow();
    expect(loadState(hostile)).toBeNull();
  });

  it('tolerates a missing storage object entirely', () => {
    expect(() => saveState(null, custom)).not.toThrow();
    expect(loadState(null)).toBeNull();
  });
});
