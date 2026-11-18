// The admin panel (docs-media/shots.yaml: admin/*), as Adaeze, the demo stack's admin (QABOARD_ADMINS in
// docs-media/compose.demo.yml). The first shots change nothing; those below set state up through the API, and undo it.
//
// What the panel dates (users' sign-ins, jobs, schedules' next runs) happened at the time of the capture, by the
// server's clock, days or weeks after T0, where the page's clock is: the shots leave those columns out.
import { test } from '@playwright/test';
import { shot, type Locator, type Page } from './lib';
import { demo } from './lib/demo';
import {
  ADMIN, apiAs, setSignInProvider, deleteSignInProvider, setGroups, deleteGroups, setServiceAccount, deleteServiceAccount,
  type DemoGroup,
} from './demoState';

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
  alt: 'Admin → Settings: a search box and filters (All, Changed, From the environment, Secrets), the groups of '
    + 'settings (Sign-in, Projects and access, Git hosts...), and the Sign-in settings, each with its description, '
    + 'its variable, where its value comes from and a switch, choices or a text field.',
  caption: 'Change settings without restarting the server. Click a badge to see where a value comes from: those set in the server\'s environment can only be changed there.',
  actions: async ui => {
    await ui.page.getByTestId('setting-ingest.auth').waitFor();
    await ui.cursor.moveTo(away);
    await ui.settle();
  },
  target: page => between(
    page.getByRole('region', { name: 'Settings' }).locator('p').first(),
    page.getByTestId('setting-auth.allowed_email_domains'),
    page.getByRole('region', { name: 'Settings' }),
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
  // the active users only: the service accounts other shots create stay, disabled, when they delete them
  // (access/ci-trust, admin/service-accounts)
  url: d => `${d.baseUrl}/admin/users?status=active`,
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


// ---- Sign-in, groups, service accounts and schedules: the snapshot has none. Each block saves them as the admin
// before its shots and removes them afterwards (the stack is shared: the provider also shows on the sign-in page meanwhile).

const KEYCLOAK = {
  id: 'keycloak',
  name: 'Kitefin SSO',
  issuer: 'https://sso.kitefin.example/realms/kitefin',
  client_id: 'qaboard',
  // a demo value, stored encrypted with the stack's key
  client_secret: 'kitefin-demo-client-secret',
  scopes: ['openid', 'profile', 'email', 'groups'],
  match_users: 'email',
  enabled: true,
  recommended: true,
};

async function asAdmin(change: (admin: Awaited<ReturnType<typeof apiAs>>) => Promise<void>) {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await change(admin);
  } finally {
    await admin.dispose();
  }
}

shot('admin/oidc-provider', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/sign-in`,
  alt: 'The Add an OIDC provider dialog filled in: Kitefin SSO, id keycloak, issuer https://sso.kitefin.example/realms/'
    + 'kitefin, client qaboard, its secret stored encrypted, scopes openid profile email groups, accounts matched by '
    + 'verified email, Recommended on.',
  caption: 'Add a provider from the admin panel: its secret is stored encrypted, or read from an environment variable of the server.',
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    const { page } = ui;
    await ui.click(page.getByRole('button', { name: 'Add OIDC provider' }));
    const dialog = page.getByRole('dialog', { name: 'Add an OIDC provider' });
    await ui.type(dialog.getByRole('textbox', { name: 'Name', exact: true }), KEYCLOAK.name);
    await ui.type(dialog.getByRole('textbox', { name: 'ID', exact: true }), KEYCLOAK.id);
    await ui.type(dialog.getByRole('textbox', { name: 'Issuer', exact: true }), KEYCLOAK.issuer);
    await ui.type(dialog.getByRole('textbox', { name: 'Client ID', exact: true }), KEYCLOAK.client_id);
    await ui.type(dialog.locator('#provider-client_secret'), KEYCLOAK.client_secret);
    await dialog.getByRole('textbox', { name: 'Scopes', exact: true }).fill('');
    await ui.type(dialog.getByRole('textbox', { name: 'Scopes', exact: true }), KEYCLOAK.scopes.join(' '));
    await ui.click(dialog.locator('label').filter({ hasText: /^By verified email/ }));
    await ui.click(dialog.locator('label').filter({ hasText: 'Recommended: the first, main button' }));
    // no focus ring on the switch
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1420, y: 1280 });
    await ui.settle();
  },
  target: page => page.getByRole('dialog', { name: 'Add an OIDC provider' }),
  padding: 0,
});

test.describe('a single sign-on provider', () => {
  test.beforeEach(() => asAdmin(admin => setSignInProvider(admin, KEYCLOAK).then(() => undefined)));
  test.afterEach(() => asAdmin(admin => deleteSignInProvider(admin, KEYCLOAK.id)));

  shot('admin/sign-in-methods', {
    project: null,
    login: ADMIN,
    url: d => `${d.baseUrl}/admin/sign-in`,
    alt: 'Admin → Sign-in: Kitefin SSO (OIDC, Enabled, Recommended, database) with its issuer, client id, secret stored '
      + 'encrypted, scopes, accounts matched by verified email and its redirect URI; below it the QA-Board account, '
      + 'from the environment.',
    caption: 'Each provider shows the redirect URI to register with it. Move methods up or down: the sign-in page lists them in this order.',
    viewport: { width: 1100, height: 900 },
    actions: async ui => {
      await ui.page.getByTestId('provider-keycloak').waitFor();
      await ui.cursor.moveTo(away);
      await ui.settle();
    },
    target: page => [page.getByTestId('provider-keycloak'), page.getByTestId('provider-local')],
  });
});

// Teams of the demo world (examples/README.md), with rules on the claims of Kitefin SSO and of a directory
const GROUPS: DemoGroup[] = [
  {
    name: 'imaging', description: 'Camera ISP: image quality and the fixed-point model', members: ['ines', 'tobias'],
    rules: [
      { provider_id: KEYCLOAK.id, claim: 'groups', values: ['imaging', 'camera-isp'] },
      { provider_id: null, claim: 'memberOf', values: ['CN=imaging,OU=Groups,DC=kitefin,DC=example'] },
    ],
  },
  {
    name: 'perception', description: 'Detection, odometry and mapping', members: ['arjun', 'mira'],
    rules: [{ provider_id: KEYCLOAK.id, claim: 'groups', values: ['perception'] }],
  },
  {
    name: 'fleet-platform', description: 'Inference gateway and fleet SDK', members: ['adaeze', 'kaito', 'agent'],
    rules: [],
  },
];

test.describe('groups', () => {
  test.beforeEach(() => asAdmin(async admin => {
    await setSignInProvider(admin, KEYCLOAK);
    await setGroups(admin, GROUPS);
  }));
  test.afterEach(() => asAdmin(async admin => {
    await deleteGroups(admin, GROUPS.map(group => group.name));
    await deleteSignInProvider(admin, KEYCLOAK.id);
  }));

  shot('admin/groups', {
    project: null,
    login: ADMIN,
    url: d => `${d.baseUrl}/admin/groups`,
    alt: 'Admin → Groups: fleet-platform (Inference gateway and fleet SDK, 3 members), imaging (Camera ISP, 2 members, '
      + '2 rules) and perception (Detection, odometry and mapping, 2 members, 1 rule).',
    caption: 'One group per team: project owners give it a role on their projects, and its members follow.',
    viewport: { width: 1100, height: 900 },
    actions: async ui => {
      await ui.page.getByRole('table', { name: 'Groups' }).getByRole('link', { name: 'perception' }).waitFor();
      await ui.cursor.moveTo(away);
      await ui.settle();
    },
    target: page => page.getByRole('table', { name: 'Groups' }),
  });

  shot('admin/group-rules', {
    project: null,
    login: ADMIN,
    url: d => `${d.baseUrl}/admin/groups`,
    alt: 'The rules of the imaging group: users who sign in with Kitefin SSO with imaging or camera-isp in their groups '
      + 'claim, and users of any sign-in method whose memberOf has CN=imaging,OU=Groups,DC=kitefin,DC=example; then '
      + 'the form to add a rule.',
    caption: 'Rules add users from the groups their sign-in gives, and remove them when they leave those groups.',
    viewport: { width: 1100, height: 900 },
    actions: async ui => {
      await ui.click(ui.page.getByRole('table', { name: 'Groups' }).getByRole('link', { name: 'imaging' }));
      await ui.page.getByRole('table', { name: 'Rules' }).getByText('Kitefin SSO').waitFor();
      await ui.cursor.moveTo(away);
      await ui.settle();
    },
    target: page => page.getByRole('region', { name: 'Rules' }),
  });
});

const NIGHTLY = {
  name: 'nightly',
  description: 'Nightly benchmarks of the Kitefin projects, from GitLab CI',
  role: 'developer',
  ci_trust: [],
};

// The service accounts' table without its dates (when they were created)
async function serviceAccountsWithoutDates(page: Page) {
  const section = await page.getByRole('region', { name: 'Service accounts' }).boundingBox();
  const table = await page.getByRole('table', { name: 'Service accounts' }).boundingBox();
  const dates = await page.getByRole('columnheader', { name: 'Created' }).boundingBox();
  if (!section || !table || !dates) throw new Error('[admin.spec] the service accounts\' table has no box');
  const padding = 16;
  return { x: section.x - padding, y: section.y - padding, width: dates.x - section.x + padding, height: table.y + table.height - section.y + 2 * padding };
}

test.describe('a service account', () => {
  test.beforeEach(() => asAdmin(admin => setServiceAccount(admin, NIGHTLY).then(() => undefined)));
  test.afterEach(() => asAdmin(admin => deleteServiceAccount(admin, NIGHTLY.name)));

  shot('admin/service-accounts', {
    project: null,
    login: ADMIN,
    url: d => `${d.baseUrl}/admin/service-accounts`,
    alt: 'Admin → Service accounts: nightly[bot], "Nightly benchmarks of the Kitefin projects, from GitLab CI", '
      + 'Developer on all projects, no active tokens, never used.',
    caption: 'A bot for the CI: its role on all projects here, or none and project owners add it to theirs.',
    actions: async ui => {
      await ui.page.getByRole('table', { name: 'Service accounts' }).getByText('nightly[bot]').waitFor();
      await ui.cursor.moveTo(away);
      await ui.settle();
    },
    target: serviceAccountsWithoutDates,
  });
});

// The next runs of a weekly cron (minute, hour, day of the week, in UTC) after `t0`
function nextWeekly(t0: Date, minute: number, hour: number, weekday: number, count = 3): string[] {
  const runs: string[] = [];
  const day = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate(), hour, minute));
  while (runs.length < count) {
    if (day.getUTCDay() === weekday && day > t0) runs.push(day.toISOString());
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return runs;
}

shot('admin/scheduled-job', {
  project: null,
  login: ADMIN,
  url: d => `${d.baseUrl}/admin/storage`,
  alt: 'The New schedule dialog: Old results, Delete old results, cron 59 1 * * 6 in UTC (next on Saturdays at 1:59), '
    + 'every project, by default older than 1month, deleting the runs\' files, not a dry run, enabled.',
  caption: 'Schedule a job with a cron expression: the form shows when it runs next.',
  viewport: { width: 1440, height: 1100 },
  actions: async ui => {
    const { page } = ui;
    // The server says when the cron runs next from its clock, the page's is at T0: answer as the server would at T0
    await page.route(/\/api\/v1\/admin\/job-schedules\/next-runs/, route => route.fulfill({
      json: { next_runs: nextWeekly(ui.demo.t0, 59, 1, 6) },
    }));
    await ui.click(page.getByRole('button', { name: 'New schedule' }));
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await ui.type(dialog.getByRole('textbox', { name: 'Name', exact: true }), 'Old results');
    await dialog.getByLabel('Job', { exact: true }).selectOption('garbage_collect');
    await dialog.getByLabel('When (cron)', { exact: true }).fill('');
    await ui.type(dialog.getByLabel('When (cron)', { exact: true }), '59 1 * * 6');
    await dialog.getByText(/^Next: /).waitFor();
    await dialog.getByText(/^\d+ projects?$/).waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1420, y: 1080 });
    await ui.settle();
  },
  target: page => page.getByRole('dialog', { name: 'New schedule' }),
  padding: 0,
});
