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


describe('the Code menu', () => {
  const project_data = { data: { git: { web_url: 'https://github.com/kitefin/monorepo', path_with_namespace: 'kitefin/monorepo' } } };
  const commit = { id: '0123456789abcdef', branch: 'feature/x' };
  const open = () => fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Code/ }));
  const href = name => {
    const item = screen.getByRole('menuitem', { name });
    return (item.closest('a') ?? item.querySelector('a'))?.getAttribute('href');
  };

  test("on a commit page, links to the commit, its files, its subproject's folder, its branch and the repository", async () => {
    const { Menu } = await import('@blueprintjs/core');
    const { CodeMenu } = await import('../AppSider');
    renderWithProviders(<Menu><CodeMenu project="kitefin/monorepo/isp" project_data={project_data} commit={commit} branch={commit.branch}/></Menu>);
    // a click goes to the subproject's folder at the commit
    expect(href(/^Code/)).toBe('https://github.com/kitefin/monorepo/tree/0123456789abcdef/isp');
    open();
    await screen.findByRole('menuitem', { name: /Changes in 01234567/ });
    expect(href(/Changes in/)).toBe('https://github.com/kitefin/monorepo/commit/0123456789abcdef');
    expect(href(/Files at/)).toBe('https://github.com/kitefin/monorepo/tree/0123456789abcdef');
    expect(href(/isp on feature\/x/)).toBe('https://github.com/kitefin/monorepo/tree/feature/x/isp');
    expect(href(/Commits on feature\/x/)).toBe('https://github.com/kitefin/monorepo/commits/feature/x');
    expect(href(/Repository/)).toBe('https://github.com/kitefin/monorepo');
  });

  test('on a branch, links to its files and commits', async () => {
    const { Menu } = await import('@blueprintjs/core');
    const { CodeMenu } = await import('../AppSider');
    renderWithProviders(<Menu><CodeMenu project="kitefin/monorepo" project_data={project_data} branch="main"/></Menu>);
    expect(href(/^Code/)).toBe('https://github.com/kitefin/monorepo');
    open();
    await screen.findByRole('menuitem', { name: /Files on main/ });
    expect(screen.queryByRole('menuitem', { name: /Changes in/ })).toBeNull();
  });
});
