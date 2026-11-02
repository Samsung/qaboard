/**
 * The user menu links to the settings, and for admins to the admin panel.
 * Run with: cd webapp && npm test -- UserMenu
 */
import { screen, fireEvent } from '@testing-library/react';

import AuthButton from '../Auth';
import { history } from '../../../router';
import { renderWithProviders } from '../../../test-utils';

const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', is_admin: false };

// On the top bar, the menu opens on click, under its button
const openMenu = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Alice: your account' }));
  return screen.findByRole('menuitem', { name: 'Settings' });
};

afterEach(() => vi.restoreAllMocks());

test('links to the settings, without reloading the app', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')));
  renderWithProviders(<AuthButton/>, { user: alice, siteConfig: {} });
  const settings = await openMenu();
  expect(settings).toHaveAttribute('href', '/settings');
  expect(screen.queryByRole('menuitem', { name: 'Admin' })).not.toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  // under its button, not over it
  expect(document.querySelector('.user-menu-popover').className).toMatch(/placement-bottom/);
  fireEvent.click(settings);
  expect(history.location.pathname).toBe('/settings');
});

test('admins see the admin panel', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')));
  renderWithProviders(<AuthButton/>, { user: { ...alice, is_admin: true }, siteConfig: {} });
  await openMenu();
  expect(screen.getByRole('menuitem', { name: 'Admin' })).toHaveAttribute('href', '/admin');
});

test('in the sidebar, the menu is a submenu', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('{}')));
  renderWithProviders(<AuthButton appSider/>, { user: alice, siteConfig: {} });
  fireEvent.mouseEnter(screen.getByText('Alice'));
  expect(await screen.findByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
});
