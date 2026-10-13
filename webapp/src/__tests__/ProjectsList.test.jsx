/**
 * The projects list shows each project's description.
 * Run with: cd webapp && npm test -- ProjectsList
 */
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ProjectsList from '../ProjectsList';
import { projectsQuery } from '../api/queries';
import { normalize_projects } from '../api/normalize';
import { makeQueryClient, renderWithProviders } from '../test-utils';


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

// Nothing else should be needed from the server
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))));
afterEach(() => vi.unstubAllGlobals());


describe('ProjectsList', () => {
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
