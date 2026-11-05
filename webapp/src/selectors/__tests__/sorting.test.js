// Sorting runs on the commit page: by name, batch, database, status, configuration, metrics...
// Run with: cd webapp && npm test -- sorting
import { default_sort_by, effective_sort_order, order_labels, sorted_ids } from '../sorting';
import { compute_batches } from '../batches';
import { normalize_commit } from '../../api/normalize';


const run = (id, test_input_path, { batch, database = '/db', metrics = {}, ...rest } = {}) => ({
  id, test_input_database: database, test_input_path, configurations: [], extra_parameters: {}, metrics,
  test_input_metadata: {}, is_pending: false, is_failed: false, data: batch ? { batch } : {}, ...rest,
});
const by_id = runs => Object.fromEntries(runs.map(r => [r.id, r]));
const sort = (runs, sort_by, sort_order) => sorted_ids(runs.map(r => r.id), by_id(runs), sort_by, sort_order);


describe('sorted_ids', () => {
  test('sorts names A to Z by default, with numbers in their order', () => {
    const runs = [run(1, 'frame_10.png'), run(2, 'Frame_2.png'), run(3, 'frame_1.png')];
    expect(sort(runs, 'test_input_path')).toEqual([3, 2, 1]);
    expect(sort(runs, 'test_input_path', -1)).toEqual([1, 2, 3]);
  });

  test('sorts by batch, then by name', () => {
    const runs = [run(1, 'b.png', { batch: 'night' }), run(2, 'a.png', { batch: 'night' }), run(3, 'b.png', { batch: 'day' }), run(4, 'a.png', { batch: 'day' })];
    expect(sort(runs, 'data.batch')).toEqual([4, 3, 2, 1]);
  });

  test('sorts by database and by configuration', () => {
    const runs = [run(1, 'a.png', { database: '/kitti' }), run(2, 'a.png', { database: '/cityscapes', configurations: ['z.yaml'] }), run(3, 'b.png', { configurations: ['a.yaml'] })];
    expect(sort(runs, 'test_input_database')).toEqual([2, 3, 1]);
    // runs without a configuration come last
    expect(sort(runs, 'configuration')).toEqual([3, 2, 1]);
  });

  test('puts failed runs first, then running and pending ones', () => {
    const runs = [run(1, 'a'), run(2, 'b', { is_pending: true }), run(3, 'c', { is_failed: true }), run(4, 'd', { is_pending: true, is_running: true })];
    expect(sort(runs, 'status')).toEqual([3, 4, 2, 1]);
  });

  test('sorts metrics largest first, runs without the metric last, ties by name', () => {
    const runs = [run(1, 'c', { metrics: { psnr: 30 } }), run(2, 'b'), run(3, 'a', { metrics: { psnr: 30 } }), run(4, 'd', { metrics: { psnr: 40 } })];
    expect(sort(runs, 'psnr')).toEqual([4, 3, 1, 2]);
    expect(sort(runs, 'psnr', 1)).toEqual([3, 1, 4, 2]);
  });

  test('sorts by run id and storage, newest and largest first', () => {
    const runs = [run(2, 'a', { data: { storage: 10 } }), run(10, 'b', { data: { storage: 300 } }), run(1, 'c')];
    expect(sort(runs, 'id')).toEqual([10, 2, 1]);
    expect(sort(runs, 'data.storage')).toEqual([10, 2, 1]);
  });

  test('metrics win over run keys of the same name', () => {
    const runs = [run(1, 'a', { metrics: { status: 1 } }), run(2, 'b', { metrics: { status: 2 } })];
    expect(sort(runs, 'status', -1)).toEqual([2, 1]);
  });
});


describe('defaults', () => {
  test('the default metric, else the batches when runs come from several, else the names', () => {
    const runs = [run(1, 'a', { batch: 'night' }), run(2, 'b', { batch: 'day' })];
    expect(default_sort_by(runs, 'psnr')).toBe('psnr');
    expect(default_sort_by(runs)).toBe('data.batch');
    expect(default_sort_by([runs[0]])).toBe('test_input_path');
  });

  test('text A to Z and failed first, numbers largest first, unless users chose', () => {
    expect(effective_sort_order('test_input_path')).toBe(1);
    expect(effective_sort_order('status')).toBe(1);
    expect(effective_sort_order('psnr')).toBe(-1);
    expect(effective_sort_order('psnr', 1)).toBe(1);
    expect(effective_sort_order('test_input_path', '-1')).toBe(-1);
    expect(order_labels('data.batch')).toEqual(['A to Z', 'Z to A']);
    expect(order_labels('status')).toEqual(['Failed first', 'Succeeded first']);
  });

  test('the commit page sorts by name without a default metric', () => {
    const commit = normalize_commit({ id: 'c', batches: { default: { id: 1, label: 'default', data: {}, outputs: by_id([run(1, 'b.png'), run(2, 'c.png'), run(3, 'a.png')]) } } });
    const selected = { selected_batch_new: 'default', selected_batch_ref: 'default', filter_batch_new: '', filter_batch_ref: '' };
    const { new_batch, sorting } = compute_batches({ new_commit: commit, ref_commit: commit, selected, metrics: {} });
    expect(new_batch.filtered.outputs.map(Number)).toEqual([3, 1, 2]);
    expect(sorting).toEqual({ by: 'test_input_path', order: 1, default_by: 'test_input_path' });
  });
});
