/**
 * The projects list: sites have hundreds of projects, we render them progressively. It shows each project's description.
 * Run with: cd webapp && npm test -- ProjectsList
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ProjectsList from '../ProjectsList';
import { projectsQuery } from '../api/queries';
import { normalize_projects } from '../api/normalize';
import { usePrefsStore } from '../stores/prefs';
import { makeQueryClient, renderWithProviders } from '../test-utils';


const nb_projects = 120;
const project_ids = Array.from({ length: nb_projects }, (_, i) => `group/project-${String(i).padStart(3, '0')}`);
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

const renderList = () => renderWithProviders(<MemoryRouter><ProjectsList/></MemoryRouter>, { siteConfig: {} });


describe('ProjectsList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    usePrefsStore.setState({ favorites: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a summary of the projects', async () => {
    renderList();
    await screen.findByText('group/project-000');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects?summary=true', expect.anything());
  });

  it('renders the first projects, and more on demand', async () => {
    renderList();
    await screen.findByText('group/project-000');
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
    await screen.findByText('group/project-000');
    fireEvent.change(screen.getByPlaceholderText('Filter projects...'), { target: { value: 'project-11' } });
    expect(shown_projects()).toEqual(project_ids.filter(id => id.includes('project-11')));
    expect(screen.getByText('10 filtered projects')).toBeInTheDocument();
  });

  it('shows favorites first, even those that would not be shown yet', async () => {
    usePrefsStore.setState({ favorites: { 'group/project-119': true } });
    renderList();
    await screen.findByText('group/project-119');
    expect(shown_projects()[0]).toBe('group/project-119');
    expect(shown_projects()[1]).toBe('group/project-000');
  });

  it('loads more when users scroll to the end', async () => {
    let observer_callback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { observer_callback = callback; }
      observe() {}
      disconnect() {}
    });
    renderList();
    await screen.findByText('group/project-000');
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
  return renderWithProviders(<MemoryRouter><ProjectsList /></MemoryRouter>, {
    queryClient,
    user: { is_logged: true, user_name: 'ines' },
    siteConfig: { docs_root: '/', login_required: false, ...siteConfig },
  });
};

describe('ProjectsList descriptions', () => {
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
