// "Start from a previous batch": what the server remembers of the batches started from QA-Board (the submission's
// `request`, see backend/backend/submissions.py), described in a few words, and turned into what fills the form.
import { model_from_parameters, model_from_text, model_keys, count_combinations, count_runs } from './model';
import { prefill_form } from './prefill';

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** The batches a request ran, as names. Requests have them as a list, or older ones as text ("ci, night") */
export const request_batches = request => {
  const selected = request?.selected_group;
  if (Array.isArray(selected)) return selected.map(String);
  if (Array.isArray(request?.batches) && request.batches.length) return request.batches.map(String);
  return String(selected ?? '').split(',').map(name => name.trim()).filter(Boolean);
};

// The values a request tried: as people wrote them (a function) if we kept it, else as sent
const request_model = request => typeof request?.text === 'string' && request.text.trim()
  ? model_from_text(request.text)
  : model_from_parameters(request?.tuning_search?.parameter_search);

const is_kept = request => {
  const tuning_search = request?.tuning_search ?? {};
  return !(request?.truncated || request?.incomplete) || (tuning_search.parameter_search !== null && tuning_search.parameter_search !== undefined);
};

/** In a few words, the parameters a request tried: "threshold, kernel: 6 combinations" */
export const describe_request = request => {
  const tuning_search = request?.tuning_search ?? {};
  if (tuning_search.search_type === 'optimize') return 'Automated tuning';
  if (!is_kept(request)) return 'Many parameters (not kept)';
  const model = request_model(request);
  const keys = model_keys(model);
  if (!model.sets) return 'Values from a function';
  if (keys.length === 0) return 'No tuning';
  const combinations = count_combinations(model);
  const { combinations: tried } = count_runs({ combinations, tests: 1, search_type: tuning_search.search_type, n_iter: tuning_search.search_options?.n_iter });
  const shown = keys.length > 3 ? `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more` : keys.join(', ');
  return `${shown}: ${plural(tried, 'combination')}${tried < combinations ? ` of ${combinations}` : ''}`;
};

/**
 * What to put in the form to start like a previous batch: {form, missing}. `missing` says what we could not bring
 * back, if anything.
 */
export const form_from_request = (request, label = request?.batch_label) => {
  const tuning_search = request?.tuning_search ?? {};
  const common = { label: label ?? '', batches: request_batches(request), platform: request?.platform ?? undefined, overwrite: request?.overwrite !== false };
  if (tuning_search.search_type === 'optimize') {
    const yaml = typeof tuning_search.parameter_search === 'string' && tuning_search.parameter_search.trim() ? tuning_search.parameter_search : null;
    return {
      form: { ...prefill_form(common), search_type: 'optimize', ...(yaml ? prefill_form({ parameter_search_auto: yaml }) : {}) },
      missing: yaml ? null : "its automated tuning configuration: open its batch, Tuning Analysis has it",
    };
  }
  if (!is_kept(request))
    return { form: { ...prefill_form(common), search_type: tuning_search.search_type === 'sampler' ? 'sampler' : 'grid' }, missing: 'its parameters: there were too many to keep' };
  return {
    form: prefill_form({ ...common, model: request_model(request), search_type: tuning_search.search_type, search_options: tuning_search.search_options }),
    missing: null,
  };
};
