// What the analysis panel shows of the view, besides its histogram (histogram.js): the profiles of its rows and
// columns, and statistics per channel. Like the histograms, they're computed on what the viewers display: 8-bit sRGB,
// at the screen's resolution.

// The panel's views. Users pick one, the viewer remembers it (or the app, with analysis / onAnalysisChange).
export const ANALYSES = [
  { value: 'histogram', label: 'Histogram', icon: 'timeline-area-chart', title: 'Histogram of the view: drag on it to highlight a range of values' },
  { value: 'profiles', label: 'Row / column', icon: 'timeline-line-chart', title: 'Row and column profiles: the average of each column and row of the view, or the row and column under the pointer' },
  { value: 'stats', label: 'Statistics', icon: 'th', title: 'Statistics of the view, per channel: mean, standard deviation, SNR, clipping…' },
];
export const DEFAULT_ANALYSIS = 'histogram';
export const normalizeAnalysis = value => ANALYSES.some(a => a.value === value) ? value : DEFAULT_ANALYSIS;

const luma = (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

// --- Profiles ---

// For each of `n` positions along an axis, per channel (R, G, B, Y): how many pixels, their sum, sum of squares, min and max.
// The arrays are flat: position k, channel c is at 4 * k + c.
const accumulator = n => ({
  n,
  count: new Float64Array(n),
  sum: new Float64Array(4 * n),
  sum2: new Float64Array(4 * n),
  min: new Float64Array(4 * n).fill(Infinity),
  max: new Float64Array(4 * n).fill(-Infinity),
});

const put = (acc, i, v) => {
  acc.sum[i] += v;
  acc.sum2[i] += v * v;
  if (v < acc.min[i]) acc.min[i] = v;
  if (v > acc.max[i]) acc.max[i] = v;
};
// no arrays: it runs for every pixel of the view
const add = (acc, k, r, g, b) => {
  acc.count[k]++;
  const i = 4 * k;
  put(acc, i, r);
  put(acc, i + 1, g);
  put(acc, i + 2, b);
  put(acc, i + 3, luma(r, g, b));
};

// The profiles of RGBA pixels (not the transparent ones): `columns` along x, each over the pixels of its column, `rows`
// along y. With `line` ({ x, y }), the values along the row y (`columns`) and along the column x (`rows`) only.
export const profilesOf = (data, width, height, { step = 1, line = null } = {}) => {
  const columns = accumulator(width);
  const rows = accumulator(height);
  const pixel = (x, y, acc, k) => {
    const i = 4 * (y * width + x);
    if (data[i + 3] !== 0) add(acc, k, data[i], data[i + 1], data[i + 2]);
  };
  if (line) {
    if (line.y >= 0 && line.y < height) for (let x = 0; x < width; x++) pixel(x, line.y, columns, x);
    if (line.x >= 0 && line.x < width) for (let y = 0; y < height; y++) pixel(line.x, y, rows, y);
    return { columns, rows };
  }
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = 4 * (y * width + x);
      if (data[i + 3] === 0) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      add(columns, x, r, g, b);
      add(rows, y, r, g, b);
    }
  }
  return { columns, rows };
};

// A profile along the image: { x, mean, std, min, max } (x in image pixels, the others flat, per channel as above), for
// the positions with pixels. `toImage` maps a position (of the screen's pixels) to the image's. With `merge`, the
// positions over the same image pixel are one, e.g. zoomed in, where a pixel of the image covers many of the screen.
export const alongImage = (acc, toImage, merge = false) => {
  const keys = [];
  const groups = [];
  for (let k = 0; k < acc.n; k++) {
    if (!acc.count[k]) continue;
    const x = merge ? Math.floor(toImage(k)) : toImage(k);
    if (merge && keys.length && keys[keys.length - 1] === x) groups[groups.length - 1].push(k);
    else {
      keys.push(x);
      groups.push([k]);
    }
  }
  const m = keys.length;
  const out = { length: m, x: new Float64Array(m), mean: new Float64Array(4 * m), std: new Float64Array(4 * m), min: new Float64Array(4 * m), max: new Float64Array(4 * m) };
  groups.forEach((group, j) => {
    // at the center of the image pixel when merged
    out.x[j] = merge ? keys[j] + 0.5 : keys[j];
    let count = 0;
    for (const k of group) count += acc.count[k];
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      let sum2 = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const k of group) {
        sum += acc.sum[4 * k + c];
        sum2 += acc.sum2[4 * k + c];
        min = Math.min(min, acc.min[4 * k + c]);
        max = Math.max(max, acc.max[4 * k + c]);
      }
      const mean = sum / count;
      out.mean[4 * j + c] = mean;
      out.std[4 * j + c] = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
      out.min[4 * j + c] = min;
      out.max[4 * j + c] = max;
    }
  });
  return out;
};

// The index of the position nearest to x, in a profile (its x increase), or -1
export const nearest = (profile, x) => {
  const { x: xs, length } = profile;
  if (!length) return -1;
  let lo = 0;
  let hi = length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? hi : lo;
};

// The band around the mean: 'minmax', 'std' (±1σ) or 'none'
export const bandOf = (profile, j, c, band) => {
  const i = 4 * j + c;
  if (band === 'minmax') return [profile.min[i], profile.max[i]];
  if (band === 'std') return [profile.mean[i] - profile.std[i], profile.mean[i] + profile.std[i]];
  return [profile.mean[i], profile.mean[i]];
};

// The range of the values of the channels shown, with their band, over profiles
export const valueRange = (profiles, channels, band) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const profile of profiles)
    for (let j = 0; j < profile.length; j++)
      for (let c = 0; c < 4; c++) {
        if (!channels[c]) continue;
        const [a, b] = bandOf(profile, j, c, band);
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
  return lo <= hi ? [lo, hi] : null;
};

// Round ticks between lo and hi: about `count` of them, every 1, 2 or 5 × 10^n
export const niceTicks = (lo, hi, count = 5) => {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
  // multiples of the step, without floating point noise (10.200000000000001)
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) ticks.push(Number((k * step).toFixed(decimals)));
  return ticks;
};

// The axis of the values: their range padded a little, or all the 8-bit values
export const valueDomain = (range, scale) => {
  if (scale === 'full' || !range) return [0, 255];
  const [lo, hi] = range;
  const pad = Math.max(1, (hi - lo) * 0.08);
  return [Math.max(0, lo - pad), Math.min(255, hi + pad)];
};


// --- Statistics ---

// The statistics of a channel, from its histogram (256 bins of 8-bit values): exact, for the pixels counted
export const statsOf = (bins, total) => {
  if (!total) return null;
  let sum = 0;
  let sum2 = 0;
  let min = -1;
  let max = -1;
  for (let i = 0; i < 256; i++) {
    const n = bins[i];
    if (!n) continue;
    if (min < 0) min = i;
    max = i;
    sum += n * i;
    sum2 += n * i * i;
  }
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sum2 / total - mean * mean));
  const percentile = p => {
    let seen = 0;
    for (let i = 0; i < 256; i++) {
      seen += bins[i];
      if (seen >= p * total) return i;
    }
    return 255;
  };
  return {
    mean,
    std,
    // mean / std, in dB: infinite for a flat area
    snr: std > 0 && mean > 0 ? 20 * Math.log10(mean / std) : mean > 0 ? Infinity : null,
    min,
    p1: percentile(0.01),
    median: percentile(0.5),
    p99: percentile(0.99),
    max,
    // the shares of clipped values, black and saturated
    low: bins[0] / total,
    high: bins[255] / total,
  };
};

// The statistics shown, in columns
export const STATS = [
  { key: 'mean', label: 'Mean', title: 'Average value', digits: 2 },
  { key: 'std', label: 'Std dev', title: 'Standard deviation: how much the values vary around the mean (noise, on a flat area)', digits: 2 },
  { key: 'snr', label: 'SNR', title: 'Signal to noise ratio: 20·log10(mean / std dev), in dB. Meaningful on flat areas', digits: 1, unit: ' dB' },
  { key: 'min', label: 'Min', title: 'Lowest value', digits: 0 },
  { key: 'p1', label: 'P1', title: '1st percentile: 1% of the values are lower', digits: 0 },
  { key: 'median', label: 'Median', title: 'Half of the values are lower', digits: 0 },
  { key: 'p99', label: 'P99', title: '99th percentile: 1% of the values are higher', digits: 0 },
  { key: 'max', label: 'Max', title: 'Highest value', digits: 0 },
  { key: 'low', label: 'At 0', title: 'Clipped black: the share of values at 0', share: true },
  { key: 'high', label: 'At 255', title: 'Saturated: the share of values at 255', share: true },
];

const formatShare = share => {
  if (share === 0) return '0%';
  const percent = 100 * share;
  if (percent < 0.01) return '<0.01%';
  return `${percent < 10 ? percent.toFixed(2) : percent.toFixed(1)}%`;
};

export const formatStat = (stat, value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (value === Infinity) return '∞';
  if (stat.share) return formatShare(value);
  return `${value.toFixed(stat.digits)}${stat.unit ?? ''}`;
};

// The difference of two statistics, signed: in percentage points for shares
export const formatStatDelta = (stat, a, b) => {
  if (a === null || b === null || a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return '–';
  const delta = stat.share ? 100 * (a - b) : a - b;
  const digits = stat.share ? 2 : stat.digits;
  const rounded = Number(delta.toFixed(digits));
  if (rounded === 0) return digits ? (0).toFixed(digits) : '0';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(delta).toFixed(digits)}${stat.share ? ' pt' : stat.unit ?? ''}`;
};

// The statistics as tab-separated values, to paste in a spreadsheet. rows: [{ channel, image, stats }]
export const statsTsv = rows => [
  ['Channel', 'Image', ...STATS.map(stat => stat.label)].join('\t'),
  ...rows.map(({ channel, image, stats }) => [
    channel,
    image,
    ...STATS.map(stat => {
      const value = stats?.[stat.key];
      if (value === null || value === undefined) return '';
      if (value === Infinity) return 'inf';
      return stat.share ? (100 * value).toFixed(4) + '%' : Number(value.toFixed(4));
    }),
  ].join('\t')),
].join('\n');
