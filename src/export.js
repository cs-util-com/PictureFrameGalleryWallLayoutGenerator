/**
 * Saving a layout out of the browser: as an SVG file, as a PNG, or on paper.
 *
 * The pure helpers here are separated from the DOM glue so the parts that can
 * go wrong — encoding, sizing, file naming — are testable.
 */

/** Widest PNG we will rasterise, so a huge wall cannot exhaust memory. */
export const PNG_MAX_WIDTH = 4000;

/** Rendered pixels per centimetre of wall. */
const PIXELS_PER_CM = 5;

/**
 * A safe, descriptive download name. The seed is included because it is what
 * identifies the layout — several downloads from one session should not
 * silently overwrite each other in the downloads folder.
 */
export function buildFilename(seed, extension) {
  const safeSeed = String(seed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `gallery-wall-${safeSeed}.${extension}`;
}

/**
 * Encodes SVG markup as a data URL.
 *
 * The markup is converted to UTF-8 bytes before base64 encoding: every size
 * label contains a multiplication sign, and `btoa` throws on any character
 * above U+00FF.
 */
export function svgToDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Pixel dimensions for rasterising a wall, preserving its aspect ratio. */
export function pngPixelSize(wallW, wallH) {
  const scale = Math.min(PIXELS_PER_CM, PNG_MAX_WIDTH / Math.max(wallW, 1));
  return {
    width: Math.max(1, Math.round(wallW * scale)),
    height: Math.max(1, Math.round(wallH * scale)),
  };
}

/** Hands the user a file. */
export function triggerDownload(win, url, filename, revoke = false) {
  const link = win.document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  win.document.body.appendChild(link);
  link.click();
  link.remove();
  if (revoke) win.URL.revokeObjectURL(url);
}

/** Downloads the layout as a standalone .svg file. */
export function downloadSVG(win, svg, seed) {
  const blob = new win.Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = win.URL.createObjectURL(blob);
  triggerDownload(win, url, buildFilename(seed, 'svg'), true);
}

/**
 * Rasterises the layout and downloads it as a .png.
 *
 * @returns {Promise<void>} Rejects if the image cannot be decoded, which the
 *   caller should surface rather than swallow — a silent no-op button is worse
 *   than an error message.
 */
export function downloadPNG(win, svg, seed, wallW, wallH) {
  return new Promise((resolve, reject) => {
    const { width, height } = pngPixelSize(wallW, wallH);
    const image = new win.Image();

    image.onload = () => {
      const canvas = win.document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not encode the image'));
          return;
        }
        const url = win.URL.createObjectURL(blob);
        triggerDownload(win, url, buildFilename(seed, 'png'), true);
        resolve();
      }, 'image/png');
    };
    image.onerror = () => reject(new Error('Could not render the layout as an image'));
    image.src = svgToDataUrl(svg);
  });
}

/**
 * Copies text to the clipboard.
 *
 * The Clipboard API is unavailable outside secure contexts and can be denied by
 * permission, so the older selection-based path is kept as a fallback.
 *
 * @returns {Promise<boolean>} Whether the copy succeeded.
 */
export async function copyToClipboard(win, text) {
  try {
    if (win.navigator?.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    const doc = win.document;
    const field = doc.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    doc.body.appendChild(field);
    field.select();
    const copied = doc.execCommand?.('copy') ?? false;
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
