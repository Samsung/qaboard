// The benchmarks of a run against the reference run's: matched by name, each classified as slower, faster, within
// noise, new or missing; sorted, filtered, grouped for the viewer's table.
import { shortName } from './parse';

// Within noise: when the change is no larger than the spread the files report. The spread is the standard
// deviation, or when the harness doesn't report one its IQR, median absolute deviation or error margin.
// QA-Board doesn't compute it: it's what the harness measured.
export const SPREADS = [
  ['stddev', 'standard deviation', 'σ'],
  ['iqr', 'interquartile range', 'IQR'],
  ['mad', 'median absolute deviation', 'MAD'],
  ['error', 'error margin', 'error'],
];

export const spreadOf = benchmark => {
  if (!benchmark?.stats) return null;
  for (const [key, label, short] of SPREADS) {
    const value = benchmark.stats[key];
    if (typeof value === 'number' && Number.isFinite(value)) return { key, label, short, value };
  }
  return null;
};

export const NOISE_RULE = 'A change is within noise when it is no larger than the larger of the two spreads the files report: '
  + 'their standard deviation, else their IQR, median absolute deviation or error margin. '
  + 'Without a spread in either file, any change counts.';

export const STATUSES = {
  slower: { label: 'slower', intent: 'danger' },
  faster: { label: 'faster', intent: 'success' },
  noise: { label: 'within noise', intent: 'none' },
  same: { label: 'unchanged', intent: 'none' },
  added: { label: 'new', intent: 'primary' },
  missing: { label: 'missing', intent: 'warning' },
  unit: { label: 'unit changed', intent: 'warning' },
};
export const STATUS_ORDER = ['slower', 'faster', 'noise', 'same', 'added', 'missing', 'unit'];
export const CHANGED = new Set(['slower', 'faster', 'added', 'missing', 'unit']);

// One benchmark against its reference
export function classify(benchmark, ref) {
  if (!ref) return { status: 'added', delta: null, ratio: null, noise: null };
  if (!benchmark) return { status: 'missing', delta: null, ratio: null, noise: null };
  if (benchmark.unit !== ref.unit) return { status: 'unit', delta: null, ratio: null, noise: null };
  const delta = benchmark.value - ref.value;
  const ratio = ref.value !== 0 ? benchmark.value / ref.value : null;
  const spreads = [spreadOf(benchmark), spreadOf(ref)].filter(s => s);
  const noise = spreads.length ? Math.max(...spreads.map(s => s.value)) : null;
  let status;
  if (delta === 0) status = 'same';
  else if (noise !== null && Math.abs(delta) <= noise) status = 'noise';
  else status = (delta > 0) === (benchmark.smaller_is_better !== false) ? 'slower' : 'faster';
  return { status, delta, ratio, noise };
}

// How much worse, as a fraction: +0.1 is 10% slower (or 10% less throughput), whatever the direction of better
export const badness = row => {
  if (row.ratio === null || row.ratio === undefined) return null;
  return row.benchmark.smaller_is_better === false ? (row.ratio > 0 ? 1 / row.ratio - 1 : null) : row.ratio - 1;
};

// The rows of the table: the run's benchmarks in the order of the file, then those only in the reference
export function compareBenchmarks(benchmarks, ref_benchmarks) {
  const refs = ref_benchmarks ? new Map(ref_benchmarks.map(b => [b.name, b])) : null;
  const rows = benchmarks.map((benchmark, index) => {
    const ref = refs?.get(benchmark.name) ?? null;
    const row = { key: benchmark.name, index, benchmark, ref, group: benchmark.group ?? '', short: shortName(benchmark), ...(refs ? classify(benchmark, ref) : { status: null, delta: null, ratio: null, noise: null }) };
    row.change = badness(row);
    return row;
  });
  if (refs) {
    const names = new Set(benchmarks.map(b => b.name));
    for (const ref of ref_benchmarks) {
      if (names.has(ref.name)) continue;
      rows.push({ key: ref.name, index: rows.length, benchmark: null, ref, group: ref.group ?? '', short: shortName(ref), ...classify(null, ref), change: null });
    }
  }
  return rows;
}

export function summarize(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  let log_sum = 0;
  let compared = 0;
  for (const row of rows) {
    if (row.status) counts[row.status] += 1;
    // the geometric mean of the ratios, the usual summary of a suite: each benchmark weighs the same
    const change = row.change;
    if (change !== null && change > -1) {
      log_sum += Math.log(1 + change);
      compared += 1;
    }
  }
  return { total: rows.length, counts, compared, geomean: compared ? Math.exp(log_sum / compared) - 1 : null };
}

export const SORTS = [
  { value: 'regressions', label: 'Biggest regressions first', needs_reference: true },
  { value: 'improvements', label: 'Biggest improvements first', needs_reference: true },
  { value: 'name', label: 'Name' },
  { value: 'time', label: 'Slowest first' },
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const by_name = (a, b) => collator.compare(a.key, b.key);
// slower first, then missing and new, then the rest, the most changed first
const regression_rank = row => row.status === 'slower' ? 0 : row.status === 'missing' ? 1 : row.status === 'added' ? 2 : row.status === 'unit' ? 3 : 4;
const improvement_rank = row => row.status === 'faster' ? 0 : row.status === 'added' ? 1 : row.status === 'missing' ? 2 : 3;
const value_of = row => (row.benchmark ?? row.ref).value;

export function sortRows(rows, sort) {
  const sorted = [...rows];
  if (sort === 'regressions')
    sorted.sort((a, b) => regression_rank(a) - regression_rank(b) || (b.change ?? -Infinity) - (a.change ?? -Infinity) || a.index - b.index);
  else if (sort === 'improvements')
    sorted.sort((a, b) => improvement_rank(a) - improvement_rank(b) || (a.change ?? Infinity) - (b.change ?? Infinity) || a.index - b.index);
  else if (sort === 'time')
    sorted.sort((a, b) => value_of(b) - value_of(a) || a.index - b.index);
  else if (sort === 'name')
    sorted.sort(by_name);
  return sorted;
}

// Every word must match the name, group or parameters; -word leaves out the benchmarks that have it
export function rowFilter({ search = '', only_changed = false, statuses = new Set() }) {
  const words = search.toLowerCase().split(/\s+/).filter(w => w);
  const include = words.filter(w => !w.startsWith('-') || w.length === 1);
  const exclude = words.filter(w => w.startsWith('-') && w.length > 1).map(w => w.slice(1));
  if (!include.length && !exclude.length && !only_changed && !statuses.size) return null;
  return row => {
    if (only_changed && !CHANGED.has(row.status)) return false;
    if (statuses.size && !statuses.has(row.status)) return false;
    if (!include.length && !exclude.length) return true;
    const b = row.benchmark ?? row.ref;
    const text = `${b.name} ${b.group ?? ''} ${Object.entries(b.params ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`.toLowerCase();
    return include.every(w => text.includes(w)) && !exclude.some(w => text.includes(w));
  };
}

// The list the table shows: rows under their group's header, groups in the order of their first row (with the
// default sort, the group with the worst regression first). Without groups, or with a single one, no headers.
export function groupRows(rows, collapsed = new Set()) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  if (groups.size <= 1 && !rows.some(r => r.group)) return rows.map(row => ({ kind: 'benchmark', key: `b:${row.key}`, row }));
  const items = [];
  for (const [group, members] of groups) {
    const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
    for (const m of members) if (m.status) counts[m.status] += 1;
    const open = !collapsed.has(group);
    items.push({ kind: 'group', key: `g:${group}`, group, count: members.length, counts, open });
    if (open) for (const row of members) items.push({ kind: 'benchmark', key: `b:${row.key}`, row, grouped: true });
  }
  return items;
}

// Different CPUs or CPU counts: the numbers aren't comparable. A different host with the same CPU is only a note.
export function contextDifferences(context, ref_context) {
  if (!context || !ref_context) return { warnings: [], notes: [] };
  const warnings = [];
  const notes = [];
  if (context.cpu && ref_context.cpu && context.cpu !== ref_context.cpu) warnings.push(['CPU', context.cpu, ref_context.cpu]);
  if (context.cpu_count && ref_context.cpu_count && context.cpu_count !== ref_context.cpu_count)
    warnings.push(['CPU count', context.cpu_count, ref_context.cpu_count]);
  if (context.machine && ref_context.machine && context.machine !== ref_context.machine)
    (warnings.length || (!context.cpu && !ref_context.cpu) ? warnings : notes).push(['Machine', context.machine, ref_context.machine]);
  return { warnings, notes };
}

const significant = (value, digits = 3) => {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 10 ** digits) return Math.round(value).toLocaleString('en-US');
  return Number(value.toPrecision(digits)).toString();
};

// 1.98e-6 => "1.98 µs"
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const abs = Math.abs(seconds);
  if (abs === 0) return '0 s';
  if (abs < 1e-6) return `${significant(seconds * 1e9)} ns`;
  if (abs < 1e-3) return `${significant(seconds * 1e6)} µs`;
  if (abs < 1) return `${significant(seconds * 1e3)} ms`;
  return `${significant(seconds)} s`;
}

// 1.03e9, "B/s" => "1.03 GB/s"
export function formatAmount(value, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  for (const [limit, prefix] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']]) {
    if (abs >= limit) return `${significant(value / limit)} ${prefix}${unit}`.trim();
  }
  return `${significant(value)} ${unit}`.trim();
}

export const formatValue = (value, unit) => unit === 's' ? formatTime(value) : formatAmount(value, unit);

export function formatPercent(fraction, { sign = true } = {}) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '';
  const pct = fraction * 100;
  const abs = Math.abs(pct);
  const text = abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(abs < 0.1 && abs > 0 ? 2 : 1);
  if (!sign) return `${text}%`;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${text}%`;
}

export const formatCount = n => {
  if (n >= 1e6) return `${significant(n / 1e6)}M`;
  if (n >= 1e4) return `${significant(n / 1e3)}k`;
  return n.toLocaleString('en-US');
};

// The domain of the change bars: most changes beyond noise fit, a few outliers are clipped. Changes within noise
// don't count: when most benchmarks barely moved, the regressions would all be clipped.
export function changeDomain(rows) {
  const changes = rows.filter(r => r.status === 'slower' || r.status === 'faster')
    .map(r => Math.abs(r.change ?? 0)).filter(c => c > 0).sort((a, b) => a - b);
  if (!changes.length) return 0.05;
  const p95 = changes[Math.min(changes.length - 1, Math.floor(changes.length * 0.95))];
  return Math.min(1, Math.max(0.05, p95));
}
