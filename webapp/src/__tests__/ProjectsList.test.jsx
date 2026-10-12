/**
 * The projects list shows each project's description.
 * Run with: cd webapp && npm test -- ProjectsList
 */
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { MemoryRouter } from 'react-router';

import ProjectsList from '../ProjectsList';

// PrivateContent checks who is logged in
vi.mock('axios', () => ({ default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(() => new Promise(() => {})) } }));


const project = (description, git = {}) => ({
  latest_commit_datetime: '2026-10-08T14:10:00Z',
  total_commits: 12,
  data: {
    git: { path_with_namespace: 'kitefin/camera-isp', ...git },
    qatools_config: { project: { name: 'kitefin/camera-isp', ...(description ? { description } : {}) } },
  },
});

const renderProjects = projects => {
  const store = createStore(() => ({
    projects: { data: projects, is_loaded: true },
    user: { is_logged: true, user_name: 'ines' },
    siteConfig: { docs_root: '/', login_required: false },
  }));
  return render(
    <Provider store={store}>
      <MemoryRouter><ProjectsList /></MemoryRouter>
    </Provider>
  );
};


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
});
