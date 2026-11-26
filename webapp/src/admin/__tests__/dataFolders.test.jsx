/**
 * Admin → Storage → Data folders: folders QA-Board reads but never changes.
 * Run with: cd webapp && npm test -- dataFolders
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { DataFolders } from '../DataFolders';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = Array.isArray(answer) ? answer : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && new URL(url, 'http://localhost').pathname === path);

const datasets = { path: '/mnt/nas/datasets', reachable: true, in_storage: false };
const old = { path: '/mnt/old', reachable: false, in_storage: true };
const listing = (props = {}) => ({ data_folders: [datasets, old], storage_roots: ['/mnt/qaboard'], ...props });

afterEach(() => vi.restoreAllMocks());


describe('DataFolders', () => {
  it('explains them, and lists them with their status', async () => {
    mockApi({ 'GET /api/v1/admin/data-folders': listing() });
    renderWithProviders(<DataFolders/>, { user: admin });
    expect(screen.getByText('Folders QA-Board reads but never changes: your datasets. Thumbnails and the file viewer can show files there.')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Data folders' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('/mnt/nas/datasets')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Not mounted')).not.toBeInTheDocument();
    expect(within(rows[2]).getByText('Not mounted')).toBeInTheDocument();
    expect(within(rows[2]).getByText('In the storage')).toBeInTheDocument();
  });

  it('says when there are none', async () => {
    mockApi({ 'GET /api/v1/admin/data-folders': listing({ data_folders: [] }) });
    renderWithProviders(<DataFolders/>, { user: admin });
    expect(await screen.findByText(/None yet: QA-Board reads only its storage/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('adds a folder', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/data-folders': listing({ data_folders: [] }),
      'POST /api/v1/admin/data-folders': [datasets, 201],
    });
    renderWithProviders(<DataFolders/>, { user: admin });
    const input = await screen.findByLabelText('Folder to add');
    expect(screen.getByRole('button', { name: 'Add a data folder' })).toBeDisabled();
    fireEvent.change(input, { target: { value: ' /mnt/nas/datasets ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a data folder' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/data-folders')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/data-folders')[0][1].body)).toEqual({ path: '/mnt/nas/datasets', check: true });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it("shows why the server refused a folder, and keeps it", async () => {
    mockApi({
      'GET /api/v1/admin/data-folders': listing({ data_folders: [] }),
      'POST /api/v1/admin/data-folders': [{ error: "/etc is, contains or is inside one of the system's folders (/etc).", reason: 'forbidden' }, 400],
    });
    renderWithProviders(<DataFolders/>, { user: admin });
    const input = await screen.findByLabelText('Folder to add');
    fireEvent.change(input, { target: { value: '/etc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a data folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("one of the system's folders");
    expect(input).toHaveValue('/etc');
  });

  it('removes a folder once confirmed', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/data-folders': listing(),
      'DELETE /api/v1/admin/data-folders': { status: 'OK', path: '/mnt/nas/datasets' },
    });
    renderWithProviders(<DataFolders/>, { user: admin });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove /mnt/nas/datasets' }));
    expect(await screen.findByText(/Its files stay where they are/)).toBeInTheDocument();
    expect(calls(fetch, 'DELETE', '/api/v1/admin/data-folders')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/data-folders')).toHaveLength(1));
    const [url] = calls(fetch, 'DELETE', '/api/v1/admin/data-folders')[0];
    expect(new URL(url, 'http://localhost').searchParams.get('path')).toBe('/mnt/nas/datasets');
  });
});
