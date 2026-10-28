/**
 * Storage usage: users' usage by project, batch, commit, branch and folder, deleting their runs' files.
 * Run with: cd webapp && npm test -- storage/
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch } from '../../router';
import { matchAppRoute } from '../../routes';
import { StoragePage, readFilters, storageUrl } from '../StoragePage';
import { formatBytes } from '../format';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice' };
const GB = 1000 ** 3;

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));
const lastBody = (fetch, method, path) => JSON.parse(calls(fetch, method, path).at(-1)[1].body);

const renderAt = pathname => {
  act(() => history.replace(pathname));
  const { match } = matchAppRoute(pathname.split('?')[0]);
  return renderWithProviders(<HistoryRouter history={history}><RouteMatch match={match}><StoragePage/></RouteMatch></HistoryRouter>, { user: alice });
};

const overview = {
  updated_at: '2026-10-22T09:00:00Z', building: null, scope: 'me', me: 'alice', can_delete_others: false,
  totals: { bytes: 39 * GB, runs: 6, batches: 3, commits: 2, projects: 2 },
  projects: [
    { project_id: 'proj/a', bytes: 35 * GB, runs: 4, batches: 2, commits: 1, last_run_at: '2026-07-01T00:00:00Z' },
    { project_id: 'proj/b', bytes: 4 * GB, runs: 2, batches: 1, commits: 1, last_run_at: '2026-07-01T00:00:00Z' },
  ],
  top_folders: [{ path: '/algo/proj/outputs/alice', bytes: 39 * GB, runs: 6 }],
};
const batch = props => ({
  key: 1, batch_id: 1, project_id: 'proj/a', ci_commit_id: 10, hexsha: 'a'.repeat(40), branch: 'feature', batch_label: 'big',
  folder: '/algo/proj/outputs/alice/a/big', bytes: 30 * GB, runs: 3, last_run_at: '2026-07-01T00:00:00Z', partial: false,
  users: ['alice'], nb_users: 1, milestone: false, ...props,
});
const items = { items: [batch(), batch({ key: 2, batch_id: 2, batch_label: 'saved', bytes: 5 * GB, milestone: true })], total: 2, totals: { bytes: 35 * GB, runs: 4 }, group: 'batch' };
const preview = props => ({
  owner: 'alice', folder: null, runs: 3, bytes: 30 * GB, batches: 1, commits: 1, projects: [{ project_id: 'proj/a', bytes: 30 * GB }],
  partial_batches: 0, kept: { milestones: { runs: 0, bytes: 0, batches: 0 }, others: { runs: 1, bytes: GB, batches: 1, users: ['bob'] } },
  confirm_phrase: null, ...props,
});

afterEach(() => vi.restoreAllMocks());


describe('Storage usage', () => {
  it('has its route, and keeps what it shows in the URL', () => {
    expect(matchAppRoute('/storage/folders').match.params.view).toBe('folders');
    expect(storageUrl('batches', { scope: 'me', project: 'proj/a', page: '' })).toBe('/storage/batches?project=proj%2Fa');
    expect(readFilters('?scope=all&folder=/x').folder).toBe('/x');
    expect(formatBytes(1234567890)).toBe('1.2 GB');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('shows your usage by project, and opens a project', async () => {
    mockApi({ 'GET /api/v1/storage/overview': overview, 'GET /api/v1/storage/items': items, 'GET /api/v1/storage/jobs': { jobs: [] } });
    renderAt('/storage');
    expect(await screen.findByTestId('total')).toHaveTextContent('39.0 GB');
    const rows = within(screen.getByRole('table', { name: 'Projects' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('proj/a');
    expect(rows[1]).toHaveTextContent('35.0 GB');
    fireEvent.click(within(rows[1]).getByRole('link', { name: 'proj/a' }));
    await waitFor(() => expect(history.location.pathname).toBe('/storage/batches'));
    expect(history.location.search).toBe('?project=proj%2Fa');
  });

  it("shows the commits' message, author and date, and filters by project, branch or user in a click", async () => {
    const commit = { message: 'Tune the AWB', details: 'Tune the AWB\n\nWith more tests', author: 'Alice Doe', authored_at: '2026-06-30T00:00:00Z' };
    const fetch = mockApi({
      'GET /api/v1/storage/overview': { ...overview, scope: 'all', users: [{ user_name: 'alice', bytes: 30 * GB, runs: 3 }, { user_name: 'bob', bytes: 5 * GB, runs: 1 }] },
      'GET /api/v1/storage/items': { ...items, items: [batch({ commit, users: ['alice', 'bob'], nb_users: 2 })], total: 1 },
      'GET /api/v1/storage/jobs': { jobs: [] },
    });
    renderAt('/storage/batches?scope=all');
    const [row] = within(await screen.findByRole('table', { name: 'Batches' })).getAllByTestId('storage-item');
    expect(within(row).getByText('Tune the AWB')).toHaveAttribute('title', commit.details);
    expect(row).toHaveTextContent('Alice Doe');
    fireEvent.click(within(row).getByRole('button', { name: 'feature' }));
    await waitFor(() => expect(history.location.search).toBe('?scope=all&branch=feature'));
    fireEvent.click(within(row).getByRole('button', { name: 'proj/a' }));
    await waitFor(() => expect(history.location.search).toBe('?scope=all&project=proj%2Fa&branch=feature'));
    fireEvent.click(within(row).getByRole('button', { name: 'bob' }));
    await waitFor(() => expect(history.location.search).toBe('?scope=user&user=bob&project=proj%2Fa&branch=feature'));
    // clicking the row selects it
    fireEvent.click(within(row).getByText('3'));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('1 batch selected');
    expect(calls(fetch, 'GET', '/api/v1/storage/items').length).toBeGreaterThan(0);
  });

  it('cuts long project names in the summary', async () => {
    const long = 'group/team/some/very/long/path/to/tests/products/the-project';
    mockApi({
      'GET /api/v1/storage/overview': { ...overview, projects: [{ ...overview.projects[0], project_id: long }, overview.projects[1]] },
      'GET /api/v1/storage/jobs': { jobs: [] },
    });
    renderAt('/storage');
    const link = within(await screen.findByTestId('projects-total')).getByRole('link', { name: long });
    expect(link.parentElement).toHaveAttribute('title', long);
    expect(link.parentElement).toHaveStyle({ textOverflow: 'ellipsis' });
  });

  it('ranks who uses the most, and opens their runs', async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': { ...overview, scope: 'all' },
      'GET /api/v1/storage/users': {
        users: [
          { user_name: 'bob', bytes: 30 * GB, runs: 10, batches: 4, commits: 2, projects: 2, last_run_at: '2026-07-01T00:00:00Z', top_project: { project_id: 'proj/a', bytes: 25 * GB } },
          { user_name: 'alice', bytes: 10 * GB, runs: 3, batches: 1, commits: 1, projects: 1, last_run_at: '2026-07-01T00:00:00Z', top_project: { project_id: 'proj/b', bytes: 10 * GB } },
        ],
        total: 2, totals: { bytes: 40 * GB, runs: 13 }, me: 'alice', can_delete_others: false,
      },
      'GET /api/v1/storage/items': items,
      'GET /api/v1/storage/jobs': { jobs: [] },
    });
    renderAt('/storage/users?project=proj/a');
    const rows = within(await screen.findByRole('table', { name: 'Users' })).getAllByTestId('storage-user');
    expect(rows[0]).toHaveTextContent('bob');
    expect(rows[0]).toHaveTextContent('75%');
    expect(rows[1]).toHaveTextContent('you');
    expect(new URL(calls(fetch, 'GET', '/api/v1/storage/users').at(-1)[0], 'http://localhost').searchParams.get('project')).toBe('proj/a');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find someone' }), { target: { value: 'ali' } });
    expect(screen.getAllByTestId('storage-user')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Their runs' }));
    await waitFor(() => expect(history.location.pathname).toBe('/storage/batches'));
    expect(history.location.search).toBe('?scope=user&user=alice&project=proj%2Fa');
  });

  it("selects batches, keeps milestones, and deletes after a preview", async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/items': items,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'POST /api/v1/storage/preview': preview(),
      'POST /api/v1/storage/delete': () => [{ job: { id: 5, status: 'queued' }, preview: preview() }, 201],
    });
    renderAt('/storage/batches?project=proj/a');
    const table = await screen.findByRole('table', { name: 'Batches' });
    const rows = within(table).getAllByTestId('storage-item');
    expect(within(rows[1]).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(rows[1]).getByText('Milestone')).toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByRole('checkbox'));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(bar).toHaveTextContent('1 batch selected · 30.0 GB');
    fireEvent.click(within(bar).getByRole('button', { name: 'Delete the files…' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByTestId('freed')).toHaveTextContent('30.0 GB');
    expect(dialog.getByText(/Other people's runs/)).toBeInTheDocument();
    expect(lastBody(fetch, 'POST', '/api/v1/storage/preview')).toEqual({ group: 'batch', keys: [1], scope: 'me', filters: { project: 'proj/a' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Delete the files of 3 runs' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/storage/delete')).toHaveLength(1));
    expect(lastBody(fetch, 'POST', '/api/v1/storage/delete').keys).toEqual([1]);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument());
  });

  it('asks to type a confirmation for big deletions', async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/items': { ...items, total: 120 },
      'GET /api/v1/storage/jobs': { jobs: [] },
      'POST /api/v1/storage/preview': preview({ confirm_phrase: 'delete 120 batches', batches: 120 }),
      'POST /api/v1/storage/delete': () => [{ job: { id: 5 } }, 201],
    });
    renderAt('/storage/batches?project=proj/a');
    await screen.findByRole('table', { name: 'Batches' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select this page' }));
    fireEvent.click(screen.getByRole('button', { name: /Select all 120/ }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('120 batches selected · 35.0 GB');
    fireEvent.click(screen.getByRole('button', { name: 'Delete the files…' }));
    const dialog = within(await screen.findByRole('dialog'));
    const button = await dialog.findByRole('button', { name: 'Delete the files of 3 runs' });
    expect(button).toBeDisabled();
    fireEvent.change(dialog.getByLabelText(/type/), { target: { value: 'Delete 120 batches' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/storage/delete')).toHaveLength(1));
    // everything that matches: no keys
    expect(lastBody(fetch, 'POST', '/api/v1/storage/delete')).toEqual({ group: 'batch', scope: 'me', filters: { project: 'proj/a' }, confirm: 'Delete 120 batches' });
  });

  it('starts the folders where the runs are, and skips folders that only lead to one', async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/folders': url => {
        const path = new URL(url, 'http://localhost').searchParams.get('path');
        const empty = { bytes: 0, runs: 0, batches: 0 };
        return [path === '/'
          ? { path: '/', skipped: false, children: [{ name: 'algo/proj/outputs/alice', path: '/algo/proj/outputs/alice', bytes: 39 * GB, runs: 6, batches: 3 }], here: empty, partial: empty }
          : { path: '/algo/proj/outputs/alice', skipped: true, children: [{ name: 'a/b/c', path: '/algo/proj/outputs/alice/a/b/c', bytes: 39 * GB, runs: 6, batches: 3 }], here: empty, partial: empty }, 200];
      },
    });
    renderAt('/storage/folders');
    expect(await screen.findByText('Started where the runs are')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'a/b/c' });
    expect(link).toHaveAttribute('href', '/storage/folders?path=%2Falgo%2Fproj%2Foutputs%2Falice%2Fa%2Fb%2Fc');
    expect(new URL(calls(fetch, 'GET', '/api/v1/storage/folders')[0][0], 'http://localhost').searchParams.get('path')).toBe(null);
    // the breadcrumbs' root is "/" itself, not where the runs start
    act(() => history.push('/storage/folders?path=%2F'));
    expect(await screen.findByRole('link', { name: 'algo/proj/outputs/alice' })).toBeInTheDocument();
    expect(screen.queryByText('Started where the runs are')).not.toBeInTheDocument();
  });

  it('says when a project is selected, and shows all projects', async () => {
    mockApi({ 'GET /api/v1/storage/overview': { ...overview, projects: [overview.projects[0]] }, 'GET /api/v1/storage/jobs': { jobs: [] } });
    renderAt('/storage/projects?project=proj/a');
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(table.parentElement).toHaveTextContent('Only proj/a is shown.');
    expect(screen.getByRole('button', { name: 'All projects' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all projects' }));
    await waitFor(() => expect(history.location.search).toBe(''));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'All projects' })).not.toBeInTheDocument());
  });

  it("hides other people's usage from who can't see it", async () => {
    mockApi({
      'GET /api/v1/storage/overview': { ...overview, can_see_others: 'none' },
      'GET /api/v1/storage/users': { can_see_others: 'none', users: [], total: 0, totals: { bytes: 0 }, me: 'alice' },
      'GET /api/v1/storage/jobs': { jobs: [] },
    });
    renderAt('/storage/users');
    expect(await screen.findByText('Only your own usage')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Whose runs' })).not.toBeInTheDocument();
    expect(screen.queryByText("Everyone's")).not.toBeInTheDocument();
  });

  it('finds the runs in a folder from a quota alert', async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/folders': url => {
        const path = new URL(url, 'http://localhost').searchParams.get('path');
        return [path
          ? { path, children: [{ name: 'a', path: `${path}/a`, bytes: 30 * GB, runs: 3, batches: 1 }], here: { bytes: 0, runs: 0, batches: 0 }, partial: { bytes: 0, runs: 0, batches: 0 } }
          : { path: '/', children: [{ name: 'algo', path: '/algo', bytes: 39 * GB, runs: 6, batches: 3 }], here: { bytes: 0, runs: 0, batches: 0 }, partial: { bytes: 0, runs: 0, batches: 0 } }, 200];
      },
      'POST /api/v1/storage/preview': preview({ folder: '/algo/proj/outputs/alice' }),
    });
    renderAt('/storage/folders');
    fireEvent.click(await screen.findByText('/algo/proj/outputs/alice'));
    await waitFor(() => expect(history.location.search).toBe('?path=%2Falgo%2Fproj%2Foutputs%2Falice'));
    expect(await screen.findByText('known to QA-Board here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete the files of these runs…' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/storage/preview')).toHaveLength(1));
    expect(lastBody(fetch, 'POST', '/api/v1/storage/preview')).toEqual({ group: 'batch', scope: 'me', filters: { folder: '/algo/proj/outputs/alice' } });
  });

  it('shows the deletions in progress, and explains quota differences', async () => {
    mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [{ id: 5, kind: 'delete_runs', status: 'running', created_at: new Date().toISOString(), params: { description: '1 batch (30.0 GB)' }, progress: { runs_deleted: 2, bytes_deleted: 20 * GB, batches_done: 0, batches_total: 1, errors: { permission: 1 } } }] },
    });
    renderAt('/storage');
    const deletion = await screen.findByTestId('deletion-5');
    expect(deletion).toHaveTextContent('20.0 GB freed, 2 runs deleted');
    expect(within(deletion).getByRole('button', { name: /1 error/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Why does IT's quota say something else?" }));
    expect(await screen.findByText(/du -sh \/algo\/proj\/outputs\/alice/)).toBeInTheDocument();
    expect(screen.getByText(/-user alice/)).toBeInTheDocument();
  });
});


describe('Leftovers, rules, exports and untracked files', () => {
  const rules = {
    project: null, settings: {},
    rules: [{ kind: 'garbage_collect', schedule: 'old', when: 'every day at 02:00 (UTC)', next_run_at: '2026-10-23T02:00:00Z', projects: '*', dry_run: false,
      title: 'Old results are deleted', detail: 'The files of runs on commits without new runs for 1month are deleted.', keeps: 'Milestones are kept.', after: '1month' }],
  };

  it('shows what deleted runs left, and the deletion rules', async () => {
    mockApi({
      'GET /api/v1/storage/overview': { ...overview, totals: { ...overview.totals, deleted: { runs: 4, bytes: 2 * GB, unmeasured: 0 } }, exports: { count: 2, bytes: 3 * GB, linked_bytes: GB } },
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/rules': rules,
    });
    renderAt('/storage');
    expect(await screen.findByTestId('deleted-leftovers')).toHaveTextContent('2.0 GB');
    expect(screen.getByTestId('deleted-leftovers')).toHaveTextContent('left by 4 deleted runs');
    expect(screen.getByTestId('exports-total')).toHaveTextContent('3.0 GB');
    const rule = await screen.findByTestId('deletion-rule');
    expect(rule).toHaveTextContent('Old results are deleted');
    expect(rule).toHaveTextContent('every day at 02:00 (UTC)');
  });

  it('sums up many deletion rules in a line, until asked', async () => {
    const rule = rules.rules[0];
    mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/rules': { ...rules, rules: [rule, { ...rule, kind: 'hard_delete', title: 'Deleted runs are deleted for good' }, { ...rule, kind: 'delete_artifacts', title: 'Old artifacts are deleted' }] },
    });
    renderAt('/storage');
    expect(await screen.findByTestId('deletion-rules-summary')).toHaveTextContent('Old results are deleted · Deleted runs are deleted for good · Old artifacts are deleted');
    expect(screen.queryByTestId('deletion-rule')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the 3 rules' }));
    expect(await screen.findAllByTestId('deletion-rule')).toHaveLength(3);
    expect(screen.queryByTestId('deletion-rules-summary')).not.toBeInTheDocument();
  });

  it('says when nothing deletes results', async () => {
    mockApi({ 'GET /api/v1/storage/overview': overview, 'GET /api/v1/storage/items': items, 'GET /api/v1/storage/jobs': { jobs: [] }, 'GET /api/v1/storage/rules': { rules: [], settings: {}, project: 'proj/a' } });
    renderAt('/storage/batches?project=proj/a');
    expect(await screen.findByTestId('deletion-rules')).toHaveTextContent("Nothing deletes this project's results automatically");
  });

  it('lists exports, explains links, and deletes them', async () => {
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/exports': {
        exports: [
          { id: 1, path: '/algo/proj/outputs/aa/bbb/share/1234abcd', project_id: 'proj/a', hexsha: 'a'.repeat(40), batch_label: 'big', created_by: 'alice', owner: 'alice', source: 'web',
            created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', bytes: 3 * GB, linked_bytes: 3 * GB, files: 30, measured_at: '2026-10-02T00:00:00Z', exports: 2 },
          { id: 2, path: '/algo/exports/bob/x', project_id: null, created_by: 'bob', owner: 'bob', source: 'scan', bytes: GB, linked_bytes: 0, files: 3, exports: 0 },
        ],
        totals: { count: 2, bytes: 4 * GB, linked_bytes: 3 * GB },
      },
      'POST /api/v1/storage/exports/delete': () => [{ job: { id: 9 } }, 201],
    });
    renderAt('/storage/exports?scope=all');
    const [mine, bobs] = await screen.findAllByTestId('export');
    expect(within(mine).getByText('Links to the runs')).toBeInTheDocument();
    expect(within(mine).getByText('2 exports in this folder')).toBeInTheDocument();
    expect(within(bobs).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(within(mine).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText(/that space is freed only once the runs are deleted too/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 export' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/storage/exports/delete')).toHaveLength(1));
    expect(lastBody(fetch, 'POST', '/api/v1/storage/exports/delete')).toEqual({ ids: [1] });
  });

  it("shows what the latest scan found that QA-Board doesn't track, and deletes what's yours", async () => {
    const entry = props => ({ path: '/algo/proj/outputs/alice/tmp', kind: 'untracked_files', bytes: 5 * GB, untracked_bytes: 5 * GB, files: 100, kinds: { untracked_files: 5 * GB },
      owners: { alice: 5 * GB }, owner: 'alice', only_yours: true, deletable: true, action: null, ref: {}, newest_mtime: '2026-01-01T00:00:00Z', ...props });
    const fetch = mockApi({
      'GET /api/v1/storage/overview': overview,
      'GET /api/v1/storage/jobs': { jobs: [] },
      'GET /api/v1/storage/untracked': {
        scan: { id: 3, finished_at: '2026-10-21T00:00:00Z', roots: [] }, user: 'alice',
        totals: { bytes: 7 * GB, by_kind: { untracked_files: 5 * GB, untracked_export: 2 * GB } },
        entries: [entry(), entry({ path: '/algo/proj/outputs/shared', only_yours: false, owners: { alice: GB, bob: GB } })],
      },
      'POST /api/v1/storage/untracked/delete': () => [{ job: { id: 10 } }, 201],
    });
    renderAt('/storage/untracked');
    const [yours, shared] = await screen.findAllByTestId('untracked');
    expect(screen.getByText(/that you own and QA-Board doesn't track/)).toHaveTextContent('7.0 GB');
    expect(within(shared).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(within(yours).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 5.0 GB' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/storage/untracked/delete')).toHaveLength(1));
    expect(lastBody(fetch, 'POST', '/api/v1/storage/untracked/delete')).toEqual({ paths: ['/algo/proj/outputs/alice/tmp'] });
  });

  it('explains how to find untracked files before any scan', async () => {
    mockApi({ 'GET /api/v1/storage/overview': overview, 'GET /api/v1/storage/jobs': { jobs: [] }, 'GET /api/v1/storage/untracked': { scan: null, totals: {}, entries: [] } });
    renderAt('/storage/untracked');
    expect(await screen.findByText("The storage wasn't scanned yet")).toBeInTheDocument();
  });
});
