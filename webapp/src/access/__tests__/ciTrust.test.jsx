/**
 * Trusted CI jobs of service accounts: GitHub Actions or GitLab CI jobs that get the account's tokens without a secret.
 * Run with: cd webapp && npm test -- ciTrust
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { CiTrust, ciName, ciSnippet } from '../CiTrust';
import { renderWithProviders } from '../../test-utils';

vi.mock('../../utils/clipboard', () => ({ copyWithToast: vi.fn(), copyText: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && new URL(url, 'http://localhost').pathname === path);
const body = call => JSON.parse(call[1].body);

const project = 'group/repo';
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice', is_admin: false };
const github = {
  id: 'a1b2c3d4', provider: 'github', issuer: 'https://token.actions.githubusercontent.com', audience: 'https://qa.example.com',
  conditions: { repository: ['camera-algo/isp'], ref: ['refs/heads/main'] }, created_by: 'alice', created_at: '2026-11-01T00:00:00Z', last_used_at: null,
};
const account = props => ({ id: 12, name: 'ci', user_name: `${project}/ci[bot]`, project, owner_type: 'project', ci_trust: [], tokens: [], ...props });

afterEach(() => vi.restoreAllMocks());


describe('Trusted CI jobs', () => {
  it('names the CI and gives the configuration to copy', () => {
    expect(ciName(github)).toBe('GitHub Actions');
    expect(ciName({ provider: 'gitlab', issuer: 'https://gitlab.com' })).toBe('GitLab.com');
    expect(ciName({ provider: 'gitlab', issuer: 'https://gitlab.example.com' })).toBe('GitLab (gitlab.example.com)');
    expect(ciSnippet(github, account()).code).toContain('id-token: write');
    expect(ciSnippet({ ...github, provider: 'gitlab' }, account()).code).toContain('QABOARD_ID_TOKEN:\n      aud: https://qa.example.com');
  });

  it('lists the jobs it trusts, and stops trusting them', async () => {
    const fetch = mockApi({ 'DELETE /api/v1/service-accounts/12/ci-trust/a1b2c3d4': account() });
    renderWithProviders(<CiTrust account={account({ ci_trust: [github] })}/>, { user: alice });
    const row = within(screen.getByTestId('ci-trust-a1b2c3d4'));
    expect(row.getByText('GitHub Actions')).toBeInTheDocument();
    expect(row.getByText('camera-algo/isp')).toBeInTheDocument();
    expect(row.getByText('ref: refs/heads/main')).toBeInTheDocument();
    expect(screen.getByText(/id-token: write/)).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'Stop trusting GitHub Actions jobs of camera-algo/isp' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/service-accounts/12/ci-trust/a1b2c3d4')).toHaveLength(1));
  });

  it('trusts the jobs of a self-hosted GitLab project', async () => {
    const fetch = mockApi({ 'POST /api/v1/service-accounts/12/ci-trust': () => [account({ ci_trust: [github] }), 201] });
    renderWithProviders(<CiTrust account={account()}/>, { user: alice });
    fireEvent.click(screen.getByRole('button', { name: 'Trust CI jobs' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('CI'), { target: { value: 'gitlab-self-hosted' } });
    fireEvent.change(dialog.getByLabelText('Project path'), { target: { value: 'camera-algo/isp' } });
    // the GitLab URL is needed
    expect(dialog.getByRole('button', { name: 'Trust these jobs' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('GitLab URL'), { target: { value: 'https://gitlab.example.com' } });
    fireEvent.change(dialog.getByLabelText(/Branch/), { target: { value: 'main' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Trust these jobs' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/service-accounts/12/ci-trust')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/service-accounts/12/ci-trust')[0])).toEqual({
      provider: 'gitlab', issuer: 'https://gitlab.example.com', repository: 'camera-algo/isp', ref: 'main',
    });
  });

  it("shows the server's refusals", async () => {
    mockApi({ 'POST /api/v1/service-accounts/12/ci-trust': () => [{ error: "Write the repository as owner/name" }, 400] });
    renderWithProviders(<CiTrust account={account()}/>, { user: alice });
    fireEvent.click(screen.getByRole('button', { name: 'Trust CI jobs' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Repository'), { target: { value: 'isp' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Trust these jobs' }));
    expect(await dialog.findByText('Write the repository as owner/name')).toBeInTheDocument();
  });
});
