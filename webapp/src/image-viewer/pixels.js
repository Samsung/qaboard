// Pixel values: the displayed ones, read from what the viewer draws (8-bit RGB), and the image's own values (e.g.
// 16-bit, raw Bayer...) that apps can give with the `getPixels(image, region, { signal })` prop: see pixelTiles.js.

export const formatNumber = (value, base = 10) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  if (base === 16 && Number.isInteger(value)) return `0x${value.toString(16)}`;
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(4).replace(/\.?0+$/, '');
};

export const formatSigned = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;

// Black or white, whichever is readable on this color
export const textColorOn = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#000' : '#fff';

// The image pixels visible in a view, given where the image is drawn:
//   origin: the view coordinates of the image's top-left corner, scale: view pixels per image pixel
// Returns { x0, y0, x1, y1 } (x1, y1 excluded), or null when nothing is visible
export const visiblePixels = ({ origin, scale }, view, size) => {
  if (!(scale > 0)) return null;
  const x0 = Math.max(0, Math.floor(-origin.x / scale));
  const y0 = Math.max(0, Math.floor(-origin.y / scale));
  const x1 = Math.min(size.width, Math.ceil((view.width - origin.x) / scale));
  const y1 = Math.min(size.height, Math.ceil((view.height - origin.y) / scale));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
};

// The size of the text in a pixel, or null when it doesn't fit: we show values when users zoomed in enough
export const MIN_CELL = 30;
export const cellFont = (cell, lines, digits) => {
  if (cell < MIN_CELL) return null;
  const by_height = (cell * 0.85) / (lines * 1.15);
  const by_width = (cell * 0.9) / (Math.max(digits, 1) * 0.62);
  const size = Math.min(16, by_height, by_width);
  // several lines of tiny text are unreadable
  return size >= (lines > 1 ? 9 : 7) ? Math.floor(size * 2) / 2 : null;
};
