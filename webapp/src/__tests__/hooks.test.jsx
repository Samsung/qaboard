import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import { useUrlText, useCommit, useProjectData, usePrefetchCommitPage } from '../hooks';
import { usePrefsStore } from '../stores/prefs';
import { commitQuery, commitsQuery, commitsPagesQuery } from '../api/queries';
import { makeQueryClient } from '../test-utils';


describe('useUrlText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('keeps every keystroke, and commits to the URL when users pause', () => {
    const commit = vi.fn();
    const { result } = renderHook(({ value }) => useUrlText(value, commit), { initialProps: { value: '' } });
    act(() => result.current[1]({ target: { value: 's' } }));
    act(() => result.current[1]({ target: { value: 'sc' } }));
    expect(result.current[0]).toBe('sc');
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('sc');
  });

  test('follows changes made elsewhere, e.g. with the back button', () => {
    const { result, rerender } = renderHook(({ value }) => useUrlText(value, vi.fn()), { initialProps: { value: 'a' } });
    rerender({ value: 'b' });
    expect(result.current[0]).toBe('b');
  });

  test("doesn't erase what users typed when its own update arrives", () => {
    const { result, rerender } = renderHook(({ value }) => useUrlText(value, vi.fn()), { initialProps: { value: '' } });
    act(() => result.current[1]({ target: { value: 'ab' } }));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current[1]({ target: { value: 'abc' } }));
    rerender({ value: 'ab' });
    expect(result.current[0]).toBe('abc');
  });
});


describe('useCommit', () => {
  test('shows what lists know about a commit while it loads', async () => {
    const queryClient = makeQueryClient();
    const summary = { id: 'abc', message: 'Hello', batches: {} };
    queryClient.setQueryData(commitsQuery({ project: 'p' }).queryKey, [summary]);
    let resolve;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r })));
    const wrapper = ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCommit({ project: 'p', id: 'abc' }), { wrapper });
    expect(result.current).toMatchObject({ id: 'abc', message: 'Hello', is_loaded: false });
    resolve(new Response(JSON.stringify({ ...summary, message: 'Hello world', batches: { default: { outputs: {} } } })));
    await waitFor(() => expect(result.current.is_loaded).toBe(true));
    expect(result.current.message).toBe('Hello world');
    vi.unstubAllGlobals();
  });

  test('also finds commits in paginated lists', () => {
    const queryClient = makeQueryClient();
    const summary = { id: 'abc', message: 'From a page', batches: {} };
    queryClient.setQueryData(commitsPagesQuery({ project: 'p' }).queryKey, { pages: [{ commits: [summary], has_more: false }], pageParams: [0] });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const wrapper = ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCommit({ project: 'p', id: 'abc' }), { wrapper });
    expect(result.current).toMatchObject({ id: 'abc', message: 'From a page', is_loaded: false });
    vi.unstubAllGlobals();
  });

  test("'' means nothing is selected", () => {
    const wrapper = ({ children }) => <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCommit({ project: 'p', id: '' }), { wrapper });
    expect(result.current).toBe(null);
  });
});


test('preferences are updated immutably', () => {
  const { forgetLegacyMilestones, toggleMilestoneGroup, toggleFavorite } = usePrefsStore.getState();
  usePrefsStore.setState({ milestones: { p: { k: { label: 'v1' } }, q: { k: { label: 'v2' } } } });
  const before = usePrefsStore.getState().milestones;
  forgetLegacyMilestones(['p']);
  expect(usePrefsStore.getState().milestones).toEqual({ q: { k: { label: 'v2' } } });
  expect(before).not.toBe(usePrefsStore.getState().milestones);
  toggleMilestoneGroup('mine/tuning');
  expect(usePrefsStore.getState().milestoneGroupsCollapsed).toEqual({ 'mine/tuning': true });
  toggleMilestoneGroup('mine/tuning');
  expect(usePrefsStore.getState().milestoneGroupsCollapsed).toEqual({});
  toggleFavorite('p');
  expect(usePrefsStore.getState().favorites.p).toBe(true);
});


test("useProjectData merges /api/v1/project, which answers with the project's data", async () => {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(['projects'], { p: { id: 'p', data: { git: { path_with_namespace: 'p' } } } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ git: { path_with_namespace: 'p' }, qatools_config: { project: { reference_branch: 'main' } } }))));
  const wrapper = ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useProjectData('p'), { wrapper });
  await waitFor(() => expect(result.current.data.qatools_config.project.reference_branch).toBe('main'));
  expect(result.current.data.git.path_with_namespace).toBe('p');
  expect(result.current.data.qatools_config.project.reference_branch).toBe('main');
  vi.unstubAllGlobals();
});


describe('usePrefetchCommitPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() });

  const render = queryClient => renderHook(() => usePrefetchCommitPage('p', 'abc'), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });

  test('loads the commit and its default reference when users linger', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const queryClient = makeQueryClient();
    const { result } = render(queryClient);
    act(() => result.current.onMouseEnter());
    act(() => vi.advanceTimersByTime(200));
    expect(queryClient.getQueryState(commitQuery({ project: 'p', id: 'abc' }).queryKey)?.fetchStatus).toBe('fetching');
    expect(queryClient.getQueryState(commitQuery({ project: 'p' }).queryKey)?.fetchStatus).toBe('fetching');
  });

  test('does nothing when users only pass by', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const queryClient = makeQueryClient();
    const { result } = render(queryClient);
    act(() => result.current.onMouseEnter());
    act(() => result.current.onMouseLeave());
    act(() => vi.advanceTimersByTime(200));
    expect(fetch).not.toHaveBeenCalled();
  });
});
