/**
 * Decides where the layout engine runs, and hides the difference.
 *
 * In a browser it runs in a module worker, so a search that takes several
 * seconds neither freezes the page nor stops the progress bar from moving.
 * Everywhere else — a test environment, a browser that refuses the worker, a
 * page opened straight off the filesystem — it runs inline instead. Callers see
 * the same interface either way: ask for a layout, get progress, get a result.
 */

import { generateLayout } from './layout.js';

/**
 * @param {Window} win
 * @returns {{run:Function, cancel:Function, dispose:Function, usesWorker:boolean}}
 *   `run(params, {onProgress, onDone})` supersedes any run already in flight.
 */
export function createEngine(win) {
  let worker = null;
  let current = 0;
  let handlers = null;

  // A module worker needs `import.meta.url` to resolve, a Worker constructor,
  // and a same-origin document. `file://` pages have the constructor but throw
  // on construction, so this has to be tried rather than feature-detected.
  try {
    if (typeof win?.Worker === 'function' && typeof import.meta.url === 'string') {
      worker = new win.Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', onMessage);
      // A worker that fails to start reports here rather than by throwing, so
      // the fallback has to happen at runtime. Any run already in flight must
      // still be answered -- otherwise the page waits for ever on a promise
      // nothing will ever settle -- so it is finished inline before the worker
      // is abandoned for good.
      worker.addEventListener('error', () => {
        worker?.terminate();
        worker = null;
        const pending = handlers;
        handlers = null;
        if (pending) pending.onDone?.(generateLayout(pending.params));
      });
    }
  } catch {
    worker = null;
  }

  function onMessage(event) {
    const message = event.data ?? {};
    // Answers to superseded questions are dropped: the inputs have moved on.
    if (message.id !== current || !handlers) return;

    if (message.type === 'progress') {
      handlers.onProgress?.(message.progress, message.label);
      return;
    }
    const done = handlers;
    handlers = null;
    if (message.type === 'result') done.onDone?.(message.result);
    // On a worker failure the caller still needs an answer, so run it here.
    else if (message.type === 'error') done.onDone?.(generateLayout(done.params));
  }

  return {
    usesWorker: Boolean(worker),

    run(params, { onProgress, onDone } = {}) {
      current += 1;

      if (!worker) {
        // Inline: the result is already known, so there is no progress worth
        // reporting and no window in which the caller could cancel.
        onDone?.(generateLayout(params));
        return;
      }

      handlers = { onProgress, onDone, params };
      worker.postMessage({ id: current, params });
    },

    /** Abandons the run in flight without stopping the worker. */
    cancel() {
      current += 1;
      handlers = null;
    },

    dispose() {
      handlers = null;
      worker?.terminate();
      worker = null;
    },
  };
}
