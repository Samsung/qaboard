// Users stack several references, and compare the new commit with one at a time: tabs below the commit bars
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ComparisonProvider, useComparison } from '../../hooks';
import { history, matchRoutes, RouteMatch } from '../../router';
import { routes } from '../../routes';
import { makeQueryClient } from '../../test-utils';
import { milestonesQuery, index_milestones } from '../../milestones/api';
import { ReferenceTabs, tabs_details } from '../ReferenceTabs';
import { usePrefsStore } from '../../stores/prefs';

const commit = id => ({ id, branch: `branch-${id.slice(0, 3)}`, message: `Commit ${id}`, committer_name: 'Ada', authored_datetime: '2026-09-01T10:00:00Z', batches: { default: { label: 'default', valid_outputs: 3, failed_outputs: 1 } } });

const Labels = () => {
  const { labels, compared, references, together } = useComparison();
  return <>
    <span data-testid="labels">{labels.new} vs {labels.reference} ({compared.map(c => c.color.css).join(',')})</span>
    <span data-testid="references">{JSON.stringify({
      references: references.map(({ id, number, ticked, together, is_shown }) => ({ id, number, ticked, together, is_shown })),
      together: together.map(({ id, number, index }) => ({ id, number, index })),
    })}</span>
  </>;
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
  // the preference is persisted: each test starts with the default
  usePrefsStore.setState({ referencesTogether: true });
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
  // the field opens once the menu has closed: it doesn't take the focus back from it
  const input = await screen.findByRole('textbox', { name: 'Rename reference 2' });
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
  show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}&together=0`);
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
  show(`/p/commit/${a}?reference=${b}&compare=${f}&together=0`);
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
  // the menu closes with a transition: under load it's still there when the next opens
  await waitFor(() => expect(screen.queryByRole('menuitem')).not.toBeInTheDocument());

  // moving it keeps its name, and it stays shown
  fireEvent.click(screen.getByRole('button', { name: 'Reference 3: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Move left' }));
  await waitFor(() => expect(tab(2)).toHaveTextContent(/^ref 3/));
  expect(tab(2)).toHaveAttribute('aria-selected', 'true');
  expect(tab(3)).toHaveTextContent(/^ref 2/);
  expect(screen.getByTestId('labels')).toHaveTextContent('new vs ref 3 (');
  await waitFor(() => expect(screen.queryByRole('menuitem')).not.toBeInTheDocument());

  // renaming from the menu: the tab and the viewers use the name
  fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  // the field opens once the menu has closed: it doesn't take the focus back from it
  const input = await screen.findByRole('textbox', { name: 'Rename reference 2' });
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
  // the field opens once the menu has closed: it doesn't take the focus back from it
  const input = await screen.findByRole('textbox', { name: 'Rename reference 2' });
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

describe('several references together', () => {
  const check = name => screen.getByRole('checkbox', { name });
  const unticked = () => [...query().entries()].filter(([key]) => key.endsWith('[together]')).map(([key, value]) => `${key}=${value}`);
  const mode = () => screen.getByRole('radiogroup', { name: "The references' images: one at a time, or together" });
  const segment = name => within(mode()).getByRole('radio', { name });
  const anchor = () => screen.getByRole('img', { name: /: the anchor\. The other images are compared with it$/ });

  test('they are all shown, users untick the others. With the reference as anchor, it follows the tab selected', async () => {
    show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}&anchor=reference`);
    expect(segment('Together')).toBeChecked();
    // the reference compared: an anchor, nothing to tick. The top results have their dot
    expect(anchor()).toHaveAccessibleName('ref: the anchor. The other images are compared with it');
    expect(tab(1)).toContainElement(anchor());
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    await waitFor(() => expect(check('Show release 1.0 next to ref in the image viewer')).toBeChecked());
    expect(check('Show ref 3 next to ref in the image viewer')).toBeChecked();
    // nothing to say in the URL
    expect(window.location.search).toBe(`?reference=${b}&compare=${c}&compare=${d}&anchor=reference`);

    // unticking doesn't compare with it, rename it, or drag it
    const box = check('Show ref 3 next to ref in the image viewer');
    fireEvent.mouseDown(box);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    act(() => { tab(3).dispatchEvent(drag); });
    expect(drag.defaultPrevented).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(unticked()).toEqual(['compare[1][together]=0']));
    fireEvent.doubleClick(check('Show ref 3 next to ref in the image viewer'));
    expect(reference()).toBe(b);
    expect(tab(1)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(check('Show ref 3 next to ref in the image viewer')).not.toBeChecked();

    // another anchor: it takes the place of the one it replaces, as many are shown
    fireEvent.click(tab(3));
    await waitFor(() => expect(reference()).toBe(d));
    expect(tab(3)).toContainElement(anchor());
    expect(check('Show ref next to ref 3 in the image viewer')).not.toBeChecked();
    expect(check('Show release 1.0 next to ref 3 in the image viewer')).toBeChecked();
    // "r" too
    fireEvent.keyDown(document.body, { key: 'r' });
    await waitFor(() => expect(reference()).toBe(b));
    expect(tab(1)).toContainElement(anchor());
    expect(check('Show ref 3 next to ref in the image viewer')).not.toBeChecked();

    // ticking again: the URL is as before
    fireEvent.click(check('Show ref 3 next to ref in the image viewer'));
    await waitFor(() => expect(window.location.search).toBe(`?reference=${b}&compare=${c}&compare=${d}&anchor=reference`));
  });

  test('the anchor is the top results by default, a click on a tab makes it the anchor', async () => {
    show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}`);
    const top = () => screen.getByRole('button', { name: /^Top: new/ });
    expect(anchor()).toHaveAccessibleName('new: the anchor. The other images are compared with it');
    expect(top()).toContainElement(anchor());
    expect(top()).toHaveAttribute('aria-pressed', 'true');
    expect(top()).not.toHaveAttribute('title');
    // the reference compared is always shown, the others are next to new
    const primary = check('ref: the reference compared everywhere, always shown');
    expect(primary).toBeChecked();
    expect(primary).toBeDisabled();
    expect(primary).toHaveAttribute('title', 'The reference compared everywhere: always shown');
    expect(check('Show ref 3 next to new in the image viewer')).toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);

    // "r" changes the reference, not the anchor
    fireEvent.keyDown(document.body, { key: 'r' });
    await waitFor(() => expect(reference()).toBe(c));
    expect(query().get('anchor')).toBeNull();
    expect(top()).toContainElement(anchor());
    expect(check('release 1.0: the reference compared everywhere, always shown')).toBeDisabled();

    // a click on a reference's tab compares with it, and makes it the anchor
    fireEvent.click(tab(3));
    await waitFor(() => expect(reference()).toBe(d));
    expect(query().get('anchor')).toBe('reference');
    expect(tab(3)).toContainElement(anchor());
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(top()).toHaveAttribute('aria-pressed', 'false');
    expect(top()).toHaveAttribute('title', 'Compare the other images with new: make it the anchor');
    // "r": the anchor follows the reference
    fireEvent.keyDown(document.body, { key: 'r' });
    await waitFor(() => expect(reference()).toBe(b));
    expect(tab(1)).toContainElement(anchor());

    // a click on the top results makes them the anchor again: the reference stays
    fireEvent.click(top());
    await waitFor(() => expect(query().get('anchor')).toBeNull());
    expect(reference()).toBe(b);
    expect(top()).toContainElement(anchor());
    // the tab selected, clicked: the anchor. Then the top results with the keyboard
    fireEvent.click(tab(1));
    await waitFor(() => expect(query().get('anchor')).toBe('reference'));
    expect(reference()).toBe(b);
    fireEvent.keyDown(top(), { key: 'Enter' });
    await waitFor(() => expect(query().get('anchor')).toBeNull());
  });

  test('one at a time there is no anchor: the top results are not a button', () => {
    show(`/p/commit/${a}?reference=${b}&compare=${c}&together=0&anchor=reference`);
    expect(screen.queryByRole('button', { name: /^Top: new/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /the anchor/ })).not.toBeInTheDocument();
    fireEvent.click(tab(2));
    // the link's anchor is what it was
    expect(query().get('anchor')).toBe('reference');
  });

  test('one at a time, or together: in the link, and remembered for the other pages', async () => {
    show(`/p/commit/${a}?reference=${b}&compare=${c}&compare=${d}&anchor=reference`);
    fireEvent.click(segment('One at a time'));
    await waitFor(() => expect(query().get('together')).toBe('0'));
    expect(usePrefsStore.getState().referencesTogether).toBe(false);
    expect(segment('One at a time')).toBeChecked();
    // the tabs as before: their dots, no checkbox, no anchor
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /the anchor/ })).not.toBeInTheDocument();
    expect(tab(2).querySelector('.qa-tab-dot.qa-tab-mark')).toBeInTheDocument();
    expect(query().getAll('compare')).toEqual([c, d]);

    fireEvent.click(segment('Together'));
    await waitFor(() => expect(query().get('together')).toBe('1'));
    expect(usePrefsStore.getState().referencesTogether).toBe(true);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(anchor()).toBeInTheDocument();
  });

  test('without a mode in the link, what users last chose', () => {
    usePrefsStore.setState({ referencesTogether: false });
    show(`/p/commit/${a}?reference=${b}&compare=${c}`);
    expect(segment('One at a time')).toBeChecked();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    cleanup();
    // the link wins
    show(`/p/commit/${a}?reference=${b}&compare=${c}&together=1&anchor=reference`);
    expect(segment('Together')).toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(usePrefsStore.getState().referencesTogether).toBe(false);
  });

  test('together with none ticked ticks them all', async () => {
    show(`/p/commit/${a}?reference=${b}&compare[0][commit]=${c}&compare[0][together]=0&compare[1][commit]=${d}&compare[1][together]=0&together=0`);
    fireEvent.click(segment('Together'));
    await waitFor(() => expect(query().get('together')).toBe('1'));
    expect(unticked()).toEqual([]);
    expect(screen.getAllByRole('checkbox').every(box => box.checked)).toBe(true);
  });

  test("from a tab's menu", async () => {
    show(`/p/commit/${a}?reference=${b}&compare=${d}&compare=${e}`);
    fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Show together with ref/ }));
    await waitFor(() => expect(unticked()).toEqual(['compare[0][together]=0']));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    // the anchor is always shown: its menu has no tick
    fireEvent.click(screen.getByRole('button', { name: 'Reference 1: more' }));
    const one = await screen.findByRole('menuitem', { name: /Show the references one at a time/ });
    expect(screen.queryByRole('menuitem', { name: /Show together with/ })).not.toBeInTheDocument();
    fireEvent.click(one);
    await waitFor(() => expect(query().get('together')).toBe('0'));
    expect(usePrefsStore.getState().referencesTogether).toBe(false);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    // one at a time: only the way back
    fireEvent.click(screen.getByRole('button', { name: 'Reference 2: more' }));
    const all = await screen.findByRole('menuitem', { name: /Show the references together/ });
    expect(screen.queryByRole('menuitem', { name: /Show together with/ })).not.toBeInTheDocument();
    fireEvent.click(all);
    await waitFor(() => expect(query().get('together')).toBe('1'));
    // the ticks stayed
    expect(unticked()).toEqual(['compare[0][together]=0']);
  });

  test('moving a tab: its tick and its id go with it, its number is its place', async () => {
    show(`/p/commit/${a}?reference=${b}&compare[0]=${c}&compare[1][commit]=${d}&compare[1][together]=0&anchor=reference`);
    const state = () => JSON.parse(screen.getByTestId('references').textContent);
    const before = state();
    expect(before.references.map(r => [r.number, r.ticked, r.together])).toEqual([[1, true, false], [2, true, true], [3, false, false]]);
    expect(before.references.map(r => r.id)).toEqual([`p/${b}/default/`, `p/${c}/default/`, `p/${d}/default/`]);
    expect(before.together).toEqual([{ id: `p/${c}/default/`, number: 2, index: 1 }]);
    // the last one first, then the anchor last
    fireEvent.keyDown(tab(3), { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(state().references.map(r => r.id)).toEqual([before.references[0].id, before.references[2].id, before.references[1].id]));
    fireEvent.keyDown(tab(1), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(state().references[1].id).toBe(before.references[0].id));
    fireEvent.keyDown(tab(2), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(state().references[2].id).toBe(before.references[0].id));
    const after = state();
    expect(after.references).toEqual([
      { id: `p/${d}/default/`, number: 1, ticked: false, together: false, is_shown: false },
      { id: `p/${c}/default/`, number: 2, ticked: true, together: true, is_shown: false },
      { id: `p/${b}/default/`, number: 3, ticked: true, together: false, is_shown: true },
    ]);
    expect(after.together).toEqual([{ id: `p/${c}/default/`, number: 2, index: 1 }]);
    expect(tab(3)).toContainElement(anchor());
    // renaming changes no id
    fireEvent.doubleClick(tab(2));
    const input = await screen.findByRole('textbox', { name: 'Rename reference 2' });
    fireEvent.change(input, { target: { value: 'night' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(tab(2)).toHaveTextContent(/^night/));
    expect(state().references.map(r => r.id)).toEqual(after.references.map(r => r.id));
  });

  test('only those shown together are loaded with their runs', async () => {
    show(`/p/commit/${a}?reference=${b}&compare[0]=${c}&compare[1][commit]=${f}&compare[1][together]=0`);
    await waitFor(() => expect(tab(3)).toHaveTextContent('branch-fff'));
    const requests = id => fetch.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(u => u.pathname === `/api/v1/commit/${id}`).map(u => u.searchParams.get('with_outputs'));
    await waitFor(() => expect(requests(c)).toEqual([null]));
    expect(requests(f)).toEqual(['false']);
  });
});
