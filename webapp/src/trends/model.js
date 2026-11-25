// Metrics over a branch's commits, from what their definitions say (qaboard/metrics.py):
// - `group`, a path like "Benchmarks/codec": metrics of a group are shown together, filtered and summarized at each level,
// - `aggregation`: how a commit's value comes from its runs (sum, average, median),
// - `part_of` and `intent`: the parts of a total (passed, failed... of tests), stacked, and their color.
// Nothing here knows about tests or benchmarks: `qa upload` describes their metrics that way, projects can do the same.
//
// The commits are "points", oldest first: {id, label, message, date, runs: [{name, metrics}]} when we have their
// runs (the Trends page), or {..., aggregated: {tests_sum: 120, ...}} when the server aggregated them (lists of commits).

const is_number = value => typeof value === 'number' && Number.isFinite(value);

export const AGGREGATIONS = {
  sum: values => values.reduce((a, b) => a + b, 0),
  average: values => values.reduce((a, b) => a + b, 0) / values.length,
  median: values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  },
};
// the keys of what the server aggregated: tests_sum, tests_median...
const AGGREGATED = new RegExp(`_(${Object.keys(AGGREGATIONS).join('|')})$`);
const aggregationOf = definition => AGGREGATIONS[definition?.aggregation] ? definition.aggregation : 'median';

// "Benchmarks / codec" => ["Benchmarks", "codec"]
const groupPath = group => typeof group === 'string' ? group.split('/').map(s => s.trim()).filter(Boolean) : [];

// A metric's value for a commit, over its runs
export function valueAt(point, key, definition, run_filter) {
  const aggregation = aggregationOf(definition);
  if (Array.isArray(point.runs)) {
    const values = [];
    for (const run of point.runs) {
      if (run_filter && !run_filter(run)) continue;
      const value = run.metrics?.[key];
      if (is_number(value)) values.push(value);
    }
    return values.length === 0 ? null : AGGREGATIONS[aggregation](values);
  }
  const value = point.aggregated?.[`${key}_${aggregation}`];
  return is_number(value) ? value : null;
}

// One series per metric the commits have: {key, definition, label, path, values}, `values` aligned with the points
// (null where a commit doesn't have the metric).
export function buildSeries(points, definitions = {}, { run_filter } = {}) {
  const keys = new Set();
  for (const point of points) {
    if (Array.isArray(point.runs)) {
      for (const run of point.runs)
        for (const key in run.metrics ?? {}) keys.add(key);
    } else {
      for (const key in point.aggregated ?? {}) keys.add(key.replace(AGGREGATED, ''));
    }
  }
  // only the metrics whose definitions say where they go: a project's other metrics can be many, with many runs
  const totals = new Set(Object.values(definitions).map(d => d?.part_of).filter(Boolean));
  const series = [];
  for (const key of keys) {
    const definition = definitions[key] ?? {};
    if (!definition.group && !definition.part_of && !totals.has(key)) continue;
    const values = points.map(point => valueAt(point, key, definition, run_filter));
    if (values.every(v => v === null)) continue;
    series.push({
      key,
      definition,
      label: definition.label ?? key,
      short_label: definition.short_label ?? definition.label ?? key,
      path: groupPath(definition.group),
      values,
    });
  }
  return series.sort((a, b) => a.label.localeCompare(b.label));
}

// Totals and their parts: [{key, total, parts, extras, path}]. `parts` are the series that say they are `part_of`
// the total, in the order of INTENTS; `extras` the other series of the total's group (the tests' time...).
export const INTENTS = ['success', 'none', 'warning', 'danger'];
export function compositions(series) {
  const by_key = new Map(series.map(s => [s.key, s]));
  const parts = new Map();
  for (const s of series) {
    const total = s.definition.part_of;
    if (!total || total === s.key) continue;
    if (!parts.has(total)) parts.set(total, []);
    parts.get(total).push(s);
  }
  const intent = s => Math.max(0, INTENTS.indexOf(s.definition.intent ?? 'none'));
  const totals_in = new Map();   // group => how many totals: with several, we can't tell whose the other metrics are
  for (const key of parts.keys()) {
    const group = (by_key.get(key)?.path ?? parts.get(key)[0].path).join('/');
    totals_in.set(group, (totals_in.get(group) ?? 0) + 1);
  }
  return [...parts.entries()].map(([key, members]) => {
    const total = by_key.get(key) ?? null;
    const path = total?.path ?? members[0].path;
    const group = path.join('/');
    const member_keys = new Set(members.map(s => s.key));
    return {
      key,
      total,
      label: total?.label ?? key,
      path,
      // within an intent, always the same order, whatever the values: a part keeps its color (failed before errors)
      parts: members.sort((a, b) => intent(a) - intent(b) || b.key.localeCompare(a.key)),
      extras: totals_in.get(group) > 1 ? [] : series.filter(s => s.key !== key && !member_keys.has(s.key) && !parts.has(s.key) && !s.definition.part_of && s.path.length > 0 && s.path.join('/') === group),
    };
  })
    // nothing to show for a total that is always 0 (no test in any report)
    .filter(c => [c.total, ...c.parts].some(s => s?.values.some(v => v > 0)))
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')) || a.key.localeCompare(b.key));
}

// The series that aren't part of a composition, as a tree of their groups:
// {name, path, children: [nodes], series: [in this group], all: [in this group and below]}
function groupTree(series, composed = compositions(series)) {
  const used = new Set();
  for (const c of composed) {
    used.add(c.key);
    c.parts.forEach(s => used.add(s.key));
    c.extras.forEach(s => used.add(s.key));
  }
  const root = { name: '', path: [], children: [], series: [], all: [] };
  const nodes = new Map([['', root]]);
  for (const s of series) {
    if (used.has(s.key)) continue;
    let node = root;
    node.all.push(s);
    s.path.forEach((name, depth) => {
      const id = s.path.slice(0, depth + 1).join('/');
      let child = nodes.get(id);
      if (!child) {
        child = { name, path: s.path.slice(0, depth + 1), children: [], series: [], all: [] };
        nodes.set(id, child);
        node.children.push(child);
      }
      node = child;
      node.all.push(s);
    });
    node.series.push(s);
  }
  const sort = node => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}
export const findGroup = (root, path) => path.reduce((node, name) => node?.children.find(c => c.name === name), root) ?? null;

// What there is to show: {series, composed, tree}
const NOTHING = { series: [], composed: [], tree: { name: '', path: [], children: [], series: [], all: [] } };
export function trendsOf(points, definitions = {}, options) {
  // most projects' metrics say nothing of groups: nothing to compute over their runs
  if (!Object.values(definitions).some(d => !!d?.group || !!d?.part_of)) return NOTHING;
  const series = buildSeries(points, definitions, options);
  const composed = compositions(series);
  return { series, composed, tree: groupTree(series, composed) };
}
export const hasTrends = ({ composed, tree }) => composed.length > 0 || tree.children.length > 0;

// The same inputs run in several configurations (`run.configuration`: build types, modes...): each test is in each
// configuration's runs, so totals that add up over the runs count it once per configuration. That is what a commit
// ran, and a failure in any configuration counts, but "1,218 tests" reads like the suite's size: the tiles and
// sections say what the sum is made of. => [{name, runs}], sorted, or null when nothing is repeated.
export function configurationsOf(point) {
  if (!Array.isArray(point?.runs)) return null;
  const by_name = new Map();
  for (const run of point.runs) {
    const name = run.configuration ?? '';
    if (!by_name.has(name)) by_name.set(name, []);
    by_name.get(name).push(run);
  }
  if (by_name.size < 2) return null;
  // configurations of different inputs (a configuration per suite) add up different tests: nothing to say
  const configuration_of_input = new Map();
  let repeated = false;
  for (const [name, runs] of by_name) {
    for (const run of runs) {
      const seen = configuration_of_input.get(run.name);
      if (seen !== undefined && seen !== name) repeated = true;
      configuration_of_input.set(run.name, name);
    }
  }
  if (!repeated) return null;
  return [...by_name.entries()].map(([name, runs]) => ({ name, runs })).sort((a, b) => a.name.localeCompare(b.name));
}

// What series that add up over runs (aggregation "sum") have in each configuration at a point:
// {configurations: [{name, value}], total, same} (`same`: every configuration has the same value), or null.
export function byConfiguration(point, series_list) {
  if (series_list.length === 0 || series_list.some(s => aggregationOf(s.definition) !== 'sum')) return null;
  const configurations = configurationsOf(point);
  if (!configurations) return null;
  const values = configurations.map(({ name }) => {
    const in_configuration = run => (run.configuration ?? '') === name;
    return { name, value: series_list.reduce((sum, s) => sum + (valueAt(point, s.key, s.definition, in_configuration) ?? 0), 0) };
  });
  const total = values.reduce((sum, c) => sum + c.value, 0);
  return { configurations: values, total, same: values.every(c => c.value === values[0].value) };
}
// "default: 609 · strict: 609"
export const formatConfigurations = ({ configurations }) => configurations.map(c => `${c.name || 'no configuration'}: ${formatNumber(c.value)}`).join(' · ');

// Where a section is on the page, for links: a total's by its key, a group's by its name
const slug = text => String(text).replace(/[^\w-]+/g, '-');
export const anchorOf = { total: key => `trends-total-${slug(key)}`, group: name => `trends-group-${slug(name)}` };

// The commits where at least one of the series has a value: the others didn't measure this at all (no benchmark job
// on that commit), which says nothing about the scope.
function measuredIndexes(series_list, count) {
  const indexes = [];
  for (let i = 0; i < count; i++)
    if (series_list.some(s => s.values[i] !== null)) indexes.push(i);
  return indexes;
}

// What is compared from the first to the last commit: are these the same metrics?
// - common: in every commit that measured something,
// - added / removed: not in the first / last one,
// - partial: in the first and the last, missing in between.
export function scopeOf(series_list, count) {
  const measured = measuredIndexes(series_list, count);
  const scope = { measured, common: [], added: [], removed: [], partial: [] };
  if (measured.length === 0) return scope;
  const first = measured[0], last = measured[measured.length - 1];
  for (const s of series_list) {
    if (s.values[first] === null && s.values[last] === null) scope.partial.push(s);
    else if (s.values[first] === null) scope.added.push(s);
    else if (s.values[last] === null) scope.removed.push(s);
    else if (measured.every(i => s.values[i] !== null)) scope.common.push(s);
    else scope.partial.push(s);
  }
  return scope;
}

const median = values => AGGREGATIONS.median(values);
// how far b is from a: a log ratio for positive values (2x and 0.5x are as far), else a difference
const distance = (a, b) => a > 0 && b > 0 ? Math.log(b / a) : b - a;

// How a series changed over the commits: {first, last, ratio, direction, step, usual, beyond}
// - baseline: 'first' compares the last value with the first, 'previous' with the one before,
// - direction: 'better' | 'worse' | 'changed' (no better direction) | 'same',
// - step: where it moved the most between two commits in a row, {index, from, to, ratio},
// - usual: the median move between two commits in a row; `notable`: the change is over 3 times it. A hint, not a
//   verdict: QA-Board doesn't know how noisy the machine is. Metrics that only wobble aren't "movers". With fewer
//   than MIN_POINTS commits (`few`), nothing says what is usual: every change is notable.
// - stepped: most of the change happened at one commit (`step`), rather than drifting over many.
export const MIN_CHANGE = 0.005;
export const MIN_POINTS = 4;
export function changeOf(series, { baseline = 'first', from = 0, to = series.values.length - 1 } = {}) {
  const present = [];
  for (let i = from; i <= to; i++)
    if (series.values[i] !== null) present.push(i);
  if (present.length < 2) return null;
  const last_index = present[present.length - 1];
  const first_index = baseline === 'previous' ? present[present.length - 2] : present[0];
  const first = series.values[first_index], last = series.values[last_index];
  // a ratio only means something between positive values: otherwise the change is shown as a difference
  const ratio_of = (a, b) => a > 0 && b > 0 ? b / a : (a === b ? 1 : null);
  const ratio = ratio_of(first, last);
  const moves = [];
  let step = null;
  for (let k = 1; k < present.length; k++) {
    const a = series.values[present[k - 1]], b = series.values[present[k]];
    const move = Math.abs(distance(a, b));
    moves.push(move);
    if (!step || move > step.move)
      step = { move, index: present[k], previous_index: present[k - 1], from: a, to: b, ratio: ratio_of(a, b), delta: b - a };
  }
  const usual = median(moves);
  const total = Math.abs(distance(first, last));
  const relative = first !== 0 ? Math.abs((last - first) / first) : (last === 0 ? 0 : Infinity);
  let direction = 'same';
  if (relative >= MIN_CHANGE) {
    const smaller_is_better = series.definition.smaller_is_better;
    if (smaller_is_better === true) direction = last < first ? 'better' : 'worse';
    else if (smaller_is_better === false) direction = last > first ? 'better' : 'worse';
    else direction = 'changed';
  }
  // with few commits there is no usual variation to compare with: every change counts
  const few = present.length < MIN_POINTS;
  const notable = direction !== 'same' && (few || total > 3 * usual);
  // a step: one move, the same way as the whole change, that stands out by itself and makes most of it
  const same_way = Math.sign(step.to - step.from) === Math.sign(last - first);
  const stepped = notable && same_way && step.move >= 0.6 * total && (few || step.move > 3 * usual);
  return { first, last, delta: last - first, first_index, last_index, ratio, relative, direction, step, usual, notable, few, stepped, points: present.length };
}

// The series that moved beyond their usual variation, the worst first, then the best: [{series, change}].
// `quiet` counts those that changed less than that.
export function movers(series_list, options) {
  const rows = [];
  let quiet = 0;
  for (const series of series_list) {
    const change = changeOf(series, options);
    if (change?.notable) rows.push({ series, change });
    else if (change && change.direction !== 'same') quiet += 1;
  }
  rows.quiet = quiet;
  rows.few = rows.length > 0 && rows.every(row => row.change.few);
  const rank = { worse: 0, changed: 1, better: 2 };
  // from zero, every change is infinite: the biggest difference first
  const size = (a, b) => a.change.relative === b.change.relative ? Math.abs(b.change.delta) - Math.abs(a.change.delta) : b.change.relative - a.change.relative;
  rows.sort((a, b) => rank[a.change.direction] - rank[b.change.direction] || size(a, b));
  return rows;
}
export function countDirections(rows) {
  const counts = { worse: 0, better: 0, changed: 0 };
  rows.forEach(row => { counts[row.change.direction] += 1; });
  return counts;
}

// A group's summary over the commits: the geometric mean of each series against its first value (1 = no change),
// oriented so that above 1 is always more of the metric. Only series with positive values, all present at each point
// they are averaged at: with `same_scope`, only those in every measured commit, so the mean always covers the same
// metrics. Returns {values, counts}: `counts[i]` series behind `values[i]`.
export function groupIndex(series_list, count, { same_scope = true } = {}) {
  const scope = scopeOf(series_list, count);
  const members = (same_scope ? scope.common : series_list).filter(s => s.values.every(v => v === null || v > 0));
  const values = Array.from({ length: count }, () => null);
  const counts = Array.from({ length: count }, () => 0);
  const firsts = members.map(s => s.values.find(v => v !== null));
  for (const i of scope.measured) {
    let sum = 0, n = 0;
    members.forEach((s, k) => {
      if (s.values[i] === null) return;
      sum += Math.log(s.values[i] / firsts[k]);
      n += 1;
    });
    if (n > 0) {
      values[i] = Math.exp(sum / n);
      counts[i] = n;
    }
  }
  return { values, counts, scope, members };
}

// Whether a group's metrics all go the same way: its summary is then better or worse, not only different
export function groupDirection(series_list) {
  const directions = new Set(series_list.map(s => s.definition.smaller_is_better));
  return directions.size === 1 ? [...directions][0] : undefined;
}

// --- formatting ---
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export function formatNumber(value, precision) {
  if (!is_number(value)) return '–';
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e6) return value.toLocaleString('en');
  if (abs >= 1e5) return compact.format(value);
  if (precision !== undefined) return value.toLocaleString('en', { maximumFractionDigits: precision });
  return value.toLocaleString('en', { maximumSignificantDigits: 3 });
}
// as the metric's definition says: its scale, precision and unit (0.0042 with scale 1000 and " ms" => "4.2 ms")
export const formatValue = (value, definition = {}) => is_number(value)
  ? `${formatNumber(value * (definition.scale ?? 1), definition.precision)}${definition.suffix ?? ''}`
  : '–';
// 1.034 => "+3.4%"
export function formatRatio(ratio) {
  if (!is_number(ratio)) return ratio === Infinity ? 'new' : '–';
  const percent = (ratio - 1) * 100;
  if (Math.abs(percent) >= 1000) return `${ratio.toFixed(0)}×`;
  const digits = Math.abs(percent) < 10 ? 1 : 0;
  const text = percent.toFixed(digits);
  if (parseFloat(text) === 0) return '0%';
  // a real minus sign, as wide as the plus
  return `${percent > 0 ? '+' : '−'}${text.replace('-', '')}%`;
}
export const formatDelta = delta => `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${formatNumber(Math.abs(delta))}`;
export const plural = (n, word, words = `${word}s`) => `${n.toLocaleString('en')} ${n === 1 ? word : words}`;

// At most `max` points, spread over the commits, always with the first and the last
export function samplePoints(points, max) {
  if (points.length <= max) return points;
  const picked = [];
  for (let k = 0; k < max; k++) picked.push(points[Math.round(k * (points.length - 1) / (max - 1))]);
  return picked;
}
