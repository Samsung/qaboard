/**
 * Runs activity: what waits and runs now, what ended recently, the batches that start soon, and marking runs as failed.
 * Run with: cd webapp && npm test -- activity/
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch } from '../../router';
import { matchAppRoute } from '../../routes';
import { ActivityPage, readFilters, activityUrl, commitUrl } from '../ActivityPage';
import { overviewQuery, keepIfSameWhose, refresh_interval } from '../api';
import { formatDuration } from '../format';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice' };

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname.replace(/\/$/, '')}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));
const lastParams = (fetch, method, path) => new URL(calls(fetch, method, path).at(-1)[0], 'http://localhost').searchParams;
const lastBody = (fetch, method, path) => JSON.parse(calls(fetch, method, path).at(-1)[1].body);

const renderAt = pathname => {
  act(() => history.replace(pathname));
  const { match } = matchAppRoute(pathname.split('?')[0]);
  return renderWithProviders(<HistoryRouter history={history}><RouteMatch match={match}><ActivityPage/></RouteMatch></HistoryRouter>, { user: alice });
};

const now = '2026-10-22T12:00:00Z';
const bars = Array.from({ length: 24 }, (_, i) => ({ at: `2026-10-21T${String(12 + i).padStart(2, '0')}:00:00Z`, waiting: i === 23 ? 2 : 0, running: 1, done: i % 6 === 0 ? 3 : 0, failed: i === 20 ? 1 : 0 }));
const overview = props => ({
  scope: 'me', me: 'alice', is_admin: false, now, window: '24h', since: '2026-10-21T12:00:00Z',
  totals: { waiting: 2, running: 3, done: 12, failed: 1, active_users: 1, active_projects: 1, active_batches: 2, active_since: '2026-10-20T12:00:00Z', long_active: 1 },
  timeline: { step_seconds: 3600, bars },
  starting_soon: [{ id: 's1', created_at: '2026-10-22T11:55:00Z', user: 'alice', runner: 'lsf', status: 'submitted', lsf_job_id: '4242', queue: 'gpu',
    batch_id: 9, batch_label: 'sweep', ci_commit_id: 3, hexsha: 'c'.repeat(40), branch: 'dev', project_id: 'isp/denoise', log_dir_url: '/s/logs/s1' }],
  projects: [{ key: 'isp/denoise', waiting: 2, running: 3, ended: 13, failed: 1 }],
  queues: [{ key: 'gpu', waiting: 2, running: 1, ended: 0, failed: 0 }],
  stuck: { older_than: '1week', runs: 0 },
  ...props,
});
const batch = props => ({
  key: 7, batch_id: 7, batch_label: 'tuning', project_id: 'isp/denoise', ci_commit_id: 3, hexsha: 'a'.repeat(40), branch: 'feature',
  runs: 6, waiting: 2, running: 3, done: 1, failed: 0, active_since: '2026-10-20T12:00:00Z', latest: '2026-10-22T11:59:00Z',
  nb_projects: 1, commits: 1, batches: 1, labels: ['tuning'], users: ['alice'], nb_users: 1, runners: ['lsf'], queues: ['gpu'],
  run_seconds: 1800, wait_seconds: 300, ...props,
});
const run = props => ({
  id: 100, status: 'running', batch_id: 7, batch_label: 'tuning', project_id: 'isp/denoise', hexsha: 'a'.repeat(40), branch: 'feature',
  input_path: 'night/scene1.dng', input_database: '/datasets', platform: 'linux', configurations: ['base'], extra_parameters: { iso: 800 },
  user_name: 'alice', job_options: { type: 'lsf', queue: 'gpu' }, queued_at: '2026-10-22T10:00:00Z', started_at: '2026-10-22T10:30:00Z',
  finished_at: null, created_date: '2026-10-22T10:00:00Z', output_dir_url: '/s/runs/1', failed_reason: null, ...props,
});
const routes = (props = {}) => ({
  'GET /api/v1/activity/overview': overview(props.overview),
  'GET /api/v1/activity/items': { items: [batch(), batch({ key: 8, batch_id: 8, batch_label: 'ci', waiting: 0, running: 0, done: 5, failed: 1, active_since: null })], total: 2, group: 'batch' },
  'GET /api/v1/activity/runs': { runs: [run(), run({ id: 101, status: 'waiting', started_at: null, input_path: 'night/scene2.dng' })], total: 2 },
  ...props.routes,
});

afterEach(() => vi.restoreAllMocks());


describe('Runs activity', () => {
  it('has its route, and keeps what it shows in the URL', () => {
    expect(matchAppRoute('/activity').match).toBeTruthy();
    expect(activityUrl({ scope: 'me', project: 'a/b', group: 'user', page: '' })).toBe('/activity?project=a%2Fb&group=user');
    expect(readFilters('?scope=all&window=7d').window).toBe('7d');
    expect(commitUrl({ project_id: 'a/b', hexsha: 'f00', batch_label: 'x y' }, { selected_views: 'logs' })).toBe('/a/b/commit/f00?batch=x+y&selected_views=logs');
    expect(formatDuration(3900)).toBe('1h 5min');
    expect(formatDuration(420)).toBe('7min');
    expect(formatDuration(9 * 86400)).toBe('9d');
  });

  it('sums up what runs, flags long runs, and filters by status', async () => {
    const fetch = mockApi(routes());
    renderAt('/activity');
    expect(await screen.findByTestId('total-running')).toHaveTextContent('3');
    expect(screen.getByTestId('total-running')).toHaveTextContent('1 run pending for over a day');
    expect(screen.getByTestId('total-waiting')).toHaveTextContent('2');
    expect(screen.getByTestId('total-ended')).toHaveTextContent('13');
    expect(screen.getByTestId('total-soon')).toHaveTextContent('1');
    expect(screen.getAllByTestId('timeline-bar')).toHaveLength(24);
    fireEvent.click(screen.getByTestId('total-failed'));
    await waitFor(() => expect(history.location.search).toBe('?status=failed'));
    await waitFor(() => expect(lastParams(fetch, 'GET', '/api/v1/activity/items').get('status')).toBe('failed'));
    // the overview counts every status
    expect(lastParams(fetch, 'GET', '/api/v1/activity/overview').get('status')).toBe(null);
  });

  it("shows the server's errors, and doesn't hide them behind a spinner when it refreshes", async () => {
    mockApi(routes({ routes: { 'GET /api/v1/activity/overview': () => [{ error: 'Something broke' }, 500] } }));
    renderAt('/activity');
    expect(await screen.findByText('Something broke')).toBeInTheDocument();
    // refreshing a query without data shows the spinner again: live pages stop refreshing after an error
    const query = overviewQuery({}, { live: true });
    expect(query.refetchInterval({ state: { status: 'error' } })).toBe(false);
    expect(query.refetchInterval({ state: { status: 'success' } })).toBe(refresh_interval);
    expect(overviewQuery({}, { live: false }).refetchInterval({ state: { status: 'success' } })).toBe(false);
  });

  it("shows the previous numbers while new ones load, but not someone else's", () => {
    const keep = keepIfSameWhose({ scope: 'all' });
    expect(keep('everyone', { queryKey: ['activity', 'overview', { scope: 'all' }, { window: '7d' }] })).toBe('everyone');
    expect(keep('mine', { queryKey: ['activity', 'overview', { scope: 'me' }, {}] })).toBe(undefined);
    expect(keep(undefined, undefined)).toBe(undefined);
  });

  it('groups runs by batch, and shows their runs with links', async () => {
    const fetch = mockApi(routes());
    renderAt('/activity?scope=all');
    const table = await screen.findByRole('table', { name: 'Batch' });
    const rows = within(table).getAllByTestId('activity-item');
    expect(rows[0]).toHaveTextContent('tuning');
    expect(rows[0]).toHaveTextContent('3 running');
    expect(rows[0]).toHaveTextContent('2 waiting');
    expect(rows[0]).toHaveTextContent('pending for 2d');
    expect(rows[0]).toHaveTextContent('waits 5min, runs 30min on average');
    expect(within(rows[0]).getByRole('link', { name: 'tuning' })).toHaveAttribute('href', `/isp/denoise/commit/${'a'.repeat(40)}?batch=tuning`);
    expect(rows[1]).toHaveTextContent('last ended');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Show the runs: Batch tuning' }));
    const runs = await screen.findAllByTestId('run');
    expect(lastParams(fetch, 'GET', '/api/v1/activity/runs').get('key')).toBe('7');
    expect(lastParams(fetch, 'GET', '/api/v1/activity/runs').get('scope')).toBe('all');
    expect(runs[0]).toHaveTextContent('night/scene1.dng');
    expect(runs[0]).toHaveTextContent('linux · base · {"iso":800}');
    expect(runs[0]).toHaveTextContent('lsf · queue gpu');
    expect(runs[0]).toHaveTextContent('Running for 1h 30min');
    expect(runs[0]).toHaveTextContent('waited 30min');
    expect(runs[1]).toHaveTextContent('Queued 2h ago');
    expect(within(runs[0]).getByRole('link', { name: 'Its log' })).toHaveAttribute('href', '/s/runs/1/log.txt');
    expect(within(runs[0]).getByRole('link', { name: 'night/scene1.dng' })).toHaveAttribute('href', `/isp/denoise/commit/${'a'.repeat(40)}?batch=tuning&filter=night%2Fscene1.dng`);
  });

  it('groups by anything, even job options', async () => {
    const fetch = mockApi(routes());
    renderAt('/activity');
    fireEvent.change(await screen.findByRole('combobox', { name: 'Group by' }), { target: { value: 'option' } });
    await waitFor(() => expect(history.location.search).toBe('?group=option'));
    expect(await screen.findByText('Which job option?')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Job option' }), { target: { value: 'project' } });
    await waitFor(() => expect(history.location.search).toBe('?group=option&option=project'), { timeout: 2000 });
    await waitFor(() => expect(lastParams(fetch, 'GET', '/api/v1/activity/items').get('option')).toBe('project'));
    expect(lastParams(fetch, 'GET', '/api/v1/activity/items').get('group')).toBe('option');
  });

  it('lists the batches that start soon, with their logs', async () => {
    mockApi(routes());
    renderAt('/activity');
    const row = await screen.findByTestId('starting-soon');
    expect(row).toHaveTextContent('sweep');
    expect(row).toHaveTextContent('job 4242');
    expect(within(row).getByRole('link', { name: 'Logs' })).toHaveAttribute('href', `/isp/denoise/commit/${'c'.repeat(40)}?batch=sweep&selected_views=logs`);
  });

  it('marks the runs of a batch as failed, after saying how many', async () => {
    const fetch = mockApi(routes({ routes: {
      'POST /api/v1/activity/fail': (url, init) => [JSON.parse(init.body).dry_run
        ? { runs: 5, batches: 1, projects: { 'isp/denoise': 5 }, dry_run: true }
        : { runs: 5, batches: 1, projects: { 'isp/denoise': 5 }, dry_run: false }, 200],
    } }));
    renderAt('/activity');
    const rows = await screen.findAllByTestId('activity-item');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Actions: Batch tuning' }));
    fireEvent.click(await screen.findByText('Mark waiting and running runs as failed…'));
    expect(await screen.findByTestId('fail-preview')).toHaveTextContent('5 runs waiting or running, in 1 batch, will be marked as failed.');
    expect(lastBody(fetch, 'POST', '/api/v1/activity/fail')).toMatchObject({ group: 'batch', key: 7, scope: 'me', dry_run: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark 5 runs as failed' }));
    await waitFor(() => expect(lastBody(fetch, 'POST', '/api/v1/activity/fail').dry_run).toBe(false));
  });

  it('stops a batch', async () => {
    const fetch = mockApi(routes({ routes: { 'POST /api/v1/batch/stop': {} } }));
    renderAt('/activity');
    const rows = await screen.findAllByTestId('activity-item');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Actions: Batch tuning' }));
    fireEvent.click(await screen.findByText('Stop the batch…'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop the batch' }));
    await waitFor(() => expect(lastBody(fetch, 'POST', '/api/v1/batch/stop')).toEqual({ id: 7 }));
  });

  it('tells admins about stuck runs, and offers to clean them up on a schedule', async () => {
    mockApi(routes({ overview: { is_admin: true, stuck: { older_than: '1week', runs: 12, schedule: null } } }));
    renderAt('/activity?scope=all');
    const stuck = await screen.findByTestId('stuck');
    expect(stuck).toHaveTextContent('12 runs pending for over a week');
    expect(stuck).toHaveTextContent('No schedule marks them as failed.');
    fireEvent.click(within(stuck).getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(history.location.search).toBe('?scope=all&status=active&sort=oldest'));
    fireEvent.click(within(screen.getByTestId('stuck')).getByRole('button', { name: 'Do it every night…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Job' })).toHaveValue('fail_stuck_runs');
    expect(within(dialog).getByLabelText('Pending for over')).toHaveValue('1week');
  });

  it('tells users how admins clean stuck runs up', async () => {
    mockApi(routes({ overview: { stuck: { older_than: '1week', runs: 2 } } }));
    renderAt('/activity');
    const stuck = await screen.findByTestId('stuck');
    expect(stuck).toHaveTextContent('Mark yours as failed from their menu');
    expect(within(stuck).queryByRole('button', { name: 'Mark them as failed…' })).toBeNull();
  });

  it("shows older runs from when they were created, and offers everyone's runs when yours are none", async () => {
    mockApi(routes({ routes: {
      'GET /api/v1/activity/items': { items: [], total: 0, group: 'batch' },
    } }));
    renderAt('/activity');
    fireEvent.click(await screen.findByRole('button', { name: "See everyone's runs" }));
    await waitFor(() => expect(history.location.search).toBe('?scope=all'));
  });

  it('says when older runs were created, since their end is unknown', async () => {
    mockApi(routes({ routes: {
      'GET /api/v1/activity/runs': { runs: [run({ status: 'done', started_at: null, queued_at: null, finished_at: '2026-10-22T09:00:00Z', created_date: '2026-10-22T09:00:00Z', estimated: true })], total: 1 },
    } }));
    renderAt('/activity?group=runs');
    expect(await screen.findByTestId('run')).toHaveTextContent('Created');
  });

  it('estimates when older runs ended from how long they computed', async () => {
    mockApi(routes({ routes: {
      'GET /api/v1/activity/runs': { runs: [run({ status: 'done', queued_at: null, started_at: '2026-10-22T09:00:00Z', finished_at: '2026-10-22T09:25:00Z', created_date: '2026-10-22T09:00:00Z', estimated: true })], total: 1 },
    } }));
    renderAt('/activity?group=runs');
    const row = await screen.findByTestId('run');
    expect(row).toHaveTextContent('Ended ~');
    expect(row).toHaveTextContent('ran 25min');
  });
});
