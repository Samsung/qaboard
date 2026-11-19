// cd webapp && npm test -- CommitsTrends
import { describe, expect, it } from 'vitest';
import { pointsOf } from '../CommitsTrends';
import { aggregation_metrics } from '../hooks';
import { normalize_commit } from '../api/normalize';
import { trendsOf, hasTrends, AGGREGATIONS, INTENTS } from '../trends/model';
import { compositionKeys, hasGroups, listMetricKeys, MAX_LIST_METRICS } from '../metricGroups';
import schema from 'qaboard-schemas/metrics.schema.json';
import junit from '../../../tests/fixtures/metrics/junit-definitions.json';
import { TEST_DEFINITIONS } from '../trends/generate';

const commit = (id, date, batch) => ({ id, authored_datetime: date, message: `${id}\n\ndetails`, batches: { default: batch } });

describe('commits as points', () => {
  it('reads what the server aggregated for lists of commits, which come without runs', () => {
    // as the API answers, then as the app keeps them: batches always get `outputs`
    const commits = [
      commit('bbbbbbbbbbbb', '2026-11-02T10:00:00+00:00', { aggregated_metrics: { tests_sum: 12, passed_sum: 11, failed_sum: 1 } }),
      commit('aaaaaaaaaaaa', '2026-11-01T10:00:00+00:00', { aggregated_metrics: { tests_sum: 10, passed_sum: 10, failed_sum: 0 } }),
    ].map(normalize_commit);
    const points = pointsOf(commits, { project: 'group/project' });
    expect(points.map(p => p.label)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(points[0].runs).toBeUndefined();
    expect(points[1]).toMatchObject({ message: 'bbbbbbbbbbbb', href: '/group/project/commit/bbbbbbbbbbbb' });
    const trends = trendsOf(points, TEST_DEFINITIONS);
    expect(hasTrends(trends)).toBe(true);
    expect(trends.composed[0].total.values).toEqual([10, 12]);
  });

  it('keeps the runs the server would aggregate, that match the filter', () => {
    const outputs = {
      1: { test_input_path: 'unit', metrics: { tests: 5 } },
      2: { test_input_path: 'e2e', metrics: { tests: 7 } },
      3: { test_input_path: 'unit-failed', metrics: { tests: 100 }, is_failed: true },
      4: { test_input_path: 'unit-pending', metrics: {}, is_pending: true },
      5: { test_input_path: 'unit-deleted', metrics: { tests: 100 }, deleted: true },
    };
    const commits = [commit('aaaaaaaaaaaa', '2026-11-01T10:00:00+00:00', { outputs })];
    expect(pointsOf(commits, { project: 'p', with_runs: true })[0].runs.map(run => run.name)).toEqual(['unit', 'e2e']);
    expect(pointsOf(commits, { project: 'p', with_runs: true, filter: 'e2e' })[0].runs.map(run => run.name)).toEqual(['e2e']);
  });

  it('orders commits by date, whatever their time zone', () => {
    const commits = [commit('aaaaaaaaaaaa', '2026-11-01T12:00:00+02:00', {}), commit('bbbbbbbbbbbb', '2026-11-01T09:00:00-05:00', {})];
    expect(pointsOf(commits, { project: 'p' }).map(p => p.label)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });
});

describe('the metrics lists of commits ask for', () => {
  it('are unchanged for projects without totals', () => {
    const metrics = { available_metrics: { psnr: { target: 30 }, ssim: {} }, default_metric: 'psnr', main_metrics: ['psnr', 'ssim'] };
    expect(aggregation_metrics(metrics)).toEqual({ psnr: 30, ssim: 0 });
  });
  it('put the project\'s own before the totals: the server keeps the first 20', () => {
    const main_metrics = Array.from({ length: 15 }, (_, i) => `m${i}`);
    const keys = Object.keys(aggregation_metrics({ available_metrics: TEST_DEFINITIONS, default_metric: 'm0', main_metrics }));
    expect(keys.slice(0, 15)).toEqual(main_metrics);
    expect(keys[15]).toBe('tests');
  });
});

describe('what definitions say of groups', () => {
  const bench = group => ({ group, smaller_is_better: true });
  it('finds totals first, then their parts and what adds up with them', () => {
    const keys = compositionKeys({ ...TEST_DEFINITIONS, bench_a: bench('Benchmarks/codec') });
    expect([...keys].sort()).toEqual(Object.keys(TEST_DEFINITIONS).sort());
    expect(keys[0]).toBe('tests');
    expect(keys.at(-1)).toBe('test_time');
    expect(listMetricKeys(TEST_DEFINITIONS).length).toBeLessThanOrEqual(MAX_LIST_METRICS);
  });
  it('knows groups that need the runs from a total\'s own', () => {
    expect(hasGroups(TEST_DEFINITIONS)).toBe(false);
    expect(hasGroups({ ...TEST_DEFINITIONS, bench_a: bench('Benchmarks/codec') })).toBe(true);
    // grouped metrics that say how they aggregate are groups too
    expect(hasGroups({ loss: { group: 'Training', aggregation: 'average' } })).toBe(true);
    expect(hasGroups({ psnr: { label: 'PSNR' } })).toBe(false);
  });
});

// Python (qaboard/metrics.py), the schema and the web app must agree: tests/test_schemas.py checks Python's side
describe('the vocabulary of definitions', () => {
  const { properties } = schema.$defs.metric;
  it('is the schema\'s', () => {
    expect(Object.keys(AGGREGATIONS).sort()).toEqual([...properties.aggregation.enum].sort());
    expect([...INTENTS].sort()).toEqual([...properties.intent.enum].sort());
  });
  it('reads the definitions junit_metrics returns, like the generated ones of the playground', () => {
    // tests/test_junit.py checks the same file against qaboard/junit.py
    for (const [key, definition] of Object.entries(junit.definitions))
      expect([key, definition]).toEqual([key, expect.objectContaining(TEST_DEFINITIONS[key])]);
    const points = [{ id: 'a', runs: [{ metrics: { tests: 3, passed: 2, failed: 1, errors: 0, skipped: 0, flaky: 0, test_time: 2 } }] }];
    const [tests] = trendsOf(points, junit.definitions).composed;
    expect(tests.parts.map(s => s.key)).toEqual(['passed', 'skipped', 'flaky', 'failed', 'errors']);
    expect(tests.extras.map(s => s.key)).toEqual(['test_time']);
  });
});
