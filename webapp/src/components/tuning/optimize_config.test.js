// Tests for the JS mirror of qaboard/optimization.py's validator.
import assert from 'assert';
import {
  parseOptimizeConfig, validateOptimizeConfig, serializeOptimizeConfig,
  objectiveMetrics, addDimension, removeDimension, changeDimensionKind, updateDimension,
} from './optimize_config';

// The exact template from the webapp (JS interpolations resolved)
const TEMPLATE = `
evaluations: 50
parallel_sampling: 1
objective:
  my_metric:
    weight: 1
    reduce: sum
    loss: identity
search_space:
  - Integer:
      name: max_events
      low: 1000
      high: 10000
  - Categorical:
      name: solver
      categories: [ceres, g2o]
  - Real:
      name: threshold
      low: 0.0
      high: 1.0
  - Real:
      name: learning_rate
      low: 0.0000001
      high: 0.1
      prior: log-uniform
`;

let { config, parse_error } = parseOptimizeConfig(TEMPLATE);
assert.equal(parse_error, null);
assert.deepEqual(validateOptimizeConfig(config), []);
assert.deepEqual(objectiveMetrics(config), ['my_metric']);

// round-trip: serialize -> parse -> validate, content preserved
const dumped = serializeOptimizeConfig(config);
const round = parseOptimizeConfig(dumped).config;
assert.deepEqual(validateOptimizeConfig(round), []);
assert.deepEqual(round.search_space, config.search_space);
assert.deepEqual(round.objective, config.objective);
assert.equal(round.evaluations, 50);
assert.equal(round.parallel_sampling, undefined, 'default parallel_sampling stays implicit');

// unknown sections survive serialization (forward compatibility)
const custom = { ...config, some_future_section: { a: 1 } };
assert.deepEqual(parseOptimizeConfig(serializeOptimizeConfig(custom)).config.some_future_section, { a: 1 });

// ---- validation errors mirror the Python parser ----
const errorsOf = text => validateOptimizeConfig(parseOptimizeConfig(text).config);
const expectError = (text, ...fragments) => {
  const errors = errorsOf(text);
  for (const fragment of fragments)
    assert.ok(errors.some(e => e.includes(fragment)), `expected error containing "${fragment}" in ${JSON.stringify(errors)}`);
};

expectError('evaluations: 50', 'objective', 'search_space');
expectError('objective: {m: {}}\nsearch_space:\n - Real: {name: x, low: 0, high: 1}', 'evaluations');
expectError(TEMPLATE.replace('evaluations: 50', 'evaluations: -1'), 'evaluations');
expectError(TEMPLATE + '\nearly_stopping: {patience: 0}', 'patience');
expectError(TEMPLATE + '\npareto: true', 'two metrics');
expectError(TEMPLATE + '\nsolver: {base_estimator: GP}', 'scikit-optimize');
expectError(TEMPLATE + '\nsolver: {sampler: grid}', 'sampler');
expectError(TEMPLATE.replace('name: threshold', 'name: max_events'), 'more than once');
expectError(TEMPLATE.replace('low: 0.0000001', 'low: 0'), 'log-uniform');
expectError(TEMPLATE.replace('low: 1000\n      high: 10000', 'low: 1000\n      high: 10'), '>=');
expectError(TEMPLATE.replace('- Real:\n      name: threshold', '- Float:\n      name: threshold'), 'Float');

// unparseable YAML fails soft
assert.notEqual(parseOptimizeConfig('a: [b').parse_error, null);
assert.equal(parseOptimizeConfig('just a string').config, null);

// ---- form edits ----
let space = config.search_space;
space = addDimension(space, 'Real');
assert.equal(space.length, 5);
assert.deepEqual(space[4], { Real: { name: '', low: 0.0, high: 1.0 } });
space = updateDimension(space, 4, 'Real', { name: 'gain', low: 0.5, high: 2.0 });
assert.equal(space[4].Real.name, 'gain');
space = changeDimensionKind(space, 4, 'Integer');
assert.deepEqual(space[4], { Integer: { name: 'gain', low: 0.5, high: 2.0 } });
space = changeDimensionKind(space, 4, 'Categorical');
assert.deepEqual(space[4], { Categorical: { name: 'gain', categories: [] } });
space = removeDimension(space, 4);
assert.equal(space.length, 4);
assert.deepEqual(space, config.search_space);



// The assertions above run at import time; this makes jest report them as a test.
it('validates and round-trips the optimize-config dialect', () => {});
