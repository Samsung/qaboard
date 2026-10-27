// A project's Access tab (docs-media/shots.yaml: access/*).
//
// The demo projects have no owners in the snapshot: before each shot, the admin (Adaeze) makes Arjun the owner of the
// detector and Mira a developer, and Mira asks to become an owner. Afterwards her request is denied and their roles
// removed. They're given at the time of the capture, by the server's clock: these shots run the page's clock at the
// same time, so that they were given "just now" (the other shots run at T0).
import { test } from '@playwright/test';
import { shot, type Ui } from './lib';
import { demo } from './lib/demo';
import { ADMIN, apiAs, denyRequests, removeMembers, requestAccess, setMembers } from './demoState';

const DETECTOR = 'kitefin/detector';
const MEMBERS = { arjun: 'owner', mira: 'developer' } as const;
const REQUEST = 'Arjun is away in November: I\'ll review the detector\'s changes and its access requests meanwhile.';

test.beforeEach(async () => {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await setMembers(admin, DETECTOR, MEMBERS);
    await denyRequests(admin, DETECTOR, ['mira', 'kaito']);
  } finally {
    await admin.dispose();
  }
  await requestAccess(demo(), 'mira', DETECTOR, 'owner', REQUEST);
});

test.afterAll(async () => {
  const admin = await apiAs(demo(), ADMIN);
  try {
    await denyRequests(admin, DETECTOR, ['mira', 'kaito']);
    await removeMembers(admin, DETECTOR, Object.keys(MEMBERS));
  } finally {
    await admin.dispose();
  }
});

// The page's clock at the server's: what was just given shows as given "just now"
async function serverTime(ui: Ui) {
  await ui.page.clock.setSystemTime(new Date());
  await ui.goto(ui.page.url());
}

shot('access/members', {
  project: 'detection-eval',
  login: 'arjun',
  url: d => `${d.baseUrl}/${DETECTOR}/access`,
  alt: 'The Access tab of kitefin/detector, as its owner: the visibility (Public, the server\'s default), Mira\'s '
    + 'request for the owner role with her message and Approve and Deny buttons, and the members: Arjun, owner, and '
    + 'Mira, developer.',
  caption: 'Owners choose who sees the project, add members, and decide access requests.',
  viewport: { width: 1440, height: 1100 },
  actions: async ui => {
    await serverTime(ui);
    await ui.page.getByRole('table', { name: 'Members' }).waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 1080 });
    await ui.settle();
  },
  target: page => [page.getByRole('heading', { name: 'Access', exact: true }), page.getByRole('table', { name: 'Members' })],
  // not the top bar's border, 16 px above the title
  padding: 12,
});

shot('access/request', {
  project: 'detection-eval',
  login: 'kaito',
  url: d => `${d.baseUrl}/${DETECTOR}/access`,
  alt: 'The Access tab of kitefin/detector, as someone who isn\'t a member: their role (Developer, like everyone signed '
    + 'in), the visibility, the owner (Arjun), and the Request access form with the Owner role and a message.',
  caption: 'Ask the owners for the role you need, and say why.',
  actions: async ui => {
    const form = ui.page.getByRole('form', { name: 'Request access' });
    await ui.type(form.getByLabel(/Why you need it/), 'I ship the int8 detector in the inference gateway, and approve its changes with Arjun.');
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.settle();
  },
  target: page => [page.getByRole('heading', { name: 'Access', exact: true }), page.getByRole('region', { name: 'Request access' })],
  padding: 12,
});
