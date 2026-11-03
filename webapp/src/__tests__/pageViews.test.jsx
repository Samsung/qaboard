// Page views for the usage analytics: one per page, with what the page is about
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../router';
import { page_view_of, PageViews } from '../usePageViews';
import { initUsage, _resetUsageForTests, _usageQueueForTests } from '../analytics';


describe('page_view_of', () => {
  it('names the page, its project and its commit', () => {
    expect(page_view_of('/repo/sub/commit/abc123', '?reference=def&batch=tuning&selected_views=logs')).toEqual({
      route: 'commit', project_id: 'repo/sub', commit_id: 'abc123', has_reference: true, batch_label: 'tuning', view: 'logs',
    });
    expect(page_view_of('/repo/commit/abc123')).toEqual({ route: 'commit', project_id: 'repo', commit_id: 'abc123', has_reference: false });
    expect(page_view_of('/repo/sub/history/develop')).toEqual({ route: 'history_branch', project_id: 'repo/sub', has_reference: false });
    expect(page_view_of('/repo/sub')).toEqual({ route: 'project', project_id: 'repo/sub', has_reference: false });
  });

  it("names the app's own pages", () => {
    expect(page_view_of('/')).toEqual({ route: 'home', has_reference: false });
    expect(page_view_of('/admin/usage')).toMatchObject({ route: 'admin' });
    expect(page_view_of('/settings/tokens')).toMatchObject({ route: 'settings' });
    expect(page_view_of('/projects')).toMatchObject({ route: 'explore' });
    expect(page_view_of('/activity').project_id).toBeUndefined();
  });

  it('decodes names with special characters', () => {
    expect(page_view_of('/repo/commit/feature%2Fx').commit_id).toBe('feature/x');
  });
});


describe('PageViews', () => {
  beforeEach(() => {
    _resetUsageForTests();
    initUsage({ analytics_enabled: true });
  });
  afterEach(() => _resetUsageForTests());

  const events = () => _usageQueueForTests().map(e => ({ event: e.event, project_id: e.project_id, ...e.properties }));

  it('sends one event per page, not per selection change', () => {
    act(() => history.replace('/repo/sub/commit/abc123'));
    render(<HistoryRouter history={history}><PageViews/></HistoryRouter>);
    expect(events()).toEqual([{ event: 'page_view', route: 'commit', project_id: 'repo/sub', commit_id: 'abc123', has_reference: false }]);
    // picking a batch or a reference changes the query string: the same page
    act(() => history.replace('/repo/sub/commit/abc123?reference=def'));
    expect(events()).toHaveLength(1);
    // another commit: another page
    act(() => history.push('/repo/sub/commit/def456?reference=abc123'));
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ commit_id: 'def456', has_reference: true });
    act(() => history.push('/repo/sub/history'));
    expect(events()[2]).toMatchObject({ route: 'history', project_id: 'repo/sub' });
  });
});
