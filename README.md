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
- Puts the whole state in the URL, so a link reproduces exactly what you saw.

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
npm test        # run the test suite
npm run lint    # ESLint
npm run check   # lint + formatting + tests, the same gate CI runs
```

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

The modules under `src/` are pure apart from `app.js` and `main.js`, which is
why the engine can be tested without a browser.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
