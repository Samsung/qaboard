// The selection (commits, batches, filters, views...) is derived from the URL, and changed by navigating.
// What we write in the URL must read back the same.
import {
  selection_from_url, url_for_selection, date_range_from_query, route_info,
  show_reference, add_reference, remove_reference, swap_with_top, move_reference, duplicate_reference, rename_reference,
  reference_names, reference_colors, side_colors, switch_new_and_reference,
  project_url,
} from '../selection';
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
  test('repeated text parameters are read as one text', () => {
    const s = select('/group/repo/commit/abc123?filter=a&filter=b&filter_ref=c&filter_ref=d&search=e&search=f');
    expect(s.filter_batch_new).toBe('a b');
    expect(s.filter_batch_ref).toBe('c d');
    expect(s.search).toBe('e f');
  });

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


describe('several references', () => {
  const ids = selected => selected.references.map(r => r.commit_id);
  // applies an action on the selection of a URL, and reads the selection back
  const act = (url, action, ...args) => roundtrip(url, action(select(url), ...args));

  test('without other references, the reference is the only one', () => {
    const s = select('/p/commit/a?reference=b&batch_ref=x&filter_ref=f');
    expect(s.references).toEqual([{ project: 'p', commit_id: 'b', batch: 'x', filter: 'f', label: '' }]);
    expect(s.ref_index).toBe(0);
    expect(select('/p/commit/a').references).toEqual([{ project: 'p', commit_id: null, batch: 'default', filter: '', label: '' }]);
  });

  test('the reference shown is at ref_index among the others', () => {
    const s = select('/p/commit/a?reference=c&compare=b&compare=d&ref_index=1');
    expect(ids(s)).toEqual(['b', 'c', 'd']);
    expect(s.ref_commit_id).toBe('c');
    // out of range: clamped
    expect(select('/p/commit/a?reference=c&compare=b&ref_index=9').ref_index).toBe(1);
    expect(select('/p/commit/a?reference=c&compare=b&ref_index=x').ref_index).toBe(0);
  });

  test('references with a batch, filter or project', () => {
    const { url, selected } = act('/p/commit/a?reference=b', add_reference, { commit_id: 'c', batch: 'tuning', filter: 'scene:1', project: 'other' });
    expect(selected.references[1]).toEqual({ commit_id: 'c', batch: 'tuning', filter: 'scene:1', project: 'other', label: 'ref 2' });
    // the old reference, now not shown, is only a commit id
    expect(new URLSearchParams(url.split('?')[1]).get('compare')).toBe('b');
    expect(selected).toMatchObject({ ref_commit_id: 'c', selected_batch_ref: 'tuning', filter_batch_ref: 'scene:1', ref_project: 'other', ref_index: 1 });
  });

  test('switching keeps their order', () => {
    const url = '/p/commit/a?reference=b&compare=c&compare=d';
    const { url: next, selected } = act(url, show_reference, 2);
    expect(ids(selected)).toEqual(['b', 'c', 'd']);
    expect(selected.ref_commit_id).toBe('d');
    expect(next).toBe('/p/commit/a?reference=d&compare=b&compare=c&ref_index=2');
    // back to the first: no ref_index in the URL
    expect(act(next, show_reference, 0).url).toBe('/p/commit/a?reference=b&compare=c&compare=d');
  });

  test('adding a reference shows it, adding one we have shows it', () => {
    const { url, selected } = act('/p/commit/a?reference=b', add_reference, { commit_id: 'c' });
    expect(ids(selected)).toEqual(['b', 'c']);
    expect(selected.ref_commit_id).toBe('c');
    const again = act(url, add_reference, { commit_id: 'b' }).selected;
    expect(ids(again)).toEqual(['b', 'c']);
    expect(again.ref_commit_id).toBe('b');
  });

  test('removing a reference', () => {
    const url = '/p/commit/a?reference=c&compare=b&compare=d&ref_index=1';
    // the one shown: the next one is shown
    expect(act(url, remove_reference, 1).selected).toMatchObject({ ref_commit_id: 'd', ref_index: 1 });
    // the last one shown: the one before
    expect(act('/p/commit/a?reference=d&compare=b&ref_index=1', remove_reference, 1).selected).toMatchObject({ ref_commit_id: 'b', ref_index: 0 });
    // another one: the same is shown
    const before = act(url, remove_reference, 0).selected;
    expect(ids(before)).toEqual(['c', 'd']);
    expect(before).toMatchObject({ ref_commit_id: 'c', ref_index: 0 });
    // the last one can't be removed
    expect(remove_reference(select('/p/commit/a?reference=b'), 0)).toEqual({});
    // without other references, the URL is as before
    expect(act('/p/commit/a?reference=b&compare=c', remove_reference, 1).url).toBe('/p/commit/a?reference=b');
  });

  test('a reference swapped with the top results: both go in the bars, nothing else changes', () => {
    const { url, selected } = act('/p/commit/a?batch=x&reference=b&compare=c', swap_with_top, 1);
    expect(selected.new_commit_id).toBe('c');
    expect(selected.selected_batch_new).toBe('default');
    // the place keeps its name: "ref 2" is now the commit that was on top, and the top is "new". Colors follow results.
    expect(selected.references).toEqual([
      { project: 'p', commit_id: 'b', batch: 'default', filter: '', label: '', color: 1 },
      { project: 'p', commit_id: 'a', batch: 'x', filter: '', label: 'ref 2', color: 0 },
    ]);
    // the old top results are in the bottom bar
    expect(selected).toMatchObject({ ref_commit_id: 'a', ref_index: 1, selected_batch_ref: 'x', label_new: '' });
    expect(url).toBe("/p/commit/c?reference=a&compare%5B0%5D%5Bcommit%5D=b&compare%5B0%5D%5Bcolor%5D=1&batch_ref=x&label_ref=ref%202&color_ref=0&ref_index=1");
    // swapping again goes back, with the reference compared shown
    expect(act(url, swap_with_top, 1).selected).toMatchObject({
      new_commit_id: 'a', selected_batch_new: 'x', ref_commit_id: 'c', ref_index: 1, label_ref: 'ref 2', label_new: '',
    });
  });

  test('changing the reference shown keeps the others', () => {
    const { selected } = roundtrip('/p/commit/a?reference=b&compare=c', { ref_commit_id: 'z' });
    expect(ids(selected)).toEqual(['z', 'c']);
  });

  test('reordering keeps the reference shown', () => {
    const url = '/p/commit/a?reference=b&compare=c&compare=d';
    const { selected } = act(url, move_reference, 0, 2);
    expect(ids(selected)).toEqual(['c', 'd', 'b']);
    expect(selected).toMatchObject({ ref_commit_id: 'b', ref_index: 2 });
    // they keep their names: "ref" isn't first anymore, the others are written down
    expect(reference_names(selected.references)).toEqual(['ref 2', 'ref 3', 'ref']);
    expect(ids(act(url, move_reference, 2, 1).selected)).toEqual(['b', 'd', 'c']);
    // out of the list: nothing changes
    expect(move_reference(select(url), 0, -1)).toEqual({});
  });

  test('a duplicate is shown, next to the original, to change its batch or filter', () => {
    const { url, selected } = act('/p/commit/a?reference=b&batch_ref=x&label_ref=v1&compare=c', duplicate_reference, 0);
    expect(ids(selected)).toEqual(['b', 'b', 'c']);
    expect(selected).toMatchObject({ ref_index: 1, selected_batch_ref: 'x', label_ref: 'v1 copy' });
    // the others keep their names
    expect(reference_names(selected.references)).toEqual(['v1', 'v1 copy', 'ref']);
    // then users change its batch: the original keeps its own
    const changed = roundtrip(url, { selected_batch_ref: 'y' }).selected;
    expect(changed.references.map(r => r.batch)).toEqual(['x', 'y', 'default']);
    expect(changed.references[0].label).toBe('v1');
  });

  test('references are called "ref", then "ref 2", "ref 3"... and keep their names', () => {
    // the first one keeps "ref" when users stack more
    let { url, selected } = act('/p/commit/a?reference=b', add_reference, { commit_id: 'c' });
    expect(reference_names(selected.references)).toEqual(['ref', 'ref 2']);
    ({ url, selected } = act(url, add_reference, { commit_id: 'd' }));
    expect(reference_names(selected.references)).toEqual(['ref', 'ref 2', 'ref 3']);
    // removing one doesn't rename the others, the next one added gets the free name
    ({ url, selected } = act(url, remove_reference, 1));
    expect(reference_names(selected.references)).toEqual(['ref', 'ref 3']);
    ({ url, selected } = act(url, add_reference, { commit_id: 'e' }));
    expect(reference_names(selected.references)).toEqual(['ref', 'ref 3', 'ref 2']);
    // dragging doesn't either
    ({ url, selected } = act(url, move_reference, 2, 0));
    expect(reference_names(selected.references)).toEqual(['ref 2', 'ref', 'ref 3']);
    expect(selected.ref_commit_id).toBe('e');
    // a copy of one of them is the next "ref N"
    ({ url, selected } = act(url, duplicate_reference, 1));
    expect(reference_names(selected.references)).toEqual(['ref 2', 'ref', 'ref 4', 'ref 3']);
    // links from before: the first is "ref", the others the next free names
    expect(reference_names(select('/p/commit/a?reference=b&compare=c&compare=d').references)).toEqual(['ref', 'ref 2', 'ref 3']);
    expect(reference_names(select('/p/commit/a?reference=b&label_ref=ref%202&compare=c').references)).toEqual(['ref 2', 'ref']);
  });

  test('copies of named references and milestones are "<name> copy"', () => {
    const url = '/p/commit/a?reference=b&label_ref=night&compare=c';
    const { url: next, selected } = act(url, duplicate_reference, 0);
    expect(reference_names(selected.references)).toEqual(['night', 'night copy', 'ref']);
    expect(reference_names(act(next, duplicate_reference, 0).selected.references)).toEqual(['night', 'night copy 2', 'night copy', 'ref']);
    // the tabs give milestones' names
    expect(reference_names(act('/p/commit/a?reference=b', duplicate_reference, 0, 'release 1.0').selected.references)).toEqual(['ref', 'release 1.0 copy']);
  });

  test('swapping new and a reference: names users gave follow their results', () => {
    // our names stay in place
    let s = select('/p/commit/a?reference=b&compare=c');
    expect(switch_new_and_reference(s)).toMatchObject({ new_commit_id: 'b', ref_commit_id: 'a', label_new: '', label_ref: '' });
    // users' names follow their results
    s = select('/p/commit/a?label=ISP%20v2&reference=b&label_ref=ISP%20v1');
    expect(switch_new_and_reference(s)).toMatchObject({ label_new: 'ISP v1', label_ref: 'ISP v2' });
    // a named reference becomes new: its place gets a name of ours
    s = select('/p/commit/a?reference=b&label_ref=night&compare=c');
    expect(switch_new_and_reference(s)).toMatchObject({ label_new: 'night', label_ref: 'ref 2' });
    expect(act('/p/commit/a?label=ISP%20v2&reference=b&compare=c', swap_with_top, 1).selected).toMatchObject({ label_new: '', references: [{ label: '' }, { label: 'ISP v2' }] });
  });

  test('other changes keep references with names or batches', () => {
    const url = '/p/commit/a?reference=b&compare%5B0%5D=c&compare%5B1%5D%5Bcommit%5D=d&compare%5B1%5D%5Blabel%5D=ref%203';
    const before = select(url).references;
    expect(before.map(r => r.commit_id)).toEqual(['b', 'c', 'd']);
    const { selected } = roundtrip(url, { filter_batch_ref: 'scene', label_ref: 'night' });
    expect(selected.references).toEqual([{ ...before[0], filter: 'scene', label: 'night' }, before[1], before[2]]);
  });

  test('users name what they compare, the names are in the URL', () => {
    const s = select('/p/commit/a?label=ISP%20v2&reference=b&label_ref=ISP%20v1');
    expect(s).toMatchObject({ label_new: 'ISP v2', label_ref: 'ISP v1' });
    expect(s.references[0].label).toBe('ISP v1');
    // the others' names go with them
    const { url, selected } = act('/p/commit/a?reference=b&compare=c', rename_reference, 1, 'night');
    expect(selected.references[1].label).toBe('night');
    expect(url).toBe('/p/commit/a?reference=b&compare%5B0%5D%5Bcommit%5D=c&compare%5B0%5D%5Blabel%5D=night');
    // and follow them when they are shown, or shown as new
    expect(act(url, show_reference, 1).selected).toMatchObject({ ref_commit_id: 'c', label_ref: 'night' });
    expect(act(url, swap_with_top, 1).selected).toMatchObject({ new_commit_id: 'c', label_new: 'night' });
    // no name: as before
    expect(roundtrip('/p/commit/a?label=x', { label_new: '' }).url).toBe('/p/commit/a?');
  });

  test('references keep their colors wherever they go, freed colors are used again', () => {
    const colors = selected => reference_colors(selected.references);
    // links from before, and while users only add references: colors in order, nothing more in the URL
    expect(colors(select('/p/commit/a?reference=b&compare=c&compare=d'))).toEqual([1, 2, 3]);
    let { url, selected } = act('/p/commit/a?reference=b', add_reference, { commit_id: 'c' });
    ({ url, selected } = act(url, add_reference, { commit_id: 'd' }));
    expect(colors(selected)).toEqual([1, 2, 3]);
    expect(url).not.toMatch(/color/);
    // dragging: they keep their colors
    ({ url, selected } = act(url, move_reference, 2, 0));
    expect(ids(selected)).toEqual(['d', 'b', 'c']);
    expect(colors(selected)).toEqual([3, 1, 2]);
    // switching: too
    ({ url, selected } = act(url, show_reference, 1));
    expect(colors(selected)).toEqual([3, 1, 2]);
    expect(selected.color_ref).toBe(1);
    // removing one: the others keep theirs, the next one added gets the free color
    ({ url, selected } = act(url, remove_reference, 1));
    expect(colors(selected)).toEqual([3, 2]);
    ({ url, selected } = act(url, add_reference, { commit_id: 'e' }));
    expect(colors(selected)).toEqual([3, 2, 1]);
    // a copy gets the next free color
    ({ url, selected } = act(url, duplicate_reference, 0));
    expect(ids(selected)).toEqual(['d', 'd', 'c', 'e']);
    expect(colors(selected)).toEqual([3, 4, 2, 1]);
    // renaming keeps it
    expect(colors(act(url, rename_reference, 2, 'night').selected)).toEqual([3, 4, 2, 1]);
    // swapping with the top results: colors follow their results
    const swapped = act(url, swap_with_top, 2).selected;
    expect(side_colors(swapped.color_new, swapped.references)).toEqual([2, 3, 4, 0, 1]);
    // and back
    const back = act(act(url, swap_with_top, 2).url, swap_with_top, 2).selected;
    expect(side_colors(back.color_new, back.references)).toEqual([0, 3, 4, 2, 1]);
  });

  test('the new results and the reference swapped: their colors follow them, changing a commit keeps its color', () => {
    let { url, selected } = act('/p/commit/a?reference=b&compare=c', switch_new_and_reference);
    expect(selected).toMatchObject({ new_commit_id: 'b', ref_commit_id: 'a', color_ref: 0 });
    expect(side_colors(selected.color_new, selected.references)).toEqual([1, 0, 2]);
    // another commit on top: the same color
    ({ url, selected } = roundtrip(url, { new_commit_id: 'd' }));
    expect(side_colors(selected.color_new, selected.references)).toEqual([1, 0, 2]);
    // swapped back: as before, nothing in the URL
    expect(act(url, switch_new_and_reference).url).not.toMatch(/color/);
  });

  test('past 4 references they are gray, until a color is freed', () => {
    let { url, selected } = { url: '/p/commit/a?reference=b&compare=c&compare=d&compare=e&compare=f' };
    expect(reference_colors(select(url).references)).toEqual([1, 2, 3, 4, undefined]);
    ({ url, selected } = act(url, remove_reference, 1));
    expect(reference_colors(selected.references)).toEqual([1, 3, 4, 2]);
    // colors in the URL that don't exist, or that another has already, are ignored
    expect(reference_colors(select('/p/commit/a?reference=b&color_ref=9&compare%5B0%5D%5Bcommit%5D=c&compare%5B0%5D%5Bcolor%5D=1').references)).toEqual([2, 1]);
    expect(reference_colors(select('/p/commit/a?reference=b&color_ref=2&compare%5B0%5D%5Bcommit%5D=c&compare%5B0%5D%5Bcolor%5D=2').references)).toEqual([2, 1]);
  });
});


describe('project_url', () => {
  it("is the project's path, or its commits when the app has a page with the same name", () => {
    expect(project_url('group/repo')).toBe('/group/repo');
    expect(project_url('a b/c')).toBe('/a%20b/c');
    expect(project_url('projects')).toBe('/projects/commits');
    expect(project_url('settings')).toBe('/settings/commits');
    // only exact matches are the app's
    expect(project_url('projects/sub')).toBe('/projects/sub');
  });
});
