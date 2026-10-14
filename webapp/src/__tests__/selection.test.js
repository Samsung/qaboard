// The selection (commits, batches, filters, views...) is derived from the URL, and changed by navigating.
// What we write in the URL must read back the same.
import { selection_from_url, url_for_selection, date_range_from_query, route_info } from '../selection';
import { matchRoutes } from '../router';
import { route_paths } from '../route_paths';

const routes = Object.values(route_paths).map(path => ({ path }));

const select = url => {
  const { pathname, search } = new URL(url, 'http://localhost');
  return selection_from_url(matchRoutes(routes, pathname).match, search);
};

// Applies changes to the selection, then reads it back from the new URL
const roundtrip = (url, changes) => {
  const { pathname, search } = new URL(url, 'http://localhost');
  const next = url_for_selection(changes, { pathname, search });
  return { url: `${next.pathname}?${next.search}`, selected: select(`${next.pathname}?${next.search}`) };
};


describe('reading the selection from the URL', () => {
  test('commit page', () => {
    const s = select('/group/repo/commit/abc123?reference=def456&batch=tuning&filter=scene&batch_ref=default&new_project=group/other');
    expect(s.project).toBe('group/repo');
    expect(s.route.is_commit).toBe(true);
    expect(s.new_commit_id).toBe('abc123');
    expect(s.ref_commit_id).toBe('def456');
    expect(s.selected_batch_new).toBe('tuning');
    expect(s.filter_batch_new).toBe('scene');
    expect(s.new_project).toBe('group/other');
    expect(s.ref_project).toBe('group/repo');
  });

  test('defaults', () => {
    const s = select('/group/repo/commit');
    expect(s.new_commit_id).toBe(null);
    expect(s.ref_commit_id).toBe(null);
    expect(s.selected_batch_new).toBe('default');
    expect(s.filter_batch_new).toBe('');
    expect(s.sort_order).toBe(-1);
    expect(s.selected_views).toBeUndefined();
    expect(s.selected_metrics).toBeUndefined();
  });

  test('branches and committers come from the path', () => {
    expect(select('/group/repo/commits/feature/x').branch).toBe('feature/x');
    expect(select('/group/repo/history/master').branch).toBe('master');
    expect(select('/group/repo/committer/Alice%20Smith').committer).toBe('Alice Smith');
    expect(select('/group/repo').branch).toBe(null);
  });

  test('views are normalized', () => {
    expect(select('/p/commit/a?selected_views=output_list').selected_views).toEqual(['output-list']);
  });

  test('routes', () => {
    expect(route_info("/:project_id+/commits/:name+")).toMatchObject({ is_commits: true, is_commit: false, is_list: true });
    expect(route_info("/:project_id+/committer/:committer+")).toMatchObject({ is_committer: true, is_commit: false });
    expect(route_info("/:project_id+/commit/:name+")).toMatchObject({ is_commit: true, is_list: false });
    expect(route_info("/:project_id+/history/:name+")).toMatchObject({ is_history: true, is_commit: false });
  });
});


describe('changing the selection', () => {
  test('selecting a commit goes to its page', () => {
    const { url, selected } = roundtrip('/group/repo?search=x', { new_commit_id: 'abc', ref_commit_id: 'def' });
    expect(url.startsWith('/group/repo/commit/abc?')).toBe(true);
    expect(selected.new_commit_id).toBe('abc');
    expect(selected.ref_commit_id).toBe('def');
  });

  test('on lists of commits, selecting a commit stays on the page', () => {
    const { url, selected } = roundtrip('/group/repo/history/master', { new_commit_id: 'abc' });
    expect(url).toBe('/group/repo/history/master?commit=abc');
    expect(selected.new_commit_id).toBe('abc');
    expect(selected.branch).toBe('master');
  });

  test('the page type comes from the routes, not from words in the URL', () => {
    expect(roundtrip('/p/commits/fix/commit', { new_commit_id: 'abc' }).url).toBe('/p/commits/fix/commit?commit=abc');
    expect(roundtrip('/p', { new_commit_id: 'abc' }).url).toBe('/p/commit/abc?');
  });

  test('"nothing selected" survives the round trip', () => {
    expect(roundtrip('/p/commit/abc', { ref_commit_id: '' }).selected.ref_commit_id).toBe('');
    expect(roundtrip('/p/commit/abc', { new_commit_id: '' }).selected.new_commit_id).toBe('');
  });

  test('lists survive the round trip, including empty ones', () => {
    expect(roundtrip('/p/commit/a', { selected_metrics: ['psnr', 'ssim'] }).selected.selected_metrics).toEqual(['psnr', 'ssim']);
    expect(roundtrip('/p/commit/a', { selected_metrics: ['psnr'] }).selected.selected_metrics).toEqual(['psnr']);
    expect(roundtrip('/p/commit/a', { selected_metrics: [] }).selected.selected_metrics).toEqual([]);
    expect(roundtrip('/p/commit/a', { selected_views: 'logs' }).selected.selected_views).toEqual(['logs']);
  });

  test('numbers and strings', () => {
    const { selected } = roundtrip('/p/commit/a', { sort_order: 1, sort_by: 'psnr', filter_batch_new: 'a b -c' });
    expect(selected.sort_order).toBe(1);
    expect(selected.sort_by).toBe('psnr');
    expect(selected.filter_batch_new).toBe('a b -c');
  });

  test('null removes from the URL, the current project is implicit', () => {
    const { url } = roundtrip('/p/commit/a?filter=x&new_project=q', { filter_batch_new: null, new_project: 'p' });
    expect(url).toBe('/p/commit/a?');
  });

  test('defaults are not in the URL', () => {
    const { url, selected } = roundtrip('/p/commit/a?batch=x&batch_ref=y&filter=f&sort_order=1&search=s', {
      selected_batch_new: 'default', selected_batch_ref: 'default', filter_batch_new: '', search: '', sort_order: '-1',
    });
    expect(url).toBe('/p/commit/a?');
    expect(selected).toMatchObject({ selected_batch_new: 'default', filter_batch_new: '', sort_order: -1 });
    // '' still means "no commit selected"
    expect(roundtrip('/p/commit/a', { ref_commit_id: '' }).url).toBe('/p/commit/a?reference=');
  });

  test('callers give the defaults of their options', () => {
    const { pathname, search } = new URL('/p/commit/a?show_all_files=true&selected_metrics=psnr&selected_metrics=ssim', 'http://localhost');
    const defaults = { show_all_files: false, selected_metrics: ['psnr', 'ssim'], relative: true };
    const next = url_for_selection({ show_all_files: false, selected_metrics: ['psnr', 'ssim'], relative: false }, { pathname, search }, defaults);
    expect(next.search).toBe('relative=false');
    const other_metrics = url_for_selection({ selected_metrics: ['ssim'] }, { pathname, search }, defaults);
    expect(other_metrics.search).toBe('show_all_files=true&selected_metrics=ssim');
  });

  test('the legacy batch_new is replaced', () => {
    expect(roundtrip('/p/commit/a?batch_new=x', { selected_batch_new: 'default' }).url).toBe('/p/commit/a?');
    expect(roundtrip('/p/commit/a?batch_new=x', { selected_batch_new: 'y' }).selected.selected_batch_new).toBe('y');
  });

  test('long lists survive the round trip', () => {
    const metrics = [...Array(25).keys()].map(i => `m${i}`);
    expect(roundtrip('/p/commit/a', { selected_metrics: metrics }).selected.selected_metrics).toEqual(metrics);
  });

  test('paths are encoded', () => {
    const { url, selected } = roundtrip('/g/p', { branch: 'fix#12' });
    expect(url.split('?')[0]).toBe('/g/p/commits/fix%2312');
    expect(selected.branch).toBe('fix#12');
    expect(roundtrip('/g/p/commits', { branch: 'feature/x' }).url.split('?')[0]).toBe('/g/p/commits/feature/x');
  });

  test('the project shown is kept when other components change the selection', () => {
    const { url } = roundtrip('/p/commit/a?new_project=q', { selected_views: ['logs'] });
    expect(select(url).new_project).toBe('q');
  });

  test('switching new and reference', () => {
    const before = select('/p/commit/a?reference=b&batch=x&batch_ref=y');
    const { selected } = roundtrip('/p/commit/a?reference=b&batch=x&batch_ref=y', {
      new_commit_id: before.ref_commit_id, ref_commit_id: before.new_commit_id,
      selected_batch_new: before.selected_batch_ref, selected_batch_ref: before.selected_batch_new,
    });
    expect(selected).toMatchObject({ new_commit_id: 'b', ref_commit_id: 'a', selected_batch_new: 'y', selected_batch_ref: 'x' });
  });

  test('branches and committers have their own pages', () => {
    expect(roundtrip('/p/commit/a', { branch: 'feature/x', committer: null }).url.split('?')[0]).toBe('/p/commits/feature/x');
    expect(roundtrip('/p', { branch: null, committer: 'Alice' }).url.split('?')[0]).toBe('/p/committer/Alice');
    expect(roundtrip('/p/commits/x', { branch: null, committer: null }).url.split('?')[0]).toBe('/p');
  });

  test('dates are written as days', () => {
    const { url, selected } = roundtrip('/p/commits', { from: new Date(2026, 8, 1, 15), to: new Date(2026, 8, 3) });
    expect(url).toBe('/p/commits?from=2026-09-01&to=2026-09-03');
    expect(selected.date_range[0]).toEqual(new Date(2026, 8, 1));
    expect(selected.date_range[1]).toEqual(new Date(2026, 8, 3, 23, 59, 59, 999));
  });
});


test('the default date range is the last days', () => {
  const [from, to] = date_range_from_query({});
  expect(to > new Date()).toBe(true);
  expect((to - from) / (24 * 3600 * 1000)).toBeCloseTo(4, 0);
  // invalid dates are ignored
  expect(date_range_from_query({ from: 'yesterday' })[0]).toEqual(from);
});
