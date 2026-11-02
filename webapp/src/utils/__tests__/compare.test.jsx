/**
 * The numbers of the Summary and Metrics Diff views, on the fixture shared with the backend's tests:
 * GET /api/v1/commit/<sha>/compare (used by `qa gate`) must give the same, see backend/tests/test_compare.py.
 * Run with: cd webapp && npm test -- compare
 */
import { screen, within } from '@testing-library/react';
import { renderWithProviders as render } from '../../test-utils';

import { metrics_fill_defaults, metric_info, with_undeclared_metrics } from '../../utils';
import { normalize_commit } from '../../api/normalize';
import { compute_batches } from '../../selectors/batches';
import { summary_outputs, metric_values, summary_stats, diff_cell, mixed_parameters, pass_rate, changed_metrics } from '../compare';
import { TableCompare } from '../../components/tables';
import fixture from '../../../../tests/fixtures/metrics-compare.json';


// The batches as the commit page has them (api/normalize.js and selectors/batches.js), runs sorted by id
const load = () => {
  const commit = side => normalize_commit({ batches: { default: { outputs: structuredClone(fixture[side].outputs) } } });
  const selected = { selected_batch_new: 'default', selected_batch_ref: 'default', filter_batch_new: '', filter_batch_ref: '', sort_by: 'id', sort_order: 1 };
  const { new_batch, ref_batch } = compute_batches({ new_commit: commit('new'), ref_commit: commit('ref'), selected, metrics: {} });
  const available_metrics = metrics_fill_defaults(structuredClone(fixture.available_metrics));
  return { new_batch, ref_batch, available_metrics };
};

// JSON has no Infinity or NaN: the API returns null
const finite = x => (x === null || x === undefined || !Number.isFinite(x)) ? null : x;
const expectClose = (actual, expected) => {
  if (expected === null)
    expect(finite(actual)).toBeNull();
  else
    expect(actual).toBeCloseTo(expected, 12);
};


describe('the Summary', () => {
  it('gives the numbers of the fixture', () => {
    const { new_batch, ref_batch, available_metrics } = load();
    const { outputs_new, outputs_ref } = summary_outputs(new_batch, ref_batch);
    Object.entries(fixture.expected.summary).forEach(([key, expected]) => {
      const new_values = metric_values(outputs_new, key);
      const ref_values = metric_values(outputs_ref, key);
      expect(new_values.length).toBe(expected.new.count);
      expect(ref_values.length).toBe(expected.ref.count);
      const stats = summary_stats(new_values, ref_values, available_metrics[key]);
      expectClose(stats.new_med, expected.new.median);
      expectClose(stats.ref_med, expected.ref.median);
      expectClose(stats.new_pc_good, expected.new.pass_rate);
      expectClose(stats.ref_pc_good, expected.ref.pass_rate);
      expectClose(stats.delta, expected.delta);
      expectClose(stats.delta_relative, expected.delta_relative);
    });
  });

  it('shows the change relative to the magnitude of the reference', () => {
    // a metric that is negative: going from -2 to -1 is +50%, not -50%
    expect(summary_stats([-1], [-2], { smaller_is_better: true }).delta_relative).toBe(0.5);
  });
});


describe('the Metrics Diff', () => {
  it('matches each run with the reference run of the fixture', () => {
    const { new_batch } = load();
    const rows = new_batch.filtered.outputs
      .map(id => new_batch.outputs[id])
      .filter(o => !o.is_pending && o.output_type !== 'optim_iteration');
    expect(rows.map(o => String(o.id))).toEqual(Object.keys(fixture.expected.diff));
    rows.forEach(output => {
      const expected = fixture.expected.diff[output.id];
      expect(output.reference_id ?? null).toBe(expected.reference_id);
      expect(output.reference_mismatch).toEqual(expected.reference_mismatch);
    });
  });

  it('gives the changes of the fixture', () => {
    const { new_batch, ref_batch } = load();
    Object.entries(fixture.expected.diff).forEach(([id, expected]) => {
      const output = new_batch.outputs[id];
      const output_ref = ref_batch.outputs[output.reference_id] || {};
      // like ColumnsMetricImprovement: a cell shows a change when both runs have a value
      const cells = Object.keys(fixture.available_metrics).filter(key => {
        const [metric_new, metric_ref] = [output.metrics?.[key], output_ref.metrics?.[key]];
        return metric_new !== undefined && metric_new !== null && metric_ref !== undefined && metric_ref !== null;
      });
      expect(cells.sort()).toEqual(Object.keys(expected.metrics).sort());
      cells.forEach(key => {
        const { delta, delta_relative } = diff_cell(output.metrics[key], output_ref.metrics[key]);
        expectClose(delta, expected.metrics[key].delta);
        expectClose(delta_relative, expected.metrics[key].delta_relative);
      });
    });
  });

  it('shows those changes', () => {
    const { new_batch, ref_batch, available_metrics } = load();
    render(<TableCompare new_batch={new_batch} ref_batch={ref_batch} available_metrics={available_metrics} metrics={['psnr', 'latency_p99']} />);
    // the header has 2 rows, then come runs 101, 102, 103...
    const cells = screen.getAllByRole('row').slice(2).map(row => within(row).queryAllByRole('cell').map(cell => cell.textContent));
    // run 101: PSNR 31 vs 30, latency 10 vs 9
    expect(cells[0]).toEqual(['1 (3%)', '1 (11%)']);
    // run 103 has the same PSNR as its reference
    expect(cells[2]).toEqual(['=', '1 (10%)']);
    // run 109 has no reference run
    expect(cells[6]).toEqual(['', '']);
  });
});


describe('mixed_parameters', () => {
  it('ignores the parameters every run shares', () => {
    const runs = [{ params: { model: 'kd-1.2-int8-320' } }, { params: { model: 'kd-1.2-int8-320' } }];
    expect(mixed_parameters(runs)).toEqual([]);
    expect(mixed_parameters([])).toEqual([]);
    expect(mixed_parameters([{}, { params: {} }])).toEqual([]);
  });

  it('lists the parameters with several values, or missing in some runs', () => {
    const runs = [
      { params: { model: 'fp32', nms: { iou: 0.5 }, seed: 1 } },
      { params: { model: 'int8', nms: { iou: 0.7 }, seed: 1, extra: true } },
    ];
    expect(mixed_parameters(runs).sort()).toEqual(['extra', 'model', 'nms.iou']);
  });
});


describe('metrics that were not declared', () => {
  it('have neutral definitions', () => {
    const available_metrics = metrics_fill_defaults({ psnr: { smaller_is_better: false }, frames: { smaller_is_better: null } });
    expect(metric_info(available_metrics, 'psnr')).toBe(available_metrics.psnr);
    expect(available_metrics.frames.smaller_is_better).toBeNull();
    const latency = metric_info(available_metrics, 'latency');
    expect(latency).toMatchObject({ key: 'latency', label: 'latency', scale: 1, suffix: '', smaller_is_better: null, declared: false });
    // the same object: memoized components don't re-render
    expect(metric_info({}, 'latency')).toBe(latency);
  });

  it('come after the declared metrics', () => {
    const available_metrics = metrics_fill_defaults({ psnr: {} });
    const all = with_undeclared_metrics(available_metrics, new Set(['zoom', 'psnr', 'is_failed', 'alpha']));
    expect(Object.keys(all)).toEqual(['psnr', 'alpha', 'zoom']);
    expect(with_undeclared_metrics(available_metrics, new Set(['psnr']))).toBe(available_metrics);
  });

  it('have no pass rate: we don\'t know which way is better', () => {
    expect(pass_rate([1, 2], { target: 1.5, smaller_is_better: null })).toBeNull();
    expect(pass_rate([1, 2], { target: '1.5', smaller_is_better: true })).toBeNull();
    expect(pass_rate([1, 2], { target: 1.5, smaller_is_better: true })).toBe(0.5);
  });

  it('are summarized by how much they changed vs the reference', () => {
    const outputs = values => values.map(metrics => ({ metrics }));
    const outputs_new = outputs([{ a: 1, b: 10, c: 5, d: 'x', compute_time: 9 }, { a: 1, b: 12, c: 5 }]);
    const outputs_ref = outputs([{ a: 2, b: 10, c: 5, compute_time: 1 }]);
    // a: -50%, b: +10%, c: 0%, d is not a number, e has no reference, compute_time changes too much to be informative
    expect(changed_metrics(outputs_new, outputs_ref, ['c', 'e', 'b', 'a', 'd', 'compute_time'])).toEqual(['a', 'b', 'c']);
    expect(changed_metrics(outputs([{ e: 1 }]), outputs_ref, ['c', 'e', 'b', 'a'])).toEqual(['e']);
    // without reference, in the order we're given
    expect(changed_metrics(outputs_new, [], ['c', 'b', 'a'], 2)).toEqual(['c', 'b']);
    // a reference at 0 doesn't make the change infinite: 0 → 1 (1) is ranked with 1 → 4 (0.75) and 10 → 20 (0.5)
    expect(changed_metrics(outputs([{ x: 1, y: 4, z: 20 }]), outputs([{ x: 0, y: 1, z: 10 }]), ['z', 'y', 'x'])).toEqual(['x', 'y', 'z']);
  });
});
