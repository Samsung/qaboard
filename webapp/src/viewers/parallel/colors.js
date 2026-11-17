// The colors of the lines: a sequential scale for numbers, a palette for categories. Rows get a palette index
// (few distinct stroke styles to set on the canvas) and a drawing order (the salient ones last, on top).

const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']
  .map(hex => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)));

/** viridis at t in [0, 1], as [r, g, b] */
export function viridis(t) {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const k = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - k;
  return VIRIDIS[k].map((c, channel) => Math.round(c + (VIRIDIS[k + 1][channel] - c) * f));
}

/**
 * The sequential scale, by salience: at 1 the color that stands out the most on the theme's background (dark purple
 * on white, bright yellow on dark), at 0 the one that recedes. The good end of a column with `better` is at 1.
 * Both themes show viridis, clipped where it would be unreadable on the background.
 */
export function sequential(salience, dark) {
  const s = Math.min(1, Math.max(0, salience));
  const [r, g, b] = dark ? viridis(0.24 + 0.76 * s) : viridis(0.9 * (1 - s));
  return `rgb(${r}, ${g}, ${b})`;
}

export const CATEGORY_COLORS = {
  light: ['#2d72d2', '#d1980b', '#238551', '#cd4246', '#9d3f9d', '#00a396', '#d33d17', '#7961db', '#5f8c1b'],
  dark: ['#4c90f0', '#f0b726', '#32a467', '#e76a6e', '#bd6bbd', '#13c9ba', '#ec9a3c', '#9881f3', '#b6d94c'],
};
const NEUTRAL = { light: '#8f99a8', dark: '#738091' };
const SINGLE = { light: '#2d72d2', dark: '#4c90f0' };
const BUCKETS = 64;

/**
 * The colors of the rows for a column (analyzed, see model.js), or one color for all without a column.
 * Returns { palette, index, order, legend }: row i is drawn with palette[index[i]], in the order of `order`.
 */
export function rowColors(column, n, { dark = false, log = false } = {}) {
  const theme = dark ? 'dark' : 'light';
  const neutral = NEUTRAL[theme];
  const index = new Uint8Array(n);
  const natural = () => { const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i; return order; };
  if (!column) return { palette: [SINGLE[theme]], index, order: natural(), legend: null, neutral };

  if (column.type === 'number' && column.max >= column.min) {
    log = !!log && column.positive;
    const f = log ? Math.log10 : x => x;
    const a = f(column.min), span = f(column.max) - a;
    const lower = column.better === 'lower';
    const palette = Array.from({ length: BUCKETS }, (_, k) => sequential(k / (BUCKETS - 1), dark));
    palette.push(neutral);
    const salience = new Float32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const v = column.num[i];
      if (v !== v) { index[i] = BUCKETS; continue; }
      const t = span > 0 ? (f(v) - a) / span : 0.5;
      salience[i] = lower ? 1 - t : t;
      index[i] = Math.round(salience[i] * (BUCKETS - 1));
    }
    const order = natural().sort((p, q) => salience[p] - salience[q] || p - q);
    return {
      palette, index, order, neutral,
      legend: {
        type: 'number', column, log,
        // left to right: from the lowest value to the highest
        gradient: Array.from({ length: 9 }, (_, k) => sequential(lower ? 1 - k / 8 : k / 8, dark)),
        min: column.min, max: column.max,
        has_other: column.n_missing + column.n_other > 0,
      },
    };
  }

  const categories = column.type === 'number' ? column.others : column.categories;
  const cat = column.type === 'number' ? column.other : column.cat;
  const colors = CATEGORY_COLORS[theme];
  const palette = [...colors, neutral];
  for (let i = 0; i < n; i++) index[i] = cat[i] >= 0 && cat[i] < colors.length ? cat[i] : colors.length;
  return {
    palette, index, order: natural(), neutral,
    legend: {
      type: 'category', column,
      items: categories.slice(0, colors.length).map((c, k) => ({ name: c.name, count: c.count, color: colors[k] })),
      more: Math.max(0, categories.length - colors.length),
      has_other: column.n_missing > 0 || categories.length > colors.length,
    },
  };
}
