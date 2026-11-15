/**
 * The table of "Choose the values", over the text that is sent, and "Start from a previous batch".
 * Run with: cd webapp && npm test -- parameters
 */
import {
  parse_sets, serialize_sets, format_parameters, set_combinations, parse_value, format_value, split_values, range_values,
  transformCDERegisters, pasted_parameters, compact_json,
} from '../parameters';
import { describe_request, form_from_request, request_batches, request_text } from '../history';

describe('the table over the text', () => {
  it('reads sets of parameters, and says when it cannot show the text', () => {
    expect(parse_sets('')).toEqual({ sets: [[]] });
    expect(parse_sets('{}')).toEqual({ sets: [[]] });
    expect(parse_sets('{"a": [1, 2], "b": "x"}')).toEqual({ sets: [[{ name: 'a', values: [1, 2] }, { name: 'b', values: ['x'] }]] });
    expect(parse_sets('[{"a": 1}, {"a": [2, 3]}]').sets).toEqual([[{ name: 'a', values: [1] }], [{ name: 'a', values: [2, 3] }]]);
    expect(parse_sets('return {a: [1, 2]}')).toEqual({ sets: null, reason: 'function' });
    expect(parse_sets('{"a": [1, ')).toEqual({ sets: null, reason: 'invalid' });
    expect(parse_sets('[1, 2]')).toEqual({ sets: null, reason: 'invalid' });
  });

  it('writes one line per parameter, without the rows being written', () => {
    const rows = [{ name: 'a.b', values: [1, 'x', [0, 1], { k: true }] }, { name: '', values: [1] }, { name: 'c', values: [] }];
    expect(serialize_sets([rows])).toBe('{\n  "a.b": [1, "x", [0, 1], {"k": true}]\n}');
    expect(serialize_sets([[], rows])).toBe('{\n  "a.b": [1, "x", [0, 1], {"k": true}]\n}');
    expect(serialize_sets([[{ name: 'a', values: [1] }], [{ name: 'a', values: [2] }]])).toBe('[\n  {\n    "a": [1]\n  },\n  {\n    "a": [2]\n  }\n]');
    expect(serialize_sets([[{ name: '', values: [] }]])).toBe('');
    // what we write is what we read
    const text = serialize_sets([rows, [{ name: 'd', values: [null, 1e-3] }]]);
    expect(serialize_sets(parse_sets(text).sets)).toBe(text);
    expect(JSON.parse(text)).toEqual([{ 'a.b': [1, 'x', [0, 1], { k: true }] }, { d: [null, 0.001] }]);
    expect(format_parameters({ a: [1, 2], b: 3 })).toBe('{\n  "a": [1, 2],\n  "b": [3]\n}');
    expect(format_parameters(null)).toBe('');
    expect(format_parameters({})).toBe('');
    expect(compact_json({ a: [1, [2, 3]], b: 'x' })).toBe('{"a": [1, [2, 3]], "b": "x"}');
  });

  it('counts combinations', () => {
    expect(set_combinations([])).toBe(1);
    expect(set_combinations([{ name: 'a', values: [1, 2] }, { name: 'b', values: [1, 2, 3] }, { name: '', values: [1, 2] }])).toBe(6);
  });

  it('reads what people type as values', () => {
    expect(parse_value(' 1.5 ')).toBe(1.5);
    expect(parse_value('1e-3')).toBe(0.001);
    expect(parse_value('true')).toBe(true);
    expect(parse_value('null')).toBe(null);
    expect(parse_value('high')).toBe('high');
    expect(parse_value('"1"')).toBe('1');
    expect(parse_value('[[0, 1], [1, 0]]')).toEqual([[0, 1], [1, 0]]);
    // registers
    expect(parse_value('[1 2 3]')).toEqual([1, 2, 3]);
    expect(parse_value('{"a": 1}')).toEqual({ a: 1 });
    expect(parse_value('[not json')).toBe('[not json');
    expect(split_values('1, 2,[3, 4]; "a, b"\n{"k": [1, 2]}')).toEqual(['1', '2', '[3, 4]', '"a, b"', '{"k": [1, 2]}']);
    expect(split_values(' , ')).toEqual([]);
  });

  it('shows values so that typing them back gives the same', () => {
    for (const value of [1, 0.5, true, null, 'high', '1', 'true', '', ' padded', 'a, b', '[1 2 3]', '[x', [0, 1], [[1, 2], [3, 4]], { a: 1 }]) {
      const shown = format_value(value);
      expect(split_values(shown).map(parse_value)).toEqual([value]);
    }
    expect(format_value('high')).toBe('high');
    expect(format_value('1')).toBe('"1"');
    expect(format_value([0, 1])).toBe('[0, 1]');
  });

  it('makes evenly spaced values', () => {
    expect(range_values({ from: 0, to: 1, count: 5 })).toEqual({ values: [0, 0.25, 0.5, 0.75, 1] });
    expect(range_values({ from: 0.1, to: 0.3, count: 3 })).toEqual({ values: [0.1, 0.2, 0.3] });
    expect(range_values({ from: 0.001, to: 1, count: 4, scale: 'log' })).toEqual({ values: [0.001, 0.01, 0.1, 1] });
    expect(range_values({ from: 5, to: 1, count: 3 })).toEqual({ values: [5, 3, 1] });
    // rounding can repeat values
    expect(range_values({ from: 0, to: 2, count: 5, integer: true })).toEqual({ values: [0, 1, 2] });
    expect(range_values({ from: 0, to: 1, count: 3, scale: 'log' }).error).toMatch(/above 0/);
    expect(range_values({ from: NaN, to: 1, count: 3 }).error).toBeTruthy();
    expect(range_values({ from: 0, to: 1, count: 1 }).error).toBeTruthy();
    expect(range_values({ from: 1, to: 1, count: 3 }).error).toBeTruthy();
    expect(range_values({ from: 0, to: 1, count: 5000 }).error).toBeTruthy();
  });

  it('converts registers pasted from CDE', () => {
    expect(transformCDERegisters('block.a=1000\nblock.hal|b="text"\nblock.def|c=on')).toBe('"block.a": [1000],\n"block.b": ["text"],\n"block.c": ["on"]');
    expect(transformCDERegisters('mixer.hal|gain=[1 2\n 0 0 ]')).toBe('"mixer.gain": [[[1, 2], [0, 0]]]');
    expect(transformCDERegisters('mixer.gain=[18 22 32]\n# a comment')).toBe('"mixer.gain": [[[18, 22, 32]]]\n# a comment');
    expect(pasted_parameters('block.a=1000\nblock.hal|b="text"')).toEqual([{ name: 'block.a', values: [1000] }, { name: 'block.b', values: ['text'] }]);
    expect(pasted_parameters('{"a": [1, 2], "b": 3}')).toEqual([{ name: 'a', values: [1, 2] }, { name: 'b', values: [3] }]);
    expect(pasted_parameters('"a": [1, 2],\n"b": [3]')).toEqual([{ name: 'a', values: [1, 2] }, { name: 'b', values: [3] }]);
    // a name
    expect(pasted_parameters('denoise.strength')).toBe(null);
    expect(pasted_parameters('')).toBe(null);
  });
});

describe('starting from a previous batch', () => {
  const request = { batch_label: 'sweep', selected_group: 'ci, night', batches: ['ci', 'night'], platform: 'linux', overwrite: false, tuning_search: { search_type: 'grid', search_options: {}, parameter_search: { a: [1, 2], b: [1, 2, 3] } } };

  it('says in a few words what a batch tried', () => {
    expect(describe_request(request)).toBe('a, b: 6 combinations');
    expect(describe_request({ tuning_search: { search_type: 'sampler', search_options: { n_iter: 4 }, parameter_search: { a: [1, 2], b: [1, 2, 3] } } })).toBe('a, b: 4 combinations of 6');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: [{ a: 1 }, { a: 2, b: [1, 2] }] } })).toBe('a, b: 3 combinations');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: { a: 1, b: 1, c: 1, d: 1, e: [1, 2] } } })).toBe('a, b, c and 2 more: 2 combinations');
    expect(describe_request({ tuning_search: { search_type: 'grid', parameter_search: {} } })).toBe('No tuning');
    expect(describe_request({ tuning_search: { search_type: 'optimize', parameter_search: 'evaluations: 3' } })).toBe('Automated tuning');
    expect(describe_request({ truncated: true, tuning_search: { search_type: 'grid', parameter_search: null } })).toBe('Many parameters (not kept)');
    expect(describe_request(undefined)).toBe('No tuning');
  });

  it('fills the form like it was', () => {
    expect(form_from_request(request)).toEqual({
      form: { experiment_name: 'sweep', selected_group: 'ci, night', overwrite: false, search_type: 'grid', platform: 'linux', parameter_search: '{\n  "a": [1, 2],\n  "b": [1, 2, 3]\n}' },
      missing: null,
    });
    // batches from before we remembered requests: one name
    expect(request_batches({ selected_group: 'ci' })).toBe('ci');
    // what the user wrote, when it was a function
    expect(request_text({ ...request, text: 'return {a: [1, 2]}' })).toBe('return {a: [1, 2]}');
    const optimize = form_from_request({ batch_label: 'auto', selected_group: 'ci', overwrite: true, tuning_search: { search_type: 'optimize', parameter_search: 'evaluations: 30\n' } });
    expect(optimize.form).toEqual({ experiment_name: 'auto', selected_group: 'ci', overwrite: true, search_type: 'optimize', parameter_search_auto: 'evaluations: 30\n' });
    // read from an older command: the configuration was in a file
    const old = form_from_request({ batch_label: 'auto', selected_group: 'ci', truncated: true, tuning_search: { search_type: 'optimize', parameter_search: null } });
    expect(old.form.parameter_search_auto).toBeUndefined();
    expect(old.missing).toMatch(/configuration/);
    const big = form_from_request({ batch_label: 'big', selected_group: 'ci', truncated: true, tuning_search: { search_type: 'grid', parameter_search: null } });
    expect(big.form.parameter_search).toBeUndefined();
    expect(big.missing).toMatch(/too many/);
    expect(form_from_request({ batch_label: 's', selected_group: 'ci', tuning_search: { search_type: 'sampler', search_options: { n_iter: 7 }, parameter_search: { a: [1, 2] } } }).form.search_options).toEqual({ n_iter: 7 });
  });
});
