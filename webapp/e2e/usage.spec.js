// Admin → Usage: the charts' hover labels, with the mouse and the keyboard, against a mocked API.
// SCREENSHOTS_DIR=/some/folder saves how it looks, in light and dark, and on a phone.
import { test, expect } from '@playwright/test';

const admin = { is_authenticated: true, user_id: 1, user_name: 'root', full_name: 'Root', email: 'root@example.com', login_type: 'local', is_admin: true };

// Weekdays are busier, and it grows a little
const timeseries = url => {
  const params = new URL(url).searchParams;
  const week = params.get('bucket') === 'week';
  const until = new Date(`${params.get('until')}T00:00:00Z`);
  let start = new Date(`${params.get('since')}T00:00:00Z`);
  if (week) start = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86400e3);
  const buckets = [];
  for (let i = 0; start <= until; i++, start = new Date(start.getTime() + (week ? 7 : 1) * 86400e3)) {
    const weekend = !week && [0, 6].includes(start.getUTCDay());
    const n = (base, spread) => Math.round((week ? 3 : 1) * (weekend ? base / 5 : base + spread * Math.sin(i / 2) + i / 4));
    buckets.push({
      start: start.toISOString().slice(0, 10),
      web_users: n(18, 4), cli_users: n(6, 2), commits_viewed: n(45, 12), outputs_opened: n(120, 30),
      batches_started: n(4, 3), cli_commands: n(30, 10),
    });
  }
  return { buckets };
};

const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': admin,
  '/api/v1/admin/usage/summary': {
    counts: { users: 42, web_users: 40, cli_users: 12, new_users: 3, commits_viewed: 1318, comparisons: 77, outputs_opened: 3204, image_viewer_uses: 96, batches_started: 125, batches_started_by_kind: { tuning: 60, run_tests: 40, cli: 25 }, cli_commands: 940, exports: 4, milestones: 6, ci_runs: 9000 },
    previous_counts: { users: 38, web_users: 36, cli_users: 9, new_users: 1, commits_viewed: 1290, comparisons: 60, outputs_opened: 3000, image_viewer_uses: 80, batches_started: 120, cli_commands: 820, exports: 2, milestones: 4, ci_runs: 8000 },
  },
  '/api/v1/admin/usage/users': { users: [] },
  '/api/v1/admin/usage/groups': { groups: [] },
  '/api/v1/admin/usage/projects': { projects: [] },
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/v1/admin/usage/timeseries') return route.fulfill({ json: timeseries(route.request().url()) });
    const key = Object.keys(api).sort((x, y) => y.length - x.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen).toEqual([]);
});

const label = page => page.locator('.hoverlayer .legend');

test('read the usage charts on hover and with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.goto('/admin/usage?period=7d');
  const users = page.getByRole('img', { name: /Active users and commits looked at, per day/ });
  const work = page.getByRole('img', { name: /Batches started and qa commands, per day/ });
  await expect(users.locator('.main-svg').first()).toBeVisible();
  await expect(work.locator('.main-svg').first()).toBeVisible();

  // the date and every series
  const box = await users.locator('.nsewdrag').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(label(users)).toContainText(/\w{3}, \w{3} \d+, \d{4}/);
  for (const name of ['Users in the web app', 'Users with the CLI', 'Commits looked at'])
    await expect(label(users)).toContainText(name);
  const dir = process.env.SCREENSHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/usage-hover-light.png`, fullPage: true });

  // the keyboard
  await page.mouse.move(0, 0);
  await work.focus();
  await page.keyboard.press('End');
  await expect(label(work)).toContainText('qa commands');
  await expect(page.getByTestId('chart-reading').nth(1)).toContainText(/Batches started \d+, qa commands \d+/);
  await page.keyboard.press('ArrowLeft');
  await expect(label(work)).toContainText('Batches started');
  if (dir) {
    await page.screenshot({ path: `${dir}/usage-keyboard-light.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    // the charts are drawn again in the dark theme, without the hover label
    await expect(async () => {
      // focusing the other chart scrolled the page
      const now = await users.locator('.nsewdrag').first().boundingBox();
      await page.mouse.move(0, 0);
      await page.mouse.move(now.x + now.width * 0.3, now.y + now.height * 0.5);
      await expect(label(users)).toContainText('Commits looked at', { timeout: 500 });
    }).toPass();
    // the keyboard's label, in the dark theme too
    await page.keyboard.press('ArrowLeft');
    await page.screenshot({ path: `${dir}/usage-hover-dark.png`, fullPage: true });
  }
  await page.keyboard.press('Escape');
  await expect(label(work)).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('weekly buckets over 12 months, with a tap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/admin/usage?period=12m');
    const work = page.getByRole('img', { name: /Batches started and qa commands, per week/ });
    await expect(work.locator('.main-svg').first()).toBeVisible();
    // no horizontal scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await work.scrollIntoViewIfNeeded();
    // the charts may be drawn again as the page settles (e.g. resized), without the hover label
    await expect(async () => {
      const box = await work.locator('.nsewdrag').first().boundingBox();
      await page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.6);
      await expect(label(work)).toContainText(/Week of \w{3} \d+, \d{4}/, { timeout: 1000 });
    }).toPass();
    await expect(label(work)).toContainText('qa commands');
    const dir = process.env.SCREENSHOTS_DIR;
    if (dir) {
      await work.screenshot({ path: `${dir}/usage-12m-phone-light.png` });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/admin/usage?period=90d');
      const users = page.getByRole('img', { name: /Active users and commits looked at, per day/ });
      await expect(users.locator('.main-svg').first()).toBeVisible();
      await page.screenshot({ path: `${dir}/usage-90d-phone-dark.png`, fullPage: true });
    }
  });
});
