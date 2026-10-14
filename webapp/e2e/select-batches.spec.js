// The batch selector keeps its scroll position while the store updates (mocked API, like smoke.spec.js).
// npm run build && npm run e2e
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const labels = ['default', ...Array.from({length: 40}, (_, i) => `batch-${String(i).padStart(2, '0')}`)];
const commit = {
  id: 'abc123', hexsha: 'abc123', project_id: project, branch: 'master',
  committer_name: 'Alice', message: 'Hello world',
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z',
  batches: Object.fromEntries(labels.map(label => [label, { label, data: {}, outputs: {} }])),
  data: {}, parents: [],
};
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config: {} }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
  '/api/v1/project': { id: project, data: { qatools_config: {} } },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commit': commit,
};

test('the batch menu keeps its scroll position when the store updates', async ({ page }) => {
  // We answer the projects list only once the menu is scrolled: it updates the store
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/api/v1/projects'))
      await held;
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.goto(`/${project}/commit/abc123`);
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 3000 }).catch(() => {});
  await page.locator('.bp6-button').filter({ hasText: '0/0' }).first().click({ force: true });
  const list = page.getByRole('listbox');
  await expect(list.locator('li')).toHaveCount(labels.length);
  // let the popover finish opening: then Blueprint scrolls the active item into view
  await page.waitForTimeout(500);

  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(300);
  const scrolled = await list.evaluate(el => el.scrollTop);

  const projects_loaded = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/api/v1/projects'));
  release();
  await projects_loaded;
  await page.waitForTimeout(300);
  expect(await list.evaluate(el => el.scrollTop)).toBe(scrolled);
});
