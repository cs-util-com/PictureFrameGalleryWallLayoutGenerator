# Gallery Wall Layout Generator

Arrange your picture frames on a wall, then get the exact nail positions.

Tell it what frames you own and how big the wall is; it composes an arrangement
that respects the spacing you want, keeps everything on the wall, and hands you
a list of measurements to mark up with. Every layout is reproducible from its
link.

**[Open the app →](https://cs-util-com.github.io/PictureFrameGalleryWallLayoutGenerator/)**

## What it does

- Composes a gallery wall from your frame inventory, anywhere between a strict
  grid and a dense salon hang.
- Guarantees the result is physically hangable: no overlaps, the requested gap
  respected, nothing off the wall.
- Optionally turns frames sideways, prefers an odd number of pieces, and mixes
  large and small frames across the wall rather than sorting them into corners.
- Gives you nail positions in centimetres from the wall's top-left corner, in
  the order to hang them, allowing for how far the hook sits below the frame's
  top edge.
- Exports to SVG or PNG, and prints the layout together with the nail table.
- Puts the whole state in the URL — frames, wall, spacing, hook drop, options
  and seed — so a link reproduces exactly what you saw. The seed alone would
  not: the same seed against a different inventory gives a different wall.

## Running it

The app is static: no build step, no dependencies at runtime. It does use ES
modules, so it needs to be served over HTTP rather than opened from the
filesystem.

```bash
npm install     # only needed for the tests and linters
npm start       # serves the app at http://localhost:8080
```

## Development

```bash
npm test          # run the test suite
npm run lint      # ESLint
npm run coverage  # tests with a coverage report
npm run check     # lint + formatting + tests, the same gate CI runs
```

CI runs `npm run check` rather than the coverage task: the layout search is
CPU-bound and v8 instrumentation makes the suite roughly ten times slower, for
a metric that says little here. The engine's cost is bounded by explicit
assertions on how much work it does instead of by a timer.

### Testing approach

The geometric invariants are swept rather than spot-checked: layouts are
generated across walls, gaps, seeds and options, and every one is asserted to be
physically hangable. The annealer's move/undo pair is tested directly, because a
move that is not exactly reversed corrupts the search while leaving the output
legal — so no end-to-end assertion would notice. The PRNG has golden vectors,
since the seed-to-sequence mapping is effectively a wire format: changing it
would invalidate every link anyone has shared.

## How the layout engine works

The interesting part is `src/layout.js`. Producing an arrangement that looks
_deliberate_ is not a packing problem — the goal is not to fit the most frames
in, but to compose something a person would have arranged by eye. So the engine
optimises a cost function rather than following a placement rule.

Each layout runs through four stages:

1. **Select** (`inventory.js`) — decide which frames to hang. Unless you ask for
   all of them, the selection is thinned toward covering about 40% of the wall,
   dropping the smallest frames first, since a gallery wall is anchored by its
   large pieces.
2. **Seed** — place the frames roughly inside an envelope sized to hold them at
   a plausible density and shaped roughly like the wall. The largest frame
   anchors the composition slightly off-centre; a perfectly centred anchor reads
   as accidental.
3. **Anneal** (`energy.js`) — improve the composition by simulated annealing,
   proposing small moves and accepting worse ones with a probability that falls
   as the run cools. The cost function weighs collisions and spacing violations
   an order of magnitude above matters of taste: visual balance, trapped empty
   space, silhouette, size mixing, and how much grid-like structure the _Style_
   slider is asking for.
4. **Settle** (`constraints.js`) — turn near-alignments into exact ones, then
   repair any remaining physical violation by pushing crowded frames apart and
   clamping them back onto the wall.

Only the last stage decides whether a layout is usable. Keeping physical rules
separate from aesthetic preferences is what makes the engine predictable: a
layout is never thrown away for being merely untidy, and if the frames genuinely
do not fit, the engine drops the smallest and retries rather than searching a
dead end.

Everything random is drawn from one seeded stream (`prng.js`), which is what
makes a shared link reproduce a layout exactly.

## Project layout

| File                 | Responsibility                                        |
| -------------------- | ----------------------------------------------------- |
| `src/prng.js`        | Seeded random numbers — the source of reproducibility |
| `src/geometry.js`    | Axis-aligned rectangle maths                          |
| `src/inventory.js`   | Frame rows, instances, and which to hang              |
| `src/energy.js`      | The cost function the search minimises                |
| `src/constraints.js` | Physical rules and the repair pass                    |
| `src/layout.js`      | The search itself                                     |
| `src/render.js`      | Layout to SVG, as a pure function                     |
| `src/hanging.js`     | Layout to nail positions                              |
| `src/state.js`       | URL and localStorage encoding                         |
| `src/export.js`      | SVG, PNG and clipboard                                |
| `src/app.js`         | DOM wiring                                            |
| `src/main.js`        | Browser entry point                                   |

Everything under `src/` is a pure function of its inputs except `app.js`,
`main.js` and `export.js` — the three that touch the DOM, the clipboard and the
filesystem. That is why the engine, the renderer and the hanging plan can all be
tested without a browser.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
