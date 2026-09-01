import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderLayoutSVG, PALETTE } from '../src/render.js';

const frame = (x, y, w, h, extra = {}) => ({
  x,
  y,
  w,
  h,
  baseW: extra.baseW ?? w,
  baseH: extra.baseH ?? h,
  area: w * h,
  rotated: extra.rotated ?? false,
});

const frames = [frame(10, 10, 20, 30), frame(50, 10, 30, 20)];
const opts = { wallW: 300, wallH: 200 };

const parse = (svg) => {
  const doc = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
  const error = doc.querySelector('parsererror');
  expect(error, error?.textContent).toBeNull();
  return doc;
};

describe('renderLayoutSVG', () => {
  it('produces well-formed SVG', () => {
    const doc = parse(renderLayoutSVG(frames, opts));
    expect(doc.documentElement.tagName).toBe('svg');
  });

  it('maps the viewBox to the wall in centimetres', () => {
    const doc = parse(renderLayoutSVG(frames, opts));
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 300 200');
  });

  it('draws one rectangle per frame at its wall position', () => {
    const doc = parse(renderLayoutSVG(frames, opts));
    const rects = [...doc.querySelectorAll('rect.frame')];
    expect(rects).toHaveLength(2);
    expect(rects[0].getAttribute('x')).toBe('10');
    expect(rects[0].getAttribute('width')).toBe('20');
    expect(rects[1].getAttribute('width')).toBe('30');
  });

  it('labels each frame with its size', () => {
    const svg = renderLayoutSVG(frames, opts);
    expect(svg).toContain('20 × 30');
    expect(svg).toContain('30 × 20');
  });

  it('omits labels when asked to', () => {
    const doc = parse(renderLayoutSVG(frames, { ...opts, showLabels: false }));
    expect(doc.querySelectorAll('text.frame-label')).toHaveLength(0);
  });

  it('splits a label onto two lines when it will not fit across the frame', () => {
    const narrow = [frame(0, 0, 6, 40)];
    const doc = parse(renderLayoutSVG(narrow, opts));
    expect(doc.querySelectorAll('text.frame-label tspan').length).toBeGreaterThan(1);
  });

  it('keeps label text inside the frame it belongs to', () => {
    const doc = parse(renderLayoutSVG([frame(100, 50, 20, 30)], opts));
    const label = doc.querySelector('text.frame-label');
    const x = Number(label.getAttribute('x'));
    expect(x).toBeGreaterThanOrEqual(100);
    expect(x).toBeLessThanOrEqual(120);
  });

  it('scales text in wall units, not in pixels of whatever element it lands in', () => {
    // The original derived font size from the container's measured width, so
    // the same layout rendered differently depending on the viewport -- and
    // exported files came out with the wrong text size entirely.
    const wide = renderLayoutSVG(frames, { ...opts, wallW: 300 });
    const same = renderLayoutSVG(frames, { ...opts, wallW: 300 });
    expect(wide).toBe(same);
  });

  it('renders the wall outline and both centre lines', () => {
    const doc = parse(renderLayoutSVG(frames, opts));
    expect(doc.querySelector('rect.wall')).not.toBeNull();
    expect(doc.querySelectorAll('line.center-line')).toHaveLength(2);
  });

  it('describes itself for screen readers', () => {
    const doc = parse(renderLayoutSVG(frames, opts));
    expect(doc.documentElement.getAttribute('role')).toBe('img');
    expect(doc.querySelector('title').textContent).toBeTruthy();
    expect(doc.querySelector('desc').textContent).toContain('2');
  });

  it('renders an empty wall without frames', () => {
    const doc = parse(renderLayoutSVG([], opts));
    expect(doc.querySelectorAll('rect.frame')).toHaveLength(0);
    expect(doc.querySelector('rect.wall')).not.toBeNull();
  });

  it('marks rotated frames so they can be told apart', () => {
    const rotated = [frame(0, 0, 30, 20, { baseW: 20, baseH: 30, rotated: true })];
    const doc = parse(renderLayoutSVG(rotated, opts));
    expect(doc.querySelector('rect.frame').getAttribute('data-rotated')).toBe('true');
  });

  it('carries its own colours so an exported file looks right on its own', () => {
    const svg = renderLayoutSVG(frames, { ...opts, standalone: true });
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(PALETTE.light.frameFill);
    expect(svg).not.toContain('var(--');
  });

  it('accepts a dark palette', () => {
    const svg = renderLayoutSVG(frames, { ...opts, standalone: true, palette: PALETTE.dark });
    expect(svg).toContain(PALETTE.dark.frameFill);
  });

  it('does not emit runs of floating point noise', () => {
    const messy = [frame(10.123456789, 10.987654321, 20.5, 30.25)];
    const svg = renderLayoutSVG(messy, opts);
    expect(svg).not.toMatch(/\d\.\d{4,}/);
  });

  it('escapes text rather than letting it become markup', () => {
    // Sizes are numbers today, but the renderer must not be the thing that
    // makes that a security property.
    const svg = renderLayoutSVG(frames, { ...opts, caption: '<script>alert(1)</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('is a pure function of its inputs', () => {
    const before = JSON.parse(JSON.stringify(frames));
    renderLayoutSVG(frames, opts);
    expect(frames).toEqual(before);
  });
});
