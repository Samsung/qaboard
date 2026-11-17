// Pairing runs on different inputs by their names, e.g. a register sweep's captures, street_reg0x1A=05.raw with
// street_reg0x1A=03.raw: users don't need ids in metadata (see the `pair` rules in src/matching/rules.js).
//
// Names are split in parts at the separators of the configurations' changes (string_separator), and shown like them:
// street_reg0x1A=[05 → 03]_g4.raw. A rule replaces whole parts: "reg0x1A=05" -> "reg0x1A=03" doesn't change "reg0x1A=055".

import { string_change, string_separator } from "../configurations/tokens";

const SEPARATORS = new RegExp(`(${string_separator.source}+)`);
const is_separator = c => c !== undefined && string_separator.test(c);

// Alternate parts and separators: "a/b_c" => ["a", "/", "b", "_", "c"]. Parts are at even indices.
export const split_name = name => name.split(SEPARATORS);

// Where two names differ, part by part: [{ index, from, to, before }], null when they aren't built alike (other
// separators, more parts). `before`: the unchanged part and separator before, e.g. "reg0x1A=" for "05" -> "03".
export const name_changes = (a, b) => {
  const A = split_name(a), B = split_name(b);
  if (A.length !== B.length) return null;
  const changes = [];
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) continue;
    if (i % 2) return null;
    changes.push({ index: i, from: A[i], to: B[i], before: i >= 2 && A[i - 2] === B[i - 2] ? A[i - 2] + A[i - 1] : '' });
  }
  return changes;
};

// A rule from a change: with the part before when there's one, "reg0x1A=05" is clearer and safer than "05"
export const rule_of_change = ({ from, to, before }) => ({ from: before + from, to: before + to });

// Where `text` is in `name` as whole parts
const whole_parts_at = (name, text) => {
  const at = [];
  if (!text) return at;
  for (let i = name.indexOf(text); i !== -1; i = name.indexOf(text, i + 1)) {
    const end = i + text.length;
    const starts = i === 0 || is_separator(name[i - 1]) || is_separator(text[0]);
    const ends = end === name.length || is_separator(name[end]) || is_separator(text[text.length - 1]);
    if (starts && ends) at.push(i);
  }
  return at;
};

// The name with the rules applied, null when none applies. Rules replace whole parts only: "reg0x1A=05" isn't in
// "reg0x1A=055", nor "05gain" in "reg05gain4". All rules apply to the name as it is: A → B and B → C don't make C of A.
// Where two rules match the same text, the first wins.
export const rename = (name, pairs) => {
  if (!name || !pairs?.length) return null;
  const replacements = [];
  for (const { from, to } of pairs) {
    if (!from || from === to) continue;
    for (const at of whole_parts_at(name, from)) {
      const end = at + from.length;
      if (replacements.some(r => at < r.end && end > r.at)) continue;
      replacements.push({ at, end, to });
    }
  }
  if (!replacements.length) return null;
  replacements.sort((a, b) => a.at - b.at);
  let out = '', last = 0;
  for (const r of replacements) {
    out += name.slice(last, r.at) + r.to;
    last = r.end;
  }
  out += name.slice(last);
  return out === name ? null : out;
};

// The name of the reference run a run is paired with by the rules: its own name when no rule applies
export const paired_name = (name, pairs) => rename(name, pairs) ?? name;

// "reg0x1A=05 → 03": the rule as text, cut at separators like the changes of settings (string_change)
export const rule_text = ({ from, to }) => {
  const { prefix, before, after, suffix } = string_change(from, to);
  return `${prefix}${before} → ${after}${suffix}`;
};

// How many runs a rule gives a reference run: their name with it is a reference run's
export const paired_by = (rule, outputs, index) =>
  outputs.filter(o => index.by_test_input_path.has(rename(o.test_input_path, [rule]))).length;

// ---------------------------------------------------------------------------- similar names

// Lookups of names with one part left out: names that differ by one part share a key.
// Built once per batch of reference runs, when needed (the runs without reference, the picker).
const one_part_keys = name => {
  const parts = split_name(name);
  const keys = [];
  for (let i = 0; i < parts.length; i += 2) {
    const saved = parts[i];
    parts[i] = '\u0000';
    keys.push(`${i}\u0001${parts.join('')}`);
    parts[i] = saved;
  }
  return keys;
};

// Names that share a key with more other names than this differ by a part that's in every name, like the scene in
// set_a/scene_12.raw: they're not "similar", and looking them up would compare every run with every reference run.
// We count names, not runs: a tuning batch has many runs per input.
const MAX_SIMILAR = 20;
const similar_indexes = new WeakMap();
// `index`: from index_outputs (src/matching/match.js), its outputs by position
const similar_index = index => {
  let similar = similar_indexes.get(index);
  if (similar) return similar;
  similar = new Map();
  index.outputs.forEach((o, position) => {
    if (!o.test_input_path) return;
    for (const key of one_part_keys(o.test_input_path)) {
      if (!similar.has(key)) similar.set(key, { names: new Set(), positions: [] });
      const entry = similar.get(key);
      entry.names.add(o.test_input_path);
      entry.positions.push(position);
    }
  });
  for (const [key, { names }] of similar) if (names.size > MAX_SIMILAR) similar.delete(key);
  similar_indexes.set(index, similar);
  return similar;
};

// The positions of the reference runs whose name differs from `name` by one part
export const similar_positions = (name, index) => {
  if (!name) return [];
  const similar = similar_index(index);
  const positions = new Set();
  for (const key of one_part_keys(name))
    for (const position of similar.get(key)?.positions ?? [])
      if (index.outputs[position].test_input_path !== name) positions.add(position);
  return [...positions].sort((a, b) => a - b);
};


// ---------------------------------------------------------------------------- suggestions

const SUGGESTED = 4;
// Parts of the batches' names, e.g. sweep-0x1A=05: a change from one to the other is likely what users compare
const parts_of = label => new Set(split_name(label ?? '').filter((_, i) => i % 2 === 0 && _));

// Rules that would give a reference to the runs without one: [{ rule, pairs }], the likeliest first. `pairs`: how many
// runs without reference it gives one (it may also change the reference of others, e.g. on the same input).
// `unmatched`: new runs without reference, `outputs`: all the new runs shown, `index`: the reference runs',
// `labels`: { new, reference } the batches' names, `pairs`: the rules users have already.
// Likeliest: those that pair the most runs, whose parts are in most of the runs' names (a register value, a sensor,
// rather than one scene's name), and whose parts are the batches' names.
export const suggest_pairs = ({ unmatched, outputs, index, labels = {}, pairs = [] }) => {
  if (!unmatched.length || !index.outputs.length) return [];
  const have = new Set(pairs.map(p => `${p.from}\u0000${p.to}`));
  const found = new Map();
  // enough runs to find the changes that pair many of them
  for (const o of unmatched.slice(0, 1000)) {
    const name = o.test_input_path;
    for (const position of similar_positions(name, index)) {
      const changes = name_changes(name, index.outputs[position].test_input_path);
      if (changes?.length !== 1) continue;
      const rule = rule_of_change(changes[0]);
      if (!rule.from || !rule.to) continue;
      const key = `${rule.from}\u0000${rule.to}`;
      if (have.has(key)) continue;
      const entry = found.get(key) ?? { rule, change: changes[0], runs: new Set() };
      entry.runs.add(o.id);
      found.set(key, entry);
    }
  }
  if (!found.size) return [];
  const new_parts = parts_of(labels.new), ref_parts = parts_of(labels.reference);
  const scored = [...found.values()]
    // the most runs first, before counting the others: there can be many changes, each one a scene's name
    .sort((a, b) => b.runs.size - a.runs.size)
    .slice(0, 20)
    .map(({ rule, change, runs }) => {
      const having = outputs.filter(o => whole_parts_at(o.test_input_path ?? '', rule.from).length).length;
      const paired = paired_by(rule, unmatched, index);
      const in_labels = new_parts.has(change.from) && ref_parts.has(change.to) ? 2 : 1;
      return { rule, pairs: paired, score: runs.size * (1 + having / Math.max(1, outputs.length)) * in_labels };
    });
  return scored
    .filter(s => s.pairs > 0)
    .sort((a, b) => b.score - a.score || b.pairs - a.pairs)
    .slice(0, SUGGESTED)
    .map(({ rule, pairs }) => ({ rule, pairs }));
};
