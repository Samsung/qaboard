/**
 * Explore: sites have hundreds of projects, we render them progressively, as a tree. It shows each project's description.
 * Run with: cd webapp && npm test -- ExplorePage
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ExplorePage from '../ExplorePage';
import { SubprojectsCard } from '../SubprojectsCard';
import { projectsQuery } from '../../api/queries';
import { normalize_projects } from '../../api/normalize';
import { usePrefsStore } from '../../stores/prefs';
import { makeQueryClient, renderWithProviders } from '../../test-utils';


const nb_projects = 120;
const project_ids = Array.from({ length: nb_projects }, (_, i) => `project-${String(i).padStart(3, '0')}`);
// what /api/v1/projects?summary=true gives
const projects = Object.fromEntries(project_ids.map((id, i) => [id, {
  data: { git: { path_with_namespace: id, name: id }, qatools_config: { project: { name: id } } },
  latest_output_datetime: null,
  // the first projects have the most recent commits
  latest_commit_datetime: new Date(Date.UTC(2026, 9, 1) - i * 3600 * 1000).toISOString(),
  total_commits: 10,
}]));

const fetchMock = vi.fn(async url => {
  if (String(url).startsWith('/api/v1/projects'))
    return new Response(JSON.stringify(projects), { headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ is_authenticated: false }), { headers: { 'Content-Type': 'application/json' } });
});

// getAllByRole is slow with many elements
const shown_projects = () => [...document.querySelectorAll('h5')].map(h => h.textContent);

const renderList = () => renderWithProviders(<MemoryRouter><ExplorePage/></MemoryRouter>, { siteConfig: {} });


describe('ExplorePage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    usePrefsStore.setState({ favorites: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a summary of the projects', async () => {
    renderList();
    await screen.findByText('project-000');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects?summary=true', expect.anything());
  });

  it('renders the first projects, and more on demand', async () => {
    renderList();
    await screen.findByText('project-000');
    expect(shown_projects()).toHaveLength(50);
    expect(screen.getByText(`${nb_projects} projects`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show more (70)'));
    expect(shown_projects()).toHaveLength(100);
    fireEvent.click(screen.getByText('Show more (20)'));
    expect(shown_projects()).toHaveLength(nb_projects);
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();
  });

  it('filters all the projects, not only those shown', async () => {
    renderList();
    await screen.findByText('project-000');
    fireEvent.change(screen.getByPlaceholderText('Filter projects...'), { target: { value: 'project-11' } });
    expect(shown_projects()).toEqual(project_ids.filter(id => id.includes('project-11')));
    expect(screen.getByText('10 filtered projects')).toBeInTheDocument();
  });

  it('shows favorites first, even those that would not be shown yet', async () => {
    usePrefsStore.setState({ favorites: { 'project-119': true } });
    renderList();
    await screen.findByText('project-119');
    expect(shown_projects()[0]).toBe('project-119');
    expect(shown_projects()[1]).toBe('project-000');
  });

  it('loads more when users scroll to the end', async () => {
    let observer_callback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { observer_callback = callback; }
      observe() {}
      disconnect() {}
    });
    renderList();
    await screen.findByText('project-000');
    expect(shown_projects()).toHaveLength(50);
    act(() => observer_callback([{ isIntersecting: true }]));
    await waitFor(() => expect(shown_projects()).toHaveLength(100));
  });
});


const project = (description, git = {}) => ({
  latest_commit_datetime: '2026-10-08T14:10:00Z',
  total_commits: 12,
  data: {
    git: { path_with_namespace: 'kitefin/camera-isp', ...git },
    qatools_config: { project: { name: 'kitefin/camera-isp', ...(description ? { description } : {}) } },
  },
});

const renderProjects = (projects, siteConfig = {}) => {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(projectsQuery.queryKey, normalize_projects(projects));
  return renderWithProviders(<MemoryRouter><ExplorePage /></MemoryRouter>, {
    queryClient,
    user: { is_logged: true, user_name: 'ines' },
    siteConfig: { docs_root: '/', login_required: false, ...siteConfig },
  });
};

describe('ExplorePage descriptions', () => {
  // Nothing else should be needed from the server
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the description from qaboard.yaml for projects that aren't on GitHub or GitLab", () => {
    renderProjects({ 'kitefin/camera-isp': project('Camera ISP pipeline') });
    expect(screen.getByText('Camera ISP pipeline')).toBeInTheDocument();
  });

  it('prefers the description from qaboard.yaml to the one from GitHub/GitLab', () => {
    renderProjects({ 'kitefin/camera-isp': project('Camera ISP pipeline', { description: 'Mirror of the ISP repo' }) });
    expect(screen.getByText('Camera ISP pipeline')).toBeInTheDocument();
    expect(screen.queryByText('Mirror of the ISP repo')).not.toBeInTheDocument();
  });

  it('falls back to the description from GitHub/GitLab', () => {
    renderProjects({ 'kitefin/camera-isp': project(undefined, { description: 'Mirror of the ISP repo' }) });
    expect(screen.getByText('Mirror of the ISP repo')).toBeInTheDocument();
  });

  it('counts the projects', () => {
    renderProjects({ 'kitefin/camera-isp': project('Camera ISP pipeline') });
    expect(screen.getByText('1 project')).toBeInTheDocument();
  });

  it("without projects, links to the docs and to the server's support page", () => {
    renderProjects({}, { docs_root: '/qa/', support_url: 'https://support.example.com/qaboard' });
    expect(screen.getByRole('link', { name: 'get started' })).toHaveAttribute('href', '/qa/docs/installation');
    expect(screen.getByRole('link', { name: 'ask the maintainers' })).toHaveAttribute('href', 'https://support.example.com/qaboard');
  });
});


const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
// someone used it lately, or only the CI ran it
const used = { data: { qatools_config: { project: { name: 'x' } } }, latest_commit_datetime: recent, total_commits: 3, latest_human_activity: recent, views_90d: 1, my_last_view: null, activity: null };
const ci_only = { ...used, latest_human_activity: null, views_90d: 0, latest_output_datetime: recent };

describe('ExplorePage tree', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    usePrefsStore.setState({ favorites: {}, exploreGroups: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const tree = {
    'kitefin/k3': used, 'kitefin/k3/denoise': used, 'kitefin/k3/ci-a': ci_only, 'kitefin/k3/ci-b': ci_only,
    'kitefin/k5': used, 'old/one': ci_only, 'old/two': ci_only,
  };

  it('groups projects, shows subprojects on demand, and remembers it', () => {
    renderProjects(tree);
    // a group for the prefix, open
    expect(shown_projects()).toEqual(['kitefin', 'k3', 'k5']);
    expect(screen.getByText('2 quiet projects')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '3 subprojects' }));
    expect(usePrefsStore.getState().exploreGroups).toEqual({ 'kitefin/k3': true });
    expect(shown_projects()).toEqual(['kitefin', 'k3', 'denoise', 'k5']);
    // the CI's subprojects are quiet
    fireEvent.click(screen.getByRole('button', { name: '2 quiet subprojects' }));
    expect(shown_projects()).toEqual(['kitefin', 'k3', 'denoise', 'ci-a', 'ci-b', 'k5']);
    // closing a group
    fireEvent.click(screen.getByRole('button', { name: '5 projects' }));
    expect(shown_projects()).toEqual(['kitefin']);
  });

  it('links to projects, with their full id', () => {
    renderProjects(tree);
    expect(screen.getByRole('link', { name: 'k5' })).toHaveAttribute('href', '/kitefin/k5');
    expect(screen.getByText('kitefin/k5')).toBeInTheDocument();
  });

  it('never hides pinned projects', () => {
    usePrefsStore.setState({ favorites: { 'old/two': true } });
    renderProjects(tree);
    // its group stays, with the other quiet one inside
    expect(shown_projects()).toEqual(['old', 'two', 'kitefin', 'k3', 'k5']);
    expect(screen.getByText('1 quiet subproject')).toBeInTheDocument();
    expect(screen.queryByText(/quiet projects?$/)).not.toBeInTheDocument();
  });

  it('filters all the projects, quiet ones included, with their full path', () => {
    renderProjects(tree);
    fireEvent.change(screen.getByPlaceholderText('Filter projects...'), { target: { value: 'ci-' } });
    expect(shown_projects()).toEqual(['kitefin/k3/ci-a', 'kitefin/k3/ci-b']);
    expect(screen.getAllByText('quiet')).toHaveLength(2);
    expect(screen.getByText('2 filtered projects')).toBeInTheDocument();
  });
});


describe('SubprojectsCard', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))));
  afterEach(() => vi.unstubAllGlobals());

  const renderCard = (project, projects) => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(projectsQuery.queryKey, normalize_projects(projects));
    return renderWithProviders(<MemoryRouter><SubprojectsCard project={project}/></MemoryRouter>, { queryClient, siteConfig: {} });
  };

  it("lists the project's subprojects, quiet ones last", () => {
    renderCard('repo', { 'repo': used, 'repo/ci': ci_only, 'repo/a/x': used, 'repo/a/y': used, 'other': used });
    expect(screen.getByText('(3)')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['a/x', '/repo/a/x'], ['a/y', '/repo/a/y'], ['ci', '/repo/ci'],
    ]);
    expect(screen.getAllByText('quiet')).toHaveLength(1);
  });

  it('shows nothing without subprojects', () => {
    const { container } = renderCard('other', { 'repo': used, 'repo/a': used, 'other': used });
    expect(container).toBeEmptyDOMElement();
  });
});
