/**
 * The search box above the commits: typing filters them, Enter doesn't leave the page unless users picked a branch or commit.
 * Run with: cd webapp && npm test -- AppNavbar
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import AppNavbar from '../AppNavbar';
import { ComparisonProvider } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { renderWithProviders } from '../test-utils';


const project = 'group/proj';
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn(async url => {
  const { pathname } = new URL(url, 'http://localhost');
  if (pathname === '/api/v1/project/branches') return json(['master', 'feature/master-fix']);
  if (pathname.startsWith('/api/v1/commits')) return json([]);
  if (pathname === '/api/v1/project') return json({ qatools_config: { project: { name: project } } });
  if (pathname === '/api/v1/projects') return json({});
  return json({ is_authenticated: false });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(history, 'push');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderNavbar = () => {
  const url = `/${project}/commits`;
  const { match } = matchRoutes([{ path: '/:project_id+/commits' }], url);
  renderWithProviders(
    <MemoryRouter initialEntries={[url]}><RouteMatch match={match}><ComparisonProvider><AppNavbar/></ComparisonProvider></RouteMatch></MemoryRouter>,
    { siteConfig: {} },
  );
  return screen.getByPlaceholderText(/Search commits/);
};

const press = (input, key) => {
  fireEvent.keyDown(input, { key });
  fireEvent.keyUp(input, { key });
};

test('Enter keeps filtering', async () => {
  const input = renderNavbar();
  act(() => input.focus());
  fireEvent.change(input, { target: { value: 'master' } });
  await screen.findByText('feature/master-fix');
  press(input, 'Enter');
  expect(history.push).not.toHaveBeenCalled();
  expect(input.value).toBe('master');
});

test('Picking a commit with the arrow keys, then Enter, goes to it', async () => {
  const input = renderNavbar();
  act(() => input.focus());
  fireEvent.change(input, { target: { value: 'abc123' } });
  await screen.findByText(/Go to commit/);
  press(input, 'ArrowDown');
  press(input, 'Enter');
  expect(history.push).toHaveBeenCalledWith(`/${project}/commit/abc123`);
});
