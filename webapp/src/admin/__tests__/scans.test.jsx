/**
 * Admin → Storage → a scan: exploring what's on disk like ncdu, and acting on what QA-Board doesn't track.
 * Run with: cd webapp && npm test -- scans
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { matchAppRoute } from '../../routes';
import { ScanExplorer } from '../ScanExplorer';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };
const GB = 1000 ** 3;

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));

const renderAt = pathname => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}><ScanExplorer id="3"/></HistoryRouter>, { user: admin });
};

const scan = {
  id: 3, job_id: 9, job: null, roots: ['/algo/proj/outputs'], status: 'done', created_at: '2026-10-21T10:00:00Z', finished_at: '2026-10-21T10:05:00Z',
  min_bytes: 50e6, bytes: 100 * GB, files: 12000, errors: 0, by_kind: { run: 60 * GB, untracked_export: 30 * GB, untracked_run: 10 * GB }, untracked_bytes: 40 * GB,
  owners: [{ owner: 'alice', bytes: 70 * GB, untracked_bytes: 30 * GB, kinds: { run: 40 * GB, untracked_export: 30 * GB } }],
};
const entry = props => ({
  path: '/algo/proj/outputs/x', parent: '/algo/proj/outputs', name: 'x', depth: 1, is_dir: true, kind: 'folder', bytes: GB, files: 10,
  newest_mtime: '2026-09-01T00:00:00Z', owners: { alice: GB }, owner: 'alice', kinds: { untracked_files: GB }, ref: {}, small: {}, action: null, deletable: true, ...props,
});

afterEach(() => vi.restoreAllMocks());


describe('Storage scans', () => {
  it('has its route', () => {
    expect(matchAppRoute('/admin/storage/scans/3')).toMatchObject({ route: { name: 'admin_scan' }, match: { params: { scan_id: '3' } } });
  });

  it('shows the totals, drills down folders, and deletes what QA-Board does not use', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/scans/3': scan,
      'GET /api/v1/admin/scans/3/entries': url => {
        const parent = new URL(url, 'http://localhost').searchParams.get('parent');
        if (!parent) return [{ entries: [entry({ path: '/algo/proj/outputs', parent: null, name: '/algo/proj/outputs', depth: 0, deletable: false, kinds: scan.by_kind, bytes: 100 * GB })], total: 1, current: null }, 200];
        return [{ entries: [
          entry({ path: '/algo/proj/outputs/share', name: 'share', kind: 'untracked_export', bytes: 30 * GB, kinds: { untracked_export: 30 * GB } }),
          entry({ path: '/algo/proj/outputs/a1', name: 'a1', kind: 'folder', bytes: 60 * GB, kinds: { run: 60 * GB }, deletable: false }),
        ], total: 2, current: entry({ path: parent }) }, 200];
      },
      'POST /api/v1/admin/scans/3/delete': () => [{ job: { id: 11, status: 'queued' } }, 201],
    });
    renderAt('/admin/storage/scans/3');
    expect(await screen.findByText('Scan #3')).toBeInTheDocument();
    expect(screen.getByText("QA-Board doesn't track").previousSibling).toHaveTextContent('40.0 GB');
    const root = await screen.findByRole('link', { name: '/algo/proj/outputs' });
    fireEvent.click(root);
    await waitFor(() => expect(screen.getAllByTestId('scan-entry')).toHaveLength(2));
    const [share, tracked] = screen.getAllByTestId('scan-entry');
    expect(within(tracked).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(within(share).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Track 1 export' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 30.0 GB' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/scans/3/delete')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/scans/3/delete')[0][1].body)).toEqual({ paths: ['/algo/proj/outputs/share'] });
    await waitFor(() => expect(history.location.pathname).toBe('/admin/storage/jobs/11'));
  });

  it('lists the biggest untracked things anywhere, for an owner', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/scans/3': scan,
      'GET /api/v1/admin/scans/3/entries': { entries: [entry({ kind: 'untracked_run', ref: { batch_id: 4, project_id: 'proj' } })], total: 1, current: null },
      'POST /api/v1/admin/scans/3/import-runs': () => [{ job: { id: 12 } }, 201],
    });
    renderAt('/admin/storage/scans/3');
    await screen.findByText('Scan #3');
    fireEvent.click(screen.getByRole('radio', { name: 'Biggest untracked' }));
    fireEvent.click(screen.getByRole('button', { name: 'alice' }));
    await waitFor(() => {
      const params = new URL(calls(fetch, 'GET', '/api/v1/admin/scans/3/entries').at(-1)[0], 'http://localhost').searchParams;
      expect(params.get('flat')).toBe('true');
      expect(params.get('owner')).toBe('alice');
    });
    fireEvent.click(within(screen.getAllByTestId('scan-entry')[0]).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 run to QA-Board' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/scans/3/import-runs')).toHaveLength(1));
  });
});
