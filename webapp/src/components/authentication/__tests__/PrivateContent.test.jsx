/**
 * Tests for the login gate and button. Signing in itself is on /login (login/__tests__/LoginPage.test.jsx).
 * Run with: cd webapp && npm test -- PrivateContent
 */
import { act, screen, fireEvent } from '@testing-library/react';

import PrivateContent from '../PrivateContent';
import AuthButton from '../Auth';
import { history } from '../../../router';
import { renderWithProviders } from '../../../test-utils';
import { userQuery } from '../../../api/queries';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com' };

describe('PrivateContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the content when the server does not require a login', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: false } });
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('sends signed-out users to the sign-in page, which comes back here, even when a parent passes enabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
    act(() => history.replace('/group/project/commits?branch=dev'));
    renderWithProviders(<PrivateContent enabled={false}>secret</PrivateContent>, { siteConfig: { login_required: true } });
    await vi.waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/group/project/commits?branch=dev');
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
    act(() => history.replace('/group/project'));
    renderWithProviders(<><PrivateContent>secret</PrivateContent><AuthButton/></>, { siteConfig: { require_sign_in: false } });
    // the content is public, the button says why users are signed out, and the sign-in page shows their request
    expect(screen.getByText('secret')).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Account pending' });
    expect(button).toHaveAttribute('href', '/login?next=%2Fgroup%2Fproject');
    fireEvent.click(button);
    expect(history.location.pathname).toBe('/login');
  });

  it('shows pending users their access request when signing in is required', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ ...anonymous_me, reason: 'user_pending', error: "This account is waiting for an admin's approval.", pending: {
      user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', reviewers: ['Root'],
      request: { id: 3, kind: 'instance', message: 'I work on the ISP team', status: 'pending', created_at: '2026-10-19T10:00:00Z', decided_at: null },
    } }));
    const { queryClient } = renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { require_sign_in: true } });
    expect(await screen.findByText('Your account is waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('I work on the ISP team')).toBeInTheDocument();
    expect(screen.getByText(/Root reviews requests/)).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(queryClient.getQueryData(userQuery.queryKey).pending.request.message).toBe('I work on the ISP team');
  });
});
