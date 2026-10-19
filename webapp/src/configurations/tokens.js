// Runs' configurations as lists of settings, to show what's specific to each run and how it differs from its reference.
// A configuration is a list of items: strings ("base", "conf/night.yaml") or objects ({"gain": 4, "isp": {"awb": "auto"}}).
// Each string is a setting, and so is each leaf of an object, keyed by its path ("isp.awb").
// Tuning parameters (`qa --tuning`, a run's extra_parameters) are one more object, applied last: their settings are
// shown and compared like the others, but they're kept apart from the configuration's (`source: 'tuning'`).
// Pure functions: the commit page calls them for each of its 1000s of runs, so they're memoized.

// Some configuration keys are used and shown by viewers - we don't display them as settings
export const hidden_keys = ["badges", "roi", "auto_rois"];

// Values as people write them: [1, 0.98, 0.95] rather than JSON's [1,0.98,0.95]
export const format_value = value => {
  if (Array.isArray(value)) return `[${value.map(format_value).join(', ')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${format_value(v)}`).join(', ')}}`;
  return JSON.stringify(value) ?? String(value);
};

// `text` identifies the value (JSON), `display` is how we show it
const string_token = (text, item) => ({
  kind: 'string', source: 'config', id: `s\u0000${text}`, full: `s\u0000${text}`, key: null, text, display: text, item,
});
const param_token = (key, value, item, source) => {
  const text = JSON.stringify(value) ?? String(value);
  const tag = source === 'tuning' ? 't' : 'p';
  return {
    kind: 'param', source, id: `${tag}\u0000${key}`, full: `${tag}\u0000${key}\u0000${text}`, key, text, display: format_value(value), value, item,
  };
};

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has_objects = array => array.some(v => is_object(v) && Object.keys(v).length > 0);

// Each leaf is a setting. Lists of objects (e.g. layers: [{type: "conv", ...}, ...]) have a setting per leaf too,
// "layers[0].type", so that their changes show. Lists of values are one setting: "lens_shading: [1, 0.98, 0.95]".
const visit = (value, path, item, source, tokens) => {
  if (is_object(value) && Object.keys(value).length > 0) {
    for (const [key, v] of Object.entries(value)) {
      if (!path && hidden_keys.includes(key)) continue;
      visit(v, path ? `${path}.${key}` : key, item, source, tokens);
    }
  } else if (Array.isArray(value) && has_objects(value)) {
    value.forEach((v, i) => visit(v, `${path}[${i}]`, item, source, tokens));
  } else {
    tokens.push(param_token(path, value, item, source));
  }
};
// an empty object has no settings
const flatten = (object, prefix, item, source, tokens) => {
  if (Object.keys(object).length > 0) visit(object, prefix, item, source, tokens);
};

const compute_tokens = configurations => {
  const tokens = [];
  configurations.forEach((c, item) => {
    if (c !== null && typeof c === 'object' && !Array.isArray(c)) flatten(c, '', item, 'config', tokens);
    else tokens.push(string_token(typeof c === 'string' ? c : JSON.stringify(c), item));
  });
  return Object.freeze(tokens);
};

const compute_tuning_tokens = parameters => {
  const tokens = [];
  flatten(parameters, '', null, 'tuning', tokens);
  return Object.freeze(tokens);
};


const empty = Object.freeze([]);

// Runs often have the same configuration: they share the same tokens, so comparisons are cached across runs
const interned = compute => {
  const by_object = new WeakMap();
  const by_json = new Map();
  return value => {
    let tokens = by_object.get(value);
    if (tokens) return tokens;
    const json = JSON.stringify(value);
    tokens = by_json.get(json);
    if (!tokens) {
      tokens = compute(value);
      if (by_json.size > 20000) by_json.clear();
      by_json.set(json, tokens);
    }
    by_object.set(value, tokens);
    return tokens;
  };
};
const interned_config = interned(c => compute_tokens(Array.isArray(c) ? c : [c]));
const interned_tuning = interned(compute_tuning_tokens);

// The settings of a configuration (a list of items, or a single object). Equal configurations get the same (frozen) array.
export const config_tokens = configurations => {
  if (configurations === null || configurations === undefined) return empty;
  if (typeof configurations !== 'object') return config_tokens([configurations]);
  return interned_config(configurations);
};

// The settings of tuning parameters
export const tuning_tokens = parameters => {
  if (!parameters || typeof parameters !== 'object' || Object.keys(parameters).length === 0) return empty;
  return interned_tuning(parameters);
};


// Results cached for pairs of token arrays
const pair_cache = () => {
  const cache = new WeakMap();
  return (a, b, compute) => {
    let for_a = cache.get(a);
    if (!for_a) cache.set(a, for_a = new WeakMap());
    let result = for_a.get(b);
    if (result === undefined) for_a.set(b, result = compute(a, b));
    return result;
  };
};

const concat_cache = pair_cache();

// All of a run's settings: its configuration's, then its tuning parameters'
export const run_tokens = (configurations, tuning) => {
  const config = config_tokens(configurations);
  const params = tuning_tokens(tuning);
  if (params.length === 0) return config;
  return concat_cache(config, params, (a, b) => Object.freeze([...a, ...b]));
};

export const output_tokens = output => run_tokens(output.configurations, output.extra_parameters);

// The settings of a run's reference run, null when they're the same (see matching_output's mismatch)
export const reference_tokens = output => {
  const mismatch = output.reference_mismatch;
  if (!mismatch || (!mismatch.configurations && !mismatch.extra_parameters)) return null;
  return run_tokens(mismatch.configurations ?? output.configurations, mismatch.extra_parameters ?? output.extra_parameters);
};


// How different two strings are, from 0 (equal) to 1. Settings are short: a Levenshtein distance is cheap.
const string_distance = (a, b) => {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 1;
  if (n * m > 100_000) {
    const { prefix, suffix } = string_change(a, b);
    return 1 - (prefix.length + suffix.length) / Math.max(n, m);
  }
  let row = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const next = [i];
    for (let j = 1; j <= m; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[m] / Math.max(n, m);
};

// How different two values of a setting are, from 0 to 1: 3 is closer to 4 than to 100
const value_distance = (a, b) => {
  if (typeof a.value === 'number' && typeof b.value === 'number')
    return Math.abs(a.value - b.value) / (Math.abs(a.value) + Math.abs(b.value));
  return string_distance(a.text, b.text);
};

// The settings of `tokens` that `other` doesn't have (as a multiset)
const only_in = (tokens, other) => {
  const left = new Map();
  for (const t of other) left.set(t.full, (left.get(t.full) ?? 0) + 1);
  return tokens.filter(t => {
    const n = left.get(t.full) ?? 0;
    if (n > 0) left.set(t.full, n - 1);
    return n === 0;
  });
};
const distance_cache = pair_cache();

// How different two lists of settings are, to find the closest reference run:
// - the integer part is the number of settings added, removed or changed. A changed value, or a string replaced
//   by another, counts as one. It handles long and deeply nested configurations.
// - the fractional part breaks ties: how different the changed values are. "base-v1" is closer to "base-v2"
//   than to "other", and gain 3 closer to 4 than to 100.
// It used to be a Levenshtein distance between the configurations as JSON, slow with long configurations,
// and counting characters instead of settings.
export const tokens_distance = (a, b) => {
  if (a === b) return 0;
  return distance_cache(a, b, (a, b) => {
    const only_a = only_in(a, b);
    const only_b = only_in(b, a);
    // the same settings in another order
    if (only_a.length === 0 && only_b.length === 0)
      return a.some((t, i) => t.full !== b[i]?.full) ? 0.5 : 0;

    const pair_distances = [];
    // changed values
    const params_b = new Map(only_b.filter(t => t.kind === 'param').map(t => [t.id, t]));
    const keys_a = new Set(only_a.filter(t => t.kind === 'param').map(t => t.id));
    let changed = 0;
    for (const t of only_a) {
      const other = t.kind === 'param' && params_b.get(t.id);
      if (!other) continue;
      changed++;
      pair_distances.push(value_distance(t, other));
      params_b.delete(t.id);
    }
    // strings replaced by the most similar ones
    const strings_a = only_a.filter(t => t.kind === 'string').map(t => t.text);
    const strings_b = only_b.filter(t => t.kind === 'string').map(t => t.text);
    const [fewer, more] = strings_a.length <= strings_b.length ? [strings_a, strings_b] : [strings_b, strings_a];
    const left = [...more];
    for (const s of fewer) {
      let best = 0;
      left.forEach((o, k) => { if (string_distance(s, o) < string_distance(s, left[best])) best = k; });
      pair_distances.push(string_distance(s, left[best]));
      left.splice(best, 1);
    }
    const keys_b = new Set(only_b.filter(t => t.kind === 'param').map(t => t.id));
    const settings = more.length + keys_a.size + keys_b.size - changed;
    const tie = pair_distances.length > 0 ? pair_distances.reduce((x, y) => x + y, 0) / pair_distances.length : 1;
    return settings + 0.9 * Math.min(tie, 1);
  });
};

export const config_distance = (configurations_a, configurations_b) =>
  tokens_distance(config_tokens(configurations_a), config_tokens(configurations_b));


const string_separator = /[\s/\\.,:;=_\-@|+()[\]{}"']/;
// In values like [1, 0.98, -0.5], numbers are words: 0.7 → 0.635, not 0.[7 → 635]
export const value_separator = /[\s,:[\]{}"]/;

// Where two strings differ, e.g. "conf/day.yaml" and "conf/night.yaml": "conf/", "day", "night", ".yaml".
// We cut at separators, to show "gain=[10 → 12]" rather than "gain=1[0 → 2]".
export const string_change = (before, after, separator = string_separator) => {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const in_word = (left, right) => left !== undefined && right !== undefined && !separator.test(left) && !separator.test(right);
  while (p > 0 && (in_word(before[p - 1], before[p]) || in_word(after[p - 1], after[p]))) p--;
  const b = before.length, a = after.length;
  while (s > 0 && (in_word(before[b - s - 1], before[b - s]) || in_word(after[a - s - 1], after[a - s]))) s--;
  return {
    prefix: before.slice(0, p),
    before: before.slice(p, before.length - s),
    after: after.slice(p, after.length - s),
    suffix: before.slice(before.length - s),
  };
};

// Strings that look like versions of each other, e.g. paths to files in the same folder
const similar = (a, b) => {
  const { prefix, suffix } = string_change(a, b);
  const common = prefix.length + suffix.length;
  return common >= 3 && common >= 0.4 * Math.min(a.length, b.length);
};


// The longest common subsequence of settings' ids, as (i, j) index pairs. Settings with the same key are matched,
// even if their values differ: those are changes.
const max_cells = 4_000_000;
const match_ids = (a, b) => {
  const n = a.length, m = b.length;
  if (n * m > max_cells) {
    // huge configurations: match greedily, in order
    const pairs = [];
    let j = 0;
    const positions = new Map();
    b.forEach((t, k) => { if (!positions.has(t.id)) positions.set(t.id, []); positions.get(t.id).push(k); });
    for (let i = 0; i < n; i++) {
      const next = positions.get(a[i].id)?.find(k => k >= j);
      if (next !== undefined) { pairs.push([i, next]); j = next + 1; }
    }
    return pairs;
  }
  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[at(i, j)] = a[i].id === b[j].id ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].id === b[j].id) { pairs.push([i, j]); i++; j++; }
    else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) i++;
    else j++;
  }
  return pairs;
};

// Removed and added strings that look like versions of each other are shown as changes
const pair_strings = (removed, added) => {
  const out = [];
  const used = new Set();
  const changed = new Map();
  for (const r of removed) {
    if (r.token.kind !== 'string') continue;
    const a = added.find(a => a.token.kind === 'string' && !used.has(a) && similar(r.token.text, a.token.text));
    if (a) { used.add(a); changed.set(a, r); }
  }
  const paired = new Set(changed.values());
  for (const r of removed) if (!paired.has(r)) out.push(r);
  for (const a of added) out.push(changed.has(a) ? { op: 'changed', token: a.token, ref: changed.get(a).token } : a);
  return out;
};

const diff_cache = pair_cache();

// A run's settings compared with its reference's, like `git diff`: a list of
//   {op: 'same', token, ref}, {op: 'changed', token, ref}, {op: 'added', token}, {op: 'removed', token}
// where `token` is the run's setting (the reference's for 'removed') and `ref` the reference's
export const diff_tokens = (tokens, ref_tokens) => diff_cache(tokens, ref_tokens, (b, a) => {
  const ops = [];
  let removed = [], added = [];
  const flush = () => {
    if (removed.length || added.length) ops.push(...pair_strings(removed, added));
    removed = []; added = [];
  };
  let i = 0, j = 0;
  for (const [pi, pj] of [...match_ids(a, b), [a.length, b.length]]) {
    for (; i < pi; i++) removed.push({ op: 'removed', token: a[i] });
    for (; j < pj; j++) added.push({ op: 'added', token: b[j] });
    if (pi === a.length && pj === b.length) break;
    flush();
    ops.push({ op: a[pi].text === b[pj].text ? 'same' : 'changed', token: b[pj], ref: a[pi] });
    i++; j++;
  }
  flush();
  return Object.freeze(ops);
});

export const diff_configurations = (configurations, reference) => diff_tokens(config_tokens(configurations), config_tokens(reference));

export const count_changes = ops => {
  const n = { added: 0, removed: 0, changed: 0 };
  for (const { op } of ops) if (op !== 'same') n[op]++;
  return n;
};


// Long strings that vary between runs often share a long prefix, e.g. "conf/projects/camera/scenes/night.yaml" and
// ".../day.yaml". For each string, how many characters we can replace by "…" and still tell it from the others:
// we keep the last folder or word of the prefix.
const min_elided = 12;
const elisions = strings => {
  const sorted = [...new Set(strings)].sort();
  const lcp = (a, b) => {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  };
  const result = new Map();
  sorted.forEach((s, i) => {
    const common = Math.max(i > 0 ? lcp(s, sorted[i - 1]) : 0, i < sorted.length - 1 ? lcp(s, sorted[i + 1]) : 0);
    // the prefix ends after a separator
    let end = common;
    while (end > 0 && !string_separator.test(s[end - 1])) end--;
    // keep the last folder or word of the prefix
    let start = end - 1;
    while (start > 0 && !string_separator.test(s[start - 1])) start--;
    if (start >= min_elided) result.set(s, start);
  });
  return result;
};


// Configurations shown together are often long and mostly the same: we hide the settings that all runs share.
// Hiding 1 or 2 short settings would only make users wonder what's hidden.
const min_hidden_settings = 3;
const min_hidden_length = 40;

// We return the same object for the same result: the commit page passes it to all runs in a context,
// and filtering would re-render them all
const shared_results = new Map();

// What all the runs' settings share, from a list of outputs:
//   tokens: the shared settings, in order
//   keys: their `full` keys
//   runs: the number of runs
//   varies: if some runs have different settings
//   collapse: if it's worth hiding the shared settings
//   elided: for long strings that vary between runs, how many characters of their prefix we can hide
export const shared_configuration = outputs => {
  outputs = (outputs ?? []).filter(o => o && o.output_type !== 'optim_iteration');
  if (outputs.length < 2) return null;
  const lists = new Set(outputs.map(output_tokens));
  let keys = null;
  for (const tokens of lists) {
    const these = new Set(tokens.map(t => t.full));
    keys = keys === null ? these : new Set([...keys].filter(k => these.has(k)));
  }
  const seen = new Set();
  const [first] = lists;
  const tokens = first.filter(t => keys.has(t.full) && !seen.has(t.full) && seen.add(t.full));
  const length = tokens.reduce((total, t) => total + (t.key?.length ?? 0) + t.text.length, 0);
  const varying_strings = [...lists].flatMap(list => list.filter(t => t.kind === 'string' && !keys.has(t.full)).map(t => t.text));
  const elided = elisions(varying_strings);
  const result = {
    tokens,
    keys,
    runs: outputs.length,
    varies: lists.size > 1,
    collapse: tokens.length >= min_hidden_settings || (tokens.length > 0 && length >= min_hidden_length),
    elided,
  };
  const signature = JSON.stringify([result.runs, result.varies, result.collapse, [...keys], [...elided]]);
  if (!shared_results.has(signature)) {
    if (shared_results.size > 50) shared_results.clear();
    shared_results.set(signature, Object.freeze(result));
  }
  return shared_results.get(signature);
};


export const change_key = d => `${d.op}\u0000${d.token.full}\u0000${d.ref?.full ?? ''}`;

// The runs that are compared to a reference run, and those compared to a reference with other settings,
// as [settings, reference settings]. Also how many runs had several reference runs as close.
export const reference_pairs = new_batch => {
  const outputs = (new_batch?.filtered?.outputs ?? []).map(id => new_batch.outputs[id]).filter(o => !!o?.reference_id);
  const pairs = [];
  for (const o of outputs) {
    const reference = reference_tokens(o);
    if (reference) pairs.push([output_tokens(o), reference]);
  }
  return { compared: outputs.length, pairs, ambiguous: outputs.filter(o => o.reference_mismatch?.alternatives > 0).length };
};

const all_runs_results = new Map();

// The changes all compared runs have, e.g. the reference commit used other defaults. As a Set of change_key,
// the same Set for the same changes.
export const changes_in_all_runs = ({ compared, pairs }) => {
  const keys = compared < 2 || pairs.length < compared ? [] : summarize_changes(pairs).filter(c => c.runs === compared).map(change_key);
  const signature = keys.join('\u0001');
  if (!all_runs_results.has(signature)) {
    if (all_runs_results.size > 50) all_runs_results.clear();
    all_runs_results.set(signature, new Set(keys));
  }
  return all_runs_results.get(signature);
};

// How the runs' settings differ from their references', for the whole batch:
// the changes most runs have, e.g. when the reference used another default configuration.
// `pairs` are [settings, reference settings] (token arrays)
export const summarize_changes = pairs => {
  const changes = new Map();
  for (const [tokens, reference] of pairs) {
    const seen = new Set();
    for (const d of diff_tokens(tokens, reference)) {
      if (d.op === 'same') continue;
      const key = change_key(d);
      if (seen.has(key)) continue;
      seen.add(key);
      const change = changes.get(key) ?? { ...d, runs: 0 };
      change.runs++;
      changes.set(key, change);
    }
  }
  return [...changes.values()].sort((a, b) => b.runs - a.runs);
};
