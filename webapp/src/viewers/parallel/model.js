// The logic of the parallel coordinates plot, without React or canvas: what type each column is, where each row
// goes on each axis (scales, ticks, the bands that spread tied rows), which rows the brushes keep and which line
// is under the cursor. Everything works on row indices and typed arrays: 5,000 rows x 40 columns stay fast.

// --- Values -----------------------------------------------------------------------------------------------------

/** The names of the slots of rows without a value, and with a non-numeric value on a numeric axis */
export const MISSING = '∅ missing';
export const OTHER = '… other';

export const isMissing = v => v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v));

/** The number a value stands for (numbers and numeric strings), or null */
export const toNumber = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  return null;
};

/** How a value is named as a category: strings verbatim, the rest as JSON */
export const categoryName = v => {
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

const trimZeros = s => s.includes('.') ? s.replace(/\.?0+$/, '') : s;
const exponent = (x, digits) => {
  const [mantissa, exp] = x.toExponential(digits).split('e');
  return `${trimZeros(mantissa)}e${exp.replace('+', '')}`;
};

/** A number for the tooltips: integers as they are, the rest with 4 significant digits */
export function formatNumber(x, digits = 4) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (Number.isInteger(x)) return a < 1e9 ? String(x) : exponent(x, digits - 1);
  if (a >= 1e9 || a < 1e-4) return exponent(x, digits - 1);
  if (a >= 10 ** digits) return String(Math.round(x));
  return String(Number(x.toPrecision(digits)));
}

const UNITS = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
/** A compact number for the ticks: 1.2k, 3e-4, 0.25. `step` is the distance between ticks, for the decimals. */
export function formatTick(x, step) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e15) return exponent(x, 2);
  if (a >= 1e3) {
    const [unit, suffix] = UNITS.find(([u]) => a >= u);
    return `${trimZeros((x / unit).toPrecision(3))}${suffix}`;
  }
  if (a < 1e-3) return exponent(x, 2);
  const decimals = step > 0 && Number.isFinite(step) ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))) : 3;
  return String(Number(x.toFixed(Math.max(decimals, a < 1 ? Math.ceil(-Math.log10(a)) : 0))));
}

// --- Columns ----------------------------------------------------------------------------------------------------

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const MAX_DISTINCT = 8;

/**
 * What a column holds: its type, its values as typed arrays, its range or categories.
 * - numbers and numeric strings make a `number` column, anything else a `category` column,
 * - a column with at least 90% of numbers stays a number: the other values go to a separate "other" band,
 * - undefined, null and NaN are missing, on any column.
 */
export function analyzeColumn(column, rows) {
  const n = rows.length;
  const key = column.key;
  const num = new Float64Array(n).fill(NaN);
  const names = Array.from({ length: n });
  let n_missing = 0, n_num = 0;
  for (let i = 0; i < n; i++) {
    const v = rows[i].values?.[key];
    if (isMissing(v)) { n_missing++; continue; }
    names[i] = categoryName(v);
    const x = toNumber(v);
    if (x !== null) { num[i] = x; n_num++; }
  }
  const present = n - n_missing;
  const type = column.type === 'number' || column.type === 'category'
    ? column.type
    : (n_num > 0 && n_num >= 0.9 * present ? 'number' : 'category');
  const base = { ...column, key, label: column.label ?? key, type, n, n_missing, names };

  // the categories, in the order of `choices` then sorted like a person would
  const categorize = keep => {
    const counts = new Map();
    for (let i = 0; i < n; i++) if (names[i] !== undefined && keep(i)) counts.set(names[i], (counts.get(names[i]) ?? 0) + 1);
    const choices = (column.choices ?? []).map(categoryName);
    const rank = new Map(choices.map((c, i) => [c, i]));
    const ordered = [...counts.keys()].sort((a, b) => {
      const ra = rank.get(a) ?? Infinity, rb = rank.get(b) ?? Infinity;
      return ra !== rb ? ra - rb : natural.compare(a, b);
    });
    const index = new Map(ordered.map((name, i) => [name, i]));
    const cat = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) if (names[i] !== undefined && keep(i)) cat[i] = index.get(names[i]);
    return { categories: ordered.map(name => ({ name, count: counts.get(name) })), cat };
  };

  if (type === 'category') {
    const { categories, cat } = categorize(() => true);
    const states = categories.length + (n_missing > 0 ? 1 : 0);
    return {
      ...base, categories, cat, constant: states <= 1,
      constant_value: states <= 1 ? (categories[0]?.name ?? 'missing') : undefined,
    };
  }

  let min = Infinity, max = -Infinity, integer = true;
  const distinct = new Set();
  for (let i = 0; i < n; i++) {
    const x = num[i];
    if (x !== x) continue;
    if (x < min) min = x;
    if (x > max) max = x;
    if (integer && !Number.isInteger(x)) integer = false;
    if (distinct.size <= MAX_DISTINCT) distinct.add(x);
  }
  // the values that aren't numbers, on their own band
  const { categories: others, cat: other } = categorize(i => num[i] !== num[i]);
  const states = distinct.size + others.length + (n_missing > 0 ? 1 : 0);
  const column_ = {
    ...base, num, min, max, integer: integer && n_num > 0, positive: min > 0, others, other, n_other: present - n_num,
    // the few values of a grid search get a tick each
    distinct: distinct.size <= MAX_DISTINCT ? [...distinct].sort((a, b) => a - b) : null,
    constant: states <= 1,
  };
  if (states <= 1) column_.constant_value = n_num > 0 ? formatValue(column_, min) : (others[0]?.name ?? 'missing');
  return column_;
}

/** A value as the tooltips show it: the true value, not where it's drawn */
export function formatValue(column, value) {
  if (isMissing(value)) return 'missing';
  if (column.format) {
    try { return String(column.format(value)); } catch { /* the value as it is */ }
  }
  if (column.type === 'number') {
    const x = toNumber(value);
    if (x !== null) return `${formatNumber(x)}${column.suffix ?? ''}`;
  }
  return categoryName(value);
}

// --- Scales and ticks -------------------------------------------------------------------------------------------

const niceStep = raw => {
  const power = 10 ** Math.floor(Math.log10(raw));
  const r = raw / power;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * power;
};

/** Round values within [min, max], about `count` of them; whole numbers only for integer columns */
export function niceTicks(min, max, count = 6, integer = false) {
  if (!(max > min)) return [min];
  let step = niceStep((max - min) / Math.max(1, count));
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
}

/** Powers of ten within [min, max] (with 2 and 5 times them when there are few decades) */
export function logTicks(min, max, count = 6) {
  if (!(min > 0) || !(max > min)) return [min];
  const lo = Math.floor(Math.log10(min) + 1e-9), hi = Math.ceil(Math.log10(max) - 1e-9);
  const decades = hi - lo;
  const multipliers = decades <= 1 ? [1, 2, 3, 5] : decades <= 2 ? [1, 2, 5] : decades <= Math.max(3, count / 2) ? [1, 3] : [1];
  const every = Math.max(1, Math.ceil(decades / Math.max(2, count)));
  const ticks = [];
  for (let e = lo; e <= hi; e++) {
    if (multipliers.length === 1 && (e - lo) % every !== 0) continue;
    for (const m of multipliers) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) ticks.push(v);
    }
  }
  return ticks;
}

/** Where numbers go between `top` and `bottom` (pixels): the highest at the top, unless flipped */
export function numericScale({ min, max, log = false, flipped = false, top, bottom }) {
  const f = log ? Math.log10 : x => x;
  const g = log ? x => 10 ** x : x => x;
  const a = f(min), b = f(max);
  const span = b - a;
  const middle = (top + bottom) / 2;
  const from = flipped ? top : bottom, to = flipped ? bottom : top;
  return {
    toY: v => span > 0 ? from + (f(v) - a) / span * (to - from) : middle,
    fromY: y => span > 0 ? g(a + Math.min(1, Math.max(0, (y - from) / (to - from))) * span) : min,
  };
}

// --- Layout -----------------------------------------------------------------------------------------------------

export const GEOMETRY = {
  min_axis: 104,        // the least distance between axes: beyond, the plot scrolls
  pad_left: 72,         // room for the first axis' tick labels
  pad_right: 56,
  marks_right: 96,      // ... and for the labels of the marked rows
  group_height: 18,
  title_height: 26,
  pad_top: 30,          // between the titles and the top of the axes: the bands of the top categories go there
  pad_bottom: 22,
  missing_height: 34,   // the slot of the rows without a value, under the axes
  group_gap: 36,        // more room between the axes of two groups
  other_height: 38,     // on a numeric axis, room for the band of the values that aren't numbers
  line_step: 2.5,       // between two tied lines, when there is room
  max_value_band: 22,   // tied numbers never spread more than this...
  value_band_share: 0.7,// ... or than this share of the distance to the next value,
  min_value_gap: 3,     // and not at all when the next value is closer than this
  max_category_band: 44,
  max_missing_band: 16,
  tie_tolerance: 0.5,   // numbers closer than this (pixels) are tied
  tick_gap: 44,
  label_gap: 13,        // the least distance between two tick labels
  brush_margin: 14,     // brushes reach this far beyond the axes' ends
  curve: 0.5,           // where the curves' control points are between two axes: 0.5 gives horizontal tangents and symmetric S curves
};

// The clusters of rows tied on a numeric axis: a slot each
function valueSlots(column, center, G) {
  const n = column.n;
  const rows = [];
  for (let i = 0; i < n; i++) if (column.num[i] === column.num[i]) rows.push(i);
  const sorted = Uint32Array.from(rows).sort((a, b) => center[a] - center[b] || a - b);
  const slots = [];
  const slot = new Int32Array(n).fill(-1);
  let start = -Infinity, current = null;
  for (const i of sorted) {
    const y = center[i];
    if (!current || y - start > G.tie_tolerance) {
      start = y;
      current = { type: 'value', name: String(column.num[i]), value: column.num[i], y, y_max: y, count: 0, band: 0 };
      slots.push(current);
    }
    current.y_max = y;
    current.count++;
    slot[i] = slots.length - 1;
  }
  for (const s of slots) s.y = (s.y + s.y_max) / 2;
  slots.forEach((s, k) => {
    if (s.count < 2) return;
    const gap = Math.min(k > 0 ? s.y - slots[k - 1].y : Infinity, k < slots.length - 1 ? slots[k + 1].y - s.y : Infinity);
    if (gap < G.min_value_gap) return;
    s.band = Math.min(G.max_value_band, G.value_band_share * gap, (s.count - 1) * G.line_step);
  });
  return { slots, slot };
}

/**
 * Where a column's rows go on its axis, before the ties are spread:
 * - `center[i]`: the y of row i's value (rows with the same value have the same),
 * - `slots`: the groups of rows that share a place (a category, tied numbers, "other", "missing"), each with the
 *   band its rows will spread over, and `slot[i]` the one row i is in,
 * - `ticks`: what the axis labels. Those with a `slot` stand for all its rows: they can be hovered and toggled.
 */
export function layoutAxis(column, { top, bottom, missing_y, log = false, flipped = false, x = 0 }, G = GEOMETRY) {
  const n = column.n;
  const center = new Float32Array(n);
  let slots, slot, ticks = [], scale = null, line_bottom = bottom;
  const missing_band = count => Math.min(G.max_missing_band, (count - 1) * G.line_step);

  if (column.type === 'number') {
    log = !!log && column.positive;
    const has_other = column.n_other > 0;
    const no_numbers = !(column.max >= column.min);
    line_bottom = has_other ? bottom - G.other_height : bottom;
    scale = numericScale({ min: column.min, max: column.max, log, flipped, top, bottom: line_bottom });
    const other_y = bottom - 4;
    for (let i = 0; i < n; i++) {
      const v = column.num[i];
      center[i] = v === v ? scale.toY(v) : column.other[i] >= 0 ? other_y : missing_y;
    }
    ({ slots, slot } = valueSlots(column, center, G));

    const height = line_bottom - top;
    const discrete = column.distinct && column.distinct.length > 1 && slots.length === column.distinct.length
      && slots.every((s, k) => k === 0 || s.y - slots[k - 1].y >= G.label_gap);
    if (no_numbers) {
      ticks = [];
    } else if (discrete || column.min === column.max) {
      // a few values: one tick each, that stands for its rows
      const step = column.distinct.length > 1 ? Math.min(...column.distinct.slice(1).map((v, k) => v - column.distinct[k])) : 0;
      ticks = slots.map((s, k) => ({ y: s.y, label: formatTick(s.value, step / 10), slot: k, count: s.count, title: formatValue(column, s.value) }));
    } else {
      const count = Math.max(2, Math.floor(height / G.tick_gap));
      const values = log ? logTicks(column.min, column.max, count) : niceTicks(column.min, column.max, count, column.integer);
      const step = values.length > 1 && !log ? values[1] - values[0] : 0;
      // the range's ends are always labeled, round values in between where there is room
      const end_step = log ? 0 : (column.max - column.min) / 100;
      const end = v => ({ y: scale.toY(v), label: column.integer ? formatTick(v, 1) : formatTick(v, end_step), end: true, title: formatValue(column, v) });
      const ends = [end(column.min), end(column.max)];
      ticks = [
        ...ends,
        ...values
          .map(v => ({ y: scale.toY(v), label: formatTick(v, log ? 0 : step), title: formatValue(column, v) }))
          .filter(t => ends.every(e => Math.abs(e.y - t.y) >= G.label_gap)),
      ];
    }
    if (has_other) {
      const count = column.n_other;
      slots.push({ type: 'other', name: OTHER, y: other_y, count, band: missing_band(count), values: column.others });
      const k = slots.length - 1;
      for (let i = 0; i < n; i++) if (column.other[i] >= 0) slot[i] = k;
      const label = column.others.length === 1 ? column.others[0].name : 'other';
      ticks.push({ y: other_y, label, slot: k, count, title: column.others.map(o => `${o.name} (${o.count})`).join(', ') });
    }
  } else {
    const k = column.categories.length;
    const spacing = k > 1 ? (bottom - top) / (k - 1) : bottom - top;
    const max_count = Math.max(1, ...column.categories.map(c => c.count));
    const max_band = Math.min(G.max_category_band, G.value_band_share * spacing);
    slots = column.categories.map((c, i) => {
      const position = flipped ? k - 1 - i : i;
      return {
        type: 'category', name: c.name, count: c.count,
        y: k > 1 ? top + position * spacing : (top + bottom) / 2,
        // proportional-ish to the count: lines at least `line_step` apart while there is room, never more than the cap
        band: Math.min(max_band * Math.sqrt(c.count / max_count), (c.count - 1) * G.line_step),
      };
    });
    slot = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      slot[i] = column.cat[i];
      center[i] = column.cat[i] >= 0 ? slots[column.cat[i]].y : missing_y;
    }
    // every category is labeled when there is room, or every other one...
    const every = Math.max(1, Math.ceil(G.label_gap / Math.max(spacing, 1e-6)));
    ticks = slots.map((s, i) => ({ y: s.y, label: s.name, slot: i, count: s.count, title: s.name, hidden: i % every !== 0 }));
  }

  if (column.n_missing > 0) {
    slots.push({ type: 'missing', name: MISSING, y: missing_y, count: column.n_missing, band: missing_band(column.n_missing) });
    const k = slots.length - 1;
    for (let i = 0; i < n; i++) if (slot[i] < 0) slot[i] = k;
    ticks.push({ y: missing_y, label: String(column.n_missing), slot: k, count: column.n_missing, missing: true, title: `${column.n_missing} without a value` });
  }
  return {
    column, key: column.key, x, top, bottom, line_bottom, missing_y, log, flipped, scale, center, slot, slots, ticks,
    // what a brush can cover
    extent: [top - G.brush_margin, (column.n_missing > 0 ? missing_y : bottom) + G.brush_margin],
    pos: center,
  };
}

/**
 * Spreads the rows that share a slot over its band, so that each line can be followed: `axis.pos[i]` is where row i
 * crosses the axis. Within a slot the rows are ordered like on the neighbouring axes, so that the lines of a slot fan
 * out without crossing: first like on the neighbour with the fewest places (where the lines make bundles), then like on
 * the other one.
 */
export function spreadTies(axes) {
  // twice: the second time, rows that are tied on the neighbours too follow the order they got there, so that the
  // lines of a bundle are parallel
  const first = axes.map((axis, j) => spreadAxis(axes, j, null));
  const second = axes.map((axis, j) => spreadAxis(axes, j, first));
  axes.forEach((axis, j) => { axis.pos = second[j]; });
  return axes;
}

function spreadAxis(axes, j, previous) {
  const axis = axes[j];
  const n = axis.center.length;
  // nothing to spread: the rows are where their values are
  if (!axis.slots.some(s => s.band > 0 && s.count > 1)) return axis.center;
  const neighbours = [j + 1, j - 1].filter(k => axes[k]);
  // sort() is stable: the right neighbour comes first on a tie
  neighbours.sort((a, b) => axes[a].slots.length - axes[b].slots.length);
  const k1 = axes[neighbours[0]]?.center, k2 = axes[neighbours[1]]?.center;
  const p1 = previous?.[neighbours[0]], p2 = previous?.[neighbours[1]];
  const slot = axis.slot;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => slot[a] - slot[b]
    || (k1 ? k1[a] - k1[b] : 0)
    || (k2 ? k2[a] - k2[b] : 0)
    || (p1 ? p1[a] - p1[b] : 0)
    || (p2 ? p2[a] - p2[b] : 0)
    || a - b);
  const pos = new Float32Array(n);
  let start = 0;
  while (start < n) {
    const s = axis.slots[slot[order[start]]];
    let end = start + 1;
    while (end < n && slot[order[end]] === slot[order[start]]) end++;
    const count = end - start;
    for (let r = start; r < end; r++) {
      const i = order[r];
      pos[i] = s.band > 0 && count > 1
        ? s.y + ((r - start) / (count - 1) - 0.5) * s.band
        // tied within less than a pixel, without room to spread: where the value is
        : axis.center[i];
    }
    start = end;
  }
  return pos;
}

/**
 * The whole plot's geometry: one axis per column, left to right.
 * - `columns`: analyzed columns (analyzeColumn), the visible ones, in order,
 * - `options[key]`: { log, flipped },
 * - `width`: what's available: the axes spread over it, or get their minimum width and the content is wider.
 */
export function computeLayout(columns, { width, height, options = {}, marks = false }, G = GEOMETRY) {
  const has_groups = columns.some(c => c.group);
  const has_missing = columns.some(c => c.n_missing > 0);
  const pad_right = marks ? G.marks_right : G.pad_right;
  const top = (has_groups ? G.group_height : 0) + G.title_height + G.pad_top;
  const bottom = Math.max(top + 60, height - G.pad_bottom - (has_missing ? G.missing_height : 0));
  const missing_y = bottom + G.missing_height - 6;

  const breaks = columns.map((c, j) => j > 0 && has_groups && (c.group ?? '') !== (columns[j - 1].group ?? ''));
  const n_breaks = breaks.filter(Boolean).length;
  const gaps = Math.max(1, columns.length - 1);
  const spacing = Math.max(G.min_axis, (width - G.pad_left - pad_right - n_breaks * G.group_gap) / gaps);
  let x = G.pad_left;
  const axes = columns.map((column, j) => {
    if (j > 0) x += spacing + (breaks[j] ? G.group_gap : 0);
    return layoutAxis(column, { top, bottom, missing_y, x, ...options[column.key] }, G);
  });
  spreadTies(axes);

  // the runs of consecutive axes of the same group
  const groups = [];
  if (has_groups) {
    axes.forEach((axis, j) => {
      const name = axis.column.group ?? '';
      if (j === 0 || breaks[j]) groups.push({ name, from: j, to: j, x0: axis.x, x1: axis.x });
      else { groups[groups.length - 1].to = j; groups[groups.length - 1].x1 = axis.x; }
    });
  }
  return {
    axes, groups, spacing, top, bottom, missing_y, has_missing, has_groups,
    width: Math.max(width, Math.ceil(x + pad_right)), height,
    title_top: has_groups ? G.group_height : 0,
    curve: G.curve,
  };
}

// --- Brushes ----------------------------------------------------------------------------------------------------

// A brush is on an axis, by its column's key:
// - { type: 'range', t0, t1 }: the rows whose value is drawn between two heights, as fractions of the axis' height
//   (so that they survive a resize). Tied rows are kept or dropped together: what counts is where their value is,
//   not where each line was spread to.
// - { type: 'set', names: [...] }: the rows in those slots (categories, the values of a grid, MISSING, OTHER).

const BEYOND = 1000;
// heights as fractions of the axis: 0 at its top, 1 at its bottom, and pixels / 1000 beyond (the "other" and "missing" slots)
const toFraction = (axis, y) => {
  const top = axis.top, bottom = axis.line_bottom;
  return y < top ? (y - top) / BEYOND : y > bottom ? 1 + (y - bottom) / BEYOND : (y - top) / (bottom - top);
};
const fromFraction = (axis, t) => {
  const top = axis.top, bottom = axis.line_bottom;
  return t < 0 ? top + t * BEYOND : t > 1 ? bottom + (t - 1) * BEYOND : top + t * (bottom - top);
};
export const brushPixels = (axis, brush) => [fromFraction(axis, brush.t0), fromFraction(axis, brush.t1)];
export const rangeBrush = (axis, y0, y1) => {
  const [e0, e1] = axis.extent;
  const t = y => toFraction(axis, Math.min(e1, Math.max(e0, y)));
  return { type: 'range', t0: t(Math.min(y0, y1)), t1: t(Math.max(y0, y1)) };
};

/** The names of the slots a brush keeps */
export function brushedSlots(axis, brush) {
  if (!brush) return null;
  if (brush.type === 'set') return new Set(brush.names);
  const [y0, y1] = brushPixels(axis, brush);
  return new Set(axis.slots.filter(s => s.y >= y0 - 0.5 && s.y <= y1 + 0.5).map(s => s.name));
}

/** Clicking a tick toggles its slot: from nothing brushed, only that slot is kept */
export function toggleSlot(axis, brush, name) {
  const names = brushedSlots(axis, brush) ?? new Set();
  if (names.has(name)) names.delete(name); else names.add(name);
  return names.size ? { type: 'set', names: axis.slots.map(s => s.name).filter(s => names.has(s)) } : null;
}

/** The values a range brush covers on a numeric axis, to label it: [low, high] or null */
export function brushValues(axis, brush) {
  if (!axis.scale || brush?.type !== 'range') return null;
  const [y0, y1] = brushPixels(axis, brush);
  if (y0 > axis.line_bottom || y1 < axis.top) return null;
  const a = axis.scale.fromY(Math.min(Math.max(y0, axis.top), axis.line_bottom));
  const b = axis.scale.fromY(Math.min(Math.max(y1, axis.top), axis.line_bottom));
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * The rows that pass every brush: { mask: Uint8Array, count }, or null when nothing is brushed.
 */
export function selectRows(axes, brushes, n) {
  const active = axes.filter(axis => brushes?.[axis.key]);
  if (!active.length) return null;
  const mask = new Uint8Array(n).fill(1);
  for (const axis of active) {
    const brush = brushes[axis.key];
    if (brush.type === 'set') {
      const names = new Set(brush.names);
      const keep = axis.slots.map(s => names.has(s.name));
      for (let i = 0; i < n; i++) if (!keep[axis.slot[i]]) mask[i] = 0;
    } else {
      const [y0, y1] = brushPixels(axis, brush);
      const center = axis.center;
      for (let i = 0; i < n; i++) if (center[i] < y0 - 0.5 || center[i] > y1 + 0.5) mask[i] = 0;
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += mask[i];
  return { mask, count };
}

// --- Curves and hit testing -------------------------------------------------------------------------------------

// Between two axes a line is a cubic Bézier from (x0, y0) to (x1, y1), with control points (x0 + c w, y0) and
// (x1 - c w, y1): it leaves and reaches the axes horizontally. With u the fraction of the way between the axes:
//   u(t) = 3 c t (1-t)^2 + 3 (1-c) t^2 (1-t) + t^3      y(t) = y0 + (y1 - y0) (3 t^2 - 2 t^3)

/** Where the curve is at the fraction `u` of the way between two axes: { s, slope } with y = y0 + (y1 - y0) s and
 *  dy/dx = (y1 - y0) / (x1 - x0) * slope */
export function curveAt(u, c = GEOMETRY.curve) {
  if (u <= 0) return { s: 0, slope: 0 };
  if (u >= 1) return { s: 1, slope: 0 };
  const x = t => 3 * c * t * (1 - t) ** 2 + 3 * (1 - c) * t * t * (1 - t) + t ** 3;
  let lo = 0, hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (x(mid) < u) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  const du = 3 * c * ((1 - t) ** 2 - 2 * t * (1 - t)) + 3 * (1 - c) * (2 * t * (1 - t) - t * t) + 3 * t * t;
  return { s: 3 * t * t - 2 * t ** 3, slope: du > 1e-9 ? 6 * t * (1 - t) / du : 0 };
}

/** The y of row i's line at x */
export function lineY(axes, i, x, c = GEOMETRY.curve) {
  if (x <= axes[0].x) return axes[0].pos[i];
  for (let j = 0; j < axes.length - 1; j++) {
    if (x <= axes[j + 1].x) {
      const { s } = curveAt((x - axes[j].x) / (axes[j + 1].x - axes[j].x), c);
      return axes[j].pos[i] + (axes[j + 1].pos[i] - axes[j].pos[i]) * s;
    }
  }
  return axes[axes.length - 1].pos[i];
}

/**
 * The row whose line is the closest to (x, y), anywhere along the curves: { row, distance }, or null when none is
 * within `tolerance` pixels. With a `mask`, only among its rows.
 */
export function nearestRow(axes, x, y, { mask = null, tolerance = 6, curve = GEOMETRY.curve } = {}) {
  if (axes.length < 2) return null;
  const first = axes[0], last = axes[axes.length - 1];
  if (x < first.x - tolerance || x > last.x + tolerance) return null;
  let j = 0;
  while (j < axes.length - 2 && x > axes[j + 1].x) j++;
  const a = axes[j], b = axes[j + 1];
  const width = b.x - a.x;
  const { s, slope } = curveAt((x - a.x) / width, curve);
  const pa = a.pos, pb = b.pos;
  const n = pa.length;
  let best = -1, best_distance = Infinity;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const dy = pb[i] - pa[i];
    const line_y = pa[i] + dy * s;
    // the distance to the curve, from the vertical distance and the curve's slope there
    const k = dy / width * slope;
    const distance = Math.abs(line_y - y) / Math.sqrt(1 + k * k);
    if (distance < best_distance) { best_distance = distance; best = i; }
  }
  return best >= 0 && best_distance <= tolerance ? { row: best, distance: best_distance } : null;
}

/** The rows in a slot of an axis */
export function slotRows(axis, slot_index, mask = null) {
  const rows = [];
  const slot = axis.slot;
  for (let i = 0; i < slot.length; i++) if (slot[i] === slot_index && (!mask || mask[i])) rows.push(i);
  return rows;
}

// --- Columns' order and visibility ------------------------------------------------------------------------------

/** The columns in the user's order: those they moved where they put them, the new ones where the caller has them */
export function orderColumns(columns, order) {
  if (!order?.length) return columns;
  const rank = new Map(order.map((key, i) => [key, i]));
  const known = columns.filter(c => rank.has(c.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key));
  let k = 0;
  return columns.map(c => rank.has(c.key) ? known[k++] : c);
}

/** Moves a key before the one at `index` of `keys` (or to the end) */
export function moveKey(keys, key, index) {
  const from = keys.indexOf(key);
  if (from < 0) return keys;
  const next = keys.filter(k => k !== key);
  next.splice(index > from ? index - 1 : index, 0, key);
  return next;
}

/** How opaque and thick the lines are: fewer rows, stronger lines */
export function lineStyle(n) {
  return {
    // like 1/sqrt(n), then faster: thousands of lines would fill the plot
    alpha: n <= 1000 ? Math.min(0.85, 4.5 / Math.sqrt(Math.max(1, n))) : 0.142 * (1000 / n) ** 0.75,
    width: n <= 60 ? 1.6 : n <= 600 ? 1.2 : 1,
  };
}

/**
 * A label that fits in about `max` characters. Parameters are often paths (`denoise.luma.strength`) that differ by
 * their end: those keep their end. The others are left to the CSS, that cuts their end.
 */
export function shortLabel(label, max) {
  const s = String(label);
  if (s.length <= max || max < 4) return s;
  if (!/[./]/.test(s) || /\s/.test(s)) return s;
  let tail = s.slice(s.length - (max - 1));
  const cut = tail.search(/[./]/);
  if (cut >= 0 && cut < tail.length / 2) tail = tail.slice(cut + 1);
  return `…${tail}`;
}
