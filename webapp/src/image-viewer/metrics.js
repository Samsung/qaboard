// How the viewer measures and shows the difference between two images.
//
// The difference is computed on what the viewer displays: 8-bit sRGB values, at the screen's resolution. Zoomed out,
// a screen pixel averages many image pixels: zoom to 1:1 or more to compare every pixel. The GPU renders it
// (diffRenderer.js): the functions here are the reference implementation, used without WebGL, by the tests,
// and for the values under the pointer.

import { colormap } from './colormaps';

// Each method has one setting: an amplification (gain), or the difference shown with the colormap's last color (max)
export const DIFF_METHODS = {
  absolute: {
    label: 'Absolute',
    title: '|new − reference| per channel, amplified',
    description: 'Each channel of |new − reference|, amplified. Black where the images are identical.',
    setting: 'gain',
    values: [1, 2, 4, 8, 16, 32, 64],
    default: 4,
    format: value => `×${value}`,
  },
  signed: {
    label: 'Signed',
    title: 'Luma of new − reference, amplified',
    description: 'Red where the first image (new, unless swapped) is brighter than the second, blue where it is darker.',
    setting: 'gain',
    values: [1, 2, 4, 8, 16, 32, 64],
    default: 4,
    format: value => `×${value}`,
  },
  perceptual: {
    label: 'Perceptual',
    title: 'Perceived color difference (YIQ)',
    description: 'How different colors look (YIQ NTSC color space, Kotsarenko and Ramos), as a fraction of the largest possible difference.',
    setting: 'max',
    values: [0.01, 0.02, 0.05, 0.1, 0.2, 0.3],
    default: 0.05,
    format: value => `${+(100 * value).toFixed(1)}%`,
  },
  deltaE: {
    label: 'ΔE 2000',
    title: 'CIEDE2000 color difference',
    description: 'The CIEDE2000 color difference, in CIELAB. Under 1 it is imperceptible, about 2.3 is just noticeable.',
    setting: 'max',
    values: [1, 2, 3, 5, 10, 20],
    default: 5,
    format: value => `ΔE ${value}`,
  },
  exact: {
    label: 'Any change',
    title: 'Pixels that differ at all',
    description: 'In red, the pixels whose displayed values differ at all. Zoom to 1:1 or more to check every pixel.',
    setting: null,
    values: [],
    default: null,
    format: () => '',
  },
};

export const DEFAULT_DIFF = { method: 'perceptual' };

// Valid settings, whatever we're given (e.g. from a URL)
export const normalizeDiff = diff => {
  const method = DIFF_METHODS[diff?.method] ? diff.method : DEFAULT_DIFF.method;
  const { setting, default: fallback } = DIFF_METHODS[method];
  const value = Number(diff?.[setting]);
  return setting ? { method, [setting]: Number.isFinite(value) && value > 0 ? value : fallback } : { method };
};

// Under this fraction of `max`, heatmaps show the image instead, faded: it tells where we are
export const CONTEXT_BELOW = 0.05;


// --- Colors ---

// Rec. 601, like most image tools
export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

const srgb_to_linear = c => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// sRGB (0-255) to CIELAB, D65
export const srgbToLab = (r, g, b) => {
  const [lr, lg, lb] = [r, g, b].map(srgb_to_linear);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb);
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883;
  const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const [fx, fy, fz] = [x, y, z].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

const deg = rad => rad * 180 / Math.PI;
const rad = degrees => degrees * Math.PI / 180;

// CIEDE2000, following Sharma, Wu and Dalal (2005)
export const deltaE2000 = ([L1, a1, b1], [L2, a2, b2]) => {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const C_mean = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(C_mean ** 7 / (C_mean ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b, ap) => (b === 0 && ap === 0) ? 0 : (deg(Math.atan2(b, ap)) + 360) % 360;
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lp_mean = (L1 + L2) / 2;
  const Cp_mean = (C1p + C2p) / 2;
  let hp_mean = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hp_mean /= 2;
    else hp_mean = (h1p + h2p < 360) ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hp_mean - 30)) + 0.24 * Math.cos(rad(2 * hp_mean))
    + 0.32 * Math.cos(rad(3 * hp_mean + 6)) - 0.20 * Math.cos(rad(4 * hp_mean - 63));
  const d_theta = 30 * Math.exp(-(((hp_mean - 275) / 25) ** 2));
  const R_C = 2 * Math.sqrt(Cp_mean ** 7 / (Cp_mean ** 7 + 25 ** 7));
  const S_L = 1 + 0.015 * (Lp_mean - 50) ** 2 / Math.sqrt(20 + (Lp_mean - 50) ** 2);
  const S_C = 1 + 0.045 * Cp_mean;
  const S_H = 1 + 0.015 * Cp_mean * T;
  const R_T = -Math.sin(rad(2 * d_theta)) * R_C;
  return Math.sqrt(
    (dLp / S_L) ** 2 + (dCp / S_C) ** 2 + (dHp / S_H) ** 2 + R_T * (dCp / S_C) * (dHp / S_H)
  );
};

// The squared YIQ distance of pixelmatch (Kotsarenko and Ramos), from 0 to 35215
export const YIQ_MAX = 35215;
export const yiqDistance = ([r1, g1, b1], [r2, g2, b2]) => {
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.27417610 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
};

// Transparent pixels (around an image that doesn't fill the view) are compared as if over white
export const opaque = (r, g, b, a = 255) => {
  if (a >= 255) return [r, g, b];
  const alpha = a / 255;
  return [r, g, b].map(c => 255 + (c - 255) * alpha);
};


// --- Per pixel ---

// The difference between two displayed pixels ([r, g, b, a?], 0-255) for the hover readout:
// - delta: new − reference, per channel
// - value: what the method measures, e.g. ΔE, or null for "absolute" (see delta)
// - amount: the value relative to the setting, from 0 (identical) to 1 (the colormap's last color), or -1 to 1 for "signed"
export const diffAt = (diff, a, b) => {
  const { method, gain, max } = normalizeDiff(diff);
  const ca = opaque(...a);
  const cb = opaque(...b);
  const delta = [0, 1, 2].map(i => Math.round(ca[i] - cb[i]));
  switch (method) {
    case 'absolute':
      return { delta, value: null, amount: Math.min(1, Math.max(...delta.map(Math.abs)) * gain / 255) };
    case 'signed': {
      const value = luma(...ca) - luma(...cb);
      return { delta, value, amount: Math.max(-1, Math.min(1, value * gain / 255)) };
    }
    case 'perceptual': {
      const value = Math.sqrt(yiqDistance(ca, cb) / YIQ_MAX);
      return { delta, value, amount: Math.min(1, value / max) };
    }
    case 'deltaE': {
      const value = deltaE2000(srgbToLab(...ca), srgbToLab(...cb));
      return { delta, value, amount: Math.min(1, value / max) };
    }
    default: {
      const value = delta.some(d => d !== 0) ? 1 : 0;
      return { delta, value, amount: value };
    }
  }
};

// How the hover readout shows `value`
export const formatDiffValue = (method, value) => {
  if (value === null || value === undefined) return '';
  switch (method) {
    case 'signed': return `Δluma ${value > 0 ? '+' : ''}${value.toFixed(1)}`;
    case 'perceptual': return `${(100 * value).toFixed(2)}%`;
    case 'deltaE': return `ΔE ${value.toFixed(2)}`;
    case 'exact': return value ? 'differs' : 'same';
    default: return '';
  }
};


// --- Whole images ---

// The faded gray image shown where heatmaps show no difference (pixelmatch's)
const context_gray = (r, g, b) => 255 + (luma(r, g, b) - 255) * 0.1;

// Renders the difference of two RGBA buffers of the same size into `out` (e.g. ImageData.data), like the GPU does.
export const renderDiff = (a, b, out, diff) => {
  const { method, gain, max } = normalizeDiff(diff);
  const heat = colormap('inferno');
  const diverging = colormap('diverging');
  const put = (i, r, g, b_) => {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b_;
    out[i + 3] = 255;
  };
  const put_context = (i, c) => {
    const v = context_gray(...c);
    put(i, v, v, v);
  };
  // the colormap is reversed: yellow for small differences, black for large ones
  const put_heat = (i, amount) => {
    const j = 3 * Math.round(255 * (1 - Math.min(1, amount)));
    put(i, heat[j], heat[j + 1], heat[j + 2]);
  };
  for (let i = 0; i < a.length; i += 4) {
    const ca = opaque(a[i], a[i + 1], a[i + 2], a[i + 3]);
    const cb = opaque(b[i], b[i + 1], b[i + 2], b[i + 3]);
    switch (method) {
      case 'absolute':
        put(i, ...[0, 1, 2].map(c => Math.min(255, Math.abs(ca[c] - cb[c]) * gain)));
        break;
      case 'signed': {
        const amount = Math.max(-1, Math.min(1, (luma(...ca) - luma(...cb)) * gain / 255));
        if (Math.abs(amount) < CONTEXT_BELOW / 2) put_context(i, ca);
        else {
          const j = 3 * Math.round(255 * (0.5 + 0.5 * amount));
          put(i, diverging[j], diverging[j + 1], diverging[j + 2]);
        }
        break;
      }
      case 'perceptual': {
        const amount = Math.sqrt(yiqDistance(ca, cb) / YIQ_MAX) / max;
        if (amount < CONTEXT_BELOW) put_context(i, ca);
        else put_heat(i, amount);
        break;
      }
      case 'deltaE': {
        const amount = deltaE2000(srgbToLab(...ca), srgbToLab(...cb)) / max;
        if (amount < CONTEXT_BELOW) put_context(i, ca);
        else put_heat(i, amount);
        break;
      }
      default:
        if (ca[0] !== cb[0] || ca[1] !== cb[1] || ca[2] !== cb[2]) put(i, 230, 30, 30);
        else put_context(i, ca);
    }
  }
  return out;
};

// The legend of a method: what the colors mean
export const diffLegend = diff => {
  const { method, gain, max } = normalizeDiff(diff);
  const { format } = DIFF_METHODS[method];
  switch (method) {
    case 'absolute': return { colormap: null, from: '0', to: `${Math.round(255 / gain)}+`, note: 'per channel' };
    case 'signed': return { colormap: 'diverging', from: `−${Math.round(255 / gain)}`, to: `+${Math.round(255 / gain)}`, note: 'luma' };
    case 'exact': return { colormap: null, from: '', to: '', note: 'red: differs' };
    default: return { colormap: 'inferno', reverse: true, from: '0', to: `${format(max)}+`, note: '' };
  }
};
