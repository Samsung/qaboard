/**
 * Admin → Storage: starting jobs (hard deletes, old results), following them and their errors, schedules.
 * Run with: cd webapp && npm test -- storage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { app_routes, matchAppRoute } from '../../routes';
import { AdminPage } from '../AdminPage';
import { Storage } from '../Storage';
import { JobDetail } from '../JobDetail';
import { fromParams, toParams, validateParams, splitPatterns } from '../JobForm';
import { progressSummary, formatDuration } from '../jobs';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, options);
};

const job = props => ({
  id: 7, kind: 'hard_delete', kind_label: 'Hard-delete deleted runs', description: 'Hard-delete the deleted runs of *, created before 1month',
  params: { projects: ['*'], exclude_projects: [], created_before: '1month', created_after: null, dry_run: false }, dry_run: false,
  status: 'done', cancel_requested: false, progress: { runs_deleted: 1200, runs_without_files: 1000, runs_with_files: 200, runs_protected: 30, projects_done: 3, projects_total: 3 },
  error: null, created_at: '2026-10-20T10:00:00Z', created_by: 'root', schedule_id: null, started_at: '2026-10-20T10:00:01Z',
  finished_at: '2026-10-20T10:05:01Z', heartbeat_at: '2026-10-20T10:05:00Z', worker: 'backend-1:12', attempts: 1, log: [], ...props,
});
const worker = { online: [{ id: 'backend-1:12', seen_at: '2026-10-20T10:00:00Z' }], last_seen_at: '2026-10-20T10:00:00Z' };

afterEach(() => vi.restoreAllMocks());


describe('routes', () => {
  it('has a storage section and job pages', () => {
    expect(matchAppRoute('/admin/storage').match.params.section).toBe('storage');
    expect(matchAppRoute('/admin/storage/jobs/12')).toMatchObject({ route: { name: 'admin_job' }, match: { params: { job_id: '12' } } });
  });

  it('opens a job on the storage tab', async () => {
    mockApi({ 'GET /api/v1/admin/jobs/7': { ...job(), workers: worker } });
    const { match } = matchRoutes(app_routes, '/admin/storage/jobs/7');
    renderAt('/admin/storage/jobs/7', <RouteMatch match={match}><AdminPage/></RouteMatch>, { user: admin });
    expect(await screen.findByRole('heading', { name: '#7 Hard-delete deleted runs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Storage/, selected: true })).toBeInTheDocument();
  });
});


describe('Storage', () => {
  it('lists jobs and schedules, and says when no worker runs them', async () => {
    mockApi({
      'GET /api/v1/admin/jobs': { jobs: [job(), job({ id: 8, status: 'queued', dry_run: true, progress: {} })], next_before_id: null, workers: { online: [], last_seen_at: null } },
      'GET /api/v1/admin/job-schedules': { schedules: [{
        id: 1, name: 'Nightly purge', kind: 'hard_delete', description: 'Hard-delete the deleted runs of *', params: { dry_run: false },
        cron: '0 2 * * *', timezone: 'Asia/Jerusalem', enabled: true, next_run_at: '2026-10-21T23:00:00Z',
        last_job: job({ status: 'done_with_errors', progress: { errors: { permission: 3 } } }), last_message: 'Skipped: Job #8 is already queued',
      }] },
    });
    renderAt('/admin/storage', <Storage/>);
    expect(await screen.findByText('No worker is running jobs')).toBeInTheDocument();
    expect(screen.getByText(/Queued jobs will wait/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Jobs' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('1,200 runs deleted, 30 kept in milestones, 3/3 projects');
    expect(rows[2]).toHaveTextContent('Queued');
    expect(rows[2]).toHaveTextContent('dry run');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/admin/storage/jobs/7');

    const schedule = within(screen.getByRole('table', { name: 'Schedules' })).getAllByRole('row')[1];
    expect(schedule).toHaveTextContent('Nightly purge');
    expect(schedule).toHaveTextContent('0 2 * * *');
    expect(schedule).toHaveTextContent('Done with errors');
    expect(schedule).toHaveTextContent('Skipped: Job #8 is already queued');
  });

  it('sums up many schedules in a line, until asked', async () => {
    const schedule = (id, props) => ({
      id, name: `Schedule ${id}`, kind: 'hard_delete', description: 'Hard-delete the deleted runs of *', params: {}, cron: '0 2 * * *', timezone: 'UTC',
      enabled: true, next_run_at: `2026-10-2${id}T02:00:00Z`, last_job: job(), last_message: null, ...props,
    });
    mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [schedule(1, { enabled: false }), schedule(2, { last_job: job({ status: 'failed' }) }), schedule(3), schedule(4)] },
    });
    renderAt('/admin/storage', <Storage/>);
    const summary = await screen.findByTestId('schedules-summary');
    expect(summary).toHaveTextContent('3 of 4 enabled');
    expect(summary).toHaveTextContent('next: Schedule 2');
    expect(summary).toHaveTextContent('last run went wrong for 1');
    expect(screen.queryByRole('table', { name: 'Schedules' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the 4 schedules' }));
    expect(within(await screen.findByRole('table', { name: 'Schedules' })).getAllByRole('row')).toHaveLength(5);
  });

  it('lists the latest scans, and deletes what they found', async () => {
    const scan = id => ({ id, job_id: null, job: null, roots: ['/algo'], status: 'done', created_at: '2026-10-20T10:00:00Z', finished_at: '2026-10-20T11:00:00Z',
      min_bytes: 0, bytes: 1000, files: 10, errors: 0, by_kind: {}, untracked_bytes: 0 });
    const fetch = mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [] },
      'GET /api/v1/admin/scans': { scans: [{ ...scan(5), status: 'running', job: job({ id: 9, kind: 'scan_storage', status: 'running' }) }, scan(4), scan(3), scan(2), scan(1)] },
      'DELETE /api/v1/admin/scans/4': { deleted: 4 },
    });
    renderAt('/admin/storage', <Storage/>);
    const table = await screen.findByRole('table', { name: 'Scans' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('button', { name: 'Delete scan #5' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show the 2 older scans' }));
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    fireEvent.click(within(table).getByRole('button', { name: 'Delete scan #4' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the scan' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/scans/4')).toHaveLength(1));
  });

  it('starts a dry run of a hard delete, then shows it', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [] },
      'GET /api/v1/admin/jobs/projects': { total: 2, projects: ['group/a', 'group/b'] },
      'POST /api/v1/admin/jobs/estimate': { total: 5000, projects: { 'group/a': 4000, 'group/b': 1000 }, timeout: false },
      'POST /api/v1/admin/jobs': (url, init) => [job({ id: 9, status: 'queued', dry_run: JSON.parse(init.body).params.dry_run }), 201],
    });
    renderAt('/admin/storage', <Storage/>);
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
    expect(screen.getByTestId('workers')).toHaveTextContent('1 worker ready to run jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Start: Hard-delete deleted runs' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Projects'), { target: { value: 'group/*' } });
    fireEvent.change(dialog.getByLabelText('Except'), { target: { value: 'group/c, x*' } });
    expect(await dialog.findByText('2 projects')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Count the deleted runs' }));
    expect(await dialog.findByText('5,000')).toBeInTheDocument();
    // safe by default
    expect(dialog.getByRole('button', { name: 'Start the dry run' })).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Start the dry run' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs')).toHaveLength(2));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/jobs').at(-1)[1].body)).toEqual({
      kind: 'hard_delete',
      params: { projects: ['group/*'], exclude_projects: ['group/c', 'x*'], runs: 'deleted', created_before: '1month', dry_run: true },
    });
    await waitFor(() => expect(history.location.pathname).toBe('/admin/storage/jobs/9'));
  });

  it('purges runs whose files are gone, and deletes artifacts', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [] },
      'POST /api/v1/admin/jobs': (url, init) => [job({ id: 12, kind: JSON.parse(init.body).kind, status: 'queued' }), 201],
    });
    renderAt('/admin/storage', <Storage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Start: Purge runs whose files are gone' }));
    let dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('radio', { name: /Whose files are gone/ })).toBeChecked();
    expect(dialog.getByRole('button', { name: 'Count the runs to check' })).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Start the dry run' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/jobs')[0][1].body).params.runs).toBe('missing_files');

    act(() => history.replace('/admin/storage'));
    fireEvent.click(await screen.findByRole('button', { name: 'Start: Delete artifacts' }));
    dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Keep'), { target: { value: 'coverage_report, build/*.html' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Start the dry run' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs')).toHaveLength(2));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/jobs')[1][1].body)).toEqual({
      kind: 'delete_artifacts',
      params: { projects: ['*'], exclude_projects: [], older_than: '1month', keep: ['coverage_report', 'build/*.html'], can_delete_reference_branch: false, dry_run: true },
    });
  });

  it('warns before deleting for real, and shows why the server refuses', async () => {
    mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [] },
      'POST /api/v1/admin/jobs': () => [{ error: 'Job #3 (Hard-delete deleted runs) is already running: wait for it to finish, or cancel it.', job: job({ id: 3, status: 'running' }) }, 409],
    });
    renderAt('/admin/storage', <Storage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Start: Hard-delete deleted runs' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Runs created before'), { target: { value: 'soon' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /Dry run/ }));
    expect(dialog.getByText(/the runs will be deleted for good/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    expect(await dialog.findByText(/A date like 2026-01-31/)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Runs created before'), { target: { value: '2026-01-01' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    expect(await dialog.findByText(/is already running/)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'See job #3' })).toBeInTheDocument();
  });

  it('creates schedules', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs': { jobs: [], next_before_id: null, workers: worker },
      'GET /api/v1/admin/job-schedules': { schedules: [] },
      'GET /api/v1/admin/job-schedules/next-runs': { next_runs: ['2026-10-21T23:00:00Z'] },
      'POST /api/v1/admin/job-schedules': (url, init) => [{ id: 1, ...JSON.parse(init.body) }, 201],
    });
    renderAt('/admin/storage', <Storage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'New schedule' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Schedule' }));
    expect(await dialog.findByText(/Say what it's for/)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Old results' } });
    fireEvent.change(dialog.getByLabelText('Job'), { target: { value: 'garbage_collect' } });
    fireEvent.change(dialog.getByLabelText('Time zone'), { target: { value: 'UTC' } });
    expect(await dialog.findByText(/^Next:/)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('By default, older than'), { target: { value: '3months' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/job-schedules')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/job-schedules')[0][1].body)).toEqual({
      name: 'Old results', kind: 'garbage_collect', cron: '0 2 * * *', timezone: 'UTC', enabled: true,
      params: { projects: ['*'], exclude_projects: [], default_older_than: '3months', can_delete_reference_branch: false, delete_outputs: true, delete_artifacts: false, dry_run: false },
    });
  });
});


describe('JobDetail', () => {
  it('shows the progress, the errors grouped to fix them, and runs again', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs/7': { ...job({ status: 'done_with_errors', progress: { ...job().progress, runs_failed: 3, errors: { permission: 3 } }, log: [{ at: '2026-10-20T10:00:01Z', level: 'info', message: 'Starting: Hard-delete' }] }), workers: worker },
      'GET /api/v1/admin/jobs/7/errors': (url) => [{
        errors: [{ id: 1, kind: 'permission', path: '/algo/x/run/file.png', owner: 'alice', message: '[Errno 13] Permission denied', project_id: 'group/a', output_id: 12 }],
        total: new URL(url, 'http://localhost').searchParams.get('owner') ? 1 : 3,
        by_kind: [{ value: 'permission', count: 3 }], by_owner: [{ value: 'alice', count: 2 }, { value: 'bob', count: 1 }], by_project: [{ value: 'group/a', count: 3 }], not_saved: 0,
      }, 200],
      'POST /api/v1/admin/jobs/7/retry': () => [job({ id: 10, status: 'queued' }), 201],
    });
    renderAt('/admin/storage/jobs/7', <JobDetail id="7"/>);
    expect(await screen.findByText('Done with errors')).toBeInTheDocument();
    expect(screen.getByText('Runs deleted').previousSibling).toHaveTextContent('1,200');
    expect(screen.getByText('Runs kept because of errors').previousSibling).toHaveTextContent('3');
    expect(await screen.findByText('/algo/x/run/file.png')).toBeInTheDocument();
    expect(screen.getByText(/The server could not delete files/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download all/ })).toHaveAttribute('href', '/api/v1/admin/jobs/7/errors.csv');
    expect(screen.getByText('Starting: Hard-delete')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'alice' }));
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/admin/jobs/7/errors').at(-1)[0]).toContain('owner=alice'));

    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(history.location.pathname).toBe('/admin/storage/jobs/10'));
  });

  it('stops jobs stuck cancelling without waiting for their worker', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs/7': { ...job({ status: 'running', finished_at: null, cancel_requested: true }), workers: worker },
      'POST /api/v1/admin/jobs/7/cancel': job({ status: 'cancelled' }),
    });
    renderAt('/admin/storage/jobs/7', <JobDetail id="7"/>);
    expect(await screen.findByText(/its worker is stuck/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop without waiting' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs/7/cancel')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/jobs/7/cancel')[0][1].body)).toEqual({ force: true });
  });

  it('cancels running jobs, and runs dry runs for real', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/jobs/7': { ...job({ status: 'running', finished_at: null }), workers: worker },
      'POST /api/v1/admin/jobs/7/cancel': job({ status: 'running', cancel_requested: true }),
    });
    renderAt('/admin/storage/jobs/7', <JobDetail id="7"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs/7/cancel')).toHaveLength(1));
    vi.restoreAllMocks();

    const fetch2 = mockApi({
      'GET /api/v1/admin/jobs/8': { ...job({ id: 8, dry_run: true }), workers: worker },
      'POST /api/v1/admin/jobs/8/retry': () => [job({ id: 11, status: 'queued' }), 201],
    });
    renderAt('/admin/storage/jobs/8', <JobDetail id="8"/>);
    expect(await screen.findByText('Runs to delete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run it for real' }));
    await waitFor(() => expect(calls(fetch2, 'POST', '/api/v1/admin/jobs/8/retry')).toHaveLength(1));
    expect(JSON.parse(calls(fetch2, 'POST', '/api/v1/admin/jobs/8/retry')[0][1].body)).toEqual({ dry_run: false });
  });
});


describe('job forms', () => {
  it('converts parameters both ways', () => {
    expect(splitPatterns(' a*, b\nc ,')).toEqual(['a*', 'b', 'c']);
    const form = fromParams('hard_delete', { projects: ['a*', 'b'], created_before: null, dry_run: false });
    expect(form).toEqual({ projects: 'a*, b', exclude_projects: '', runs: 'deleted', created_before: '', created_after: '', dry_run: false });
    expect(toParams('hard_delete', form)).toEqual({ projects: ['a*', 'b'], exclude_projects: [], runs: 'deleted', dry_run: false });
    expect(toParams('delete_artifacts', fromParams('delete_artifacts', { keep: ['coverage', 'build/*.html'] }))).toEqual({
      projects: ['*'], exclude_projects: [], older_than: '1month', keep: ['coverage', 'build/*.html'], can_delete_reference_branch: false, dry_run: true,
    });
    expect(Object.keys(validateParams('delete_artifacts', { ...fromParams('delete_artifacts'), older_than: '' }))).toEqual(['older_than']);
  });

  it('checks the dates, durations and projects', () => {
    expect(validateParams('hard_delete', fromParams('hard_delete'))).toEqual({});
    expect(validateParams('hard_delete', { ...fromParams('hard_delete'), created_before: '2026-01-31', created_after: '2 weeks' })).toEqual({});
    expect(Object.keys(validateParams('hard_delete', { ...fromParams('hard_delete'), projects: ' ', created_after: 'yesterday' }))).toEqual(['projects', 'created_after']);
    expect(Object.keys(validateParams('garbage_collect', { ...fromParams('garbage_collect'), older_than: '1week' }))).toEqual(['older_than']);
    expect(validateParams('garbage_collect', { ...fromParams('garbage_collect'), projects: 'a*', older_than: '1week' })).toEqual({});
  });

  it('summarizes progress', () => {
    expect(progressSummary(job({ dry_run: true, progress: { runs_deleted: 1, projects_total: 2, projects_done: 1 } }))).toBe('1 run to delete, 1/2 projects');
    expect(progressSummary(job({ kind: 'garbage_collect', progress: { outputs: 10, artifacts: 2 } }))).toBe('10 runs cleaned, artifacts of 2 commits');
    expect(progressSummary(job({ kind: 'delete_artifacts', progress: { commits_deleted: 3, artifacts_files: 40 } }))).toBe('artifacts of 3 commits deleted, 40 files');
    expect(formatDuration(3725)).toBe('1h 2min');
    expect(formatDuration(42)).toBe('42s');
  });
});
