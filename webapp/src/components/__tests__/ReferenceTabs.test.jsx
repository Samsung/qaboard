// Users stack several references, and compare the new commit with one at a time: tabs below the commit bars
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../../hooks';
import { history, matchRoutes, RouteMatch } from '../../router';
import { routes } from '../../routes';
import { makeQueryClient } from '../../test-utils';
import { milestonesQuery, index_milestones } from '../../milestones/api';
import { ReferenceTabs } from '../ReferenceTabs';

const commit = id => ({ id, branch: `branch-${id.slice(0, 3)}`, message: `Commit ${id}`, authored_datetime: '2026-09-01T10:00:00Z', batches: {} });

const Labels = () => {
  const { labels, compared } = useComparison();
  return <span data-testid="labels">{labels.new} vs {labels.reference} ({compared.map(c => c.color.css).join(',')})</span>;
};

const Page = () => {
  const { pathname } = useLocation();
  const { match } = matchRoutes(routes, pathname);
  return <RouteMatch match={match}><ComparisonProvider><ReferenceTabs/><Labels/></ComparisonProvider></RouteMatch>;
};

const show = url => {
  act(() => history.replace(url));
  const queryClient = makeQueryClient();
  queryClient.setQueryData(milestonesQuery('p').queryKey, index_milestones([
    { id: 1, project: 'p', commit: 'c'.repeat(40), batch: 'default', label: 'release 1.0', is_mine: true },
  ]));
  render(<QueryClientProvider client={queryClient}><HistoryRouter history={history}><Page/></HistoryRouter></QueryClientProvider>);
};
const query = () => new URLSearchParams(window.location.search);
const reference = () => query().get('reference');
const tab = number => screen.getByRole('tab', { name: new RegExp(`^Reference ${number}:`) });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    const id = pathname.match(/^\/api\/v1\/commit\/(.+)$/)?.[1];
    // f…: a big commit
    if (id) return new Response(JSON.stringify(id.startsWith('f') ? { ...commit(id), batches: { default: { label: 'default', valid_outputs: 8000 } } } : commit(id)));
    // the latest commit of a branch
    if (pathname === '/api/v1/commit/' && searchParams.get('branch')) return new Response(JSON.stringify(commit('e'.repeat(40))));
    return new Response(JSON.stringify({}));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40), f = 'f'.repeat(40);

test('with one reference, users stack more: commits or branches', async () => {
  show(`/p/commit/${a}?reference=${b}`);
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  // new is blue, the reference purple
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs reference (var(--qa-side-0),var(--qa-side-1))');

  fireEvent.click(screen.getByRole('button', { name: 'Stack a reference' }));
  const input = await screen.findByRole('textbox', { name: 'Add a commit or a branch as reference' });
  fireEvent.change(input, { target: { value: c } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(reference()).toBe(c));
  expect(query().getAll('compare')).toEqual([b]);
  // the new reference is a milestone: viewers use its name, it's the second reference: magenta
  await waitFor(() => expect(screen.getByTestId('labels')).toHaveTextContent('new vs release 1.0 (var(--qa-side-0),var(--qa-side-2))'));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');

  // a branch: its latest commit
  fireEvent.click(screen.getByRole('button', { name: 'Stack a reference' }));
  const branch_input = await screen.findByRole('textbox', { name: 'Add a commit or a branch as reference' });
  fireEvent.change(branch_input, { target: { value: 'feature/night' } });
  fireEvent.keyDown(branch_input, { key: 'Enter' });
  await waitFor(() => expect(reference()).toBe(e));
  expect(query().getAll('compare')).toEqual([b, c]);
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
});

test('users switch between references with their tabs or "r"', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${d}`);
  expect(tab(1)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs reference 1');

  fireEvent.click(tab(2));
  await waitFor(() => expect(reference()).toBe(d));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs reference 2');

  fireEvent.keyDown(document.body, { key: 'r' });
  await waitFor(() => expect(reference()).toBe(b));
  fireEvent.keyDown(document.body, { key: 'R', shiftKey: true });
  await waitFor(() => expect(reference()).toBe(d));
});

test('users reorder, rename and remove references from their tabs', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${d}`);
  // alt+arrows move the tab focused
  fireEvent.keyDown(tab(1), { key: 'ArrowRight', altKey: true });
  await waitFor(() => expect(query().getAll('compare')).toEqual([d]));
  expect(query().get('ref_index')).toBe('1');
  expect(screen.getAllByRole('tab').map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);

  // double-click renames, viewers use the name
  fireEvent.doubleClick(tab(2));
  const input = screen.getByRole('textbox', { name: 'Rename reference 2' });
  fireEvent.change(input, { target: { value: 'v1.0 tuned' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(query().get('label_ref')).toBe('v1.0 tuned'));
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs v1.0 tuned');

  fireEvent.keyDown(tab(2), { key: 'Delete' });
  await waitFor(() => expect(reference()).toBe(d));
  expect(window.location.search).not.toContain('compare');
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
});

test('references not shown are loaded without their outputs, then the next ones with them once idle', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}`);
  const requests = () => fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(u => u.pathname.startsWith('/api/v1/commit/'));
  // tabs say their branch
  await waitFor(() => expect(tab(3)).toHaveTextContent('branch-ddd'));
  const light = requests().filter(u => u.searchParams.get('with_outputs') === 'false').map(u => u.pathname.split('/').pop());
  expect(light.sort()).toEqual([c, d]);
  // the next and previous references (2 and 3), with their outputs
  await waitFor(() => {
    const full = requests().filter(u => !u.searchParams.has('with_outputs')).map(u => u.pathname.split('/').pop());
    expect(full).toEqual(expect.arrayContaining([b, c, d]));
  });
});

test('big references are loaded only when users compare with them', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${f}`);
  await waitFor(() => expect(tab(2)).toHaveTextContent('branch-fff'));
  await new Promise(resolve => setTimeout(resolve, 500));
  const full = fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(u => u.pathname === `/api/v1/commit/${f}` && !u.searchParams.has('with_outputs'));
  expect(full).toHaveLength(0);
});
