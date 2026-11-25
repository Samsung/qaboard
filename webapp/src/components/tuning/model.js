// "Choose the values" of Run Tests / Tuning: the one model of the parameters to try, and its conversions.
//
// A row is {key, mode, values}: the parameter as the code reads it, how to try it ('values': each value, in every
// combination with the other rows of its set), and the values. A set is a list of rows: every combination of its
// values runs. Several sets run one after the other ("values that go together").
// The model is {sets: [[row]]}, or, for text the table can't show (a function, invalid JSON), {sets: null, text, reason}.
//
// The form stores the text (what the JSON editor shows), the table edits the model: they are two views of it.
// The server gets `tuning_search.parameter_search`: {key: [values]}, or a list of those (model_to_parameters).
import { compact_json } from './values';

const is_object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wrap = value => Array.isArray(value) ? value : [value];

export const row = (key = '', values = []) => ({ key, mode: 'values', values });
export const empty_model = () => ({ sets: [[]] });

// A function that returns the parameters, like the text editor always accepted: run when the text isn't JSON
const run_function = text => {
  try {
    return Function(text)();
  } catch {
    return undefined;
  }
};

const sets_of = parameters => (Array.isArray(parameters) ? parameters : [parameters])
  .filter(is_object)
  .map(set => Object.entries(set).map(([key, values]) => row(key, wrap(values))));

/**
 * The model from the parameters as the server gets them, or as a run has them (its flat `{key: value}`):
 * {key: value or [values]}, or a list of those. null or {} is no tuning.
 */
export const model_from_parameters = parameters => {
  if (parameters === null || parameters === undefined) return empty_model();
  if (!is_object(parameters) && !(Array.isArray(parameters) && parameters.every(is_object))) return { sets: null, text: JSON.stringify(parameters), reason: 'invalid' };
  const sets = sets_of(parameters);
  return { sets: sets.length ? sets : [[]] };
};

/**
 * The model from the parameters one run used, {key: value}: each value is one value, lists included (a matrix, a
 * gain table). For "Run these parameters on more tests", and the best parameters of a tuning.
 */
export const model_from_values = values => {
  if (!is_object(values)) return empty_model();
  const rows = Object.entries(values).map(([key, value]) => row(key, [value]));
  return { sets: [rows] };
};

/** The model from the text people see and edit. Functions and invalid JSON stay text: {sets: null, text, reason} */
export const model_from_text = text => {
  if (!text || !String(text).trim()) return empty_model();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const result = run_function(text);
    return { sets: null, text, reason: is_object(result) || Array.isArray(result) ? 'function' : 'invalid' };
  }
  const model = model_from_parameters(parsed);
  return model.sets ? model : { ...model, text };
};

// The rows that say something: a key and values to try
export const filled_rows = rows => rows.filter(r => r.key.trim() && r.values.length > 0);

const format_row = r => `${JSON.stringify(r.key.trim())}: ${compact_json(r.values)}`;
const format_set = (rows, indent) => rows.length === 0
  ? '{}'
  : `{\n${rows.map(r => `${indent}  ${format_row(r)}`).join(',\n')}\n${indent}}`;

/** The text for the model: one line per parameter. Rows without a key or values are left out. */
export const model_to_text = model => {
  if (!model?.sets) return model?.text ?? '';
  const filled = model.sets.map(filled_rows).filter(rows => rows.length > 0);
  if (filled.length === 0) return '';
  if (filled.length === 1) return format_set(filled[0], '');
  return `[\n${filled.map(rows => `  ${format_set(rows, '  ')}`).join(',\n')}\n]`;
};

/**
 * What the server gets as `tuning_search.parameter_search`: {key: [values]}, a list of them, {} for no tuning, or
 * null when the text is invalid (a function is run, like before).
 */
export const model_to_parameters = model => {
  if (!model?.sets) {
    if (model?.reason !== 'function') return null;
    const result = run_function(model.text);
    if (Array.isArray(result) && result.every(is_object)) return result.map(set => Object.fromEntries(Object.entries(set).map(([k, v]) => [k, wrap(v)])));
    if (is_object(result)) return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, wrap(v)]));
    return null;
  }
  const sets = model.sets.map(filled_rows).filter(rows => rows.length > 0)
    .map(rows => Object.fromEntries(rows.map(r => [r.key.trim(), r.values])));
  if (sets.length === 0) return {};
  return sets.length === 1 ? sets[0] : sets;
};

/** The parameters' keys, in the order they appear */
export const model_keys = model => [...new Set((model?.sets ?? []).flatMap(rows => filled_rows(rows).map(r => r.key.trim())))];

/** How many combinations of a set's rows: 1 without parameters */
export const set_combinations = rows => filled_rows(rows).reduce((total, r) => total * r.values.length, 1);

/** How many parameter sets the model tries: a number, or null when the text is invalid */
export const count_combinations = model => {
  const parameters = model?.sets ? null : model_to_parameters(model);
  if (!model?.sets && parameters === null) return null;
  const sets = model?.sets
    ? model.sets.filter(rows => filled_rows(rows).length > 0)
    : sets_of(parameters);
  if (sets.length === 0) return 1;
  return sets.reduce((total, rows) => total + set_combinations(rows), 0);
};

/**
 * How many runs start: each test runs with each parameter set. A random sample tries `n_iter` sets at most.
 * {combinations, runs}, both null when the parameters are invalid. An automated tuning's count is its own (OptimizeSetup).
 */
export const count_runs = ({ combinations, tests, search_type = 'grid', n_iter }) => {
  if (combinations === null || combinations === undefined) return { combinations: null, runs: null };
  const tried = search_type === 'sampler' && Number.isFinite(n_iter) && n_iter >= 0 ? Math.min(n_iter, combinations) : combinations;
  return { combinations: tried, runs: tried * tests };
};
