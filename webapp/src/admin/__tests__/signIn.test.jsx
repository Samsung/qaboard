/**
 * Admin → Sign-in (providers, their form and tests), Access requests, the pending count, and signing users out.
 * Run with: cd webapp && npm test -- admin/__tests__/signIn
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { app_routes } from '../../routes';
import { AdminPage } from '../AdminPage';
import { SignIn } from '../SignIn';
import { AccessRequests } from '../AccessRequests';
import { UserDetail } from '../UserDetail';
import { validateProvider } from '../ProviderDialog';
import AuthButton from '../../components/authentication/Auth';
import { renderWithProviders } from '../../test-utils';
import { toaster } from '../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };

// Answers by "METHOD /path"
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
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, { user: admin, ...options });
};

afterEach(() => vi.restoreAllMocks());


// api/admin_sign_in.py admin_sign_in(): Provider.describe(), with the OIDC providers' redirect_uri
const env_sso = {
  id: 'sso', type: 'oidc', kind: 'redirect', name: 'Company SSO', recommended: true, start_url: '/api/v1/auth/oidc/sso/start',
  source: 'env', enabled: true, position: -1, has_secret: true,
  config: { issuer: 'https://idp.example.com/realms/company', client_id: 'qaboard', client_secret_env: 'QABOARD_OIDC_CLIENT_SECRET', scopes: ['openid', 'profile', 'email'], claims: {}, match_users: 'username' },
  redirect_uri: 'https://qaboard.example.com/api/v1/auth/oidc/sso/callback',
};
const ldap = { id: 'ldap', type: 'ldap', kind: 'password', name: 'Directory account (LDAP)', recommended: false, start_url: null, source: 'env', enabled: true, position: 0, config: {}, has_secret: false };
const keycloak = {
  ...env_sso, id: 'keycloak', name: 'Keycloak', recommended: false, start_url: '/api/v1/auth/oidc/keycloak/start', source: 'database', position: 10, has_secret: true,
  config: { issuer: 'https://keycloak.example.com/realms/lab', client_id: 'qa', scopes: ['openid', 'email'], match_users: 'email' },
  redirect_uri: 'https://qaboard.example.com/api/v1/auth/oidc/keycloak/callback',
};
const sign_in = (props = {}) => ({ providers: [env_sso, ldap, keycloak], can_encrypt: true, public_url: 'https://qaboard.example.com', ...props });


describe('Sign-in', () => {
  it('lists the providers: those from the environment are read-only', async () => {
    mockApi({ 'GET /api/v1/admin/sign-in': sign_in() });
    renderAt('/admin/sign-in', <SignIn/>);
    const sso = within(await screen.findByTestId('provider-sso'));
    expect(sso.getByText('environment')).toBeInTheDocument();
    expect(sso.getByText('Recommended')).toBeInTheDocument();
    expect(sso.getByText('https://qaboard.example.com/api/v1/auth/oidc/sso/callback')).toBeInTheDocument();
    expect(sso.getByRole('button', { name: 'Copy the redirect URI' })).toBeInTheDocument();
    expect(sso.getByText('By user name')).toBeInTheDocument();
    expect(sso.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(sso.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    const db = within(screen.getByTestId('provider-keycloak'));
    expect(db.getByText('database')).toBeInTheDocument();
    expect(db.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(db.getByRole('button', { name: 'Delete Keycloak' })).toBeInTheDocument();
  });

  it('shows the checks of a test, and looks up a user in LDAP', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/sign-in': sign_in(),
      'POST /api/v1/admin/sign-in/providers/sso/test': { ok: false, checks: [
        { check: 'discovery', ok: true, detail: 'https://idp.example.com/realms/company/.well-known/openid-configuration answers' },
        { check: 'redirect_uri', ok: false, detail: 'The IdP refused https://qaboard.example.com/api/v1/auth/oidc/sso/callback: register it' },
      ] },
      'POST /api/v1/admin/sign-in/providers/ldap/test': { ok: true, checks: [{ check: 'bind', ok: true, detail: 'Bound as the service account' }] },
    });
    renderAt('/admin/sign-in', <SignIn/>);
    const sso = within(await screen.findByTestId('provider-sso'));
    fireEvent.click(sso.getByRole('button', { name: 'Test' }));
    const results = within(await sso.findByRole('region', { name: 'Test results' }));
    expect(results.getByText('1 of 2 checks failed')).toBeInTheDocument();
    const checks = results.getAllByTestId('check');
    expect(within(checks[0]).getByLabelText('Passed')).toBeInTheDocument();
    expect(within(checks[1]).getByLabelText('Failed')).toBeInTheDocument();
    expect(checks[1]).toHaveTextContent('register it');

    const directory = within(screen.getByTestId('provider-ldap'));
    fireEvent.change(directory.getByLabelText('User name to look up in LDAP'), { target: { value: 'alice' } });
    fireEvent.click(directory.getByRole('button', { name: 'Test' }));
    expect(await directory.findByText('All checks passed')).toBeInTheDocument();
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/sign-in/providers/ldap/test')[0][1].body)).toEqual({ user_name: 'alice' });
  });

  it('checks the form before adding a provider, then shows what the server refuses', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/sign-in': sign_in(),
      'POST /api/v1/admin/sign-in/providers': () => [{ error: 'There is already a provider okta.' }, 409],
    });
    renderAt('/admin/sign-in', <SignIn/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add OIDC provider' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'Okta!' } });
    fireEvent.change(dialog.getByLabelText('Issuer'), { target: { value: 'okta.example.com' } });
    fireEvent.change(dialog.getByLabelText('Scopes'), { target: { value: 'profile email' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add the provider' }));
    expect(dialog.getByText('Lowercase letters, digits, - and _, e.g. keycloak.')).toBeInTheDocument();
    expect(dialog.getByText('A URL, e.g. https://keycloak.example.com/realms/company')).toBeInTheDocument();
    expect(dialog.getByText('The scopes must include openid.')).toBeInTheDocument();
    expect(dialog.getByText('Users see it on the sign-in button.')).toBeInTheDocument();
    expect(calls(fetch, 'POST', '/api/v1/admin/sign-in/providers')).toHaveLength(0);

    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Okta' } });
    fireEvent.change(dialog.getByLabelText('ID'), { target: { value: 'okta' } });
    fireEvent.change(dialog.getByLabelText('Issuer'), { target: { value: 'https://okta.example.com' } });
    fireEvent.change(dialog.getByLabelText('Client ID'), { target: { value: 'abc' } });
    fireEvent.change(dialog.getByLabelText('Client secret'), { target: { value: 's3cret' } });
    fireEvent.change(dialog.getByLabelText('Scopes'), { target: { value: 'openid profile email' } });
    fireEvent.click(dialog.getByRole('radio', { name: /By verified email/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'Add the provider' }));
    expect(await dialog.findByText('There is already a provider okta.')).toBeInTheDocument();
    const [[, init]] = calls(fetch, 'POST', '/api/v1/admin/sign-in/providers');
    expect(JSON.parse(init.body)).toMatchObject({
      id: 'okta', name: 'Okta', issuer: 'https://okta.example.com', client_id: 'abc', client_secret: 's3cret',
      scopes: ['openid', 'profile', 'email'], match_users: 'email', enabled: true, recommended: false,
    });
  });

  it('without an encryption key, secrets come from the environment', async () => {
    mockApi({ 'GET /api/v1/admin/sign-in': sign_in({ can_encrypt: false }) });
    renderAt('/admin/sign-in', <SignIn/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add OIDC provider' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('radio', { name: 'Stored encrypted' })).toBeDisabled();
    expect(dialog.getByRole('radio', { name: 'From an environment variable' })).toBeChecked();
    expect(dialog.getByText(/QABOARD_ENCRYPTION_KEY/)).toBeInTheDocument();
    expect(dialog.getByLabelText('Environment variable with the client secret')).toBeInTheDocument();
    expect(document.querySelector('.bp6-dialog input[type=password]')).toBeNull();
    expect(validateProvider({ id: 'a', name: 'A', issuer: 'https://a', client_id: 'x', scopes: 'openid', secret_mode: 'env', client_secret_env: '', client_secret: '', redirect_uri: '' }, { create: true, can_encrypt: false }))
      .toHaveProperty('client_secret_env');
  });

  it('edits a provider, keeping its secret, and deletes one after asking', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/sign-in': sign_in(),
      'POST /api/v1/admin/sign-in/providers/keycloak': (url, init) => [{ ...keycloak, ...JSON.parse(init.body) }, 200],
      'DELETE /api/v1/admin/sign-in/providers/keycloak': { status: 'OK' },
    });
    renderAt('/admin/sign-in', <SignIn/>);
    const card = within(await screen.findByTestId('provider-keycloak'));
    fireEvent.click(card.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('ID')).toBeDisabled();
    expect(dialog.getByLabelText('Client secret')).toHaveAttribute('placeholder', 'Unchanged');
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Lab Keycloak' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/sign-in/providers/keycloak')).toHaveLength(1));
    const body = JSON.parse(calls(fetch, 'POST', '/api/v1/admin/sign-in/providers/keycloak')[0][1].body);
    expect(body).toMatchObject({ name: 'Lab Keycloak', issuer: 'https://keycloak.example.com/realms/lab', match_users: 'email' });
    expect(body).not.toHaveProperty('client_secret');
    expect(body).not.toHaveProperty('id');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(card.getByRole('button', { name: 'Delete Keycloak' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/sign-in/providers/keycloak')).toHaveLength(1));
  });
});


// sign_in/access.py serialize()
const request = props => ({
  id: 5, kind: 'instance', message: 'I join the camera team next week', status: 'pending', created_at: '2026-10-19T10:00:00Z', decided_at: null,
  user: { id: 7, user_name: 'carol', full_name: 'Carol', email: 'carol@example.com' }, ...props,
});

describe('Access requests', () => {
  it('lists the pending users with their message, and approves them', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/access-requests': { requests: [request()] },
      'POST /api/v1/admin/users/7': { id: 7, user_name: 'carol', status: 'active' },
    });
    renderAt('/admin/requests', <AccessRequests/>);
    const card = within(await screen.findByTestId('request-5'));
    expect(card.getByText('I join the camera team next week')).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Carol' })).toHaveAttribute('href', '/admin/users/7');
    fireEvent.click(card.getByRole('button', { name: 'Approve carol' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/7')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/7')[0][1].body)).toEqual({ status: 'active' });
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Approved carol: they can sign in' })));
  });

  it('denies after asking', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/access-requests': { requests: [request()] },
      'POST /api/v1/admin/users/7': { id: 7, user_name: 'carol', status: 'disabled' },
    });
    renderAt('/admin/requests', <AccessRequests/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny carol' }));
    expect(calls(fetch, 'POST', '/api/v1/admin/users/7')).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/7')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/admin/users/7')[0][1].body)).toEqual({ status: 'disabled' });
  });

  it('says when no one is waiting', async () => {
    mockApi({ 'GET /api/v1/admin/access-requests': { requests: [] } });
    renderAt('/admin/requests', <AccessRequests/>);
    expect(await screen.findByText('No one is waiting')).toBeInTheDocument();
  });

  it('counts the pending users on the tab, and in the menu', async () => {
    mockApi({ 'GET /api/v1/admin/access-requests': { requests: [request(), request({ id: 6, user: { id: 8, user_name: 'dan' } })] } });
    const { route, match } = matchRoutes(app_routes, '/admin');
    expect(route.main).toBeDefined();
    renderAt('/admin', <RouteMatch match={match}><AdminPage/></RouteMatch>);
    const tab = await screen.findByRole('tab', { name: /Access requests/ });
    expect(await within(tab).findByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Root: your account' }));
    expect(await screen.findByRole('menuitem', { name: /Admin/ })).toHaveAttribute('href', '/admin/requests');
  });

  it("doesn't ask for the count for users who aren't admins", async () => {
    const fetch = mockApi({});
    renderWithProviders(<AuthButton/>, { user: { ...admin, is_admin: false }, siteConfig: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Root: your account' }));
    await screen.findByRole('menuitem', { name: 'Settings' });
    expect(calls(fetch, 'GET', '/api/v1/admin/access-requests')).toHaveLength(0);
  });
});


describe('UserDetail', () => {
  const user = props => ({
    id: 7, user_name: 'carol', full_name: 'Carol', email: 'carol@example.com', kind: 'human', status: 'active',
    is_admin: false, is_admin_from_env: false, login_type: 'LDAP', created_date: '2026-01-01T00:00:00Z',
    last_login_at: '2026-10-01T00:00:00Z', active_tokens: 0, ...props,
  });

  it('signs users out everywhere, after asking', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/users/7': { user: user(), tokens: [], audit: [] },
      'POST /api/v1/admin/users/7/revoke-sessions': { revoked: 3 },
    });
    renderAt('/admin/users/7', <UserDetail id="7" me={admin}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/Their tokens and CLI sign-ins keep working/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/users/7/revoke-sessions')).toHaveLength(1));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Signed carol out of 3 sessions' })));
  });

  it("shows pending users' message", async () => {
    mockApi({
      'GET /api/v1/admin/users/7': { user: user({ status: 'pending' }), tokens: [], audit: [], access_request: request() },
    });
    renderAt('/admin/users/7', <UserDetail id="7" me={admin}/>);
    expect(await screen.findByText('I join the camera team next week')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});
