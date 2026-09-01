/**
 * The application: wires the DOM to the layout engine.
 *
 * Written as a factory taking its document, window and storage rather than
 * reaching for globals, so the whole thing can be driven from a test.
 *
 * State flows in one direction. Every interaction updates the state object,
 * then `render()` redraws from it — controls, preview, status, hanging list and
 * URL alike. Nothing else writes to the DOM.
 */

import { DEFAULT_STATE, decodeState, encodeState, loadState, saveState } from './state.js';
import { generateLayout } from './layout.js';
import { renderLayoutSVG, PALETTE } from './render.js';
import { hangingPlan } from './hanging.js';
import { normalizeInventory, totalFrameCount, MAX_FRAMES, MAX_ROWS } from './inventory.js';
import { copyToClipboard, downloadPNG, downloadSVG } from './export.js';

/** Delay before regenerating while the user is still typing or dragging. */
const INPUT_DEBOUNCE_MS = 120;

/** Delay before a held stepper button starts repeating, and its repeat rate. */
const HOLD_DELAY_MS = 450;
const HOLD_REPEAT_MS = 90;

const THEME_KEY = 'gallery-wall:theme';

const MAX_SEED = 2147483647;

const NOTICE_TEXT = {
  'empty-inventory': 'Add at least one frame to see a layout.',
  'invalid-wall': 'Enter a wall width and height to see a layout.',
  'does-not-fit': 'These frames will not fit on this wall with this gap. Try a smaller gap.',
  'frames-dropped': 'Some frames were left out — they do not all fit with this gap.',
};

export function createApp({ document: doc, window: win, storage }) {
  let state = null;
  let layout = null;
  let generateTimer = null;
  let holdTimer = null;
  let holdInterval = null;
  const listeners = [];

  const $ = (selector) => doc.querySelector(selector);

  const on = (target, type, handler, options) => {
    if (!target) return;
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  /* ------------------------------------------------------------------ state */

  function initialState() {
    const search = win.location.search;
    // A pasted link must win over whatever this browser last had open,
    // otherwise sharing a layout would not work.
    if (search && search.length > 1) return decodeState(search);
    return loadState(storage) ?? { ...cloneState(DEFAULT_STATE), seed: randomSeed() };
  }

  function cloneState(source) {
    return {
      ...source,
      inventory: source.inventory.map((row) => ({ ...row })),
      options: { ...source.options },
    };
  }

  function randomSeed() {
    return Math.floor(Math.random() * MAX_SEED);
  }

  /* ------------------------------------------------------------- generation */

  function scheduleGenerate() {
    if (generateTimer) win.clearTimeout(generateTimer);
    generateTimer = win.setTimeout(() => {
      generateTimer = null;
      regenerate();
    }, INPUT_DEBOUNCE_MS);
  }

  function regenerate() {
    layout = generateLayout({
      inventory: state.inventory,
      wallW: state.wallW,
      wallH: state.wallH,
      gap: state.gap,
      seed: state.seed,
      options: state.options,
    });
    renderOutput();
    persist();
  }

  function persist() {
    const query = encodeState(state);
    win.history.replaceState({}, '', `${win.location.pathname}?${query}`);
    saveState(storage, state);
  }

  /* ---------------------------------------------------------------- drawing */

  function renderOutput() {
    const palette = currentTheme() === 'dark' ? PALETTE.dark : PALETTE.light;
    $('#preview').innerHTML = renderLayoutSVG(layout.frames, {
      wallW: state.wallW,
      wallH: state.wallH,
      palette,
    });

    $('#notices').textContent = layout.notices
      .map((code) => NOTICE_TEXT[code])
      .filter(Boolean)
      .join(' ');

    $('#status').textContent = describeLayout();
    renderHangingList();
    renderInventoryNote();
  }

  function describeLayout() {
    if (layout.placed === 0) return 'Nothing to hang yet.';
    const box = layout.bbox;
    const size = `${Math.round(box.width)} × ${Math.round(box.height)} cm`;
    return (
      `${layout.placed} of ${layout.total} frames · ` +
      `arrangement ${size} · covers ${Math.round(layout.coverage * 100)}% of the wall`
    );
  }

  function renderHangingList() {
    const body = $('#hanging-list').querySelector('tbody');
    const drop = Number($('#hanger-drop')?.value) || 0;
    const { items } = hangingPlan(layout.frames, {
      wallW: state.wallW,
      wallH: state.wallH,
      hangerDrop: drop,
    });

    body.replaceChildren(
      ...items.map((item) => {
        const tr = doc.createElement('tr');
        for (const [value, header] of [
          [item.number, true],
          [item.rotated ? `${item.label} (turned)` : item.label, false],
          [`${item.nailX} cm`, false],
          [`${item.nailY} cm`, false],
          [`${item.fromFloor} cm`, false],
        ]) {
          const cell = doc.createElement(header ? 'th' : 'td');
          if (header) cell.scope = 'row';
          cell.textContent = String(value);
          tr.appendChild(cell);
        }
        return tr;
      })
    );
  }

  function renderInventoryNote() {
    const owned = totalFrameCount(state.inventory);
    // The engine caps how many frames it will place; say so rather than
    // silently laying out fewer than the user asked for.
    $('#inventory-note').textContent =
      owned > MAX_FRAMES ? `Only the largest ${MAX_FRAMES} of your ${owned} frames are used.` : '';
  }

  /* --------------------------------------------------------------- controls */

  function renderInventory() {
    const list = $('#inventory-list');
    list.replaceChildren(...state.inventory.map((row, index) => inventoryRow(row, index)));
  }

  function inventoryRow(row, index) {
    const wrapper = doc.createElement('div');
    wrapper.className = 'frame-row';
    wrapper.dataset.index = String(index);

    const label = `frame size ${index + 1}`;
    wrapper.append(
      numberInput('w', row.w, `Width of ${label} in centimetres`, 1, 500),
      numberInput('h', row.h, `Height of ${label} in centimetres`, 1, 500),
      stepper(row.count, label),
      iconButton('btn-remove', '×', `Remove ${label}`)
    );
    return wrapper;
  }

  function numberInput(field, value, ariaLabel, min, max) {
    const input = doc.createElement('input');
    input.type = 'number';
    input.className = 'cell-input';
    input.dataset.field = field;
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', ariaLabel);
    return input;
  }

  function stepper(count, label) {
    const group = doc.createElement('div');
    group.className = 'stepper';
    group.append(
      iconButton('btn-decrement', '−', `One fewer ${label}`),
      numberInput('count', count, `Number of ${label}`, 0, 99),
      iconButton('btn-increment', '+', `One more ${label}`)
    );
    return group;
  }

  function iconButton(className, glyph, ariaLabel) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `btn-icon ${className}`;
    button.textContent = glyph;
    button.setAttribute('aria-label', ariaLabel);
    return button;
  }

  function syncControls() {
    $('#wall-width').value = String(state.wallW);
    $('#wall-height').value = String(state.wallH);
    $('#gap').value = String(state.gap);
    $('#order').value = String(Math.round(state.options.order * 100));
    $('#opt-rotate').checked = state.options.allowRotation;
    $('#opt-use-all').checked = state.options.useAll;
    $('#opt-prefer-odd').checked = state.options.preferOdd;
    $('#opt-mix-sizes').checked = state.options.mixSizes;
    $('#seed').textContent = String(state.seed);
  }

  /* ----------------------------------------------------------------- events */

  function bindEvents() {
    // A form whose only submit path is the Enter key still submits, which would
    // reload the page and throw away the layout on screen.
    on($('#controls'), 'submit', (event) => event.preventDefault());

    const numberFields = [
      ['#wall-width', 'wallW'],
      ['#wall-height', 'wallH'],
      ['#gap', 'gap'],
    ];
    for (const [selector, key] of numberFields) {
      on($(selector), 'input', () => {
        // Re-read through the state codec so an emptied or out-of-range field
        // falls back to something sensible instead of reaching the engine.
        state[key] = decodeState(encodeState({ ...state, [key]: $(selector).value }))[key];
        scheduleGenerate();
      });
      on($(selector), 'blur', () => syncControls());
    }

    on($('#hanger-drop'), 'input', () => renderHangingList());

    const toggles = [
      ['#opt-rotate', 'allowRotation'],
      ['#opt-use-all', 'useAll'],
      ['#opt-prefer-odd', 'preferOdd'],
      ['#opt-mix-sizes', 'mixSizes'],
    ];
    for (const [selector, key] of toggles) {
      on($(selector), 'change', () => {
        state.options[key] = $(selector).checked;
        scheduleGenerate();
      });
    }

    on($('#order'), 'input', () => {
      state.options.order = Number($('#order').value) / 100;
      scheduleGenerate();
    });

    on($('#btn-add-row'), 'click', () => {
      if (state.inventory.length >= MAX_ROWS) return;
      state.inventory.push({ w: 20, h: 30, count: 1 });
      renderInventory();
      scheduleGenerate();
    });

    on($('#inventory-list'), 'input', (event) => {
      const field = event.target.dataset?.field;
      if (!field) return;
      const index = rowIndex(event.target);
      if (index < 0) return;
      state.inventory[index][field] = event.target.value;
      state.inventory = normalizeRows(state.inventory);
      scheduleGenerate();
    });

    // Show the value the engine actually used once a field is left, so a field
    // the user emptied does not stay blank. Only that one input is touched:
    // re-rendering the list here would destroy the element the browser is
    // moving focus to and dump the user back to the top of the page.
    on($('#inventory-list'), 'focusout', (event) => {
      const field = event.target.dataset?.field;
      if (!field) return;
      const index = rowIndex(event.target);
      if (index >= 0) event.target.value = String(state.inventory[index][field]);
    });

    on($('#inventory-list'), 'click', (event) => {
      const index = rowIndex(event.target);
      if (index < 0) return;

      if (event.target.classList.contains('btn-remove')) {
        state.inventory.splice(index, 1);
        if (state.inventory.length === 0) state.inventory.push({ w: 20, h: 30, count: 1 });
        renderInventory();
        scheduleGenerate();
      } else if (event.target.classList.contains('btn-increment')) {
        step(index, +1);
      } else if (event.target.classList.contains('btn-decrement')) {
        step(index, -1);
      }
    });

    // Press-and-hold to run a count up quickly. Pointer events cover mouse,
    // touch and pen alike; the click handler above keeps it keyboard-operable.
    on($('#inventory-list'), 'pointerdown', (event) => {
      const index = rowIndex(event.target);
      if (index < 0) return;
      const delta = event.target.classList.contains('btn-increment')
        ? 1
        : event.target.classList.contains('btn-decrement')
          ? -1
          : 0;
      if (delta === 0) return;

      holdTimer = win.setTimeout(() => {
        holdInterval = win.setInterval(() => step(index, delta), HOLD_REPEAT_MS);
      }, HOLD_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      on(doc, type, stopHold);
    }

    on($('#btn-reroll'), 'click', () => {
      let next = randomSeed();
      if (next === state.seed) next = (next + 1) % MAX_SEED;
      state.seed = next;
      $('#seed').textContent = String(state.seed);
      regenerate();
    });

    on($('#btn-copy-link'), 'click', async () => {
      const button = $('#btn-copy-link');
      const copied = await copyToClipboard(win, win.location.href);
      flash(button, copied ? 'Link copied' : 'Press Ctrl+C to copy');
    });

    on($('#btn-export-svg'), 'click', () => {
      downloadSVG(win, standaloneSVG(), state.seed);
    });

    on($('#btn-export-png'), 'click', async () => {
      const button = $('#btn-export-png');
      try {
        await downloadPNG(win, standaloneSVG(), state.seed, state.wallW, state.wallH);
      } catch {
        flash(button, 'PNG export failed');
      }
    });

    on($('#btn-print'), 'click', () => win.print());

    on($('#btn-theme'), 'click', () => {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      renderOutput();
    });

    // Keep the drawing legible if the user changes their system theme while
    // the page is open and they have not chosen one explicitly.
    const media = win.matchMedia?.('(prefers-color-scheme: dark)');
    if (media?.addEventListener) {
      on(media, 'change', () => {
        if (!doc.documentElement.dataset.themeExplicit) renderOutput();
      });
    }
  }

  function rowIndex(element) {
    const row = element.closest?.('.frame-row');
    return row ? Number(row.dataset.index) : -1;
  }

  function normalizeRows(rows) {
    return normalizeInventory(rows).map(({ w, h, count }) => ({ w, h, count }));
  }

  function step(index, delta) {
    const row = state.inventory[index];
    if (!row) return;
    row.count = Math.max(0, Math.min(99, Number(row.count) + delta));
    const field = $(`#inventory-list .frame-row[data-index="${index}"] [data-field="count"]`);
    if (field) field.value = String(row.count);
    scheduleGenerate();
  }

  function stopHold() {
    if (holdTimer) win.clearTimeout(holdTimer);
    if (holdInterval) win.clearInterval(holdInterval);
    holdTimer = null;
    holdInterval = null;
  }

  function standaloneSVG() {
    return renderLayoutSVG(layout.frames, {
      wallW: state.wallW,
      wallH: state.wallH,
      standalone: true,
      palette: PALETTE.light,
      caption: `${layout.placed} frames · ${state.wallW} × ${state.wallH} cm wall · seed ${state.seed}`,
    });
  }

  function flash(button, message) {
    const original = button.dataset.label ?? button.textContent;
    button.dataset.label = original;
    button.textContent = message;
    win.setTimeout(() => {
      button.textContent = button.dataset.label ?? original;
    }, 2000);
  }

  /* ------------------------------------------------------------------ theme */

  function currentTheme() {
    const explicit = doc.documentElement.dataset.theme;
    if (explicit === 'dark' || explicit === 'light') return explicit;
    return win.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  }

  function setTheme(theme) {
    doc.documentElement.dataset.theme = theme;
    doc.documentElement.dataset.themeExplicit = 'true';
    const button = $('#btn-theme');
    if (button) button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    try {
      storage?.setItem(THEME_KEY, theme);
    } catch {
      // Remembering the theme is a convenience, not a requirement.
    }
  }

  function restoreTheme() {
    let saved = null;
    try {
      saved = storage?.getItem(THEME_KEY);
    } catch {
      saved = null;
    }
    if (saved === 'dark' || saved === 'light') setTheme(saved);
    else {
      const button = $('#btn-theme');
      if (button) button.setAttribute('aria-pressed', currentTheme() === 'dark' ? 'true' : 'false');
    }
  }

  /* ----------------------------------------------------------------- public */

  return {
    start() {
      state = initialState();
      if (!state.seed) state.seed = randomSeed();
      restoreTheme();
      renderInventory();
      syncControls();
      bindEvents();
      regenerate();
      return this;
    },

    stop() {
      if (generateTimer) win.clearTimeout(generateTimer);
      stopHold();
      for (const remove of listeners.splice(0)) remove();
    },

    /** Exposed for tests and debugging; not part of the page's behaviour. */
    getState: () => state,
    getLayout: () => layout,
  };
}
