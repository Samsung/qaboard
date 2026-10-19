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
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
const commits = {
  [a]: commit(a, 'Faster denoiser', 'feature/denoiser'),
  [b]: commit(b, 'Release 1.0'),
  [c]: commit(c, 'Tuning the sharpening', 'tuning/sharpen'),
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
  await expect(page.getByRole('button', { name: /Reference 1 of 3/ })).toBeVisible();

  await page.getByRole('button', { name: 'Next reference' }).click();
  await expect(page.getByText('Tuning the sharpening').first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`reference=${c}`));
  await page.keyboard.press('r');
  await expect(page.getByText('Latest on master').first()).toBeVisible();

  await page.getByRole('button', { name: /Reference 3 of 3/ }).click();
  await expect(page.getByText('Compare with one of 3 references')).toBeVisible();
  await page.waitForLoadState('networkidle');
});

test('add a reference', async ({ page }) => {
  await page.goto(`/${project}/commit/${a}?reference=${b}`);
  await expect(page.getByText('Release 1.0').first()).toBeVisible();
  await page.getByRole('button', { name: 'Compare with more references' }).click();
  await page.getByRole('textbox', { name: 'Add a commit as reference' }).fill(c);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Tuning the sharpening').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Reference 2 of 2/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
});
