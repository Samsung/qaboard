// "Start from a previous batch": what the server remembers of the batches started from QA-Board (their `request`),
// and how it fills Run Tests / Tuning again.
import { format_parameters, parse_sets, set_combinations } from "./parameters";

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** The batches a request ran, as the form remembers them: "ci, night-*" */
export const request_batches = request => Array.isArray(request?.batches) && request.batches.length > 0
  ? request.batches.join(', ')
  : String(request?.selected_group ?? '');

/** The text of "Choose the values" for a request: what the user wrote if we have it (e.g. a function), else JSON */
export const request_text = request => typeof request?.text === 'string' && request.text.trim()
  ? request.text
  : format_parameters(request?.tuning_search?.parameter_search);

/** In a few words, the parameters a request tried: "threshold, kernel: 6 combinations" */
export const describe_request = request => {
  const tuning_search = request?.tuning_search ?? {};
  if (tuning_search.search_type === 'optimize') return 'Automated tuning';
  if (request?.truncated && (tuning_search.parameter_search === null || tuning_search.parameter_search === undefined)) return 'Many parameters (not kept)';
  const { sets } = parse_sets(format_parameters(tuning_search.parameter_search));
  const names = [...new Set((sets ?? []).flatMap(rows => rows.map(row => row.name)))];
  if (names.length === 0) return 'No tuning';
  const combinations = sets.reduce((total, rows) => total + set_combinations(rows), 0);
  const n_iter = tuning_search.search_options?.n_iter;
  const tried = tuning_search.search_type === 'sampler' && n_iter > 0 ? Math.min(n_iter, combinations) : combinations;
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  return `${shown}: ${plural(tried, 'combination')}${tried < combinations ? ` of ${combinations}` : ''}`;
};

/**
 * What to put in the form (stores/prefs.js `tuning[project]`) to start like a previous batch.
 * Returns {form, missing}: `missing` says what we could not bring back, if anything.
 */
export const form_from_request = request => {
  const tuning_search = request?.tuning_search ?? {};
  const is_optimize = tuning_search.search_type === 'optimize';
  const form = {
    experiment_name: String(request?.batch_label ?? ''),
    selected_group: request_batches(request),
    overwrite: request?.overwrite !== false,
    search_type: ['grid', 'sampler', 'optimize'].includes(tuning_search.search_type) ? tuning_search.search_type : 'grid',
  };
  if (request?.platform) form.platform = request.platform;
  if (tuning_search.search_type === 'sampler' && tuning_search.search_options?.n_iter > 0)
    form.search_options = { n_iter: tuning_search.search_options.n_iter };
  let missing = null;
  if (is_optimize) {
    if (typeof tuning_search.parameter_search === 'string' && tuning_search.parameter_search.trim()) form.parameter_search_auto = tuning_search.parameter_search;
    else missing = "its automated tuning configuration: open its batch, Tuning Analysis has it";
  } else {
    if (request?.truncated && (tuning_search.parameter_search === null || tuning_search.parameter_search === undefined)) missing = 'its parameters: there were too many to keep';
    else form.parameter_search = request_text(request);
  }
  return { form, missing };
};
