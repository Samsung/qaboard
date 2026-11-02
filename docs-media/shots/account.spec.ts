// Settings: your account and access tokens (docs-media/shots.yaml: account/*). Nothing is saved.
import { shot } from './lib';

shot('account/create-token', {
  project: null,
  login: 'arjun',
  url: d => `${d.baseUrl}/settings/tokens`,
  alt: 'The New access token dialog: the name "detector CI", Read and Ingest checked but not Act, the project '
    + 'kitefin/detector, and an expiry of 90 days, with its date.',
  caption: 'A token for one CI job: it reads and sends results, for one project only, and expires in 90 days.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Create a token' }));
    const dialog = ui.page.getByRole('dialog', { name: 'New access token' });
    await ui.type(dialog.getByLabel('Name'), 'detector CI');
    await ui.type(dialog.locator('#token-projects'), 'kitefin/detector');
    await ui.press('Enter');
    // no focus ring, no caret in the projects
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1300, y: 860 });
    await ui.settle();
  },
  // the dialog alone: the page's text behind the backdrop would be cut
  target: page => page.getByRole('dialog', { name: 'New access token' }),
  padding: 0,
});
