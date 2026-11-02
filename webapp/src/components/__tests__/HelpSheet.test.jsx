/**
 * The cheat sheet opens with "?", except while people type.
 * Run with: cd webapp && npm test -- HelpSheet
 */
import { fireEvent, screen } from '@testing-library/react';

import { HelpSheetProvider, useHelpSheet } from '../HelpSheet';
import { renderWithProviders } from '../../test-utils';

const OpenButton = () => <button onClick={useHelpSheet().open}>help</button>;
const render = () => renderWithProviders(<HelpSheetProvider><input aria-label="filter"/><OpenButton/></HelpSheetProvider>, {
  siteConfig: { docs_root: '/qa/' },
});
const sheet = () => screen.queryByRole('dialog', { name: /Cheat sheet/ });

test('"?" opens it', async () => {
  render();
  expect(sheet()).toBeNull();
  fireEvent.keyDown(document.body, { key: '?' });
  expect(await screen.findByRole('dialog', { name: /Cheat sheet/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /User guide/ })).toHaveAttribute('href', '/qa/docs/user-guide/overview');
});

test('"?" types in text boxes', () => {
  render();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'filter' }), { key: '?' });
  expect(sheet()).toBeNull();
  // and shortcuts with modifiers are the browser's
  fireEvent.keyDown(document.body, { key: '?', ctrlKey: true });
  expect(sheet()).toBeNull();
});

test('the help button opens it', async () => {
  render();
  fireEvent.click(screen.getByRole('button', { name: 'help' }));
  expect(await screen.findByRole('dialog', { name: /Cheat sheet/ })).toBeInTheDocument();
});
