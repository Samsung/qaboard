/**
 * The guided form's logic: editing the YAML in place, checking it like qa optimize, what to recommend.
 * Run with: cd webapp && npm test -- optimize_config
 */
import batches from '../../../../e2e/fixtures/tuning.json';
import {
  template, parse, set, parameters, setParameter, addParameter, removeParameter, changeKind, objectiveMetrics,
  setObjectiveMetric, renameObjectiveMetric, recommended_evaluations, suggest_log, metric_direction, check, from_batch,
  known_parameters,
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
    let text = setObjectiveMetric(CONFIG, 'model_mb', { weight: 0.005 });
    expect(objectiveMetrics(parse(text).config)).toEqual(['map', 'model_mb']);
    text = renameObjectiveMetric(text, 'map', 'latency');
    expect(parse(text).config.objective).toEqual({ model_mb: { weight: 0.005 }, latency: { weight: 1 } });
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

  it("needs the objective's metrics to say which way is better", () => {
    const config = { evaluations: 5, objective: { psnr: {}, latency: {} }, search_space: [{ Real: { name: 'x', low: 0, high: 1 } }] };
    const errors = check(config, metrics);
    expect(errors.map(e => e.path)).toEqual([['objective', 'psnr'], ['objective', 'latency']]);
    expect(errors[0].message).toContain('smaller_is_better');
    // without the metrics file, it can't tell
    expect(check(config, undefined)).toEqual([]);
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
