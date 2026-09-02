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
   slider is asking for. The silhouette term charges for frames reaching outside
   the ellipse inscribed in their own bounding box, which rounds the outline
   into a blob rather than a filled rectangle; it fades out toward the ordered
   end, since a grid is a rectangle by definition and asking for both gets
   neither. Alignment is scored by how far the frames commit to
   _shared lines_ — edges and centre lines, clustered and squared — rather than
   by counting aligned pairs, which cannot tell one long row from a scatter of
   coincidences.
4. **Settle** (`constraints.js`) — cluster near-alignments onto shared lines,
   compact the group so it sits at the spacing you asked for rather than
   wherever annealing left it, then repair any remaining physical violation by
   pushing crowded frames apart and clamping them back onto the wall.

Compaction draws each frame toward the group's centre along its own radius, so
the arrangement tightens and rounds off at the same time — the corners of a
bounding box are its furthest points, so they close first. It will not trade
away an alignment to gain a centimetre, which is what keeps a grid a grid.

Finally the arrangement is anchored: centred horizontally, and placed
vertically so the centre of the whole group sits at eye level — 145 cm above
the floor by default, the figure galleries hang to. A cluster is positioned as
though it were a single picture, so the wall height you enter has to be the
real floor-to-ceiling height rather than just the patch you are decorating.

The winner then goes through an iterated local search: a few frames are
disturbed and the arrangement is re-annealed from a temperature warm enough to
escape the local minimum but too cool to melt the composition, keeping the
result only when it scores better. Independent restarts throw away everything
the previous one learnt, which spends a long time budget badly; this does not.

Because that takes seconds on a crowded wall, the engine runs in a module
worker (`src/worker.js`, chosen by `src/engine.js`) and reports progress as it
goes. Anywhere a worker is unavailable — a test environment, a page opened off
the filesystem — it runs inline instead, and callers see no difference.

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
