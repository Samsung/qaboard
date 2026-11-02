/**
 * URLs of projects that don't exist get a 404 page, not an empty project.
 * Run with: cd webapp && npm test -- NotFound
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import { ProjectNotFoundGate } from '../ProjectNotFoundGate';
import { history, matchRoutes, RouteMatch } from '../../router';
import { routes } from '../../routes';
import { renderWithProviders } from '../../test-utils';
import { projectQuery } from '../../api/queries';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// projects: those that exist
const mockApi = projects => vi.stubGlobal('fetch', vi.fn(async input => {
  const url = new URL(input, 'http://localhost');
  if (url.pathname === '/api/v1/project') {
    const project = url.searchParams.get('project');
    return projects[project] ? json({}) : json({ error: `There is no project ${project}.` }, 404);
  }
  if (url.pathname === '/api/v1/projects')
    return json(projects);
  return json({});
}));
afterEach(() => vi.unstubAllGlobals());
// the page is loaded on demand: once here, so that tests don't wait for it
beforeAll(() => import('../NotFoundPage'));

const Page = () => {
  const { match } = matchRoutes(routes, useLocation().pathname);
  return <RouteMatch match={match}><ProjectNotFoundGate><p>The project's page</p></ProjectNotFoundGate></RouteMatch>;
};
const renderAt = pathname => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}><Page/></HistoryRouter>, { user: { is_logged: true, user_id: 1, user_name: 'alice' }, siteConfig: {} });
};

const listed = { data: { qatools_config: { project: { name: 'x' } } }, latest_commit_datetime: '2026-10-01T00:00:00Z', total_commits: 1 };


test("says when there's no page, and links to all projects", async () => {
  mockApi({ 'group/repo': listed });
  renderAt('/admin/service-acounts');
  expect(await screen.findByRole('heading', { name: '404 Page not found' })).toBeInTheDocument();
  expect(screen.getByText('/admin/service-acounts')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('href', '/projects');
  expect(screen.queryByText("The project's page")).not.toBeInTheDocument();
});

test("compares the URL to the page users expected: the wipe's divider moves", async () => {
  mockApi({});
  renderAt('/nope');
  // the expected page covers everything, then the wipe uncovers this URL's side
  const divider = await screen.findByRole('separator', { name: 'Wipe' });
  expect(divider).toHaveAttribute('aria-valuenow', '0');
  await vi.waitFor(() => expect(divider).toHaveAttribute('aria-valuenow', '50'));
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider).toHaveAttribute('aria-valuenow', '45');
  expect(screen.getByText('this URL')).toBeInTheDocument();
  expect(screen.getByText('the page you expected')).toBeInTheDocument();
  expect(screen.getByText('-100%')).toBeInTheDocument();
});

test('links to the closest project above the URL', async () => {
  mockApi({ 'group/repo': listed });
  renderAt('/group/repo/typo/commits');
  expect(await screen.findByRole('button', { name: 'Open group/repo' })).toHaveAttribute('href', '/group/repo');
});

test('groups of projects list the projects below them', async () => {
  mockApi({ 'group/a': listed, 'group/b': listed });
  renderAt('/group');
  expect(await screen.findByRole('link', { name: 'a' })).toHaveAttribute('href', '/group/a');
  expect(screen.getByRole('link', { name: 'b' })).toBeInTheDocument();
});

test("projects that exist show their pages, and the Access page stays for groups of projects", async () => {
  mockApi({ 'group/repo': listed });
  const { queryClient } = renderAt('/group/repo/commits');
  expect(await screen.findByText("The project's page")).toBeInTheDocument();

  act(() => history.replace('/group/access'));
  await vi.waitFor(() => expect(queryClient.getQueryState(projectQuery('group').queryKey)?.error?.response?.status).toBe(404));
  expect(screen.getByText("The project's page")).toBeInTheDocument();
});
