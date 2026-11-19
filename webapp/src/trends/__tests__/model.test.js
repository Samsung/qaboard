// cd webapp && npm test -- trends
import { describe, expect, it } from 'vitest';
import {
  buildSeries, compositions, findGroup, scopeOf, changeOf, movers, groupIndex, trendsOf, hasTrends,
  compositionKeys, hasGroups, samplePoints, formatRatio, valueAt,
} from '../model';
import { buildTestHistory, VIEWS, packagesOf, commonPackage } from '../testHistory';
import { generate, TEST_DEFINITIONS } from '../generate';

const point = (id, runs) => ({ id, label: id, runs: runs.map((metrics, i) => ({ name: `run${i}`, metrics })) });
const bench = (group, extra = {}) => ({ group, smaller_is_better: true, ...extra });

describe('series over commits', () => {
  it('aggregates a commit\'s runs as the definition says', () => {
    const p = point('a', [{ tests: 10, time: 1 }, { tests: 30, time: 3 }, { time: 8 }]);
    expect(valueAt(p, 'tests', { aggregation: 'sum' })).toBe(40);
    expect(valueAt(p, 'time', {})).toBe(3);
    expect(valueAt(p, 'time', { aggregation: 'average' })).toBe(4);
    expect(valueAt(p, 'missing', {})).toBeNull();
    // only some runs
    expect(valueAt(p, 'tests', { aggregation: 'sum' }, run => run.name === 'run1')).toBe(30);
  });

  it('reads what the server aggregated when commits come without runs', () => {
    const points = [{ id: 'a', aggregated: { tests_sum: 40, tests_median: 20 } }, { id: 'b', aggregated: {} }];
    const [series] = buildSeries(points, { tests: { aggregation: 'sum' } });
    expect(series.values).toEqual([40, null]);
  });

  it('finds totals with their parts, and the groups of the other metrics', () => {
    const points = [point('a', [{ tests: 3, passed: 2, failed: 1, test_time: 5, bench_a: 1, bench_b: 2, loose: 1 }])];
    const definitions = { ...TEST_DEFINITIONS, bench_a: bench('Benchmarks/codec'), bench_b: bench('Benchmarks/maps/tiles') };
    const trends = trendsOf(points, definitions);
    expect(hasTrends(trends)).toBe(true);
    expect(trends.composed).toHaveLength(1);
    const [tests] = trends.composed;
    expect(tests.key).toBe('tests');
    expect(tests.parts.map(s => s.key)).toEqual(['passed', 'failed']);
    expect(tests.extras.map(s => s.key)).toEqual(['test_time']);
    // the tests' metrics aren't listed again as a group; metrics without a group stay at the root
    expect(trends.tree.children.map(c => c.name)).toEqual(['Benchmarks']);
    expect(trends.tree.series.map(s => s.key)).toEqual(['loose']);
    expect(findGroup(trends.tree, ['Benchmarks', 'maps', 'tiles']).all.map(s => s.key)).toEqual(['bench_b']);
    expect(findGroup(trends.tree, ['Benchmarks']).all).toHaveLength(2);
    expect(compositionKeys(definitions).sort()).toEqual(Object.keys(TEST_DEFINITIONS).sort());
    expect(hasGroups(definitions)).toBe(true);
    expect(hasGroups(TEST_DEFINITIONS)).toBe(false);
  });

  it('gives the main color of an intent to its biggest part', () => {
    const points = [point('a', [{ tests: 10, failed: 5, errors: 1 }])];
    const [tests] = compositions(buildSeries(points, TEST_DEFINITIONS));
    expect(tests.parts.map(s => s.key)).toEqual(['failed', 'errors']);
  });
});

describe('scope', () => {
  const series = values => ({ key: 'k', definition: { smaller_is_better: true }, values });
  it('tells metrics in every commit from those added, removed or missing in between', () => {
    const common = series([1, null, 1, 1]), added = series([null, null, 1, 1]), removed = series([1, null, 1, null]), partial = series([1, null, null, 1]);
    const scope = scopeOf([common, added, removed, partial], 4);
    // the second commit measured nothing: it doesn't narrow the scope
    expect(scope.measured).toEqual([0, 2, 3]);
    expect(scope.common).toEqual([common]);
    expect(scope.added).toEqual([added]);
    expect(scope.removed).toEqual([removed]);
    expect(scope.partial).toEqual([partial]);
  });

  it('summarizes the same metrics at every commit', () => {
    const steady = series([10, 10, 10]), doubled = series([1, 1, 2]), added = series([null, 100, 100]);
    const same = groupIndex([steady, doubled, added], 3);
    expect(same.members).toHaveLength(2);
    expect(same.values[0]).toBe(1);
    expect(same.values[2]).toBeCloseTo(Math.SQRT2);
    // without it, each commit averages what it has
    const all = groupIndex([steady, doubled, added], 3, { same_scope: false });
    expect(all.counts).toEqual([2, 3, 3]);
    expect(all.values[2]).toBeCloseTo(2 ** (1 / 3));
  });
});

describe('changes', () => {
  const series = (values, smaller_is_better = true) => ({ key: 'k', label: 'k', definition: { smaller_is_better }, values });
  it('says which way, where the biggest move was, and whether it is a step', () => {
    const change = changeOf(series([10, 10.1, 9.9, 10, 13, 13.1, 12.9]));
    expect(change.direction).toBe('worse');
    expect(change.ratio).toBeCloseTo(1.29);
    expect(change.step.index).toBe(4);
    expect(change.notable).toBe(true);
    expect(change.stepped).toBe(true);
    expect(changeOf(series([10, 10.1, 9.9, 10, 13, 13.1, 12.9], false)).direction).toBe('better');
    expect(changeOf(series([10, 10.1, 9.9, 10, 13, 13.1, 12.9], null)).direction).toBe('changed');
  });
  it('compares with the commit before when asked', () => {
    const change = changeOf(series([10, 20, 20, null]), { baseline: 'previous' });
    expect(change.ratio).toBe(1);
    expect(change.direction).toBe('same');
  });
  it('leaves wobble out of the movers', () => {
    const noisy = series([10, 11, 9.5, 10.6, 9.4, 10.8]);
    const drift = series([10, 10.5, 11, 11.6, 12.1, 12.8, 13.4]);
    const rows = movers([noisy, drift]);
    expect(rows.map(r => r.series)).toEqual([drift]);
    expect(rows.quiet).toBe(1);
    expect(rows[0].change.stepped).toBe(false);
  });
  it('needs two values', () => {
    expect(changeOf(series([null, 3, null]))).toBeNull();
  });
});

describe('each test over the commits', () => {
  const t = (id, status, time = 0.1) => ({ id, name: id, path: ['pkg', id.split('_')[0], id], status, time });
  const reports = [
    [t('a_ok', 'passed'), t('a_breaks', 'passed'), t('b_flaky', 'passed'), t('b_fixed', 'failed'), t('a_gone', 'passed'), t('b_slow', 'passed', 1)],
    null,
    [t('a_ok', 'passed'), t('a_breaks', 'failed'), t('b_flaky', 'failed'), t('b_fixed', 'failed'), t('a_gone', 'passed'), t('b_slow', 'passed', 1)],
    [t('a_ok', 'passed'), t('a_breaks', 'error'), t('b_flaky', 'passed'), t('b_fixed', 'passed'), t('b_slow', 'passed', 3), t('a_new', 'passed')],
  ];
  const history = buildTestHistory(reports);
  const ids = view => history.tests.filter(VIEWS.find(v => v.id === view).is).map(test => test.id).sort();
  it('finds what changed', () => {
    expect(history.loaded).toEqual([0, 2, 3]);
    expect(ids('failing')).toEqual(['a_breaks']);
    expect(history.tests.find(test => test.id === 'a_breaks').failing_since).toBe(2);
    expect(ids('flaky')).toEqual(['b_flaky']);
    expect(ids('fixed')).toEqual(['b_fixed']);
    expect(history.tests.find(test => test.id === 'b_fixed').fixed_at).toBe(3);
    expect(ids('added')).toEqual(['a_new']);
    expect(ids('removed')).toEqual(['a_gone']);
    expect(history.tests.find(test => test.id === 'a_gone').removed_at).toBe(3);
    expect(ids('slower')).toEqual(['b_slow']);
  });
  it('lists packages below the one all tests share', () => {
    expect(commonPackage(history.tests)).toEqual(['pkg']);
    const packages = packagesOf(history.tests, ['pkg']);
    expect(packages.map(p => [p.name, p.total, p.counts.failing])).toEqual([['a', 4, 1], ['b', 3, 0]]);
  });
  it('needs no report', () => {
    expect(buildTestHistory([null, null])).toEqual({ loaded: [], tests: [] });
  });
});

describe('the generated project', () => {
  const { points, definitions, reports } = generate({ commits: 40, tests: 500, benchmarks: 60 });
  const trends = trendsOf(points, definitions);
  it('has the regression to find, at the top of the movers', () => {
    const benchmarks = findGroup(trends.tree, ['Benchmarks']);
    const rows = movers(benchmarks.all);
    expect(rows[0].series.key).toMatch(/^bench_codec_decode_/);
    expect(rows[0].change.direction).toBe('worse');
    expect(rows[0].change.step.index).toBe(Math.floor(40 * 0.62));
    expect(rows.at(-1).series.key).toMatch(/^bench_maps_tile_load_/);
    const scope = scopeOf(benchmarks.all, points.length);
    expect(scope.added.length).toBeGreaterThan(0);
    expect(scope.common.length + scope.added.length + scope.removed.length + scope.partial.length).toBe(60);
  });
  it('has tests that fail now', () => {
    const history = buildTestHistory(reports);
    expect(history.tests.filter(VIEWS[0].is).length).toBeGreaterThan(0);
    expect(points.at(-1).runs[0].metrics.tests).toBe(reports.at(-1).length);
  });
});

describe('helpers', () => {
  it('samples commits, keeping the first and the last', () => {
    const points = Array.from({ length: 250 }, (_, i) => i);
    const sampled = samplePoints(points, 100);
    expect(sampled).toHaveLength(100);
    expect([sampled[0], sampled.at(-1)]).toEqual([0, 249]);
    expect(samplePoints([1, 2], 100)).toEqual([1, 2]);
  });
  it('formats ratios', () => {
    expect(formatRatio(1.034)).toBe('+3.4%');
    expect(formatRatio(0.88)).toBe('−12%');
    expect(formatRatio(1)).toBe('0%');
  });
});
