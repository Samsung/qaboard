// The admin panel (docs-media/shots.yaml: admin/*), as Adaeze, the demo stack's admin (QABOARD_ADMINS in
// docs-media/compose.demo.yml). Nothing is changed.
//
// What the panel dates (users' sign-ins, jobs, schedules' next runs) happened at the time of the capture, by the
// server's clock, days or weeks after T0, where the page's clock is: the shots leave those columns out.
import { shot, type Locator, type Page } from './lib';
import { demo } from './lib/demo';
import { ADMIN, apiAs } from './demoState';

const away = { x: 1420, y: 880 };

// From the top of `top` to the bottom of `bottom`, as wide as `width`: a table's rows are too close for a padding
async function between(top: Locator, bottom: Locator, width: Locator, padding = 16) {
  const [a, b, w] = [await top.boundingBox(), await bottom.boundingBox(), await width.boundingBox()];
  if (!a || !b || !w) throw new Error('[admin.spec] an element of the shot has no box');
  return { x: w.x - padding, y: a.y - padding, width: w.width + 2 * padding, height: b.y + b.height - a.y + padding + 2 };
}

shot('admin/overview', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin`,
  alt: 'The admin panel\'s security checklist: 5 to review. Anonymous users can read every project, anyone who can '
    + 'reach the server can send results, cookies can be sent over plain HTTP; then notes on the secret key and on '
    + 'project roles, and what\'s already fine.',
  caption: 'The checklist says what to look at next, and which setting changes it.',
  actions: async ui => {
    await ui.page.getByRole('region', { name: 'Security checklist' }).waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  // its title (the heading is as wide as the page: its tag) and its list, narrower than the section
  target: page => [
    page.getByRole('region', { name: 'Security checklist' }).getByRole('heading').locator('.bp6-tag'),
    page.getByRole('region', { name: 'Security checklist' }).getByRole('list'),
  ],
});

shot('admin/settings', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/settings`,
  alt: 'Admin → Settings: requiring sign-in and local sign-up are switches, ingest.auth is "off", set by '
    + 'QABOARD_INGEST_AUTH in the environment, and the projects\' default visibility and role of signed-in users are '
    + 'menus, each with its description.',
  caption: 'Change settings without restarting the server: those set in its environment can only be changed there.',
  actions: async ui => {
    await ui.page.getByTestId('setting-ingest.auth').waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  target: page => between(
    page.getByRole('region', { name: 'Settings' }).locator('p').first(),
    page.getByTestId('setting-projects.signed_in_role'),
    page.getByRole('table', { name: 'Settings' }),
  ),
});

// The users' table without its dates (when they last signed in, when they were created)
async function usersWithoutDates(page: Page) {
  const section = await page.getByRole('region', { name: 'Users' }).boundingBox();
  const table = await page.getByRole('table', { name: 'Users' }).boundingBox();
  const dates = await page.getByRole('columnheader', { name: 'Last sign-in' }).boundingBox();
  if (!section || !table || !dates) throw new Error('[admin.spec] the users\' table has no box');
  const padding = 16;
  return { x: section.x - padding, y: section.y - padding, width: dates.x - section.x + padding, height: table.y + table.height - section.y + 2 * padding };
}

shot('admin/users', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/users`,
  alt: 'Admin → Users: the seven people of the demo, from Adaeze to the Kitefin Coding Agent, their email and how '
    + 'they sign in (user name and password), Adaeze tagged Admin (env), and how many active tokens each has.',
  caption: 'Every user, how they sign in and their tokens: click one to disable them, make them an admin, or revoke their tokens.',
  actions: async ui => {
    // users are listed by when they last signed in, which depends on the shots taken before: sign them in in this order
    for (const user of ['agent', 'mira', 'kaito', 'tobias', 'ines', 'arjun', ADMIN])
      await (await apiAs(demo(), user)).dispose();
    await ui.goto(ui.page.url());
    await ui.page.getByRole('table', { name: 'Users' }).locator('tbody > tr').nth(6).waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  target: usersWithoutDates,
});

shot('admin/storage', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/storage`,
  alt: 'Admin → Storage: cards to start each job (hard-delete deleted runs, purge runs whose files are gone, delete '
    + 'artifacts, delete old results, scan the storage, measure what deleted runs left, fail stuck runs), each saying '
    + 'what it does and keeps.',
  caption: 'Clean the storage from the admin panel: start a job, or schedule it.',
  actions: async ui => {
    await ui.page.getByRole('region', { name: 'Clean the storage' }).waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  target: page => page.getByRole('region', { name: 'Clean the storage' }),
});

shot('admin/hard-delete', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/storage`,
  alt: 'The Hard-delete deleted runs dialog: projects matching *, none excepted (6 projects), the runs deleted by '
    + 'users, created over a month ago, a button to count them, and Dry run on: Start the dry run.',
  caption: 'Choose the projects and the runs, count them, then start a dry run: it says what it would delete.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Start: Hard-delete deleted runs' }));
    await ui.page.getByRole('dialog', { name: 'Hard-delete deleted runs' }).getByText(/^\d+ projects?$/).waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  // the dialog alone: the page's text behind the backdrop would be cut
  target: page => page.getByRole('dialog', { name: 'Hard-delete deleted runs' }),
  padding: 0,
});
