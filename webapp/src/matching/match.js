// Which reference run each run is compared with.
//
// Without rules, it's what the backend does for `qa gate` and the API (backend/backend/compare.py, `matching_output`):
// the same input, else the same metadata.id, then the closest settings and the same platform. Both are tested against
// tests/fixtures/metrics-compare.json (src/utils/__tests__/compare.test.jsx): change one, change the other.
// With the rules users add on the commit page (src/matching/rules.js), the web app can pair runs by name, prefer some
// reference runs, or pin one. The backend doesn't know them: to port them, port names.js's `rename`, rules.js's
// `run_facts` and the pins to qaboard/matching.py, with a shared fixture like metrics-compare.json.
import { config_distance } from "../configurations/tokens";
import { name_changes, paired_name, rule_of_change, similar_positions } from "./names";
import { add_rules, preferences_for, preferred_score, without_pin } from "./rules";

const empty_output = { metrics: undefined, extra_parameters: {} };

// How different a reference run is, high => more different
const match_score = (output, o) =>
  8 * ((o.input_path !== output.input_path) | 0) +
  4 * ((o.configurations_str !== output.configurations_str) | 0) +
  2 * ((o.platform !== output.platform) | 0) +
  1 * ((o.extra_parameters_str !== output.extra_parameters_str) | 0);
const mismatch_of = (o, score) => ({
  test_input_path: score & 8 ? o.test_input_path : null,
  configurations: score & 4 ? o.configurations : null,
  platform: score & 2 ? o.platform : null,
  extra_parameters: score & 1 ? o.extra_parameters : null,
});

// Kinds of reference runs, the likeliest first: paired by users' name rules, on the same input, with the same
// metadata.id. "similar" names are only offered in the picker.
const RANK = { pair: 0, input: 1, id: 2, similar: 3 };
const SAME_RUN = Object.freeze({ by: 'input', others: 0, tied: 0, preferred: false });

// The order of the reference runs that could do. Without rules (no pair, no preference), it's compare.py's sort_key:
// the same input first (rank), then the closest configuration, tuning parameters, and the same platform.
// `preferences`: false to order them as if users had none
const closer = (output, { preferences = true } = {}) => (a, b) =>
  (a.rank - b.rank) ||
  (preferences ? b.preferred - a.preferred : 0) ||
  (a.dist_configurations - b.dist_configurations) ||
  (a.dist_extra_parameters - b.dist_extra_parameters) ||
  ((b.o.platform === output.platform) - (a.o.platform === output.platform)) ||
  // like Python's stable sort, ties keep the order of the reference runs
  (a.position - b.position);

const candidates_of = (output, index, renamed_positions, prefer) => {
  const renamed = new Set(renamed_positions);
  const positions = new Set([
    ...renamed_positions,
    ...(index.by_input_path.get(output.input_path) ?? []),
    ...(index.by_test_input_path.get(output.test_input_path) ?? []),
    ...((output.test_input_metadata?.id && index.by_metadata_id.get(output.test_input_metadata.id)) || []),
  ]);
  const candidates = [...positions].map(position => {
    const o = index.outputs[position];
    const same_input = o.input_path === output.input_path || o.test_input_path === output.test_input_path;
    const kind = renamed.has(position) ? 'pair' : same_input ? 'input' : 'id';
    return {
      o,
      position,
      kind,
      rank: RANK[kind],
      preferred: preferred_score(o, prefer),
      dist_configurations: config_distance(o.configurations, output.configurations),
      dist_extra_parameters: config_distance(o.extra_parameters, output.extra_parameters),
    };
  });
  return candidates.sort(closer(output));
};

const renamed_positions_of = (output, index, pairs) => {
  if (!pairs.length) return [];
  const renamed = paired_name(output.test_input_path, pairs);
  return renamed !== output.test_input_path ? index.by_test_input_path.get(renamed) ?? [] : [];
};

// Finds the reference output that best matches an output: { output_ref, mismatch, match }.
// Pass an index made with index_outputs(batch) when matching many outputs against the same batch.
// `rules`: what users changed, { pairs, prefer, pins } (src/matching/rules.js).
// `mismatch`: how the reference run differs, compared with the backend's. Its `alternatives` are the reference runs as
// close, only when there are some.
// `match`: how we found it, for the run cards: { by: 'pin' | 'pair' | 'input' | 'id', others: how many more could do,
// tied: mismatch.alternatives, preferred: the preferences changed the pick }, null without reference run.
export const matching_output = ({ output, batch, index, rules }) => {
  index = index ?? index_outputs(batch);
  const pairs = rules?.pairs ?? [], prefer = rules?.prefer ?? [];

  const pinned = rules?.pins?.[output.id];
  const pinned_position = pinned !== undefined ? index.by_id.get(String(pinned)) : undefined;
  if (pinned_position !== undefined) {
    const o = index.outputs[pinned_position];
    const score = match_score(output, o);
    return { output_ref: o, mismatch: score > 0 ? mismatch_of(o, score) : null, match: { by: 'pin', others: 0, tied: 0, preferred: false } };
  }

  const renamed_positions = renamed_positions_of(output, index, pairs);
  // Most of the time there's an identical run: no need to measure how different the others are
  if (!renamed_positions.length && !prefer.length) {
    const exact = index.exact.get(run_key(output));
    if (exact !== undefined)
      return { output_ref: index.outputs[exact], mismatch: null, match: SAME_RUN };
  }

  const candidates = candidates_of(output, index, renamed_positions, prefer);
  const best = candidates[0];
  if (!best) return { output_ref: empty_output, mismatch: null, match: null };
  const score = match_score(output, best.o);
  const mismatch = score > 0 ? mismatch_of(best.o, score) : null;
  const alternatives = mismatch ? count_alternatives(candidates, output) : 0;
  if (alternatives > 0) mismatch.alternatives = alternatives;
  const preferred = best.preferred > 0 && candidates.reduce((a, c) => closer(output, { preferences: false })(c, a) < 0 ? c : a) !== best;
  return { output_ref: best.o, mismatch, match: { by: best.kind, others: candidates.length - 1, tied: alternatives, preferred } };
};

// How many other reference runs are as close as the one we picked: as many different settings, only how similar
// their values are (the distances' fractional part) made us choose. Runs on other inputs count: e.g. two reference
// shots with the same metadata.id and settings, we take the first.
const count_alternatives = (candidates, output) => {
  const [best] = candidates;
  const same = (a, b) => Math.floor(a) === Math.floor(b);
  const key = c => `${c.o.input_path}\u0000${c.o.configurations_str}\u0000${c.o.extra_parameters_str}`;
  const runs = new Set();
  for (const c of candidates.slice(1)) {
    if (c.rank !== best.rank || c.preferred !== best.preferred) continue;
    if ((c.o.platform === output.platform) !== (best.o.platform === output.platform)) continue;
    if (!same(c.dist_configurations, best.dist_configurations) || !same(c.dist_extra_parameters, best.dist_extra_parameters)) continue;
    if (key(c) === key(best)) continue;
    runs.add(key(c));
  }
  return runs.size;
};

// All the reference runs users can pick for a run, the likeliest first, for the reference picker:
// [{ o, kind: 'pair' | 'input' | 'id' | 'similar', ... }]. "similar": their name differs by one part (src/matching/names.js).
export const reference_candidates = ({ output, batch, index, rules }) => {
  index = index ?? index_outputs(batch);
  const pairs = rules?.pairs ?? [], prefer = rules?.prefer ?? [];
  const candidates = candidates_of(output, index, renamed_positions_of(output, index, pairs), prefer);
  const seen = new Set(candidates.map(c => c.o));
  const similar = similar_positions(paired_name(output.test_input_path, pairs), index)
    .filter(position => !seen.has(index.outputs[position]))
    .map(position => {
      const o = index.outputs[position];
      return { o, position, kind: 'similar', rank: RANK.similar, preferred: preferred_score(o, prefer), dist_configurations: config_distance(o.configurations, output.configurations), dist_extra_parameters: 0 };
    })
    .sort(closer(output));
  return [...candidates, ...similar];
};

// The rules that would compare every run like this one with a reference run like `candidate`: { added, rules }, null
// when there are none, and the pick is for this run only (a pin).
// For a name: its changes from the run's name. Else what it has that the reference run of now (`current`) hasn't, e.g.
// the other shot of a scene with the same metadata.id. Only rules that make this run compare with the candidate.
export const rules_for_all = ({ output, candidate, current, rules, index }) => {
  let added = null;
  if (candidate.kind === 'similar' || candidate.kind === 'pair' || !current) {
    const changes = name_changes(output.test_input_path ?? '', candidate.o.test_input_path ?? '');
    if (changes?.length && changes.length <= 2 && changes.every(c => c.from && c.to))
      added = { pairs: changes.map(rule_of_change), prefer: [] };
  } else {
    const prefer = preferences_for(candidate.o, current);
    if (prefer.length) added = { pairs: [], prefer };
  }
  if (!added) return null;
  const next = add_rules(without_pin(rules, output.id), added);
  return matching_output({ output, index, rules: next }).output_ref === candidate.o ? { added, rules: next } : null;
};

const run_key = o => `${o.input_path}\u0000${o.configurations_str}\u0000${o.extra_parameters_str}\u0000${o.platform}`;

// Lookups by input, for the outputs of a batch that are shown and not pending
export const index_outputs = batch => {
  const outputs = (batch.filtered?.outputs ?? Object.keys(batch.outputs ?? {}))
    .map(id => batch.outputs[id])
    .filter(o => !!o && !o.is_pending);
  const by_input_path = new Map();
  const by_test_input_path = new Map();
  const by_metadata_id = new Map();
  const by_id = new Map();
  const exact = new Map();
  const add = (map, key, i) => {
    if (key === undefined || key === null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  };
  outputs.forEach((o, i) => {
    add(by_input_path, o.input_path, i);
    add(by_test_input_path, o.test_input_path, i);
    if (o.test_input_metadata?.id) add(by_metadata_id, o.test_input_metadata.id, i);
    by_id.set(String(o.id), i);
    if (!exact.has(run_key(o))) exact.set(run_key(o), i);
  });
  return { outputs, by_input_path, by_test_input_path, by_metadata_id, by_id, exact };
};

// Whether a run can be compared with a reference run: not pending, not a tuning iteration nor a batch's own run
export const can_have_reference = output =>
  !output.is_pending && output.output_type !== 'optim_iteration' && output.output_type !== 'batch';
