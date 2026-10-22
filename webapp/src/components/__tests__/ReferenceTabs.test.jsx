// Users stack several references, and compare the new commit with one at a time: tabs below the commit bars
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../../hooks';
import { history, matchRoutes, RouteMatch } from '../../router';
import { routes } from '../../routes';
import { makeQueryClient } from '../../test-utils';
import { milestonesQuery, index_milestones } from '../../milestones/api';
import { ReferenceTabs, tabs_details } from '../ReferenceTabs';

const commit = id => ({ id, branch: `branch-${id.slice(0, 3)}`, message: `Commit ${id}`, committer_name: 'Ada', authored_datetime: '2026-09-01T10:00:00Z', batches: { default: { label: 'default', valid_outputs: 3, failed_outputs: 1 } } });

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
// Blueprint's popovers don't clear their open/close delays when they unmount: we let them fire while `window` exists
afterAll(() => new Promise(resolve => setTimeout(resolve, 1000)));

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40), f = 'f'.repeat(40);

test('with one reference, users stack more: commits or branches', async () => {
  show(`/p/commit/${a}?reference=${b}`);
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  // new is blue, the reference purple
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref (var(--qa-side-0),var(--qa-side-1))');

  fireEvent.click(screen.getByRole('button', { name: 'Stack a reference' }));
  const input = await screen.findByRole('textbox', { name: 'Add a commit or a branch as reference' });
  fireEvent.change(input, { target: { value: c } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(reference()).toBe(c));
  expect(query().getAll('compare')).toEqual([b]);
  expect(query().get('label_ref')).toBe('ref 2');
  // the new reference is a milestone: viewers use its name, it's the second reference: magenta
  await waitFor(() => expect(screen.getByTestId('labels')).toHaveTextContent('new vs release 1.0 (var(--qa-side-0),var(--qa-side-2))'));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');

  // a branch: its latest commit
  fireEvent.click(screen.getByRole('button', { name: 'Stack a reference' }));
  const branch_input = await screen.findByRole('textbox', { name: 'Add a commit or a branch as reference' });
  fireEvent.change(branch_input, { target: { value: 'feature/night' } });
  fireEvent.keyDown(branch_input, { key: 'Enter' });
  await waitFor(() => expect(reference()).toBe(e));
  expect(query().get('label_ref')).toBe('ref 3');
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
});

test('users switch between references with their tabs or "r"', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${d}`);
  expect(tab(1)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref (');

  fireEvent.click(tab(2));
  await waitFor(() => expect(reference()).toBe(d));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref 2 (');

  fireEvent.keyDown(document.body, { key: 'r' });
  await waitFor(() => expect(reference()).toBe(b));
  fireEvent.keyDown(document.body, { key: 'R', shiftKey: true });
  await waitFor(() => expect(reference()).toBe(d));
});

test('users reorder, rename and remove references from their tabs', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${d}`);
  // alt+arrows move the tab focused
  fireEvent.keyDown(tab(1), { key: 'ArrowRight', altKey: true });
  await waitFor(() => expect(query().get('compare[0][commit]')).toBe(d));
  // it keeps its name: the other one is written down
  expect(query().get('compare[0][label]')).toBe('ref 2');
  expect(query().get('ref_index')).toBe('1');
  expect(screen.getAllByRole('tab').map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  // and its color: purple, now second
  expect(screen.getByTestId('labels')).toHaveTextContent('(var(--qa-side-0),var(--qa-side-1))');

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
  // the one left keeps its color
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref 2 (var(--qa-side-0),var(--qa-side-2))');
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

test('a reference has the same name in its tab and in the viewers, wherever it goes', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${d}`);
  // the tab says its name, then its branch
  await waitFor(() => expect(tab(2)).toHaveTextContent('ref 2branch-ddd'));
  expect(tab(1)).toHaveTextContent(/^ref/);

  // the "⋯" menu has the same actions as the right-click menu
  fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
  // the copy is shown, named after the next free number
  expect(tab(3)).toHaveAttribute('aria-selected', 'true');
  expect(tab(3)).toHaveTextContent(/^ref 3/);
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref 3 (');

  // moving it keeps its name, and it stays shown
  fireEvent.click(screen.getByRole('button', { name: 'Reference 3: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Move left' }));
  await waitFor(() => expect(tab(2)).toHaveTextContent(/^ref 3/));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');
  expect(tab(3)).toHaveTextContent(/^ref 2/);
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref 3 (');

  // renaming from the menu: the tab and the viewers use the name
  fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const input = screen.getByRole('textbox', { name: 'Rename reference 2' });
  expect(input).toHaveValue('ref 3');
  fireEvent.change(input, { target: { value: 'tuned' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByTestId('labels')).toHaveTextContent('new vs tuned ('));
  expect(tab(2)).toHaveTextContent(/^tuned/);
  // clicking menu items doesn't also switch references
  expect(reference()).toBe(d);
});

test('milestones are called by their name, unless users call them something else on the page', async () => {
  show(`/p/commit/${a}?reference=${b}&compare%5B0%5D%5Bcommit%5D=${c}&compare%5B0%5D%5Blabel%5D=ref%202`);
  // "ref 2" is a name we gave: the milestone's wins
  await waitFor(() => expect(tab(2)).toHaveTextContent(/^release 1\.0/));
  fireEvent.doubleClick(tab(2));
  const input = screen.getByRole('textbox', { name: 'Rename reference 2' });
  expect(input).toHaveValue('');
  expect(input).toHaveAttribute('placeholder', 'release 1.0');
  fireEvent.change(input, { target: { value: 'v1 tuned' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(tab(2)).toHaveTextContent(/^v1 tuned/));
  // cleared: the milestone's name again
  fireEvent.doubleClick(tab(2));
  const again = screen.getByRole('textbox', { name: 'Rename reference 2' });
  expect(again).toHaveValue('v1 tuned');
  fireEvent.change(again, { target: { value: '' } });
  fireEvent.keyDown(again, { key: 'Enter' });
  await waitFor(() => expect(tab(2)).toHaveTextContent(/^release 1\.0/));
});

test('hovering a tab says what the reference is', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    show(`/p/commit/${a}?reference=${b}&compare=${a}`);
    await waitFor(() => expect(tab(2)).toHaveTextContent('branch-aaa'));
    fireEvent.mouseEnter(tab(2));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const card = await screen.findByText('Commit ' + a);
    const tooltip = card.closest('.bp6-popover-content') ?? document.body;
    expect(tooltip).toHaveTextContent('ref 2');
    expect(tooltip).toHaveTextContent('aaaaaaaa');
    expect(tooltip).toHaveTextContent('branch-aaa');
    expect(tooltip).toHaveTextContent('Ada');
    expect(tooltip).toHaveTextContent('Batch CI');
    expect(tooltip).toHaveTextContent('3 runs');
    expect(tooltip).toHaveTextContent('1 failed');
    // what is the same as the top results is left unsaid
    expect(tooltip).not.toHaveTextContent(/same/i);
    expect(tab(2)).not.toHaveTextContent('new');
  } finally {
    vi.useRealTimers();
  }
});

describe('tabs say only what tells references apart', () => {
  const ref = (commit_id, branch, more = {}) => ({ project: 'p', commit_id, batch: 'default', filter: '', commit: { id: commit_id, branch, batches: {} }, ...more });
  const texts = refs => tabs_details(refs, 'p').map(details => details.map(d => `${d.key}:${d.text}`));

  test('branches only when they differ, commits when they share one', () => {
    expect(texts([ref(a, 'master'), ref(b, 'develop')])).toEqual([['branch:master'], ['branch:develop']]);
    // all on master: their commits
    expect(texts([ref(a, 'master'), ref(b, 'master')])).toEqual([['commit:aaaaaaaa'], ['commit:bbbbbbbb']]);
    // two on master, one on develop
    expect(texts([ref(a, 'master'), ref(b, 'master'), ref(c, 'develop')]))
      .toEqual([['commit:aaaaaaaa', 'branch:master'], ['commit:bbbbbbbb', 'branch:master'], ['branch:develop']]);
  });

  test('copies: their batch or filter when they differ', () => {
    expect(texts([ref(a, 'master'), ref(a, 'master')])).toEqual([[], []]);
    expect(texts([ref(a, 'master'), ref(a, 'master', { batch: 'night' })])).toEqual([[], ['batch:night']]);
    expect(texts([ref(a, 'master'), ref(a, 'master', { filter: 'indoor' })])).toEqual([[], ['filter:indoor']]);
  });

  test("milestones are told apart by their names, other projects by their project", () => {
    expect(texts([ref(a, 'master', { milestone: { label: 'v1' } }), ref(b, 'develop')])).toEqual([[], ['branch:develop']]);
    expect(texts([ref(a, 'master'), ref(a, 'master', { project: 'q' })])).toEqual([['project:p'], ['project:q']]);
  });
});

test('the first tab is the top results: only the two bars swap', async () => {
  show(`/p/commit/${a}?label=ISP%20v2&reference=${b}&compare=${d}`);
  const top = await screen.findByLabelText(/^Top: ISP v2/);
  // hidden references don't swap: the top results would replace something users don't see
  fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
  expect(await screen.findByRole('menuitem', { name: /Compare with it/ })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /Swap the bars/ })).not.toBeInTheDocument();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });

  // the top tab's menu swaps it with the reference shown
  fireEvent.click(within(top.closest('.qa-tabs-top')).getByRole('button', { name: 'Top: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Swap the bars/ }));
  await waitFor(() => expect(location.pathname).toBe(`/p/commit/${b}`));
  // the same comparison, reversed: nothing removed, the names follow their results
  expect(reference()).toBe(a);
  expect(query().get('label_ref')).toBe('ISP v2');
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ISP v2 (');
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(await screen.findByLabelText(/^Top: new/)).toBeInTheDocument();
});

test('dragging a tab says where it would go, between which tabs', async () => {
  show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}`);
  await waitFor(() => expect(tab(3)).toHaveTextContent('branch-ddd'));
  const dataTransfer = { setData: () => {}, effectAllowed: '' };
  const hint = () => document.querySelector('.qa-tabs-drop-hint');
  const marker = () => document.querySelector('.qa-drop-marker');
  // jsdom's drag events have no position: they're on the right half of tabs, so the drop is after them
  fireEvent.dragStart(tab(1), { dataTransfer });
  expect(hint()).toHaveTextContent(/^Drop between two references/);
  fireEvent.dragOver(tab(3), { dataTransfer });
  expect(hint()).toHaveTextContent(/^Move ref last, after ref 3$/);
  expect(tab(3).querySelector('.qa-drop-marker')).not.toBeNull();
  fireEvent.dragEnd(tab(1));
  expect(hint()).toBeNull();

  const third = tab(3);
  fireEvent.dragStart(third, { dataTransfer });
  fireEvent.dragOver(tab(1), { dataTransfer });
  expect(hint()).toHaveTextContent(/^Move ref 3 between ref and release 1.0$/);
  // next to itself, it wouldn't move: no marker
  fireEvent.dragOver(tab(2), { dataTransfer });
  expect(hint()).toHaveTextContent('ref 3 is already there');
  expect(marker()).toBeNull();
  // dropped between the first two
  fireEvent.dragOver(tab(1), { dataTransfer });
  fireEvent.drop(tab(1), { dataTransfer });
  await waitFor(() => expect(tab(2)).toHaveTextContent('branch-ddd'));
  expect(hint()).toBeNull();
  expect(marker()).toBeNull();
});
