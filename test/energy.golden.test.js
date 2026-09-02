import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createEnergyContext, computeEnergy } from '../src/energy.js';
import { createRng } from '../src/prng.js';

/**
 * Bit-exactness guard for the cost function.
 *
 * Optimising `computeEnergy` is worthwhile — it is the hot loop, called
 * millions of times per layout — but it must not change what the engine
 * decides. A single differing least-significant bit flips one accept/reject in
 * a twenty-thousand-iteration anneal and diverges the whole search, so every
 * layout anyone has ever shared a link to would render differently.
 *
 * The behavioural tests in energy.test.js cannot catch that: they assert
 * inequalities and signs, which survive a change of the last few bits. This
 * fingerprints the exact double returned for every term, over a corpus built to
 * reach the awkward paths — overlapping and coincident frames, shared centre
 * lines, negative and off-wall coordinates, a zero gap, both option toggles, and
 * every interesting slider position.
 *
 * If a change is *meant* to alter the numbers, this test fails and the hash is
 * re-baselined deliberately in the same commit, rather than the change going
 * unnoticed.
 */

/** Builds a fixed corpus of layouts and contexts from a seeded PRNG. */
function* corpus() {
  const rng = createRng(20260902);
  for (const n of [1, 2, 3, 5, 8, 13, 24]) {
    for (const order of [0, 0.35, 0.5, 1]) {
      for (const mixSizes of [true, false]) {
        for (const allowRotation of [true, false]) {
          for (const gap of [0, 7]) {
            const frames = [];
            for (let i = 0; i < n; i++) {
              // Deliberately unconstrained: frames may overlap, share centre
              // lines, coincide exactly, or hang off the wall, because the
              // annealer routinely proposes all of those.
              const w = 5 + Math.round(rng.float() * 45);
              const h = 5 + Math.round(rng.float() * 45);
              const rotated = allowRotation && rng.chance(0.4);
              frames.push({
                x: Math.round(rng.range(-60, 260) * 100) / 100,
                y: Math.round(rng.range(-60, 260) * 100) / 100,
                w: rotated ? h : w,
                h: rotated ? w : h,
                baseW: w,
                baseH: h,
                area: w * h,
                rotated,
              });
            }
            // Force some exact coincidences, which ordinary randomness misses.
            if (n > 3) {
              frames[1].x = frames[0].x;
              frames[2].y = frames[0].y + frames[0].h / 2 - frames[2].h / 2;
              frames[3].x = frames[0].x;
              frames[3].y = frames[0].y;
            }
            const ctx = createEnergyContext({
              wallW: 250,
              wallH: 250,
              gap,
              order,
              mixSizes,
              allowRotation,
              targetAspect: 1.1,
            });
            yield { frames, ctx };
          }
        }
      }
    }
  }
}

/** Full-precision fingerprint of everything computeEnergy returns. */
function fingerprint() {
  const hash = createHash('sha256');
  let cases = 0;
  for (const { frames, ctx } of corpus()) {
    const { total, perFrame, terms } = computeEnergy(frames, ctx);
    // Sorted keys, so a reordering of the terms object is not a false alarm.
    const parts = [total.toExponential(17)];
    for (const key of Object.keys(terms).sort())
      parts.push(`${key}=${terms[key].toExponential(17)}`);
    for (const value of perFrame) parts.push(value.toExponential(17));
    hash.update(parts.join('|'));
    cases++;
  }
  return { digest: hash.digest('hex'), cases };
}

describe('computeEnergy: bit-exactness', () => {
  it('covers the awkward paths, not just tidy layouts', () => {
    const { cases } = fingerprint();
    expect(cases).toBe(224);
  });

  it('returns exactly the same doubles it did when this was baselined', () => {
    // Re-baseline ONLY together with a deliberate, explained change to the cost
    // function. A surprise failure here means an optimisation changed results.
    expect(fingerprint().digest).toBe(
      'dad40496563a55a81bee67f37b162828dd4d4353a23aaa48d7b95196cbd0f0b2'
    );
  });
});
