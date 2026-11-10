/**
 * The tabs at the top of a project's Admin pages: links to each page, the current one marked.
 * Run with: cd webapp && npm test -- ProjectAdminTabs
 */
import { act, fireEvent, screen, within } from '@testing-library/react';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { history } from '../../router';
import { renderWithProviders } from '../../test-utils';
import { ProjectAdminTabs, project_admin_pages } from '../ProjectAdminTabs';


const renderTabs = props => {
  act(() => history.replace('/'));
  renderWithProviders(<HistoryRouter history={history}><ProjectAdminTabs {...props}/></HistoryRouter>);
  return within(screen.getByRole('navigation', { name: 'Project admin' }));
};

test('links to the Admin pages, and says which one is shown', () => {
  const tabs = renderTabs({ project: 'group/repo', current: 'gate' });
  const access = tabs.getByRole('link', { name: 'Access' });
  const gate = tabs.getByRole('link', { name: 'Quality gate' });
  expect(tabs.getAllByRole('link')).toEqual([access, gate]);
  expect(access).toHaveAttribute('href', '/group/repo/access');
  expect(access).not.toHaveAttribute('aria-current');
  expect(gate).toHaveAttribute('href', '/group/repo/admin/gate');
  expect(gate).toHaveAttribute('aria-current', 'page');
});

test('navigates within the app', () => {
  const tabs = renderTabs({ project: 'group/repo', current: 'access' });
  expect(tabs.getByRole('link', { name: 'Access' })).toHaveAttribute('aria-current', 'page');
  // handled by the router: the browser doesn't reload the app
  expect(fireEvent.click(tabs.getByRole('link', { name: 'Quality gate' }))).toBe(false);
  expect(window.location.pathname).toBe('/group/repo/admin/gate');
});

test('escapes what project ids can have', () => {
  expect(project_admin_pages('group/my repo#1').map(page => page.to)).toEqual(['/group/my%20repo%231/access', '/group/my%20repo%231/admin/gate']);
});
