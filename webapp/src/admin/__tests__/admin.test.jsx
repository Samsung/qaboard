/**
 * The admin panel: only for admins, the users list with its filters, a user's page and its actions, the settings.
 * Run with: cd webapp && npm test -- admin
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { app_routes, matchAppRoute } from '../../routes';
import { AdminPage, sections } from '../AdminPage';
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

  // else /admin/<section> would be a project's page
  it('has a URL for each tab', () => {
    for (const { id } of sections)
      expect(matchAppRoute(`/admin/${id}`)?.match.params.section).toBe(id);
  });

  it('is only for admins', async () => {
    mockApi({});
    renderPage('/admin', { ...admin, is_admin: false });
    expect(await screen.findByText('Admins only')).toBeInTheDocument();
  });

  it('sends signed-out users to the sign-in page', async () => {
    mockApi({ 'GET /api/v1/user/me/': { is_authenticated: false } });
    renderPage('/admin/users', undefined);
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?next=%2Fadmin%2Fusers');
  });

  it('shows the overview to admins', async () => {
    mockApi({ 'GET /api/v1/admin/overview': {
      counts: { users: 12, active_30d: 8, admins: 1, pending: 0, disabled: 1, active_tokens: 5 },
      checklist: [
        { id: 'https', ok: true, severity: 'info', title: 'Cookies are only sent over HTTPS', detail: null },
        { id: 'ingest_auth', ok: false, severity: 'warning', title: 'Anyone who can reach the server can send results', detail: 'Results sent without a token are marked unverified. Move ingest.auth to "warn", then "token", once CI jobs use tokens (QABOARD_TOKEN).' },
      ],
    } });
    renderPage('/admin', admin);
    // the page shows up before its numbers
    expect(await screen.findByText('Active in the last 30 days')).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();
    // what's left to do comes first
    const items = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(items[0]).toMatch(/Anyone who can reach the server can send results/);
    // where to fix it
    expect(screen.getByRole('link', { name: 'Anyone who can reach the server can send results' })).toHaveAttribute('href', '/admin/settings?setting=ingest.auth');
    expect(screen.getByRole('link', { name: 'ingest.auth' })).toHaveAttribute('href', '/admin/settings?setting=ingest.auth');
    // nothing to say about what's fine
    expect(items[1]).toBe('Cookies are only sent over HTTPS');
  });

  it("shows the overview without waiting for what the usage says", async () => {
    // the usage-based items can take seconds when the server didn't compute them lately
    let answer_usage;
    const routes = {
      'GET /api/v1/admin/overview': {
        counts: { users: 12, active_30d: 8, admins: 1, pending: 0, disabled: 1, active_tokens: 5 },
        checklist: [],
        value_checklist: [{ id: 'sentry', ok: true, severity: 'info', title: 'Errors are reported to Sentry', detail: null }],
      },
      'GET /api/v1/admin/overview/usage': () => new Promise(resolve => { answer_usage = resolve; }),
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
      const answer = routes[`${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`];
      return typeof answer === 'function' ? answer() : json(answer ?? {});
    });
    renderPage('/admin', admin);
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('Errors are reported to Sentry')).toBeInTheDocument();
    expect(screen.getByLabelText('Looking at the last 90 days of usage…')).toBeInTheDocument();
    // not "All good" before we know
    expect(screen.queryByText('All good')).not.toBeInTheDocument();
    await act(async () => answer_usage(new Response(JSON.stringify({ items: [
      { id: 'web_only_users', ok: false, severity: 'info', title: "2 users active in the web app didn't use the CLI in 90 days", detail: 'They only read results.' },
    ] }), { headers: { 'Content-Type': 'application/json' } })));
    expect(await screen.findByText("2 users active in the web app didn't use the CLI in 90 days")).toBeInTheDocument();
    expect(screen.getByText('1 to look at')).toBeInTheDocument();
    expect(screen.queryByLabelText('Looking at the last 90 days of usage…')).not.toBeInTheDocument();
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
    // sign-in methods in words
    expect(screen.getAllByText('LDAP').length).toBe(3);
    const bob = screen.getByRole('link', { name: 'bob' });
    expect(bob).toHaveAttribute('href', '/admin/users/3');
    expect(within(bob.closest('tr')).getByText('Disabled')).toBeInTheDocument();
    expect(calls(fetch, 'GET', '/api/v1/admin/users')[0][0]).toBe('/api/v1/admin/users?status=disabled&limit=50&offset=0');

    fireEvent.click(screen.getByLabelText('Admins only'));
    await waitFor(() => expect(history.location.search).toBe('?status=disabled&admin=true'));
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/admin/users').at(-1)[0]).toBe('/api/v1/admin/users?status=disabled&admin=true&limit=50&offset=0'));
  });

  it("shows users' pictures, else their initials", async () => {
    mockApi({ 'GET /api/v1/admin/users': { users: [
      user({ avatar_url: '/api/v1/users/2/picture?v=ab12cd34' }),
      user({ id: 3, user_name: 'bob', full_name: null, avatar_url: null }),
    ], total: 2 } });
    renderAt('/admin/users', <Users/>);
    const alice = (await screen.findByRole('link', { name: 'Alice' })).closest('tr');
    expect(alice.querySelector('img')).toHaveAttribute('src', '/api/v1/users/2/picture?v=ab12cd34');
    // next to their name: not read twice
    expect(alice.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('link', { name: 'bob' }).closest('tr').querySelector('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
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

  it('shows their picture and job, from their sign-in', async () => {
    mockApi({ 'GET /api/v1/admin/users/2': detail({ avatar_url: '/api/v1/users/2/picture?v=ab12cd34', profile: { title: 'Engineer', organization: 'Example Corp' } }) });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    const page = await screen.findByRole('region', { name: 'User alice' });
    expect(page.querySelector('img[src="/api/v1/users/2/picture?v=ab12cd34"]')).toBeInTheDocument();
    expect(screen.getByText('Engineer · Example Corp')).toBeInTheDocument();
  });

  it('disables users after asking, and makes them admins after asking', async () => {
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
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText(/an admin\?/)).toBeInTheDocument();
    expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(1);
    fireEvent.click(confirm.getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(2));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/2')[1][1].body)).toEqual({ is_admin: true });
  });

  it('approves or denies pending users', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users/2': detail({ status: 'pending', login_type: 'LOCAL' }),
      'POST /api/v1/admin/users/2': (url, init) => [user(JSON.parse(init.body)), 200],
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toHaveClass('bp6-intent-primary');
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.getByText('User name and password')).toBeInTheDocument();
    fireEvent.click(approve);
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/2')[0][1].body)).toEqual({ status: 'active' });

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2')).toHaveLength(2));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/2')[1][1].body)).toEqual({ status: 'disabled' });
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
  // backend/settings.py describe()
  const layers = props => ({ env: { name: props.env ?? null, set: false, value: null, error: null }, database: { set: false, value: null, updated_by: null, updated_at: null, error: null }, default: { value: props.default ?? null, text: null } });
  const setting = props => ({
    value: null, default: null, source: 'default', env: null, description: '', type: 'str', choices: null, nullable: false, editable: true,
    label: props.key, group: 'tokens', layers: layers(props), ...props,
  });
  const groups = [
    { id: 'sign_in', title: 'Sign-in', icon: 'log-in', description: 'Who can sign in.' },
    { id: 'tokens', title: 'API tokens and results', icon: 'key', description: 'How `qa` authenticates.' },
    { id: 'jenkins', title: 'Jenkins', icon: 'build', description: 'Jenkins servers.' },
    { id: 'security', title: 'Security', icon: 'shield', description: 'Encryption.' },
  ];
  const jenkins_fields = [
    { name: 'hostname', label: 'Hostname', type: 'hostname', required: true, secret: false },
    { name: 'user', label: 'User', type: 'str', required: true, secret: false },
    { name: 'token', label: 'API token', type: 'str', required: true, secret: true },
  ];
  const initial = () => [
    setting({ key: 'auth.require_sign_in', label: 'Require signing in', group: 'sign_in', value: true, default: false, source: 'env', env: 'QABOARD_LOGIN_REQUIRED', type: 'bool', editable: false,
      description: 'Anonymous users see nothing.', can_import_env: true, layers: { ...layers({ env: 'QABOARD_LOGIN_REQUIRED', default: false }), env: { name: 'QABOARD_LOGIN_REQUIRED', set: true, value: true, error: null } } }),
    setting({ key: 'auth.local_signup', label: 'Local sign-up', group: 'sign_in', value: true, default: true, env: 'QABOARD_DISABLE_SIGNUP', type: 'bool', description: 'Anyone can create a local account.' }),
    setting({ key: 'ingest.auth', label: 'Authenticate results sent by qa', value: 'off', default: 'off', env: 'QABOARD_INGEST_AUTH', type: 'str', choices: ['off', 'warn', 'token'],
      description: 'How `qa` sends results.' }),
    setting({ key: 'tokens.default_lifetime_days', label: 'Default token lifetime', value: 90, default: 90, type: 'int', unit: 'days', minimum: 1, description: 'How long new tokens live.' }),
    setting({ key: 'tokens.max_lifetime_days', label: 'Longest token lifetime', value: null, default: null, type: 'int', nullable: true, unit: 'days', description: 'The longest lifetime.' }),
    setting({ key: 'auth.allowed_origins', label: 'Other allowed origins', group: 'security', value: ['https://a.example'], default: [], source: 'database', env: 'QABOARD_ALLOWED_ORIGINS', type: 'list', description: 'Other origins.',
      layers: { ...layers({}), database: { set: true, value: ['https://a.example'], updated_by: 'alice', updated_at: '2026-11-01T10:00:00Z', error: null } } }),
    setting({ key: 'jenkins.build_token', label: 'Remote build token', group: 'jenkins', secret: true, nullable: true, env: 'JENKINS_BUILD_TOKEN', description: 'The token.' }),
    setting({ key: 'jenkins.servers', label: 'Jenkins servers', group: 'jenkins', type: 'records', record_key: 'hostname', record_noun: 'Jenkins server', fields: jenkins_fields, default: [], source: 'database', env: 'JENKINS_AUTH',
      value: [{ id: 'abc', hostname: 'jenkins.example.com', user: 'qa', token: true }], description: 'The Jenkins servers.' }),
  ];
  const server = [
    { key: 'QABOARD_STORAGE_ROOTS', kind: 'environment', label: 'Storage roots', group: 'security', value: '/mnt/qaboard', is_set: true, source: 'env', description: 'Where results are.', why: 'A security boundary.', editable: false },
  ];
  const encryption = { key: { id: 'a1b2c3d4e5f6', source: 'generated', origin: '/var/qaboard/encryption_key', created_at: '2026-11-01T00:00:00Z' }, can_encrypt: true, previous_keys: [],
    secrets: { total: 2, by_key: { a1b2c3d4e5f6: 2 }, unreadable: [], plaintext: 0, to_rotate: 0 }, weak: false, problems: [] };
  let settings;
  beforeEach(() => { settings = initial(); });
  const mockSettings = () => mockApi({
    'GET /api/v1/admin/settings': () => [{ settings, groups, server, encryption }, 200],
    'POST /api/v1/admin/settings': (url, init) => {
      const [[key, value]] = Object.entries(JSON.parse(init.body));
      if (key === 'jenkins.servers' && value.some(r => r.token === null)) return [{ error: 'jenkins.servers: API token is required' }, 400];
      settings = settings.map(s => s.key === key ? { ...s, value: value ?? s.default, source: value === null ? 'default' : 'database' } : s);
      return [{ settings, groups, server, encryption }, 200];
    },
  });
  const posted = fetch => calls(fetch, 'POST', '/api/v1/admin/settings').map(([, init]) => JSON.parse(init.body));
  const renderSettings = (path = '/admin/settings') => renderAt(path, <Settings me={admin}/>);

  it('groups the settings, and says where values come from', async () => {
    mockSettings();
    renderSettings();
    expect(await screen.findByRole('heading', { name: 'Jenkins' })).toBeInTheDocument();
    const env_row = within(screen.getByTestId('setting-auth.require_sign_in'));
    expect(env_row.getByText('Environment')).toBeInTheDocument();
    expect(env_row.getByText(/Set by/)).toHaveTextContent('Set by $QABOARD_LOGIN_REQUIRED');
    expect(env_row.getByRole('button', { name: 'Save it here' })).toBeInTheDocument();
    // read-only: no switch
    expect(env_row.queryByLabelText('Value of auth.require_sign_in')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('setting-auth.allowed_origins')).getByText('Saved here')).toBeInTheDocument();
    // `code` in descriptions
    expect(within(screen.getByTestId('setting-ingest.auth')).getByText('qa').tagName).toBe('CODE');
    // the popover tells each layer
    fireEvent.click(within(screen.getByTestId('setting-auth.allowed_origins')).getByText('Saved here'));
    const popover = within(await screen.findByTestId('provenance'));
    expect(popover.getByText('alice')).toBeInTheDocument();
    expect(popover.getByText('in use')).toBeInTheDocument();
    // the variables only the environment sets, and the encryption key
    expect(within(screen.getByTestId('variable-QABOARD_STORAGE_ROOTS')).getByText('/mnt/qaboard')).toBeInTheDocument();
    expect(within(screen.getByTestId('encryption-panel')).getByText('a1b2c3d4e5f6')).toBeInTheDocument();
    expect(screen.getByText('Back up this key')).toBeInTheDocument();
  });

  it('searches and filters, in the URL', async () => {
    mockSettings();
    renderSettings('/admin/settings?filter=changed');
    expect(await screen.findByTestId('setting-auth.allowed_origins')).toBeInTheDocument();
    expect(screen.queryByTestId('setting-ingest.auth')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Changed/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(history.location.search).toBe('');
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'jenkins token' } });
    await waitFor(() => expect(history.location.search).toBe('?q=jenkins+token'), { timeout: 5000 });
    // the list is filtered when the page renders with the new URL, after the URL changed
    await waitFor(() => expect(screen.queryByTestId('setting-ingest.auth')).not.toBeInTheDocument());
    expect(screen.getByTestId('setting-jenkins.build_token')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'nothing like this' } });
    expect(await screen.findByText('No settings match', {}, { timeout: 5000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all the settings' }));
    expect(await screen.findByTestId('setting-ingest.auth')).toBeInTheDocument();
  });

  it('switches booleans and picks choices right away', async () => {
    const fetch = mockSettings();
    renderSettings();
    fireEvent.click(await screen.findByLabelText('Value of auth.local_signup'));
    await waitFor(() => expect(posted(fetch)).toEqual([{ 'auth.local_signup': false }]));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Value of ingest.auth' })).getByRole('radio', { name: 'warn' }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(2));
    expect(posted(fetch)[1]).toEqual({ 'ingest.auth': 'warn' });
  });

  it('edits numbers, empty means not set when it can be', async () => {
    const fetch = mockSettings();
    renderSettings();
    const row = within(await screen.findByTestId('setting-tokens.default_lifetime_days'));
    fireEvent.change(row.getByLabelText('Value of tokens.default_lifetime_days'), { target: { value: '1.5' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    expect(row.getByRole('alert')).toHaveTextContent('Type a whole number.');
    fireEvent.change(row.getByLabelText('Value of tokens.default_lifetime_days'), { target: { value: '30' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ 'tokens.default_lifetime_days': 30 }]));
    expect(await row.findByText('Saved here')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    const max = within(screen.getByTestId('setting-tokens.max_lifetime_days'));
    // not set: nothing to save until something is typed
    fireEvent.change(max.getByLabelText('Value of tokens.max_lifetime_days'), { target: { value: '' } });
    expect(max.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.change(max.getByLabelText('Value of tokens.max_lifetime_days'), { target: { value: '60' } });
    fireEvent.click(max.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(2));
    expect(posted(fetch)[1]).toEqual({ 'tokens.max_lifetime_days': 60 });
    await waitFor(() => expect(max.getByLabelText('Value of tokens.max_lifetime_days')).toHaveValue('60'));
    fireEvent.change(max.getByLabelText('Value of tokens.max_lifetime_days'), { target: { value: '' } });
    expect(max.getByText(/Empty: not set/)).toBeInTheDocument();
    fireEvent.click(max.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(3));
    expect(posted(fetch)[2]).toEqual({ 'tokens.max_lifetime_days': null });
  });

  it('edits lists as tags, and resets settings to their default', async () => {
    const fetch = mockSettings();
    renderSettings();
    const row = within(await screen.findByTestId('setting-auth.allowed_origins'));
    const input = row.getByLabelText('Value of auth.allowed_origins');
    fireEvent.change(input, { target: { value: 'https://b.example' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ 'auth.allowed_origins': ['https://a.example', 'https://b.example'] }]));
    fireEvent.click(await row.findByRole('button', { name: 'Reset auth.allowed_origins to its default' }));
    await waitFor(() => expect(posted(fetch)).toHaveLength(2));
    expect(posted(fetch)[1]).toEqual({ 'auth.allowed_origins': null });
  });

  it('never shows secrets: admins replace them', async () => {
    const fetch = mockSettings();
    renderSettings();
    const row = within(await screen.findByTestId('setting-jenkins.build_token'));
    fireEvent.click(row.getByRole('button', { name: 'Set jenkins.build_token' }));
    const input = row.getByLabelText('Value of jenkins.build_token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 's3cret' } });
    fireEvent.click(row.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted(fetch)).toEqual([{ 'jenkins.build_token': 's3cret' }]));
  });

  it('edits records in a dialog, keeping their secrets', async () => {
    const fetch = mockSettings();
    renderSettings();
    const row = within(await screen.findByTestId('setting-jenkins.servers'));
    expect(row.getByText('jenkins.example.com')).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'Edit jenkins.example.com' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('API token')).toHaveValue('');
    fireEvent.change(dialog.getByLabelText(/^User/), { target: { value: 'qa-bot' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    // the token is kept: `true`
    await waitFor(() => expect(posted(fetch)).toEqual([{ 'jenkins.servers': [{ id: 'abc', hostname: 'jenkins.example.com', user: 'qa-bot', token: true }] }]));

    fireEvent.click(await screen.findByRole('button', { name: 'Add a Jenkins server' }));
    const added = within(await screen.findByRole('dialog'));
    fireEvent.change(added.getByLabelText(/^Hostname/), { target: { value: 'other' } });
    fireEvent.click(added.getByRole('button', { name: 'Add' }));
    expect(added.getByText('User is required.')).toBeInTheDocument();
    expect(added.getByText('API token is required.')).toBeInTheDocument();
    expect(posted(fetch)).toHaveLength(1);
  });

  it('links to a setting', async () => {
    mockSettings();
    renderSettings('/admin/settings?setting=jenkins.build_token');
    expect(await screen.findByTestId('setting-jenkins.build_token')).toHaveClass('highlighted');
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


describe('Local accounts', () => {
  it('creates a user with a generated password, shown once', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users': { users: [user()], total: 1 },
      'POST /api/v1/admin/users': (url, init) => [{ user: user({ id: 3, ...JSON.parse(init.body), login_type: 'LOCAL' }), password: 'Generated123456x' }, 201],
    });
    renderAt('/admin/users', <Users/>);
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('User name'), { target: { value: ' bob ' } });
    fireEvent.change(dialog.getByLabelText(/Email/), { target: { value: 'bob@example.com' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create the account' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users')[0][1].body)).toEqual(expect.objectContaining({ user_name: 'bob', email: 'bob@example.com', is_admin: false }));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users')[0][1].body).password).toBeUndefined();
    expect(await screen.findByDisplayValue('Generated123456x')).toBeInTheDocument();
    expect(screen.getByText('Copy the password now')).toBeInTheDocument();
  });

  it('creates an admin with a chosen password, checked first', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users': { users: [], total: 0 },
      'POST /api/v1/admin/users': (url, init) => [{ user: user({ id: 3, ...JSON.parse(init.body), login_type: 'LOCAL' }) }, 201],
    });
    renderAt('/admin/users', <Users/>);
    // also in the empty state
    fireEvent.click((await screen.findAllByRole('button', { name: 'New user' }))[0]);
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('User name'), { target: { value: 'carol' } });
    fireEvent.click(dialog.getByLabelText('Choose one'));
    fireEvent.change(dialog.getByLabelText('Their password'), { target: { value: 'short' } });
    fireEvent.click(dialog.getByLabelText(/^Admin/));
    fireEvent.click(dialog.getByRole('button', { name: 'Create the account' }));
    expect(await dialog.findByText('Passwords need at least 8 characters.')).toBeInTheDocument();
    expect(calls(fetch, 'POST', '/api/v1/admin/users')).toHaveLength(0);
    fireEvent.change(dialog.getByLabelText('Their password'), { target: { value: 'long-enough' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create the account' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users')[0][1].body)).toEqual(expect.objectContaining({ user_name: 'carol', password: 'long-enough', is_admin: true }));
    expect(await screen.findByText(/the password you chose/)).toBeInTheDocument();
  });

  it('shows the server\'s errors next to their field', async () => {
    mockApi({
      'GET /api/v1/admin/users': { users: [user()], total: 1 },
      'POST /api/v1/admin/users': () => [{ error: 'This user name is already taken.', field: 'user_name' }, 400],
    });
    renderAt('/admin/users', <Users/>);
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('User name'), { target: { value: 'alice' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create the account' }));
    expect(await dialog.findByText('This user name is already taken.')).toBeInTheDocument();
  });

  it('resets the password of local accounts after asking', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users/2': { user: user({ login_type: 'LOCAL' }), tokens: [], audit: [] },
      'POST /api/v1/admin/users/2/password': { signed_out: 1, password: 'NewGenerated12345' },
    });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password' }));
    const alert = within(await screen.findByRole('alertdialog'));
    fireEvent.click(alert.getByRole('button', { name: 'Reset the password' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/2/password')).toHaveLength(1));
    expect(await screen.findByDisplayValue('NewGenerated12345')).toBeInTheDocument();
  });

  it('offers no password reset to directory accounts', async () => {
    mockApi({ 'GET /api/v1/admin/users/2': { user: user({ login_type: 'LDAP' }), tokens: [], audit: [] } });
    renderAt('/admin/users/2', <UserDetail id="2" me={admin}/>);
    expect(await screen.findByRole('heading', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
  });
});
