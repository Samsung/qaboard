/**
 * /device: users approve or deny the sign-ins `qa auth login` starts on their computers.
 * Run with: cd webapp && npm test -- DevicePage
 */
import { act, screen, fireEvent, waitFor } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { DevicePage, normalizeCode } from '../DevicePage';
import { renderWithProviders } from '../../test-utils';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice' };
// api/tokens.py serialize_device()
const request = { user_code: 'WDJB-MJHT', client_name: 'qa CLI on host-12', hostname: 'host-12', ip: '10.0.0.5', scopes: ['read', 'ingest', 'act'], created_at: '2026-10-20T10:00:00Z', expires_at: '2026-10-20T10:15:00Z', status: 'pending' };

const mockApi = ({ device = request, device_status = 200, answer = init => ({ status: JSON.parse(init.body).approve ? 'approved' : 'denied' }) } = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    if (url.startsWith('/api/v1/auth/device') && init.method === 'POST') return json(answer(init));
    if (url.startsWith('/api/v1/auth/device')) return json(device_status === 200 ? device : { error: 'Not found' }, device_status);
    return json({ is_authenticated: false });
  });

const renderAt = (pathname, user) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}><DevicePage/></HistoryRouter>, { user, siteConfig: {} });
};

afterEach(() => vi.restoreAllMocks());


test('codes are read however users type them', () => {
  expect(normalizeCode('wdjb mjht')).toBe('WDJB-MJHT');
  expect(normalizeCode('WDJB-MJHT')).toBe('WDJB-MJHT');
  expect(normalizeCode(null)).toBe('');
});

describe('DevicePage', () => {
  it('shows who asks for what, and approves', async () => {
    const fetch = mockApi();
    renderAt('/device?code=WDJB-MJHT', alice);
    expect(await screen.findByText('Authorize qa CLI on host-12?')).toBeInTheDocument();
    expect(screen.getByText(/see projects and runs, save runs and redo, delete and tune runs/)).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/auth/device?code=WDJB-MJHT');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText("You're signed in")).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ code: 'WDJB-MJHT', approve: true });
  });

  it('denies', async () => {
    const fetch = mockApi();
    renderAt('/device?code=WDJB-MJHT', alice);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Sign-in denied')).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(init.body)).toEqual({ code: 'WDJB-MJHT', approve: false });
  });

  it('asks for the code when the link has none', async () => {
    const fetch = mockApi();
    renderAt('/device', alice);
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'wdjbmjht' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Authorize qa CLI on host-12?')).toBeInTheDocument();
    expect(history.location.search).toBe('?code=WDJB-MJHT');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/auth/device?code=WDJB-MJHT');
  });

  it('says when the code is unknown or expired', async () => {
    mockApi({ device_status: 404 });
    renderAt('/device?code=AAAA-BBBB', alice);
    expect(await screen.findByRole('alert')).toHaveTextContent("This code doesn't match any sign-in request.");
  });

  it('says when the request was already answered', async () => {
    mockApi({ device: { ...request, status: 'expired' } });
    renderAt('/device?code=WDJB-MJHT', alice);
    expect(await screen.findByText('This code expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says when the sign-in was already approved, e.g. in another tab', async () => {
    // the server says "approved" once the CLI got its token
    mockApi({ device: { ...request, status: 'approved' } });
    renderAt('/device?code=WDJB-MJHT', alice);
    expect(await screen.findByText('This sign-in was already approved')).toBeInTheDocument();
    expect(screen.queryByText('This code expired')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Type another code' })).toBeInTheDocument();
  });

  it('shows the command as code, and its title once', async () => {
    mockApi();
    renderAt('/device', alice);
    expect(await screen.findByRole('heading', { name: 'Device sign-in' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    const command = screen.getAllByText('qa auth login');
    expect(command.every(element => element.tagName === 'CODE')).toBe(true);
  });

  it('sends signed-out users to the sign-in page, which comes back with the code', async () => {
    const fetch = mockApi();
    renderAt('/device?code=WDJB-MJHT', undefined);
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/device?code=WDJB-MJHT');
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/v1/auth/device'))).toBe(false);
  });
});
