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
