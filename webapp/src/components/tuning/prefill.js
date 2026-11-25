// The one way to fill Run Tests / Tuning from elsewhere: a previous batch (Start from a previous batch), a run's
// parameters (Run these parameters on more tests), the best parameters of a tuning (Tuning Analysis).
// It takes plain data and returns what to put in the form's stored state (stores/prefs.js, `tuning[project]`).
import { model_to_text } from './model';

/**
 * Only what is given changes: e.g. without `batches`, the form keeps the tests it had.
 * - `model`: the values to try (model.js); for "Choose the values"
 * - `parameter_search_auto`: an automated tuning's configuration (YAML); for "Search automatically"
 * - `batches`: the names of the batches to run
 * - `search_type`: 'grid' (every combination) or 'sampler' (a random sample of `search_options.n_iter`)
 */
export const prefill_form = ({ label, batches, model, search_type, search_options, parameter_search_auto, platform, overwrite, batches_snapshot }) => {
  const patch = {};
  if (label !== undefined) patch.experiment_name = String(label ?? '');
  // the batches are stored as people would type them: "ci, night-*"
  if (batches !== undefined) patch.selected_group = batches.join(', ');
  if (platform) patch.platform = platform;
  if (typeof overwrite === 'boolean') patch.overwrite = overwrite;
  if (batches_snapshot !== undefined) patch.batches_snapshot = batches_snapshot;
  if (typeof parameter_search_auto === 'string') {
    patch.search_type = 'optimize';
    patch.parameter_search_auto = parameter_search_auto;
  } else if (model) {
    patch.search_type = search_type === 'sampler' ? 'sampler' : 'grid';
    patch.parameter_search = model_to_text(model);
    // the table when it can show them
    patch.values_mode = model.sets ? 'table' : 'text';
    if (search_type === 'sampler' && search_options?.n_iter > 0) patch.search_options = { n_iter: search_options.n_iter };
  }
  return patch;
};
