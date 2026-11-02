// What the commit page compares is derived from the commits' data: it must never modify it.
import { compute_batches, compute_config, available_batch } from '../selectors/batches';
import { normalize_commit, normalize_metrics } from '../api/normalize';
import { matching_output, index_outputs } from '../utils';
import { used_metrics_signature, with_used_metrics } from '../hooks';

const deep_freeze = o => {
  Object.values(o).forEach(v => typeof v === 'object' && v !== null && deep_freeze(v));
  return Object.freeze(o);
};

const output = (id, test_input_path, { configurations = ['base'], platform = 'linux', metrics = {}, ...rest } = {}) => ({
  id, test_input_database: '/db', test_input_path, configurations, platform, extra_parameters: {}, metrics,
  test_input_metadata: {}, is_pending: false, is_failed: false, data: {}, ...rest,
});

const commit = (id, outputs, label = 'default') => normalize_commit({
  id,
  batches: { [label]: { id: `${id}-${label}`, label, data: {}, valid_outputs: outputs.length, outputs: Object.fromEntries(outputs.map(o => [o.id, o])) } },
});

const new_commit = deep_freeze(commit('new', [
  output(1, 'a.raw', { metrics: { psnr: 30 } }),
  output(2, 'b.raw', { metrics: { psnr: 40 }, configurations: ['base', { iso: 100 }] }),
  output(3, 'c.raw', { metrics: { psnr: 20 } }),
]));
const ref_commit = deep_freeze(commit('ref', [
  output(11, 'a.raw', { metrics: { psnr: 29 }, platform: 'windows' }),
  output(12, 'a.raw', { metrics: { psnr: 31 } }),
  output(13, 'b.raw', { metrics: { psnr: 39 } }),
]));
const selected = { selected_batch_new: 'default', selected_batch_ref: 'default', filter_batch_new: '', filter_batch_ref: '', sort_order: -1 };


describe('compute_batches', () => {
  test('works on frozen data: it never mutates it', () => {
    expect(() => compute_batches({ new_commit, ref_commit, selected, metrics: { default_metric: 'psnr' } })).not.toThrow();
  });

  test('sorts by the default metric', () => {
    const { new_batch } = compute_batches({ new_commit, ref_commit, selected, metrics: { default_metric: 'psnr' } });
    expect(new_batch.filtered.outputs).toEqual(['2', '1', '3']);
    const ascending = compute_batches({ new_commit, ref_commit, selected: { ...selected, sort_order: 1 }, metrics: { default_metric: 'psnr' } });
    expect(ascending.new_batch.filtered.outputs).toEqual(['3', '1', '2']);
  });

  test('filters', () => {
    const { new_batch, ref_batch } = compute_batches({ new_commit, ref_commit, selected: { ...selected, filter_batch_new: 'b.raw', filter_batch_ref: '-windows' }, metrics: {} });
    expect(new_batch.filtered.outputs).toEqual(['2']);
    expect(new_batch.filtered.valid_outputs).toBe(1);
    expect(ref_batch.filtered.outputs).toEqual(['12', '13']);
  });

  test('filters by status', () => {
    const statuses = commit('s', [
      output(1, 'ok.raw'),
      output(2, 'failed.raw', { is_failed: true }),
      output(3, 'pending.raw', { is_pending: true }),
      output(4, 'running.raw', { is_pending: true, is_running: true }),
      output(5, 'running-only.raw', { is_running: true }),
    ]);
    const filtered = filter => compute_batches({ new_commit: statuses, ref_commit: null, selected: { ...selected, filter_batch_new: filter }, metrics: {} }).new_batch.filtered;
    const ids = filter => [...filtered(filter).outputs].sort();
    expect(ids('status:success')).toEqual(['1']);
    expect(filtered('status:success').valid_outputs).toBe(1);
    // a run can be running without being pending: it didn't succeed yet
    expect(ids('-fail -pending')).toEqual(['1', '5']);
    expect(ids('-status:success')).toEqual(['2', '3', '4', '5']);
  });

  test('matches outputs with the most similar reference output', () => {
    const { new_batch } = compute_batches({ new_commit, ref_commit, selected, metrics: {} });
    // same input and platform
    expect(new_batch.outputs[1].reference_id).toBe(12);
    expect(new_batch.outputs[1].reference_mismatch).toBe(null);
    // same input, different configuration
    expect(new_batch.outputs[2].reference_id).toBe(13);
    expect(new_batch.outputs[2].reference_mismatch.configurations).toEqual(['base']);
    // nothing to compare with
    expect(new_batch.outputs[3].reference_id).toBeUndefined();
  });

  test('describes which metrics and parameters are used', () => {
    const { new_batch } = compute_batches({ new_commit, ref_commit, selected, metrics: {} });
    expect([...new_batch.used_metrics]).toEqual(['psnr']);
    expect([...new_batch.metrics_with_refs]).toEqual(['psnr']);
    expect(new_batch.sorted_extra_parameters[0]).toBe('iso');
  });

  test('keeps outputs identical when only the filter changes, so cards do not re-render', () => {
    const a = compute_batches({ new_commit, ref_commit, selected, metrics: {} });
    const b = compute_batches({ new_commit, ref_commit, selected: { ...selected, filter_batch_new: 'raw' }, metrics: {} });
    expect(b.new_batch.outputs[1]).toBe(a.new_batch.outputs[1]);
  });

  test('without commits', () => {
    const { new_batch, ref_batch } = compute_batches({ new_commit: undefined, ref_commit: null, selected, metrics: {} });
    expect(new_batch.filtered.outputs).toEqual([]);
    expect(ref_batch.outputs).toEqual({});
  });
});


test('available_batch falls back to the only batch', () => {
  expect(available_batch(commit('x', [], 'tuning'), 'default')).toBe('tuning');
  expect(available_batch(undefined, 'default')).toBe('default');
});

test('matching with an index gives the same results', () => {
  const ref_batch = ref_commit.batches.default;
  for (const o of Object.values(new_commit.batches.default.outputs))
    expect(matching_output({ output: o, batch: ref_batch, index: index_outputs(ref_batch) })).toEqual(matching_output({ output: o, batch: ref_batch }));
});

test('compute_config prefers the batch, then the commit, then the project', () => {
  const project_data = { data: { qatools_config: { a: 'project' }, qatools_metrics: normalize_metrics({ available_metrics: { psnr: {} }, main_metrics: ['psnr', 'missing'] }) } };
  expect(compute_config({ project_data }).config).toEqual({ a: 'project' });
  // main metrics don't need to be declared
  expect(compute_config({ project_data }).selected_metrics).toEqual(['psnr', 'missing']);
  expect(compute_config({ project_data, new_commit: { data: { qatools_config: { a: 'commit' } } } }).config).toEqual({ a: 'commit' });
  // what the server saves when a batch's qaboard.yaml differs from its commit's (backend/backend/api/batch.py)
  const new_commit = { data: { qatools_config: { a: 'commit' } } };
  expect(compute_config({ project_data, new_commit, new_batch: { data: { qatools_config: { a: 'batch' } } } }).config).toEqual({ a: 'batch' });
  expect(compute_config({ project_data, new_commit, new_batch: { data: { config: { a: 'batch' } } } }).config).toEqual({ a: 'batch' });
});

test('normalize_metrics merges the metrics declared in code', () => {
  const metrics_file = { available_metrics: { psnr: { label: 'PSNR', smaller_is_better: false, target: 30 }, loss: {} }, main_metrics: ['psnr'] };
  const metrics = normalize_metrics(metrics_file, { psnr: { suffix: ' dB' }, frames: { label: 'Frames', smaller_is_better: null } });
  expect(metrics.available_metrics.psnr).toMatchObject({ label: 'PSNR', suffix: ' dB', smaller_is_better: false, target: 30, declared: true });
  // metrics files leave out smaller_is_better when smaller is better, null says we don't know
  expect(metrics.available_metrics.loss.smaller_is_better).toBe(true);
  expect(metrics.available_metrics.frames).toMatchObject({ label: 'Frames', short_label: 'Frames', smaller_is_better: null });
  // projects without a metrics file
  expect(normalize_metrics(undefined, { frames: {} }).available_metrics.frames.label).toBe('frames');
  expect(normalize_metrics(undefined, undefined)).toBeUndefined();
});

test('normalize_metrics ignores main metrics that are not names', () => {
  // e.g. "- " with no value in a metrics file
  expect(normalize_metrics({ main_metrics: ['psnr', null, 3, '.hidden'] }).main_metrics).toEqual(['psnr']);
  expect(normalize_metrics({ main_metrics: 'psnr' }).main_metrics).toEqual([]);
});

test('normalize_metrics ignores the lists of metrics that are not lists', () => {
  // e.g. `dashboard_metrics: psnr`, or a mapping: the History page used to crash on them
  const metrics = normalize_metrics({ dashboard_metrics: { psnr: null }, dashboard_evolution_metrics: 'psnr', summary_metrics: ['psnr', null] });
  expect(metrics.dashboard_metrics).toBeUndefined();
  expect(metrics.dashboard_evolution_metrics).toBeUndefined();
  expect(metrics.summary_metrics).toEqual(['psnr']);
  // those not in the metrics file stay out
  expect('dashboard_metrics' in normalize_metrics({ main_metrics: ['psnr'] })).toBe(false);
});

test('the metrics stay the same object while the runs have the same metrics', () => {
  const metrics = normalize_metrics({ available_metrics: { psnr: {} } });
  // e.g. when users filter runs: a new Set with the same metrics
  const key = used_metrics_signature(new Set(['psnr', 'latency']));
  const with_latency = with_used_metrics(metrics, key);
  expect(Object.keys(with_latency.available_metrics)).toEqual(['psnr', 'latency']);
  expect(with_used_metrics(metrics, used_metrics_signature(new Set(['latency', 'psnr'])))).toEqual(with_latency);
  expect(key).toBe(used_metrics_signature(new Set(['latency', 'psnr'])));
  // nothing missing: the same object
  expect(with_used_metrics(metrics, used_metrics_signature(new Set(['psnr'])))).toBe(metrics);
  expect(with_used_metrics(metrics, '')).toBe(metrics);
});

test('normalize_commit gives the metrics declared in code to the commit and the batches with their own metrics file', () => {
  const commit = normalize_commit({
    data: { qatools_metrics: { available_metrics: { psnr: {} } }, metrics_definitions: { frames: { smaller_is_better: null } } },
    batches: {
      default: { data: {}, outputs: {} },
      local: { data: { qatools_metrics: { available_metrics: { loss: {} } } }, outputs: {} },
    },
  });
  expect(Object.keys(commit.data.qatools_metrics.available_metrics)).toEqual(['psnr', 'frames']);
  // without their own metrics file, batches use their commit's
  expect(commit.batches.default.data.qatools_metrics).toBeUndefined();
  expect(Object.keys(commit.batches.local.data.qatools_metrics.available_metrics)).toEqual(['loss', 'frames']);
});

test('normalize_metrics fills defaults and hides dotted metrics', () => {
  const metrics = normalize_metrics({ available_metrics: { psnr: { smaller_is_better: 'False' }, '.hidden': {} }, main_metrics: ['psnr', '.hidden'] });
  expect(metrics.available_metrics.psnr).toMatchObject({ key: 'psnr', label: 'psnr', scale: 1, suffix: '', smaller_is_better: false });
  expect(metrics.available_metrics['.hidden']).toBeUndefined();
  expect(metrics.main_metrics).toEqual(['psnr']);
});
