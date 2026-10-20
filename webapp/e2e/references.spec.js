// Several references: the new commit is compared with one at a time, users switch between them
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const commit = (id, message, branch = 'master') => ({
  id, hexsha: id, project_id: project, branch,
  committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z',
  batches: {}, data: {}, parents: [],
});
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40), f = 'f'.repeat(40);
const commits = {
  [e]: commit(e, 'Faster tone mapping'),
  [f]: commit(f, 'Night mode', 'feature/night'),
  [a]: commit(a, 'Faster denoiser', 'feature/denoiser'),
  [b]: commit(b, 'Release 1.0'),
  [c]: { ...commit(c, 'Tuning the sharpening', 'tuning/sharpen'), batches: { default: { id: 1, label: 'default', valid_outputs: 12, failed_outputs: 2, running_outputs: 0, pending_outputs: 0, outputs: {}, data: {} } } },
  [d]: commit(d, 'Latest on master'),
};

const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config: {} }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
  '/api/v1/project': { qatools_config: {} },
  '/api/v1/milestones': { milestones: [{ id: 1, project, commit: b, batch: 'default', label: 'release 1.0', is_mine: true, shared: false }], favorite_groups: [] },
  '/api/v1/commits': Object.values(commits),
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  // the release notes' popup would hide the menus
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const id = pathname.match(/^\/api\/v1\/commit\/([0-9a-f]+)$/)?.[1];
    if (id) return route.fulfill({ json: commits[id] });
    if (pathname.startsWith('/api/v1/commit')) return route.fulfill({ json: commits[d] });
    const key = Object.keys(api).sort((x, y) => y.length - x.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen, 'errors in the browser console').toEqual([]);
});

test('switch between references', async ({ page }) => {
  await page.goto(`/${project}/commit/${a}?reference=${b}&compare=${c}&compare=${d}`);
  await expect(page.getByText('Release 1.0').first()).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(3);

  await page.getByRole('tab', { name: /^Reference 2:/ }).click();
  await expect(page.getByText('Tuning the sharpening').first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`reference=${c}`));
  await page.keyboard.press('r');
  await expect(page.getByText('Latest on master').first()).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Reference 3:/ })).toHaveAttribute('aria-selected', 'true');
  await page.waitForLoadState('networkidle');
});

test('stack a reference, rename what we compare', async ({ page }) => {
  await page.goto(`/${project}/commit/${a}?reference=${b}`);
  await expect(page.getByText('Release 1.0').first()).toBeVisible();
  // the handle shows when hovering the reference's bar
  await page.locator('.qa-ref-bar').hover();
  await page.getByRole('button', { name: 'Stack a reference' }).click();
  await page.getByRole('textbox', { name: 'Add a commit or a branch as reference' }).fill(c);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Tuning the sharpening').first()).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);

  await page.getByRole('button', { name: 'new: rename' }).click();
  await page.getByRole('textbox', { name: 'Name instead of “new”' }).fill('ISP v2');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/label=ISP\+v2|label=ISP%20v2/);
  await expect(page.getByRole('button', { name: 'ISP v2: rename' })).toBeVisible();
  await page.waitForLoadState('networkidle');
});

// What users do with their references: stack, duplicate, rename, reorder. Each one keeps one name everywhere.
test('a reference has one name, in its tab, the reference bar and the viewers', async ({ page }) => {
  await page.goto(`/${project}/commit/${a}?reference=${c}`);
  await expect(page.getByText('Tuning the sharpening').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'ref: rename' })).toBeVisible();

  await page.locator('.qa-ref-bar').hover();
  await page.getByRole('button', { name: 'Stack a reference' }).click();
  await page.getByRole('textbox', { name: 'Add a commit or a branch as reference' }).fill(d);
  await page.keyboard.press('Enter');
  // the first stays "ref", the one added is "ref 2", shown in the reference bar
  await expect(page.getByRole('tab', { name: /^Reference 1: ref, tuning\/sharpen/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Reference 2: ref 2, master/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'ref 2: rename' })).toBeVisible();

  // the "⋯" menu: duplicate the first one
  await page.getByRole('tab', { name: /^Reference 1:/ }).hover();
  await page.getByRole('button', { name: 'Reference 1: more' }).click();
  await page.getByRole('menuitem', { name: /Duplicate/ }).click();
  await expect(page.getByRole('tab', { name: /^Reference 2: ref 3, tuning\/sharpen/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'ref 3: rename' })).toBeVisible();

  // renaming in the reference bar renames its tab
  await page.getByRole('button', { name: 'ref 3: rename' }).click();
  await page.getByRole('textbox', { name: 'Name instead of “ref 3”' }).fill('sharper');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Reference 2: sharper/ })).toBeVisible();

  // dragging it to the end: it keeps its name, and stays shown
  await page.getByRole('tab', { name: /^Reference 2:/ }).dragTo(page.getByRole('tab', { name: /^Reference 3:/ }), { targetPosition: { x: 80, y: 10 } });
  await expect(page.getByRole('tab', { name: /^Reference 3: sharper/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /^Reference 2: ref 2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'sharper: rename' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.locator('.qa-tabs').screenshot({ path: test.info().outputPath('tabs.png') });

  // hovering a tab tells what it is
  await page.getByRole('tab', { name: /^Reference 1:/ }).hover();
  const card = page.locator('.bp6-tooltip').filter({ hasText: 'Click to compare with it' });
  await expect(card).toContainText('Tuning the sharpening');
  await expect(card).toContainText('Alice');
  await expect(card).toContainText('Batch CI');
  await expect(card).toContainText('12 runs · 2 failed');
  await page.screenshot({ path: test.info().outputPath('hover.png'), clip: { x: 0, y: 0, width: 900, height: 420 } });
  await page.waitForLoadState('networkidle');
});

test('tabs say what tells references apart, and scroll when there are many', async ({ page }) => {
  // a milestone, two commits of master, a branch, copies with another batch and a filter
  const refs = [[d], [e], [f], [f, 'night'], [f, '', 'indoor'], [c]];
  const compare = refs.map(([id, batch, filter], i) => `compare[${i}][commit]=${id}${batch ? `&compare[${i}][batch]=${batch}` : ''}${filter ? `&compare[${i}][filter]=${filter}` : ''}`).join('&');
  await page.setViewportSize({ width: 1600, height: 600 });
  await page.goto(`/${project}/commit/${a}?reference=${b}&${compare}`);
  await expect(page.getByRole('tab')).toHaveCount(7);
  // the milestone, by its name only
  await expect(page.getByRole('tab', { name: /^Reference 1: release 1.0$/ })).toBeVisible();
  // master's commits: their branch and commit
  await expect(page.getByRole('tab', { name: /^Reference 2: ref 2, dddddddd, master$/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Reference 5: ref 5, night, feature\/night$/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Reference 6: ref 6, indoor, feature\/night$/ })).toBeVisible();
  await page.locator('.qa-tabs').screenshot({ path: test.info().outputPath('wide.png') });

  await page.setViewportSize({ width: 900, height: 600 });
  const tabs = page.locator('.qa-tabs');
  await expect.poll(() => tabs.evaluate(t => t.scrollWidth > t.clientWidth)).toBe(true);
  await expect(tabs).toHaveAttribute('data-overflow', 'end');
  await page.locator('.qa-tabs').screenshot({ path: test.info().outputPath('narrow.png') });
  await tabs.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => tabs.evaluate(t => t.scrollLeft)).toBeGreaterThan(0);
  await page.locator('.qa-tabs').screenshot({ path: test.info().outputPath('narrow-scrolled.png') });

  await page.setViewportSize({ width: 600, height: 600 });
  await expect(page.locator('.qa-tab-details').first()).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('phone.png'), clip: { x: 0, y: 0, width: 600, height: 200 } });
  await page.waitForLoadState('networkidle');
});
