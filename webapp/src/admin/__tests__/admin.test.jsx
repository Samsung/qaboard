/**
 * The admin panel: only for admins, the users list with its filters, a user's page and its actions, the settings.
 * Run with: cd webapp && npm test -- admin
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { app_routes } from '../../routes';
import { AdminPage } from '../AdminPage';
import { Users } from '../Users';
import { UserDetail } from '../UserDetail';
import { Settings } from '../Settings';
import { Checklist } from '../Overview';
import { parseSettingValue, formatSettingValue } from '../settingValue';
import { parseTarget } from '../Audit';
import { renderWithProviders } from '../../test-utils';
import { toaster } from '../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };
const user = props => ({
  id: 2, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', kind: 'human', status: 'active',
  is_admin: false, is_admin_from_env: false, login_type: 'LDAP', created_date: '2026-01-01T00:00:00Z',
  last_login_at: '2026-10-01T00:00:00Z', active_tokens: 2, ...props,
});

// Answers by "METHOD /path", the latest call's body is in calls
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

afterEach(() => vi.restoreAllMocks());


describe('AdminPage', () => {
  const renderPage = (pathname, me) => {
    const { route, match } = matchRoutes(app_routes, pathname);
    expect(route.main).toBeDefined();
    return renderAt(pathname, <RouteMatch match={match}><AdminPage/></RouteMatch>, { user: me });
  };

  it('is only for admins', async () => {
    mockApi({});
    renderPage('/admin', { ...admin, is_admin: false });
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
  });

  it('asks logged-out users to log in', async () => {
    mockApi({ 'GET /api/v1/user/me/': { is_authenticated: false } });
    renderPage('/admin/users', undefined);
    expect(await screen.findByText('Log in to continue')).toBeInTheDocument();
  });

  it('shows the overview to admins', async () => {
    mockApi({ 'GET /api/v1/admin/overview': {
      counts: { users: 12, active_30d: 8, admins: 1, pending: 0, disabled: 1, active_tokens: 5 },
      checklist: [
        { id: 'secure_cookies', ok: true, severity: 'warning', title: 'Cookies are Secure', detail: '' },
        { id: 'ingest_open', ok: false, severity: 'warning', title: 'Anyone can save runs', detail: 'Set QABOARD_INGEST_AUTH=warn.' },
      ],
    } });
    renderPage('/admin', admin);
    expect(await screen.findByText('Active in the last 30 days')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();
    // what's left to do comes first
    const items = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(items[0]).toMatch(/Anyone can save runs/);
  });

  it('says when the server refuses: not an admin anymore', async () => {
    mockApi({ 'GET /api/v1/admin/overview': () => [{ error: 'Only admins can do this.', reason: 'not_admin' }, 403] });
    renderPage('/admin/overview', admin);
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
  });
});


describe('Users', () => {
  it('lists users, and filters them from the URL', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/users': { users: [
      user(),
      user({ id: 3, user_name: 'bob', full_name: null, status: 'disabled' }),
      user({ id: 1, user_name: 'root', full_name: 'Root', is_admin: true, is_admin_from_env: true }),
    ], total: 3 } });
    renderAt('/admin/users?status=disabled', <Users/>);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('3 users')).toBeInTheDocument();
    expect(screen.getByText('Admin (env)')).toBeInTheDocument();
    const bob = screen.getByRole('link', { name: 'bob' });
    expect(bob).toHaveAttribute('href', '/admin/users/3');
    expect(within(bob.closest('tr')).getByText('Disabled')).toBeInTheDocument();
    expect(calls(fetch, 'GET', '/api/v1/admin/users')[0][0]).toBe('/api/v1/admin/users?status=disabled&limit=50&offset=0');

    fireEvent.click(screen.getByLabelText('Admins only'));
    await waitFor(() => expect(history.location.search).toBe('?status=disabled&admin=true'));
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/admin/users').at(-1)[0]).toBe('/api/v1/admin/users?status=disabled&admin=true&limit=50&offset=0'));
  });

  it('searches a moment after typing', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/users': { users: [], total: 0 } });
    renderAt('/admin/users', <Users/>);
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'ali' } });
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/admin/users').at(-1)[0]).toContain('search=ali'));
    expect(await screen.findByText('No matching users')).toBeInTheDocument();
  });

  it('pages through many users', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/users': { users: Array.from({ length: 50 }, (_, i) => user({ id: 100 + i, user_name: `user${i}`, full_name: null })), total: 120 } });
    renderAt('/admin/users', <Users/>);
    expect(await screen.findByText('1–50 of 120')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/admin/users').at(-1)[0]).toContain('offset=50'));
  });
});


describe('UserDetail', () => {
  const detail = props => ({
    user: user(props),
    tokens: [{ id: 5, name: 'ci-bot', kind: 'personal', prefix: 'qab_pat_abcd', scopes: ['ingest'], projects: [], status: 'active', created_at: '2026-09-01T00:00:00Z' }],
    audit: [{ id: 1, created_at: '2026-10-01T00:00:00Z', actor_kind: 'user', actor_label: 'alice', actor_user_id: 2, action: 'token.create', target_type: 'token', target_id: '5', target_label: 'ci-bot', ip: '10.0.0.1' }],
  });

  it('shows the user, their tokens and activity', async () => {
    mockApi({ 'GET /api/v1/admin/users/2': detail() });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    expect(await screen.findByRole('heading', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByText('qab_pat_abcd…')).toBeInTheDocument();
    expect(screen.getByText('Created a token')).toBeInTheDocument();
  });

  it('disables users after asking, and makes them admins', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users/2': detail(),
      'POST /api/v1/admin/users/2': (url, init) => [user(JSON.parse(init.body)), 200],
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const alert = within(await screen.findByRole('alertdialog'));
    fireEvent.click(alert.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/2')[0][1].body)).toEqual({ status: 'disabled' });
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disabled alice' })));

    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(2));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/2')[1][1].body)).toEqual({ is_admin: true });
  });

  it('revokes all their tokens', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users/2': detail(),
      'POST /api/v1/admin/users/2/revoke-tokens': { revoked: 2 },
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke all tokens' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke all' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2/revoke-tokens')).toHaveLength(1));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Revoked 2 tokens of alice' })));
  });

  it("can't demote admins from the environment, nor disable yourself", async () => {
    mockApi({ 'GET /api/v1/admin/users/1': detail({ id: 1, user_name: 'root', is_admin: true, is_admin_from_env: true }) });
    renderAt('/admin/users/1', <UserDetail id="1" me={admin}/>);
    expect(await screen.findByRole('button', { name: 'Remove admin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled();
  });

  it("says why the server refused", async () => {
    mockApi({
      'GET /api/v1/admin/users/2': detail({ is_admin: true }),
      'POST /api/v1/admin/users/2': () => [{ error: 'There must be at least one admin.' }, 400],
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove admin' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove admin' }));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'There must be at least one admin.' })));
  });
});


describe('Settings', () => {
  const settings = [
    { key: 'auth.require_sign_in', value: true, default: false, source: 'env', env: 'QABOARD_LOGIN_REQUIRED', description: 'Only logged-in users see anything.', editable: true },
    { key: 'tokens.default_lifetime_days', value: 90, default: 90, source: 'default', env: null, description: 'How long new tokens live.', editable: true },
    { key: 'auth.allowed_origins', value: ['https://a.example'], default: [], source: 'database', env: 'QABOARD_ALLOWED_ORIGINS', description: 'Other sites that can call the API.', editable: true },
  ];

  it('shows where values come from, and edits those not set by the environment', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/settings': { settings },
      'POST /api/v1/admin/settings': (url, init) => [{ settings: settings.map(s => s.key === 'tokens.default_lifetime_days' ? { ...s, value: JSON.parse(init.body)[s.key], source: 'database' } : s) }, 200],
    });
    renderWithProviders(<Settings/>);
    const env_row = within(await screen.findByTestId('setting-auth.require_sign_in'));
    expect(env_row.getByText('environment')).toBeInTheDocument();
    expect(env_row.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('setting-auth.allowed_origins')).getByText('database')).toBeInTheDocument();

    const row = within(screen.getByTestId('setting-tokens.default_lifetime_days'));
    fireEvent.click(row.getByRole('button', { name: 'Edit tokens.default_lifetime_days' }));
    fireEvent.change(row.getByLabelText('Value of tokens.default_lifetime_days'), { target: { value: 'soon' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    expect(row.getByRole('alert')).toHaveTextContent('Type a number.');
    fireEvent.change(row.getByLabelText('Value of tokens.default_lifetime_days'), { target: { value: '30' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/settings')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/settings')[0][1].body)).toEqual({ 'tokens.default_lifetime_days': 30 });
    expect(await row.findByText('database')).toBeInTheDocument();
  });

  it('resets settings to their default', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/settings': { settings }, 'POST /api/v1/admin/settings': { settings } });
    renderWithProviders(<Settings/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset auth.allowed_origins to its default' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/settings')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/settings')[0][1].body)).toEqual({ 'auth.allowed_origins': null });
  });
});


describe('settings values', () => {
  it('are read with the type of the setting', () => {
    expect(parseSettingValue('yes', false)).toEqual({ value: true });
    expect(parseSettingValue('False', true)).toEqual({ value: false });
    expect(parseSettingValue('maybe', true).error).toBeDefined();
    expect(parseSettingValue(' 365 ', 90)).toEqual({ value: 365 });
    expect(parseSettingValue('a, b ,', [])).toEqual({ value: ['a', 'b'] });
    expect(parseSettingValue('["a"]', [])).toEqual({ value: ['a'] });
    expect(parseSettingValue('', [])).toEqual({ value: [] });
    expect(parseSettingValue('warn', 'off')).toEqual({ value: 'warn' });
    expect(parseSettingValue('"token"', 'off')).toEqual({ value: 'token' });
  });
  it('without a type, are JSON or text', () => {
    expect(parseSettingValue('365', null)).toEqual({ value: 365 });
    expect(parseSettingValue('null', null)).toEqual({ value: null });
    expect(parseSettingValue('hello', null)).toEqual({ value: 'hello' });
    expect(parseSettingValue('', null).error).toBeDefined();
  });
  it('are shown as they are typed', () => {
    expect(formatSettingValue(['a', 'b'])).toBe('a, b');
    expect(formatSettingValue(true)).toBe('true');
    expect(formatSettingValue(null)).toBe('');
  });
});


describe('Audit', () => {
  it('filters by target', () => {
    expect(parseTarget('user:12')).toEqual({ target_type: 'user', target_id: '12' });
    expect(parseTarget(' token ')).toEqual({ target_type: 'token', target_id: '' });
  });
});

describe('Checklist', () => {
  it('says when all is good', () => {
    renderWithProviders(<Checklist checklist={[{ id: 'a', ok: true, severity: 'info', title: 'Fine' }]}/>);
    expect(screen.getByText('All good')).toBeInTheDocument();
  });
});
