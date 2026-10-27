// Loads the main pages against a mocked API, fails on any runtime error.
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const commit = {
  id: 'abc123', hexsha: 'abc123', project_id: project, branch: 'master',
  committer_name: 'Alice', message: 'Hello world',
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z',
  batches: {}, data: {}, parents: [],
};

// Longest matching prefix wins
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config: {} }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
  // the project's data, unwrapped
  '/api/v1/project': { qatools_config: {} },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commits': [commit],
  '/api/v1/commit-counts': { all: 1, mine: 1, without_ci: 0 },
  '/api/v1/batches': [],
  '/api/v1/commit': commit,
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
});

// Playwright needs a destructuring pattern for the fixtures, even when we use none
// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen, 'errors in the browser console').toEqual([]);
});

const pages = [
  { name: 'projects list', path: '/', text: 'projects' },
  { name: 'commits list', path: `/${project}/commits`, text: 'Hello world' },
  { name: 'commit results', path: `/${project}/commit/abc123`, text: 'Summary' },
  { name: 'history dashboard', path: `/${project}/history/master`, text: 'Performance over time' },
];

for (const { name, path, text } of pages) {
  test(name, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText('Alice').first()).toBeVisible();
    await expect(page.getByText(text).first()).toBeVisible();
    await expect(page.getByText('Sorry, something went wrong')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
  });
}

// Explore: groups, subprojects, quiet ones, and the sparklines, at phone width too
test('explore', async ({ page }) => {
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const used = { data: { qatools_config: { project: { name: 'x', description: 'A project with a rather long description that wraps on phones' } } }, latest_commit_datetime: recent, total_commits: 3, latest_human_activity: recent, views_90d: 1, my_last_view: null, activity: Array.from({ length: 30 }, (_, i) => i % 7) };
  const ci_only = { ...used, latest_human_activity: null, views_90d: 0, activity: null };
  const projects = { 'kitefin/k3': used, 'kitefin/k3/denoise': used, 'kitefin/k3/ci-a': ci_only, 'kitefin/k5': used, 'old/one': ci_only, 'old/two': ci_only };
  await page.route('**/api/v1/projects**', route => route.fulfill({ json: projects }));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'k5' })).toBeVisible();
    await page.getByRole('button', { name: '2 subprojects' }).click();
    await expect(page.getByRole('heading', { name: 'denoise' })).toBeVisible();
    await expect(page.getByText('2 quiet projects')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `width ${width}`).toBeLessThanOrEqual(0);
    await page.evaluate(() => localStorage.clear());
  }
  await page.waitForLoadState('networkidle');
});

// Home, for signed-in users: their batches and projects, in three columns, two, or one at phone width
test('home', async ({ page }) => {
  const recent = new Date(Date.now() - 3600 * 1000).toISOString();
  const batch = (id, label, extra) => ({ id, label, project, origin: 'webapp', user_name: 'alice', latest_output_datetime: recent, created_date: recent, data: {}, valid_outputs: 3, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, aggregated_metrics: {}, commit: { id: 'abc123', branch: 'master', message: 'Hello world' }, ...extra });
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '2099-12'));
  await page.route('**/api/v1/batches**', route => {
    const status = new URL(route.request().url()).searchParams.get('status');
    const batches = { pending: [batch(1, 'sweep', { pending_outputs: 5, running_outputs: 2 })], failed: [batch(2, 'tries', { failed_outputs: 2 })] }[status] ?? [batch(3, 'denoise')];
    return route.fulfill({ json: batches, headers: { 'X-Has-More': 'false' } });
  });
  await page.route('**/api/v1/projects**', route => route.fulfill({ json: { [project]: { data: { qatools_config: { project: { name: 'x' } } }, latest_commit_datetime: recent, total_commits: 3, my_latest_activity: recent, activity: Array.from({ length: 30 }, (_, i) => i % 5) } } }));
  for (const width of [1300, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Running now' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'denoise' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Your projects' }).getByRole('link', { name: project })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `width ${width}`).toBeLessThanOrEqual(0);
  }
  await page.waitForLoadState('networkidle');
});

// The command palette: from any page with the keyboard, to a project, then to one of its branches
test('command palette', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '2099-12'));
  await page.goto('/projects');
  await expect(page.getByPlaceholder('Filter projects...')).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search QA-Board' });
  await expect(dialog.getByRole('combobox')).toBeFocused();
  await page.keyboard.type('repo');
  await expect(dialog.getByRole('option').first()).toContainText(project);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/${project}$`));
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await expect(dialog).toBeHidden();
  // "/" opens it too, and in a project it finds branches
  await page.keyboard.press('/');
  await page.keyboard.type('mast');
  await expect(dialog.getByRole('group', { name: /Branches/ }).getByRole('option', { name: /master/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/${project}/commits/master$`));
  await page.waitForLoadState('networkidle');
});

// Signed-out visitors get Explore
test('explore at / when signed out', async ({ page }) => {
  await page.route('**/api/v1/user/me/', route => route.fulfill({ json: { is_authenticated: false } }));
  await page.goto('/');
  await expect(page.getByPlaceholder('Filter projects...')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Running now' })).toHaveCount(0);
  await page.waitForLoadState('networkidle');
});

// nginx serves files.html for folders under /s/, `vite preview` too (see vite.config.js)
test('file browser', async ({ page }) => {
  await page.route('**/s/**', route => {
    if (route.request().headers().accept !== 'application/json') return route.fallback();
    return route.fulfill({ json: { path: '/mnt/qaboard', truncated: false, entries: [
      { name: 'outputs', type: 'directory', mtime: 1790000000, owner: 'alice', mode: 'drwxr-xr-x' },
      { name: 'log.txt', type: 'file', size: 1234, mtime: 1790000000, owner: 'alice', mode: '-rw-r--r--' },
    ] } });
  });
  await page.goto('/s/mnt/qaboard/');
  await expect(page.getByText('Alice').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'log.txt', exact: true })).toHaveAttribute('href', '/s/mnt/qaboard/log.txt');
  await page.getByRole('link', { name: 'outputs/', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/mnt\/qaboard\/outputs\/$/);
  await page.waitForLoadState('networkidle');
});

// The commit lists' date ranges are persisted (as JSON) in the browser's storage
test('switch to a branch seen in a previous session', async ({ page }) => {
  await page.goto(`/${project}/commits/master`);
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await page.goto(`/${project}/commits/develop`);
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await page.waitForTimeout(1500); // redux-persist writes are throttled
  await page.reload();
  await expect(page.getByText('Hello world').first()).toBeVisible();
  // the commit's branch tag
  await page.getByRole('link', { name: 'master', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${project}/commits/master`));
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await expect(page.getByText('Sorry, something went wrong')).toHaveCount(0);
});

// The History page has the project's navigation too, and the sidebar navigates without reloading the app
test('history page navigation', async ({ page }) => {
  // the "What's new" dialog would cover the sidebar
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.goto(`/${project}/commits/master`);
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await page.evaluate(() => { window.not_reloaded = true; });
  await page.getByRole('menuitem', { name: 'History', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${project}/history/master`));
  await expect(page.getByText('Performance over time')).toBeVisible();
  // a link to the git host, with a submenu of other links
  await expect(page.getByRole('menuitem', { name: 'Code' }).locator('a').first()).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('menuitem', { name: 'Milestones' })).toBeVisible();
  // back to the branch's commits
  await page.getByRole('menuitem', { name: 'master', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${project}/commits/master`));
  await expect(page.getByText('Hello world').first()).toBeVisible();
  expect(await page.evaluate(() => window.not_reloaded)).toBe(true);
  await page.waitForLoadState('networkidle');
});

// The sidebar's submenus open next to it, in view: not off-screen on its left, nor cut off by it
test('sidebar submenus open in view', async ({ page }) => {
  // the "What's new" dialog would cover the page
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  // a small laptop's window: the sidebar scrolls
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto(`/${project}/commit/abc123`);
  const nav = page.getByRole('navigation', { name: 'Navigation' });
  const viewport = page.viewportSize();
  const expect_submenu_in_view = async (item, link_name) => {
    await item.hover();
    const submenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: link_name }) });
    await expect(submenu).toBeVisible();
    const item_box = await item.boundingBox();
    const box = await submenu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(item_box.x + item_box.width - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // toBeVisible ignores what the sidebar clips: each link must be what's under the mouse
    for (const link of await submenu.getByRole('menuitem').all()) {
      await expect(link).toBeVisible();
      const hit = await link.evaluate(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      });
      expect(hit, `"${await link.textContent()}" can be seen and clicked`).toBe(true);
    }
    // and closes soon once the mouse leaves
    await page.mouse.move(viewport.width - 10, viewport.height / 2);
    await expect(submenu).toBeHidden({ timeout: 1000 });
  };
  // links to the commit on the git host
  await expect_submenu_in_view(nav.getByRole('menuitem', { name: 'Code' }), 'Repository');
  await expect_submenu_in_view(nav.getByRole('menuitem', { name: 'Integrations' }), /learn how to link/);
  // collapsed to icons, the items keep their names
  await nav.getByRole('menuitem', { name: 'Collapse the sidebar' }).click();
  await expect(nav.getByRole('menuitem', { name: 'Expand the sidebar' })).toBeVisible();
  for (const name of ['Summary', 'Visualizations', 'Artifacts & Configs', 'Integrations', 'Tuning Analysis'])
    await expect(nav.getByRole('menuitem', { name, exact: true })).toBeVisible();
  expect(await nav.ariaSnapshot()).not.toMatch(/- menuitem:?\s*$/m);
  await expect_submenu_in_view(nav.getByRole('menuitem', { name: 'Code', exact: true }), 'Repository');
  await page.waitForLoadState('networkidle');
});

// Committers' avatars often can't be found or loaded
test('avatars that fail to load show initials', async ({ page }) => {
  await page.route('**/api/v1/commits**', route => route.fulfill({ json: [{ ...commit, committer_avatar_url: 'https://gitlab.example.com/alice.png' }] }));
  await page.goto(`/${project}/commits`);
  const avatar = page.getByRole('link', { name: 'Alice', exact: true }).getByRole('img');
  await expect(avatar).toHaveAttribute('src', /^data:image\/svg\+xml,/);
  await expect(avatar).toHaveAttribute('title', 'Alice');
  await page.waitForLoadState('networkidle');
});

// Users can list commits one line each: the choice is remembered
test('compact commit list', async ({ page }) => {
  await page.goto(`/${project}/commits`);
  const row = page.getByRole('listitem').filter({ hasText: 'Hello world' });
  await expect(row).toBeVisible();
  const comfortable_height = (await row.boundingBox()).height;
  await page.getByRole('radio', { name: 'Compact' }).click();
  await expect(page.getByRole('radio', { name: 'Compact' })).toHaveAttribute('aria-checked', 'true');
  await expect(row.getByRole('link', { name: 'Alice', exact: true })).toHaveAttribute('href', `/${project}/committer/Alice`);
  // one line, the whole message on hover
  expect((await row.boundingBox()).height).toBeLessThan(Math.min(comfortable_height, 45));
  await expect(row.getByText('Hello world')).toHaveAttribute('title', 'Hello world');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Compact' })).toHaveAttribute('aria-checked', 'true');
  await expect(row).toBeVisible();
  // the commit's branch, from its row
  await row.getByRole('link', { name: 'master' }).click();
  await expect(page).toHaveURL(new RegExp(`/${project}/commits/master`));
  await expect(page.getByText('Hello world').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
});

// The app's own pages, not projects: settings, admin, approving a CLI sign-in
const token = {
  id: 1, name: 'ci-bot', kind: 'personal', prefix: 'qab_pat_Xk3f', scopes: ['read', 'ingest'], projects: [],
  created_at: '2026-09-01T10:00:00Z', expires_at: '2036-09-01T10:00:00Z', last_used_at: null, status: 'active', data: {},
};
const user_management_api = {
  '/api/v1/user/me/': { ...api['/api/v1/user/me/'], is_admin: true, status: 'active' },
  '/api/v1/user/tokens': { tokens: [token] },
  '/api/v1/user/audit': { events: [], next_before_id: null },
  '/api/v1/user/preferences': { preferences: {}, updated_at: null },
  '/api/v1/admin/overview': { counts: { users: 3, active_30d: 2, admins: 1, pending: 0, disabled: 0, active_tokens: 1 }, checklist: [
    { id: 'ingest_auth', ok: false, severity: 'warning', title: 'Anyone can save runs', detail: 'Move ingest.auth to "warn", then "token".' },
  ] },
  '/api/v1/admin/users': { users: [{ id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', status: 'active', is_admin: true, login_type: 'LOCAL', active_tokens: 1 }], total: 1 },
  '/api/v1/auth/device': { client_name: 'qa CLI on host-12', hostname: 'host-12', scopes: ['read', 'ingest', 'act'], status: 'pending' },
  '/api/v1/project/access': {
    project, my_role: 'owner', via: 'grant', can_manage: true,
    visibility: { own: null, effective: 'internal', inherited_from: 'group', default: 'public' },
    owners: [{ type: 'user', id: 1, name: 'alice' }],
    grants: [
      { id: 1, subject: { type: 'user', id: 1, name: 'alice', full_name: 'Alice' }, role: 'owner', resource_id: project, inherited: false, source: 'manual', expires_at: null, granted_by: null, granted_at: '2026-09-01T10:00:00Z' },
      { id: 2, subject: { type: 'group', id: 7, name: 'camera-team' }, role: 'developer', resource_id: 'group', inherited: true, source: 'manual', expires_at: '2027-01-31T23:59:59Z', granted_by: { user_name: 'root' }, granted_at: '2026-09-01T10:00:00Z' },
    ],
    requests: [{ id: 3, user: { id: 2, user_name: 'bob', full_name: 'Bob' }, role: 'developer', message: 'I run the benchmarks.', status: 'pending', created_at: '2026-09-01T10:00:00Z' }],
  },
  '/api/v1/directory': { users: [{ id: 2, user_name: 'bob', full_name: 'Bob' }], groups: [{ id: 7, name: 'camera-team' }] },
  '/api/v1/admin/groups': { groups: [{ id: 7, name: 'camera-team', description: 'Camera algorithms', member_count: 4, rule_count: 1 }] },
  '/api/v1/admin/grants': { grants: [{ id: 4, subject: { type: 'group', id: 8, name: 'qa' }, role: 'viewer', granted_at: '2026-09-01T10:00:00Z' }] },
};

test.describe('user management pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
    await page.route('**/api/**', route => {
      const { pathname } = new URL(route.request().url());
      const all = { ...api, ...user_management_api };
      const key = Object.keys(all).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
      return route.fulfill({ json: key ? all[key] : {} });
    });
  });

  test('settings: access tokens', async ({ page }) => {
    await page.goto('/settings/tokens');
    await expect(page.getByRole('tab', { name: 'Access tokens' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('ci-bot')).toBeVisible();
    await page.getByRole('button', { name: 'New token' }).click();
    await expect(page.getByRole('dialog').getByText('What it can do')).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('admin: users', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText('Anyone can save runs')).toBeVisible();
    await page.getByRole('tab', { name: 'Users' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('link', { name: 'Alice' })).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('project access', async ({ page }) => {
    await page.goto(`/${project}/access`);
    await expect(page.getByRole('table', { name: 'Members' }).getByText('camera-team')).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('menuitem', { name: 'Access' })).toHaveClass(/active/);
    await expect(page.getByText('I run the benchmarks.')).toBeVisible();
    await page.getByRole('button', { name: 'Add member' }).click();
    await page.getByRole('dialog').getByLabel('User or group').fill('bo');
    await expect(page.getByRole('option', { name: /Bob/ })).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('admin: groups and roles on all projects', async ({ page }) => {
    await page.goto('/admin/groups');
    await expect(page.getByRole('link', { name: 'camera-team' })).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByRole('table', { name: 'Roles on all projects' }).getByText('qa')).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('narrow screens: no sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/settings/tokens', '/admin/users', '/admin/groups', '/admin', '/', `/${project}/access`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test('device sign-in approval', async ({ page }) => {
    await page.goto('/device?code=WDJB-MJHT');
    await expect(page.getByText('Authorize qa CLI on host-12?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('signed out: pages that need a user go to the sign-in page, single sign-on first', async ({ page }) => {
    await page.route('**/api/v1/user/me/', route => route.fulfill({ json: { is_authenticated: false } }));
    await page.route('**/api/v1/auth/providers**', route => route.fulfill({ json: {
      providers: [
        { id: 'sso', type: 'oidc', kind: 'redirect', name: 'Company SSO', recommended: true, start_url: '/api/v1/auth/oidc/sso/start?next=%2Fsettings' },
        { id: 'local', type: 'local', kind: 'password', name: 'QA-Board account', recommended: false, start_url: null },
      ],
      password_form: true, local_signup: false, auto_redirect: false,
    } }));
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await expect(page.getByRole('button', { name: 'Company SSO' })).toHaveAttribute('href', '/api/v1/auth/oidc/sso/start?next=%2Fsettings');
    const form = page.getByRole('form', { name: 'Sign in with a user name and password' });
    await expect(form.getByRole('textbox', { name: 'User name' })).toBeVisible();
    await expect(form.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
