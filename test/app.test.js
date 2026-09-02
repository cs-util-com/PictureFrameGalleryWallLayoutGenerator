// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import * as layoutModule from '../src/layout.js';

// The jsdom environment rewrites import.meta.url to an http URL, so resolve the
// page against the project root instead.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

let app;

const mount = (search = '') => {
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/, '')
    .replace(/<\/html>[\s\S]*$/, '');
  // data-theme lives on <html> itself, so replacing innerHTML does not clear it
  // and it would leak from one test to the next.
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-explicit');
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
    // A region hidden while empty is not in the accessibility tree when its
    // first message lands, so notices are an alert and transient confirmations
    // go to a permanently present, visually hidden region.
    expect($('#notices').getAttribute('role')).toBe('alert');
    expect($('#announcements').getAttribute('role')).toBe('status');
    expect($('#announcements').getAttribute('aria-live')).toBe('polite');
  });

  it('gives the skip link a target that can actually take focus', () => {
    const target = document.querySelector($('.skip-link').getAttribute('href'));
    expect(target).not.toBeNull();
    expect(target.getAttribute('tabindex')).toBe('-1');
  });

  it('lets a keyboard user reach the scrollable nail table', () => {
    const region = document.querySelector('.table-scroll');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-labelledby')).toBeTruthy();
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
    expect($('#wall-height').value).toBe('250');
    expect($('#inventory-list').querySelectorAll('.frame-row').length).toBe(3);
  });

  it('reports what it placed', () => {
    expect($('#status').textContent).toMatch(/\d+/);
  });

  it('lists the hanging coordinates', () => {
    const rows = $('#hanging-list').querySelectorAll('tbody tr');
    expect(rows.length).toBe($('#preview').querySelectorAll('rect.frame').length);
  });

  it('warns that a zero hook drop means nailing at the frame top', () => {
    // The default is 0, which silently instructs a nail at the exact top edge.
    expect($('#hanging-caution').textContent).toMatch(/wire or hook 5-10 cm below/);
  });

  it('clears the warning once a real hook drop is entered', () => {
    $('#hanger-drop').value = '6';
    fire($('#hanger-drop'));
    settle();
    expect($('#hanging-caution').textContent).toBe('');
  });

  it('questions a hook drop that is taller than the smallest frame', () => {
    // 40 cm is a plausible mis-keying of 4.0 cm entered in millimetres, and
    // the field steps in half-centimetres, which invites exactly that.
    $('#hanger-drop').value = '40';
    fire($('#hanger-drop'));
    settle();
    expect($('#hanging-caution').textContent).toMatch(/taller than your smallest frame/);
    expect($('#hanging-caution').textContent).toMatch(/Did you mean 4 cm\?/);
  });

  it('states the group size and the line to mark before any nail goes in', () => {
    const setup = $('#hanging-setup').textContent;
    expect(setup).toMatch(/The whole group is [\d.]+ × [\d.]+ cm/);
    expect(setup).toMatch(/Mark a level line [\d.]+ cm above the floor/);
  });
});

describe('reacting to input', () => {
  beforeEach(() => mount());

  it('redraws when the wall size changes', () => {
    $('#wall-width').value = '400';
    fire($('#wall-width'));
    settle();
    expect($('#preview svg').getAttribute('viewBox')).toBe('0 0 400 250');
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
    expect($('#preview svg').getAttribute('viewBox')).toBe('0 0 250 250');
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

  it('keeps focus when tabbing between inventory fields', () => {
    // Re-rendering the list on focusout would destroy the element the browser
    // is moving focus to, dumping the user back to the top of the page.
    const row = $('#inventory-list .frame-row');
    const width = row.querySelector('[data-field="w"]');
    const height = row.querySelector('[data-field="h"]');
    width.focus();
    height.focus();
    width.dispatchEvent(
      new window.FocusEvent('focusout', { bubbles: true, relatedTarget: height })
    );
    expect(document.activeElement).toBe(height);
    expect(height.isConnected).toBe(true);
  });

  it('shows the value it fell back to once a cleared field is left', () => {
    const width = $('#inventory-list .frame-row [data-field="w"]');
    width.value = '';
    fire(width);
    width.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    expect(width.value).not.toBe('');
    expect(Number(width.value)).toBeGreaterThan(0);
  });

  it('does not reload the page when Enter is pressed in a field', () => {
    // A form with a single text field submits implicitly on Enter, which would
    // throw away the layout the user is looking at.
    const submit = new window.Event('submit', { bubbles: true, cancelable: true });
    $('#controls').dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
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

describe('the press-and-hold stepper', () => {
  beforeEach(() => mount());

  // jsdom has no PointerEvent constructor; a MouseEvent carries the `button`
  // property the handler needs and dispatches under the pointerdown name.
  const hold = (button, init = {}) =>
    button.dispatchEvent(
      new window.MouseEvent('pointerdown', { bubbles: true, button: 0, ...init })
    );

  it('repeats while held', () => {
    const row = $('#inventory-list .frame-row');
    const count = row.querySelector('[data-field="count"]');
    const before = Number(count.value);
    hold(row.querySelector('.btn-increment'));
    vi.advanceTimersByTime(1000);
    document.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
    expect(Number(count.value)).toBeGreaterThan(before);
  });

  it('stops when the row it was driving is removed', () => {
    // The repeat resolved its row by index. Removing an earlier row shifts
    // every index down, so a held button silently started editing a different
    // frame size.
    const rows = () => [...document.querySelectorAll('#inventory-list .frame-row')];
    const secondCount = () => rows()[1].querySelector('[data-field="count"]').value;
    hold(rows()[1].querySelector('.btn-increment'));
    vi.advanceTimersByTime(600);
    rows()[0].querySelector('.btn-remove').click();
    const afterRemoval = secondCount();
    vi.advanceTimersByTime(2000);
    expect(secondCount()).toBe(afterRemoval);
  });

  it('ignores a non-primary button, which never gets a matching release', () => {
    // A right-click opens the context menu, so no pointerup arrives and the
    // count runs away on its own.
    const row = $('#inventory-list .frame-row');
    const count = row.querySelector('[data-field="count"]');
    const before = Number(count.value);
    hold(row.querySelector('.btn-increment'), { button: 2, isPrimary: true });
    vi.advanceTimersByTime(3000);
    expect(Number(count.value)).toBe(before);
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

  it('honours seed 0 from a link instead of treating it as missing', () => {
    app.stop();
    mount('?i=20x30x2_13x18x2_10x15x4&w=300&h=200&g=7&k=0&s=0&o=50&r=1&a=0&d=1&m=1');
    expect($('#seed').textContent).toBe('0');
    expect(new URLSearchParams(window.location.search).get('s')).toBe('0');
  });

  it('carries the hook drop in the link, since the nail table needs it', () => {
    $('#hanger-drop').value = '4';
    fire($('#hanger-drop'));
    settle();
    expect(new URLSearchParams(window.location.search).get('k')).toBe('40');
  });

  it('restores the hook drop from a link', () => {
    app.stop();
    mount('?i=20x30x2&w=300&h=200&g=7&k=25&s=5&o=50&r=1&a=1&d=1&m=1');
    expect($('#hanger-drop').value).toBe('2.5');
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

  it('toggles to dark and reports it accurately', () => {
    const button = $('#btn-theme');
    button.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    // aria-pressed is a string: asserting it is truthy passes for "false" too.
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles back to light', () => {
    const button = $('#btn-theme');
    button.click();
    button.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('redraws the preview in the matching palette', () => {
    const wallFill = () => $('#preview rect.wall').getAttribute('fill');
    const light = wallFill();
    $('#btn-theme').click();
    expect(wallFill()).not.toBe(light);
  });
});

describe('cost of redrawing', () => {
  beforeEach(() => mount());

  it('runs the engine once for a burst of keystrokes, not once each', () => {
    const spy = vi.spyOn(layoutModule, 'generateLayout');
    const field = $('#wall-width');
    for (const value of ['2', '25', '250']) {
      field.value = value;
      fire(field);
    }
    settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not anneal twice when rerolling during a pending edit', () => {
    const field = $('#wall-width');
    field.value = '260';
    fire(field);
    const spy = vi.spyOn(layoutModule, 'generateLayout');
    $('#btn-reroll').click();
    settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('resilience', () => {
  beforeEach(() => mount());

  it('keeps working when history.replaceState throws', () => {
    // Safari throttles replaceState and throws past its limit; a slider drag
    // at the debounce interval gets close.
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    $('#wall-width').value = '321';
    fire($('#wall-width'));
    expect(() => settle()).not.toThrow();
    expect($('#preview svg').getAttribute('viewBox')).toBe('0 0 321 250');
  });

  it('stops adding rows at the supported maximum', () => {
    for (let i = 0; i < 60; i++) $('#btn-add-row').click();
    expect(document.querySelectorAll('#inventory-list .frame-row').length).toBeLessThanOrEqual(40);
  });

  it('removes its listeners when stopped', () => {
    const spy = vi.spyOn(layoutModule, 'generateLayout');
    app.stop();
    $('#wall-width').value = '277';
    fire($('#wall-width'));
    settle();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('focus management', () => {
  beforeEach(() => mount());

  it('keeps focus in the list when a row is removed', () => {
    // Re-rendering the list destroys the focused button, dropping a keyboard
    // user back to the top of the page.
    const rows = () => [...document.querySelectorAll('#inventory-list .frame-row')];
    rows()[1].querySelector('.btn-remove').focus();
    rows()[1].querySelector('.btn-remove').click();
    expect(document.activeElement).not.toBe(document.body);
    expect($('#inventory-list').contains(document.activeElement)).toBe(true);
  });

  it('moves focus into the row it just added', () => {
    $('#btn-add-row').click();
    expect($('#inventory-list').contains(document.activeElement)).toBe(true);
  });
});
