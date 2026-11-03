/**
 * Admin → Usage: the numbers, trends and leaderboards, and the usage cards of users (admin and their own).
 * Run with: cd webapp && npm test -- usage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';
import { DateTime } from 'luxon';

import { history } from '../../router';
import { matchAppRoute } from '../../routes';
import { Usage, paramsFor, readFilters } from '../Usage';
import { Overview } from '../Overview';
import { UserDetail } from '../UserDetail';
import { ActivityTab } from '../../settings/ActivityTab';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Answers by "METHOD /path"
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const urls = (fetch, path) => fetch.mock.calls.map(([url]) => url).filter(url => url.startsWith(path));

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, options);
};

afterEach(() => vi.restoreAllMocks());

const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };

const summary = {
  since: '2026-10-05', until: '2026-11-03',
  counts: { users: 42, web_users: 40, cli_users: 12, new_users: 3, unverified_cli_users: 2, commits_viewed: 318, comparisons: 77, outputs_opened: 1204, image_viewer_uses: 96, batches_started: 25, batches_started_by_kind: { tuning: 10, automated_tuning: 2, run_tests: 5, redo: 3, cli: 5 }, cli_commands: 140, exports: 4, milestones: 6, ci_runs: 9000 },
  previous_counts: { users: 38, web_users: 36, cli_users: 9, new_users: 1, commits_viewed: 290, comparisons: 60, outputs_opened: 1000, image_viewer_uses: 80, batches_started: 20, cli_commands: 120, exports: 2, milestones: 4, ci_runs: 8000 },
};
const timeseries = { buckets: [
  { start: '2026-10-27', web_users: 10, cli_users: 3, commits_viewed: 40, outputs_opened: 100, batches_started: 2, cli_commands: 20 },
  { start: '2026-10-28', web_users: 12, cli_users: 4, commits_viewed: 50, outputs_opened: 120, batches_started: 3, cli_commands: 25 },
  { start: '2026-10-29', web_users: 8, cli_users: 2, commits_viewed: 30, outputs_opened: 90, batches_started: 1, cli_commands: 10 },
] };
const users = { users: [
  { user_id: 2, user_name: 'alice', full_name: 'Alice', verified: true, active_days: 20, web_events: 900, cli_commands: 50, commits_viewed: 120, batches_started: 10, last_seen_at: '2026-11-03T09:00:00Z', projects: ['isp/hdr', 'isp/denoise'] },
  { user_id: null, user_name: 'bob', full_name: null, verified: false, active_days: 5, web_events: 0, cli_commands: 30, commits_viewed: 0, batches_started: 4, last_seen_at: '2026-11-01T09:00:00Z', projects: ['isp/hdr'] },
] };
const groups = { groups: [{ group_id: 7, name: 'ISP team', members: 10, active_members: 8, active_days: 60, commits_viewed: 200, batches_started: 15, cli_commands: 90 }] };
const projects = { projects: [
  { project_id: 'isp/hdr', product: 'isp', people: 12, commits_viewed: 200, outputs_opened: 800, batches_started: 20, cli_commands: 100, ci_runs: 5000, status: 'active' },
  { project_id: 'isp/legacy', product: 'isp', people: 0, commits_viewed: 0, outputs_opened: 0, batches_started: 0, cli_commands: 0, ci_runs: 4000, status: 'ci_only' },
] };
const usage_api = {
  'GET /api/v1/admin/usage/summary': summary,
  'GET /api/v1/admin/usage/timeseries': timeseries,
  'GET /api/v1/admin/usage/users': users,
  'GET /api/v1/admin/usage/groups': groups,
  'GET /api/v1/admin/usage/projects': projects,
};


describe('filters', () => {
  it('has a URL on the admin page', () => {
    expect(matchAppRoute('/admin/usage')?.match.params.section).toBe('usage');
  });

  it('reads the period and the project from the URL, and asks for the last N days', () => {
    expect(readFilters('')).toEqual({ period: '30d', project: '' });
    expect(readFilters('?period=7d&project=isp')).toEqual({ period: '7d', project: 'isp' });
    expect(readFilters('?period=nope')).toEqual({ period: '30d', project: '' });
    const now = DateTime.fromISO('2026-11-03T12:00:00');
    expect(paramsFor({ period: '7d', project: '' }, now)).toEqual({ since: '2026-10-28', until: '2026-11-03', project: undefined, bucket: 'day' });
    expect(paramsFor({ period: '12m', project: 'isp' }, now)).toEqual({ since: '2025-11-04', until: '2026-11-03', project: 'isp', bucket: 'week' });
  });
});


describe('Usage', () => {
  it('shows the numbers, the trends and the leaderboards', async () => {
    const fetch = mockApi(usage_api);
    renderAt('/admin/usage', <Usage/>, { user: admin });
    expect(await screen.findByText('Active users')).toBeInTheDocument();
    const people = screen.getByRole('region', { name: 'People' });
    expect(within(people).getByText('42')).toBeInTheDocument();
    // the period before
    expect(within(people).getByText('vs 38')).toBeInTheDocument();
    expect(screen.getByText('10 tuning, 2 automated tuning, 5 run tests, 3 redo, 5 qa batch')).toBeInTheDocument();
    // the charts
    expect(await screen.findByRole('img', { name: /Active users and commits looked at/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('line-web_users')).toHaveLength(1);
    expect(screen.getAllByTestId('bar-cli_commands')).toHaveLength(3);
    // the leaderboards link to the users, groups and projects
    expect(await screen.findByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/admin/users/2');
    expect(screen.getByText('unverified')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ISP team' })).toHaveAttribute('href', '/admin/groups/7');
    expect(screen.getByRole('link', { name: 'isp/legacy' })).toHaveAttribute('href', '/isp/legacy');
    expect(screen.getByText('CI only')).toBeInTheDocument();
    // CSV exports of each table
    const csv = screen.getAllByText('CSV').map(el => el.closest('a').getAttribute('href'));
    expect(csv).toHaveLength(3);
    expect(csv[0]).toMatch(/^\/api\/v1\/admin\/usage\/users\?since=\d{4}-\d{2}-\d{2}&until=\d{4}-\d{2}-\d{2}&format=csv$/);
    // the default period: 30 days, by day
    expect(urls(fetch, '/api/v1/admin/usage/timeseries')[0]).toMatch(/bucket=day$/);
  });

  it('changes the period and the project filter in the URL, and asks the server again', async () => {
    const fetch = mockApi(usage_api);
    renderAt('/admin/usage', <Usage/>, { user: admin });
    await screen.findByText('Active users');
    fireEvent.click(screen.getByRole('button', { name: '12 months' }));
    expect(history.location.search).toBe('?period=12m');
    await waitFor(() => expect(urls(fetch, '/api/v1/admin/usage/timeseries').at(-1)).toMatch(/bucket=week$/));
    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'isp' } });
    await waitFor(() => expect(history.location.search).toBe('?period=12m&project=isp'));
    await waitFor(() => expect(urls(fetch, '/api/v1/admin/usage/summary').at(-1)).toMatch(/project=isp/));
  });

  it('says when the server refuses', async () => {
    mockApi({ 'GET /api/v1/admin/usage/summary': () => [{ error: 'Only admins can do this.', reason: 'not_admin' }, 403] });
    renderAt('/admin/usage', <Usage/>, { user: admin });
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
  });
});


describe('Overview', () => {
  it('lists what to configure or look at to get more from QA-Board', async () => {
    mockApi({ 'GET /api/v1/admin/overview': {
      counts: { users: 12, active_30d: 8, admins: 1, pending: 0, disabled: 1, active_tokens: 5 },
      checklist: [{ id: 'https', ok: true, severity: 'info', title: 'Cookies are only sent over HTTPS', detail: null }],
      value_checklist: [
        { id: 'email_notifications', ok: false, severity: 'info', title: "Email notifications aren't configured", detail: 'Set the SMTP settings: users get an email when their batches end.' },
        { id: 'single_sign_on', ok: false, severity: 'info', title: 'Users sign in with local accounts', detail: 'Add a single sign-on provider.' },
        { id: 'ci_only_projects', ok: false, severity: 'warning', title: '3 projects get CI runs nobody looks at', detail: 'See Usage.', link: '/admin/usage?period=90d' },
        { id: 'sentry', ok: true, severity: 'info', title: 'Errors are reported to Sentry', detail: null },
      ],
    } });
    renderAt('/admin', <Overview/>, { user: admin });
    expect(await screen.findByText('Get more from QA-Board')).toBeInTheDocument();
    expect(screen.getByText('3 to look at')).toBeInTheDocument();
    expect(screen.getByText('All good')).toBeInTheDocument();
    // where to go: by id, or as the item says
    // email notifications are a server variable: no link. Single sign-on is set up in Admin → Sign-in
    expect(screen.queryByRole('link', { name: "Email notifications aren't configured" })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users sign in with local accounts' })).toHaveAttribute('href', '/admin/sign-in');
    expect(screen.getByRole('link', { name: '3 projects get CI runs nobody looks at' })).toHaveAttribute('href', '/admin/usage?period=90d');
  });
});


const usage_of_user = {
  since: '2026-10-05', until: '2026-11-03', total: 230, active_days: 14, first_seen_at: '2026-10-06T08:00:00Z', last_seen_at: '2026-11-03T09:00:00Z',
  by_event: [{ event: 'page_view', count: 150 }, { event: 'output_open', count: 60 }, { event: 'cli_command', count: 20 }],
  by_project: [{ project_id: 'isp/hdr', count: 200 }, { project_id: 'isp/denoise', count: 30 }],
};

describe('usage cards', () => {
  it("shows a user's usage on their admin page", async () => {
    mockApi({
      'GET /api/v1/admin/users/2': { user: { id: 2, user_name: 'alice', full_name: 'Alice', status: 'active', kind: 'human', is_admin: false, active_tokens: 0 }, tokens: [], audit: [] },
      'GET /api/v1/admin/usage/users/2': usage_of_user,
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>, { user: admin });
    const card = await screen.findByRole('region', { name: 'Usage, last 30 days' });
    expect(await within(card).findByText('14')).toBeInTheDocument();
    expect(within(card).getByText('Pages viewed')).toBeInTheDocument();
    expect(within(card).getByText('qa commands')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'isp/hdr' })).toHaveAttribute('href', '/isp/hdr');
  });

  it('shows users their own usage in Settings → Activity, and says admins see it too', async () => {
    mockApi({
      'GET /api/v1/user/usage': usage_of_user,
      'GET /api/v1/user/audit': { events: [], next_before_id: null },
    });
    renderAt('/settings/activity', <ActivityTab user={{ user_id: 2 }}/>, { user: { ...admin, is_admin: false, user_id: 2 } });
    const card = await screen.findByRole('region', { name: 'Your usage, last 30 days' });
    expect(within(card).getByText(/Admins see these numbers too/)).toBeInTheDocument();
    expect(await within(card).findByText('230')).toBeInTheDocument();
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });

  it('says when there is nothing yet', async () => {
    mockApi({ 'GET /api/v1/user/usage': { ...usage_of_user, total: 0, active_days: 0, by_event: [], by_project: [] }, 'GET /api/v1/user/audit': { events: [], next_before_id: null } });
    renderAt('/settings/activity', <ActivityTab user={{ user_id: 2 }}/>, { user: { ...admin, user_id: 2 } });
    expect(await screen.findByText('Nothing in the last 30 days.')).toBeInTheDocument();
  });
});
