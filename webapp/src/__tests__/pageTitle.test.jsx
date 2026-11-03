/**
 * What browser tabs say: titles named after what pages show, the status of the runs, and the commit page's tab.
 * Run with: cd webapp && npm test -- pageTitle
 */
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import {
  commit_title, list_title, history_title, app_title, runs_status, status_badge, runs_summary, useFinishedUnseen, useCommitTab,
} from '../pageTitle';
import { ComparisonProvider } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { makeQueryClient } from '../test-utils';


const project = 'group/isp';
const commit_id = 'abcdef1234567890';

describe('commit_title', () => {
  it('names the tab after the commit when nothing else is named', () => {
    expect(commit_title({ project, commit_id, branch: 'main' })).toBe('abcdef12 main · isp');
    expect(commit_title({ project })).toBe('Commit · isp');
    // sub-projects: the last part of their path
    expect(commit_title({ project: 'group/repo/sub/isp', commit_id, branch: 'main' })).toBe('abcdef12 main · isp');
  });
  it('prefers what users named, then milestones, then the batch', () => {
    expect(commit_title({ project, commit_id, branch: 'main', name_new: 'ISP v2', name_ref: 'baseline' })).toBe('ISP v2 vs baseline · isp');
    expect(commit_title({ project, commit_id, name_new: 'ISP v2' })).toBe('ISP v2 · isp');
    expect(commit_title({ project, commit_id, name_ref: 'Golden 2.3' })).toBe('abcdef12 vs Golden 2.3 · isp');
    expect(commit_title({ project, commit_id, batch: { label: 'tuning-lr' } })).toBe('tuning-lr on abcdef12 · isp');
    expect(commit_title({ project, commit_id, batch: { label: '@alice| default', data: { type: 'local' } } })).toBe('alice 🏠 on abcdef12 · isp');
    expect(commit_title({ project, commit_id, branch: 'main', batch: { label: 'default' } })).toBe('abcdef12 main · isp');
  });
  it('says which view is open only for the views people keep in their own tab, after the subject', () => {
    expect(commit_title({ project, commit_id, name_new: 'ISP v2', views: ['logs'] })).toBe('ISP v2 · Logs · isp');
    expect(commit_title({ project, commit_id, name_new: 'ISP v2', views: ['optimization'] })).toBe('ISP v2 · Tuning Analysis · isp');
    expect(commit_title({ project, commit_id, name_new: 'ISP v2', views: ['summary', 'output-list'] })).toBe('ISP v2 · isp');
  });
  it('puts the status first', () => {
    expect(commit_title({ project, commit_id, name_new: 'ISP v2', prefix: '12/40 ' })).toBe('12/40 ISP v2 · isp');
  });
});

describe('other pages', () => {
  it('names lists and the history after the branch', () => {
    expect(list_title({ project, branch: 'main' })).toBe('main · isp');
    expect(list_title({ project, committer: 'alice' })).toBe("alice's commits · isp");
    expect(list_title({ project })).toBe('Commits · isp');
    expect(history_title({ project, branch: 'main' })).toBe('History of main · isp');
    expect(history_title({ project })).toBe('History · isp');
  });
  it("names the app's pages with their tab", () => {
    expect(app_title('Profile', 'Settings')).toBe('Profile · Settings · QA-Board');
    expect(app_title(undefined, 'Admin')).toBe('Admin · QA-Board');
    expect(app_title()).toBe('QA-Board');
  });
});

describe('the status of the runs', () => {
  const batch = counts => ({ label: 'default', valid_outputs: 0, failed_outputs: 0, pending_outputs: 0, running_outputs: 0, ...counts });

  it('has nothing to say without runs', () => {
    expect(runs_status(null)).toBeNull();
    expect(runs_status(batch({}))).toBeNull();
    expect(status_badge(null)).toEqual({ prefix: '', state: null });
    expect(runs_summary(null)).toBe('');
  });
  it('counts the runs done while some are pending, red as soon as one failed', () => {
    const status = runs_status(batch({ valid_outputs: 10, failed_outputs: 2, pending_outputs: 28, running_outputs: 3 }));
    expect(status).toMatchObject({ done: 12, total: 40, pending: 28, failed: 2 });
    expect(status_badge(status)).toEqual({ prefix: '12/40 ', state: 'failed' });
    expect(status_badge(runs_status(batch({ valid_outputs: 12, pending_outputs: 28 })))).toEqual({ prefix: '12/40 ', state: 'running' });
    expect(runs_summary(status)).toBe('12 of 40 runs done, 2 failed');
  });
  it('says how many failed once finished, and that it finished when nobody looked', () => {
    const failed = runs_status(batch({ valid_outputs: 37, failed_outputs: 3 }));
    expect(status_badge(failed)).toEqual({ prefix: '3✕ ', state: 'failed' });
    expect(runs_summary(failed)).toBe('40 runs: 37 passed, 3 failed');
    const passed = runs_status(batch({ valid_outputs: 1 }));
    expect(status_badge(passed)).toEqual({ prefix: '', state: null });
    expect(status_badge(passed, { unseen: true })).toEqual({ prefix: '✓ ', state: 'finished' });
    expect(runs_summary(passed)).toBe('1 run: 1 passed');
  });
  it('knows when qa batch is still starting, or failed to', () => {
    const submissions = status => ({ data: { submissions: { 1: { status, created_at: '2026-11-01' } } } });
    expect(status_badge(runs_status(batch(submissions('submitting'))))).toEqual({ prefix: '', state: 'running' });
    expect(status_badge(runs_status(batch(submissions('failed'))))).toEqual({ prefix: '✕ ', state: 'failed' });
    expect(runs_summary(runs_status(batch(submissions('failed'))))).toBe('failed to start');
  });
});


const set_visibility = state => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
afterEach(() => { delete document.visibilityState; });

describe('useFinishedUnseen', () => {
  it('remembers runs that finished while the tab was hidden, until users look at it', () => {
    const { result, rerender } = renderHook(({ key, pending }) => useFinishedUnseen({ key, pending }), { initialProps: { key: 'a', pending: true } });
    expect(result.current).toBe(false);
    set_visibility('hidden');
    rerender({ key: 'a', pending: false });
    expect(result.current).toBe(true);
    set_visibility('visible');
    expect(result.current).toBe(false);
  });
  it('says nothing when they finish under the user’s eyes, or for another batch', () => {
    const { result, rerender } = renderHook(({ key, pending }) => useFinishedUnseen({ key, pending }), { initialProps: { key: 'a', pending: true } });
    rerender({ key: 'a', pending: false });
    expect(result.current).toBe(false);
    set_visibility('hidden');
    rerender({ key: 'a', pending: true });
    rerender({ key: 'b', pending: false });
    expect(result.current).toBe(false);
  });
});


// The commit page, with a batch whose runs are pending, then done when its summary is asked for
describe('useCommitTab', () => {
  const batch = counts => ({ id: 1, label: 'default', data: {}, outputs: {}, valid_outputs: 0, failed_outputs: 0, pending_outputs: 0, running_outputs: 0, ...counts });
  const pending = { valid_outputs: 12, pending_outputs: 28, running_outputs: 3 };
  const done = { valid_outputs: 40 };
  let requests;
  let finished;
  beforeEach(() => {
    requests = [];
    finished = false;
    vi.stubGlobal('fetch', vi.fn(async url => {
      const { pathname, searchParams } = new URL(url, 'http://localhost');
      requests.push(pathname + (searchParams.get('with_outputs') === 'false' ? '?summary' : ''));
      if (pathname === '/api/v1/project') return new Response(JSON.stringify({ git: {}, qatools_config: { project: { reference_branch: 'master' } } }));
      if (pathname === `/api/v1/commit/${commit_id}`) {
        if (searchParams.get('with_outputs') === 'false') finished = true;
        return new Response(JSON.stringify({ id: commit_id, branch: 'master', message: 'Faster denoising\n\nMore details', authored_datetime: '2026-11-01T10:00:00Z', batches: { default: batch(finished ? done : pending) } }));
      }
      if (pathname === '/api/v1/commit/') return new Response(JSON.stringify({ id: 'fff000', branch: 'master', message: 'ref', authored_datetime: '2026-10-01T10:00:00Z', batches: {} }));
      return new Response('{}');
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const Tab = () => { useCommitTab(); return null; };
  const Page = () => {
    const { pathname } = useLocation();
    const { match } = matchRoutes(routes, pathname);
    return <RouteMatch match={match}><ComparisonProvider><Tab/></ComparisonProvider></RouteMatch>;
  };
  const open = url => {
    act(() => history.replace(url));
    render(<QueryClientProvider client={makeQueryClient()}><HistoryRouter history={history}><Page/></HistoryRouter></QueryClientProvider>);
  };

  it('says how many runs are done, and what users named', async () => {
    open(`/${project}/commit/${commit_id}?label=ISP%20v2&label_ref=baseline`);
    await waitFor(() => expect(document.title).toBe('12/40 ISP v2 vs baseline · isp'));
    expect(requests.filter(r => r.endsWith('?summary'))).toEqual([]);
  });

  it('follows the runs of a background tab from the commit’s summary, and refreshes the commit when they are done', async () => {
    set_visibility('hidden');
    open(`/${project}/commit/${commit_id}`);
    await waitFor(() => expect(document.title).toBe('12/40 abcdef12 master · isp'));
    // the summary says they're done: the tab says so, and the commit is fetched again, with its outputs
    await waitFor(() => expect(document.title).toBe('✓ abcdef12 master · isp'));
    await waitFor(() => expect(requests.filter(r => r === `/api/v1/commit/${commit_id}`).length).toBe(2));
    expect(requests.filter(r => r.endsWith('?summary')).length).toBe(1);
    set_visibility('visible');
    await waitFor(() => expect(document.title).toBe('abcdef12 master · isp'));
  });
});
