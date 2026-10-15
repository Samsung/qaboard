/**
 * The project's page lists commits one page at a time, and searches all of them on the server.
 * Run with: cd webapp && npm test -- CiCommitList
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import CiCommitList from '../CiCommitList';
import { ComparisonProvider } from '../hooks';
import { matchRoutes, RouteMatch } from '../router';
import { renderWithProviders } from '../test-utils';


const project = 'group/proj';
const nb_commits = 120;
const commits = Array.from({ length: nb_commits }, (_, i) => {
  const date = new Date(Date.UTC(2026, 9, 1, 12) - i * 3600 * 1000).toISOString();
  return {
    id: `${String(i).padStart(4, '0')}abcdef`,
    message: `Commit number ${i}.`,
    branch: 'master',
    committer_name: 'alice',
    authored_datetime: date,
    authored_date: date.slice(0, 10),
    batches: { default: { label: 'default', valid_outputs: 1, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0, aggregated_metrics: {} } },
  };
});

const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...headers } });

// A server with pagination
const fetchMock = vi.fn(async url => {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  if (pathname.startsWith('/api/v1/commits')) {
    const q = searchParams.get('q');
    const matching = q ? commits.filter(c => c.message.includes(q)) : commits;
    const limit = Number(searchParams.get('limit'));
    const offset = Number(searchParams.get('offset'));
    return json(matching.slice(offset, offset + limit), { 'X-Has-More': String(offset + limit < matching.length) });
  }
  if (pathname === '/api/v1/project')
    return json({ git: { path_with_namespace: project }, qatools_config: { project: { name: project } } });
  if (pathname === '/api/v1/projects')
    return json({});
  return json({ is_authenticated: false });
});

const commit_requests = () => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname.startsWith('/api/v1/commits'));
const shown_messages = () => [...document.querySelectorAll("ul > li")].map(li => li.textContent.match(/Commit number \d+\./)?.[0]).filter(Boolean);

const renderPage = url => {
  const { match } = matchRoutes([{ path: '/:project_id+/commits/:name+' }, { path: '/:project_id+' }], url.split('?')[0]);
  return renderWithProviders(
    <MemoryRouter initialEntries={[url]}><RouteMatch match={match}><ComparisonProvider><CiCommitList/></ComparisonProvider></RouteMatch></MemoryRouter>,
    { siteConfig: {} },
  );
};


describe('CiCommitList', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads commits one page at a time, in the date range', async () => {
    renderPage(`/${project}`);
    await screen.findByText("Commit number 0.");
    expect(shown_messages()).toHaveLength(50);
    const [first] = commit_requests();
    expect(first.searchParams.get('limit')).toBe('50');
    expect(first.searchParams.get('offset')).toBe('0');
    expect(first.searchParams.get('from')).toBeTruthy();
    expect(first.searchParams.get('q')).toBeNull();

    fireEvent.click(screen.getByText('More commits'));
    await screen.findByText("Commit number 99.");
    expect(commit_requests().at(-1).searchParams.get('offset')).toBe('50');
    expect(shown_messages()).toHaveLength(100);

    fireEvent.click(screen.getByText('More commits'));
    await screen.findByText(`Commit number ${nb_commits - 1}.`);
    // that's all: we offer to look further in the past
    expect(screen.queryByText('More commits')).not.toBeInTheDocument();
    expect(screen.getByText('Older commits')).toBeInTheDocument();
  // renders 120 commits: slow when the whole suite runs in parallel
  }, 20_000);

  it('loads more when users scroll to the end', async () => {
    let observer_callback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { observer_callback = callback; }
      observe() {}
      disconnect() {}
    });
    renderPage(`/${project}`);
    await screen.findByText("Commit number 0.");
    act(() => observer_callback([{ isIntersecting: true }]));
    expect(await screen.findByText("Commit number 99.")).toBeInTheDocument();
  }, 20_000);

  it('searches all the commits on the server', async () => {
    renderPage(`/${project}?search=number 11`);
    await screen.findByText("Commit number 110.");
    const [request] = commit_requests();
    expect(request.searchParams.get('q')).toBe('number 11');
    // the whole history, not the date range
    expect(request.searchParams.get('from')).toBeNull();
    expect(request.searchParams.get('to')).toBeNull();
    await waitFor(() => expect(screen.getByText('11 matches')).toBeInTheDocument());
    expect(screen.getByText(/Searching all commits for/)).toBeInTheDocument();
    expect(shown_messages()).toEqual(commits.filter(c => c.message.includes('number 11')).map(c => c.message));
  });

  it('shows errors without the HTML pages servers answer with', async () => {
    const respond = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async url => url.startsWith('/api/v1/commits')
      ? new Response('<html><body><h1>Internal Server Error</h1></body></html>', { status: 500, statusText: 'Internal Server Error' })
      : respond(url));
    try {
      renderPage(`/${project}`);
      expect(await screen.findByText('Could not load the commits')).toBeInTheDocument();
      expect(screen.getByText('500 Internal Server Error')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    } finally {
      fetchMock.mockImplementation(respond);
    }
  });

  it('says how results get there, and offers to look further in the past', async () => {
    const respond = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async url => url.startsWith('/api/v1/commits') ? json([]) : respond(url));
    try {
      renderPage(`/${project}`);
      expect(await screen.findByText('No commits with results in the last 3 days')).toBeInTheDocument();
      expect(screen.getByText('Set up your CI')).toHaveAttribute('href', expect.stringMatching(/docs\/ci-integration$/));
      expect(screen.getByText('Search 7 more days')).toBeInTheDocument();
    } finally {
      fetchMock.mockImplementation(respond);
    }
  });

  it('says when nothing matches', async () => {
    renderPage(`/${project}?search=nothing-like-this`);
    expect(await screen.findByText('No commit matches your search')).toBeInTheDocument();
  });
});
