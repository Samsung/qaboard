// Settings: your account and access tokens (docs-media/shots.yaml: account/*), and the page where people approve a
// `qa auth login`. Nothing is saved, but for the sign-ins the CLI shot starts: they're denied afterwards.
import { test } from '@playwright/test';
import { shot } from './lib';
import { demo } from './lib/demo';
import { apiAs, answerCliSignIn, startCliSignIn } from './demoState';

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

shot('account/preferences', {
  project: null,
  login: 'arjun',
  url: d => `${d.baseUrl}/settings/preferences`,
  viewport: { width: 1440, height: 1100 },
  alt: 'Settings → Preferences: the theme (Same as your system, Light, Dark), Comfortable or Compact lists of commits and '
    + 'run cards, when runs\' names start with their batch and database, the values written on the pixels, and two '
    + 'switches for the runs\' settings.',
  caption: 'Choose how lists, run cards and images look: signed in, your preferences follow you to every browser.',
  actions: async ui => {
    await ui.page.getByRole('region', { name: 'Preferences' }).getByText('Pinned projects').waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.settle();
  },
  // with the tabs: the other settings
  target: page => [page.getByRole('heading', { name: 'Settings', exact: true }), page.getByRole('region', { name: 'Preferences' })],
});

// `qa auth login` on Arjun's GPU server: the sign-in is started through the API the CLI calls, from this computer
// (the backend sees the stack's gateway address). Its code is random: the page is opened with the one the docs show,
// and its requests for that code ask the server about the real one, so that captures don't differ by their code.
const CLI_CODE = 'WDJB-MJHT';
const cliSignIns: string[] = [];
test.afterAll(async () => {
  if (!cliSignIns.length) return;
  const arjun = await apiAs(demo(), 'arjun');
  try {
    for (const code of cliSignIns.splice(0)) await answerCliSignIn(arjun, code, false);
  } finally {
    await arjun.dispose();
  }
});

shot('account/cli-sign-in', {
  project: null,
  login: 'arjun',
  url: d => `${d.baseUrl}/device?code=${CLI_CODE}`,
  // at the server's time, the periods of newer release notes are over: they'd pop up
  storage: { 'qaboard.release-notes.last-seen': '9999-12-31' },
  alt: 'The Device sign-in page: "Authorize qa CLI on gpu-03?", it will be able to see projects and runs, save runs and '
    + 'redo, delete and tune runs as arjun; the code, the computer, the address it came from, its scopes, and Approve '
    + 'and Deny buttons under a warning.',
  caption: 'Check that the code and the computer are yours, then approve: qa works as you on that computer.',
  actions: async ui => {
    const code = await startCliSignIn(ui.demo, 'gpu-03');
    cliSignIns.push(code);
    await ui.page.route(url => url.pathname.replace(/\/$/, '') === '/api/v1/auth/device' && url.searchParams.get('code') === CLI_CODE, route => {
      const url = new URL(route.request().url());
      url.searchParams.set('code', code);
      return route.continue({ url: url.toString() });
    });
    // the request was made now, by the server's clock: "just now", expires "in 15 minutes"
    await ui.page.clock.setSystemTime(new Date());
    await ui.goto(ui.page.url());
    await ui.page.getByRole('button', { name: 'Approve' }).waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.settle();
  },
  // the title and the card, as wide as the card: the title's and description's blocks span the page (a box gets no padding)
  target: async page => {
    const title = await page.getByRole('heading', { name: 'Device sign-in' }).boundingBox();
    const card = await page.locator('.bp6-card').filter({ hasText: 'Authorize' }).boundingBox();
    if (!title || !card) throw new Error('[account.spec] the device sign-in has no box');
    const padding = 16;
    return { x: card.x - padding, y: title.y - padding, width: card.width + 2 * padding, height: card.y + card.height - title.y + 2 * padding };
  },
});
