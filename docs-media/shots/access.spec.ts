// A project's Access tab (docs-media/shots.yaml: access/*).
//
// The demo projects have no owners in the snapshot: before each shot, the admin (Adaeze) makes Arjun the owner of the
// detector and Mira a developer, and Mira asks to become an owner. Afterwards her request is denied and their roles
// removed. They're given at the time of the capture, by the server's clock: these shots run the page's clock at the
// same time, so that they were given "just now" (the other shots run at T0).
import { test } from '@playwright/test';
import { shot, type Ui } from './lib';
import { demo } from './lib/demo';
import {
  ADMIN, apiAs, deleteProjectServiceAccount, denyRequests, projectServiceAccount, removeMembers, requestAccess, setMembers,
  trustCiJobs,
} from './demoState';

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
  // at the server's time, the periods of newer release notes are over: they'd pop up
  storage: { 'qaboard.release-notes.last-seen': '9999-12-31' },
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

// The detector's CI bot, created by Arjun when the shot starts, trusting the GitHub Actions jobs of kitefin/detector on
// main. It's deleted afterwards (its name stays taken: the next capture enables it again).
const CI_BOT = { name: 'ci', description: 'GitHub Actions of kitefin/detector' };
let ciBot: Awaited<ReturnType<typeof projectServiceAccount>> | null = null;
test.afterAll(async () => {
  if (!ciBot) return;
  const admin = await apiAs(demo(), ADMIN);
  try {
    await deleteProjectServiceAccount(admin, ciBot);
    ciBot = null;
  } finally {
    await admin.dispose();
  }
});

shot('access/ci-trust', {
  project: 'detection-eval',
  login: 'arjun',
  url: d => `${d.baseUrl}/${DETECTOR}/access`,
  alt: 'The Tokens dialog of the service account kitefin/detector/ci[bot]: no tokens, and one trusted CI job, GitHub '
    + 'Actions jobs of kitefin/detector on refs/heads/main, never used yet, with the id-token: write permission to add '
    + 'to the workflow.',
  caption: 'The detector\'s CI bot trusts the GitHub Actions jobs of its repository on main: no token to store in the CI.',
  viewport: { width: 1440, height: 1000 },
  actions: async ui => {
    const arjun = await apiAs(ui.demo, 'arjun');
    try {
      ciBot = await projectServiceAccount(ui.demo, arjun, DETECTOR, CI_BOT.name, 'developer', CI_BOT.description);
      await trustCiJobs(arjun, ciBot, { provider: 'github', repository: DETECTOR, ref: 'main' });
    } finally {
      await arjun.dispose();
    }
    await ui.goto(ui.page.url());
    await ui.click(ui.page.getByRole('button', { name: `Tokens of ${DETECTOR}/${CI_BOT.name}[bot]` }));
    await ui.page.getByRole('table', { name: 'Trusted CI jobs' }).waitFor();
    await ui.cursor.moveTo({ x: 1420, y: 980 });
    await ui.settle();
  },
  // the dialog alone: the page's text behind the backdrop would be cut
  target: page => page.getByRole('dialog'),
  padding: 0,
});
