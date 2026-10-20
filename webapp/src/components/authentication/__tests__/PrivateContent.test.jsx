/**
 * Tests for the login gate and button.
 * Run with: cd webapp && npm test -- PrivateContent
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import PrivateContent from '../PrivateContent';
import AuthButton from '../Auth';
import { renderWithProviders } from '../../../test-utils';
import { userQuery, logged_out_user } from '../../../api/queries';
import { toaster } from '../../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Until we know who users are, the button is a disabled placeholder
const openLogin = async () => {
  const button = await waitFor(() => {
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeEnabled();
    return button;
  });
  fireEvent.click(button);
  return within(await screen.findByRole('dialog'));
};

const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com' };

describe('PrivateContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the content when the server does not require a login', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: false } });
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('asks signed-out users to sign in, even when a parent passes enabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent enabled={false}>secret</PrivateContent>, { siteConfig: { login_required: true } });
    expect(await screen.findByText('Sign in to see the content.')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/user/me/');
  });

  it('checks again the auth of logged-out users', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: true, user_id: 1, user_name: 'alice' }));
    // e.g. the session was restored from the cache, but the user logged in meanwhile
    renderWithProviders(<PrivateContent>secret</PrivateContent>, {
      siteConfig: { login_required: true },
      user: { is_logged: false },
    });
    expect(await screen.findByText('secret')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalled();
  });

  it('shows the content to logged-in users', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: true, user_name: 'alice' }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true }, user: alice });
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('signs users in', async () => {
    // after logging in, we ask who we are again: e.g. whether we are an admin
    let logged = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (url !== '/api/v1/user/auth/')
        return json(logged ? { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', is_admin: true } : { is_authenticated: false });
      logged = true;
      return json({ user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com' });
    });
    const { queryClient } = renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.change(dialog.getByLabelText('User name'), { target: { value: 'alice' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('secret')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/v1/user/auth/' && init.method === 'POST')).toBe(true);
    expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: true, user_name: 'alice', full_name: 'Alice' });
    await waitFor(() => expect(queryClient.getQueryData(userQuery.queryKey).is_admin).toBe(true));
  });

  it("shows the server's sentence when signing in fails", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'Wrong user name or password.', reason: 'invalid_credentials' }, 403)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true, login_hint: 'Use your Windows credentials.' } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Wrong user name or password. Use your Windows credentials.')).toBeInTheDocument());
    expect(toaster.show).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Could not sign in/) }));
  });

  it("says why accounts can't sign in", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'Your account is waiting for an admin.', reason: 'user_pending' }, 403)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Your account is waiting for an admin.');
  });

  it('tells disabled users why they see nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ error: 'Your account was disabled by an admin.', reason: 'user_disabled' }, 401));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { require_sign_in: true } });
    expect(await screen.findByText('Your account was disabled by an admin.')).toBeInTheDocument();
    expect(screen.getByText('Your account is disabled')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  // GET /api/v1/user/me/ for a session whose user was disabled: 200, once, then the session is closed
  const disabled_me = { is_authenticated: false, is_anonymous: true, is_active: false, reason: 'user_disabled', error: 'An admin disabled this account.' };
  const anonymous_me = { is_authenticated: false, is_anonymous: true, is_active: false };

  it('tells disabled users why they were signed out, from a 200 answer, and remembers it', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(calls++ === 0 ? disabled_me : anonymous_me));
    const { queryClient } = renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { require_sign_in: true } });
    expect(await screen.findByText('An admin disabled this account.')).toBeInTheDocument();
    expect(screen.getByText('Your account is disabled')).toBeInTheDocument();
    // the next answers are plain anonymous: we keep saying why until users sign in again
    await queryClient.refetchQueries({ queryKey: userQuery.queryKey });
    expect(calls).toBe(2);
    expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: false, reason: 'user_disabled', error: 'An admin disabled this account.' });
    expect(screen.getByText('An admin disabled this account.')).toBeInTheDocument();
  });

  it('says pending accounts wait for approval, also when signing in is optional', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ ...anonymous_me, reason: 'user_pending', error: 'An admin needs to approve this account.' }));
    renderWithProviders(<><PrivateContent>secret</PrivateContent><AuthButton/></>, { siteConfig: { require_sign_in: false } });
    // the content is public, the button says why users are signed out
    expect(screen.getByText('secret')).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Account pending' });
    fireEvent.click(button);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('alert')).toHaveTextContent('Your account is pending approval');
    expect(dialog.getByRole('alert')).toHaveTextContent('An admin needs to approve this account.');
    expect(dialog.getByRole('alert')).toHaveClass('bp6-intent-warning');
  });

  it('forgets the reason once users sign in again', async () => {
    let signed_in = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (url === '/api/v1/user/auth/') { signed_in = true; return json({ user_id: 2, user_name: 'bob' }); }
      return json(signed_in ? { is_authenticated: true, user_id: 2, user_name: 'bob' } : anonymous_me);
    });
    const { queryClient } = renderWithProviders(<AuthButton/>, {
      siteConfig: { require_sign_in: false },
      user: { ...logged_out_user, reason: 'user_disabled', error: 'An admin disabled this account.' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Account disabled' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('User name'), { target: { value: 'bob' } });
    fireEvent.change(dialog.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: true, user_name: 'bob' }));
    expect(queryClient.getQueryData(userQuery.queryKey).reason).toBeUndefined();
  });

  it('shows why signing in failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'invalid-password' }, 401)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('The password is incorrect.')).toBeInTheDocument());
  });

  it("gives the site's advice when signing in fails", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'invalid-username' }, 401)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true, login_hint: 'Use your Windows credentials.' } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('This user name does not match any account. Use your Windows credentials.')).toBeInTheDocument());
  });

  it('says why users could not sign in when the server fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? Promise.resolve(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }));
    // the toaster is mocked in setupTests.js
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Could not sign in: .*502/) })));
  });
});
