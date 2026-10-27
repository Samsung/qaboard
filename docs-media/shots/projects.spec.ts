// Finding your way (docs-media/shots.yaml: projects/*): the home page, Explore, the list of projects, and the search
// that opens from any page. Not tied to one demo project: every project of the snapshot shows.
import { shot, type Page, type Ui } from './lib';
import { stableBox } from './imageViewer';

// Preferences follow users on the server (webapp/src/stores/prefsSync.js), favorites too. A shot that needs one gets
// it in the API's answer, and what the page sends back never reaches the server: the persona's preferences stay as the
// demo has them for the other shots. The page is loaded again with it.
async function withPreferences(ui: Ui, preferences: Record<string, unknown>) {
  await ui.page.route('**/api/v1/user/preferences', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, json: {} });
    const response = await route.fetch();
    const body = await response.json() as { preferences?: Record<string, unknown> };
    await route.fulfill({ response, json: { ...body, preferences: { ...body.preferences, ...preferences } } });
  });
  await ui.page.reload();
  await ui.settle();
}

// The home page, signed in (webapp/src/home/HomePage.jsx). Arjun works on the detector and the fleet assistant: two
// projects, and three batches of his own (a tuning experiment in each, his local size sweep). His projects are sorted by
// when he last used them, page views included: the detector shots (commit.spec.ts, commits.spec.ts) open his project
// last, before this file runs
shot('projects/home', {
  project: null,
  login: 'arjun',
  url: d => `${d.baseUrl}/`,
  alt: 'The home page signed in as Arjun: his projects, the fleet assistant and the detector, with their runs over 30 '
    + 'days; his recent batches, two tuning experiments and a local sweep, each with its runs and main metric; on the '
    + 'right, What\'s new, his storage and guides.',
  caption: 'Signed in, the home page starts from your work: your projects, your batches running or failed, and your '
    + 'latest ones with their main metric.',
  actions: async ui => {
    await ui.page.getByRole('complementary', { name: 'News and help' }).waitFor();
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // from the navigation bar to the guides, on the right
  target: page => [page.locator('.bp6-navbar').first(), page.getByRole('complementary', { name: 'News and help' })],
  padding: 0,
});

// Explore (webapp/src/explore/ExplorePage.jsx), at /projects: the home page when signed out
shot('projects/explore', {
  project: null,
  login: 'ines',
  url: d => `${d.baseUrl}/projects`,
  alt: 'Explore: a filter box, then the kitefin group with its runs over 30 days, and its projects, each with its avatar, '
    + 'name, path, description, when it was last used, a sparkline of its runs, a star and a link to its source; the '
    + 'camera ISP pinned on top; "1 quiet subproject" below.',
  caption: 'Explore groups projects by their path. Pin the ones you follow: they stay on top. Projects that only the CI '
    + 'ran fade under "quiet".',
  actions: async ui => {
    // favorites belong to the user: in the API's answer only
    await withPreferences(ui, { favorites: { 'kitefin/camera-isp': true } });
    await ui.page.getByRole('button', { name: 'Unpin' }).first().waitFor();
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // from the navigation bar to the quiet projects
  target: page => [page.locator('.bp6-navbar').first(), page.getByText(/quiet (sub)?projects?$/).first()],
  padding: 16,
});

// The search that opens from any page (webapp/src/palette/CommandPalette.jsx): Ctrl+K, or "/"
const palette = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('combobox') });

shot('projects/command-palette', {
  project: 'detection-eval',
  // on the detector's page: the search also finds its branches
  url: d => d.url('detection-eval', 'commits'),
  alt: 'The search box open over the detector\'s page, with "det" typed: the project kitefin/detector, the branch '
    + 'det/confusions, and Arjun\'s recent batches tune-int8 and arjun-sizes with their runs and dates; the keys to '
    + 'navigate and open below.',
  caption: 'Press Ctrl K anywhere and type a few letters: projects, branches, your batches, pages and actions. Enter '
    + 'opens the result.',
  actions: async ui => {
    const { page } = ui;
    await ui.press('Control+k');
    const box = palette(page).getByRole('combobox');
    await box.waitFor();
    await ui.type(box, 'det', { delayMs: 80 });
    await palette(page).getByRole('listbox', { name: 'Results' }).getByText('det/confusions').waitFor();
    await ui.settle();
  },
  // the search, with a little of the page around it
  target: async page => {
    const box = await stableBox(palette(page));
    const margin = 32;
    return { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin };
  },
});
