/**
 * Runs the layout engine off the main thread.
 *
 * Searching a crowded wall is seconds of solid arithmetic. On the main thread
 * that freezes the page: no progress can be drawn, no control responds, and the
 * browser may offer to kill the tab. Here it blocks nothing, and the progress
 * it reports can actually be painted while it works.
 *
 * The protocol is deliberately tiny. In: `{ id, params }`. Out:
 * `{ id, type: 'progress' | 'result' | 'error' }`. The `id` lets the page throw
 * away answers to questions it has stopped caring about, which happens whenever
 * someone drags a slider.
 */

import { generateLayout } from './layout.js';

self.addEventListener('message', (event) => {
  const { id, params } = event.data ?? {};

  try {
    const result = generateLayout({
      ...params,
      onProgress: (progress, label) => {
        self.postMessage({ id, type: 'progress', progress, label });
      },
    });
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    // A worker that dies silently leaves the page waiting for ever, so failures
    // are reported and the page falls back to running the engine itself.
    self.postMessage({ id, type: 'error', message: String(error?.message ?? error) });
  }
});
