// Runs' configurations as lists of settings, to show what's specific to each run and how it differs from its reference.
// A configuration is a list of items: strings ("base", "conf/night.yaml") or objects ({"gain": 4, "isp": {"awb": "auto"}}).
// Each string is a setting, and so is each leaf of an object, keyed by its path ("isp.awb").
// Pure functions: the commit page calls them for each of its 1000s of runs, so they're memoized.

// Some configuration keys are used and shown by viewers - we don't display them as settings
export const hidden_keys = ["badges", "roi", "auto_rois"];

const string_token = (text, item) => ({ kind: 'string', id: `s\u0000${text}`, full: `s\u0000${text}`, key: null, text, item });
const param_token = (key, value, item) => {
  const text = JSON.stringify(value) ?? String(value);
  return { kind: 'param', id: `p\u0000${key}`, full: `p\u0000${key}\u0000${text}`, key, text, item };
};

const flatten = (object, prefix, item, tokens) => {
  for (const [key, value] of Object.entries(object)) {
    if (!prefix && hidden_keys.includes(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const is_object = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (is_object && Object.keys(value).length > 0) flatten(value, path, item, tokens);
    else tokens.push(param_token(path, value, item));
  }
};

const compute_tokens = configurations => {
  const tokens = [];
  configurations.forEach((c, item) => {
    if (c !== null && typeof c === 'object' && !Array.isArray(c)) flatten(c, '', item, tokens);
    else tokens.push(string_token(typeof c === 'string' ? c : JSON.stringify(c), item));
  });
  return Object.freeze(tokens);
};


const empty = Object.freeze([]);
const by_object = new WeakMap();
// Runs often have the same configuration: they share the same tokens, so comparisons are cached across runs
const by_json = new Map();

// The settings of a configuration (a list of items, or a single object, like tuning parameters).
// Equal configurations get the same (frozen) array.
export const config_tokens = configurations => {
  if (configurations === null || configurations === undefined) return empty;
  if (typeof configurations !== 'object') return config_tokens([configurations]);
  let tokens = by_object.get(configurations);
  if (tokens) return tokens;
  const json = JSON.stringify(configurations);
  tokens = by_json.get(json);
  if (!tokens) {
    tokens = compute_tokens(Array.isArray(configurations) ? configurations : [configurations]);
    if (by_json.size > 20000) by_json.clear();
    by_json.set(json, tokens);
  }
  by_object.set(configurations, tokens);
  return tokens;
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

// How different two configurations are, to find the closest reference run: the number of settings
// added, removed or changed. A changed value, or a string replaced by another, counts as one.
// Linear in the number of settings: it used to be a Levenshtein distance between the configurations as JSON,
// which was slow with long configurations, and counted characters instead of settings.
export const config_distance = (configurations_a, configurations_b) => {
  const a = config_tokens(configurations_a);
  const b = config_tokens(configurations_b);
  if (a === b) return 0;
  return distance_cache(a, b, (a, b) => {
    const only_a = only_in(a, b);
    const only_b = only_in(b, a);
    const strings = tokens => tokens.filter(t => t.kind === 'string').length;
    const keys = tokens => new Set(tokens.filter(t => t.kind === 'param').map(t => t.id));
    const keys_a = keys(only_a), keys_b = keys(only_b);
    const changed = [...keys_a].filter(k => keys_b.has(k)).length;
    // the same settings in another order
    const order = only_a.length === 0 && only_b.length === 0 && a.some((t, i) => t.full !== b[i]?.full) ? 0.5 : 0;
    return Math.max(strings(only_a), strings(only_b)) + keys_a.size + keys_b.size - changed + order;
  });
};


// Where two strings differ, e.g. "conf/day.yaml" and "conf/night.yaml": "conf/", "day", "night", ".yaml".
// We cut at separators, to show "gain=[10 → 12]" rather than "gain=1[0 → 2]".
const separator = /[\s/\\.,:;=_\-@|+()[\]{}"']/;
export const string_change = (before, after) => {
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

// A run's configuration compared with its reference's, like `git diff`: a list of
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


// Configurations shown together are often long and mostly the same: we hide the settings that all runs share.
// Hiding 1 or 2 short settings would only make users wonder what's hidden.
const min_hidden_settings = 3;
const min_hidden_length = 40;

const shared_cache = new WeakMap();

// What all the runs' configurations share, from the batch's outputs (an object id => output):
//   tokens: the shared settings, in order
//   keys: their `full` keys
//   runs: the number of runs
//   varies: if some runs have a different configuration
//   collapse: if it's worth hiding the shared settings
export const shared_configuration = outputs_by_id => {
  if (!outputs_by_id) return null;
  if (shared_cache.has(outputs_by_id)) return shared_cache.get(outputs_by_id);
  const outputs = Object.values(outputs_by_id).filter(o => o && o.output_type !== 'optim_iteration');
  let result = null;
  if (outputs.length >= 2) {
    const lists = new Set(outputs.map(o => config_tokens(o.configurations)));
    let keys = null;
    for (const tokens of lists) {
      const these = new Set(tokens.map(t => t.full));
      keys = keys === null ? these : new Set([...keys].filter(k => these.has(k)));
    }
    const seen = new Set();
    const [first] = lists;
    const tokens = first.filter(t => keys.has(t.full) && !seen.has(t.full) && seen.add(t.full));
    const length = tokens.reduce((total, t) => total + (t.key?.length ?? 0) + t.text.length, 0);
    result = Object.freeze({
      tokens,
      keys,
      runs: outputs.length,
      varies: lists.size > 1,
      collapse: tokens.length >= min_hidden_settings || (tokens.length > 0 && length >= min_hidden_length),
    });
  }
  shared_cache.set(outputs_by_id, result);
  return result;
};


export const change_key = d => `${d.op}\u0000${d.token.full}\u0000${d.ref?.full ?? ''}`;

// The runs that are compared to a reference run, and those compared to a reference with another configuration,
// as [configurations, reference configurations]
export const reference_pairs = new_batch => {
  const outputs = (new_batch?.filtered?.outputs ?? []).map(id => new_batch.outputs[id]).filter(o => !!o?.reference_id);
  return {
    compared: outputs.length,
    pairs: outputs
      .filter(o => !!o.reference_mismatch?.configurations)
      .map(o => [o.configurations ?? [], o.reference_mismatch.configurations]),
  };
};

// The changes all compared runs have, e.g. the reference commit used other defaults. As a Set of change_key.
export const changes_in_all_runs = ({ compared, pairs }) => {
  if (compared < 2 || pairs.length < compared) return new Set();
  return new Set(summarize_changes(pairs).filter(c => c.runs === compared).map(change_key));
};

// How the runs' configurations differ from their references', for the whole batch:
// the changes most runs have, e.g. when the reference used another default configuration.
// `pairs` are [configurations, reference configurations]
export const summarize_changes = pairs => {
  const changes = new Map();
  for (const [configurations, reference] of pairs) {
    const seen = new Set();
    for (const d of diff_configurations(configurations, reference)) {
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
