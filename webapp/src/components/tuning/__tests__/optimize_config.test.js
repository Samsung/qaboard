/**
 * The guided form's logic: editing the YAML in place, checking it like qa optimize, what to recommend.
 * Run with: cd webapp && npm test -- optimize_config
 */
import batches from '../../../../e2e/fixtures/tuning.json';
import {
  template, parse, set, parameters, setParameter, addParameter, removeParameter, changeKind, objectiveMetrics,
  setObjectiveMetric, renameObjectiveMetric, recommended_evaluations, suggest_log, metric_direction, check, from_batch,
  known_parameters, objective_goal, metrics_to_choose,
} from '../optimize_config';

const metrics = {
  default_metric: 'map',
  available_metrics: {
    map: { label: 'mAP', smaller_is_better: false },
    model_mb: { label: 'Model size' },
    latency: { label: 'Latency', smaller_is_better: null },
  },
};

const CONFIG = `# my tuning
evaluations: 20 # enough?
objective:
  map:
    weight: 1
search_space:
  # what we tune
  - Real:
      name: threshold
      low: 0.1
      high: 0.9
`;

describe('editing the YAML', () => {
  it('keeps comments', () => {
    let text = set(CONFIG, ['evaluations'], 40);
    text = setParameter(text, 0, { kind: 'Real', name: 'threshold', low: 0.2, high: 0.9 });
    text = addParameter(text, { kind: 'Categorical', name: 'mode', categories: ['fast', 'slow'] });
    expect(text).toContain('# my tuning');
    expect(text).toContain('evaluations: 40 # enough?');
    expect(text).toContain('# what we tune');
    const { config } = parse(text);
    expect(config.evaluations).toBe(40);
    expect(config.search_space).toEqual([
      { Real: { name: 'threshold', low: 0.2, high: 0.9 } },
      { Categorical: { name: 'mode', categories: ['fast', 'slow'] } },
    ]);
  });

  it('adds parameters to the empty template, as a block list', () => {
    const text = addParameter(template(metrics), { kind: 'Integer', name: 'n', low: 1, high: 10 });
    expect(text).toContain('search_space:\n  - Integer:');
    expect(parameters(parse(text).config)).toEqual([{ kind: 'Integer', name: 'n', low: 1, high: 10, log: false, categories: [] }]);
  });

  it('removes parameters, sets and deletes settings', () => {
    let text = removeParameter(CONFIG, 0);
    expect(parse(text).config.search_space).toEqual([]);
    text = set(text, ['early_stopping', 'patience'], 15);
    expect(parse(text).config.early_stopping).toEqual({ patience: 15 });
    text = set(text, ['early_stopping'], undefined);
    expect('early_stopping' in parse(text).config).toBe(false);
  });

  it('writes log-scale ranges as log-uniform priors', () => {
    const text = setParameter(CONFIG, 0, { kind: 'Real', name: 'lr', low: 1e-5, high: 0.1, log: true });
    expect(parse(text).config.search_space[0].Real.prior).toBe('log-uniform');
    expect(parameters(parse(text).config)[0].log).toBe(true);
  });

  it('edits the metrics of the objective', () => {
    let text = setObjectiveMetric(CONFIG, 'model_mb', { goal: 'min', weight: 0.005 });
    expect(objectiveMetrics(parse(text).config)).toEqual(['map', 'model_mb']);
    expect(parse(text).config.objective.model_mb).toEqual({ goal: 'min', weight: 0.005 });
    // the goal alone is written short
    text = setObjectiveMetric(text, 'map', { goal: 'max', weight: 1 });
    expect(text).toContain('  map: max\n');
    // another metric in the same row takes its own goal, and keeps the weight
    text = renameObjectiveMetric(text, 'model_mb', 'latency', 'min');
    expect(parse(text).config.objective).toEqual({ map: 'max', latency: { goal: 'min', weight: 0.005 } });
    text = renameObjectiveMetric(text, 'map', 'psnr', null);
    expect(parse(text).config.objective.psnr).toEqual({});
  });

  it("doesn't touch YAML it can't parse", () => {
    expect(set('a: [', ['evaluations'], 3)).toBe('a: [');
    expect(parse('a: [').errors.length).toBeGreaterThan(0);
  });

  it("keeps what makes sense when a parameter's kind changes", () => {
    expect(changeKind({ kind: 'Real', name: 'n', low: 1.4, high: 9.6 }, 'Integer')).toEqual({ kind: 'Integer', name: 'n', low: 1, high: 10, log: undefined });
    expect(changeKind({ kind: 'Real', name: 'mode', low: 0, high: 1 }, 'Categorical')).toEqual({ kind: 'Categorical', name: 'mode', categories: [] });
  });
});

describe('recommendations', () => {
  it('about 10 evaluations per parameter, at least 20', () => {
    expect(recommended_evaluations([])).toBe(20);
    expect(recommended_evaluations([{ kind: 'Real' }])).toBe(20);
    expect(recommended_evaluations([{ kind: 'Real' }, { kind: 'Real' }, { kind: 'Integer' }, { kind: 'Real' }])).toBe(40);
    expect(recommended_evaluations([{ kind: 'Real' }, { kind: 'Real' }, { kind: 'Categorical', categories: [1, 2, 3, 4, 5, 6, 7] }])).toBe(38);
  });

  it('log scale for ranges over orders of magnitude', () => {
    expect(suggest_log({ kind: 'Real', low: 1e-5, high: 0.1 })).toBe(true);
    expect(suggest_log({ kind: 'Real', low: 0, high: 1000 })).toBe(false);
    expect(suggest_log({ kind: 'Real', low: 1e-5, high: 0.1, log: true })).toBe(false);
  });

  it("knows the metrics' directions like qa optimize", () => {
    expect(metric_direction('map', metrics)).toBe('higher');
    expect(metric_direction('model_mb', metrics)).toBe('lower');
    expect(metric_direction('latency', metrics)).toBe('none');
    expect(metric_direction('psnr', metrics)).toBe('undeclared');
  });
});

describe('check', () => {
  const messages = (config, m = metrics) => check(config, m).map(e => e.message);

  it('accepts a valid configuration', () => {
    expect(check(parse(CONFIG).config, metrics)).toEqual([]);
  });

  it("says what's missing in the template", () => {
    expect(messages(parse(template(metrics)).config)).toEqual(["The configuration must list the parameters to tune in `search_space`."]);
  });

  it("uses qa optimize's messages", () => {
    // the same text as qaboard/optimization.py, so the server's check of the same problem is shown once
    expect(messages({ evaluations: 0, objective: { map: {} }, search_space: [{ Real: { name: 'x', low: 1, high: 0 } }] })).toEqual([
      "`evaluations` must be a positive whole number, not `0`.",
      "`x`'s `low` (1) must be smaller than its `high` (0).",
    ]);
    expect(messages({ evaluations: 5, objective: { map: {} }, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }], solver: { base_estimator: 'GP' } })[0])
      .toMatch(/^`solver.base_estimator` was a scikit-optimize setting/);
  });

  it("needs to know which way is better for each metric of the objective", () => {
    const config = { evaluations: 5, objective: { psnr: {}, latency: {}, map: {} }, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }] };
    const errors = check(config, metrics);
    // map says it where it's computed (or in the metrics file); psnr nowhere, and latency has no better direction
    expect(errors.map(e => e.path)).toEqual([['objective', 'psnr'], ['objective', 'latency']]);
    expect(errors[0].message).toBe('Say whether higher or lower values of psnr are better: `psnr: max` or `psnr: min`.');
    // the objective says it
    expect(check({ ...config, objective: { psnr: 'max', latency: { goal: 'min', weight: 2 }, map: {} } }, metrics)).toEqual([]);
    // without the metrics' definitions, it can't tell
    expect(check(config, undefined)).toEqual([]);
  });

  it("checks the objective's settings like qa optimize", () => {
    const with_objective = objective => messages({ evaluations: 5, objective, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }] });
    expect(with_objective({ psnr: 'higher' })).toEqual(['`objective.psnr` says `higher`: expected `max` (higher is better) or `min` (lower is better).']);
    expect(with_objective({ psnr: 3 })).toEqual(['`objective.psnr` must be `max`, `min`, or a mapping (e.g. `goal: max` and `weight: 2`), not `3`.']);
    expect(with_objective({ psnr: { goal: 'max', loss: 'l2', reduce: 'mean', target: 'x' } })).toEqual([
      '`objective.psnr.loss` is `l2`, expected identity, shift or relative, optionally as relu_X, square_X or square_relu_X.',
      '`objective.psnr.reduce` is `mean`, expected sum, relu, l1 or l2.',
      '`objective.psnr.target` must be a number, not `x`.',
    ]);
  });

  it('knows which way is better from the objective, else from the declarations', () => {
    expect(objective_goal({ objective: { map: 'min' } }, 'map', metrics)).toEqual({ goal: 'min', from: 'config' });
    expect(objective_goal({ objective: { map: { goal: 'maximize' } } }, 'map', metrics)).toEqual({ goal: 'max', from: 'config' });
    expect(objective_goal({ objective: { map: {} } }, 'map', metrics)).toEqual({ goal: 'max', from: 'declared' });
    expect(objective_goal({ objective: { psnr: {} } }, 'psnr', metrics)).toEqual({ goal: null, from: null });
  });

  it('offers the metrics the runs returned, after the declared ones', () => {
    const commit = { batches: {
      ci: { outputs: { 1: { metrics: { psnr: 30, map: 0.3, is_failed: false } } } },
      tune: { outputs: { 2: { output_type: 'optim_iteration', metrics: { objective: 1, iteration: 1 } } } },
    } };
    const choices = metrics_to_choose(metrics, commit);
    expect(Object.keys(choices)).toEqual(['map', 'model_mb', 'latency', 'psnr']);
    expect(choices.psnr).toMatchObject({ label: 'psnr', smaller_is_better: null, declared: false });
  });

  it('checks Pareto mode', () => {
    expect(messages({ evaluations: 5, pareto: true, objective: { map: {} }, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }] })[0]).toContain('at least two metrics');
  });

  it('points at the parameter', () => {
    const errors = check({ evaluations: 5, objective: { map: {} }, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }, { Categorical: { name: 'c', categories: ['a'] } }] }, metrics);
    expect(errors).toEqual([{ path: ['search_space', 1], message: "`c` has a single category: set it in `preset_params` instead of tuning it." }]);
  });
});

describe('from_batch', () => {
  it("gives a past tuning's configuration, with a new budget", () => {
    const text = from_batch(batches['tune-int8'], { evaluations: 60 });
    const { config } = parse(text);
    expect(config.evaluations).toBe(60);
    expect(config.objective).toEqual(batches['tune-int8'].data.optimization_config.config.objective);
    expect(config.search_space).toEqual(batches['tune-int8'].data.optimization_config.config.search_space);
    expect(check(config, { available_metrics: { ap_small: { smaller_is_better: false }, map: { smaller_is_better: false }, model_mb: {} } })).toEqual([]);
    expect(from_batch({ data: {} })).toBeNull();
  });
});

describe('known_parameters', () => {
  it("lists the commit's tuning parameters", () => {
    expect(known_parameters({ batches })).toEqual(['nms_iou', 'quant_keep_fp32', 'quant_percentile', 'score_threshold']);
  });
});
