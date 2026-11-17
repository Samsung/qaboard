// What the web app understands of a batch where runs differ by their parameters, without `qa optimize`: a grid, a
// sampling, runs started by hand with other values... Pure functions, for TuningReport.jsx. Automated tunings are in
// optimization.js.
//
// The unit is the *parameter set*: the runs that share the same values of the parameters that change in the batch.
// Each parameter set usually ran on several tests (an input with its configurations): its metrics are aggregated over
// them, so that a set that ran on more tests doesn't weigh more.

const is_number = x => typeof x === 'number' && Number.isFinite(x);
const is_plain = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const MISSING = '\u0000';
const value_key = v => v === undefined ? MISSING : JSON.stringify(v);

// {a: {b: 1}, c: [1, 2]} => {"a.b": 1, c: [1, 2]}: nested settings by their dotted name, lists as one value
export const flatten = (params, prefix = '', flat = {}) => {
  for (const [key, value] of Object.entries(params ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (is_plain(value)) flatten(value, name, flat);
    else flat[name] = value;
  }
  return flat;
};

const average = values => values.reduce((a, b) => a + b, 0) / values.length;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const aggregations = { average, median };

const is_done = o => !o.is_pending && !o.is_running && !o.is_failed && !o.deleted;

// The batch's parameter sets, the parameters that change between them, and the tests they ran on.
// - parameters: [{name, type: integer|real|categorical, values, low, high, log, choices, has_default}], the most varied first.
//   `has_default`: some runs don't set it, and use the code's default.
// - sets: [{id, key, params, all_params, tests: Map(test => run), runs, done, failed, pending, metrics, counts}]
// - tests: the tests' keys; `names[test]` is how to call them
// - confounded: no test ran with 2 parameter sets: we can't tell the parameters' effect from the tests'
export const analyze = (outputs, { aggregation = 'average' } = {}) => {
  const aggregate = aggregations[aggregation] ?? average;
  // in the order the runs were made, whatever the page sorts them by: a parameter set keeps its number
  const by_id = (a, b) => (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0);
  const runs = (outputs ?? []).filter(o => o && o.output_type !== 'optim_iteration').sort(by_id).map(o => ({ output: o, flat: flatten(o.params) }));

  // which parameters change
  const seen = new Map();
  for (const { flat } of runs)
    for (const [name, value] of Object.entries(flat)) {
      if (!seen.has(name)) seen.set(name, new Map());
      seen.get(name).set(value_key(value), value);
    }
  const varying = [...seen.entries()]
    .map(([name, values]) => ({ name, values, has_default: runs.some(r => !(name in r.flat)) }))
    .filter(p => p.values.size + (p.has_default ? 1 : 0) > 1);
  const parameters = varying.map(({ name, values, has_default }) => {
    const all = [...values.values()];
    if (all.every(is_number)) {
      const sorted = [...all].sort((a, b) => a - b);
      const low = sorted[0], high = sorted[sorted.length - 1];
      return {
        name, type: sorted.every(Number.isInteger) ? 'integer' : 'real', values: sorted, low, high,
        // values over orders of magnitude read better on a log scale
        log: low > 0 && high / low >= 100 && sorted.length > 2,
        has_default, inferred: true,
      };
    }
    return { name, type: 'categorical', values: all, choices: all, has_default, inferred: true };
  }).sort((a, b) => b.values.length - a.values.length || a.name.localeCompare(b.name));
  const names = parameters.map(p => p.name);
  const is_varying = new Set(names);

  // the tests, and the parameter sets
  const tests = new Map();
  const sets = new Map();
  for (const { output, flat } of runs) {
    const fixed = Object.entries(flat).filter(([name]) => !is_varying.has(name)).sort(([a], [b]) => a.localeCompare(b));
    const configurations = (output.configurations ?? []).filter(c => typeof c === 'string');
    const test = JSON.stringify([output.test_input_path, configurations, fixed]);
    if (!tests.has(test))
      tests.set(test, configurations.length ? `${output.test_input_path} · ${configurations.join(' ')}` : String(output.test_input_path ?? ''));
    const params = Object.fromEntries(names.filter(name => name in flat).map(name => [name, flat[name]]));
    const key = JSON.stringify(names.map(name => value_key(flat[name])));
    if (!sets.has(key))
      sets.set(key, { key, params, all_params: output.params ?? {}, tests: new Map(), runs: 0, done: 0, failed: 0, pending: 0 });
    const set = sets.get(key);
    set.runs += 1;
    if (output.is_failed) set.failed += 1;
    else if (output.is_pending || output.is_running) set.pending += 1;
    if (is_done(output)) {
      set.done += 1;
      set.tests.set(test, output);
    }
  }
  const all_sets = [...sets.values()].map((set, index) => {
    const values = {};
    for (const output of set.tests.values())
      for (const [metric, value] of Object.entries(output.metrics ?? {}))
        if (is_number(value)) (values[metric] ??= []).push(value);
    return {
      ...set,
      id: index + 1,
      // the code's defaults: none of the parameters that change is set
      is_default: Object.keys(set.params).length === 0,
      metrics: Object.fromEntries(Object.entries(values).map(([metric, v]) => [metric, aggregate(v)])),
      counts: Object.fromEntries(Object.entries(values).map(([metric, v]) => [metric, v.length])),
    };
  });

  const per_test = new Map();
  for (const set of all_sets)
    for (const test of set.tests.keys()) per_test.set(test, (per_test.get(test) ?? 0) + 1);
  const metrics = new Set(all_sets.flatMap(set => Object.keys(set.metrics)));
  return {
    parameters,
    sets: all_sets,
    tests: [...tests.keys()],
    names: Object.fromEntries(tests),
    metrics: [...metrics],
    aggregation: aggregations[aggregation] ? aggregation : 'average',
    runs: {
      total: runs.length,
      done: all_sets.reduce((n, s) => n + s.done, 0),
      failed: all_sets.reduce((n, s) => n + s.failed, 0),
      pending: all_sets.reduce((n, s) => n + s.pending, 0),
    },
    confounded: all_sets.length > 1 && [...per_test.values()].every(n => n < 2),
  };
};

// A batch is worth analyzing when it has parameter sets to compare
export const is_tuning = analysis => analysis.parameters.length > 0 && analysis.sets.length > 1;

// What a batch is, for the sidebar and the page's banner, without analyzing it twice
const kinds = new WeakMap();
export const tuning_kind = batch => {
  if (!batch?.outputs) return null;
  if (batch.data?.optimization) return { kind: 'automated', evaluations: Object.values(batch.outputs).filter(o => o.output_type === 'optim_iteration').length };
  if (!kinds.has(batch.outputs)) {
    const analysis = analyze(Object.values(batch.outputs));
    kinds.set(batch.outputs, is_tuning(analysis)
      ? { kind: 'manual', sets: analysis.sets.length, parameters: analysis.parameters.map(p => p.name), tests: analysis.tests.length, has_metrics: analysis.metrics.length > 0 }
      : null);
  }
  return kinds.get(batch.outputs);
};


// The metrics worth comparing parameter sets with: those that change between them. The ones users picked come first.
export const varying_metrics = (analysis, preferred = []) => {
  const changes = metric => new Set(analysis.sets.map(s => s.metrics[metric]).filter(is_number)).size > 1;
  const varying = analysis.metrics.filter(changes);
  return [...preferred.filter(m => varying.includes(m)), ...varying.filter(m => !preferred.includes(m)).sort()];
};

const better_than = goal => goal === 'max' ? (a, b) => a > b : (a, b) => a < b;

// How much of the metric's variation between parameter sets a parameter explains on its own, from 0 to 1 (epsilon squared,
// a less optimistic eta squared: en.wikipedia.org/wiki/Effect_size). Numbers with many values are binned.
// null when there is too little to say: one parameter, or as many groups as parameter sets.
const impact = (parameter, points) => {
  const defined = points.filter(p => p.params[parameter.name] !== undefined || parameter.has_default);
  let group_of = p => value_key(p.params[parameter.name]);
  if (parameter.type !== 'categorical' && parameter.values.length > 6) {
    const bins = Math.max(3, Math.min(5, Math.floor(Math.sqrt(defined.length))));
    const sorted = defined.map(p => p.params[parameter.name]).filter(is_number).sort((a, b) => a - b);
    const edges = Array.from({ length: bins - 1 }, (_, i) => sorted[Math.floor((i + 1) * sorted.length / bins)]);
    group_of = p => is_number(p.params[parameter.name]) ? String(edges.filter(e => p.params[parameter.name] >= e).length) : MISSING;
  }
  const groups = new Map();
  for (const p of defined) {
    const key = group_of(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.value);
  }
  const n = defined.length, k = groups.size;
  if (k < 2 || n <= k) return null;
  const mean = average(defined.map(p => p.value));
  const total = defined.reduce((sum, p) => sum + (p.value - mean) ** 2, 0);
  if (total <= 0) return 0;
  let within = 0;
  for (const values of groups.values()) {
    const group_mean = average(values);
    within += values.reduce((sum, v) => sum + (v - group_mean) ** 2, 0);
  }
  const between = total - within;
  return Math.min(1, Math.max(0, (between - (k - 1) * within / (n - k)) / total));
};

// Parameter sets none of the others beats on both metrics: [ids]. goals: 'min' or 'max' for each metric.
export const pareto_front = (sets, [mx, my], [gx, gy]) => {
  const points = sets.filter(s => is_number(s.metrics[mx]) && is_number(s.metrics[my]));
  const sign = goal => goal === 'max' ? -1 : 1;
  const cost = s => [sign(gx) * s.metrics[mx], sign(gy) * s.metrics[my]];
  return points.filter(s => {
    const [x, y] = cost(s);
    return !points.some(other => {
      const [ox, oy] = cost(other);
      return ox <= x && oy <= y && (ox < x || oy < y);
    });
  }).map(s => s.id);
};

// The parameter sets compared on a metric. goal: 'min', 'max', or null when we don't know which way is better: then
// there is no best.
// - ranked: the sets that have the metric on as many tests as the most complete one, the best first. The others are
//   `partial`: comparing their average with the others' wouldn't be fair.
// - wins: on how many of the tests the best set ran, it is the best (or tied)
// - regrets: per test, how far the best set is from that test's own best: [{test, value, best, set}], the worst first
export const compare = (analysis, metric, goal) => {
  const with_metric = analysis.sets.filter(s => is_number(s.metrics[metric]));
  const coverage = Math.max(0, ...with_metric.map(s => s.counts[metric]));
  const complete = with_metric.filter(s => s.counts[metric] === coverage);
  const partial = with_metric.filter(s => s.counts[metric] < coverage);
  const better = goal ? better_than(goal) : null;
  const ranked = better ? [...complete].sort((a, b) => better(a.metrics[metric], b.metrics[metric]) ? -1 : better(b.metrics[metric], a.metrics[metric]) ? 1 : a.id - b.id) : complete;
  const best = better ? ranked[0] ?? null : null;
  const values = complete.map(s => s.metrics[metric]);
  const low = Math.min(...values), high = Math.max(...values);
  const baseline = complete.find(s => s.is_default) ?? null;

  const points = complete.map(s => ({ params: s.params, value: s.metrics[metric] }));
  const importances = analysis.parameters.length >= 2
    ? Object.fromEntries(analysis.parameters.map(p => [p.name, impact(p, points)]).filter(([, v]) => v !== null))
    : {};

  let wins = null, regrets = [];
  if (best && coverage > 1) {
    wins = 0;
    for (const [test, output] of best.tests) {
      const value = output.metrics?.[metric];
      if (!is_number(value)) continue;
      let test_best = { value, set: best };
      for (const other of complete) {
        const v = other.tests.get(test)?.metrics?.[metric];
        if (is_number(v) && better(v, test_best.value)) test_best = { value: v, set: other };
      }
      if (test_best.set === best) wins += 1;
      else regrets.push({ test, value, best: test_best.value, set: test_best.set });
    }
    regrets.sort((a, b) => Math.abs(b.value - b.best) - Math.abs(a.value - a.best));
  }
  return {
    metric, goal: goal ?? null, coverage, ranked, partial, best, baseline,
    worst: better ? ranked[ranked.length - 1] ?? null : null,
    low: values.length ? low : null, high: values.length ? high : null,
    // how much the choice of parameters matters, relative to the metric's size
    spread: values.length > 1 && Math.max(Math.abs(low), Math.abs(high)) > 0 ? (high - low) / Math.max(Math.abs(low), Math.abs(high)) : 0,
    importances, wins, regrets,
  };
};

// What the comparison tells users, and what they could do next, most important first: [{kind, intent, ...details}].
// TuningReport.jsx writes the sentences.
export const insights = (analysis, comparison) => {
  const found = [];
  const { best, ranked, importances } = comparison;
  if (analysis.runs.failed > 0)
    found.push({ kind: 'failed', intent: 'warning', runs: analysis.runs.failed, sets: analysis.sets.filter(s => s.failed > 0).length });
  if (analysis.runs.pending > 0)
    found.push({ kind: 'pending', intent: 'primary', runs: analysis.runs.pending });
  if (analysis.confounded)
    found.push({ kind: 'confounded', intent: 'warning' });
  if (comparison.partial.length > 0 && analysis.runs.pending === 0)
    found.push({ kind: 'partial', intent: 'warning', sets: comparison.partial.length, coverage: comparison.coverage });
  if (!best || ranked.length < 2) return found;

  // nothing to choose: the metric is the same whatever the parameters
  if (comparison.spread < 0.005) {
    found.push({ kind: 'flat', intent: 'none', spread: comparison.spread });
    return found;
  }

  // the best value is the lowest or highest tried: better ones may be further
  for (const parameter of analysis.parameters) {
    if (parameter.type === 'categorical' || parameter.values.length < 3) continue;
    const value = best.params[parameter.name];
    if (!is_number(value)) continue;
    if ((importances[parameter.name] ?? 1) < 0.1) continue;
    if (value === parameter.low) found.push({ kind: 'edge', intent: 'warning', name: parameter.name, side: 'low', value, parameter });
    else if (value === parameter.high) found.push({ kind: 'edge', intent: 'warning', name: parameter.name, side: 'high', value, parameter });
  }

  // the best on average isn't the best everywhere
  if (comparison.wins !== null && comparison.coverage >= 3 && comparison.wins < comparison.coverage / 2)
    found.push({ kind: 'tests_disagree', intent: 'none', wins: comparison.wins, tests: comparison.coverage, worst: comparison.regrets[0] ?? null });

  const weak = Object.entries(importances).filter(([, v]) => v < 0.05).map(([name]) => name);
  if (ranked.length >= 8 && weak.length > 0 && weak.length < Object.keys(importances).length)
    found.push({ kind: 'unimportant', intent: 'none', names: weak });

  // tuned on one test: the best parameters may only be the best there
  if (analysis.tests.length === 1)
    found.push({ kind: 'one_test', intent: 'none' });

  // a search would try more values than a grid, where it matters
  if (analysis.parameters.some(p => p.type !== 'categorical' || p.values.length > 1))
    found.push({ kind: 'automate', intent: 'primary', sets: ranked.length });
  return found;
};

// The search space an automated tuning would start from: the ranges and values this batch tried, a bit wider when the
// best value is at an edge. As rows for optimize_config.js: [{kind, name, low, high, log} or {kind, name, categories}]
export const as_search_space = (analysis, comparison) => analysis.parameters.map(p => {
  if (p.type === 'categorical' || p.values.length < 2 || p.low === p.high)
    return { kind: 'Categorical', name: p.name, categories: p.values };
  let { low, high } = p;
  const best = comparison?.best?.params[p.name];
  const widen = (from, to) => p.log ? from * (from / to) ** 0.5 : from + (from - to) * 0.5;
  if (best === low && p.values.length >= 3) low = widen(low, high);
  if (best === high && p.values.length >= 3) high = widen(high, low);
  if (p.type === 'integer') return { kind: 'Integer', name: p.name, low: Math.floor(low), high: Math.ceil(high), log: false };
  return { kind: 'Real', name: p.name, low: Number(low.toPrecision(6)), high: Number(high.toPrecision(6)), log: p.log };
});

// A filter of the commit page that shows a parameter set's runs. The filter's words are regular expressions matched on
// the runs' parameters as JSON without quotes: `threshold:0.3` alone would also match 0.35.
const escape_regex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const set_filter = set => Object.entries(set.params)
  .filter(([, value]) => ['number', 'boolean'].includes(typeof value) || (typeof value === 'string' && /^[^\s"]+$/.test(value)))
  .map(([name, value]) => `${escape_regex(name.split('.').pop())}:${escape_regex(String(value))}[,}]`)
  .join(' ');
