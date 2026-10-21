/**
 * Admin → Groups (members, rules) and the roles on all projects of Admin → Overview.
 * Run with: cd webapp && npm test -- groups
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { app_routes } from '../../routes';
import { AdminPage } from '../AdminPage';
import { Groups, GroupDetail } from '../Groups';
import { InstanceRoles } from '../InstanceRoles';
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
const body = call => JSON.parse(call[1].body);

const admin = { is_logged: true, user_id: 1, user_name: 'root', full_name: 'Root', is_admin: true };
const group = { id: 7, name: 'camera-team', description: 'The camera algorithms', member_count: 2, rule_count: 1 };

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, options);
};

// Types in a picker, then picks what the directory answers
const pick = async (input, text, name) => {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(within(await screen.findByRole('option', { name: new RegExp(name) })).getByText(name));
};

afterEach(() => vi.restoreAllMocks());


describe('Groups', () => {
  it('is a tab of the admin page, and groups have their page', async () => {
    mockApi({ 'GET /api/v1/admin/groups': { groups: [group] }, 'GET /api/v1/admin/groups/7': { group, members: [], rules: [] } });
    for (const pathname of ['/admin/groups', '/admin/groups/7']) {
      const { route, match } = matchRoutes(app_routes, pathname);
      const { unmount } = renderAt(pathname, <RouteMatch match={match}><AdminPage/></RouteMatch>, { user: admin });
      expect(route.main).toBeDefined();
      expect(await screen.findByRole('tab', { name: 'Groups', selected: true })).toBeInTheDocument();
      unmount();
    }
  });

  it("shows the last update of users' groups, and updates them now", async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/groups': { groups: [group], sync: { last_job: { id: 31, kind: 'sync_groups', status: 'done', finished_at: '2026-10-20T04:41:00Z' }, schedule: { id: 2, enabled: true } } },
      'POST /api/v1/admin/jobs': [{ id: 32, kind: 'sync_groups', status: 'queued' }, 201],
    });
    renderAt('/admin/groups', <Groups/>);
    const sync = within(await screen.findByRole('group', { name: "Updates of users' groups" }));
    expect(sync.getByText(/every day/)).toBeInTheDocument();
    expect(sync.getByRole('link', { name: 'done' })).toHaveAttribute('href', '/admin/storage/jobs/31');
    fireEvent.click(sync.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/jobs')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/jobs')[0])).toEqual({ kind: 'sync_groups', params: {} });
  });

  it('lists groups with their counts, and creates one', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/groups': { groups: [group] },
      'POST /api/v1/admin/groups': { id: 8, name: 'qa', description: '' },
    });
    renderAt('/admin/groups', <Groups/>);
    const row = (await screen.findByRole('link', { name: 'camera-team' })).closest('tr');
    expect(row).toHaveTextContent('The camera algorithms21');
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: ' qa ' } });
    fireEvent.change(dialog.getByLabelText(/Description/), { target: { value: 'Testers' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/groups')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/groups')[0])).toEqual({ name: 'qa', description: 'Testers' });
    await waitFor(() => expect(history.location.pathname).toBe('/admin/groups/8'));
  });

  it('adds and removes members', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/groups/7': { group, members: [
        { user: { id: 2, user_name: 'alice', full_name: 'Alice' }, source: 'manual', added_at: '2026-10-01T00:00:00Z' },
        { user: { id: 3, user_name: 'bob', full_name: 'Bob' }, source: 'rule', added_at: '2026-10-01T00:00:00Z' },
      ], rules: [] },
      'GET /api/v1/directory': { users: [{ id: 5, user_name: 'carol', full_name: 'Carol' }], groups: [{ id: 9, name: 'not-offered' }] },
      'POST /api/v1/admin/groups/7/members': {},
      'DELETE /api/v1/admin/groups/7/members/2': {},
    });
    renderAt('/admin/groups/7', <GroupDetail id="7"/>);
    expect(await screen.findByRole('heading', { name: 'camera-team' })).toBeInTheDocument();
    // members from rules leave by themselves
    expect(screen.getByText('Rule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Bob' })).not.toBeInTheDocument();

    await pick(screen.getByLabelText('Add a user'), 'car', 'Carol');
    // only users join groups
    expect(screen.queryByText('not-offered')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/groups/7/members')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/groups/7/members')[0])).toEqual({ user_id: 5 });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/groups/7/members/2')).toHaveLength(1));
  });

  it('adds and deletes rules', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/groups/7': { group, members: [], rules: [{ id: 3, provider_id: null, claim: 'email_domain', values: ['example.com'] }] },
      'GET /api/v1/admin/sign-in': { providers: [{ id: 'sso', type: 'oidc', name: 'Company SSO' }, { id: 'ldap', type: 'ldap', name: 'LDAP' }] },
      'POST /api/v1/admin/groups/7/rules': {},
      'DELETE /api/v1/admin/groups/7/rules/3': {},
    });
    renderAt('/admin/groups/7', <GroupDetail id="7"/>);
    const rule = within(await screen.findByTestId('rule-3'));
    expect(rule.getByText('Any')).toBeInTheDocument();
    expect(rule.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText(/They leave at their next sign-in without it/)).toBeInTheDocument();

    const form = within(screen.getByRole('form', { name: 'Add a rule' }));
    await waitFor(() => expect(form.getByRole('option', { name: 'Company SSO' })).toBeInTheDocument());
    fireEvent.change(form.getByLabelText('Sign-in'), { target: { value: 'sso' } });
    fireEvent.change(form.getByLabelText('Claim'), { target: { value: 'groups' } });
    const values = form.getByLabelText('Contains any of');
    fireEvent.change(values, { target: { value: 'camera-team' } });
    fireEvent.keyDown(values, { key: 'Enter' });
    fireEvent.change(values, { target: { value: 'isp' } });
    fireEvent.keyDown(values, { key: 'Enter' });
    fireEvent.click(form.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/groups/7/rules')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/groups/7/rules')[0])).toEqual({ provider_id: 'sso', claim: 'groups', values: ['camera-team', 'isp'] });

    fireEvent.click(rule.getByRole('button', { name: 'Delete the rule on email_domain' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/groups/7/rules/3')).toHaveLength(1));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Deleted the rule: the users it added leave in a minute' })));
  });

  it('asks before deleting a group', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/groups/7': { group, members: [], rules: [] }, 'DELETE /api/v1/admin/groups/7': {} });
    renderAt('/admin/groups/7', <GroupDetail id="7"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(calls(fetch, 'DELETE', '/api/v1/admin/groups/7')).toHaveLength(0);
    fireEvent.click(alert.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/groups/7')).toHaveLength(1));
    await waitFor(() => expect(history.location.pathname).toBe('/admin/groups'));
  });
});


describe('Roles on all projects', () => {
  const settings = [
    { key: 'projects.signed_in_role', value: 'developer', default: 'developer', source: 'default', type: 'str', choices: ['viewer', 'developer'] },
    { key: 'projects.default_visibility', value: 'public', default: 'public', source: 'env', env: 'QABOARD_PROJECTS_DEFAULT_VISIBILITY', type: 'str', choices: ['public', 'internal', 'private'] },
  ];
  const grants = [{ id: 4, subject: { type: 'group', id: 8, name: 'qa' }, role: 'viewer', granted_at: '2026-10-01T00:00:00Z' }];

  it('changes the role of signed-in users', async () => {
    const fetch = mockApi({ 'GET /api/v1/admin/settings': { settings }, 'GET /api/v1/admin/grants': { grants: [] }, 'POST /api/v1/admin/settings': { settings } });
    renderAt('/admin', <InstanceRoles/>);
    const select = await screen.findByLabelText(/Role of signed-in users/);
    expect(screen.getByText(/Set Viewer once projects have owners/)).toBeInTheDocument();
    // from the environment: read-only
    expect(screen.queryByLabelText(/Default visibility/)).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'viewer' } });
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/settings')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/settings')[0])).toEqual({ 'projects.signed_in_role': 'viewer' });
  });

  it('gives roles, and asks before removing them', async () => {
    const fetch = mockApi({
      'GET /api/v1/admin/grants': { grants },
      'GET /api/v1/directory': { users: [{ id: 5, user_name: 'carol', full_name: 'Carol' }], groups: [] },
      'POST /api/v1/admin/grants': { id: 5 },
      'DELETE /api/v1/admin/grants/4': {},
    });
    renderAt('/admin', <InstanceRoles/>);
    const row = within(await screen.findByTestId('instance-grant-4'));
    expect(row.getByText('qa')).toBeInTheDocument();
    expect(calls(fetch, 'GET', '/api/v1/admin/grants')[0][0]).toBe('/api/v1/admin/grants?resource_type=instance');

    await pick(screen.getByLabelText('User or group'), 'car', 'Carol');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give the role' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/admin/grants')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/admin/grants')[0])).toEqual({ subject: { type: 'user', id: 5 }, role: 'developer' });

    fireEvent.click(row.getByRole('button', { name: 'Remove the group qa' }));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(alert.getByText(/on all projects\?/)).toHaveTextContent('Remove the viewer role of the group qa on all projects?');
    expect(calls(fetch, 'DELETE', '/api/v1/admin/grants/4')).toHaveLength(0);
    fireEvent.click(alert.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls(fetch, 'DELETE', '/api/v1/admin/grants/4')).toHaveLength(1));
  });
});
