// The automated tuning's configuration, as the guided form edits it. Pure functions, for OptimizeSetup.jsx.
//
// The YAML text stays the source of truth: it is what users can also edit by hand, what is sent to the server, and what
// `qa optimize` reads. The form reads it, and edits it in place with yaml's Document API: comments users wrote are kept.
// The checks mirror qaboard/optimization.py, with the same messages: the server checks again before starting, and its
// messages for the same problems are then the same, so the form shows them once.
import { parseDocument, isSeq } from "yaml";
import { with_undeclared_metrics } from "../../utils";

export const KINDS = ['Real', 'Integer', 'Categorical'];
export const KIND_LABELS = { Real: 'Number', Integer: 'Whole number', Categorical: 'Choice' };
export const SAMPLERS = ['auto', 'gp', 'tpe', 'random'];
const DOCS = "https://samsung.github.io/qaboard/docs/auto-optimization";
const LEGACY_SOLVER_KEYS = {
  base_estimator: "choose a `sampler` instead: `gp` (Gaussian processes), `tpe` or `random`",
  n_initial_points: "it is called `n_startup_trials` now",
  random_state: "it is called `seed` now",
  acq_func: "the acquisition function is not configurable anymore",
  acq_funcstring: "the acquisition function is not configurable anymore",
  acq_optimizer: "it is not configurable anymore",
  acq_func_kwargs: "it is not configurable anymore",
  acq_optimizer_kwargs: "it is not configurable anymore",
  n_restarts_optimizer: "it is not configurable anymore",
  n_jobs: "use `parallel_sampling` to evaluate several parameters at once",
  xi: "it is not configurable anymore",
  kappa: "it is not configurable anymore",
};

const is_int = x => typeof x === 'number' && Number.isInteger(x);
const is_num = x => typeof x === 'number' && Number.isFinite(x);
const is_map = x => x !== null && typeof x === 'object' && !Array.isArray(x);
// how Python prints values in messages
const py = x => x === null || x === undefined ? 'None' : typeof x === 'boolean' ? (x ? 'True' : 'False') : typeof x === 'object' ? JSON.stringify(x) : String(x);


// The template of a new automated tuning: short, the guided form explains the rest. It starts with the project's
// main metric when its code or metrics file says which way is better.
export const template = (metrics) => {
  const declared = Object.keys(metrics?.available_metrics ?? {});
  const metric = [metrics?.default_metric, ...declared].find(m => m && ['higher', 'lower'].includes(metric_direction(m, metrics)));
  const objective = metric ? `\n  ${metric}: ${metric_direction(metric, metrics) === 'higher' ? 'max' : 'min'}` : ' {}';
  return `# Automated tuning: QA-Board runs the batch with parameters from search_space,
# and searches for the ones that give the best objective.
# Settings: ${DOCS}
evaluations: 30
objective:${objective}
search_space: []
`;
};


export const parse = text => {
  const doc = parseDocument(text ?? '');
  const errors = doc.errors.map(e => e.message.split('\n')[0]);
  let config = null;
  if (errors.length === 0) {
    try {
      config = doc.toJS();
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { config: config ?? null, errors };
};

// Edits the YAML in place: comments and the order of keys are kept
const edit = (text, change) => {
  const doc = parseDocument(text ?? '');
  if (doc.errors.length) return text;
  if (doc.contents === null) doc.contents = doc.createNode({});
  change(doc);
  return doc.toString({ lineWidth: 0 });
};

// undefined deletes
export const set = (text, path, value) => edit(text, doc => {
  if (value === undefined) doc.deleteIn(path);
  else doc.setIn(path, value);
});

// The search space's parameters as rows: {kind, name, low, high, log, categories}
export const parameters = config => (Array.isArray(config?.search_space) ? config.search_space : []).map(item => {
  const kind = is_map(item) ? Object.keys(item)[0] : undefined;
  const options = is_map(item) && is_map(item[kind]) ? item[kind] : {};
  return {
    kind: KINDS.includes(kind) ? kind : kind ?? 'Real',
    name: options.name ?? '',
    low: options.low,
    high: options.high,
    log: options.prior === 'log-uniform',
    categories: Array.isArray(options.categories) ? options.categories : [],
  };
});

const as_item = ({ kind, name, low, high, log, categories }) => {
  if (kind === 'Categorical') return { Categorical: { name, categories: categories ?? [] } };
  return { [kind]: { name, low, high, ...(log ? { prior: 'log-uniform' } : {}) } };
};

export const setParameter = (text, index, parameter) => edit(text, doc => {
  if (!isSeq(doc.get('search_space'))) doc.set('search_space', doc.createNode([]));
  doc.setIn(['search_space', index], doc.createNode(as_item(parameter)));
});

export const addParameter = (text, parameter = { kind: 'Real', name: '', low: 0, high: 1 }) => edit(text, doc => {
  if (!isSeq(doc.get('search_space'))) doc.set('search_space', doc.createNode([]));
  const space = doc.get('search_space');
  space.flow = false;
  space.add(doc.createNode(as_item(parameter)));
});

export const removeParameter = (text, index) => edit(text, doc => doc.deleteIn(['search_space', index]));

// Changing a parameter's kind keeps what still makes sense
export const changeKind = (parameter, kind) => {
  if (kind === 'Categorical')
    return { kind, name: parameter.name, categories: parameter.categories?.length ? parameter.categories : [] };
  const integer = kind === 'Integer';
  const bound = (v, fallback) => is_num(v) ? (integer ? Math.round(v) : v) : fallback;
  return { kind, name: parameter.name, low: bound(parameter.low, 0), high: bound(parameter.high, integer ? 10 : 1), log: parameter.log };
};

export const objectiveMetrics = config => Object.keys(is_map(config?.objective) ? config.objective : {}).filter(m => m !== 'target');

// Each metric of the objective says which way is better: `psnr: max`, or `psnr: {goal: max, weight: 2}`
export const GOALS = { max: 'max', maximize: 'max', min: 'min', minimize: 'min' };
const as_goal = goal => GOALS[String(goal).toLowerCase()] ?? null;

// A metric's settings as a mapping, whether the YAML has `psnr: max`, `psnr:` or `psnr: {goal: max}`
export const objective_options = (config, metric) => {
  const options = is_map(config?.objective) ? config.objective[metric] : undefined;
  if (typeof options === 'string') return { goal: options };
  return is_map(options) ? options : {};
};

// The shortest YAML for these settings: `max` when the goal is all there is
const objective_value = ({ goal, weight, ...rest }) => {
  const options = { ...(goal ? { goal } : {}), ...(weight !== undefined && weight !== 1 ? { weight } : {}), ...rest };
  return Object.keys(options).length === 1 && options.goal ? options.goal : options;
};

export const setObjectiveMetric = (text, metric, options) => set(text, ['objective', metric], objective_value(options));
// Another metric in the same row: its goal is the new metric's
export const renameObjectiveMetric = (text, from, to, goal) => edit(text, doc => {
  const { goal: _goal, ...options } = objective_options(doc.toJS(), from);
  doc.deleteIn(['objective', from]);
  doc.setIn(['objective', to], doc.createNode(objective_value({ ...options, goal: goal ?? undefined })));
});

// Which way is better for a metric of the objective: what the configuration says, else what the code that computes it
// or the metrics file declares. {goal: 'max', 'min' or null, from: 'config', 'declared' or null}
export const objective_goal = (config, metric, metrics) => {
  const goal = objective_options(config, metric).goal;
  if (goal !== undefined && goal !== null) return { goal: as_goal(goal), from: 'config' };
  const direction = metric_direction(metric, metrics);
  if (direction === 'higher' || direction === 'lower') return { goal: direction === 'higher' ? 'max' : 'min', from: 'declared' };
  return { goal: null, from: null };
};

// The metrics to choose from: those declared in code or in the metrics file, then the others the commit's runs returned
export const metrics_to_choose = (metrics, commit) => {
  const returned = new Set();
  for (const batch of Object.values(commit?.batches ?? {}))
    for (const output of Object.values(batch.outputs ?? {}))
      if (output.output_type !== 'optim_iteration')
        for (const key of Object.keys(output.metrics ?? {})) returned.add(key);
  return with_undeclared_metrics(metrics?.available_metrics ?? {}, returned);
};


// ---- what to recommend

// Rules of thumb: about 10 evaluations per parameter, at least 20. Choices with many values need a few more.
export const recommended_evaluations = parameters => {
  if (parameters.length === 0) return 20;
  const extra = parameters.filter(p => p.kind === 'Categorical').reduce((n, p) => n + Math.max(0, (p.categories?.length ?? 0) - 3), 0);
  return Math.max(20, 10 * parameters.length + 2 * extra);
};

// A range over orders of magnitude is better searched on a log scale
export const suggest_log = p => p.kind !== 'Categorical' && !p.log && is_num(p.low) && is_num(p.high) && p.low > 0 && p.high / p.low >= 100;

// Which way is better for a metric, from its definition (the code that computes it, or the metrics file): like
// qaboard/gate.py's smaller_is_better
export const metric_direction = (metric, metrics) => {
  const definition = metrics?.available_metrics?.[metric];
  if (definition === undefined) return 'undeclared';
  if (!('smaller_is_better' in (definition ?? {}))) return 'lower';
  if (definition.smaller_is_better === null) return 'none';
  return definition.smaller_is_better === false || String(definition.smaller_is_better).toLowerCase() === 'false' ? 'higher' : 'lower';
};


// ---- checks: [{path, message}], with qaboard/optimization.py's messages

const check_options = (config, metrics) => {
  const errors = [];
  const error = (path, message) => errors.push({ path, message });
  const objective = config.objective;
  const names = objectiveMetrics(config);
  if (!objective || !is_map(objective)) error(['objective'], "The configuration must say what to optimize in `objective`, from your project's metrics.");
  else if (names.length === 0) error(['objective'], "The `objective` must list at least one metric.");
  if (!('evaluations' in config)) error(['evaluations'], "The configuration must set how many parameters to try, with `evaluations`.");
  else if (!is_int(config.evaluations) || config.evaluations <= 0) error(['evaluations'], `\`evaluations\` must be a positive whole number, not \`${py(config.evaluations)}\`.`);
  const parallel = config.parallel_sampling ?? 1;
  if (!is_int(parallel) || parallel < 1) error(['parallel_sampling'], `\`parallel_sampling\` must be a positive whole number, not \`${py(parallel)}\`.`);
  const early = config.early_stopping;
  let patience = early;
  if (is_map(early)) {
    const unknown = Object.keys(early).filter(k => k !== 'patience').sort();
    if (unknown.length) error(['early_stopping'], `Unknown \`early_stopping\` settings: ${unknown.join(', ')}. Expected: \`patience\`.`);
    patience = early.patience;
  }
  if (patience !== undefined && patience !== null && (!is_int(patience) || patience <= 0))
    error(['early_stopping'], `\`early_stopping.patience\` must be a positive whole number, not \`${py(patience)}\`.`);
  const pareto = config.pareto ?? false;
  if (typeof pareto !== 'boolean') error(['pareto'], `\`pareto\` must be \`true\` or \`false\`, not \`${py(pareto)}\`.`);
  else if (pareto && names.length < 2) error(['pareto'], "`pareto: true` needs at least two metrics in the `objective`: with one, there is no trade-off to explore.");
  else if (pareto && names.length > 3) error(['pareto'], "`pareto: true` supports at most three metrics in the `objective`.");
  const resume = config.resume ?? true;
  if (typeof resume !== 'boolean') error(['resume'], `\`resume\` must be \`true\` or \`false\`, not \`${py(resume)}\`.`);
  for (const metric of names) {
    // qaboard/optimization.py's parse_objective_metric
    const raw = objective[metric];
    if (raw !== null && raw !== undefined && typeof raw !== 'string' && !is_map(raw)) {
      error(['objective', metric], `\`objective.${metric}\` must be \`max\`, \`min\`, or a mapping (e.g. \`goal: max\` and \`weight: 2\`), not \`${py(raw)}\`.`);
      continue;
    }
    const options = objective_options(config, metric);
    if (options.goal !== undefined && options.goal !== null && !as_goal(options.goal)) {
      error(['objective', metric], `\`objective.${metric}\` says \`${py(options.goal)}\`: expected \`max\` (higher is better) or \`min\` (lower is better).`);
      continue;
    }
    const weight = options.weight ?? 1;
    if (!is_num(weight) || weight <= 0) error(['objective', metric, 'weight'], `\`objective.${metric}.weight\` must be a positive number, not \`${py(weight)}\`.`);
    const loss = options.loss ?? 'identity';
    if (!/^(square_)?(relu_)?(identity|shift|relative)$/.test(String(loss))) error(['objective', metric, 'loss'], `\`objective.${metric}.loss\` is \`${py(loss)}\`, expected identity, shift or relative, optionally as relu_X, square_X or square_relu_X.`);
    const reduce = options.reduce ?? 'sum';
    if (!/^(sum|relu|l\d)$/.test(String(reduce))) error(['objective', metric, 'reduce'], `\`objective.${metric}.reduce\` is \`${py(reduce)}\`, expected sum, relu, l1 or l2.`);
    if ('margin' in options && !is_num(options.margin)) error(['objective', metric, 'margin'], `\`objective.${metric}.margin\` must be a number, not \`${py(options.margin)}\`.`);
    if (options.target !== undefined && options.target !== null && !is_num(options.target)) error(['objective', metric, 'target'], `\`objective.${metric}.target\` must be a number, not \`${py(options.target)}\`.`);
    // Without a goal, which way is better must be declared: by the code that computes the metric, or the metrics file
    if (metrics && !objective_goal(config, metric, metrics).goal)
      error(['objective', metric], `Say whether higher or lower values of ${metric} are better: \`${metric}: max\` or \`${metric}: min\`.`);
  }
  return errors;
};

const check_search_space = search_space => {
  const errors = [];
  const error = (index, message) => errors.push({ path: index === null ? ['search_space'] : ['search_space', index], message });
  if (!search_space || (Array.isArray(search_space) && search_space.length === 0)) {
    error(null, "The configuration must list the parameters to tune in `search_space`.");
    return errors;
  }
  if (!Array.isArray(search_space)) {
    error(null, "`search_space` must be a list of parameters, each written as `- Integer:`, `- Real:` or `- Categorical:`.");
    return errors;
  }
  const names = new Set();
  search_space.forEach((dimension, index) => {
    let at = `search_space[${index}]`;
    if (!is_map(dimension) || Object.keys(dimension).length !== 1)
      return error(index, `${at} must be one of: \`Integer:\`, \`Real:\`, \`Categorical:\`.`);
    const [kind] = Object.keys(dimension);
    const options = dimension[kind];
    if (!['Integer', 'Real', 'Categorical'].includes(kind)) return error(index, `${at} has an unknown type \`${kind}\`. Expected one of: Integer, Real, Categorical.`);
    if (!is_map(options)) return error(index, `${at} (\`${kind}\`) needs at least a \`name\`.`);
    const name = options.name;
    if (!name || typeof name !== 'string') return error(index, `${at} (\`${kind}\`) needs a \`name\`.`);
    if (names.has(name)) return error(index, `\`${name}\` is in the search space twice.`);
    names.add(name);
    at = `\`${name}\``;
    if (kind === 'Categorical') {
      const categories = options.categories;
      if (!Array.isArray(categories) || categories.length === 0) return error(index, `${at} needs a list of \`categories\`.`);
      if (categories.length < 2) return error(index, `${at} has a single category: set it in \`preset_params\` instead of tuning it.`);
      if (new Set(categories.map(c => JSON.stringify(c))).size !== categories.length) return error(index, `${at} lists the same category twice: ${JSON.stringify(categories)}`);
      return;
    }
    if (!('low' in options) || !('high' in options)) return error(index, `${at} needs both \`low\` and \`high\` bounds.`);
    const { low, high } = options;
    if (!is_num(low) || !is_num(high)) return error(index, `${at} needs numbers for \`low\` and \`high\`.`);
    if (low >= high) return error(index, `${at}'s \`low\` (${py(low)}) must be smaller than its \`high\` (${py(high)}).`);
    if (kind === 'Integer' && (!Number.isInteger(low) || !Number.isInteger(high))) return error(index, `${at} is an Integer: its bounds must be whole numbers, not ${py(low)} and ${py(high)}.`);
    const prior = options.prior ?? 'uniform';
    if (prior !== 'uniform' && prior !== 'log-uniform') return error(index, `${at} has an unknown \`prior: ${py(prior)}\`. Expected \`uniform\` or \`log-uniform\`.`);
    if (prior === 'log-uniform' && low <= 0) return error(index, `${at} uses \`prior: log-uniform\`, so its \`low\` (${py(low)}) must be above 0.`);
  });
  return errors;
};

const check_solver = solver => {
  const errors = [];
  const error = message => errors.push({ path: ['solver'], message });
  if (solver === undefined || solver === null) return errors;
  if (!is_map(solver)) {
    error(`\`solver\` must be a mapping, e.g. \`sampler: tpe\`, not \`${py(solver)}\`.`);
    return errors;
  }
  const { name = 'optuna', sampler = 'auto', seed = 101, n_startup_trials = 10, ...rest } = solver;
  if (name !== 'optuna') {
    error(`\`solver.name: ${py(name)}\` is not supported anymore: QA-Board tunes parameters with Optuna. Remove \`name\`, and see ${DOCS} for the solver's settings.`);
    return errors;
  }
  for (const [key, hint] of Object.entries(LEGACY_SOLVER_KEYS))
    if (key in solver) {
      error(`\`solver.${key}\` was a scikit-optimize setting: ${hint}. See ${DOCS}`);
      return errors;
    }
  if (!SAMPLERS.includes(sampler)) error(`Unknown \`solver.sampler: ${py(sampler)}\`. Expected one of: ${SAMPLERS.join(', ')}.`);
  else if (!is_int(seed)) error(`\`solver.seed\` must be a whole number, not \`${py(seed)}\`.`);
  else if (!is_int(n_startup_trials) || n_startup_trials < 1) error(`\`solver.n_startup_trials\` must be a positive whole number, not \`${py(n_startup_trials)}\`.`);
  else if (Object.keys(rest).length) error(`Unknown solver settings: ${Object.keys(rest).sort().join(', ')}. Expected: sampler, n_startup_trials, seed.`);
  return errors;
};

// metrics: the metrics' definitions (the code's and the metrics file's), to check that the objective says which way is
// better for each metric. Without it, it isn't checked.
export const check = (config, metrics) => {
  if (!is_map(config))
    return [{ path: [], message: "The configuration must be a YAML mapping, with at least `evaluations`, `objective` and `search_space`." }];
  const errors = [...check_options(config, metrics), ...check_search_space(config.search_space), ...check_solver(config.solver)];
  if (errors.length === 0 && is_map(config.preset_params)) {
    const tuned = parameters(config).map(p => p.name);
    const both = tuned.filter(name => name in config.preset_params);
    if (both.length) errors.push({ path: ['preset_params'], message: `${both.map(n => `\`${n}\``).join(', ')} is both in \`preset_params\` and in the \`search_space\`: keep it in one of them.` });
  }
  return errors;
};


// To continue an automated tuning, or start from it: its configuration, from the batch's data
export const from_batch = (batch, { evaluations } = {}) => {
  const config = batch?.data?.optimization_config?.config;
  if (!is_map(config)) return null;
  // without `resume: false`: it would start over instead of continuing
  const { solver, preset_params, resume: _resume, ...rest } = config;
  const cleaned = {
    ...rest,
    ...(is_map(solver) && Object.keys(solver).length ? { solver } : {}),
    ...(is_map(preset_params) && Object.keys(preset_params).length ? { preset_params } : {}),
    ...(evaluations ? { evaluations } : {}),
  };
  const doc = parseDocument('');
  doc.contents = doc.createNode(cleaned);
  return doc.toString({ lineWidth: 0 });
};

// Starting with the label of an existing automated tuning continues it (qa optimize resumes). It only searches further
// with more evaluations than it already did. {batch, done, error} or null.
export const continuation = (commit, label, config) => {
  const batch = commit?.batches?.[label];
  if (!label || !batch?.data?.optimization) return null;
  const done = batch.data.evaluations_completed !== undefined
    ? batch.data.evaluations_completed + (batch.data.evaluations_failed ?? 0)
    : (batch.data.iteration ?? 0);
  const evaluations = config?.evaluations;
  const error = Number.isInteger(evaluations) && evaluations <= done && config?.resume !== false
    ? `${label} already did ${done} evaluations: set more than ${done} to search further, or use another batch label to start over.`
    : null;
  return { batch, done, error };
};

// The parameters the commit's runs were tuned with: names to suggest
export const known_parameters = commit => {
  const names = new Set();
  for (const batch of Object.values(commit?.batches ?? {}))
    for (const output of Object.values(batch.outputs ?? {}))
      for (const name of Object.keys(output.extra_parameters ?? {})) names.add(name);
  return [...names].sort();
};
