/**
 * /settings: tabs in the URL, the profile, preferences and activity.
 * Run with: cd webapp && npm test -- SettingsPage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch } from '../../router';
import { matchAppRoute } from '../../routes';
import { SettingsPage, tabs } from '../SettingsPage';
import { usePrefsStore } from '../../stores/prefs';
import { actionLabel } from '../format';
import { renderWithProviders } from '../../test-utils';

const json = data => Promise.resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'LDAP', is_admin: true };

const Page = () => {
  const { match } = matchAppRoute(history.location.pathname);
  return <RouteMatch match={match}><SettingsPage/></RouteMatch>;
};
const renderAt = (pathname, user = alice) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}><Page/></HistoryRouter>, { user, siteConfig: {} });
};

afterEach(() => vi.restoreAllMocks());


test('shows the profile by default, and tabs change the URL', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tokens: [] }));
  renderAt('/settings');
  expect(screen.getByRole('tab', { name: 'Profile', selected: true })).toBeInTheDocument();
  expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('tab', { name: 'Access tokens' }));
  expect(history.location.pathname).toBe('/settings/tokens');
});

test("shows users' picture and job from their sign-in, and where they come from", async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tokens: [] }));
  renderAt('/settings', {
    ...alice, login_type: 'OIDC', avatar_url: '/api/v1/users/1/picture?v=ab12cd34',
    profile: { title: 'Image quality engineer', department: 'Camera', organization: 'Example Corp', picture_source: 'Single sign-on', updated_at: '2026-11-01T10:00:00Z' },
  });
  const profile = within(screen.getByRole('region', { name: 'Profile' }));
  expect(profile.getByRole('img', { name: 'Alice' })).toHaveAttribute('src', '/api/v1/users/1/picture?v=ab12cd34');
  expect(profile.getByText('Image quality engineer · Camera · Example Corp')).toBeInTheDocument();
  expect(profile.getByTestId('profile-source')).toHaveTextContent(/^From Single sign-on, updated at each sign-in\. Last updated/);
});

test("without a picture, uses the site's template, else initials", async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tokens: [] }));
  act(() => history.replace('/settings'));
  renderWithProviders(<HistoryRouter history={history}><Page/></HistoryRouter>, { user: { ...alice, avatar_url: null }, siteConfig: { avatar_url_template: 'https://directory.example.com/{user_name}.jpg' } });
  const profile = within(screen.getByRole('region', { name: 'Profile' }));
  expect(profile.getByRole('img', { name: 'Alice' })).toHaveAttribute('src', 'https://directory.example.com/alice.jpg');
  // nothing from the sign-in: nothing to explain
  expect(profile.queryByTestId('profile-source')).not.toBeInTheDocument();
});

// else /settings/<tab> would be a project's page
test('each tab has its URL', () => {
  for (const { id } of tabs)
    expect(matchAppRoute(`/settings/${id}`)?.match.params.tab).toBe(id);
});

test('tabs scroll sideways on narrow screens, instead of the page', () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tokens: [] }));
  renderAt('/settings');
  expect(getComputedStyle(screen.getByRole('tablist').closest('.bp6-tabs').parentElement).overflowX).toBe('auto');
  expect(screen.getByRole('tab', { name: 'CLI sign-ins' })).toBeInTheDocument();
});

test('preferences use the same store as the pages', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}));
  const before = usePrefsStore.getState();
  renderAt('/settings/preferences');
  expect(screen.getByText(/follow you in every browser/)).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Commit list density' })).getByRole('radio', { name: 'Compact' }));
  expect(usePrefsStore.getState().commitListDensity).toBe('compact');
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Run cards density' })).getByRole('radio', { name: 'Compact' }));
  expect(usePrefsStore.getState().outputCardDensity).toBe('compact');
  fireEvent.click(screen.getByRole('radio', { name: /^Never/ }));
  expect(usePrefsStore.getState().runNameOrigin).toBe('never');
  usePrefsStore.setState({ commitListDensity: before.commitListDensity, outputCardDensity: before.outputCardDensity, runNameOrigin: before.runNameOrigin });
});

test('activity loads older events on demand', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.includes('before_id=10')
    ? json({ events: [{ id: 9, created_at: '2026-09-01T00:00:00Z', action: 'auth.login', actor_kind: 'user', actor_user_id: 1, actor_label: 'alice', ip: '10.0.0.2' }], next_before_id: null })
    : json({ events: [
      { id: 11, created_at: '2026-10-01T00:00:00Z', action: 'token.create', actor_kind: 'user', actor_user_id: 1, actor_label: 'alice', target_type: 'token', target_id: '3', target_label: 'ci-bot' },
      { id: 10, created_at: '2026-10-01T00:00:00Z', action: 'user.disabled', actor_kind: 'user', actor_user_id: 2, actor_label: 'root', target_type: 'user', target_id: '1', target_label: 'alice' },
    ], next_before_id: 10 }));
  renderAt('/settings/activity');
  expect(await screen.findByText('Created a token')).toBeInTheDocument();
  expect(screen.getByText(/ci-bot/)).toBeInTheDocument();
  // what others did to the account says who
  expect(screen.getByText(/by root/)).toBeInTheDocument();
  expect(screen.queryByText(/by alice/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Signed in')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
  expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/user/audit?before_id=10&limit=50');
});

test('signed-out users go to the sign-in page, then come back', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ is_authenticated: false }));
  renderAt('/settings/tokens', null);
  await waitFor(() => expect(history.location.pathname).toBe('/login'));
  expect(history.location.search).toBe('?next=%2Fsettings%2Ftokens');
});

test('failed sign-ins say which user name was tried, and why it failed', async () => {
  // backend/audit.py serialize(), for auth.login_failed (api/auth.py)
  const failed = reason => ({
    id: reason.length, created_at: '2026-10-01T00:00:00Z', actor_kind: 'anonymous', actor_user_id: null, actor_token_id: null, actor_label: null,
    ip: '10.0.0.9', user_agent: 'Mozilla/5.0', action: 'auth.login_failed', target_type: 'user', target_id: '1', target_label: 'alice',
    project_id: null, changes: {}, meta: { reason, login_type: 'LOCAL' },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ events: [
    failed('invalid-password'), failed('pending'),
    { id: 20, created_at: '2026-10-01T00:00:00Z', actor_kind: 'anonymous', actor_user_id: null, actor_token_id: null, actor_label: null, ip: '10.0.0.8', user_agent: null, action: 'auth.signup', target_type: 'user', target_id: '1', target_label: 'alice', project_id: null, changes: {}, meta: {} },
  ], next_before_id: null }));
  renderAt('/settings/activity');
  const items = (await screen.findAllByRole('listitem')).map(item => item.textContent);
  expect(items[0]).toMatch(/Failed to sign in as alice: wrong password/);
  expect(items[0]).toMatch(/from 10\.0\.0\.9/);
  expect(items[0]).not.toMatch(/by /);
  expect(items[1]).toMatch(/pending account/);
  expect(items[2]).toMatch(/by someone not signed in/);
});

test('audit actions are said in words', () => {
  expect(actionLabel('auth.login')).toBe('Signed in');
  expect(actionLabel('device.approve')).toBe('Approved a CLI sign-in');
  expect(actionLabel('batch.delete')).toBe('Deleted a batch');
  expect(actionLabel('token.revoke')).toBe('Revoked a token');
  expect(actionLabel('group.rule_changed')).toBe('Group: rule changed');
});
