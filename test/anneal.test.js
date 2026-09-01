import { describe, it, expect } from 'vitest';
import { __testing } from '../src/layout.js';
import { createRng } from '../src/prng.js';

const { proposeMove, undoMove, buildMoveDistribution, MOVE_KINDS } = __testing;

const frame = (id, x, y, w, h) => ({
  id,
  rowId: 0,
  baseW: w,
  baseH: h,
  w,
  h,
  area: w * h,
  rotated: false,
  x,
  y,
});

const envelope = { x: 10, y: 10, w: 180, h: 140, aspect: 1.3 };
const opts = { allowRotation: true, order: 0.5, mixSizes: true, useAll: true, preferOdd: false };

const snapshot = (frames) =>
  frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rotated }));

const mixed = () => [
  frame(0, 20, 20, 40, 60),
  frame(1, 80, 20, 30, 20),
  frame(2, 20, 90, 20, 20),
  frame(3, 90, 90, 25, 35),
];

describe('move and undo', () => {
  it('restores the layout exactly, for every kind of move', () => {
    // A move that is not exactly reversed corrupts the search silently: the
    // output stays legal, so no end-to-end assertion notices.
    const seen = new Set();
    for (let seed = 0; seed < 400; seed++) {
      const frames = mixed();
      const before = snapshot(frames);
      const rng = createRng(seed);
      const distribution = buildMoveDistribution(frames, opts);
      const perFrame = frames.map((_, i) => i);

      const move = proposeMove(frames, rng, envelope, perFrame, opts, distribution);
      if (!move) continue;
      seen.add(move.kind);
      undoMove(frames, move);

      expect(snapshot(frames), `move kind ${move.kind}, seed ${seed}`).toEqual(before);
    }
    // The sweep is only meaningful if it actually exercised every move.
    expect(seen).toEqual(new Set(Object.values(MOVE_KINDS)));
  });

  it('does not drift over hundreds of thousands of applied and undone moves', () => {
    const frames = mixed();
    const before = snapshot(frames);
    const rng = createRng(7);
    const distribution = buildMoveDistribution(frames, opts);
    const perFrame = frames.map(() => 0);

    for (let i = 0; i < 200000; i++) {
      const move = proposeMove(frames, rng, envelope, perFrame, opts, distribution);
      if (move) undoMove(frames, move);
    }

    const after = snapshot(frames);
    for (let i = 0; i < frames.length; i++) {
      // Well below EPSILON (0.01 cm), and in practice below 1e-12.
      expect(Math.abs(after[i].x - before[i].x)).toBeLessThan(1e-6);
      expect(Math.abs(after[i].y - before[i].y)).toBeLessThan(1e-6);
      expect(after[i].w).toBe(before[i].w);
      expect(after[i].h).toBe(before[i].h);
      expect(after[i].rot).toBe(before[i].rot);
    }
  });

  it('actually changes something when it reports a move', () => {
    // An undo test passes trivially if the move was a no-op.
    for (let seed = 0; seed < 200; seed++) {
      const frames = mixed();
      const before = snapshot(frames);
      const rng = createRng(seed);
      const move = proposeMove(
        frames,
        rng,
        envelope,
        frames.map((_, i) => i),
        opts,
        buildMoveDistribution(frames, opts)
      );
      if (!move) continue;
      expect(snapshot(frames), `move kind ${move.kind}, seed ${seed}`).not.toEqual(before);
    }
  });

  it('keeps every frame at its real size or that size turned', () => {
    const frames = mixed();
    const rng = createRng(3);
    const distribution = buildMoveDistribution(frames, opts);
    for (let i = 0; i < 20000; i++) {
      proposeMove(
        frames,
        rng,
        envelope,
        frames.map(() => 0),
        opts,
        distribution
      );
      for (const f of frames) {
        const upright = f.w === f.baseW && f.h === f.baseH;
        const turned = f.w === f.baseH && f.h === f.baseW;
        expect(upright || turned).toBe(true);
        expect(f.rotated).toBe(turned && !upright ? true : f.rotated);
      }
    }
  });
});

describe('the move distribution', () => {
  it('offers every move when the frames allow all of them', () => {
    const kinds = buildMoveDistribution(mixed(), opts).map(([kind]) => kind);
    expect(new Set(kinds)).toEqual(new Set(Object.values(MOVE_KINDS)));
  });

  it('drops rotation when it is switched off', () => {
    const kinds = buildMoveDistribution(mixed(), { ...opts, allowRotation: false }).map(([k]) => k);
    expect(kinds).not.toContain(MOVE_KINDS.MOVE_ROTATE);
  });

  it('drops rotation when every frame is square', () => {
    const squares = [frame(0, 0, 0, 20, 20), frame(1, 40, 0, 20, 20), frame(2, 0, 40, 20, 20)];
    const kinds = buildMoveDistribution(squares, opts).map(([k]) => k);
    expect(kinds).not.toContain(MOVE_KINDS.MOVE_ROTATE);
  });

  it('drops swapping when every frame is the same shape', () => {
    const same = [frame(0, 0, 0, 20, 30), frame(1, 40, 0, 20, 30), frame(2, 0, 40, 20, 30)];
    const kinds = buildMoveDistribution(same, { ...opts, allowRotation: false }).map(([k]) => k);
    expect(kinds).not.toContain(MOVE_KINDS.MOVE_SWAP);
  });

  it('keeps swapping for equal-area frames of different shapes', () => {
    // A 10x60 and a 20x30 have the same area but trade places usefully.
    const equalArea = [frame(0, 0, 0, 10, 60), frame(1, 40, 0, 20, 30)];
    const kinds = buildMoveDistribution(equalArea, opts).map(([k]) => k);
    expect(kinds).toContain(MOVE_KINDS.MOVE_SWAP);
  });

  it('always sums to one so no draw falls off the end', () => {
    for (const frames of [mixed(), [frame(0, 0, 0, 20, 20), frame(1, 40, 0, 20, 20)]]) {
      for (const allowRotation of [true, false]) {
        const dist = buildMoveDistribution(frames, { ...opts, allowRotation });
        expect(dist[dist.length - 1][1]).toBeCloseTo(1, 10);
      }
    }
  });

  it('wastes no draws on moves that cannot apply', () => {
    // Identical unrotatable frames previously spent a third of every run
    // proposing rotations and swaps that did nothing.
    const same = [frame(0, 0, 0, 20, 30), frame(1, 40, 0, 20, 30), frame(2, 0, 40, 20, 30)];
    const settings = { ...opts, allowRotation: false };
    const distribution = buildMoveDistribution(same, settings);
    const rng = createRng(11);
    let nulls = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i++) {
      const frames = same.map((f) => ({ ...f }));
      const move = proposeMove(
        frames,
        rng,
        envelope,
        frames.map(() => 0),
        settings,
        distribution
      );
      if (!move) nulls++;
    }
    expect(nulls / trials).toBeLessThan(0.05);
  });
});

describe('choosing which frame to relocate', () => {
  it('targets the worst-scoring frame when the scores differ', () => {
    const frames = mixed();
    const perFrame = [0, 0, 99, 0];
    const rng = createRng(1);
    const distribution = [[MOVE_KINDS.MOVE_RELOCATE, 1]];
    const move = proposeMove(frames, rng, envelope, perFrame, opts, distribution);
    expect(move.kind).toBe(MOVE_KINDS.MOVE_RELOCATE);
    expect(move.i).toBe(2);
  });

  it('spreads its choice when every frame scores the same', () => {
    // Scores tie at zero as soon as the layout is legal. Taking the first
    // maximum then relocates frame 0 -- the anchor -- for the rest of the run.
    const distribution = [[MOVE_KINDS.MOVE_RELOCATE, 1]];
    const chosen = new Set();
    for (let seed = 0; seed < 60; seed++) {
      const frames = mixed();
      const move = proposeMove(
        frames,
        createRng(seed),
        envelope,
        frames.map(() => 0),
        opts,
        distribution
      );
      chosen.add(move.i);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });
});
