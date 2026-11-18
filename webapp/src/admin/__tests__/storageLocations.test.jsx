/**
 * Admin → Storage → Storage locations: where projects' uploaded runs go.
 * Run with: cd webapp && npm test -- storageLocations
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { StorageLocations } from '../StorageLocations';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  // an answer: its data, or [data, status], or a function of the request returning [data, status]
  const [data, status] = typeof answer === 'function' ? answer(url, init) : Array.isArray(answer) ? answer : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && new URL(url, 'http://localhost').pathname === path);

const team_a = { id: 1, url: 's3://team-a/qaboard/', path: '/mnt/qaboard/team-a', projects: ['team-a/'], runs: 12, outside_storage_roots: false, reachable: true };
const old = { id: 2, url: 's3://old/', path: '/data/old', projects: [], runs: 0, outside_storage_roots: true, reachable: false };
const listing = (props = {}) => ({ locations: [team_a, old], default: { path: '/mnt/qaboard', reachable: true }, default_off_reason: null, storage_roots: ['/mnt/qaboard'], ...props });

afterEach(() => vi.restoreAllMocks());


describe('StorageLocations', () => {
  it('lists the locations, then the default one', async () => {
    mockApi({ 'GET /api/v1/admin/storage-locations': listing() });
    renderWithProviders(<StorageLocations/>, { user: admin });
    const table = await screen.findByRole('table', { name: 'Storage locations' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText('s3://team-a/qaboard/…')).toBeInTheDocument();
    expect(within(rows[1]).getByText('team-a/')).toBeInTheDocument();
    expect(within(rows[2]).getByText('None: no new runs go there')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Not mounted')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Outside the storage roots')).toBeInTheDocument();
    expect(within(rows[3]).getByText('/mnt/qaboard')).toBeInTheDocument();
    expect(within(rows[3]).getByText('The other projects')).toBeInTheDocument();
    expect(screen.getByText(/Folders must be inside the storage roots/)).toBeInTheDocument();
  });

  it('says when the projects no location lists cannot upload', async () => {
    mockApi({ 'GET /api/v1/admin/storage-locations': listing({ locations: [], default: null, default_off_reason: "QABOARD_UPLOAD_ROOT isn't set" }) });
    renderWithProviders(<StorageLocations/>, { user: admin });
    expect(await screen.findByText(/can't upload \(QABOARD_UPLOAD_ROOT isn't set\)/)).toBeInTheDocument();
  });

  it('adds a location', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/storage-locations': listing({ locations: [] }),
      'POST /api/v1/admin/storage-locations': [{ ...team_a, runs: 0 }, 201],
    });
    renderWithProviders(<StorageLocations/>, { user: admin });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a location…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Runs store'), { target: { value: 's3://team-a/qaboard/' } });
    fireEvent.change(within(dialog).getByLabelText('Folder on the server'), { target: { value: '/mnt/qaboard/team-a' } });
    const projects = within(dialog).getByLabelText('New runs of');
    fireEvent.change(projects, { target: { value: 'team-a/' } });
    fireEvent.keyDown(projects, { key: 'Enter' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/storage-locations')).toHaveLength(1));
    const [, init] = calls(fetch, 'POST', '/api/v1/admin/storage-locations')[0];
    expect(JSON.parse(init.body)).toEqual({ url: 's3://team-a/qaboard/', path: '/mnt/qaboard/team-a', projects: ['team-a/'], check: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it("shows why the server refused a location, and keeps the form", async () => {
    mockApi({
      'GET /api/v1/admin/storage-locations': listing({ locations: [] }),
      'POST /api/v1/admin/storage-locations': [{ error: "/etc isn't in the storage roots (/mnt/qaboard)", reason: 'outside_storage_roots' }, 400],
    });
    renderWithProviders(<StorageLocations/>, { user: admin });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a location…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Runs store'), { target: { value: 's3://x/' } });
    fireEvent.change(within(dialog).getByLabelText('Folder on the server'), { target: { value: '/etc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("isn't in the storage roots");
  });

  it("changes a location's projects, never its URL", async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/storage-locations': listing(),
      'POST /api/v1/admin/storage-locations/1': [{ ...team_a, projects: [] }],
    });
    renderWithProviders(<StorageLocations/>, { user: admin });
    fireEvent.click(await screen.findByRole('button', { name: 'Change s3://team-a/qaboard/' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Runs store')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: /Remove/ }));  // the tag's remove button
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/storage-locations/1')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/storage-locations/1')[0][1].body)).toEqual({ path: '/mnt/qaboard/team-a', projects: [], check: true });
  });

  it('removes a location with runs only once confirmed, with force', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/storage-locations': listing(),
      'DELETE /api/v1/admin/storage-locations/1': [{ status: 'OK', runs: 12 }],
    });
    renderWithProviders(<StorageLocations/>, { user: admin });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove s3://team-a/qaboard/' }));
    expect(await screen.findByText(/12 runs are in s3:\/\/team-a\/qaboard\//)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/storage-locations/1')).toHaveLength(1));
    expect(calls(fetch, 'DELETE', '/api/v1/admin/storage-locations/1')[0][0]).toContain('force=1');
  });
});
