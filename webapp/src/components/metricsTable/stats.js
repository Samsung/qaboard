// The numbers of the metrics tables' column summaries, and how their cells format values.
// Tables can have 5,000 runs and 30 metrics: each column's numbers are computed once for the same runs (column_stats).
import { is_number, diff_cell } from "../../utils/compare";


// The numbers among values, sorted. Typed arrays sort numbers natively: much faster than with a comparator.
const sorted_numbers = (values, map) => {
  const numbers = new Float64Array(values.length);
  let n = 0;
  for (const value of values)
    if (is_number(value)) numbers[n++] = map ? map(value) : value;
  return numbers.subarray(0, n).sort();
};
const median_of_sorted = sorted => {
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Whether a value meets the metric's target, like the Summary (pass_rate in utils/compare.js).
// null without a target, or when we don't know which way is better.
export const target_check = metric => {
  if (!is_number(metric.target) || metric.smaller_is_better === null || metric.smaller_is_better === undefined)
    return null;
  return metric.smaller_is_better ? value => value <= metric.target : value => value >= metric.target;
};

const bins_count = 12;

// A column's distribution: { count, missing, min, max, median, bins, met }. Values are as runs logged them, not scaled.
//   bins: how many values fall in each of `bins_count` equal ranges from min to max (one bin when they're all the same)
//   met: how many runs meet the target, null without one
export const distribution = (values, metric) => {
  const numbers = sorted_numbers(values);
  const missing = values.length - numbers.length;
  if (numbers.length === 0) return { count: 0, missing, min: null, max: null, median: null, bins: [], met: null };
  const min = numbers[0];
  const max = numbers[numbers.length - 1];
  const bins = Array.from({ length: min === max ? 1 : bins_count }, () => 0);
  const width = (max - min) / bins.length;
  for (const value of numbers)
    bins[width > 0 ? Math.min(bins.length - 1, Math.floor((value - min) / width)) : 0]++;
  const meets = target_check(metric);
  let met = 0;
  if (meets) for (const value of numbers) if (meets(value)) met++;
  return {
    count: numbers.length,
    missing,
    min,
    max,
    median: median_of_sorted(numbers),
    bins,
    met: meets ? met : null,
  };
};

// How runs changed vs their reference run: { better, worse, changed, unchanged, missing, median_change }.
// better and worse are null when we don't know which way is better: then only `changed` counts.
// A change is any difference, like the cells, that show "=" only for the same value.
// values, values_ref: the runs' values, and their reference runs', in the same order
export const changes = (values, values_ref, metric) => {
  const known = metric.smaller_is_better !== null && metric.smaller_is_better !== undefined;
  let better = 0, worse = 0, changed = 0, unchanged = 0, missing = 0;
  const relative = new Float64Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const value_ref = values_ref[i];
    if (value === undefined || value === null || value_ref === undefined || value_ref === null) {
      missing++;
      continue;
    }
    if (is_number(value) && is_number(value_ref)) {
      const { delta, delta_relative } = diff_cell(value, value_ref);
      if (delta === 0) { unchanged++; relative[n++] = 0; continue; }
      changed++;
      relative[n++] = delta_relative;
      if (known && (metric.smaller_is_better ? delta < 0 : delta > 0)) better++;
      else if (known) worse++;
    } else if (JSON.stringify(value) === JSON.stringify(value_ref)) {
      unchanged++;
    } else {
      // e.g. badges: they changed, we can't say if for the better
      changed++;
    }
  }
  return {
    better: known ? better : null,
    worse: known ? worse : null,
    changed,
    unchanged,
    missing,
    median_change: median_of_sorted(relative.subarray(0, n).sort()),
  };
};


// Each column's summary, once per runs, reference and metric definition: switching metrics only computes the new ones.
// outputs: the table's [id, output], ref_batch: where their reference runs are (output.reference_id)
const caches = new WeakMap();
const no_reference = {};
const table_cache = (outputs, ref_batch) => {
  let by_ref = caches.get(outputs);
  if (!by_ref) caches.set(outputs, by_ref = new WeakMap());
  const key = ref_batch ?? no_reference;
  if (!by_ref.has(key)) by_ref.set(key, {
    // looked up once for all the columns
    refs: outputs.map(([, o]) => ref_batch?.outputs?.[o.reference_id]),
    kpi: new WeakMap(),
    diff: new WeakMap(),
  });
  return by_ref.get(key);
};
const cached = (by_metric, metric, compute) => {
  if (!by_metric.has(metric)) by_metric.set(metric, compute());
  return by_metric.get(metric);
};
// a column's values, and the reference runs'
const column = (outputs, refs, key) => ({
  values: outputs.map(([, o]) => o.metrics?.[key]),
  values_ref: refs.map(o => o?.metrics?.[key]),
});

// The Metrics Table's: the distributions of the new runs' values, and of their reference runs'
export const kpi_column_stats = (outputs, ref_batch, metric) => {
  const table = table_cache(outputs, ref_batch);
  return cached(table.kpi, metric, () => {
    const { values, values_ref } = column(outputs, table.refs, metric.key);
    return {
      new: distribution(values, metric),
      ref: distribution(values_ref, metric),
      // the new runs' typical value: the reference's is close
      decimals: column_decimals(values, metric) ?? column_decimals(values_ref, metric),
    };
  });
};

// The Metrics Diff's: how the runs changed
export const diff_column_stats = (outputs, ref_batch, metric) => {
  const table = table_cache(outputs, ref_batch);
  return cached(table.diff, metric, () => {
    const { values, values_ref } = column(outputs, table.refs, metric.key);
    return { changes: changes(values, values_ref, metric) };
  });
};

// Whether any of the metrics changed between the run and its reference run, for "Only runs that changed"
export const has_changes = (output, output_ref, metrics) => metrics.some(m => {
  const value = output.metrics?.[m.key];
  const value_ref = output_ref?.metrics?.[m.key];
  if (value === undefined || value === null || value_ref === undefined || value_ref === null) return false;
  return is_number(value) && is_number(value_ref) ? value !== value_ref : JSON.stringify(value) !== JSON.stringify(value_ref);
});


// How many decimals a column's numbers get, so that they line up: the metric's significant digits (3 by default) for
// its typical value, none when they're all integers. null when it has no numbers.
export const column_decimals = (values, metric) => {
  const scale = metric.scale ?? 1;
  const magnitudes = sorted_numbers(values, v => Math.abs(v * scale));
  if (magnitudes.length === 0) return null;
  if (magnitudes.every(Number.isInteger)) return 0;
  let zeros = 0;
  while (magnitudes[zeros] === 0) zeros++;
  const typical = median_of_sorted(magnitudes.subarray(zeros));
  return Math.max(0, Math.min(6, (metric.precision ?? 3) - 1 - Math.floor(Math.log10(typical))));
};

// A value with the column's decimals, e.g. "1.20" next to "1.44". Values this would round to 0, or huge ones,
// keep their significant digits with `fallback`, e.g. "4e-5".
export const format_fixed = (value, decimals, fallback) => {
  if (decimals === null || decimals === undefined || !Number.isFinite(value)) return fallback(value);
  const abs = Math.abs(value);
  if ((abs > 0 && abs < 10 ** -decimals) || abs >= 1e12) return fallback(value);
  const text = value.toFixed(decimals);
  // not "-0.00"
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
};


// Tab-separated values, as spreadsheets paste them: cells can't have tabs or line breaks
const tsv_cell = value => value === undefined || value === null ? '' : String(value).replace(/[\t\r\n]+/g, ' ');
export const to_tsv = rows => rows.map(row => row.map(tsv_cell).join('\t')).join('\n');

// Without floating-point noise, e.g. 0.5 not 0.5000000000000036
export const clean_number = value => Number(value.toPrecision(12));

// A value for spreadsheets: numbers in full, with the metric's scale, badges by their text
export const raw_value = (value, metric) => {
  if (value === undefined || value === null) return '';
  if (is_number(value)) return clean_number(value * (metric.scale ?? 1));
  if (typeof value === 'object') return value.text ?? JSON.stringify(value);
  return value;
};
