/**
 * Admin → Usage: the numbers, trends and leaderboards, and the usage cards of users (admin and their own).
 * Run with: cd webapp && npm test -- usage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';
import { DateTime } from 'luxon';

import { history } from '../../router';
import { matchAppRoute } from '../../routes';
import { Usage, UsageChart, paramsFor, readFilters, usageFigure, bucket_label } from '../Usage';
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

// Plotly doesn't run in jsdom: we check what would be plotted, a test id per trace. The real charts are in e2e/usage.spec.js
const plotly = vi.hoisted(() => ({ hover: vi.fn(), unhover: vi.fn() }));
vi.mock('../../components/Plot', () => ({
  default: ({ data, onInitialized }) => {
    onInitialized?.({}, plotly);
    return <div data-testid="plot">
      {data.map(trace => <span key={trace.meta} data-testid={`${trace.type === 'bar' ? 'bar' : 'line'}-${trace.meta}`} data-y={trace.y.join(',')}/>)}
    </div>;
  },
  hoverPlot: (gd, where) => gd.hover(where),
  unhoverPlot: gd => gd.unhover(),
}));

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
    expect(screen.getByTestId('line-web_users')).toHaveAttribute('data-y', '10,12,8');
    expect(screen.getByTestId('line-cli_users')).toHaveAttribute('data-y', '3,4,2');
    expect(screen.getByTestId('line-commits_viewed')).toHaveAttribute('data-y', '40,50,30');
    expect(screen.getByRole('img', { name: /Batches started and qa commands, per day/ })).toBeInTheDocument();
    expect(screen.getByTestId('bar-batches_started')).toHaveAttribute('data-y', '2,3,1');
    expect(screen.getByTestId('bar-cli_commands')).toHaveAttribute('data-y', '20,25,10');
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

  it("asks for the trends and the tables without waiting for the summary", async () => {
    // the summary is the slowest to compute: the rest shows up as it comes
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      const { pathname } = new URL(url, 'http://localhost');
      return pathname === '/api/v1/admin/usage/summary' ? new Promise(() => {}) : json(usage_api[`GET ${pathname}`] ?? {});
    });
    renderAt('/admin/usage', <Usage/>, { user: admin });
    expect(await screen.findByRole('link', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ISP team' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Active users and commits looked at/ })).toBeInTheDocument();
    // the summary is still loading
    expect(screen.getByLabelText('Loading the usage')).toBeInTheDocument();
    expect(screen.queryByText('Active users')).not.toBeInTheDocument();
  });

  it('says when nothing happened in the period', async () => {
    mockApi({ ...usage_api, 'GET /api/v1/admin/usage/timeseries': { buckets: timeseries.buckets.map(({ start }) => ({ start, web_users: 0, cli_users: 0, commits_viewed: 0, outputs_opened: 0, batches_started: 0, cli_commands: 0 })) } });
    renderAt('/admin/usage', <Usage/>, { user: admin });
    expect(await screen.findByText('No usage events in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Active users and commits looked at/ })).not.toBeInTheDocument();
  });

  it('says when the server refuses', async () => {
    mockApi({ 'GET /api/v1/admin/usage/summary': () => [{ error: 'Only admins can do this.', reason: 'not_admin' }, 403] });
    renderAt('/admin/usage', <Usage/>, { user: admin });
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
  });
});


describe('charts', () => {
  const series = [
    { key: 'web_users', label: 'Users in the web app', color: 'blue' },
    { key: 'cli_commands', label: 'qa commands', color: 'orange' },
  ];

  it('plots each series over the dates, with every value in the hover label', () => {
    const { data, layout } = usageFigure({ kind: 'line', buckets: timeseries.buckets, series, bucket: 'day' });
    expect(data.map(t => [t.type, t.name, t.meta])).toEqual([['scatter', 'Users in the web app', 'web_users'], ['scatter', 'qa commands', 'cli_commands']]);
    expect(data[0].x).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
    expect(data[1].y).toEqual([20, 25, 10]);
    expect(data[0].line.color).toBe('blue');
    expect(data[0].hovertemplate).toBe('<b>%{y:,}</b>  Users in the web app<extra></extra>');
    // one label for the date, with every series, wherever the pointer is
    expect(layout.hovermode).toBe('x unified');
    expect(layout.hoverdistance).toBe(-1);
    expect(layout.xaxis).toMatchObject({ type: 'date', hoverformat: '%a, %b %-d, %Y', showspikes: true });
    expect(layout.yaxis).toMatchObject({ rangemode: 'tozero' });
    // the y ticks: no 0.5 users
    expect(layout.yaxis.dtick).toBeUndefined();
    const few = usageFigure({ kind: 'line', buckets: [{ start: '2026-10-27', web_users: 2, cli_commands: 1 }], series, bucket: 'day' });
    expect(few.layout.yaxis.dtick).toBe(1);
  });

  it('draws bars side by side, by week over 12 months', () => {
    const buckets = Array.from({ length: 53 }, (_, i) => ({ start: DateTime.fromISO('2025-11-03', { zone: 'utc' }).plus({ weeks: i }).toISODate(), web_users: i, cli_commands: 2 * i }));
    const { data, layout } = usageFigure({ kind: 'bar', buckets, series, bucket: 'week' });
    expect(data.map(t => t.type)).toEqual(['bar', 'bar']);
    expect(data[1].marker.color).toBe('orange');
    expect(layout.xaxis.hoverformat).toBe('Week of %b %-d, %Y');
    expect(bucket_label('2025-11-03', 'week')).toBe('Week of Nov 3, 2025');
    expect(bucket_label('2026-10-27', 'day')).toBe('Tue, Oct 27, 2026');
    // lines are dots only over short periods
    expect(usageFigure({ kind: 'line', buckets, series, bucket: 'week' }).data[0].mode).toBe('lines');
  });

  it('reads the values with the arrow keys', () => {
    plotly.hover.mockClear();
    renderWithProviders(<UsageChart title="Users, per day" kind="line" buckets={timeseries.buckets} series={series} bucket="day"/>);
    const chart = screen.getByRole('img', { name: 'Users, per day' });
    expect(chart).toHaveAccessibleDescription(/arrow keys/);
    chart.focus();
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    // the hover label at that date, and the same for screen readers
    expect(plotly.hover).toHaveBeenLastCalledWith({ xval: Date.UTC(2026, 9, 27) });
    expect(screen.getByTestId('chart-reading')).toHaveTextContent('Tue, Oct 27, 2026: Users in the web app 10, qa commands 20');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(screen.getByTestId('chart-reading')).toHaveTextContent('Wed, Oct 28, 2026: Users in the web app 12, qa commands 25');
    fireEvent.keyDown(chart, { key: 'End' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(plotly.hover).toHaveBeenLastCalledWith({ xval: Date.UTC(2026, 9, 29) });
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByTestId('chart-reading')).toHaveTextContent(/^Tue, Oct 27/);
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(plotly.unhover).toHaveBeenCalled();
    expect(screen.getByTestId('chart-reading')).toHaveTextContent('');
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
    // email is set up in Admin → Settings → Email, single sign-on in Admin → Sign-in
    expect(screen.getByRole('link', { name: "Email notifications aren't configured" })).toHaveAttribute('href', '/admin/settings?group=email');
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
