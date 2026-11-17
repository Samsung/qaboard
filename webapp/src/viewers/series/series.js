// The values a run logged while it ran (a training's loss at each step...), from the files of its folder:
// - series.json: at most ~1000 points per series, written by the Python SDK for us (qaboard/series.py),
// - series.jsonl: everything, one line per log() call. Programs in any language can write it; we read it when there is
//   no series.json, and keep the same number of points, the same way.
// Both give the same model, like in Python: both are tested on tests/fixtures/series/. Change one, change the other.
//
//   { started_at, updated_at?, series: { [key]: { points, step: [], time: [], value: [], min?: [], max?: [] } } }
// `time` is in seconds since started_at; `value` is null where a point is NaN or infinite.

export const FORMAT = 'qaboard-series';
export const MAX_POINTS = 500;
const STEP = '_step';
const TIME = '_time';
const NON_FINITE = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };

// series.json, results/series.jsonl, train.series.json... Other names need `type: series`
export const is_series = path => /(^|\/)([^/]*[._-])?series\.(json|jsonl|ndjson)$/i.test(path || '');

const round = value => Number(value.toPrecision(6));
const round_time = value => Math.round(value * 1000) / 1000;

// A series with a bounded number of points: buckets of `stride` consecutive values (qaboard/series.py:Downsampled)
class Downsampled {
  constructor(max_points = MAX_POINTS) {
    this.max_points = Math.max(2, max_points);
    this.stride = 1;
    this.points = 0;
    // [last step, last time, sum of the finite values, how many are finite, min, max, how many values]
    this.buckets = [];
  }
  add(step, value, time) {
    this.points += 1;
    const finite = Number.isFinite(value);
    const bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket[6] >= this.stride) {
      this.buckets.push([step, time, finite ? value : 0, finite ? 1 : 0, finite ? value : null, finite ? value : null, 1]);
      if (this.buckets.length > 2 * this.max_points) this.halve();
      return;
    }
    bucket[0] = step;
    bucket[1] = time;
    bucket[6] += 1;
    if (finite) {
      bucket[2] += value;
      bucket[3] += 1;
      bucket[4] = bucket[4] === null ? value : Math.min(bucket[4], value);
      bucket[5] = bucket[5] === null ? value : Math.max(bucket[5], value);
    }
  }
  halve() {
    const merged = [];
    for (let i = 0; i < this.buckets.length - 1; i += 2) {
      const a = this.buckets[i], b = this.buckets[i + 1];
      const lows = [a[4], b[4]].filter(v => v !== null);
      const highs = [a[5], b[5]].filter(v => v !== null);
      merged.push([b[0], b[1], a[2] + b[2], a[3] + b[3], lows.length ? Math.min(...lows) : null, highs.length ? Math.max(...highs) : null, a[6] + b[6]]);
    }
    if (this.buckets.length % 2) merged.push(this.buckets[this.buckets.length - 1]);
    this.buckets = merged;
    this.stride *= 2;
  }
  to_object(started_at) {
    const series = {
      points: this.points,
      step: this.buckets.map(b => b[0]),
      time: this.buckets.map(b => round_time(b[1] - started_at)),
      value: this.buckets.map(b => b[3] ? round(b[2] / b[3]) : null),
    };
    if (this.stride > 1) {
      series.min = this.buckets.map(b => b[4] !== null ? round(b[4]) : null);
      series.max = this.buckets.map(b => b[5] !== null ? round(b[5]) : null);
    }
    return series;
  }
}

const decode = value => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value in NON_FINITE) return NON_FINITE[value];
  return undefined;
};

// The lines of a series.jsonl. Lines that aren't objects are skipped, like a last line cut by a run that was killed
const parse_history = (text, max_points) => {
  const series = {};
  let started_at = null;
  let step = -1;
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    rows += 1;
    step = Number.isInteger(row[STEP]) ? row[STEP] : step + 1;
    const time = typeof row[TIME] === 'number' ? row[TIME] : 0;
    if (started_at === null) started_at = time;
    for (const [key, raw] of Object.entries(row)) {
      if (key === STEP || key === TIME) continue;
      const value = decode(raw);
      if (value === undefined) continue;
      (series[key] ??= new Downsampled(max_points)).add(step, value, time);
    }
  }
  if (rows === 0) throw new Error('no line is a JSON object');
  // e.g. another program's series.json: an object, but not lines of values
  if (Object.keys(series).length === 0) throw new Error('no line has a number');
  return {
    started_at: round_time(started_at ?? 0),
    series: Object.fromEntries(Object.entries(series).map(([key, s]) => [key, s.to_object(started_at ?? 0)])),
  };
};

const is_array = (value, length) => Array.isArray(value) && (length === undefined || value.length === length);

const parse_summary = data => {
  if (data.format !== FORMAT) throw new Error(`not a ${FORMAT} file`);
  if (data.series === null || typeof data.series !== 'object' || Array.isArray(data.series)) throw new Error('no series');
  const series = {};
  for (const [key, s] of Object.entries(data.series)) {
    if (!s || !is_array(s.step) || !is_array(s.value, s.step.length)) continue;
    series[key] = {
      points: Number.isFinite(s.points) ? s.points : s.step.length,
      step: s.step,
      time: is_array(s.time, s.step.length) ? s.time : s.step.map(() => 0),
      value: s.value,
      ...(is_array(s.min, s.step.length) && is_array(s.max, s.step.length) ? { min: s.min, max: s.max } : {}),
    };
  }
  return {
    started_at: Number.isFinite(data.started_at) ? data.started_at : 0,
    ...(Number.isFinite(data.updated_at) ? { updated_at: data.updated_at } : {}),
    series,
  };
};

// The content of a series.json or a series.jsonl -> the model above. Throws when it is neither.
export const parse_series = (content, { max_points = MAX_POINTS } = {}) => {
  if (content !== null && typeof content === 'object') return parse_summary(content);
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty file');
  // series.json is one JSON object on one line... like the only line of a short series.jsonl: the format says which
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    // several lines
  }
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && data.format !== undefined)
    return parse_summary(data);
  return parse_history(content, max_points);
};

// Exponential moving average, like TensorBoard's smoothing: `weight` in [0, 1), 0 doesn't smooth. Debiased, so the
// first values aren't pulled to zero; null values (NaN) stay null and don't count.
export const smooth = (values, weight) => {
  if (!(weight > 0)) return values;
  let last = 0;
  let count = 0;
  return values.map(value => {
    if (value === null || !Number.isFinite(value)) return null;
    last = last * weight + (1 - weight) * value;
    count += 1;
    return last / (1 - weight ** count);
  });
};

// Series are grouped by what comes before their first "/": train/loss and train/accuracy, then val/loss...
// Those without a "/" come first.
export const sorted_keys = keys => [...keys].sort((a, b) => {
  const ga = a.includes('/') ? a.split('/')[0] : '';
  const gb = b.includes('/') ? b.split('/')[0] : '';
  return ga === gb ? a.localeCompare(b) : ga.localeCompare(gb);
});

// 3725 -> "1h 02m"
export const format_duration = seconds => {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
};
