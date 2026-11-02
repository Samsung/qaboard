// Signing in (docs-media/shots.yaml: auth/*), with a local account of the demo stack.
import { shot } from './lib';

shot('auth/login', {
  project: null,
  login: null,
  // where the Sign in button, at the top right, leads
  url: d => `${d.baseUrl}/login`,
  alt: 'The "Sign in to QA-Board" page: a user name field with "ines", a password field, the Sign in button, and a '
    + 'link to create an account.',
  caption: 'Click Sign in at the top right, then sign in with your user name and password.',
  actions: async ui => {
    const form = ui.page.getByRole('form', { name: 'Sign in with a user name and password' });
    await ui.type(form.getByLabel('User name'), 'ines');
    await ui.type(form.getByLabel('Password'), 'kitefin-demo');
    // no focus ring
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  target: page => [
    page.getByRole('heading', { name: 'Sign in to QA-Board' }),
    page.locator('.bp6-card').filter({ has: page.getByRole('form', { name: 'Sign in with a user name and password' }) }),
  ],
  padding: 32,
});
