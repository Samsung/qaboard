// Dynamic options: values found in each output's files (e.g. :frame/out.png), merged for the controls panel
import { calculateOptionValues, configureOption, mergeOptions, parseVisualizationOptions, resolveOptionValue } from '../utils/dynamicOptions';

const options_for = (path, files) => {
  const { options } = parseVisualizationOptions([{ name: 'Out', path }]);
  return Object.fromEntries(Object.entries(options).map(([name, option]) => [name, configureOption(option, calculateOptionValues(option, files))]));
};

test('values are sorted like numbers: 2 before 10', () => {
  const { frame } = options_for(':frame/out.png', ['10/out.png', '2/out.png', '1/out.png']);
  expect(frame.values).toEqual(['1', '2', '10']);
  expect(frame.type).toBe('select'); // not sequential
  expect(frame.defaultValue).toBe('10');
});

test('sequential numbers get a slider, the default is the last one', () => {
  const { frame } = options_for(':frame/out.png', ['0/out.png', '1/out.png', '2/out.png']);
  expect(frame).toMatchObject({ type: 'slider', min: 0, max: 2, defaultValue: '2' });
});

test('outputs with different values are merged into one option with all values', () => {
  const run_a = options_for(':frame/out.png', ['1/out.png', '2/out.png']);
  const run_b = options_for(':frame/out.png', ['5/out.png', '6/out.png']);
  const merged = mergeOptions([run_a, run_b]);
  expect(Object.keys(merged)).toEqual(['frame']);
  expect(merged.frame.values).toEqual(['1', '2', '5', '6']);
  // not sequential anymore: no stale slider settings from the outputs
  expect(merged.frame.type).toBe('select');
  expect(merged.frame).toMatchObject({ min: 1, max: 6 });
  expect(merged.frame.defaultValue).toBe('6');
  expect(merged.frame.views).toEqual(['Out']);
  expect(merged.frame.paths).toEqual([':frame/out.png']);
});

test('merging is stable: the same registrations give equal options', () => {
  const run = options_for(':camera/out.png', ['left/out.png', 'right/out.png']);
  expect(JSON.stringify(mergeOptions([run, run]))).toBe(JSON.stringify(mergeOptions([run])));
  expect(mergeOptions([run]).camera).toMatchObject({ type: 'select', values: ['left', 'right'], defaultValue: 'left' });
});

describe('resolveOptionValue', () => {
  const frames = configureOption({ name: 'frame' }, ['1', '2', '10']);
  const cameras = configureOption({ name: 'camera' }, ['left', 'right']);

  test('without a selection: the default', () => {
    expect(resolveOptionValue(frames, undefined)).toEqual({ value: '10', exact: true });
    expect(resolveOptionValue(cameras, null)).toEqual({ value: 'left', exact: true });
  });
  test('the selection when the output has it', () => {
    expect(resolveOptionValue(frames, '2')).toEqual({ value: '2', exact: true });
  });
  test('otherwise the closest number', () => {
    expect(resolveOptionValue(frames, '8')).toEqual({ value: '10', exact: false });
    expect(resolveOptionValue(frames, '3')).toEqual({ value: '2', exact: false });
    expect(resolveOptionValue(frames, '-5')).toEqual({ value: '1', exact: false });
  });
  test('or the default', () => {
    expect(resolveOptionValue(cameras, 'center')).toEqual({ value: 'left', exact: false });
    expect(resolveOptionValue(frames, 'abc')).toEqual({ value: '10', exact: false });
  });
  test('options without values', () => {
    expect(resolveOptionValue(configureOption({ name: 'x' }, []), '1')).toEqual({ value: undefined, exact: false });
  });
});
