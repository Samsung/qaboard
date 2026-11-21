/**
 * The audit log: events' labels and icons from the server's registry, their details, the filters in the URL and the
 * exports (Admin → Audit), and a project's audit log, for its developers and owners.
 * Run with: cd webapp && npm test -- audit
 */
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history, RouteMatch, matchRoutes } from '../../router';
import { routes } from '../../routes';
import { renderWithProviders } from '../../test-utils';
import { AuditEvents } from '../../settings/AuditEvents';
import { Audit } from '../../admin/Audit';
import { ProjectAdminPage } from '../../projectAdmin/ProjectAdminPage';
import { target_audit_location } from '../../projectAdmin/api';
import { audit_registry } from '../../settings/__tests__/auditRegistry';
import { readFilters, filtersSearch, filterParams, dayStart, dayEnd } from '../filters';

// dates as the API gets them: the user's day, in UTC
const since_param = encodeURIComponent(dayStart('2026-11-01'));
const until_param = encodeURIComponent(dayEnd('2026-11-21'));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

// Answers by "GET /path"
const mockApi = answers => vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
  const { pathname } = new URL(url, 'http://localhost');
  const answer = answers[pathname];
  if (!answer) return json({});
  const [data, status] = typeof answer === 'function' ? answer(url) : [answer, 200];
  return json(data, status);
});
const calls = (fetch, path) => fetch.mock.calls.map(([url]) => url).filter(url => url.startsWith(path));

const renderAt = (pathname, ui, options) => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}>{ui}</HistoryRouter>, options);
};

const event = props => ({
  id: 1, created_at: '2026-11-20T10:00:00Z', actor_kind: 'user', actor_user_id: 2, actor_token_id: null, actor_label: 'alice',
  action: 'batch.start', target_type: 'batch', target_id: '12', target_label: 'nightly', project_id: 'group/repo',
  changes: {}, meta: {}, ...props,
});

afterEach(() => vi.restoreAllMocks());


describe('events', () => {
  it("say actions in the server's words, else guess them", async () => {
    mockApi({ '/api/v1/audit/actions': audit_registry });
    renderAt('/', <AuditEvents events={[event(), event({ id: 2, action: 'thing.do_it' })]}/>);
    // while the registry loads
    expect(screen.getByText('Batch: start')).toBeInTheDocument();
    expect(await screen.findByText('Started a batch')).toBeInTheDocument();
    // unknown to the server's registry, e.g. events of an older version
    expect(screen.getByText('Thing: do it')).toBeInTheDocument();
  });

  it('guess the labels of older servers, without a registry', async () => {
    const fetch = mockApi({ '/api/v1/audit/actions': () => [{ error: 'Not found' }, 404] });
    renderAt('/', <AuditEvents events={[event({ action: 'token.create' })]}/>);
    await waitFor(() => expect(calls(fetch, '/api/v1/audit/actions').length).toBeGreaterThan(0));
    // once the request failed, not only while it loads
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(screen.getByText('Token: create')).toBeInTheDocument();
  });

  it('show their details on demand', async () => {
    mockApi({ '/api/v1/audit/actions': audit_registry });
    const meta = {
      commit: '0123456789abcdef0123456789abcdef01234567', batch_label: 'tuning', runner: 'local', redo: false, count: 3,
      parameters: { iso: 100, nested: { a: 1 } }, labels: ['a', 'b'], command: 'x'.repeat(300), note: null,
    };
    renderAt('/', <AuditEvents events={[event({ meta })]}/>);
    // at a glance: the commit, in its project, and the batch when it isn't the target
    expect(screen.getByRole('link', { name: '01234567' })).toHaveAttribute('href', `/group/repo/commit/${meta.commit}`);
    expect(screen.getByText('tuning')).toBeInTheDocument();
    // collapsed, and not rendered
    const toggle = screen.getByRole('button', { name: /^Details of / });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: /^Details of / })).toBeNull();
    expect(screen.queryByText('runner')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = within(screen.getByRole('region', { name: /^Details of / }));
    expect(toggle).toHaveAttribute('aria-controls', screen.getByRole('region', { name: /^Details of / }).id);
    const value = key => details.getByText(key).nextElementSibling.textContent;
    expect(value('runner')).toBe('local');
    expect(value('redo')).toBe('false');
    expect(value('count')).toBe('3');
    expect(value('note')).toBe('none');
    expect(value('labels')).toBe('["a","b"]');
    // objects as their keys, deeper ones as JSON
    expect(value('iso')).toBe('100');
    expect(value('nested')).toBe('{"a":1}');
    // long values are cut
    expect(value('command')).toMatch(/^x{120}… Show all$/);
    fireEvent.click(details.getByRole('button', { name: 'Show all' }));
    expect(value('command')).toBe(`${'x'.repeat(300)} Show less`);

    fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: /^Details of / })).toBeNull();
  });

  it('have no details without meta', () => {
    mockApi({ '/api/v1/audit/actions': audit_registry });
    renderAt('/', <AuditEvents events={[event()]}/>);
    expect(screen.queryByRole('button', { name: /^Details/ })).toBeNull();
  });
});


describe('filters', () => {
  it('are read from and written to the URL', () => {
    expect(readFilters('?category=runs&since=2026-11-01&other=1')).toEqual({ action: '', category: 'runs', actor: '', target: '', since: '2026-11-01', until: '' });
    expect(filtersSearch('?other=1&actor=bob', { actor: '', until: '2026-11-21' })).toBe('?other=1&until=2026-11-21');
    expect(filterParams({ action: '', category: 'runs', actor: 'al', target: 'batch:12', since: '', until: '' })).toEqual({ category: 'runs', actor: 'al', target_type: 'batch', target_id: '12' });
    // the user's days: from their midnight, until the end of the last day
    const { since, until } = filterParams({ since: '2026-11-01', until: '2026-11-21' });
    expect(new Date(since).getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(new Date(until).getTime()).toBe(new Date(2026, 10, 22).getTime() - 1);
  });
});


describe('Admin → Audit', () => {
  const admin = { is_logged: true, user_id: 1, user_name: 'root', is_admin: true };
  const renderAudit = (search = '') => {
    const fetch = mockApi({
      '/api/v1/audit/actions': audit_registry,
      '/api/v1/admin/audit/actions': { actions: ['auth.login', 'batch.delete', 'batch.start', 'token.create'] },
      '/api/v1/admin/audit': { events: [event()], next_before_id: null },
    });
    renderAt(`/admin/audit${search}`, <Audit/>, { user: admin });
    return fetch;
  };

  it('filters by category and dates, in the URL', async () => {
    const fetch = renderAudit('?action=token.create');
    const category = await screen.findByRole('combobox', { name: 'Category' });
    expect(within(category).getAllByRole('option').map(option => option.textContent)).toEqual(['All categories', 'Sign-in', 'Tokens', 'Runs and batches']);
    fireEvent.change(category, { target: { value: 'runs' } });
    // the action was of another category: it would match nothing
    expect(readFilters(history.location.search)).toMatchObject({ category: 'runs', action: '' });
    expect(within(screen.getByRole('combobox', { name: 'Action' })).getAllByRole('option').map(option => option.textContent)).toEqual(['All actions', 'Deleted a batch', 'Started a batch']);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-21' } });
    expect(history.location.pathname).toBe('/admin/audit');
    expect(readFilters(history.location.search)).toMatchObject({ category: 'runs', since: '2026-11-01', until: '2026-11-21' });
    await waitFor(() => expect(calls(fetch, '/api/v1/admin/audit?')).toContain(`/api/v1/admin/audit?category=runs&since=${since_param}&until=${until_param}&limit=100`));
    expect(screen.getByLabelText('To')).toHaveAttribute('min', '2026-11-01');
  });

  it('exports with the filters', async () => {
    renderAudit('?category=runs&actor=ali&since=2026-11-01&target=batch:12');
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const csv = await screen.findByRole('menuitem', { name: 'Download CSV' });
    expect(csv).toHaveAttribute('href', `/api/v1/admin/audit?category=runs&actor=ali&since=${since_param}&target_type=batch&target_id=12&format=csv`);
    expect(csv).toHaveAttribute('download');
    expect(screen.getByRole('menuitem', { name: 'Download JSON Lines' })).toHaveAttribute('href', `/api/v1/admin/audit?category=runs&actor=ali&since=${since_param}&target_type=batch&target_id=12&format=jsonl`);
  });

  it('says the actor filter matches part of names', async () => {
    renderAudit();
    expect(await screen.findByRole('textbox', { name: 'Actor' })).toHaveAttribute('placeholder', 'By user, or part of a name');
  });
});


describe("a project's audit log", () => {
  const project = 'group/repo';
  const alice = { is_logged: true, user_id: 2, user_name: 'alice', is_admin: false };
  const renderPage = (answers, search = '') => {
    const fetch = mockApi({ '/api/v1/audit/actions': audit_registry, ...answers });
    const pathname = `/${project}/admin/audit`;
    act(() => history.replace(`${pathname}${search}`));
    const { route, match } = matchRoutes(routes, pathname);
    expect(route.name).toBe('project_admin');
    renderWithProviders(<HistoryRouter history={history}><RouteMatch match={match}><ProjectAdminPage/></RouteMatch></HistoryRouter>, { user: alice });
    return fetch;
  };

  it("lists the project's events, with its actions' categories", async () => {
    // the next page has older events
    const fetch = renderPage({ '/api/v1/project/audit': url => [{ events: [event({ id: url.includes('before_id') ? 1 : 2, meta: { commit: 'abc' } })], next_before_id: 1 }, 200] });
    const list = within(await screen.findByRole('list', { name: 'Activity' }));
    expect(await list.findByText('Started a batch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit log', current: 'page' })).toHaveAttribute('href', `/${project}/admin/audit`);
    // no sign-ins nor tokens in projects
    expect(within(screen.getByRole('combobox', { name: 'Category' })).getAllByRole('option').map(option => option.textContent)).toEqual(['All categories', 'Project access', 'Runs and batches', 'Milestones']);
    expect(calls(fetch, '/api/v1/project/audit')[0]).toBe('/api/v1/project/audit?project=group%2Frepo&limit=50');
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
    // clicking names filters
    fireEvent.click(screen.getByRole('link', { name: 'alice' }));
    expect(readFilters(history.location.search).actor).toBe('alice');
    await waitFor(() => expect(calls(fetch, '/api/v1/project/audit')).toContain('/api/v1/project/audit?project=group%2Frepo&actor=alice&limit=50'));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(calls(fetch, '/api/v1/project/audit')).toContain('/api/v1/project/audit?project=group%2Frepo&actor=alice&before_id=1&limit=50'));
  });

  it('opens on a batch from its menu', async () => {
    expect(target_audit_location(project, 'batch', 12)).toBe(`/${project}/admin/audit?target=batch%3A12`);
    const fetch = renderPage({ '/api/v1/project/audit': { events: [], next_before_id: null } }, '?target=batch%3A12');
    expect(await screen.findByText('No matching events')).toBeInTheDocument();
    expect(calls(fetch, '/api/v1/project/audit')[0]).toBe('/api/v1/project/audit?project=group%2Frepo&target_type=batch&target_id=12&limit=50');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('menuitem', { name: 'Download CSV' })).toHaveAttribute('href', '/api/v1/project/audit?project=group%2Frepo&target_type=batch&target_id=12&format=csv');
  });

  it("tells viewers that it's for developers and owners", async () => {
    renderPage({ '/api/v1/project/audit': () => [{
      error: "You need the developer role to see the history of group/repo: you're a viewer.",
      reason: 'missing_role', required: 'developer', role: 'viewer', project, owners: [], can_request: true,
    }, 403] });
    expect(await screen.findByText('Developers and owners only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See who has which role' })).toHaveAttribute('href', `/${project}/access`);
    // nothing to filter nor export
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Action' })).not.toBeInTheDocument();
  });
});
