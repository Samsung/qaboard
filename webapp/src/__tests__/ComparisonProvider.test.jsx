// The comparison is what project pages show: the commits we compare and their batches, from the URL and the API
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { makeQueryClient } from '../test-utils';

const commit = (id, outputs = {}) => ({
  id, branch: 'master', message: `Commit ${id}`, authored_datetime: '2026-09-01T10:00:00Z',
  batches: { default: { id: 1, label: 'default', data: {}, outputs } },
});

const api = {
  '/api/v1/project': { git: {}, qatools_config: { project: { reference_branch: 'master' } } },
  '/api/v1/commit/abc': commit('abcdef123', { 1: { id: 1, test_input_path: 'a', test_input_database: '/', configurations: [], metrics: { psnr: 1 } } }),
  '/api/v1/commit/': commit('fff000'),
};

const Shown = () => {
  const { new_commit, ref_commit, new_batch } = useComparison();
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
