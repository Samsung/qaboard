// The histograms of what the viewers display, and the pixels in a range of values, highlighted on the images.
//
// A highlight is { lo, hi, channels }: the pixels whose channels (R, G, B, Y: luma, those that are true) are all
// within [lo, hi], 8-bit displayed values.

export const CHANNELS = ['R', 'G', 'B', 'Y'];
export const ALL_CHANNELS = [true, true, true, true];

const luma = (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

// Whether a pixel is highlighted
export const inRange = (r, g, b, { lo, hi, channels }) => {
  const values = [r, g, b, channels[3] ? luma(r, g, b) : 0];
  for (let c = 0; c < 4; c++)
    if (channels[c] && (values[c] < lo || values[c] > hi)) return false;
  return true;
};

// [r, g, b, luma] x 256 bins of RGBA pixels (not the transparent ones), and how many are highlighted
export const histogramOf = (data, width, height, highlight = null) => {
  const bins = [0, 1, 2, 3].map(() => new Float64Array(256));
  const step = width * height > 1e6 ? 2 : 1;
  let total = 0;
  let selected = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = 4 * (y * width + x);
      if (data[i + 3] === 0) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      bins[0][r]++;
      bins[1][g]++;
      bins[2][b]++;
      bins[3][luma(r, g, b)]++;
      total++;
      if (highlight && inRange(r, g, b, highlight)) selected++;
    }
  }
  return { bins, total, selected };
};

// The histogram of what a viewer displays (its canvas)
export const histogram = (canvas, highlight = null) => {
  const { width, height } = canvas;
  if (!width || !height) return histogramOf([], 0, 0);
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return histogramOf(data, width, height, highlight);
};

// The highest share of the pixels in a bin, of the channels shown. Not the clipped values (0 and 255): they'd squash the rest.
export const histogramMax = (series, channels) => {
  let max = 0;
  for (const s of series)
    s.bins.forEach((bins, c) => {
      if (!channels[c]) return;
      for (let i = 1; i < 255; i++) max = Math.max(max, bins[i] / (s.total || 1));
    });
  return max;
};

// The value under a position on the histogram, 0 (left) to 1 (right)
export const valueAt = fraction => Math.min(255, Math.max(0, Math.floor(fraction * 256)));

// How users drag on the histogram: an edge of the range, the range, or a new one
export const rangeDrag = (range, value, slack = 2) => {
  if (!range) return 'new';
  if (Math.abs(value - range.lo) <= slack && value <= range.hi) return 'lo';
  if (Math.abs(value - range.hi) <= slack) return 'hi';
  if (value > range.lo && value < range.hi) return 'move';
  return 'new';
};

// The range after dragging from `start` (where the pointer went down, with the range then) to `value`
export const dragRange = (drag, start, value) => {
  const { range, value: from } = start;
  if (drag === 'new') return { lo: Math.min(from, value), hi: Math.max(from, value) };
  if (drag === 'move') {
    const shift = Math.min(255 - range.hi, Math.max(-range.lo, value - from));
    return { lo: range.lo + shift, hi: range.hi + shift };
  }
  // an edge: past the other, it becomes the other
  const fixed = drag === 'lo' ? range.hi : range.lo;
  return { lo: Math.min(fixed, value), hi: Math.max(fixed, value) };
};

// Zebra stripes on the highlighted pixels, the others dimmed. Keep in sync with highlightRenderer.js
export const HIGHLIGHT = {
  // in CSS pixels, along the diagonal
  period: 12,
  light: [255, 214, 10, 0.85],
  dark: [0, 0, 0, 0.6],
  dimmed: [0, 0, 0, 0.45],
};

// RGBA pixels to the highlight over them, on the CPU
export const renderHighlight = (data, out, width, highlight, ratio = 1) => {
  const period = HIGHLIGHT.period * ratio;
  const color = (k, [r, g, b, a]) => {
    out[k] = r;
    out[k + 1] = g;
    out[k + 2] = b;
    out[k + 3] = Math.round(255 * a);
  };
  for (let k = 0; k < data.length; k += 4) {
    if (data[k + 3] === 0) {
      out[k + 3] = 0;
      continue;
    }
    if (!inRange(data[k], data[k + 1], data[k + 2], highlight)) {
      color(k, HIGHLIGHT.dimmed);
      continue;
    }
    const p = k / 4;
    const position = ((p % width + Math.floor(p / width)) / period) % 1;
    color(k, position < 0.5 ? HIGHLIGHT.light : HIGHLIGHT.dark);
  }
};

// Readable ticks for the values axis
export const TICKS = [0, 32, 64, 96, 128, 160, 192, 224, 255];
export const LABELLED_TICKS = [0, 64, 128, 192, 255];

export const formatShare = (count, total) => {
  if (!total) return '–';
  const share = 100 * count / total;
  if (share === 0) return '0%';
  if (share < 0.01) return '<0.01%';
  return `${share < 10 ? share.toFixed(2) : share.toFixed(1)}%`;
};

// The channels shown after clicking one in the legend: alone (or all again, if it was), or, adding, shown or hidden
export const toggleChannel = (channels, channel, adding = false) => {
  if (!adding) return channels.every((shown, c) => shown === (c === channel)) ? ALL_CHANNELS : channels.map((_, c) => c === channel);
  const next = channels.map((shown, c) => c === channel ? !shown : shown);
  return next.some(Boolean) ? next : channels;
};
