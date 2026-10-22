/**
 * The History page: what it shows while the commits load, on errors, and without commits.
 * Run with: cd webapp && npm test -- Dashboard
 */
import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import Dashboard from '../Dashboard';
import { ComparisonProvider } from '../hooks';
import { matchRoutes, RouteMatch } from '../router';
import { route_paths } from '../route_paths';
import { renderWithProviders } from '../test-utils';

vi.mock('../components/Plot', () => ({ default: () => <div data-testid="plot"/> }));

const project = 'group/proj';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// answers=null: the commits never arrive
const server = (commits_response, qatools_metrics = undefined) => vi.fn(async url => {
  const { pathname } = new URL(url, 'http://localhost');
  if (pathname.startsWith('/api/v1/commits'))
    return commits_response ? commits_response() : new Promise(() => {});
  if (pathname === '/api/v1/project')
    return json({ git: { path_with_namespace: project }, qatools_config: { project: { name: project } }, qatools_metrics });
  if (pathname === '/api/v1/projects')
    return json({});
  return json({ is_authenticated: false });
});

const renderPage = url => {
  const routes = Object.values(route_paths).map(path => ({ path }));
  const { match } = matchRoutes(routes, url.split('?')[0]);
  return renderWithProviders(
    <MemoryRouter initialEntries={[url]}><RouteMatch match={match}><ComparisonProvider><Dashboard/></ComparisonProvider></RouteMatch></MemoryRouter>,
    { siteConfig: {} },
  );
};


describe('Dashboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says it is loading', async () => {
    vi.stubGlobal('fetch', server(null));
    renderPage(`/${project}/history/master`);
    expect(await screen.findByText('Loading the history of master…')).toBeInTheDocument();
  });

  it('shows errors without the HTML pages servers answer with, and retries', async () => {
    const fetch = server(() => new Response('<html><body><h1>Internal Server Error</h1></body></html>', { status: 500, statusText: 'Internal Server Error' }));
    vi.stubGlobal('fetch', fetch);
    renderPage(`/${project}/history`);
    expect(await screen.findByText('Could not load the history', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('500 Internal Server Error')).toBeInTheDocument();
    expect(screen.queryByText(/<html>/)).not.toBeInTheDocument();
    const requests = () => fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/commits')).length;
    const before = requests();
    fireEvent.click(screen.getByText('Retry'));
    expect(requests()).toBeGreaterThan(before);
  });

  it('offers to look further in the past when there are no commits', async () => {
    vi.stubGlobal('fetch', server(() => json([])));
    renderPage(`/${project}/history`);
    expect(await screen.findByText('No commits found')).toBeInTheDocument();
    expect(screen.getByText('Search 30 more days')).toBeInTheDocument();
  });

  it("breaks the metrics down by input tag when the metrics file's dashboard_breakdown_by_tag says so", async () => {
    const commit = { id: 'abcdef12', branch: 'master', message: 'm', authored_datetime: '2026-10-01T10:00:00Z', batches: {} };
    vi.stubGlobal('fetch', server(() => json([commit]), { available_metrics: {}, dashboard_breakdown_by_tag: true }));
    renderPage(`/${project}/history/master`);
    expect(await screen.findByText('Metrics per input tag')).toBeInTheDocument();
  });

  it("doesn't crash on lists of metrics that are not lists in the metrics file", async () => {
    const commit = { id: 'abcdef12', branch: 'master', message: 'm', authored_datetime: '2026-10-01T10:00:00Z', batches: {} };
    const qatools_metrics = { available_metrics: { psnr: {} }, dashboard_metrics: { psnr: null }, dashboard_evolution_metrics: 'psnr', main_metrics: ['psnr'] };
    vi.stubGlobal('fetch', server(() => json([commit]), qatools_metrics));
    renderPage(`/${project}/history/master`);
    expect(await screen.findByText('Metrics per test')).toBeInTheDocument();
  });

  it("doesn't crash when the branch's latest commit has such a metrics file", async () => {
    // On branches, the History uses the metrics file of the latest commit: the tables used to crash with "metrics.join is not a function"
    const qatools_metrics = { available_metrics: { psnr: {} }, dashboard_metrics: { psnr: null }, main_metrics: ['psnr'] };
    const commit = { id: 'abcdef12', branch: 'master', message: 'm', authored_datetime: '2026-10-01T10:00:00Z', batches: {}, data: { qatools_metrics } };
    vi.stubGlobal('fetch', server(() => json([commit]), { available_metrics: { psnr: {} }, main_metrics: ['psnr'] }));
    renderPage(`/${project}/history/master`);
    expect(await screen.findByText('Metrics per test')).toBeInTheDocument();
  });

  it('shows no breakdown by tag by default', async () => {
    const commit = { id: 'abcdef12', branch: 'master', message: 'm', authored_datetime: '2026-10-01T10:00:00Z', batches: {} };
    vi.stubGlobal('fetch', server(() => json([commit]), { available_metrics: {} }));
    renderPage(`/${project}/history/master`);
    expect(await screen.findByText('Metrics per test')).toBeInTheDocument();
    expect(screen.queryByText('Metrics per input tag')).not.toBeInTheDocument();
  });
});
