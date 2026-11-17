// The comparison is what project pages show: the commits we compare and their batches, from the URL and the API
import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { makeQueryClient } from '../test-utils';
import { usePrefsStore } from '../stores/prefs';

const commit = (id, outputs = {}) => ({
  id, branch: 'master', message: `Commit ${id}`, authored_datetime: '2026-09-01T10:00:00Z',
  batches: { default: { id: 1, label: 'default', data: {}, outputs } },
});

const api = {
  '/api/v1/project': { git: {}, qatools_config: { project: { reference_branch: 'master' } } },
  '/api/v1/commit/abc': commit('abcdef123', { 1: { id: 1, test_input_path: 'a', test_input_database: '/', configurations: [], metrics: { psnr: 1 } } }),
  '/api/v1/commit/': commit('fff000'),
  '/api/v1/commit/fff000': commit('fff000', { 5: { id: 5, test_input_path: 'a', test_input_database: '/', configurations: [], metrics: { psnr: 2 } } }),
  '/api/v1/commit/ccc111': commit('ccc111', {
    7: { id: 7, test_input_path: 'a', test_input_database: '/', configurations: [], metrics: { psnr: 3 } },
    8: { id: 8, test_input_path: 'b', test_input_database: '/', configurations: [], metrics: { psnr: 4 } },
  }),
  '/api/v1/commit/ddd222': commit('ddd222'),
};

// what the page last rendered with
let comparison;
const Shown = () => {
  const shown = useComparison();
  useEffect(() => { comparison = shown; });
  const { new_commit, ref_commit, new_batch } = shown;
  return <div>
    <span data-testid="new">{new_commit?.id}{new_commit?.is_loaded ? ' loaded' : ''}</span>
    <span data-testid="ref">{ref_commit?.id}</span>
    <span data-testid="outputs">{new_batch.filtered.outputs.length}</span>
  </div>;
};

const Page = () => {
  const { pathname } = useLocation();
  const { match } = matchRoutes(routes, pathname);
  return <RouteMatch match={match}><ComparisonProvider><Shown/></ComparisonProvider></RouteMatch>;
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const { pathname } = new URL(url, 'http://localhost');
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return new Response(JSON.stringify(api[key] ?? {}));
  }));
});
afterEach(() => vi.unstubAllGlobals());

test('a commit opened by its short id gets its full id in the URL, without fetching it again', async () => {
  act(() => history.replace('/group/repo/commit/abc'));
  render(<QueryClientProvider client={makeQueryClient()}><HistoryRouter history={history}><Page/></HistoryRouter></QueryClientProvider>);
  await waitFor(() => expect(window.location.pathname).toBe('/group/repo/commit/abcdef123'));
  expect(screen.getByTestId('new')).toHaveTextContent('abcdef123 loaded');
  expect(screen.getByTestId('outputs')).toHaveTextContent('1');
  // without ?reference=, the reference is the latest commit on the reference branch
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('reference')).toBe('fff000'));
  const commit_requests = fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost').pathname).filter(p => p.startsWith('/api/v1/commit/'));
  expect(commit_requests.sort()).toEqual(['/api/v1/commit/', '/api/v1/commit/abc']);
});

describe('references shown together with the one compared', () => {
  const open = search => {
    act(() => history.replace(`/group/repo/commit/abcdef123?reference=fff000&${search}`));
    render(<QueryClientProvider client={makeQueryClient()}><HistoryRouter history={history}><Page/></HistoryRouter></QueryClientProvider>);
  };
  const requests = () => fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname.startsWith('/api/v1/commit/'));
  // the preference is persisted: each test starts with the default
  beforeEach(() => usePrefsStore.setState({ referencesTogether: true }));

  test('by default they all are: they come with their runs, and find the run that matches a new run', async () => {
    open('compare[0]=ccc111&compare[1][commit]=ddd222&compare[1][together]=0');
    expect(comparison.together_mode).toBe('all');
    // there at once, before their runs
    expect(comparison.together).toMatchObject([{ id: 'group/repo/ccc111/default/', key: 'reference-2', index: 1, number: 2, label: 'ref 2', project: 'group/repo', loading: true }]);
    expect(comparison.together[0].match(comparison.new_batch.outputs[1])).toBeUndefined();
    await waitFor(() => expect(comparison.together[0].loading).toBe(false));
    await waitFor(() => expect(comparison.new_batch.outputs[1]?.reference_id).toBe(5));
    const [entry] = comparison.together;
    expect(entry.commit.id).toBe('ccc111');
    expect(entry.color).toBe(comparison.references[1].color);
    expect(Object.keys(entry.batch.outputs)).toEqual(['7', '8']);
    // the same input, like the reference compared
    const output_new = comparison.new_batch.outputs[1];
    expect(entry.match(output_new)).toBe(entry.batch.outputs[7]);
    expect(entry.match(output_new)).toBe(entry.match(output_new));
    expect(entry.match({ id: 99, test_input_path: 'z', configurations: [] })).toBeUndefined();
    expect(entry.match(undefined)).toBeUndefined();
    // the one compared is not shown together with itself, the one unticked isn't shown
    expect(comparison.references.map(r => [r.id, r.ticked, r.together])).toEqual([
      ['group/repo/fff000/default/', true, false], ['group/repo/ccc111/default/', true, true], ['group/repo/ddd222/default/', false, false],
    ]);
    expect(comparison.compared.map(side => side.key)).toEqual(['new', 'reference']);
    // only those shown are fetched with their runs
    const with_outputs = id => requests().filter(url => url.pathname === `/api/v1/commit/${id}`).map(url => url.searchParams.get('with_outputs'));
    expect(with_outputs('ccc111')).toEqual([null]);
    expect(with_outputs('ddd222')).toEqual(['false']);
  });

  test('their filter is theirs, and the array is the same while nothing changes', async () => {
    open('compare[0][commit]=ccc111&compare[0][filter]=b');
    await waitFor(() => expect(comparison.together[0].loading).toBe(false));
    await waitFor(() => expect(comparison.new_batch.outputs[1]).toBeDefined());
    const { together } = comparison;
    expect(together[0].id).toBe('group/repo/ccc111/default/b');
    expect(together[0].batch.filtered.outputs).toEqual(['8']);
    // a change elsewhere on the page
    act(() => history.replace(`${window.location.pathname}${window.location.search}&selected_views=logs`));
    await waitFor(() => expect(comparison.selected.selected_views).toEqual(['logs']));
    expect(comparison.together).toBe(together);
  });

  test('one at a time: none, whatever is ticked', async () => {
    open('compare=ccc111&together=0');
    expect(comparison.together_mode).toBe('one');
    await waitFor(() => expect(comparison.references[1].commit?.id).toBe('ccc111'));
    const { together } = comparison;
    expect(together).toEqual([]);
    expect(comparison.references.map(r => [r.ticked, r.together])).toEqual([[true, false], [true, false]]);
    expect(requests().filter(url => url.pathname === '/api/v1/commit/ccc111').map(url => url.searchParams.get('with_outputs'))).toEqual(['false']);
    act(() => history.replace(`${window.location.pathname}${window.location.search}&ref_index=1`));
    await waitFor(() => expect(comparison.selected.ref_index).toBe(1));
    expect(comparison.together).toBe(together);
  });

  test('without a mode in the link: what users last chose, and the link wins', () => {
    usePrefsStore.setState({ referencesTogether: false });
    open('compare=ccc111');
    expect(comparison.together_mode).toBe('one');
    expect(comparison.together).toEqual([]);
    act(() => usePrefsStore.setState({ referencesTogether: true }));
    expect(comparison.together_mode).toBe('all');
    expect(comparison.together).toHaveLength(1);
    act(() => history.replace(`${window.location.pathname}${window.location.search}&together=0`));
    expect(comparison.together_mode).toBe('one');
  });

  test('the anchor is the new results, unless the link says the reference', () => {
    open('compare=ccc111');
    expect(comparison.anchor).toBe('new');
    act(() => history.replace(`${window.location.pathname}${window.location.search}&anchor=reference`));
    expect(comparison.anchor).toBe('reference');
  });

  test('with one reference there is nothing to show together', () => {
    open('together=1');
    expect(comparison.together).toEqual([]);
    expect(comparison.references.map(r => r.together)).toEqual([false]);
  });

  test('a copy of a reference has its own id', () => {
    open('compare=fff000&compare=ccc111');
    expect(comparison.references.map(r => r.id)).toEqual(['group/repo/fff000/default/', 'group/repo/fff000/default/#2', 'group/repo/ccc111/default/']);
  });
});
