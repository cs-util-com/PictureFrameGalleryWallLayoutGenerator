// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';

// The jsdom environment rewrites import.meta.url to an http URL, so resolve the
// page against the project root instead.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

let app;

const mount = (search = '') => {
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/, '')
    .replace(/<\/html>[\s\S]*$/, '');
  window.history.replaceState({}, '', '/' + search);
  app = createApp({ document, window, storage: null });
  app.start();
  return app;
};

const $ = (sel) => document.querySelector(sel);
const fire = (el, type = 'input') => el.dispatchEvent(new window.Event(type, { bubbles: true }));

// Input is debounced so that dragging the slider does not run the engine on
// every pixel; tests drive the clock rather than sleeping.
const settle = () => vi.advanceTimersByTime(500);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  app?.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('markup', () => {
  beforeEach(() => mount());

  it('has exactly one first-level heading', () => {
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('gives every form control an accessible name', () => {
    const controls = [...document.querySelectorAll('input, button, select')];
    expect(controls.length).toBeGreaterThan(5);
    for (const el of controls) {
      const labelled =
        el.getAttribute('aria-label') ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)) ||
        el.closest('label') ||
        el.textContent.trim();
      expect(
        labelled,
        `${el.tagName}#${el.id || el.className} has no accessible name`
      ).toBeTruthy();
    }
  });

  it('marks the live regions so changes are announced', () => {
    expect($('#status').getAttribute('aria-live')).toBe('polite');
    expect($('#notices').getAttribute('role')).toBe('status');
  });

  it('declares the document language as English', () => {
    expect(html).toContain('lang="en"');
  });
});

describe('initial render', () => {
  beforeEach(() => mount());

  it('draws a layout on start', () => {
    expect($('#preview svg')).not.toBeNull();
    expect($('#preview').querySelectorAll('rect.frame').length).toBeGreaterThan(0);
  });

  it('fills the controls from the current state', () => {
    expect($('#wall-width').value).toBe('300');
    expect($('#wall-height').value).toBe('200');
    expect($('#inventory-list').querySelectorAll('.frame-row').length).toBe(3);
  });

  it('reports what it placed', () => {
    expect($('#status').textContent).toMatch(/\d+/);
  });

  it('lists the hanging coordinates', () => {
    const rows = $('#hanging-list').querySelectorAll('tbody tr');
    expect(rows.length).toBe($('#preview').querySelectorAll('rect.frame').length);
  });
});

describe('reacting to input', () => {
  beforeEach(() => mount());

  it('redraws when the wall size changes', () => {
    $('#wall-width').value = '400';
    fire($('#wall-width'));
    settle();
    expect($('#preview svg').getAttribute('viewBox')).toBe('0 0 400 200');
  });

  it('redraws when an option is toggled', () => {
    const before = $('#preview').innerHTML;
    $('#opt-use-all').checked = true;
    fire($('#opt-use-all'), 'change');
    settle();
    expect($('#preview').innerHTML).not.toBe(before);
  });

  it('does not run the engine once per keystroke', () => {
    // Typing '250' fires three input events; only the settled value matters.
    const field = $('#wall-width');
    for (const value of ['2', '25', '250']) {
      field.value = value;
      fire(field);
    }
    settle();
    expect($('#preview svg').getAttribute('viewBox')).toBe('0 0 250 200');
  });

  it('adds and removes inventory rows', () => {
    const list = $('#inventory-list');
    $('#btn-add-row').click();
    expect(list.querySelectorAll('.frame-row')).toHaveLength(4);
    list.querySelector('.frame-row .btn-remove').click();
    expect(list.querySelectorAll('.frame-row')).toHaveLength(3);
  });

  it('keeps at least one inventory row', () => {
    const list = $('#inventory-list');
    for (let i = 0; i < 5; i++) list.querySelector('.frame-row .btn-remove')?.click();
    expect(list.querySelectorAll('.frame-row').length).toBeGreaterThanOrEqual(1);
  });

  it('steps a frame count up and down from the keyboard', () => {
    const row = $('#inventory-list .frame-row');
    const count = row.querySelector('[data-field="count"]');
    const before = Number(count.value);
    row.querySelector('.btn-increment').click();
    expect(Number(count.value)).toBe(before + 1);
    row.querySelector('.btn-decrement').click();
    expect(Number(count.value)).toBe(before);
  });

  it('never steps a count below zero', () => {
    const row = $('#inventory-list .frame-row');
    const count = row.querySelector('[data-field="count"]');
    for (let i = 0; i < 10; i++) row.querySelector('.btn-decrement').click();
    expect(Number(count.value)).toBe(0);
  });

  it('recovers when a size field is cleared instead of drawing a 1 cm frame', () => {
    const width = $('#inventory-list .frame-row [data-field="w"]');
    width.value = '';
    fire(width);
    settle();
    expect($('#preview svg')).not.toBeNull();
    expect($('#status').textContent).toMatch(/\d+/);
  });
});

describe('the seed and the shareable URL', () => {
  beforeEach(() => mount());

  it('puts the whole state in the URL, not only the seed', () => {
    const params = new URLSearchParams(window.location.search);
    expect(params.get('s')).toBeTruthy();
    expect(params.get('i')).toBeTruthy();
    expect(params.get('w')).toBe('300');
  });

  it('changes the layout when rerolled', () => {
    const before = $('#seed').textContent;
    $('#btn-reroll').click();
    expect($('#seed').textContent).not.toBe(before);
  });

  it('restores the exact layout from a shared URL', () => {
    $('#btn-reroll').click();
    const shared = window.location.search;
    const frames = [...$('#preview').querySelectorAll('rect.frame')].map((r) =>
      r.getAttribute('x')
    );

    app.stop();
    mount(shared);
    const restored = [...$('#preview').querySelectorAll('rect.frame')].map((r) =>
      r.getAttribute('x')
    );
    expect(restored).toEqual(frames);
  });

  it('updates the URL when the wall changes', () => {
    $('#wall-width').value = '250';
    fire($('#wall-width'));
    settle();
    expect(new URLSearchParams(window.location.search).get('w')).toBe('250');
  });
});

describe('notices', () => {
  it('explains itself when nothing can be hung', () => {
    mount('?i=200x200x4&w=60&h=60&g=5');
    expect($('#notices').textContent.trim()).not.toBe('');
    expect($('#preview').querySelectorAll('rect.frame')).toHaveLength(0);
  });

  it('says nothing when everything worked', () => {
    mount();
    expect($('#notices').textContent.trim()).toBe('');
  });
});

describe('persistence', () => {
  it('saves state and restores it on the next visit', () => {
    const map = new Map();
    const storage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };

    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, '')
      .replace(/<\/html>[\s\S]*$/, '');
    window.history.replaceState({}, '', '/');
    const first = createApp({ document, window, storage });
    first.start();
    $('#wall-width').value = '345';
    fire($('#wall-width'));
    settle();
    first.stop();

    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, '')
      .replace(/<\/html>[\s\S]*$/, '');
    window.history.replaceState({}, '', '/');
    app = createApp({ document, window, storage });
    app.start();
    expect($('#wall-width').value).toBe('345');
  });

  it('prefers the URL over saved state, so a shared link wins', () => {
    const map = new Map();
    const storage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, '')
      .replace(/<\/html>[\s\S]*$/, '');
    window.history.replaceState({}, '', '/');
    const first = createApp({ document, window, storage });
    first.start();
    $('#wall-width').value = '345';
    fire($('#wall-width'));
    settle();
    first.stop();

    document.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/, '')
      .replace(/<\/html>[\s\S]*$/, '');
    window.history.replaceState({}, '', '/?w=280');
    app = createApp({ document, window, storage });
    app.start();
    expect($('#wall-width').value).toBe('280');
  });
});

describe('theme', () => {
  beforeEach(() => mount());

  it('toggles between light and dark', () => {
    const button = $('#btn-theme');
    const before = document.documentElement.dataset.theme;
    button.click();
    expect(document.documentElement.dataset.theme).not.toBe(before);
    expect(button.getAttribute('aria-pressed')).toBeTruthy();
  });
});
