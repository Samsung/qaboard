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
  '/api/v1/project': { id: project, data: { qatools_config: {} } },
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
