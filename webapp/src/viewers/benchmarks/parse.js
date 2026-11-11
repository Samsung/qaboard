// Reads the files of benchmark harnesses into one model: pytest-benchmark (--benchmark-json), Google Benchmark
// (--benchmark_format=json, --benchmark_out), hyperfine (--export-json), Criterion (cargo criterion
// --message-format=json), JMH (-rf json), `go test -bench` output, and QA-Board's normalized format (*.benchmarks.json,
// qaboard/schemas/benchmarks.schema.json).
//
// The `qa` package reads the same formats into the same model (qaboard/benchmarks.py): both are tested on
// tests/fixtures/benchmarks/, whose *.expected.benchmarks.json are the expected results. Change one, change the other.
//
// A benchmark: {name, group, params, value, unit, statistic, smaller_is_better, stats, throughput}. Times are in
// seconds (unit "s"); `value` is the mean time per iteration (JMH's score, Go's ns/op), files in our format can pick
// another statistic. `stats` has what the file says: mean, median, stddev, min, max, iqr, mad, error, rounds...

export const FORMATS = ['pytest-benchmark', 'google-benchmark', 'hyperfine', 'criterion', 'jmh', 'go', 'qaboard'];
export const VERSION = 1;
export const SCHEMA = 'https://samsung.github.io/qaboard/benchmarks.schema.json';

const TIME_STATS = ['mean', 'median', 'stddev', 'min', 'max', 'iqr', 'mad', 'error'];
export const STATS = [...TIME_STATS, 'rounds', 'iterations', 'samples', 'ops', 'cpu_time', 'bytes_per_op', 'allocs_per_op'];
const COUNT_STATS = ['rounds', 'iterations', 'samples'];
const CONTEXT = ['machine', 'cpu', 'cpu_count', 'os', 'arch', 'date', 'harness'];
// in seconds
export const TIME_UNITS = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ms: 1e-3, s: 1.0 };

class FormatError extends Error {}

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const number = value => isNumber(value) ? value : null;

const makeStats = values => {
  const stats = {};
  for (const [key, value] of Object.entries(values)) {
    if (isNumber(value)) stats[key] = COUNT_STATS.includes(key) ? Math.round(value) : value;
  }
  return stats;
};

const scaled = (stats, factor) => Object.fromEntries(Object.entries(stats)
  .map(([k, v]) => [k, TIME_STATS.includes(k) || k === 'cpu_time' ? v * factor : v]));

const param = value => value === null || typeof value === 'string' || typeof value === 'boolean' || isNumber(value)
  ? value : JSON.stringify(value);
const makeParams = params => params && typeof params === 'object' && !Array.isArray(params)
  ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, param(v)])) : {};

const cleanContext = context => Object.fromEntries(CONTEXT
  .filter(k => context?.[k] !== undefined && context[k] !== null && context[k] !== '')
  .map(k => [k, context[k]]));

const benchmark = ({ name, value, unit = 's', group = null, params = {}, statistic = null, smaller_is_better = true, stats = {}, throughput = null }) =>
  ({ name, value, unit, group, params, statistic, smaller_is_better, stats, throughput });

// Names are unique: the second benchmark called "x" becomes "x #2"
const unique = benchmarks => {
  const seen = new Map();
  for (const b of benchmarks) {
    if (seen.has(b.name)) {
      seen.set(b.name, seen.get(b.name) + 1);
      b.name = `${b.name} #${seen.get(b.name)}`;
    } else seen.set(b.name, 1);
  }
  return benchmarks;
};

const family = (name, separator = '/') => name.includes(separator) ? name.split(separator)[0] : null;

const sum = values => {
  let total = 0;
  for (const v of values) total += v;
  return total;
};
const mean = values => sum(values) / values.length;

function parsePytestBenchmark(data) {
  const machine = data.machine_info || {};
  const cpu = machine.cpu || {};
  const system = ['system', 'release'].filter(k => machine[k]).map(k => String(machine[k])).join(' ');
  const context = {
    machine: machine.node,
    cpu: cpu.brand_raw || cpu.brand,
    cpu_count: cpu.count,
    os: system || null,
    arch: machine.machine,
    date: data.datetime,
    harness: data.version ? `pytest-benchmark ${data.version}` : 'pytest-benchmark',
  };
  const benchmarks = [];
  for (const b of data.benchmarks || []) {
    const stats = b.stats || {};
    if (!isNumber(stats.mean)) continue;
    const name = b.fullname || b.name;
    benchmarks.push(benchmark({
      name,
      group: b.group || (name.includes('::') ? name.split('::')[0] : null),
      params: makeParams(b.params),
      value: stats.mean,
      statistic: 'mean',
      stats: makeStats({
        mean: stats.mean, median: stats.median, stddev: stats.stddev, min: stats.min, max: stats.max, iqr: stats.iqr,
        rounds: stats.rounds, iterations: stats.iterations, ops: stats.ops,
      }),
    }));
  }
  return { source: 'pytest-benchmark', context, benchmarks };
}

// BM_Route/size:1024/threads:4 => {size: "1024", threads: "4"}. Unnamed arguments stay in the name.
const googleParams = name => {
  const params = {};
  for (const part of name.split('/').slice(1)) {
    const at = part.indexOf(':');
    if (at >= 0) params[part.slice(0, at)] = part.slice(at + 1);
  }
  return params;
};

function parseGoogleBenchmark(data) {
  const info = data.context || {};
  const context = {
    machine: info.host_name,
    cpu_count: info.num_cpus,
    date: info.date,
    harness: info.library_version ? `Google Benchmark ${info.library_version}` : 'Google Benchmark',
  };
  // Rows are grouped by run_name: the iterations' rows, then with --benchmark_repetitions their aggregates
  const runs = new Map();
  for (const row of data.benchmarks || []) {
    if (row.error_occurred) continue;
    const name = row.run_name || row.name;
    if (!runs.has(name)) runs.set(name, { iterations: [], aggregates: {} });
    const run = runs.get(name);
    if (row.run_type === 'aggregate') {
      // BigO and RMS fit a complexity over the family's sizes: not a time per iteration. cv is a percentage.
      if ((row.aggregate_unit ?? 'time') === 'time' && !['BigO', 'RMS'].includes(row.aggregate_name) && !(row.aggregate_name in run.aggregates))
        run.aggregates[row.aggregate_name] = row;
    } else run.iterations.push(row);
  }
  const benchmarks = [];
  for (const [name, { aggregates, iterations }] of runs) {
    const main = aggregates.mean || iterations[0];
    if (!main || !isNumber(main.real_time)) continue;
    const factor = TIME_UNITS[main.time_unit ?? 'ns'] ?? 1e-9;
    const stats = scaled(makeStats({
      mean: main.real_time,
      median: aggregates.median?.real_time,
      stddev: aggregates.stddev?.real_time,
      min: aggregates.min?.real_time,
      max: aggregates.max?.real_time,
      cpu_time: main.cpu_time,
    }), factor);
    if (aggregates.mean) stats.rounds = Math.trunc(main.repetitions || iterations.length);
    if (iterations.length && isNumber(iterations[0].iterations)) stats.iterations = Math.trunc(iterations[0].iterations);
    let throughput = null;
    for (const [key, unit] of [['bytes_per_second', 'B/s'], ['items_per_second', 'items/s']]) {
      if (isNumber(main[key])) { throughput = { value: main[key], unit }; break; }
    }
    benchmarks.push(benchmark({
      name, group: family(name), params: googleParams(name), value: stats.mean, statistic: 'mean', stats, throughput,
    }));
  }
  return { source: 'google-benchmark', context, benchmarks };
}

function parseHyperfine(data) {
  const benchmarks = [];
  for (const result of data.results || []) {
    if (!isNumber(result.mean)) continue;
    benchmarks.push(benchmark({
      name: String(result.command),
      params: makeParams(result.parameters),
      value: result.mean,
      statistic: 'mean',
      stats: makeStats({
        mean: result.mean, median: result.median, stddev: result.stddev, min: result.min, max: result.max,
        rounds: Array.isArray(result.times) ? result.times.length : null,
      }),
    }));
  }
  return { source: 'hyperfine', context: { harness: 'hyperfine' }, benchmarks };
}

const CRITERION_THROUGHPUT = { bytes: 'B/s', bytes_decimal: 'B/s', elements: 'elements/s' };
const criterionThroughput = (per_iteration, unit, mean_s) => {
  if (!isNumber(per_iteration) || !mean_s || !(unit in CRITERION_THROUGHPUT)) return null;
  return { value: per_iteration / mean_s, unit: CRITERION_THROUGHPUT[unit] };
};

// `cargo criterion --message-format=json`: one JSON message per line
function parseCriterionMessages(messages) {
  const benchmarks = [];
  for (const message of messages) {
    if (message?.reason !== 'benchmark-complete') continue;
    const m = message.mean || {};
    if (!isNumber(m.estimate)) continue;
    const unit = m.unit || message.unit || 'ns';
    const factor = TIME_UNITS[unit] ?? null;
    const counts = message.iteration_count;
    let stats = makeStats({ mean: m.estimate, median: message.median?.estimate, mad: message.median_abs_dev?.estimate });
    if (factor !== null) stats = scaled(stats, factor);
    if (Array.isArray(counts)) Object.assign(stats, makeStats({ samples: counts.length, iterations: sum(counts.filter(isNumber)) }));
    let throughput = null;
    for (const t of message.throughput || []) {
      throughput = criterionThroughput(t.per_iteration, t.unit, factor ? stats.mean : 0);
      if (throughput) break;
    }
    const name = String(message.id);
    benchmarks.push(benchmark({
      name, group: family(name), value: stats.mean, unit: factor !== null ? 's' : unit, statistic: 'mean', stats, throughput,
    }));
  }
  return { source: 'criterion', context: { harness: 'Criterion' }, benchmarks };
}

const JMH_TIME = /^(ns|us|µs|ms|s)\/op$/;
const JMH_RATE = /^ops\/(ns|us|µs|ms|s|min)$/;

function parseJmh(data) {
  const baseName = entry => {
    const params = entry.params || {};
    const keys = Object.keys(params);
    return `${entry.benchmark}${keys.length ? `[${keys.map(k => `${k}=${params[k]}`).join(',')}]` : ''}`;
  };
  // a benchmark run in several modes (-bm avgt,thrpt) has one entry per mode
  const counts = new Map();
  for (const entry of data) counts.set(baseName(entry), (counts.get(baseName(entry)) ?? 0) + 1);
  const benchmarks = [];
  let context = null;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const metric = entry.primaryMetric || {};
    const score = number(metric.score);
    if (score === null) continue;
    if (!context) {
      const vm = ['vmName', 'jdkVersion'].filter(k => entry[k]).map(k => String(entry[k])).join(' ');
      context = { harness: [entry.jmhVersion ? `JMH ${entry.jmhVersion}` : 'JMH', vm ? `(${vm})` : ''].filter(x => x).join(' ') };
    }
    const unit_text = metric.scoreUnit || '';
    const percentiles = metric.scorePercentiles || {};
    const raw = metric.rawData || [];
    let stats = makeStats({
      mean: score, error: metric.scoreError, median: percentiles['50.0'], min: percentiles['0.0'], max: percentiles['100.0'],
      samples: sum(raw.filter(r => Array.isArray(r)).map(r => r.length)) || null,
      rounds: isNumber(entry.measurementIterations) ? (entry.forks || 1) * entry.measurementIterations : null,
    });
    const time = JMH_TIME.exec(unit_text);
    const rate = JMH_RATE.exec(unit_text);
    let unit, smaller_is_better;
    if (time) {
      [unit, smaller_is_better] = ['s', true];
      stats = scaled(stats, TIME_UNITS[time[1]]);
    } else if (rate) {
      // operations per second, whatever the file's unit
      [unit, smaller_is_better] = ['ops/s', false];
      const per = rate[1] === 'min' ? 60.0 : TIME_UNITS[rate[1]];
      stats = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, TIME_STATS.includes(k) ? v / per : v]));
    } else {
      [unit, smaller_is_better] = [unit_text, !['avgt', 'sample', 'ss'].includes(entry.mode)];
    }
    let name = baseName(entry);
    if (counts.get(name) > 1 && entry.mode) name = `${name} (${entry.mode})`;
    const bench = String(entry.benchmark);
    benchmarks.push(benchmark({
      name, group: bench.includes('.') ? bench.slice(0, bench.lastIndexOf('.')) : null, params: makeParams(entry.params),
      value: stats.mean, unit, statistic: 'mean', smaller_is_better, stats,
    }));
  }
  return { source: 'jmh', context: context ?? {}, benchmarks };
}

const GO_LINE = /^(Benchmark\S+?)(?:-(\d+))?\s+(\d+)\s+(.+)$/;
const GO_HEADER = /^(goos|goarch|pkg|cpu):\s*(.+)$/;

// `go test -bench`: with -count=N each benchmark has N lines, we show their mean and standard deviation
function parseGo(text) {
  const context = { harness: 'go test' };
  const runs = new Map();
  let pkg = null;
  for (const raw_line of text.split(/\r?\n/)) {
    const line = raw_line.trim();
    const header = GO_HEADER.exec(line);
    if (header) {
      const [, key, value] = header;
      if (key === 'pkg') pkg = value;
      else {
        const field = { goos: 'os', goarch: 'arch', cpu: 'cpu' }[key];
        if (!(field in context)) context[field] = value;
      }
      continue;
    }
    const match = GO_LINE.exec(line);
    if (!match) continue;
    const [, bench, procs, iterations, rest] = match;
    const tokens = rest.split(/\s+/);
    const values = {};
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const value = tokens[i] === '' ? NaN : Number(tokens[i]);
      if (Number.isNaN(value)) break;
      values[tokens[i + 1]] = value;
    }
    if (!('ns/op' in values)) continue;
    if (procs && !('cpu_count' in context)) context.cpu_count = parseInt(procs, 10);
    const name = pkg ? `${pkg}.${bench}` : bench;
    if (!runs.has(name)) runs.set(name, { group: pkg, rows: [] });
    runs.get(name).rows.push({ iterations: parseInt(iterations, 10), ...values });
  }
  const benchmarks = [];
  for (const [name, { group, rows }] of runs) {
    const times = rows.map(r => r['ns/op'] * 1e-9);
    const m = mean(times);
    const stats = { mean: m };
    if (rows.length > 1) {
      stats.stddev = Math.sqrt(sum(times.map(t => (t - m) ** 2)) / (times.length - 1));
      stats.min = Math.min(...times);
      stats.max = Math.max(...times);
      stats.rounds = rows.length;
    } else stats.iterations = rows[0].iterations;
    for (const [unit, key] of [['B/op', 'bytes_per_op'], ['allocs/op', 'allocs_per_op']]) {
      if (rows.every(r => unit in r)) stats[key] = mean(rows.map(r => r[unit]));
    }
    const throughput = rows.every(r => 'MB/s' in r) ? { value: mean(rows.map(r => r['MB/s'])) * 1e6, unit: 'B/s' } : null;
    benchmarks.push(benchmark({ name, group, value: m, statistic: 'mean', stats, throughput }));
  }
  return { source: 'go', context, benchmarks };
}

// Our format: times in any of ns, us, ms, s are converted to seconds
function parseNormalized(data) {
  if (data.qaboard_benchmarks !== VERSION)
    throw new FormatError(`unsupported version of the benchmarks format: ${JSON.stringify(data.qaboard_benchmarks)}`);
  const benchmarks = (data.benchmarks || []).map((b, i) => {
    if (!b || typeof b !== 'object' || typeof b.name !== 'string' || !isNumber(b.value))
      throw new FormatError(`benchmarks[${i}]: needs a name and a numeric value`);
    let unit = b.unit || 's';
    const factor = TIME_UNITS[unit] ?? null;
    let stats = makeStats(Object.fromEntries(Object.entries(b.stats || {}).filter(([k]) => STATS.includes(k))));
    let value = b.value;
    if (factor !== null) [stats, value, unit] = [scaled(stats, factor), value * factor, 's'];
    const throughput = b.throughput && typeof b.throughput === 'object' && isNumber(b.throughput.value) ? b.throughput : null;
    return benchmark({
      name: b.name, group: b.group ?? null, params: makeParams(b.params), value, unit, statistic: b.statistic ?? null,
      smaller_is_better: b.smaller_is_better !== false, stats, throughput,
    });
  });
  const context = data.context && typeof data.context === 'object' && !Array.isArray(data.context) ? data.context : {};
  return { source: data.source ?? null, context, benchmarks };
}

// The format of a file, from its parsed JSON (undefined if it isn't JSON), or else its text
export function detectFormat(data, text = '') {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if ('qaboard_benchmarks' in data) return 'qaboard';
    const rows = data.benchmarks;
    if ('machine_info' in data || (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object' && 'fullname' in rows[0]))
      return 'pytest-benchmark';
    if (Array.isArray(rows) && data.context && typeof data.context === 'object' && !Array.isArray(data.context)) return 'google-benchmark';
    if (Array.isArray(data.results) && data.results.every(r => r && typeof r === 'object' && 'command' in r)) return 'hyperfine';
    if ('reason' in data) return 'criterion';
  }
  if (Array.isArray(data) && data.length && data.every(e => e && typeof e === 'object' && !Array.isArray(e) && 'primaryMetric' in e))
    return 'jmh';
  if (data === undefined) {
    if (text.trimStart().startsWith('{') && text.includes('"reason"')) return 'criterion';
    if (/^Benchmark\S*\s+\d+\s+\S+ ns\/op/m.test(text)) return 'go';
  }
  return null;
}

const PARSERS = {
  'pytest-benchmark': parsePytestBenchmark,
  'google-benchmark': parseGoogleBenchmark,
  hyperfine: parseHyperfine,
  jmh: parseJmh,
  qaboard: parseNormalized,
};

const isObject = data => !!data && typeof data === 'object' && !Array.isArray(data);

// JSON, or undefined. Python's json module writes NaN and Infinity, that JSON.parse refuses (pytest-benchmark's stats
// can have them): they're read as null, like the Python package reads them as not numbers.
const NON_FINITE = /([:,[]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g;
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    if (!/NaN|Infinity/.test(text)) return undefined;
    try {
      return JSON.parse(text.replace(NON_FINITE, '$1null'));
    } catch {
      return undefined;
    }
  }
}

// Larger files would take seconds and gigabytes to show: 50,000 benchmarks are about 12 MB, read in 0.3 s.
export const MAX_FILE_LENGTH = 100e6;

function parse(text, format) {
  if (text.length > MAX_FILE_LENGTH)
    throw new FormatError(`the file is too large to show (${Math.round(text.length / 1e6)} MB, the viewer reads up to ${MAX_FILE_LENGTH / 1e6} MB)`);
  if (format && !FORMATS.includes(format))
    throw new FormatError(`unknown benchmark format "${format}", expected one of ${FORMATS.join(', ')}`);
  let data = parseJson(text);
  if (data === null) data = undefined;
  format = format || detectFormat(data, text);
  if (!format) throw new FormatError(`unknown benchmark file: expected one of ${FORMATS.join(', ')}`);
  if (format === 'go') return parseGo(text);
  if (format === 'criterion') {
    const messages = isObject(data) ? [data] : text.split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
    return parseCriterionMessages(messages);
  }
  if (data === undefined) throw new FormatError(`not a ${format} file: not JSON`);
  if (format === 'jmh' && !Array.isArray(data)) throw new FormatError('not a JMH file: expected a list');
  if (format !== 'jmh' && !isObject(data)) throw new FormatError(`not a ${format} file: expected an object`);
  return PARSERS[format](data);
}

// {source, context, benchmarks}, or {error} when the file can't be read
export function parseBenchmarks(text, { format } = {}) {
  try {
    const { source, context, benchmarks } = parse(String(text ?? ''), format);
    return { source, context: cleanContext(context), benchmarks: unique(benchmarks), error: null };
  } catch (error) {
    if (error instanceof FormatError || error instanceof SyntaxError || error instanceof TypeError)
      return { source: null, context: {}, benchmarks: [], error: error.message };
    throw error;
  }
}

// As the normalized format writes it, without empty fields: what the Python package's to_dict() gives
export function toNormalized({ source, context, benchmarks }) {
  const data = { $schema: SCHEMA, qaboard_benchmarks: VERSION };
  if (source) data.source = source;
  const ctx = cleanContext(context);
  if (Object.keys(ctx).length) data.context = ctx;
  data.benchmarks = benchmarks.map(b => {
    const item = { name: b.name };
    if (b.group !== null && b.group !== undefined) item.group = b.group;
    if (b.params && Object.keys(b.params).length) item.params = { ...b.params };
    item.value = b.value;
    item.unit = b.unit;
    if (b.statistic) item.statistic = b.statistic;
    if (b.smaller_is_better === false) item.smaller_is_better = false;
    if (b.stats && Object.keys(b.stats).length) item.stats = Object.fromEntries(STATS.filter(k => k in b.stats).map(k => [k, b.stats[k]]));
    if (b.throughput) item.throughput = { ...b.throughput };
    return item;
  });
  return data;
}

// The name without its group, or its module for pytest's: what the viewer shows (short_name in the Python package)
export function shortName({ name, group }) {
  if (group && name.startsWith(group) && name.length > group.length) {
    const tail = name.slice(group.length);
    const rest = tail.replace(/^[/.: ]+/, '');
    if (rest && rest !== tail) return rest;
  }
  if (name.includes('::')) return name.slice(name.lastIndexOf('::') + 2) || name;
  return name;
}
