/**
 * The project's page shows signed-in users their batches first, everyone's one click away, and can hide the CI's.
 * Run with: cd webapp && npm test -- ProjectScope
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import CiCommitList from '../CiCommitList';
import { ComparisonProvider } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { renderWithProviders } from '../test-utils';
import { usePrefsStore } from '../stores/prefs';
import { logged_out_user } from '../api/queries';


const project = 'group/proj';
const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', is_admin: false };
const date = new Date().toISOString();
const batch = (label, extra = {}) => ({ id: label.length, label, origin: 'ci', user_name: 'qaboard', latest_output_datetime: date, created_date: date, data: {}, valid_outputs: 2, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0, aggregated_metrics: {}, ...extra });
const commit = (id, message, batches, extra = {}) => ({
  id, message, branch: 'feature', committer_name: 'Alice', authored_datetime: date, authored_date: date.slice(0, 10),
  batches: Object.fromEntries(batches.map(b => [b.label, b])), ...extra,
});
const everyone = [
  commit('a'.repeat(40), 'Bob on master', [batch('default')], { committer_name: 'Bob', branch: 'master' }),
  commit('b'.repeat(40), 'Alice tunes', [batch('default'), batch('sweep', { origin: 'webapp', user_name: 'alice' })]),
];
const mine = [everyone[1]];
const my_batches = [
  { ...batch('sweep', { origin: 'webapp', user_name: 'alice', pending_outputs: 3, running_outputs: 1 }), project, commit: { id: 'b'.repeat(40), branch: 'feature', message: 'Alice tunes', committer_name: 'Alice' } },
  { ...batch('@alice| try', { id: 99, origin: 'local', user_name: 'alice' }), project, commit: { id: 'c'.repeat(40), branch: 'feature', message: 'Alice tries', committer_name: 'Alice' } },
];

const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...headers } });
let has_mine = true;
let has_my_commits = true;
const fetchMock = vi.fn(async url => {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  if (pathname === '/api/v1/commit-counts') return json({ all: 2, mine: has_mine ? 1 : 0, without_ci: 1 });
  if (pathname === '/api/v1/batches') return json(has_mine ? my_batches : [], { 'X-Has-More': 'false' });
  if (pathname.startsWith('/api/v1/commits')) {
    if (pathname === '/api/v1/commits/master') return json([everyone[0]]);
    const list = searchParams.get('scope') === 'mine' ? (has_mine && has_my_commits ? mine : []) : everyone;
    return json(searchParams.get('origin') ? list.filter(c => Object.values(c.batches).some(b => b.origin !== 'ci')) : list, { 'X-Has-More': 'false' });
  }
  if (pathname === '/api/v1/project')
    return json({ git: { path_with_namespace: project, default_branch: 'master' }, qatools_config: { project: { name: project } } });
  if (pathname === '/api/v1/projects') return json({});
  return json({});
});
const requests = path => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname === path);

const renderPage = (url, user = alice) => {
  const { match } = matchRoutes([{ path: '/:project_id+/commits/:name+' }, { path: '/:project_id+' }], url.split('?')[0]);
  return renderWithProviders(
    <MemoryRouter initialEntries={[url]}><RouteMatch match={match}><ComparisonProvider><CiCommitList/></ComparisonProvider></RouteMatch></MemoryRouter>,
    { siteConfig: {}, user },
  );
};

describe('the project page for signed-in users', () => {
  beforeEach(() => {
    has_mine = true;
    has_my_commits = true;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(history, 'push').mockImplementation(() => {});
    usePrefsStore.setState({ commitListDensity: 'comfortable', listScope: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists their batches first, with their progress, and where master is', async () => {
    renderPage(`/${project}`);
    const list = await screen.findByRole('list', { name: 'Batches' });
    expect(within(list).getByText('sweep')).toBeInTheDocument();
    expect(within(list).getByText('web app')).toBeInTheDocument();
    expect(within(list).getByText('2/5')).toBeInTheDocument();
    expect(requests('/api/v1/batches')[0].searchParams.get('scope')).toBe('mine');
    expect(requests('/api/v1/commits/')[0]?.searchParams.get('scope') ?? 'mine').toBe('mine');
    // whoever committed it
    expect(await screen.findByText('Latest on master')).toBeInTheDocument();
    expect(await screen.findByText('Bob on master')).toBeInTheDocument();
    // everyone's is one click away
    expect(await screen.findByText('2 commits by everyone')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Yours/ })).toBeChecked();
  });

  it('compares two batches', async () => {
    renderPage(`/${project}`);
    const list = await screen.findByRole('list', { name: 'Batches' });
    fireEvent.click(within(list).getByLabelText('Select sweep to compare it'));
    expect(screen.getByText(/Pick another batch to compare/)).toBeInTheDocument();
    fireEvent.click(within(list).getByLabelText('Select try to compare it'));
    fireEvent.click(screen.getByRole('button', { name: /Compare/ }));
    expect(history.push).toHaveBeenCalledWith(`/${project}/commit/${'b'.repeat(40)}?batch=sweep&reference=${'c'.repeat(40)}&batch_ref=%40alice%7C+try`);
  });

  it('keeps theirs when they only have batches, from old commits', async () => {
    has_my_commits = false;
    renderPage(`/${project}`);
    expect(await screen.findByRole('list', { name: 'Batches' })).toBeInTheDocument();
    expect(screen.queryByText(/You have no commits or batches/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Yours/ })).toBeChecked();
  });

  it("shows everyone's when they have nothing in the project", async () => {
    has_mine = false;
    renderPage(`/${project}?view=commits`);
    expect(await screen.findByText(/You have no commits or batches in this project yet/)).toBeInTheDocument();
    expect(await screen.findByText('Bob on master')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Everyone/ })).toBeChecked();
  });

  it("shows everyone's commits when the link says so, and remembers what users pick", async () => {
    renderPage(`/${project}?scope=all`);
    expect(await screen.findByText('Bob on master')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Batches' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1 yours')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: /Yours/ }));
    expect(usePrefsStore.getState().listScope[project]).toBe('mine');
    expect(history.push).toHaveBeenCalled();
  });

  it('hides the CI', async () => {
    renderPage(`/${project}?scope=all&hide_ci=1`);
    expect(await screen.findByText('Alice tunes')).toBeInTheDocument();
    expect(requests('/api/v1/commits/').every(url => url.searchParams.get('origin') === 'webapp,local')).toBe(true);
    expect(screen.getByLabelText('Hide the CI')).toBeChecked();
  });

  it('is about everyone for signed-out users', async () => {
    renderPage(`/${project}`, logged_out_user);
    expect(await screen.findByText('Bob on master')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Yours/ })).not.toBeInTheDocument();
    expect(requests('/api/v1/commits/').every(url => url.searchParams.get('scope') === null)).toBe(true);
  });
});
