// Signing in (docs-media/shots.yaml: auth/*), with a local account of the demo stack.
import { shot } from './lib';

shot('auth/login', {
  project: null,
  login: null,
  url: d => `${d.baseUrl}/`,
  alt: 'The Login dialog over the projects list: a user name field with "ines", a password field, and a Log In button.',
  caption: 'Click Login at the top right, then sign in with your user name and password.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Log in' }).first());
    await ui.settle();
    const dialog = ui.page.locator('.bp6-dialog');
    await ui.type(dialog.locator('#username'), 'ines');
    await ui.type(dialog.locator('#password'), 'kitefin-demo');
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  target: page => page.locator('.bp6-dialog'),
  padding: 32,
});
