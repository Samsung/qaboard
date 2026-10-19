// Users select several references, and compare the new commit with one at a time: ‹ 2/3 ›, "r", a menu to manage them
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../../hooks';
import { history, matchRoutes, RouteMatch } from '../../router';
import { routes } from '../../routes';
import { makeQueryClient } from '../../test-utils';
import { milestonesQuery, index_milestones } from '../../milestones/api';
import { ReferencesSwitcher } from '../ReferencesSwitcher';

const commit = id => ({ id, branch: `branch-${id}`, message: `Commit ${id}`, authored_datetime: '2026-09-01T10:00:00Z', batches: {} });

const Labels = () => {
  const { labels, compared } = useComparison();
  return <span data-testid="labels">{labels.new} vs {labels.reference} ({compared.map(c => c.key).join(',')})</span>;
};

const Page = () => {
  const { pathname } = useLocation();
  const { match } = matchRoutes(routes, pathname);
  return <RouteMatch match={match}><ComparisonProvider><ReferencesSwitcher/><Labels/></ComparisonProvider></RouteMatch>;
};

const show = url => {
  act(() => history.replace(url));
  const queryClient = makeQueryClient();
  queryClient.setQueryData(milestonesQuery('p').queryKey, index_milestones([
    { id: 1, project: 'p', commit: 'c'.repeat(40), batch: 'default', label: 'release 1.0', is_mine: true },
  ]));
  render(<QueryClientProvider client={queryClient}><HistoryRouter history={history}><Page/></HistoryRouter></QueryClientProvider>);
};
const reference = () => new URLSearchParams(window.location.search).get('reference');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    const { pathname } = new URL(url, 'http://localhost');
    const id = pathname.match(/^\/api\/v1\/commit\/(.+)$/)?.[1];
    return new Response(JSON.stringify(id ? commit(id) : {}));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);

test('with one reference, users can add more', async () => {
  show(`/p/commit/${a}?reference=${b}`);
  expect(screen.getByRole('button', { name: 'Compare with more references' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Next reference' })).not.toBeInTheDocument();
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs reference (new,reference)');

  fireEvent.click(screen.getByRole('button', { name: 'Compare with more references' }));
  const input = await screen.findByRole('textbox', { name: 'Add a commit as reference' });
  fireEvent.change(input, { target: { value: c } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(reference()).toBe(c));
  expect(new URLSearchParams(window.location.search).getAll('compare')).toEqual([b]);
  // the new reference is a milestone: viewers use its name
  await waitFor(() => expect(screen.getByTestId('labels')).toHaveTextContent('new vs release 1.0'));
});

test('users switch between references with the arrows or "r"', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${c}`);
  expect(screen.getByRole('button', { name: /Reference 1 of 2/ })).toHaveTextContent('1/2');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs reference 1');

  fireEvent.click(screen.getByRole('button', { name: 'Next reference' }));
  await waitFor(() => expect(reference()).toBe(c));
  expect(screen.getByRole('button', { name: /Reference 2 of 2/ })).toBeInTheDocument();

  fireEvent.keyDown(document.body, { key: 'r' });
  await waitFor(() => expect(reference()).toBe(b));
  fireEvent.keyDown(document.body, { key: 'R', shiftKey: true });
  await waitFor(() => expect(reference()).toBe(c));
});

test('users remove references from the menu', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${c}`);
  fireEvent.click(screen.getByRole('button', { name: /Reference 1 of 2/ }));
  const [remove] = await screen.findAllByRole('button', { name: 'Remove from the references' });
  fireEvent.click(remove);
  await waitFor(() => expect(reference()).toBe(c));
  expect(window.location.search).not.toContain('compare');
});
