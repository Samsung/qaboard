// Display adjustments: brightness, contrast, gamma, sharpening, a channel, false colors.
//
// They only change how images look: an SVG filter applied by the browser (on the GPU when it can) to what the viewer
// draws. The pixel values, the difference and the histograms are those of the images, not adjusted.

import { colormap } from './colormaps';

export const DEFAULT_ADJUSTMENTS = {
  // added to each channel, from -255 to 255
  brightness: 0,
  // around mid-gray
  contrast: 1,
  // over 1 brightens the shadows: values^(1/gamma)
  gamma: 1,
  // unsharp masking
  sharpen: 0,
  // 'rgb', 'r', 'g', 'b' or 'luma': one channel as gray levels
  channel: 'rgb',
  // a colormap for the gray levels (of the channel, or the luma): 'turbo', 'viridis', 'inferno', or null
  falseColor: null,
  invert: false,
};

export const ADJUSTMENT_SLIDERS = [
  { name: 'brightness', label: 'Brightness', min: -255, max: 255, step: 1, format: v => `${v > 0 ? '+' : ''}${v}` },
  { name: 'contrast', label: 'Contrast', min: 0.1, max: 5, step: 0.05, format: v => `×${v.toFixed(2)}` },
  { name: 'gamma', label: 'Gamma', min: 0.1, max: 5, step: 0.05, format: v => v.toFixed(2) },
  { name: 'sharpen', label: 'Sharpen', min: 0, max: 2, step: 0.1, format: v => v.toFixed(1) },
];

export const CHANNELS = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'R' },
  { value: 'g', label: 'G' },
  { value: 'b', label: 'B' },
  { value: 'luma', label: 'Luma' },
];

export const FALSE_COLORS = ['turbo', 'viridis', 'inferno'];

export const normalizeAdjustments = adjustments => ({ ...DEFAULT_ADJUSTMENTS, ...adjustments });

export const changedAdjustments = adjustments => {
  const normalized = normalizeAdjustments(adjustments);
  return Object.keys(DEFAULT_ADJUSTMENTS).filter(name => normalized[name] !== DEFAULT_ADJUSTMENTS[name]);
};

const channel_rows = {
  r: '1 0 0 0 0',
  g: '0 1 0 0 0',
  b: '0 0 1 0 0',
  luma: '0.299 0.587 0.114 0 0',
};

const round = value => +value.toFixed(5);

// The SVG filter primitives for the adjustments, in order: [{ type, attributes, functions? }], or [] when the images
// show as they are. `functions` are the feFuncR/G/B of an feComponentTransfer.
export const filterPrimitives = adjustments => {
  const { brightness, contrast, gamma, sharpen, channel, falseColor, invert } = normalizeAdjustments(adjustments);
  const primitives = [];
  const transfer = (type, attributes) => ({
    type: 'feComponentTransfer',
    attributes: {},
    functions: ['R', 'G', 'B'].map(c => ({ channel: c, type, ...(typeof attributes === 'function' ? attributes(c) : attributes) })),
  });

  // False colors map gray levels: the luma of color images
  const gray = channel !== 'rgb' ? channel : falseColor ? 'luma' : null;
  if (gray && channel_rows[gray]) {
    const row = channel_rows[gray];
    primitives.push({ type: 'feColorMatrix', attributes: { type: 'matrix', values: `${row} ${row} ${row} 0 0 0 1 0` } });
  }
  if (gamma !== 1 && gamma > 0)
    primitives.push(transfer('gamma', { amplitude: 1, exponent: round(1 / gamma), offset: 0 }));
  if (brightness !== 0 || contrast !== 1)
    primitives.push(transfer('linear', { slope: round(contrast), intercept: round(0.5 - 0.5 * contrast + brightness / 255) }));
  if (sharpen > 0) {
    const s = round(sharpen);
    primitives.push({
      type: 'feConvolveMatrix',
      attributes: { order: 3, kernelMatrix: `0 ${-s} 0 ${-s} ${round(1 + 4 * s)} ${-s} 0 ${-s} 0`, preserveAlpha: 'true', edgeMode: 'duplicate' },
    });
  }
  if (invert)
    primitives.push(transfer('table', { tableValues: '1 0' }));
  if (falseColor) {
    const lut = colormap(falseColor);
    const samples = 33;
    const table = c => {
      const offset = 'RGB'.indexOf(c);
      return {
        tableValues: Array.from({ length: samples }, (_, i) => {
          const j = 3 * Math.round(255 * i / (samples - 1));
          return round(lut[j + offset] / 255);
        }).join(' '),
      };
    };
    primitives.push(transfer('table', table));
  }
  return primitives;
};

// e.g. for the copied images
export const describeAdjustments = adjustments => {
  const normalized = normalizeAdjustments(adjustments);
  return changedAdjustments(normalized).map(name => {
    const slider = ADJUSTMENT_SLIDERS.find(s => s.name === name);
    if (slider) return `${slider.label.toLowerCase()} ${slider.format(normalized[name])}`;
    if (name === 'channel') return `${normalized.channel.toUpperCase()} channel`;
    if (name === 'falseColor') return `${normalized.falseColor} colors`;
    return name;
  });
};
