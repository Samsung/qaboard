/**
 * Settings → Access tokens: the list with what users need to know, creating a token (its secret is shown once),
 * revoking one.
 * Run with: cd webapp && npm test -- settings
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DateTime } from 'luxon';

import { TokensTab } from '../TokensTab';
import { CliTab } from '../CliTab';
import { TokenStatusTags } from '../tokens';
import { renderWithProviders } from '../../test-utils';
import { copyWithToast } from '../../utils/clipboard';

vi.mock('../../utils/clipboard', () => ({ copyWithToast: vi.fn(), copyText: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const in_days = days => DateTime.utc().plus({ days }).toISO();

const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', is_admin: false };
const token = (props) => ({
  id: 1, name: 'ci-bot', kind: 'personal', prefix: 'qab_pat_Xk3f', scopes: ['read', 'ingest'], projects: [],
  created_at: in_days(-10), expires_at: in_days(80), idle_expiry_days: null, last_used_at: in_days(-1), last_used_ip: '10.0.0.7',
  revoked_at: null, status: 'active', data: {}, ...props,
});

// GET /api/v1/user/tokens answers `tokens`, POST creates `created`
const mockApi = ({ tokens = [], created, create_error } = {}) => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
  if (url === '/api/v1/user/tokens' && init?.method === 'POST')
    return create_error ? json(create_error, 400) : json(created, 201);
  if (url === '/api/v1/user/tokens') return json({ tokens });
  if (url.startsWith('/api/v1/user/tokens/') && init?.method === 'DELETE') return json({ ...tokens[0], status: 'revoked' });
  return json({});
});

afterEach(() => vi.restoreAllMocks());


describe('TokenStatusTags', () => {
  const tags = props => {
    const { container } = renderWithProviders(<TokenStatusTags token={token(props)}/>);
    return container.textContent;
  };
  it('says whether tokens can be used', () => {
    expect(tags({})).toBe('Active');
    expect(tags({ status: 'revoked', revoked_at: in_days(-1) })).toBe('Revoked');
    expect(tags({ status: 'expired', expires_at: in_days(-1) })).toBe('Expired');
    expect(tags({ status: 'idle_expired', idle_expiry_days: 180 })).toBe('Expired: unused');
  });
  it('warns before they expire, and about legacy tokens', () => {
    expect(tags({ expires_at: in_days(3.5) })).toBe('Expires in 3 days');
    expect(tags({ expires_at: in_days(0.5) })).toBe('Expires within a day');
    expect(tags({ kind: 'legacy', scopes: [], expires_at: null })).toBe('legacy: all scopesActive');
  });
});


describe('TokensTab', () => {
  it('lists tokens with their scopes, projects and last use', async () => {
    mockApi({ tokens: [
      token({ id: 1, projects: ['group/*'] }),
      token({ id: 2, name: 'old', kind: 'legacy', scopes: [], expires_at: null, last_used_at: null }),
      token({ id: 3, name: 'laptop', kind: 'cli', data: { hostname: 'host-12' } }),
      token({ id: 4, name: 'gone', status: 'revoked' }),
    ] });
    renderWithProviders(<TokensTab user={alice}/>);
    const row = within(await screen.findByTestId('token-1'));
    expect(row.getByText('ci-bot')).toBeInTheDocument();
    expect(row.getByText('qab_pat_Xk3f…')).toBeInTheDocument();
    expect(row.getByText('ingest')).toBeInTheDocument();
    expect(row.getByText('group/*')).toBeInTheDocument();
    expect(row.getByText('from 10.0.0.7')).toBeInTheDocument();
    expect(within(screen.getByTestId('token-2')).getByText('Never used')).toBeInTheDocument();
    // a nudge to replace legacy tokens
    expect(screen.getByText('You have a legacy token')).toBeInTheDocument();
    // CLI logins are in their own tab, revoked tokens hidden until asked
    expect(screen.queryByTestId('token-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('token-4')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show revoked and expired tokens (1)'));
    expect(within(screen.getByTestId('token-4')).getByText('Revoked')).toBeInTheDocument();
    expect(within(screen.getByTestId('token-4')).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it('says what tokens are for when there is none', async () => {
    mockApi({ tokens: [] });
    renderWithProviders(<TokensTab user={alice}/>);
    expect(await screen.findByText('No access tokens yet')).toBeInTheDocument();
  });

  it('creates a token and shows its secret once', async () => {
    const secret = 'qab_pat_0123456789abcdefghijABCDEFGHIJ0123456789xyzXYZ';
    const fetch = mockApi({ tokens: [], created: { ...token({ id: 9, name: 'nightly' }), token: secret } });
    renderWithProviders(<TokensTab user={alice}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a token' }));
    const dialog = within(await screen.findByRole('dialog'));
    // only admins can give the admin scope
    expect(dialog.queryByText('Admin')).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Create token' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: ' nightly ' } });
    fireEvent.click(dialog.getByRole('checkbox', { name: /Act/ }));
    fireEvent.click(dialog.getByRole('radio', { name: '1 year' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create token' }));

    expect(await dialog.findByText('Copy your token now')).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([url, init]) => url === '/api/v1/user/tokens' && init?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'nightly', scopes: ['read', 'ingest', 'act'], projects: [], expires_in_days: 365 });
    expect(dialog.getByDisplayValue(secret)).toBeInTheDocument();
    expect(dialog.getByText(`export QABOARD_TOKEN=${secret}`)).toBeInTheDocument();
    expect(dialog.getByText(/qa auth login --with-token/)).toBeInTheDocument();
    expect(dialog.getByText(/Authorization: Bearer/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Copy' }));
    expect(copyWithToast).toHaveBeenCalledWith(secret, expect.anything());

    // once closed, the secret is gone
    fireEvent.click(dialog.getByRole('button', { name: 'I copied it, close' }));
    await waitFor(() => expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    const again = within(await screen.findByRole('dialog'));
    expect(again.getByRole('button', { name: 'Create token' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  });

  it("says why the server refused, e.g. tokens can't live forever", async () => {
    mockApi({ tokens: [], create_error: { error: 'Tokens expire after 365 days at most on this server.' } });
    renderWithProviders(<TokensTab user={{ ...alice, is_admin: true }}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a token' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('checkbox', { name: /Admin/ })).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'forever' } });
    fireEvent.click(dialog.getByRole('radio', { name: 'No expiry' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create token' }));
    const alert = await dialog.findByRole('alert');
    expect(alert).toHaveTextContent('Tokens expire after 365 days at most on this server.');
    expect(alert).toHaveTextContent('Choose an expiry date and try again.');
  });

  it('revokes tokens after asking', async () => {
    const fetch = mockApi({ tokens: [token({ id: 7 })] });
    renderWithProviders(<TokensTab user={alice}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke ci-bot' }));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(alert.getByText(/will stop working/)).toBeInTheDocument();
    fireEvent.click(alert.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/user/tokens/7', expect.objectContaining({ method: 'DELETE' })));
  });
});


describe('CliTab', () => {
  it('lists CLI logins by computer, with how to log in', async () => {
    mockApi({ tokens: [token({ id: 1 }), token({ id: 3, name: 'qa CLI on host-12', kind: 'cli', data: { client: 'qa CLI', hostname: 'host-12' }, expires_at: null, idle_expiry_days: 180 })] });
    renderWithProviders(<CliTab/>);
    const row = within(await screen.findByTestId('token-3'));
    expect(row.getByText('host-12')).toBeInTheDocument();
    expect(row.getByText('After 180 days unused')).toBeInTheDocument();
    expect(screen.queryByTestId('token-1')).not.toBeInTheDocument();
    expect(screen.getByText('qa auth login')).toBeInTheDocument();
  });
});
