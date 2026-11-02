/**
 * /login: single sign-on buttons, the password form, auto-redirects, errors from the server, and pending accounts.
 * Run with: cd webapp && npm test -- LoginPage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { LoginPage } from '../LoginPage';
import { PendingAccount } from '../PendingAccount';
import { goTo, safeNext, loginUrl } from '../api';
import { renderWithProviders } from '../../test-utils';
import { userQuery, logged_out_user } from '../../api/queries';
import { toaster } from '../../toaster';

// full-page navigations, to the identity providers
vi.mock('../api', async importOriginal => ({ ...await importOriginal(), goTo: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// backend/sign_in/providers.py Provider.public()
const provider = props => ({ type: 'oidc', kind: 'redirect', recommended: false, ...props, start_url: `/api/v1/auth/oidc/${props.id}/start${props.next ? `?next=${encodeURIComponent(props.next)}` : ''}` });
const options = ({ next, ...props } = {}) => ({
  providers: [
    provider({ id: 'github', name: 'GitHub', next }),
    provider({ id: 'sso', name: 'Company SSO', recommended: true, next }),
    { id: 'ldap', type: 'ldap', kind: 'password', name: 'Directory account (LDAP)', recommended: false, start_url: null },
  ],
  password_form: true,
  local_signup: false,
  auto_redirect: false,
  ...props,
});
const anonymous_me = { is_authenticated: false, is_anonymous: true, is_active: false };

// Answers by "METHOD /path"
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});

const renderAt = (url, { user, siteConfig = {} } = {}) => {
  act(() => history.replace(url));
  return renderWithProviders(<HistoryRouter history={history}><LoginPage/></HistoryRouter>, { user, siteConfig });
};
const signInWith = (username, password) => {
  const form = within(screen.getByRole('form', { name: 'Sign in with a user name and password' }));
  fireEvent.change(form.getByLabelText('User name'), { target: { value: username } });
  fireEvent.change(form.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(form.getByRole('button', { name: 'Sign in' }));
};

afterEach(() => {
  vi.restoreAllMocks();
  goTo.mockClear();
});


test('next only goes to our own pages', () => {
  expect(safeNext('/group/project?x=1')).toBe('/group/project?x=1');
  expect(safeNext('//evil.example')).toBeNull();
  expect(safeNext('https://evil.example')).toBeNull();
  expect(safeNext('/\\evil.example')).toBeNull();
  expect(safeNext('/login?next=/x')).toBeNull();
  expect(loginUrl('/device?code=WDJB-MJHT')).toBe('/login?next=%2Fdevice%3Fcode%3DWDJB-MJHT');
  expect(loginUrl('/')).toBe('/login');
});

describe('LoginPage', () => {
  it('shows the single sign-ons first, the recommended one as the main button, then the password form', async () => {
    const fetch = mockApi({ 'GET /api/v1/auth/providers': options({ next: '/group/project', local_signup: true }), 'GET /api/v1/user/me/': anonymous_me });
    renderAt('/login?next=%2Fgroup%2Fproject');
    const sso = await screen.findByRole('button', { name: 'Company SSO' });
    const github = screen.getByRole('button', { name: 'GitHub' });
    const or = screen.getByText('or');
    const form = screen.getByRole('form', { name: 'Sign in with a user name and password' });
    const order = [sso, github, or, form];
    for (let i = 1; i < order.length; i++)
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sso).toHaveClass('bp6-intent-primary');
    expect(github).not.toHaveClass('bp6-intent-primary');
    expect(within(form).getByRole('button', { name: 'Sign in' })).not.toHaveClass('bp6-intent-primary');
    // they come back to the page
    expect(sso).toHaveAttribute('href', '/api/v1/auth/oidc/sso/start?next=%2Fgroup%2Fproject');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/auth/providers?next=%2Fgroup%2Fproject');
    expect(screen.getByRole('button', { name: 'Create one' })).toBeInTheDocument();
    expect(goTo).not.toHaveBeenCalled();
  });

  it('the password form is the main action without single sign-on', async () => {
    mockApi({ 'GET /api/v1/auth/providers': options({ providers: [] }), 'GET /api/v1/user/me/': anonymous_me });
    renderAt('/login');
    const form = await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    expect(within(form).getByRole('button', { name: 'Sign in' })).toHaveClass('bp6-intent-primary');
    expect(screen.queryByText('or')).not.toBeInTheDocument();
  });

  it('asks for the password form with ?local=1', async () => {
    const fetch = mockApi({ 'GET /api/v1/auth/providers': options(), 'GET /api/v1/user/me/': anonymous_me });
    renderAt('/login?local=1&next=%2Fadmin');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/auth/providers?next=%2Fadmin&local=1');
  });

  it('signs in with a password, then goes to next', async () => {
    let signed_in = false;
    const fetch = mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': () => [signed_in ? { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', is_admin: true } : anonymous_me, 200],
      'POST /api/v1/user/auth/': () => { signed_in = true; return [{ user_id: 1, user_name: 'alice', full_name: 'Alice', status: 'active', is_admin: true }, 200]; },
    });
    const { queryClient } = renderAt('/login?next=%2Fgroup%2Fproject%2Fcommits%3Fbranch%3Ddev');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('alice', 'secret');
    await waitFor(() => expect(history.location.pathname).toBe('/group/project/commits'));
    expect(history.location.search).toBe('?branch=dev');
    const [, init] = fetch.mock.calls.find(([url, init]) => url === '/api/v1/user/auth/' && init.method === 'POST');
    expect(init.body.get('username')).toBe('alice');
    expect(init.body.get('password')).toBe('secret');
    expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: true, user_name: 'alice', is_admin: true });
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Welcome, Alice' }));
  });

  it("loads the server's own pages after signing in, like pgAdmin", async () => {
    let signed_in = false;
    mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': () => [signed_in ? { is_authenticated: true, user_id: 1, user_name: 'alice', is_admin: true } : anonymous_me, 200],
      'POST /api/v1/user/auth/': () => { signed_in = true; return [{ user_id: 1, user_name: 'alice', status: 'active', is_admin: true }, 200]; },
    });
    renderAt('/login?next=%2Fpgadmin4%2Fbrowser%2F');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('alice', 'secret');
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/pgadmin4/browser/'));
  });

  it("doesn't go to other sites after signing in", async () => {
    mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': anonymous_me,
      'POST /api/v1/user/auth/': { user_id: 1, user_name: 'alice', status: 'active' },
    });
    renderAt('/login?next=%2F%2Fevil.example%2F');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('alice', 'secret');
    await waitFor(() => expect(history.location.pathname).toBe('/'));
    expect(goTo).not.toHaveBeenCalled();
  });

  it("shows the server's sentence when signing in fails, with the site's advice", async () => {
    mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': anonymous_me,
      'POST /api/v1/user/auth/': () => [{ error: 'Wrong user name or password.', reason: 'invalid_credentials' }, 403],
    });
    renderAt('/login', { siteConfig: { login_hint: 'Use your Windows credentials.' } });
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('alice', 'wrong');
    expect(await screen.findByText('Wrong user name or password. Use your Windows credentials.')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
  });

  it("shows older servers' codes next to their field", async () => {
    mockApi({
      'GET /api/v1/auth/providers': () => [{ error: 'Not found' }, 404],
      'GET /api/v1/user/me/': anonymous_me,
      'POST /api/v1/user/auth/': () => [{ error: 'invalid-username' }, 401],
    });
    renderAt('/login');
    // servers without single sign-on: the password form
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('bob', 'secret');
    expect(await screen.findByText('This user name does not match any account.')).toBeInTheDocument();
  });

  it('says when the server fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? Promise.resolve(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
      : json(url.startsWith('/api/v1/auth/providers') ? options() : anonymous_me));
    renderAt('/login');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('alice', 'secret');
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not sign in: 502/);
  });

  it('goes straight to the only single sign-on with auto_redirect, and offers the password form', async () => {
    mockApi({
      'GET /api/v1/auth/providers': options({ providers: [provider({ id: 'sso', name: 'Company SSO', recommended: true, next: '/x' })], password_form: false, auto_redirect: true }),
      'GET /api/v1/user/me/': anonymous_me,
    });
    renderAt('/login?next=%2Fx');
    expect(await screen.findByText('Redirecting to Company SSO…')).toBeInTheDocument();
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/api/v1/auth/oidc/sso/start?next=%2Fx', { replace: true }));
    expect(screen.getByRole('link', { name: 'Sign in with a password instead' })).toHaveAttribute('href', '/login?next=%2Fx&local=1');
  });

  it("doesn't redirect after an error, and says what went wrong with a reference for admins", async () => {
    mockApi({
      'GET /api/v1/auth/providers': options({ providers: [provider({ id: 'sso', name: 'Company SSO', recommended: true })], password_form: false, auto_redirect: true }),
      'GET /api/v1/user/me/': anonymous_me,
    });
    renderAt('/login?error=sso_unavailable&ref=1234');
    expect(await screen.findByRole('button', { name: 'Company SSO' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("We couldn't reach Company SSO");
    expect(alert).toHaveTextContent('Try again in a minute; if it keeps failing, tell your admins.');
    expect(alert).toHaveTextContent('Reference: 1234');
    expect(goTo).not.toHaveBeenCalled();
    // break-glass admins
    expect(screen.getByRole('link', { name: 'Admins: sign in with a local account' })).toHaveAttribute('href', '/login?local=1');
  });

  it('names the provider the server says failed, among several', async () => {
    mockApi({ 'GET /api/v1/auth/providers': options(), 'GET /api/v1/user/me/': anonymous_me });
    renderAt('/login?error=sso_unavailable&ref=9&provider=github');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("We couldn't reach GitHub"));
  });

  it.each([
    ['sso_expired', 'Your sign-in took too long or started in another tab. Try again.'],
    ['not_allowed', "You signed in, but this QA-Board server doesn't accept your account."],
    ['user_disabled', 'Your account is disabled'],
    ['sso_misconfigured', 'Tell your admins: they need to fix it.'],
    ['something_new', "We couldn't sign you in"],
  ])('explains the error %s', async (code, message) => {
    mockApi({ 'GET /api/v1/auth/providers': options(), 'GET /api/v1/user/me/': anonymous_me });
    renderAt(`/login?error=${code}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText(/Reference/)).not.toBeInTheDocument();
  });

  it('sends signed-in users on', async () => {
    mockApi({ 'GET /api/v1/auth/providers': options(), 'GET /api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice' } });
    renderAt('/login?next=%2Fsettings', { user: { ...logged_out_user, is_logged: true, user_id: 1, user_name: 'alice' } });
    await waitFor(() => expect(history.location.pathname).toBe('/settings'));
  });

  it('forgets why the account was disabled once users sign in with another', async () => {
    let signed_in = false;
    mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': () => [signed_in ? { is_authenticated: true, user_id: 2, user_name: 'bob' } : anonymous_me, 200],
      'POST /api/v1/user/auth/': () => { signed_in = true; return [{ user_id: 2, user_name: 'bob', status: 'active' }, 200]; },
    });
    const { queryClient } = renderAt('/login', { user: { ...logged_out_user, reason: 'user_disabled', error: 'An admin disabled this account.' } });
    expect(await screen.findByText('An admin disabled this account.')).toBeInTheDocument();
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('bob', 'secret');
    await waitFor(() => expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: true, user_name: 'bob' }));
    expect(queryClient.getQueryData(userQuery.queryKey).reason).toBeUndefined();
  });

  it('shows pending users their request after signing in', async () => {
    let signed_in = false;
    mockApi({
      'GET /api/v1/auth/providers': options(),
      'GET /api/v1/user/me/': () => [signed_in
        ? { ...anonymous_me, reason: 'user_pending', error: "This account is waiting for an admin's approval.", pending: { user_name: 'carol', full_name: null, email: null, reviewers: [], request: { id: 1, message: '', status: 'pending', created_at: '2026-10-20T10:00:00Z' } } }
        : anonymous_me, 200],
      'POST /api/v1/user/auth/': () => { signed_in = true; return [{ user_id: 3, user_name: 'carol', status: 'pending' }, 200]; },
    });
    renderAt('/login?next=%2Fgroup%2Fproject');
    await screen.findByRole('form', { name: 'Sign in with a user name and password' });
    signInWith('carol', 'secret');
    expect(await screen.findByText('Your account is waiting for approval')).toBeInTheDocument();
    expect(screen.getByLabelText('Why do you need access?')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
  });
});


describe('PendingAccount', () => {
  const pending_user = request => ({
    ...logged_out_user, reason: 'user_pending', error: "This account is waiting for an admin's approval.",
    pending: { user_name: 'carol', full_name: 'Carol', email: 'carol@example.com', reviewers: ['Root', 'Dana'], request },
  });

  it('sends why users need access, and shows it', async () => {
    const fetch = mockApi({
      'POST /api/v1/user/access-request': (url, init) => [{ id: 1, kind: 'instance', message: JSON.parse(init.body).message, status: 'pending', created_at: '2026-10-20T10:00:00Z', decided_at: null }, 200],
    });
    const user = pending_user({ id: 1, kind: 'instance', message: '', status: 'pending', created_at: '2026-10-20T10:00:00Z', decided_at: null });
    const { queryClient } = renderWithProviders(<PendingAccount user={user}/>, { user });
    expect(screen.getByText('Waiting for an admin')).toBeInTheDocument();
    expect(screen.getByText(/Root and Dana review requests/)).toBeInTheDocument();
    // nothing to send yet
    fireEvent.click(screen.getByRole('button', { name: 'Send to the admins' }));
    expect(screen.getByText('Say why you need access, e.g. your team and your projects.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Why do you need access?'), { target: { value: ' I work on the camera team ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the admins' }));
    expect(await screen.findByText('Sent. The admins will see your message with your request.')).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/user/access-request');
    expect(JSON.parse(init.body)).toEqual({ message: 'I work on the camera team' });
    expect(queryClient.getQueryData(userQuery.queryKey).pending.request.message).toBe('I work on the camera team');
  });

  it('edits a message sent before, and shows the server errors', async () => {
    mockApi({ 'POST /api/v1/user/access-request': () => [{ error: 'Your account is already active.' }, 400] });
    const user = pending_user({ id: 1, kind: 'instance', message: 'Hello', status: 'pending', created_at: '2026-10-20T10:00:00Z', decided_at: null });
    renderWithProviders(<PendingAccount user={user}/>, { user });
    expect(screen.getByText('Hello')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit the message' }));
    fireEvent.change(screen.getByLabelText('Why do you need access?'), { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update the message' }));
    expect(await screen.findByText('Your account is already active.')).toBeInTheDocument();
  });
});
