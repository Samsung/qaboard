/**
 * The model of the values to try, its text and the payload the server gets; reading values; pasted registers;
 * pre-filling the form; "Start from a previous batch".
 * Run with: cd webapp && npm test -- model
 */
import {
  row, model_from_text, model_to_text, model_from_parameters, model_from_values, model_to_parameters, model_keys, set_combinations,
  count_combinations, count_runs,
} from '../model';
import { parse_value, format_value, split_values, range_values, compact_json } from '../values';
import { transformCDERegisters, model_from_registers } from '../registers';
import { prefill_form } from '../prefill';
import { describe_request, form_from_request, request_batches } from '../history';
import { grid_to_space } from '../optimize_config';

describe('the model of the values to try', () => {
  it('reads the text, and says when the table cannot show it', () => {
    expect(model_from_text('')).toEqual({ sets: [[]] });
    expect(model_from_text('{}')).toEqual({ sets: [[]] });
    expect(model_from_text('{"a": [1, 2], "b": "x"}')).toEqual({ sets: [[row('a', [1, 2]), row('b', ['x'])]] });
    expect(model_from_text('[{"a": 1}, {"a": [2, 3]}]').sets).toEqual([[row('a', [1])], [row('a', [2, 3])]]);
    // kept as text: the table can't show them
    expect(model_from_text('return {a: [1, 2]}')).toEqual({ sets: null, text: 'return {a: [1, 2]}', reason: 'function' });
    expect(model_from_text('{"a": [1, ')).toMatchObject({ sets: null, reason: 'invalid', text: '{"a": [1, ' });
    expect(model_from_text('[1, 2]')).toMatchObject({ sets: null, reason: 'invalid' });
  });

  it('writes one line per parameter, without the rows being written', () => {
    const rows = [row('a.b', [1, 'x', [0, 1], { k: true }]), row('', [1]), row('c', [])];
    expect(model_to_text({ sets: [rows] })).toBe('{\n  "a.b": [1, "x", [0, 1], {"k": true}]\n}');
    expect(model_to_text({ sets: [[], rows] })).toBe('{\n  "a.b": [1, "x", [0, 1], {"k": true}]\n}');
    expect(model_to_text({ sets: [[row('a', [1])], [row('a', [2])]] })).toBe('[\n  {\n    "a": [1]\n  },\n  {\n    "a": [2]\n  }\n]');
    expect(model_to_text({ sets: [[row()]] })).toBe('');
    // text the table can't show stays as it is
    expect(model_to_text(model_from_text('return {a: [1]}'))).toBe('return {a: [1]}');
  });

  it('round-trips the text, the model and the payload', () => {
    const texts = [
      '{\n  "a.b": [1, "x", [0, 1], {"k": true}]\n}',
      '[\n  {\n    "low": [1],\n    "high": [2]\n  },\n  {\n    "low": [3],\n    "high": [4, 5]\n  }\n]',
      '{\n  "ccm": [[[1, 0], [0, 1]], [[1.2, -0.1], [0, 1]]],\n  "d": [null, 0.001, "1", true]\n}',
    ];
    for (const text of texts) {
      const model = model_from_text(text);
      expect(model_to_text(model)).toBe(text);
      expect(model_to_text(model_from_parameters(model_to_parameters(model)))).toBe(text);
      expect(model_to_parameters(model)).toEqual(JSON.parse(text));
    }
    // what the old text form accepted: values that are not lists, sets of one value
    expect(model_to_parameters(model_from_text('{"a": 1, "b": [1, 2]}'))).toEqual({ a: [1], b: [1, 2] });
    expect(model_to_parameters(model_from_text('[{"a": 1}, {"a": [2]}]'))).toEqual([{ a: [1] }, { a: [2] }]);
    expect(model_to_parameters(model_from_text(''))).toEqual({});
    expect(model_to_parameters(model_from_text('{}'))).toEqual({});
    // functions run, like they always did; their result goes as the payload
    expect(model_to_parameters(model_from_text('return {a: [1, 2], b: 3}'))).toEqual({ a: [1, 2], b: [3] });
    expect(model_to_parameters(model_from_text('return [1, 2, 3].map(i => ({a: i}))'))).toEqual([{ a: [1] }, { a: [2] }, { a: [3] }]);
    expect(model_to_parameters(model_from_text('throw new Error()'))).toBe(null);
    expect(model_to_parameters(model_from_text('{"a": [1, '))).toBe(null);
  });

  it("reads a run's parameters: one value each, lists included", () => {
    expect(model_from_values({ threshold: 0.3, gains: [1, 2] })).toEqual({ sets: [[row('threshold', [0.3]), row('gains', [[1, 2]])]] });
    expect(model_from_values(null)).toEqual({ sets: [[]] });
    // what the server gets: lists are the values to try
    expect(model_from_parameters({ threshold: 0.3, 'block.mode': 'fast' })).toEqual({ sets: [[row('threshold', [0.3]), row('block.mode', ['fast'])]] });
    expect(model_from_parameters(null)).toEqual({ sets: [[]] });
    expect(model_from_parameters('x').sets).toBe(null);
    expect(model_keys(model_from_text('[{"a": 1, "b": 2}, {"a": 2, "c": 1}]'))).toEqual(['a', 'b', 'c']);
  });

  it('counts combinations and runs in one place', () => {
    expect(set_combinations([])).toBe(1);
    expect(set_combinations([row('a', [1, 2]), row('b', [1, 2, 3]), row('', [1, 2])])).toBe(6);
    expect(count_combinations(model_from_text(''))).toBe(1);
    expect(count_combinations(model_from_text('{"a": [1, 2], "b": [1, 2, 3]}'))).toBe(6);
    expect(count_combinations(model_from_text('[{"a": 1}, {"a": [1, 2]}]'))).toBe(3);
    expect(count_combinations(model_from_text('return {a: [1, 2, 3]}'))).toBe(3);
    expect(count_combinations(model_from_text('not valid'))).toBe(null);
    expect(count_runs({ combinations: 6, tests: 4 })).toEqual({ combinations: 6, runs: 24 });
    expect(count_runs({ combinations: 6, tests: 4, search_type: 'sampler', n_iter: 2 })).toEqual({ combinations: 2, runs: 8 });
    // a sample larger than the grid, or no sample size yet: every combination
    expect(count_runs({ combinations: 6, tests: 1, search_type: 'sampler', n_iter: 50 }).combinations).toBe(6);
    expect(count_runs({ combinations: 6, tests: 1, search_type: 'sampler', n_iter: NaN }).combinations).toBe(6);
    expect(count_runs({ combinations: null, tests: 4 })).toEqual({ combinations: null, runs: null });
  });

  it('moves the rows of the table to an automated tuning', () => {
    const space = grid_to_space(model_to_parameters(model_from_text('{"threshold": [0.1, 0.2, 0.3], "mode": ["a", "b"], "fixed": [7]}')));
    expect(space.rows.map(r => [r.name, r.kind])).toEqual([['threshold', 'Real'], ['mode', 'Categorical']]);
    expect(space.preset_params).toEqual({ fixed: 7 });
  });
});

describe('reading values', () => {
  it('reads what people type, and says what looks wrong', () => {
    expect(parse_value(' 1.5 ')).toEqual({ value: 1.5, error: null });
    expect(parse_value('1e-3').value).toBe(0.001);
    expect(parse_value('true').value).toBe(true);
    expect(parse_value('null').value).toBe(null);
    expect(parse_value('high').value).toBe('high');
    expect(parse_value('"1"').value).toBe('1');
    expect(parse_value('[[0, 1], [1, 0]]').value).toEqual([[0, 1], [1, 0]]);
    expect(parse_value('{"a": 1}').value).toEqual({ a: 1 });
    // registers, matrices with a row per line
    expect(parse_value('[1 2 3]').value).toEqual([1, 2, 3]);
    expect(parse_value('[1 2\n 3 4]').value).toEqual([[1, 2], [3, 4]]);
    // kept as text, like the text editor did, with what looks wrong
    expect(parse_value('[1, 2')).toEqual({ value: '[1, 2', error: expect.stringMatching(/brackets/) });
    expect(parse_value('"abc')).toEqual({ value: '"abc', error: expect.stringMatching(/quote/) });
    expect(parse_value('  ').error).toBeTruthy();
    // the description of the parameter is not used yet
    expect(parse_value('5', { type: 'int', min: 0, max: 3 })).toEqual({ value: 5, error: null });
  });

  it('shows values so that typing them back gives the same', () => {
    for (const value of [1, 0.5, true, null, 'high', '1', 'true', ' padded', 'a, b', '[1 2 3]', '[x', [0, 1], [[1, 2], [3, 4]], { a: 1 }]) {
      const shown = format_value(value);
      expect(split_values(shown).map(text => parse_value(text).value)).toEqual([value]);
    }
    expect(format_value('high')).toBe('high');
    expect(format_value('1')).toBe('"1"');
    expect(format_value([0, 1])).toBe('[0, 1]');
    expect(compact_json({ a: [1, [2, 3]], b: 'x' })).toBe('{"a": [1, [2, 3]], "b": "x"}');
    expect(split_values('1, 2,[3, 4]; "a, b"\n{"k": [1, 2]}')).toEqual(['1', '2', '[3, 4]', '"a, b"', '{"k": [1, 2]}']);
    expect(split_values('[1 2\n3 4], 5')).toEqual(['[1 2\n3 4]', '5']);
  });

  it('makes evenly spaced values', () => {
    expect(range_values({ from: 0, to: 1, count: 5 })).toEqual({ values: [0, 0.25, 0.5, 0.75, 1] });
    expect(range_values({ from: 0.1, to: 0.3, count: 3 })).toEqual({ values: [0.1, 0.2, 0.3] });
    expect(range_values({ from: 0.001, to: 1, count: 4, scale: 'log' })).toEqual({ values: [0.001, 0.01, 0.1, 1] });
    expect(range_values({ from: 5, to: 1, count: 3 })).toEqual({ values: [5, 3, 1] });
    expect(range_values({ from: 0, to: 2, count: 5, integer: true })).toEqual({ values: [0, 1, 2] });
    expect(range_values({ from: 0, to: 1, count: 3, scale: 'log' }).error).toMatch(/above 0/);
    for (const bad of [{ from: NaN, to: 1, count: 3 }, { from: 0, to: 1, count: 1 }, { from: 1, to: 1, count: 3 }, { from: 0, to: 1, count: 5000 }])
      expect(range_values(bad).error).toBeTruthy();
  });
});

describe('pasted registers', () => {
  it('converts register lines to the model', () => {
    expect(transformCDERegisters('block.a=1000\nblock.hal|b="text"\nblock.def|c=on')).toBe('"block.a": [1000],\n"block.b": ["text"],\n"block.c": ["on"]');
    expect(transformCDERegisters('mixer.hal|gain=[1 2\n 0 0 ]')).toBe('"mixer.gain": [[[1, 2], [0, 0]]]');
    expect(model_from_registers('block.a=1000\nmixer.hal|gain=[1 2\n 0 0 ]')).toEqual({ sets: [[row('block.a', [1000]), row('mixer.gain', [[[1, 2], [0, 0]]])]] });
    expect(model_from_registers('denoise.strength')).toBe(null);
    expect(model_from_registers('')).toBe(null);
  });
});

describe('filling the form', () => {
  it('takes plain data, and only changes what it is given', () => {
    expect(prefill_form({})).toEqual({});
    expect(prefill_form({ label: 'sweep', batches: ['ci', 'night-*'], model: model_from_parameters({ a: [1, 2] }), platform: 'linux', overwrite: false })).toEqual({
      experiment_name: 'sweep', selected_group: 'ci, night-*', platform: 'linux', overwrite: false,
      search_type: 'grid', parameter_search: '{\n  "a": [1, 2]\n}', values_mode: 'table',
    });
    expect(prefill_form({ model: model_from_text('return {a: [1]}') })).toMatchObject({ parameter_search: 'return {a: [1]}', values_mode: 'text' });
    expect(prefill_form({ model: model_from_parameters({ a: [1, 2] }), search_type: 'sampler', search_options: { n_iter: 7 } }).search_options).toEqual({ n_iter: 7 });
    expect(prefill_form({ parameter_search_auto: 'evaluations: 3' })).toEqual({ search_type: 'optimize', parameter_search_auto: 'evaluations: 3' });
  });
});

describe('starting from a previous batch', () => {
  const request = { batch_label: 'sweep', selected_group: ['ci', 'night'], platform: 'linux', overwrite: false, tuning_search: { search_type: 'grid', search_options: {}, parameter_search: { a: [1, 2], b: [1, 2, 3] } } };

  it('says in a few words what a batch tried', () => {
    expect(describe_request(request)).toBe('a, b: 6 combinations');
    expect(describe_request({ tuning_search: { search_type: 'sampler', search_options: { n_iter: 4 }, parameter_search: { a: [1, 2], b: [1, 2, 3] } } })).toBe('a, b: 4 combinations of 6');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: [{ a: 1 }, { a: 2, b: [1, 2] }] } })).toBe('a, b: 3 combinations');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: { a: 1, b: 1, c: 1, d: 1, e: [1, 2] } } })).toBe('a, b, c and 2 more: 2 combinations');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: {} } })).toBe('No tuning');
    expect(describe_request({ text: 'return {a: [1]}', tuning_search: { search_type: 'grid', parameter_search: { a: [1] } } })).toBe('Values from a function');
    expect(describe_request({ tuning_search: { search_type: 'optimize', parameter_search: 'evaluations: 3' } })).toBe('Automated tuning');
    expect(describe_request({ truncated: true, tuning_search: { search_type: 'grid', parameter_search: null } })).toBe('Many parameters (not kept)');
    expect(describe_request(undefined)).toBe('No tuning');
  });

  it('fills the form like it was', () => {
    expect(form_from_request(request)).toEqual({
      form: { experiment_name: 'sweep', selected_group: 'ci, night', overwrite: false, search_type: 'grid', platform: 'linux', parameter_search: '{\n  "a": [1, 2],\n  "b": [1, 2, 3]\n}', values_mode: 'table' },
      missing: null,
    });
    // the batches as older requests had them
    expect(request_batches({ selected_group: 'ci' })).toEqual(['ci']);
    expect(request_batches({ selected_group: 'ci, night', batches: ['ci', 'night'] })).toEqual(['ci', 'night']);
    // what the user wrote, when it was a function
    expect(form_from_request({ ...request, text: 'return {a: [1, 2]}' }).form).toMatchObject({ parameter_search: 'return {a: [1, 2]}', values_mode: 'text' });
    const optimize = form_from_request({ batch_label: 'auto', selected_group: ['ci'], overwrite: true, tuning_search: { search_type: 'optimize', parameter_search: 'evaluations: 30\n' } });
    expect(optimize.form).toEqual({ experiment_name: 'auto', selected_group: 'ci', overwrite: true, search_type: 'optimize', parameter_search_auto: 'evaluations: 30\n' });
    // read from an older command: the configuration was in a file
    const old = form_from_request({ batch_label: 'auto', selected_group: ['ci'], incomplete: true, tuning_search: { search_type: 'optimize', parameter_search: null } });
    expect(old.form.parameter_search_auto).toBeUndefined();
    expect(old.missing).toMatch(/configuration/);
    const big = form_from_request({ batch_label: 'big', selected_group: 'ci', truncated: true, tuning_search: { search_type: 'grid', parameter_search: null } });
    expect(big.form.parameter_search).toBeUndefined();
    expect(big.missing).toMatch(/too many/);
    // the label of the batch, when the request has none
    expect(form_from_request({ selected_group: ['ci'], tuning_search: { search_type: 'grid', parameter_search: {} } }, 'from-batch').form.experiment_name).toBe('from-batch');
  });
});
