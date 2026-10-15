/**
 * Tests for the login gate and button.
 * Run with: cd webapp && npm test -- PrivateContent
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import PrivateContent from '../PrivateContent';
import { renderWithProviders } from '../../../test-utils';
import { userQuery } from '../../../api/queries';
import { toaster } from '../../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Until we know who users are, the button is a disabled placeholder
const openLogin = async () => {
  const button = await waitFor(() => {
    const button = screen.getByRole('button', { name: 'Log in' });
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

  it('asks logged-out users to log in, even when a parent passes enabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent enabled={false}>secret</PrivateContent>, { siteConfig: { login_required: true } });
    expect(await screen.findByText('The content is available for logged-in users only.')).toBeInTheDocument();
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

  it('logs users in', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com' })
      : json({ is_authenticated: false }));
    const { queryClient } = renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.change(dialog.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('secret')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/v1/user/auth/' && init.method === 'POST')).toBe(true);
    expect(queryClient.getQueryData(userQuery.queryKey)).toMatchObject({ is_logged: true, user_name: 'alice', full_name: 'Alice' });
  });

  it('shows why the login failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'invalid-password' }, 401)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByText('The password is incorrect.')).toBeInTheDocument());
  });

  it("gives the site's advice when the login fails", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? json({ error: 'invalid-username' }, 401)
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true, login_hint: 'Use your Windows credentials.' } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByText('This username does not match any user account. Use your Windows credentials.')).toBeInTheDocument());
  });

  it('says why users could not log in when the server fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url === '/api/v1/user/auth/'
      ? Promise.resolve(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
      : json({ is_authenticated: false }));
    renderWithProviders(<PrivateContent>secret</PrivateContent>, { siteConfig: { login_required: true } });
    const dialog = await openLogin();
    fireEvent.click(dialog.getByRole('button', { name: 'Log in' }));
    // the toaster is mocked in setupTests.js
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Could not log in: .*502/) })));
  });
});
