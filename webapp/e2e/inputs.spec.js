// The Inputs page, the Collections page and a collection's page, against a mocked API: they load, select, open the viewer, without errors.
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const commit = {
  id: 'abc123', hexsha: 'abc123', project_id: project, branch: 'master', committer_name: 'Alice', message: 'Hello world',
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z', latest_output_datetime: '2026-09-01T10:00:00Z',
  batches: {}, data: {}, parents: [],
};
const inputs = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, database: '/data', path: `night/IMG_${i + 1}.raw`, name: `IMG_${i + 1}.raw`, folder: 'night', runs: 2,
  first_run_at: '2026-09-01T10:00:00Z', last_run_at: '2026-09-02T10:00:00Z', thumbnail_url: `/api/v1/inputs/${i + 1}/thumbnail`,
}));
const collection = {
  id: 7, project, name: 'night/hard-cases', ref: 'night/hard-cases', description: '', created_by: { id: 1, user_name: 'alice' },
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', archived: false, latest_version: 1, size: 3,
  favorite: false, pinned_for: [], pinned: false, can_edit: true, inherited: false,
};
const version = { version: 1, created_by: { id: 1, user_name: 'alice' }, created_at: '2026-09-01T10:00:00Z', notes: '', size: 3 };

// Longest matching prefix wins
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config: {} }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
  '/api/v1/project': { qatools_config: {} },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commits': [commit],
  '/api/v1/commit-counts': { all: 1, mine: 1, without_ci: 0 },
  '/api/v1/batches': [],
  '/api/v1/inputs': { inputs, total: inputs.length, databases: [{ database: '/data', count: 30 }], folders: [{ folder: 'night', name: 'night', count: 30 }] },
  '/api/v1/inputs/2': { ...inputs[1], runs: [] },
  '/api/v1/collections': { collections: [collection] },
  '/api/v1/collections/7': { ...collection, version, versions: [version] },
  '/api/v1/collections/7/inputs': { inputs: inputs.slice(0, 3), total: 3 },
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && !/Failed to load resource/.test(msg.text()) && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    // no thumbnails: the grid shows placeholders
    if (/\/(thumbnail|file)$/.test(pathname)) return route.fulfill({ status: 404, json: { error: 'no_thumbnail' } });
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname === k || pathname.startsWith(`${k}/`) || pathname.startsWith(`${k}?`));
    return route.fulfill({ json: key ? api[key] : {} });
  });
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen, 'errors in the browser console').toEqual([]);
});

test('inputs: select, then open one', async ({ page }) => {
  await page.goto(`/${project}/inputs`);
  await expect(page.getByRole('heading', { name: 'Inputs' })).toBeVisible();
  await page.getByRole('gridcell', { name: 'IMG_1.raw' }).click();
  await page.getByRole('gridcell', { name: 'IMG_3.raw' }).click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 inputs selected')).toBeVisible();
  await page.getByRole('gridcell', { name: 'IMG_2.raw' }).dblclick();
  await expect(page.getByRole('dialog', { name: /IMG_2.raw/ })).toBeVisible();
  await expect(page).toHaveURL(/input=2/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a collection', async ({ page }) => {
  await page.goto(`/${project}/collections/7`);
  await expect(page.getByRole('heading', { name: /hard-cases/ })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'IMG_3.raw' })).toBeVisible();
  await page.getByRole('tab', { name: /Batch file/ }).click();
  await expect(page.getByLabel('qa/batches.yaml')).toContainText(/collections:\s+- night\/hard-cases@1/);
  await expect(page.getByLabel('qa/batches.yaml')).not.toContainText('- collection:');
  await page.getByRole('tab', { name: /Python/ }).click();
  await expect(page.getByLabel('Python', { exact: true })).toContainText('for item in collection:');
  // back to the Collections: their own page, apart from the Inputs
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: /Collections/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${project}/collections$`));
});

test('the Collections page, from the sidebar', async ({ page }) => {
  await page.goto(`/${project}/inputs`);
  const entry = page.getByRole('menuitem', { name: /^Collections/ });
  await expect(entry).toHaveAttribute('href', `/${project}/collections`);
  await entry.click();
  await expect(page.getByRole('heading', { name: 'Collections', exact: true })).toBeVisible();
  await expect(entry).toHaveClass(/bp6-active/);
  await expect(page.getByRole('menuitem', { name: /^Inputs/ })).not.toHaveClass(/bp6-active/);
  await page.getByRole('searchbox', { name: 'Search collections' }).fill('hard');
  await expect(page.getByRole('link', { name: 'hard-cases' })).toBeVisible();
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByRole('region', { name: 'New collection' }).getByRole('link', { name: /Select inputs/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${project}/inputs`));
});
