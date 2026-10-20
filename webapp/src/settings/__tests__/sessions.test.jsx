/**
 * Settings → Sessions and Sign-in methods: revoking sessions (this browser signs out), unlinking sign-in methods.
 * Run with: cd webapp && npm test -- sessions
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { SessionsTab, describeUserAgent } from '../SessionsTab';
import { SignInTab } from '../SignInTab';
import { renderWithProviders } from '../../test-utils';
import { userQuery } from '../../api/queries';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice' };

// Answers by "METHOD /path"
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));

const renderAt = (url, ui) => {
  act(() => history.replace(url));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, { user: alice, siteConfig: {} });
};

afterEach(() => vi.restoreAllMocks());


const firefox = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const chrome_mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
// backend/sign_in/sessions.py serialize()
const session = props => ({ id: 1, current: false, provider_id: 'sso', created_at: '2026-10-01T10:00:00Z', last_seen_at: '2026-10-20T09:00:00Z', expires_at: '2027-03-30T10:00:00Z', ip: '10.0.0.5', user_agent: firefox, status: 'active', ...props });

test('user agents are said in words', () => {
  expect(describeUserAgent(firefox)).toBe('Firefox on Linux');
  expect(describeUserAgent(chrome_mac)).toBe('Chrome on macOS');
  expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0')).toBe('Edge on Windows');
  expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
  expect(describeUserAgent('curl/8.5.0')).toBe('curl');
  expect(describeUserAgent(null)).toBe('Unknown browser');
});

describe('Sessions', () => {
  it('lists the sessions, this browser first, and revokes another one', async () => {
    let revoked = false;
    const fetch = mockApi({
      'GET /api/v1/user/sessions': () => [{ sessions: revoked ? [session({ id: 2, current: true, user_agent: chrome_mac })] : [session({ id: 1 }), session({ id: 2, current: true, user_agent: chrome_mac, ip: '10.0.0.9' })] }, 200],
      'DELETE /api/v1/user/sessions/1': () => { revoked = true; return [session({ id: 1, status: 'revoked' }), 200]; },
    });
    renderAt('/settings/sessions', <SessionsTab/>);
    const rows = await screen.findAllByTestId(/^session-/);
    expect(rows.map(row => row.dataset.testid)).toEqual(['session-2', 'session-1']);
    expect(within(rows[0]).getByText('This browser')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Chrome on macOS')).toBeInTheDocument();
    expect(within(rows[1]).getByText('10.0.0.5')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('This browser')).not.toBeInTheDocument();

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Revoke Firefox on Linux from 10.0.0.5' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByTestId('session-1')).not.toBeInTheDocument());
    expect(calls(fetch, 'DELETE', '/api/v1/user/sessions/1')).toHaveLength(1);
    expect(history.location.pathname).toBe('/settings/sessions');
  });

  it('signs out everywhere else', async () => {
    let revoked = false;
    const fetch = mockApi({
      'GET /api/v1/user/sessions': () => [{ sessions: revoked ? [session({ id: 3, current: true })] : [session({ id: 1 }), session({ id: 2 }), session({ id: 3, current: true })] }, 200],
      'DELETE /api/v1/user/sessions': () => { revoked = true; return [{ revoked: 2 }, 200]; },
    });
    renderAt('/settings/sessions', <SessionsTab/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere else' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/every browser but this one/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign out everywhere else' }));
    await waitFor(() => expect(screen.queryByTestId('session-1')).not.toBeInTheDocument());
    expect(calls(fetch, 'DELETE', '/api/v1/user/sessions').filter(([url]) => url === '/api/v1/user/sessions')).toHaveLength(1);
    expect(screen.getByTestId('session-3')).toBeInTheDocument();
    // nothing else to sign out of
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out everywhere else' })).not.toBeInTheDocument());
  });

  it('signs out when revoking this browser', async () => {
    const fetch = mockApi({
      'GET /api/v1/user/sessions': { sessions: [session({ id: 2, current: true })] },
      'DELETE /api/v1/user/sessions/2': session({ id: 2, current: true, status: 'revoked' }),
    });
    const { queryClient } = renderAt('/settings/sessions', <SessionsTab/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of this browser' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/you'll be signed out here/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(history.location.search).toBe('?next=%2Fsettings%2Fsessions');
    expect(queryClient.getQueryData(userQuery.queryKey).is_logged).toBe(false);
    expect(calls(fetch, 'DELETE', '/api/v1/user/sessions/2')).toHaveLength(1);
  });
});


// backend/sign_in/identities.py serialize()
const identity = props => ({ id: 1, provider_id: 'ldap', provider_name: 'Directory account (LDAP)', provider_type: 'ldap', subject: 'alice', email: 'alice@example.com', created_at: '2026-01-01T00:00:00Z', last_login_at: '2026-10-19T08:00:00Z', ...props });
const keycloak = { id: 'keycloak', type: 'oidc', kind: 'redirect', name: 'Keycloak', recommended: false, start_url: '/api/v1/auth/oidc/keycloak/start' };

describe('Sign-in methods', () => {
  it("can't unlink the only one, and links others", async () => {
    mockApi({ 'GET /api/v1/user/identities': { identities: [identity()], linkable: [keycloak] } });
    renderAt('/settings/sign-in', <SignInTab/>);
    const unlink = await screen.findByRole('button', { name: 'Unlink Directory account (LDAP)' });
    expect(unlink).toBeDisabled();
    fireEvent.mouseEnter(unlink.parentElement);
    expect(await screen.findByText("It's your only way to sign in: link another one first.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link Keycloak' })).toHaveAttribute('href', '/api/v1/auth/oidc/keycloak/start?link=1');
  });

  it("unlinks one, and shows the server's refusal", async () => {
    const fetch = mockApi({
      'GET /api/v1/user/identities': { identities: [identity(), identity({ id: 2, provider_id: 'sso', provider_name: 'Company SSO', provider_type: 'oidc' })], linkable: [] },
      'DELETE /api/v1/user/identities/2': () => [{ error: "It's your only way to sign in: add another one first." }, 400],
    });
    renderAt('/settings/sign-in', <SignInTab/>);
    const unlink = await screen.findByRole('button', { name: 'Unlink Company SSO' });
    expect(unlink).toBeEnabled();
    fireEvent.click(unlink);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlink' }));
    expect(await screen.findByText("It's your only way to sign in: add another one first.")).toBeInTheDocument();
    expect(calls(fetch, 'DELETE', '/api/v1/user/identities/2')).toHaveLength(1);
  });

  it('says why linking failed, with the reference', async () => {
    mockApi({ 'GET /api/v1/user/identities': { identities: [identity()], linkable: [keycloak] } });
    renderAt('/settings/sign-in?error=sso_expired&ref=77', <SignInTab/>);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your sign-in took too long or started in another tab. Try again.');
    expect(alert).toHaveTextContent('Reference: 77');
  });

  it('names the provider that failed', async () => {
    mockApi({ 'GET /api/v1/user/identities': { identities: [identity()], linkable: [keycloak] } });
    renderAt('/settings/sign-in?error=sso_unavailable&ref=78&provider=keycloak', <SignInTab/>);
    // named once the sign-in methods are loaded
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("We couldn't reach Keycloak"));
  });
});
