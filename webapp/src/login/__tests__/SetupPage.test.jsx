/**
 * A new server's first admin: /setup, the sign-in page that points there, and changing a local account's password.
 * Run with: cd webapp && npm test -- SetupPage
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { matchAppRoute } from '../../routes';
import { SetupPage } from '../SetupPage';
import { LoginPage } from '../LoginPage';
import { ChangePassword } from '../../settings/SignInTab';
import { renderWithProviders } from '../../test-utils';
import { toaster } from '../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));

const renderAt = (url, ui, options) => {
  act(() => history.replace(url));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, options);
};

const open_setup = { open: true, default_user_name: 'admin', min_password_length: 8 };
const fill = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => vi.restoreAllMocks());


describe('SetupPage', () => {
  it('has its URL', () => {
    expect(matchAppRoute('/setup')?.route.main).toBeDefined();
  });

  it('creates the first admin with the setup token, then goes to the admin panel', async () => {
    const fetch = mockApi({
      'GET /api/v1/setup': open_setup,
      'POST /api/v1/setup': (url, init) => [{ user_id: 1, user_name: JSON.parse(init.body).user_name, is_admin: true, status: 'active' }, 201],
    });
    renderAt('/setup', <SetupPage/>);
    expect(await screen.findByLabelText('Setup token')).toBeInTheDocument();
    expect(screen.getByLabelText('User name')).toHaveValue('admin');
    // it says where the token is
    expect(screen.getByText('qaboard-admin setup-token')).toBeInTheDocument();
    fill('Setup token', 'abcd-ef01');
    fill('Password', 'correct-horse');
    fill('Password, again', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: 'Create the admin account' }));
    await waitFor(() => expect(history.location.pathname).toBe('/admin/overview'));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/setup')[0][1].body)).toEqual(expect.objectContaining({
      token: 'abcd-ef01', user_name: 'admin', password: 'correct-horse',
    }));
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("you're QA-Board's admin") }));
  });

  it('checks both passwords match before sending them', async () => {
    const fetch = mockApi({ 'GET /api/v1/setup': open_setup });
    renderAt('/setup', <SetupPage/>);
    await screen.findByLabelText('Setup token');
    fill('Setup token', 'abcd');
    fill('Password', 'correct-horse');
    fill('Password, again', 'correct-hoarse');
    fireEvent.click(screen.getByRole('button', { name: 'Create the admin account' }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(calls(fetch, 'POST', '/api/v1/setup')).toHaveLength(0);
  });

  it('shows the server\'s errors next to their field', async () => {
    mockApi({
      'GET /api/v1/setup': open_setup,
      'POST /api/v1/setup': () => [{ error: "This isn't the setup token.", reason: 'invalid_setup_token', field: 'token' }, 403],
    });
    renderAt('/setup', <SetupPage/>);
    await screen.findByLabelText('Setup token');
    fill('Setup token', 'wrong');
    fill('Password', 'correct-horse');
    fill('Password, again', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: 'Create the admin account' }));
    expect(await screen.findByText("This isn't the setup token.")).toBeInTheDocument();
    expect(history.location.pathname).toBe('/setup');
  });

  it('says when the server is already set up', async () => {
    mockApi({ 'GET /api/v1/setup': { open: false } });
    renderAt('/setup', <SetupPage/>);
    expect(await screen.findByText('QA-Board is set up')).toBeInTheDocument();
    expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
  });
});


describe('LoginPage on a new server', () => {
  it('points to the setup page, and offers no sign-up', async () => {
    mockApi({
      'GET /api/v1/user/me/': { is_authenticated: false },
      'GET /api/v1/auth/providers': { providers: [], password_form: true, local_signup: true, auto_redirect: false, setup_required: true },
    });
    renderAt('/login', <LoginPage/>);
    const link = await screen.findByRole('link', { name: 'Set up QA-Board' });
    expect(link).toHaveAttribute('href', '/setup');
    expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
  });
});


describe('ChangePassword', () => {
  it('changes the password of local accounts', async () => {
    const fetch = mockApi({ 'POST /api/v1/user/password': { signed_out: 2 } });
    renderAt('/settings/sign-in', <ChangePassword/>);
    const form = within(screen.getByRole('form', { name: 'Change your password' }));
    fireEvent.change(form.getByLabelText('Current password'), { target: { value: 'old-password' } });
    fireEvent.change(form.getByLabelText('New password'), { target: { value: 'new-password' } });
    fireEvent.change(form.getByLabelText('New password, again'), { target: { value: 'new-password' } });
    fireEvent.click(form.getByRole('button', { name: 'Change the password' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/user/password')).toHaveLength(1));
    expect(JSON.parse(calls(fetch, 'POST', '/api/v1/user/password')[0][1].body)).toEqual({ current_password: 'old-password', new_password: 'new-password' });
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Changed your password, and signed out 2 other browsers' })));
  });

  it('shows a wrong current password next to it', async () => {
    mockApi({ 'POST /api/v1/user/password': () => [{ error: 'Your current password is wrong.', field: 'current_password' }, 403] });
    renderAt('/settings/sign-in', <ChangePassword/>);
    const form = within(screen.getByRole('form', { name: 'Change your password' }));
    fireEvent.change(form.getByLabelText('Current password'), { target: { value: 'nope' } });
    fireEvent.change(form.getByLabelText('New password'), { target: { value: 'new-password' } });
    fireEvent.change(form.getByLabelText('New password, again'), { target: { value: 'new-password' } });
    fireEvent.click(form.getByRole('button', { name: 'Change the password' }));
    expect(await form.findByText('Your current password is wrong.')).toBeInTheDocument();
  });
});
