// How runs find their reference run, beyond the default (the same input, else the same metadata.id).
// Users change it on the commit page, it's in the URL so that links show the same pairs:
//   ?pair=reg0x1A=05|reg0x1A=03   runs whose name has the first part compare with the reference run that has the second
//   ?prefer=platform=arm          among the reference runs that could do, those with this fact first
//   ?pin=<run id>:<reference id>  this run compares with this reference run
// The checks of the CLI and the API (`qa gate`, backend/backend/compare.py) use the default: see src/matching/match.js
// for how to port the rules there.

const as_list = value => value === undefined || value === null || value === '' ? [] : [].concat(typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : value);

// The first half can have the separator: we escape it, and "%" ("a|b" => "a%7Cb"). The second half is as is.
const escape = (text, separator) => text.replace(/%/g, '%25').replaceAll(separator, encodeURIComponent(separator));
const unescape = text => text.replace(/%7C|%3D|%25/gi, code => decodeURIComponent(code));
const split_once = (text, separator) => {
  const at = text.indexOf(separator);
  if (at <= 0 || at === text.length - 1) return null;
  return [unescape(text.slice(0, at)), text.slice(at + 1)];
};

// `|` can't be in Windows file names, and is rare elsewhere
const parse_pair = text => {
  const parts = split_once(String(text), '|');
  return parts && { from: parts[0], to: parts[1] };
};
// facts are "platform", "param:<path>", "meta:<key>", "config:<item>"
const parse_prefer = text => {
  const parts = split_once(String(text), '=');
  return parts && { key: parts[0], value: parts[1] };
};
const parse_pin = text => {
  const [output, reference] = String(text).split(':');
  return output && reference ? [output, reference] : null;
};

const no_rules = Object.freeze({ pairs: [], prefer: [], pins: {}, custom: false });
const rules_key = rules => JSON.stringify([rules.pairs, rules.prefer, rules.pins]);

// The rules in a URL's query (parsed by qs). The same object for the same rules: the runs' references are computed
// again only when they change (compute_batches in src/selectors/batches.js), not with each change of the URL.
const recent = new Map();
export const rules_from_query = query => {
  const pairs = as_list(query.pair).map(parse_pair).filter(Boolean);
  const prefer = as_list(query.prefer).map(parse_prefer).filter(Boolean);
  const pins = Object.fromEntries(as_list(query.pin).map(parse_pin).filter(Boolean));
  if (!pairs.length && !prefer.length && !Object.keys(pins).length) return no_rules;
  const rules = { pairs, prefer, pins, custom: true };
  const key = rules_key(rules);
  if (!recent.has(key)) {
    if (recent.size > 20) recent.clear();
    recent.set(key, Object.freeze(rules));
  }
  return recent.get(key);
};

// What to give updateSelected to save rules
export const rules_to_selection = ({ pairs = [], prefer = [], pins = {} }) => ({
  pair: pairs.map(({ from, to }) => `${escape(from, '|')}|${to}`),
  prefer: prefer.map(({ key, value }) => `${escape(key, '=')}=${value}`),
  pin: Object.entries(pins).map(([output, reference]) => `${output}:${reference}`),
});
export const rules_defaults = { pair: [], prefer: [], pin: [] };


// ---------------------------------------------------------------------------- changing rules

export const without_pin = (rules, output_id) => {
  const { [output_id]: _, ...pins } = rules.pins;
  return { ...rules, pins };
};

// The rules with others added. A pair replaces the one on the same part, and is left out when another does the same
// change already (e.g. "a_reg05 → a_reg03" with "reg05 → reg03"). A preference replaces the one on the same fact.
export const add_rules = (rules, { pairs = [], prefer = [] }) => {
  const kept = rules.pairs.filter(p => !pairs.some(n => n.from === p.from));
  const new_pairs = pairs.filter(n => !kept.some(p => p.from !== n.from && n.from.includes(p.from) && n.from.replace(p.from, p.to) === n.to));
  return {
    ...rules,
    pairs: [...kept, ...new_pairs],
    prefer: [...rules.prefer.filter(p => !prefer.some(n => n.key === p.key)), ...prefer],
  };
};

// ---------------------------------------------------------------------------- facts

// Metadata keys that are no facts users prefer: what viewers show, or the id runs are matched with
const SKIPPED_METADATA = new Set(['id', 'label', 'roi', 'auto_rois', 'tags', 'width', 'height']);

const facts_cache = new WeakMap();
// What we know about a run, to prefer reference runs: { "platform": "arm", "param:gain": "4", "meta:sensor": "imx766",
// "config:low-light": "yes" }. Values are text, as in URLs.
export const run_facts = output => {
  let facts = facts_cache.get(output);
  if (facts) return facts;
  facts = {};
  if (output.platform) facts.platform = String(output.platform);
  const visit = (value, path) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
    } else {
      facts[`param:${path}`] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  };
  visit(output.extra_parameters ?? {}, '');
  for (const [k, v] of Object.entries(output.test_input_metadata ?? {}))
    if (!SKIPPED_METADATA.has(k) && !k.startsWith('_') && (typeof v !== 'object' || v === null)) facts[`meta:${k}`] = String(v);
  for (const c of output.configurations ?? [])
    if (typeof c === 'string') facts[`config:${c}`] = 'yes';
  facts_cache.set(output, facts);
  return facts;
};

// How many of the preferences a run has
export const preferred_score = (output, prefer) => {
  if (!prefer.length) return 0;
  const facts = run_facts(output);
  let score = 0;
  for (const { key, value } of prefer) if (facts[key] === value) score++;
  return score;
};

// What a reference run has that another hasn't: the preferences that would pick it, e.g. [{ key: "platform", value: "arm" }]
export const preferences_for = (candidate, other) => {
  const mine = run_facts(candidate), theirs = run_facts(other);
  return Object.entries(mine).filter(([k, v]) => theirs[k] !== v).map(([key, value]) => ({ key, value }));
};

// How users read a fact: "platform = arm", "gain = 4", "sensor = imx766", "low-light"
export const fact_text = ({ key, value }) => {
  if (key.startsWith('config:')) return key.slice('config:'.length);
  const name = key.replace(/^(param|meta):/, '');
  return `${name} = ${value}`;
};
