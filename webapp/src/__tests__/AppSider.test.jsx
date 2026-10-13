/**
 * The sidebar shows the project's navigation on commit lists and on the History page.
 * Run with: cd webapp && npm test -- AppSider.test
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter, useLocation } from 'react-router';

import AppSider from '../AppSider';
import { ComparisonProvider } from '../hooks';
import { history, matchRoutes, RouteMatch } from '../router';
import { routes } from '../routes';
import { renderWithProviders } from '../test-utils';

const Page = () => {
  const { match } = matchRoutes(routes, useLocation().pathname);
  return <RouteMatch match={match}><ComparisonProvider><AppSider/></ComparisonProvider></RouteMatch>;
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async input => {
    const { pathname } = new URL(input, 'http://localhost');
    if (pathname === '/api/v1/project')
      return new Response(JSON.stringify({ git: { path_with_namespace: 'kitefin/camera-isp' }, qatools_config: { project: { reference_branch: 'main' } } }));
    if (pathname.startsWith('/api/v1/commits'))
      return new Response('[]');
    return new Response('{}');
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderSider = pathname => {
  act(() => history.replace(pathname));
  return renderWithProviders(<HistoryRouter history={history}><Page/></HistoryRouter>, {
    user: { is_logged: false },
    siteConfig: { login_required: false },
  });
};


test("on History, the branch's commits and History are a click away, without reloading the app", async () => {
  renderSider('/kitefin/camera-isp/history/feature/denoise');
  const history_link = await screen.findByRole('menuitem', { name: /History/ });
  expect(history_link).toHaveAttribute('href', '/kitefin/camera-isp/history/feature/denoise');
  expect(history_link).toHaveClass('bp6-active');

  const branch_link = screen.getByRole('menuitem', { name: /feature\/denoise/ });
  expect(branch_link).toHaveAttribute('href', '/kitefin/camera-isp/commits/feature/denoise');
  const not_prevented = fireEvent.click(branch_link);
  expect(not_prevented).toBe(false);
  expect(window.location.pathname).toBe('/kitefin/camera-isp/commits/feature/denoise');
});

test('ctrl+click still lets the browser open a new tab', async () => {
  renderSider('/kitefin/camera-isp/commits');
  const history_link = await screen.findByRole('menuitem', { name: /History/ });
  // the project's reference branch
  await vi.waitFor(() => expect(history_link).toHaveAttribute('href', '/kitefin/camera-isp/history/main'));
  expect(fireEvent.click(history_link, { ctrlKey: true })).toBe(true);
  expect(window.location.pathname).toBe('/kitefin/camera-isp/commits');
});
