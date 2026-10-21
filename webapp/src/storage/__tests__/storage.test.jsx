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
