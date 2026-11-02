/**
 * The project's Access page: managers change the visibility and the members, decide requests, others request access.
 * And project pages that answer 403 say whom to ask.
 * Run with: cd webapp && npm test -- access
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { routes } from '../../routes';
import { AccessPage } from '../AccessPage';
import { ProjectAccessGate, NoProjectAccess } from '../NoProjectAccess';
import { errorMessage, HttpError } from '../../api/http';
import { renderWithProviders } from '../../test-utils';
import { toaster } from '../../toaster';

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Answers by "METHOD /path", see calls() for what was sent
const mockApi = routes => vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = routes[`${init.method ?? 'GET'} ${pathname}`];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url, init) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, method, path) => fetch.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(path));
const body = call => JSON.parse(call[1].body);

const project = 'group/repo';
const alice = { is_logged: true, user_id: 2, user_name: 'alice', full_name: 'Alice', is_admin: false };
const grant = props => ({
  id: 1, subject: { type: 'user', id: 2, name: 'alice', full_name: 'Alice' }, role: 'owner', resource_id: project,
  inherited: false, source: 'manual', expires_at: null, granted_by: { user_name: 'root', full_name: 'Root' }, granted_at: '2026-10-01T00:00:00Z',
  ...props,
});
const manager_access = props => ({
  project, my_role: 'owner', via: 'grant', can_manage: true,
  visibility: { own: null, effective: 'public', inherited_from: null, default: 'public' },
  owners: [{ type: 'user', id: 2, name: 'alice' }],
  grants: [
    grant(),
    grant({ id: 2, subject: { type: 'group', id: 7, name: 'camera-team' }, role: 'developer' }),
    grant({ id: 3, subject: { type: 'user', id: 3, name: 'bob', full_name: 'Bob' }, role: 'viewer', resource_id: 'group', inherited: true }),
    grant({ id: 4, subject: { type: 'group', id: 8, name: 'qa' }, role: 'viewer', resource_id: null, resource_type: 'instance', inherited: true }),
  ],
  requests: [],
  ...props,
});

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  const { route, match } = matchRoutes(routes, pathname);
  return { route, ...renderWithProviders(<HistoryRouter history={history}><RouteMatch match={match}>{ui}</RouteMatch></HistoryRouter>, options) };
};

afterEach(() => vi.restoreAllMocks());


describe('Access page, for owners', () => {
  it('has its route', () => {
    const { route, match } = matchRoutes(routes, '/a/b/c/access');
    expect(route.name).toBe('access');
    expect(match.params.project_id).toBe('a/b/c');
  });

  it('lists the members, inherited ones read-only', async () => {
    mockApi({ 'GET /api/v1/project/access': manager_access() });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    const table = within(await screen.findByRole('table', { name: 'Members' }));
    expect(screen.getByText("It was given to you.")).toBeInTheDocument();
    // own rows can change
    const team = within(screen.getByTestId('grant-2'));
    expect(team.getByText('camera-team')).toBeInTheDocument();
    expect(team.getByRole('combobox', { name: 'Role of the group camera-team' })).toHaveValue('developer');
    expect(team.getByRole('button', { name: 'Remove the group camera-team' })).toBeInTheDocument();
    // given on a folder: where
    const bob = within(screen.getByTestId('grant-3'));
    expect(bob.getByRole('link', { name: 'group' })).toHaveAttribute('href', '/group/access');
    expect(bob.queryByRole('combobox')).not.toBeInTheDocument();
    expect(bob.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    // given on all projects
    const qa = within(screen.getByTestId('grant-4'));
    expect(qa.getByText('All projects')).toBeInTheDocument();
    expect(qa.queryByRole('combobox')).not.toBeInTheDocument();
    expect(table.getAllByRole('row').length).toBe(5);
  });

  it('changes the visibility, or inherits it', async () => {
    const fetch = mockApi({ 'GET /api/v1/project/access': manager_access(), 'POST /api/v1/project/access/visibility': {} });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    const select = await screen.findByRole('combobox', { name: 'Visibility' });
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: 'Inherit (Public)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'private' } });
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/visibility')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/project/access/visibility')[0])).toEqual({ project, visibility: 'private' });
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/visibility')).toHaveLength(2));
    expect(body(calls(fetch, 'POST', '/api/v1/project/access/visibility')[1])).toEqual({ project, visibility: null });
  });

  it('says where an inherited visibility comes from', async () => {
    mockApi({ 'GET /api/v1/project/access': manager_access({ visibility: { own: 'public', effective: 'private', inherited_from: 'group', default: 'public' } }) });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    expect(await screen.findByText(/projects can't be seen by more people than their folder/)).toBeInTheDocument();
    const visibility = within(screen.getByRole('region', { name: 'Visibility' }));
    expect(visibility.getByTestId('effective-visibility')).toHaveTextContent('Private: only members. (from group)');
    expect(visibility.getByRole('link', { name: 'group' })).toHaveAttribute('href', '/group/access');
  });

  it('adds a member picked in the directory', async () => {
    const fetch = mockApi({
      'GET /api/v1/project/access': manager_access(),
      'GET /api/v1/directory': { users: [{ id: 5, user_name: 'carol', full_name: 'Carol' }], groups: [{ id: 9, name: 'carol-fans' }] },
      'POST /api/v1/project/access/grants': grant({ id: 10 }),
    });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
    const dialog = within(await screen.findByRole('dialog'));
    const input = dialog.getByLabelText('User or group');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'car' } });
    // searched a moment after typing
    fireEvent.click(within(await screen.findByRole('option', { name: /carol-fans/ })).getByText('carol-fans'));
    expect(input).toHaveValue('carol-fans');
    await waitFor(() => expect(calls(fetch, 'GET', '/api/v1/directory?q=car').length).toBeGreaterThan(0));
    fireEvent.click(dialog.getByLabelText(/^Developer/));
    fireEvent.change(dialog.getByLabelText(/Expires/), { target: { value: '2027-01-31' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add member' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/grants')).toHaveLength(1));
    const sent = body(calls(fetch, 'POST', '/api/v1/project/access/grants')[0]);
    expect(sent).toMatchObject({ project, subject: { type: 'group', id: 9 }, role: 'developer' });
    expect(sent.expires_at).toMatch(/^2027-0[12]-/);
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Added the group carol-fans as developer' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('changes a role', async () => {
    const fetch = mockApi({ 'GET /api/v1/project/access': manager_access(), 'POST /api/v1/project/access/grants': grant({ id: 2 }) });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Role of the group camera-team' }), { target: { value: 'owner' } });
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/grants')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/project/access/grants')[0])).toEqual({ project, subject: { type: 'group', id: 7 }, role: 'owner' });
  });

  it('asks before removing a member, and shows why the server refuses', async () => {
    const fetch = mockApi({
      'GET /api/v1/project/access': manager_access(),
      'DELETE /api/v1/project/access/grants/1': () => [{ error: "A project needs at least one owner." }, 400],
    });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Alice' }));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(alert.getByText(/from elsewhere/)).toHaveTextContent(`Remove Alice from ${project}?`);
    expect(calls(fetch, 'DELETE', '/api/v1/project/access/grants')).toHaveLength(0);
    fireEvent.click(alert.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A project needs at least one owner.');
    expect(calls(fetch, 'DELETE', '/api/v1/project/access/grants/1')).toHaveLength(1);
  });

  it('approves requests with the role chosen', async () => {
    const fetch = mockApi({
      'GET /api/v1/project/access': manager_access({ requests: [{ id: 4, user: { id: 5, user_name: 'carol', full_name: 'Carol' }, role: 'developer', message: 'I run the benchmarks', status: 'pending', created_at: '2026-10-20T00:00:00Z' }] }),
      'POST /api/v1/project/access/requests/4': {},
    });
    renderAt(`/${project}/access`, <AccessPage/>, { user: alice });
    const request = within(await screen.findByTestId('request-4'));
    expect(request.getByText('I run the benchmarks')).toBeInTheDocument();
    const role = request.getByRole('combobox', { name: 'Role for Carol' });
    expect(role).toHaveValue('developer');
    fireEvent.change(role, { target: { value: 'viewer' } });
    fireEvent.click(request.getByRole('button', { name: 'Approve Carol' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/requests/4')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/project/access/requests/4')[0])).toEqual({ decision: 'approve', role: 'viewer' });
  });
});


describe('Access page, for others', () => {
  const viewer_access = props => ({
    project, my_role: 'viewer', via: 'signed_in', can_manage: false,
    visibility: { own: 'internal', effective: 'internal', inherited_from: null, default: 'public' },
    owners: [{ type: 'user', id: 2, name: 'alice' }, { type: 'group', id: 7, name: 'camera-team' }],
    my_request: null,
    ...props,
  });
  const bob = { is_logged: true, user_id: 3, user_name: 'bob', full_name: 'Bob', is_admin: false };

  it('shows their role, the owners, and requests a role above theirs', async () => {
    const fetch = mockApi({ 'GET /api/v1/project/access': viewer_access(), 'POST /api/v1/project/access/requests': { id: 1 } });
    renderAt(`/${project}/access`, <AccessPage/>, { user: bob });
    expect(await screen.findByText('Everyone signed in has it on internal projects.')).toBeInTheDocument();
    const owners = within(screen.getByRole('region', { name: 'Owners' }));
    expect(owners.getByText('alice')).toBeInTheDocument();
    expect(owners.getByText('camera-team')).toBeInTheDocument();
    // they can't manage
    expect(screen.queryByRole('combobox', { name: 'Visibility' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Members' })).not.toBeInTheDocument();
    // only roles above theirs
    const form = within(screen.getByRole('form', { name: 'Request access' }));
    expect(form.queryByLabelText(/^Viewer/)).not.toBeInTheDocument();
    expect(form.getByLabelText(/^Developer/)).toBeChecked();
    fireEvent.click(form.getByLabelText(/^Owner/));
    fireEvent.change(form.getByLabelText(/Why you need it/), { target: { value: ' I lead the team ' } });
    fireEvent.click(form.getByRole('button', { name: 'Request access' }));
    await waitFor(() => expect(calls(fetch, 'POST', '/api/v1/project/access/requests')).toHaveLength(1));
    expect(body(calls(fetch, 'POST', '/api/v1/project/access/requests')[0])).toEqual({ project, role: 'owner', message: 'I lead the team' });
  });

  it('shows their pending request', async () => {
    mockApi({ 'GET /api/v1/project/access': viewer_access({ my_request: { id: 1, role: 'developer', message: 'Please', status: 'pending', created_at: '2026-10-20T00:00:00Z' } }) });
    renderAt(`/${project}/access`, <AccessPage/>, { user: bob });
    expect(await screen.findByText('You asked for the developer role')).toBeInTheDocument();
    expect(screen.getByText('Please')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('can request access when the server refuses outsiders', async () => {
    mockApi({ 'GET /api/v1/project/access': () => [{ reason: 'missing_role', required: 'viewer', project, owners: [{ type: 'user', id: 2, name: 'alice' }], can_request: true }, 403] });
    renderAt(`/${project}/access`, <AccessPage/>, { user: bob });
    expect(await screen.findByText(/You have no role on this project/)).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Request access' })).toBeInTheDocument();
  });

  it('asks anonymous users to sign in', async () => {
    const fetch = mockApi({});
    renderAt(`/${project}/access`, <AccessPage/>, { user: { is_logged: false } });
    expect(await screen.findByText('Sign in to see who has access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/${project}/access`)}`);
    expect(calls(fetch, 'GET', '/api/v1/project/access')).toHaveLength(0);
  });
});


describe('Projects users have no access to', () => {
  const forbidden = { error: 'Forbidden', reason: 'missing_role', required: 'viewer', project, owners: [{ type: 'user', id: 2, name: 'alice' }], can_request: true };

  it('say whom to ask on every project page, and link to request access', async () => {
    mockApi({ 'GET /api/v1/project': () => [forbidden, 403] });
    renderAt(`/${project}/commits`, <ProjectAccessGate><p>The commits</p></ProjectAccessGate>, { user: { is_logged: true, user_id: 3, user_name: 'bob' } });
    expect(await screen.findByText(`You don't have access to ${project}`)).toBeInTheDocument();
    expect(screen.queryByText('The commits')).not.toBeInTheDocument();
    expect(screen.getByText('You need the viewer role to see it.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Owners' })).getByText('alice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toHaveAttribute('href', `/${project}/access`);
  });

  it("don't hide the Access page", async () => {
    mockApi({ 'GET /api/v1/project': () => [forbidden, 403] });
    renderAt(`/${project}/access`, <ProjectAccessGate><p>The access page</p></ProjectAccessGate>, { user: { is_logged: true, user_id: 3, user_name: 'bob' } });
    expect(await screen.findByText('The access page')).toBeInTheDocument();
  });

  it('ask anonymous users to sign in', () => {
    const error = new HttpError({ status: 403, data: { reason: 'forbidden_project' } });
    renderAt(`/${project}/commits`, <NoProjectAccess project={project} error={error}/>, { user: { is_logged: false } });
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/${project}/commits`)}`);
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('get toasts that say which role they need', () => {
    expect(errorMessage(new HttpError({ status: 403, data: forbidden }))).toBe(`You need the viewer role on ${project}. Ask an owner, or request access.`);
    expect(errorMessage(new HttpError({ status: 403, data: { ...forbidden, required: 'developer', project: 'a/b' } }))).toBe('You need the developer role on a/b. Ask an owner, or request access.');
  });
});
