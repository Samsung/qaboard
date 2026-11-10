/**
 * The benchmark viewer's parser and model: the harnesses' files, matching with the reference, noise, sorting.
 * The fixtures are shared with the Python package's tests (tests/test_benchmarks.py): both parsers must give their
 * *.expected.benchmarks.json. Run with: cd webapp && npm test -- benchmarks
 */
import fs from 'node:fs';
import path from 'node:path';

import { detectFormat, parseBenchmarks, shortName, toNormalized } from '../benchmarks/parse';
import {
  changeDomain, classify, compareBenchmarks, contextDifferences, formatPercent, formatTime, formatAmount, groupRows,
  rowFilter, sortRows, spreadOf, summarize,
} from '../benchmarks/model';

const FIXTURES = path.join(import.meta.dirname, '../../../../tests/fixtures/benchmarks');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
// the files the web app reads: a Criterion directory is only read by the Python package
const FILES = fs.readdirSync(FIXTURES).filter(name => !name.includes('.expected.') && fs.statSync(path.join(FIXTURES, name)).isFile());
const expected = name => JSON.parse(read(`${name.replace(/(\.benchmarks)?\.(json|jsonl|txt)$/, '')}.expected.benchmarks.json`));

// Where two values differ, with numbers equal within a relative 1e-12, as in the Python tests
const differences = (actual, wanted, where = '', found = []) => {
  if (wanted && typeof wanted === 'object') {
    const keys = Object.keys(wanted);
    if (!actual || typeof actual !== 'object' || Object.keys(actual).sort().join() !== [...keys].sort().join())
      found.push(`${where}: keys ${JSON.stringify(Object.keys(actual ?? {}))} != ${JSON.stringify(keys)}`);
    else for (const key of keys) differences(actual[key], wanted[key], `${where}.${key}`, found);
  } else if (typeof wanted === 'number') {
    if (!(Math.abs(actual - wanted) <= 1e-12 * Math.max(Math.abs(actual), Math.abs(wanted)))) found.push(`${where}: ${actual} != ${wanted}`);
  } else if (actual !== wanted) {
    found.push(`${where}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
  }
  return found;
};

const bench = (name, value, stats = {}, extra = {}) => ({ name, value, unit: 's', group: null, params: {}, statistic: 'mean', smaller_is_better: true, stats, throughput: null, ...extra });

describe('parseBenchmarks', () => {
  it('reads every fixture like the Python package', () => {
    expect(FILES).toHaveLength(8);
    for (const name of FILES) {
      const parsed = parseBenchmarks(read(name));
      expect({ name, error: parsed.error }).toEqual({ name, error: null });
      expect(differences(toNormalized(parsed), expected(name), name)).toEqual([]);
    }
    // the check checks
    expect(differences({ a: [1, { b: 2 }] }, { a: [1, { b: 2.0000001 }] })).toEqual(['.a.1.b: 2 != 2.0000001']);
  });

  it('detects the format', () => {
    expect(Object.fromEntries(FILES.map(name => [name, parseBenchmarks(read(name)).source]))).toEqual({
      'cargo-criterion.jsonl': 'criterion',
      'go-bench.txt': 'go',
      'google-benchmark-repetitions.json': 'google-benchmark',
      'google-benchmark.json': 'google-benchmark',
      'hyperfine.json': 'hyperfine',
      'jmh.json': 'jmh',
      'kitefin.benchmarks.json': 'kitefin-bench 2.3',
      'pytest-benchmark.json': 'pytest-benchmark',
    });
    expect(detectFormat({ a: 1 })).toBeNull();
    expect(detectFormat(undefined, 'hello')).toBeNull();
  });

  it('says why a file cannot be read', () => {
    expect(parseBenchmarks('').error).toMatch(/unknown benchmark file/);
    expect(parseBenchmarks('<html/>').error).toMatch(/unknown benchmark file/);
    expect(parseBenchmarks('{}', { format: 'jmh' }).error).toMatch(/not a JMH file/);
    expect(parseBenchmarks('{"qaboard_benchmarks": 1, "benchmarks": [{"name": "a"}]}').error).toMatch(/benchmarks\[0\]/);
    expect(parseBenchmarks('{"qaboard_benchmarks": 2, "benchmarks": []}').error).toMatch(/unsupported version/);
    expect(parseBenchmarks('{"reason": "benchmark-complete"}\n{oops').error).toBeTruthy();
    expect(parseBenchmarks(' '.repeat(100e6 + 1)).error).toMatch(/too large to show \(100 MB/);
    // forced
    expect(parseBenchmarks(read('hyperfine.json'), { format: 'hyperfine' }).source).toBe('hyperfine');
  });

  it("reads NaN and Infinity, that Python's json module writes, as missing", () => {
    const text = '{"machine_info": {"node": "n"}, "benchmarks": [{"name": "test_a", "fullname": "t.py::test_a", '
      + '"stats": {"mean": 1e-3, "stddev": NaN, "rounds": 1, "ops": Infinity, "min": -Infinity}}]}';
    const { benchmarks, error } = parseBenchmarks(text);
    expect(error).toBeNull();
    expect(benchmarks[0].stats).toEqual({ mean: 1e-3, rounds: 1 });
  });

  it('keeps names unique', () => {
    const { benchmarks } = parseBenchmarks(JSON.stringify({ results: [{ command: 'sleep 0.1', mean: 0.1 }, { command: 'sleep 0.1', mean: 0.2 }] }));
    expect(benchmarks.map(b => b.name)).toEqual(['sleep 0.1', 'sleep 0.1 #2']);
  });

  it('shows names without their group', () => {
    expect(shortName({ name: 'BM_Encode/64', group: 'BM_Encode' })).toBe('64');
    expect(shortName({ name: 'tests/test_codec.py::test_encode[64]', group: 'codec' })).toBe('test_encode[64]');
    expect(shortName({ name: 'example.com/codec.BenchmarkDecode', group: 'example.com/codec' })).toBe('BenchmarkDecode');
    expect(shortName({ name: 'fibonacci', group: 'fib' })).toBe('fibonacci');
  });
});

describe('classify', () => {
  it('is within noise when the change is no larger than the larger spread', () => {
    expect(classify(bench('a', 1.04, { stddev: 0.02 }), bench('a', 1.0, { stddev: 0.05 })).status).toBe('noise');
    expect(classify(bench('a', 1.06, { stddev: 0.02 }), bench('a', 1.0, { stddev: 0.05 })).status).toBe('slower');
    expect(classify(bench('a', 0.9, { stddev: 0.02 }), bench('a', 1.0, { stddev: 0.05 })).status).toBe('faster');
    // other spreads, when there is no standard deviation
    expect(classify(bench('a', 1.05, { iqr: 0.1 }), bench('a', 1.0)).status).toBe('noise');
    expect(spreadOf(bench('a', 1, { mad: 0.1, error: 0.2 }))).toMatchObject({ key: 'mad', value: 0.1 });
    // without a spread, any change counts
    expect(classify(bench('a', 1.001), bench('a', 1.0)).status).toBe('slower');
    expect(classify(bench('a', 1.0), bench('a', 1.0)).status).toBe('same');
  });

  it('knows that a larger throughput is better', () => {
    const ops = (value, stddev) => bench('ops', value, { stddev }, { unit: 'ops/s', smaller_is_better: false });
    expect(classify(ops(120, 2), ops(100, 2)).status).toBe('faster');
    expect(classify(ops(80, 2), ops(100, 2)).status).toBe('slower');
    const [row] = compareBenchmarks([ops(80, 2)], [ops(100, 2)]);
    // 25% more time per operation
    expect(row.change).toBeCloseTo(0.25);
  });

  it('flags a change of unit', () => {
    expect(classify(bench('a', 1), bench('a', 1, {}, { unit: 'ops/s' })).status).toBe('unit');
  });
});

describe('compareBenchmarks', () => {
  const NEW = [bench('a', 1.2, { stddev: 0.01 }), bench('b', 1.0, { stddev: 0.1 }), bench('c', 0.5), bench('new', 1)];
  const REF = [bench('a', 1.0, { stddev: 0.01 }), bench('b', 1.05, { stddev: 0.1 }), bench('c', 1.0), bench('gone', 1)];
  const rows = compareBenchmarks(NEW, REF);

  it('matches by name', () => {
    expect(rows.map(r => [r.key, r.status])).toEqual([['a', 'slower'], ['b', 'noise'], ['c', 'faster'], ['new', 'added'], ['gone', 'missing']]);
    const summary = summarize(rows);
    expect(summary.counts).toMatchObject({ slower: 1, faster: 1, noise: 1, added: 1, missing: 1 });
    // (1.2 × 1/1.05 × 0.5)^(1/3)
    expect(summary.geomean).toBeCloseTo(Math.cbrt(1.2 / 1.05 * 0.5) - 1);
  });

  it('works without a reference', () => {
    const alone = compareBenchmarks(NEW, null);
    expect(alone.every(r => r.status === null && r.change === null)).toBe(true);
    expect(summarize(alone).geomean).toBeNull();
  });

  it('sorts', () => {
    expect(sortRows(rows, 'regressions').map(r => r.key)).toEqual(['a', 'gone', 'new', 'b', 'c']);
    expect(sortRows(rows, 'improvements').map(r => r.key)).toEqual(['c', 'new', 'gone', 'b', 'a']);
    expect(sortRows(rows, 'name').map(r => r.key)).toEqual(['a', 'b', 'c', 'gone', 'new']);
    expect(sortRows(rows, 'time')[0].key).toBe('a');
  });

  it('filters', () => {
    expect(rows.filter(rowFilter({ only_changed: true })).map(r => r.key)).toEqual(['a', 'c', 'new', 'gone']);
    expect(rows.filter(rowFilter({ search: 'g' })).map(r => r.key)).toEqual(['gone']);
    expect(rows.filter(rowFilter({ search: '-a -b' })).map(r => r.key)).toEqual(['c', 'new', 'gone']);
    expect(rows.filter(rowFilter({ statuses: new Set(['slower']) })).map(r => r.key)).toEqual(['a']);
    expect(rowFilter({})).toBeNull();
  });

  it('groups, in the order of the sort', () => {
    const grouped = compareBenchmarks(
      [bench('x/1', 1, {}, { group: 'x' }), bench('y/1', 2, {}, { group: 'y' }), bench('x/2', 1, {}, { group: 'x' })],
      [bench('x/1', 1, {}, { group: 'x' }), bench('y/1', 1, {}, { group: 'y' }), bench('x/2', 1, {}, { group: 'x' })],
    );
    const items = groupRows(sortRows(grouped, 'regressions'));
    expect(items.map(i => i.key)).toEqual(['g:y', 'b:y/1', 'g:x', 'b:x/1', 'b:x/2']);
    expect(items[0].counts.slower).toBe(1);
    expect(groupRows(grouped, new Set(['x'])).map(i => i.key)).toEqual(['g:x', 'g:y', 'b:y/1']);
    // no headers without groups
    expect(groupRows(rows).every(i => i.kind === 'benchmark')).toBe(true);
  });

  it('scales the bars to most changes', () => {
    expect(changeDomain(rows)).toBe(0.5);
    expect(changeDomain([])).toBe(0.05);
  });
});

describe('contextDifferences', () => {
  it('warns about different CPUs', () => {
    expect(contextDifferences({ cpu: 'A', cpu_count: 8 }, { cpu: 'B', cpu_count: 4 }).warnings).toEqual([['CPU', 'A', 'B'], ['CPU count', 8, 4]]);
    // another host, with the same CPU: a note
    expect(contextDifferences({ cpu: 'A', machine: 'x' }, { cpu: 'A', machine: 'y' })).toEqual({ warnings: [], notes: [['Machine', 'x', 'y']] });
    // another host, without the CPU's model: we can't tell
    expect(contextDifferences({ machine: 'x' }, { machine: 'y' }).warnings).toHaveLength(1);
    expect(contextDifferences({}, null)).toEqual({ warnings: [], notes: [] });
  });
});

describe('format', () => {
  it('shows times and amounts readably', () => {
    expect(formatTime(1.9787e-6)).toBe('1.98 µs');
    expect(formatTime(6.23e-8)).toBe('62.3 ns');
    expect(formatTime(0.003284)).toBe('3.28 ms');
    expect(formatTime(12.5)).toBe('12.5 s');
    expect(formatAmount(1.0274e9, 'B/s')).toBe('1.03 GB/s');
    expect(formatAmount(182000, 'msg/s')).toBe('182 kmsg/s');
    expect(formatPercent(0.1234)).toBe('+12.3%');
    expect(formatPercent(-0.05)).toBe('−5.0%');
    expect(formatPercent(0.0004)).toBe('+0.04%');
  });
});
