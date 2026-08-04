// The auto-tuning configuration dialect, as understood by the web UI.
//
// This mirrors the reference parser in qaboard/optimization.py -- same shapes, same
// error messages -- so users see problems while typing instead of after submitting.
// Pure logic, no React: it is also exercised directly by node in tests.
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

export const DIMENSION_KINDS = ['Integer', 'Real', 'Categorical'];
export const SAMPLERS = [
  { value: 'gp', label: 'Gaussian processes (best for expensive runs)' },
  { value: 'tpe', label: 'TPE (scales to many parameters)' },
  { value: 'random', label: 'Random search (baseline)' },
];

export const parseOptimizeConfig = text => {
  try {
    const config = yamlLoad(text);
    if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config))
      return { config: null, parse_error: 'The configuration must be a YAML mapping.' };
    return { config, parse_error: null };
  } catch (e) {
    return { config: null, parse_error: e.message };
  }
};

const isPositiveInt = x => Number.isInteger(x) && x > 0;

// Returns a list of user-facing error strings, [] when the config is valid.
export const validateOptimizeConfig = config => {
  const errors = [];
  if (!config) return ['The configuration could not be parsed.'];

  if (config.objective === undefined)
    errors.push('The configuration must provide an `objective`.');
  const objective_metrics = objectiveMetrics(config);
  if (config.objective !== undefined && objective_metrics.length === 0)
    errors.push('The `objective` must include at least one metric.');

  if (config.evaluations === undefined)
    errors.push('The configuration must provide an `evaluations` budget.');
  else if (!isPositiveInt(config.evaluations))
    errors.push(`\`evaluations\` must be a positive integer, got \`${JSON.stringify(config.evaluations)}\`.`);

  if (config.parallel_sampling !== undefined && !isPositiveInt(config.parallel_sampling))
    errors.push(`\`parallel_sampling\` must be a positive integer, got \`${JSON.stringify(config.parallel_sampling)}\`.`);

  const patience = typeof config.early_stopping === 'object' && config.early_stopping !== null
    ? config.early_stopping.patience : config.early_stopping;
  if (patience !== undefined && patience !== null && !isPositiveInt(patience))
    errors.push(`\`early_stopping.patience\` must be a positive integer, got \`${JSON.stringify(patience)}\`.`);

  if (config.pareto !== undefined && typeof config.pareto !== 'boolean')
    errors.push(`\`pareto\` must be true or false, got \`${JSON.stringify(config.pareto)}\`.`);
  if (config.pareto === true && objective_metrics.length < 2)
    errors.push('`pareto: true` needs at least two metrics in the `objective`.');
  if (config.pareto === true && objective_metrics.length > 3)
    errors.push('`pareto: true` supports at most three objective metrics.');

  if (config.solver !== undefined && config.solver !== null) {
    const legacy = {
      base_estimator: 'use `sampler: gp` or `sampler: tpe`',
      n_initial_points: 'renamed to `n_startup_trials`',
      random_state: 'renamed to `seed`',
      acq_func: 'acquisition functions are not configurable anymore',
      acq_funcstring: 'acquisition functions are not configurable anymore',
    };
    Object.keys(config.solver).forEach(key => {
      if (legacy[key] !== undefined)
        errors.push(`\`solver.${key}\` was a scikit-optimize setting and is not supported anymore: ${legacy[key]}.`);
    });
    const sampler = config.solver.sampler;
    if (sampler !== undefined && !SAMPLERS.some(s => s.value === sampler))
      errors.push(`Unknown \`solver.sampler: ${sampler}\`. Expected one of: ${SAMPLERS.map(s => s.value).join(', ')}.`);
  }

  errors.push(...validateSearchSpace(config.search_space));
  return errors;
};

export const validateSearchSpace = search_space => {
  const errors = [];
  if (search_space === undefined || search_space === null || (Array.isArray(search_space) && search_space.length === 0)) {
    errors.push('The configuration must provide a non-empty `search_space`.');
    return errors;
  }
  if (!Array.isArray(search_space)) {
    errors.push('`search_space` must be a list of dimensions, each written as `- Integer:`, `- Real:` or `- Categorical:`.');
    return errors;
  }
  const names = new Set();
  search_space.forEach((dimension, index) => {
    const at = `search_space[${index}]`;
    if (typeof dimension !== 'object' || dimension === null || Object.keys(dimension).length !== 1) {
      errors.push(`${at} must be a single-key mapping, one of: ${DIMENSION_KINDS.join(', ')}.`);
      return;
    }
    const kind = Object.keys(dimension)[0];
    const options = dimension[kind];
    if (!DIMENSION_KINDS.includes(kind)) {
      errors.push(`${at} has unknown dimension type \`${kind}\`. Expected one of: ${DIMENSION_KINDS.join(', ')}.`);
      return;
    }
    if (typeof options !== 'object' || options === null) {
      errors.push(`${at} (\`${kind}\`) must be a mapping with at least a \`name\`.`);
      return;
    }
    const name = options.name;
    if (!name) {
      errors.push(`${at} (\`${kind}\`) is missing a \`name\`.`);
      return;
    }
    if (names.has(name))
      errors.push(`\`${name}\` is defined more than once in the search space.`);
    names.add(name);
    const here = `\`${name}\``;

    if (kind === 'Categorical') {
      if (!options.categories || !Array.isArray(options.categories) || options.categories.length === 0)
        errors.push(`${here} is missing its \`categories\`.`);
      return;
    }
    if (options.low === undefined || options.high === undefined) {
      errors.push(`${here} needs both \`low\` and \`high\` bounds.`);
      return;
    }
    if (typeof options.low !== 'number' || typeof options.high !== 'number') {
      errors.push(`${here} expects numbers for \`low\` and \`high\`.`);
      return;
    }
    if (options.low >= options.high)
      errors.push(`${here} has \`low\` (${options.low}) >= \`high\` (${options.high}).`);
    const prior = options.prior;
    if (prior !== undefined && prior !== 'uniform' && prior !== 'log-uniform')
      errors.push(`${here} has unknown \`prior: ${prior}\`. Expected \`uniform\` or \`log-uniform\`.`);
    if (prior === 'log-uniform' && options.low <= 0)
      errors.push(`${here} uses \`prior: log-uniform\`, so \`low\` (${options.low}) must be > 0.`);
  });
  return errors;
};

export const objectiveMetrics = config =>
  Object.keys(config?.objective || {}).filter(m => m !== 'target');

// Serialize back to YAML in a stable, readable order.
// Only meaningful sections are written: defaults stay implicit.
export const serializeOptimizeConfig = config => {
  const ordered = {};
  if (config.evaluations !== undefined) ordered.evaluations = config.evaluations;
  if (config.parallel_sampling !== undefined && config.parallel_sampling !== 1)
    ordered.parallel_sampling = config.parallel_sampling;
  if (config.early_stopping !== undefined && config.early_stopping !== null)
    ordered.early_stopping = config.early_stopping;
  if (config.pareto === true) ordered.pareto = true;
  if (config.resume === false) ordered.resume = false;
  if (config.solver !== undefined && config.solver !== null && Object.keys(config.solver).length > 0)
    ordered.solver = config.solver;
  if (config.objective !== undefined) ordered.objective = config.objective;
  if (config.preset_params !== undefined && config.preset_params !== null && Object.keys(config.preset_params).length > 0)
    ordered.preset_params = config.preset_params;
  ordered.search_space = config.search_space || [];
  // any section this UI does not know about is kept as-is
  Object.keys(config).forEach(key => {
    if (ordered[key] === undefined
        && !['evaluations', 'parallel_sampling', 'early_stopping', 'pareto', 'resume', 'solver', 'objective', 'preset_params', 'search_space'].includes(key))
      ordered[key] = config[key];
  });
  return yamlDump(ordered, { noRefs: true, lineWidth: 120 });
};

// ---- form-friendly edits, all immutable ----

export const defaultDimension = kind => {
  if (kind === 'Categorical') return { Categorical: { name: '', categories: [] } };
  if (kind === 'Integer') return { Integer: { name: '', low: 1, high: 100 } };
  return { Real: { name: '', low: 0.0, high: 1.0 } };
};

export const updateDimension = (search_space, index, kind, options) =>
  search_space.map((dimension, i) => (i === index ? { [kind]: options } : dimension));

export const addDimension = (search_space, kind) => [...(search_space || []), defaultDimension(kind)];

export const removeDimension = (search_space, index) => search_space.filter((_, i) => i !== index);

// Change a dimension's type, carrying over what makes sense (the name, the bounds)
export const changeDimensionKind = (search_space, index, new_kind) => {
  const [old_kind] = Object.keys(search_space[index]);
  const old_options = search_space[index][old_kind];
  const fresh = defaultDimension(new_kind)[new_kind];
  const options = { ...fresh, name: old_options.name || '' };
  if (new_kind !== 'Categorical' && old_kind !== 'Categorical') {
    if (old_options.low !== undefined) options.low = old_options.low;
    if (old_options.high !== undefined) options.high = old_options.high;
    if (old_options.prior !== undefined) options.prior = old_options.prior;
  }
  return updateDimension(search_space, index, new_kind, options);
};
