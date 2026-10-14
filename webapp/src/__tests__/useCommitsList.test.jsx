/**
 * What the sidebar and navbar get from lists of commits.
 * Run with: cd webapp && npm test -- useCommitsList
 */
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { ComparisonProvider, useCommitsList } from '../hooks';
import { branch_query, filterBranch } from '../AppNavbar';
import { matchRoutes, RouteMatch } from '../router';
import { renderWithProviders } from '../test-utils';


const project = 'group/proj';
const commit = (i, branch) => {
  const date = new Date(Date.UTC(2026, 9, 1, 12) - i * 3600 * 1000).toISOString();
  return { id: `${branch}-${i}`, message: `Commit ${i}`, branch, committer_name: 'alice', authored_datetime: date, authored_date: date.slice(0, 10), batches: { default: { label: 'default', valid_outputs: 1 } } };
};
// Busy feature branches: the latest master commit is not on the first page
const commits = [...Array.from({ length: 60 }, (_, i) => commit(i, 'feature')), commit(60, 'master')];

const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...headers } });
const fetchMock = vi.fn(async url => {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  if (pathname.startsWith('/api/v1/commits')) {
    const branch = decodeURIComponent(pathname.replace(/^\/api\/v1\/commits\/?/, ''));
    const matching = branch ? commits.filter(c => c.branch === branch) : commits;
    const limit = Number(searchParams.get('limit'));
    const offset = Number(searchParams.get('offset') ?? 0);
    return json(matching.slice(offset, offset + limit), { 'X-Has-More': String(offset + limit < matching.length) });
  }
  if (pathname === '/api/v1/project')
    return json({ git: { path_with_namespace: project, default_branch: 'master' }, qatools_config: { project: { name: project } } });
  if (pathname === '/api/v1/projects')
    return json({});
  return json({ is_authenticated: false });
});

const LatestCommit = () => {
  const { latest_commit, ids } = useCommitsList({ ignore_search: true });
  return <p>{ids.length} loaded, latest on master: {latest_commit?.id ?? 'none'}</p>;
};


describe('useCommitsList', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("finds the default branch's latest commit even when it's not in the pages loaded", async () => {
    const { match } = matchRoutes([{ path: '/:project_id+' }], `/${project}`);
    renderWithProviders(
      <MemoryRouter initialEntries={[`/${project}`]}><RouteMatch match={match}><ComparisonProvider><LatestCommit/></ComparisonProvider></RouteMatch></MemoryRouter>,
      { siteConfig: {} },
    );
    expect(await screen.findByText('50 loaded, latest on master: master-60')).toBeInTheDocument();
    const branch_requests = fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname === '/api/v1/commits/master');
    expect(branch_requests.map(url => url.searchParams.get('limit'))).toEqual(['1']);
  });

  test("searches don't change the latest commit, nor the commits compared by default", async () => {
    const Lists = () => {
      const searched = useCommitsList();
      const unsearched = useCommitsList({ ignore_search: true });
      return <p>searched: {searched.search || 'nothing'}, latest: {unsearched.latest_commit?.id ?? 'none'}</p>;
    };
    const { match } = matchRoutes([{ path: '/:project_id+' }], `/${project}`);
    renderWithProviders(
      <MemoryRouter initialEntries={[`/${project}?search=feature`]}><RouteMatch match={match}><ComparisonProvider><Lists/></ComparisonProvider></RouteMatch></MemoryRouter>,
      { siteConfig: {} },
    );
    expect(await screen.findByText('searched: feature, latest: master-60')).toBeInTheDocument();
    const list_requests = fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname === '/api/v1/commits/');
    // the search looks at all the commits, the list without it at the date range
    expect(list_requests.some(url => url.searchParams.get('q') === 'feature' && !url.searchParams.has('from'))).toBe(true);
    expect(list_requests.some(url => !url.searchParams.has('q') && url.searchParams.has('from'))).toBe(true);
  });
});


describe('branch suggestions in the navbar filter', () => {
  test('only for searches that can be about branches', () => {
    expect(branch_query('fix')).toBe('fix');
    expect(branch_query('speed branch:feature -wip')).toBe('feature');
    expect(branch_query('fix crash')).toBe('');
    expect(filterBranch('', 'master')).toBe(true);
    expect(filterBranch('feat', 'feature')).toBe(true);
    expect(filterBranch('feat', 'master')).toBe(false);
    // e.g. words of commit messages
    expect(filterBranch('fix crash', 'master')).toBe(false);
    expect(filterBranch('committer:alice', 'master')).toBe(false);
  });
});
