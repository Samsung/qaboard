/**
 * The series viewer's parser: what runs log while they run, from series.json or series.jsonl.
 * The fixtures are shared with the Python package's tests (tests/test_series.py): both must give the
 * *.expected.json. Run with: cd webapp && npm test -- series
 */
import fs from 'node:fs';
import path from 'node:path';

import { format_duration, is_series, parse_series, smooth, sorted_keys } from '../series/series';
import { with_logged_series } from '../runView';

const FIXTURES = path.join(import.meta.dirname, '../../../../tests/fixtures/series');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
const expected = name => {
  const { started_at, series } = JSON.parse(read(name));
  return { started_at, series };
};

describe('parse_series', () => {
  it('reads a series.jsonl like Python does', () => {
    expect(parse_series(read('training.series.jsonl'))).toEqual(expected('training.expected.json'));
  });

  it('keeps a bounded number of points, like Python does', () => {
    expect(parse_series(read('training.series.jsonl'), { max_points: 2 })).toEqual(expected('training.downsampled.expected.json'));
  });

  it('reads a series.json, as text or parsed', () => {
    const text = read('training.downsampled.expected.json');
    expect(parse_series(text)).toEqual(expected('training.downsampled.expected.json'));
    expect(parse_series({ ...JSON.parse(text), updated_at: 1731500010 })).toEqual({ ...expected('training.downsampled.expected.json'), updated_at: 1731500010 });
  });

  it('stays small for long runs, and keeps the spikes', () => {
    const lines = [];
    for (let step = 0; step < 50000; step++)
      lines.push(JSON.stringify({ _step: step, _time: step, loss: step === 12345 ? 1000 : step % 7 }));
    const { series: { loss } } = parse_series(lines.join('\n'));
    expect(loss.points).toBe(50000);
    expect(loss.step.length).toBeGreaterThanOrEqual(500);
    expect(loss.step.length).toBeLessThanOrEqual(1000);
    expect(loss.step.at(-1)).toBe(49999);
    expect(Math.max(...loss.max)).toBe(1000);
  });

  it('a single line of history is not mistaken for a summary', () => {
    expect(parse_series('{"_step": 3, "_time": 10, "loss": 0.5}').series.loss).toEqual({ points: 1, step: [3], time: [0], value: [0.5] });
  });

  it("says when a file isn't series", () => {
    expect(() => parse_series('')).toThrow('empty file');
    expect(() => parse_series('hello\nworld')).toThrow('no line is a JSON object');
    expect(() => parse_series('{"model": "resnet50", "series": "another format"}')).toThrow('no line has a number');
    expect(() => parse_series('{"format": "other", "series": {}}')).toThrow('not a qaboard-series file');
    expect(() => parse_series({ results: [] })).toThrow('not a qaboard-series file');
    expect(() => parse_series({ format: 'qaboard-series', series: [1] })).toThrow('no series');
  });

  it('ignores series whose columns disagree', () => {
    const { series } = parse_series({ format: 'qaboard-series', series: { ok: { step: [0, 1], value: [1, 2] }, bad: { step: [0, 1], value: [1] }, worse: null } });
    expect(series).toEqual({ ok: { points: 2, step: [0, 1], time: [0, 0], value: [1, 2] } });
  });
});

describe('smooth', () => {
  it('does nothing without a weight', () => {
    const values = [1, 2, 3];
    expect(smooth(values, 0)).toBe(values);
  });

  it('is an exponential moving average, without a bias to zero at the start', () => {
    const smoothed = smooth([1, 1, 1, 1], 0.9);
    smoothed.forEach(value => expect(value).toBeCloseTo(1, 10));
    const noisy = smooth([0, 10, 0, 10, 0, 10], 0.8);
    expect(noisy[0]).toBe(0);
    expect(noisy.at(-1)).toBeGreaterThan(3);
    expect(noisy.at(-1)).toBeLessThan(7);
  });

  it('keeps the gaps', () => {
    expect(smooth([1, null, 1], 0.5)).toEqual([1, null, 1]);
  });
});

describe('helpers', () => {
  it('groups the series by their prefix', () => {
    expect(sorted_keys(['val/loss', 'lr', 'train/loss', 'train/acc', 'epoch'])).toEqual(['epoch', 'lr', 'train/acc', 'train/loss', 'val/loss']);
  });

  it('formats durations', () => {
    expect([42, 125, 3725].map(format_duration)).toEqual(['42s', '2m 05s', '1h 02m']);
  });

  it('knows series files by their name', () => {
    for (const name of ['series.json', 'series.jsonl', 'results/series.json', 'train.series.jsonl', 'eval_series.json'])
      expect([name, is_series(name)]).toEqual([name, true]);
    for (const name of ['timeseries.json', 'series.txt', 'series.json.bak', 'metrics.json', undefined])
      expect([name, is_series(name)]).toEqual([name, false]);
  });
});

describe('with_logged_series', () => {
  const views = [{ name: 'Output', path: 'out.png' }];
  const from_code = { data: { sdk: { script: 'train.py' } } };

  it("shows a run's series first, without anything in qaboard.yaml", () => {
    expect(with_logged_series(views, { 'series.json': {}, 'series.jsonl': {}, 'out.png': {} }, from_code)).toEqual([
      { name: 'Logged series', path: 'series.json', type: 'series', logged_series: true }, ...views,
    ]);
    // written by another program: only the history
    expect(with_logged_series([], { 'series.jsonl': {} }, from_code)[0].path).toBe('series.jsonl');
    // a `qa run`'s own series.json isn't ours to show
    expect(with_logged_series(views, { 'series.json': {} }, { data: {} })).toBe(views);
  });

  it('changes nothing for runs without series, or before their files are known', () => {
    expect(with_logged_series(views, { 'out.png': {} }, from_code)).toBe(views);
    expect(with_logged_series(views, undefined, from_code)).toBe(views);
  });

  it("leaves it to the project when its visualizations list the series", () => {
    const listed = [...views, { name: 'Curves', path: 'series.json', default_hidden: true }];
    expect(with_logged_series(listed, { 'series.json': {} }, from_code)).toBe(listed);
    const typed = [{ name: 'Curves', path: 'logs/history.jsonl', type: 'series' }];
    expect(with_logged_series(typed, { 'series.json': {} }, from_code)).toBe(typed);
  });
});
