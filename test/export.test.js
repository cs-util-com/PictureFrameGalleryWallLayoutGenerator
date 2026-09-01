import { describe, it, expect } from 'vitest';
import {
  buildFilename,
  svgToDataUrl,
  PNG_MAX_WIDTH,
  pngPixelSize,
  downloadSVG,
  downloadPNG,
  copyToClipboard,
} from '../src/export.js';

describe('buildFilename', () => {
  it('names files after the app and the seed, so downloads stay distinguishable', () => {
    expect(buildFilename(12345, 'svg')).toBe('gallery-wall-12345.svg');
  });

  it('handles any extension', () => {
    expect(buildFilename(7, 'png')).toBe('gallery-wall-7.png');
  });

  it('never produces a name with path separators or spaces in it', () => {
    expect(buildFilename('../../etc/passwd', 'svg')).toMatch(/^gallery-wall-[a-z0-9-]*\.svg$/);
  });
});

describe('svgToDataUrl', () => {
  it('produces a data URL a browser will render', () => {
    const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('round-trips the markup', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>20 × 30</text></svg>';
    const base64 = svgToDataUrl(svg).split(',')[1];
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    expect(decoded).toBe(svg);
  });

  it('survives non-ASCII characters, which every size label contains', () => {
    // btoa throws on the multiplication sign unless the string is encoded to
    // UTF-8 bytes first.
    expect(() => svgToDataUrl('<svg>÷ × ü Ø</svg>')).not.toThrow();
  });
});

describe('pngPixelSize', () => {
  it('renders at a useful resolution for a typical wall', () => {
    const { width, height } = pngPixelSize(300, 200);
    expect(width).toBeGreaterThan(1000);
    expect(width / height).toBeCloseTo(1.5, 6);
  });

  it('preserves the wall aspect ratio', () => {
    const { width, height } = pngPixelSize(120, 400);
    expect(width / height).toBeCloseTo(0.3, 6);
  });

  it('caps the width so an enormous wall cannot exhaust memory', () => {
    const { width } = pngPixelSize(20000, 100);
    expect(width).toBeLessThanOrEqual(PNG_MAX_WIDTH);
  });

  it('always returns at least one whole pixel', () => {
    // 0.1cm would round to 1 on its own; 0.05 actually exercises the floor.
    const { width, height } = pngPixelSize(0.05, 0.05);
    expect(width).toBeGreaterThanOrEqual(1);
    expect(height).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });
});

describe('downloading and copying', () => {
  const fakeWindow = () => {
    const clicked = [];
    const revoked = [];
    const doc = {
      body: { appendChild() {} },
      createElement: () => ({
        set href(v) {
          this._href = v;
        },
        get href() {
          return this._href;
        },
        click() {
          clicked.push({ href: this._href, download: this.download });
        },
        remove() {},
      }),
    };
    return {
      clicked,
      revoked,
      document: doc,
      Blob: class {
        constructor(parts, options) {
          this.parts = parts;
          this.type = options?.type;
        }
      },
      URL: {
        createObjectURL: (blob) => `blob:${blob.type}`,
        revokeObjectURL: (url) => revoked.push(url),
      },
    };
  };

  it('downloads the SVG under a name carrying the seed', () => {
    const win = fakeWindow();
    downloadSVG(win, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 4242);
    expect(win.clicked).toHaveLength(1);
    expect(win.clicked[0].download).toBe('gallery-wall-4242.svg');
    expect(win.clicked[0].href).toContain('image/svg+xml');
  });

  it('releases the object URL it created', () => {
    const win = fakeWindow();
    downloadSVG(win, '<svg/>', 1);
    expect(win.revoked).toHaveLength(1);
  });

  it('rejects rather than silently doing nothing when the image cannot render', async () => {
    const win = fakeWindow();
    win.Image = class {
      set src(_value) {
        // A silent no-op button is worse than an error message.
        queueMicrotask(() => this.onerror());
      }
    };
    await expect(downloadPNG(win, '<svg/>', 1, 300, 200)).rejects.toThrow();
  });

  it('uses the clipboard API when it is available', async () => {
    const win = fakeWindow();
    const written = [];
    win.navigator = { clipboard: { writeText: async (t) => written.push(t) } };
    expect(await copyToClipboard(win, 'https://example.test/?s=1')).toBe(true);
    expect(written).toEqual(['https://example.test/?s=1']);
  });

  it('falls back when the clipboard API is missing, as outside a secure context', async () => {
    const win = fakeWindow();
    const field = { style: {}, setAttribute() {}, select() {}, remove() {} };
    win.document.createElement = () => field;
    win.document.execCommand = () => true;
    expect(await copyToClipboard(win, 'text')).toBe(true);
    expect(field.value).toBe('text');
  });

  it('falls back when the clipboard API rejects, as when permission is denied', async () => {
    const win = fakeWindow();
    win.navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    };
    const field = { style: {}, setAttribute() {}, select() {}, remove() {} };
    win.document.createElement = () => field;
    win.document.execCommand = () => true;
    expect(await copyToClipboard(win, 'text')).toBe(true);
  });

  it('reports failure rather than throwing when nothing works', async () => {
    const win = fakeWindow();
    win.document.createElement = () => {
      throw new Error('no DOM');
    };
    expect(await copyToClipboard(win, 'text')).toBe(false);
  });
});
