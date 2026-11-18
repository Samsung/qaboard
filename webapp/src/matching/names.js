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

// The change that makes name `a` into `b` as one rule on whole parts, { from, to }, for names that aren't built alike
// (name_changes gives up: another folder depth, other separators) or differ in many parts: what's between their common
// end and start. The common end first, since file names usually stay while folders move: "run1/street.raw" and
// "run1/sub/street.raw" give "run1 → run1/sub". With nothing between, it takes the part before, else the one after.
// null when there's no such rule: the same names, an empty part at an end ("/a/b" and "x/a/b"), or a rule that would
// also change another place of the name.
export const name_rewrite = (a, b) => {
  if (!a || !b || a === b) return null;
  const A = split_name(a), B = split_name(b);
  let s = 0;
  while (s < A.length && s < B.length && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  let p = 0;
  while (p < A.length - s && p < B.length - s && A[p] === B[p]) p++;
  // start at a part, end after one: parts are at even indices, names start and end with one
  p -= p % 2;
  s -= s % 2;
  const whole = (T, start, end) => end > start && T[start] !== '' && T[end - 1] !== '';
  while (!whole(A, p, A.length - s) || B.length - s <= p) {
    if (p >= 2) p -= 2;
    else if (s >= 2) s -= 2;
    else return null;
  }
  const rule = { from: A.slice(p, A.length - s).join(''), to: B.slice(p, B.length - s).join('') };
  return rename(a, [rule]) === b ? rule : null;
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


// ---------------------------------------------------------------------------- the same file in another folder

// Names whose file (the last part after a folder) is in more reference runs' names than this are no clue, e.g. frame_0001.png
const MAX_SAME_FILE = 20;
const file_of = name => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
const file_indexes = new WeakMap();
const file_index = index => {
  let files = file_indexes.get(index);
  if (files) return files;
  files = new Map();
  index.outputs.forEach((o, position) => {
    if (!o.test_input_path) return;
    const file = file_of(o.test_input_path);
    if (!files.has(file)) files.set(file, { names: new Set(), positions: [] });
    files.get(file).names.add(o.test_input_path);
    files.get(file).positions.push(position);
  });
  for (const [file, { names }] of files) if (names.size > MAX_SAME_FILE) files.delete(file);
  file_indexes.set(index, files);
  return files;
};

// The positions of the reference runs with the same file name in other folders: "dataset_v1/street.raw" and
// "datasets/v2/street.raw". Only for names in folders.
export const same_file_positions = (name, index) => {
  if (!name || file_of(name) === name) return [];
  return (file_index(index).get(file_of(name))?.positions ?? []).filter(position => index.outputs[position].test_input_path !== name);
};


// ---------------------------------------------------------------------------- every name, the closest first

// The parts of each reference run's name, to find the closest names to any other. Built once per batch of reference
// runs, when users search them all (the picker): a run per name in a tuning batch, many runs per name in others.
const name_indexes = new WeakMap();
const name_index = index => {
  let names = name_indexes.get(index);
  if (names) return names;
  const by_name = new Map();
  index.outputs.forEach((o, position) => {
    const name = o.test_input_path ?? '';
    if (!by_name.has(name)) by_name.set(name, { name, parts: name_parts(name), positions: [] });
    by_name.get(name).positions.push(position);
  });
  names = [...by_name.values()];
  name_indexes.set(index, names);
  return names;
};
const name_parts = name => new Set(split_name(name.toLowerCase()).filter((part, i) => i % 2 === 0 && part));

// How many characters two names share at their start and end
const common_ends = (a, b) => {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return p + s;
};

// All the reference runs' names, the closest to `name` first: [{ name, likeness, positions }]. `likeness`: the share of
// their parts in common, from 0 to 1, case-insensitive. Ties: the most characters in common at the start and end.
// Linear in the number of names: ~10ms for 100k (the picker computes it once, when opened or when users search).
export const names_by_likeness = (name, index) => {
  const mine = name_parts(name ?? '');
  return name_index(index)
    .map(n => {
      let shared = 0;
      for (const part of mine) if (n.parts.has(part)) shared++;
      const union = mine.size + n.parts.size - shared;
      return { name: n.name, positions: n.positions, likeness: union ? shared / union : 0, common: common_ends(name ?? '', n.name) };
    })
    .sort((a, b) => b.likeness - a.likeness || b.common - a.common || a.positions[0] - b.positions[0]);
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
    const similar = similar_positions(name, index);
    const found_similar = similar.length > 0;
    for (const position of similar) {
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
    // names not built alike, like the same files in another folder: "v1/street.raw" and "datasets/v2/street.raw"
    if (found_similar) continue;
    for (const position of same_file_positions(name, index)) {
      const rule = name_rewrite(name, index.outputs[position].test_input_path);
      if (!rule) continue;
      const key = `${rule.from}\u0000${rule.to}`;
      if (have.has(key)) continue;
      const entry = found.get(key) ?? { rule, change: rule, runs: new Set() };
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
