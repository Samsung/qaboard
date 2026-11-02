/**
 * Home, for signed-in users: their projects, their running, failed and recent batches, their teammates', what's new.
 * Run with: cd webapp && npm test -- HomePage
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import HomePage from '../HomePage';
import { ReleaseNotesProvider } from '../../releaseNotes/ReleaseNotes';
import { LAST_SEEN_KEY } from '../../releaseNotes/logic';
import { renderWithProviders } from '../../test-utils';
import { usePrefsStore } from '../../stores/prefs';


const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', is_admin: false };
const hours_ago = n => new Date(Date.now() - n * 3600 * 1000).toISOString();
const commit = { id: 'b'.repeat(40), branch: 'feature', message: 'Faster denoising', committer_name: 'Alice' };
const batch = (id, label, extra = {}) => ({
  id, label, project: 'kitefin/k3', origin: 'webapp', user_name: 'alice', latest_output_datetime: hours_ago(1), created_date: hours_ago(2), data: {},
  valid_outputs: 4, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0, aggregated_metrics: {}, commit, ...extra,
});
const running = batch(1, 'sweep', { pending_outputs: 6, running_outputs: 2 });
const failed = batch(2, 'denoise-2', { failed_outputs: 3 });
const recent = batch(3, 'denoise-1', { default_metric: 'psnr', default_metric_info: { label: 'PSNR', suffix: 'dB' }, aggregated_metrics: { psnr_average: 31.25 } });
const bobs = batch(4, 'tonemap-gamma', { project: 'hdr/tonemap', user_name: 'bob', origin: 'local' });
const project = extra => ({ data: { qatools_config: { project: { name: 'x' } } }, latest_commit_datetime: hours_ago(5), total_commits: 3, activity: [0, 1, 2], ...extra });
const projects = {
  'kitefin/k3': project({ my_latest_activity: hours_ago(1) }),
  'hdr/tonemap': project({ my_last_view: hours_ago(30) }),
  'old/one': project({ latest_human_activity: hours_ago(50) }),
};
const note = {
  slug: '2026-10', date: '2026-10-05', period: '2026-10', title: 'October 2026', description: 'A home page.', html: '',
  highlights: [{ title: 'A home page about you', icon: 'home', audience: 'users', description: 'Your batches.', link: '/docs/user-guide/finding-results' }],
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Has-More': 'false' } });
let mine = true;
let fail_recent = false;
const fetchMock = vi.fn(async url => {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  if (pathname === '/api/v1/batches') {
    if (searchParams.get('scope') === 'others') return json([bobs]);
    if (!mine) return json([]);
    if (searchParams.get('status') === 'pending') return json([running]);
    if (searchParams.get('status') === 'failed') return json([failed]);
    if (fail_recent) return json({ error: 'The database is down' }, 500);
    return json([running, failed, recent]);
  }
  if (pathname === '/api/v1/projects') return json(projects);
  if (pathname === '/api/v1/storage/overview') return json({ totals: { bytes: 1.5e12, runs: 1200, batches: 30, projects: 2 }, projects: [{ project_id: 'kitefin/k3', bytes: 1e12 }] });
  return json({});
});
const requests = path => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname === path);

const renderHome = () => renderWithProviders(
  <MemoryRouter><ReleaseNotesProvider load={() => Promise.resolve([note])} popupDelay={0}><HomePage/></ReleaseNotesProvider></MemoryRouter>,
  { siteConfig: { docs_root: '/qa/' }, user: alice },
);

describe('the home page', () => {
  beforeEach(() => {
    mine = true;
    fail_recent = false;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(LAST_SEEN_KEY, '2099-12');
    usePrefsStore.setState({ favorites: { 'old/one': true }, homeDismissed: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows what runs, what failed and what ended', async () => {
    renderHome();
    const running_list = await screen.findByRole('list', { name: 'Your running batches' });
    expect(within(running_list).getByText('sweep')).toBeInTheDocument();
    expect(within(running_list).getByText('4/10')).toBeInTheDocument();
    expect(within(running_list).getByRole('link', { name: 'The logs of sweep' })).toHaveAttribute('href', expect.stringContaining('selected_views=logs'));
    expect(requests('/api/v1/batches').find(url => url.searchParams.get('status') === 'pending').searchParams.get('scope')).toBe('mine');

    const failed_list = screen.getByRole('list', { name: 'Your batches with failed runs' });
    expect(within(failed_list).getByText('3 failed')).toBeInTheDocument();
    expect(requests('/api/v1/batches').find(url => url.searchParams.get('status') === 'failed').searchParams.get('since_days')).toBe('7');

    // finished only, with the default metric
    const recent_list = screen.getByRole('list', { name: 'Your recent batches' });
    expect(within(recent_list).queryByText('sweep')).not.toBeInTheDocument();
    expect(within(recent_list).getByText('denoise-1')).toBeInTheDocument();
    // formatted like the project's pages
    expect(within(recent_list).getByText(/31\.3/)).toHaveTextContent('31.3dB');
    // without fetching each project
    expect(requests('/api/v1/project')).toHaveLength(0);
  });

  it('lists their projects, pins included, the most recent first', async () => {
    renderHome();
    const list = await screen.findByRole('list', { name: 'Your projects' });
    expect(within(list).getAllByRole('link').filter(a => a.textContent).map(a => a.textContent)).toEqual(['kitefin/k3', 'hdr/tonemap', 'old/one']);
    expect(screen.getByRole('link', { name: /Explore all projects/ })).toHaveAttribute('href', '/projects');
  });

  it('dismisses failed batches', async () => {
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss denoise-2' }));
    expect(screen.queryByRole('list', { name: 'Your batches with failed runs' })).not.toBeInTheDocument();
    expect(usePrefsStore.getState().homeDismissed[2]).toMatchObject({ failed: 3 });
  });

  it("shows teammates' batches in their projects on demand", async () => {
    renderHome();
    await screen.findByRole('list', { name: 'Your projects' });
    expect(requests('/api/v1/batches').some(url => url.searchParams.get('scope') === 'others')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'From your projects' }));
    const list = await screen.findByRole('list', { name: "Your teammates' batches" });
    expect(within(list).getByText('bob')).toBeInTheDocument();
    const url = requests('/api/v1/batches').find(url => url.searchParams.get('scope') === 'others');
    expect(url.searchParams.get('projects')).toBe('kitefin/k3,hdr/tonemap,old/one');
    expect(url.searchParams.get('origin')).toBe('webapp,local');
  });

  it("shows what's new, their storage, and docs", async () => {
    renderHome();
    expect(await screen.findByRole('link', { name: 'A home page about you' })).toHaveAttribute('href', '/qa/docs/user-guide/finding-results');
    expect(await screen.findByText('1.5 TB')).toBeInTheDocument();
    // they tuned from the web app already
    const learn = screen.getByRole('region', { name: 'Learn' });
    expect(within(learn).queryByText(/Tune from the web app/)).not.toBeInTheDocument();
    expect(within(learn).getByRole('link', { name: /Follow your runs/ })).toHaveAttribute('href', '/qa/docs/user-guide/runs-activity');
  });

  it('teaches new users how to get started', async () => {
    mine = false;
    renderHome();
    expect(await screen.findByText(/Sign your runs/)).toBeInTheDocument();
    expect(screen.getByText('qa auth login')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recent' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Learn' })).getByRole('link', { name: /Review your first results/ })).toBeInTheDocument();
  });

  it('says when something could not load, and retries', async () => {
    fail_recent = true;
    renderHome();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your recent batches');
    fail_recent = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Your recent batches' })).toBeInTheDocument());
  });
});
