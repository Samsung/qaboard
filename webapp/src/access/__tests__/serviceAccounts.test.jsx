/**
 * Service accounts: projects' owners (Access page) and admins (admin panel) create bots, give them a role, create
 * their tokens and delete them.
 * Run with: cd webapp && npm test -- serviceAccounts
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { ServiceAccounts, valid_name } from '../ServiceAccounts';
import { SubjectName } from '../roles';
import { renderWithProviders } from '../../test-utils';

vi.mock('../../utils/clipboard', () => ({ copyWithToast: vi.fn(), copyText: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Answers by "METHOD /path"
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && new URL(url, 'http://localhost').pathname === path);
const body = call => JSON.parse(call[1].body);

const project = 'group/repo';
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice', is_admin: false };
const account = props => ({
  id: 12, name: 'ci', user_name: `${project}/ci[bot]`, description: 'GitLab CI', owner_type: 'project', project,
  role: 'developer', status: 'active', created_at: '2026-10-01T00:00:00Z', created_by: 'alice', active_tokens: 1,
  last_used_at: null, ...props,
});
const token = props => ({
  id: 5, name: 'gitlab', kind: 'service', prefix: 'qab_svc_Xk3f', scopes: ['read', 'ingest'], projects: [project],
  created_at: '2026-10-01T00:00:00Z', expires_at: null, idle_expiry_days: null, last_used_at: null, last_used_ip: null,
  revoked_at: null, status: 'active', data: {}, ...props,
});

afterEach(() => vi.restoreAllMocks());


describe('Service accounts', () => {
  it('accepts the names the server accepts', () => {
    expect(['ci', 'nightly-benchmarks', 'a.b_c'].every(valid_name)).toBe(true);
    expect(['CI', 'ci bot', '-ci', 'a'.repeat(41), ''].some(valid_name)).toBe(false);
  });

  it("lists a project's service accounts, and changes their role", async () => {
    const fetch = mockApi({
      'GET /api/v1/service-accounts': { service_accounts: [account()] },
      'POST /api/v1/service-accounts/12': (url, init) => [account({ role: JSON.parse(init.body).role }), 200],
    });
    renderWithProviders(<ServiceAccounts project={project}/>, { user: alice });
    const row = within(await screen.findByTestId('service-account-12'));
    expect(row.getByText(`${project}/ci[bot]`)).toBeInTheDocument();
    expect(row.getByText('GitLab CI')).toBeInTheDocument();
    expect(calls(fetch, 'GET', '/api/v1/service-accounts')[0][0]).toContain('project=group%2Frepo');
    // a project's always has a role
    const role = row.getByRole('combobox', { name: `Role of ${project}/ci[bot]` });
    expect([...role.options].map(o => o.value)).toEqual(['viewer', 'developer', 'owner']);
    fireEvent.change(role, { target: { value: 'viewer' } });
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/service-accounts/12')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/service-accounts/12')[0])).toEqual({ role: 'viewer' });
  });

  it('creates one, then a token restricted to the project, shown once', async () => {
    const secret = 'qab_svc_0123456789abcdefghijABCDEFGHIJ0123456789xyzXYZ';
    const fetch = mockApi({
      'GET /api/v1/service-accounts': { service_accounts: [] },
      'POST /api/v1/service-accounts': () => [account({ active_tokens: 0 }), 201],
      'GET /api/v1/service-accounts/12': { ...account(), tokens: [] },
      'POST /api/v1/service-accounts/12/tokens': () => [{ ...token(), token: secret }, 201],
    });
    renderWithProviders(<ServiceAccounts project={project}/>, { user: alice });
    expect(await screen.findByText('No service accounts yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New service account' }));
    let dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'CI' } });
    expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'ci' } });
    expect(dialog.getByText(`${project}/ci[bot]`)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('radio', { name: /Viewer/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/service-accounts')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/service-accounts')[0])).toEqual({ name: 'ci', description: '', role: 'viewer', project });

    // its tokens open right away
    dialog = within((await screen.findByText(`Tokens of ${project}/ci[bot]`)).closest('[role="dialog"]'));
    expect(await dialog.findByText('No tokens yet')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'New token' }));
    const form = within((await screen.findByText(`New token for ${project}/ci[bot]`)).closest('[role="dialog"]'));
    // never the admin API, and only its project
    expect(form.queryByRole('checkbox', { name: /Admin/ })).not.toBeInTheDocument();
    expect(form.queryByLabelText(/Projects/)).not.toBeInTheDocument();
    expect(form.getByText(project)).toBeInTheDocument();
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'gitlab' } });
    fireEvent.click(form.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByDisplayValue(secret)).toBeInTheDocument();
    const sent = body(calls(fetch, 'POST', '/api/v1/service-accounts/12/tokens')[0]);
    expect(sent).toMatchObject({ name: 'gitlab', scopes: ['read', 'ingest'], projects: [project] });
  });

  it("lists the instance's, whose role on all projects is optional, and deletes them", async () => {
    const fetch = mockApi({
      'GET /api/v1/service-accounts': { service_accounts: [account({ id: 13, user_name: 'nightly[bot]', name: 'nightly', owner_type: 'instance', project: null, role: null })] },
      'DELETE /api/v1/service-accounts/13': { status: 'OK' },
    });
    renderWithProviders(<ServiceAccounts/>, { user: { ...alice, is_admin: true } });
    const row = within(await screen.findByTestId('service-account-13'));
    expect(calls(fetch, 'GET', '/api/v1/service-accounts')[0][0]).not.toContain('project=');
    expect(row.getByRole('combobox', { name: 'Role of nightly[bot]' })).toHaveValue('');
    fireEvent.click(row.getByRole('button', { name: 'Delete nightly[bot]' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/service-accounts/13')).toHaveLength(1));
  });

  it('shows service accounts as such among members', () => {
    renderWithProviders(<SubjectName subject={{ type: 'user', id: 12, name: 'ci[bot]', full_name: 'ci', kind: 'service' }}/>);
    expect(screen.getByLabelText('Service account')).toBeInTheDocument();
    expect(screen.getByText('ci[bot]')).toBeInTheDocument();
  });
});
