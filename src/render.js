/**
 * Draws a layout as SVG.
 *
 * Pure string generation with no DOM dependency: the same function produces the
 * preview on the page and the file the user downloads, and it can be tested
 * without a browser.
 *
 * All coordinates are wall centimetres, mapped straight onto the viewBox, so
 * the drawing is resolution-independent and text scales with the wall rather
 * than with whatever element it happens to be rendered into. The original sized
 * its text from the container's measured pixel width, which made the same
 * layout render differently at different viewport sizes.
 */

/** Colours for each theme. Exported so the page and the file agree. */
export const PALETTE = Object.freeze({
  light: Object.freeze({
    wallFill: '#ffffff',
    wallStroke: '#d8d8d8',
    guide: '#ececec',
    frameFill: '#f2f2f2',
    frameStroke: '#2b2b2b',
    label: '#5a5a5a',
    caption: '#8a8a8a',
  }),
  dark: Object.freeze({
    wallFill: '#16181c',
    wallStroke: '#3a3f46',
    guide: '#24272d',
    frameFill: '#242830',
    frameStroke: '#c8ced8',
    label: '#98a1af',
    caption: '#6c7481',
  }),
});

/** Label height as a share of the frame's shorter side. */
const LABEL_SCALE = 0.16;

/** Label height bounds, as a share of the wall's shorter side. */
const LABEL_MIN_RATIO = 0.012;
const LABEL_MAX_RATIO = 0.035;

/** Rough width of one character relative to the font size. */
const CHAR_WIDTH_RATIO = 0.58;

/** Share of the frame width a single-line label may occupy. */
const LABEL_FIT_RATIO = 0.85;

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Trims floating-point noise; two decimals is far finer than any wall. */
const num = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

/**
 * Renders the wall and its frames.
 *
 * @param {Array} frames Placed frames, in wall centimetres.
 * @param {{wallW:number, wallH:number, showLabels?:boolean, palette?:object,
 *          standalone?:boolean, caption?:string}} options
 *   `standalone` adds the XML namespace so the string is a valid `.svg` file on
 *   its own.
 * @returns {string}
 */
export function renderLayoutSVG(frames, options) {
  const {
    wallW,
    wallH,
    showLabels = true,
    palette = PALETTE.light,
    standalone = false,
    caption = '',
  } = options;

  const shortSide = Math.min(wallW, wallH);
  const hairline = Math.max(0.15, shortSide * 0.002);
  const frameStroke = Math.max(0.2, shortSide * 0.004);

  const parts = [];
  parts.push(
    `<svg ${standalone ? 'xmlns="http://www.w3.org/2000/svg" ' : ''}` +
      `viewBox="0 0 ${num(wallW)} ${num(wallH)}" preserveAspectRatio="xMidYMid meet" role="img" ` +
      `aria-labelledby="gw-title gw-desc">`
  );
  parts.push(`<title id="gw-title">Gallery wall layout</title>`);
  parts.push(
    `<desc id="gw-desc">${escapeXml(
      `${frames.length} frame${frames.length === 1 ? '' : 's'} on a ${num(wallW)} by ${num(
        wallH
      )} centimetre wall.`
    )}</desc>`
  );

  // The wall itself, then its centre lines as hanging guides.
  parts.push(
    `<rect class="wall" x="0" y="0" width="${num(wallW)}" height="${num(wallH)}" ` +
      `fill="${palette.wallFill}" stroke="${palette.wallStroke}" stroke-width="${num(hairline)}"/>`
  );
  const dash = `${num(shortSide * 0.03)} ${num(shortSide * 0.03)}`;
  parts.push(
    `<line class="center-line" x1="${num(wallW / 2)}" y1="0" x2="${num(wallW / 2)}" ` +
      `y2="${num(wallH)}" stroke="${palette.guide}" stroke-width="${num(hairline)}" ` +
      `stroke-dasharray="${dash}"/>`
  );
  parts.push(
    `<line class="center-line" x1="0" y1="${num(wallH / 2)}" x2="${num(wallW)}" ` +
      `y2="${num(wallH / 2)}" stroke="${palette.guide}" stroke-width="${num(hairline)}" ` +
      `stroke-dasharray="${dash}"/>`
  );

  const labelMin = shortSide * LABEL_MIN_RATIO;
  const labelMax = shortSide * LABEL_MAX_RATIO;

  for (const f of frames) {
    parts.push(
      `<rect class="frame" x="${num(f.x)}" y="${num(f.y)}" width="${num(f.w)}" ` +
        `height="${num(f.h)}" data-rotated="${f.rotated ? 'true' : 'false'}" ` +
        `fill="${palette.frameFill}" stroke="${palette.frameStroke}" ` +
        `stroke-width="${num(frameStroke)}"/>`
    );
    if (showLabels) parts.push(renderLabel(f, palette, labelMin, labelMax));
  }

  if (caption) {
    parts.push(
      `<text class="caption" x="${num(wallW / 2)}" y="${num(wallH - shortSide * 0.02)}" ` +
        `font-size="${num(labelMax)}" text-anchor="middle" fill="${palette.caption}" ` +
        `font-family="system-ui, sans-serif">${escapeXml(caption)}</text>`
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

/**
 * Draws a frame's size label, wrapping onto two lines when the frame is too
 * narrow to hold it across.
 */
function renderLabel(f, palette, labelMin, labelMax) {
  const size = Math.max(labelMin, Math.min(Math.min(f.w, f.h) * LABEL_SCALE, labelMax));
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const text = `${num(f.w)} × ${num(f.h)}`;

  const common =
    `class="frame-label" x="${num(cx)}" y="${num(cy)}" font-size="${num(size)}" ` +
    `font-family="system-ui, sans-serif" fill="${palette.label}" text-anchor="middle" ` +
    `dominant-baseline="central"`;

  const estimatedWidth = text.length * size * CHAR_WIDTH_RATIO;
  if (estimatedWidth <= f.w * LABEL_FIT_RATIO) {
    return `<text ${common}>${escapeXml(text)}</text>`;
  }

  return (
    `<text ${common}>` +
    `<tspan x="${num(cx)}" dy="-0.6em">${escapeXml(num(f.w))}</tspan>` +
    `<tspan x="${num(cx)}" dy="1.2em">× ${escapeXml(num(f.h))}</tspan>` +
    `</text>`
  );
}
