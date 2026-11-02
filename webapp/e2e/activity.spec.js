// Runs activity: what waits and runs now, against a mocked API.
// SCREENSHOTS_DIR=/some/folder saves how it looks, in light and dark.
import { test, expect } from '@playwright/test';

const now = new Date();
const ago = minutes => new Date(now.getTime() - minutes * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const a = 'a'.repeat(40), c = 'c'.repeat(40);
const bars = Array.from({ length: 24 }, (_, i) => ({
  at: ago((24 - i) * 60), waiting: [0, 0, 1, 3, 8, 12, 6, 2, 0, 0, 0, 0, 4, 9, 14, 20, 18, 9, 5, 3, 2, 6, 10, 7][i],
  running: [2, 2, 3, 6, 10, 16, 18, 14, 9, 4, 2, 2, 5, 12, 20, 26, 30, 28, 22, 15, 10, 12, 16, 14][i],
  done: [0, 1, 2, 3, 6, 9, 14, 12, 8, 3, 1, 0, 2, 6, 12, 18, 22, 25, 20, 14, 9, 8, 10, 6][i], failed: i === 16 ? 4 : i === 5 ? 1 : 0,
}));
const batch = (key, label, props) => ({
  key, batch_id: key, batch_label: label, project_id: 'isp/denoise', ci_commit_id: 3, hexsha: a, branch: 'feature/night', runs: 30,
  waiting: 0, running: 0, done: 0, failed: 0, active_since: null, latest: ago(2), nb_projects: 1, commits: 1, batches: 1, labels: [label],
  users: ['alice', 'bob'], nb_users: 2, runners: ['lsf'], queues: ['gpu'], run_seconds: 1500, wait_seconds: 420, ...props,
});
const run = (id, status, input, props) => ({
  id, status, batch_id: 7, batch_label: 'tuning-night', project_id: 'isp/denoise', hexsha: a, branch: 'feature/night',
  input_path: input, input_database: '/datasets', platform: 'linux', configurations: ['base', 'night'], extra_parameters: { iso: 800 },
  user_name: 'alice', job_options: { type: 'lsf', queue: 'gpu', memory: '16G' }, queued_at: ago(95), started_at: status === 'waiting' ? null : ago(80),
  finished_at: status === 'done' || status === 'failed' ? ago(10) : null, created_date: ago(95), output_dir_url: `/s/runs/${id}`, failed_reason: null, ...props,
});

const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local', is_admin: true },
  '/api/v1/activity/overview': {
    scope: 'all', me: 'alice', is_admin: true, now: now.toISOString(), window: '24h', since: ago(24 * 60),
    totals: { waiting: 7, running: 14, done: 211, failed: 5, active_users: 4, active_projects: 3, active_batches: 6, active_since: ago(60 * 24 * 9), long_active: 3 },
    timeline: { step_seconds: 3600, bars },
    starting_soon: [{ id: 's1', created_at: ago(4), user: 'bob', runner: 'lsf', status: 'submitted', lsf_job_id: '804211', queue: 'gpu',
      batch_id: 9, batch_label: 'sweep-iso', batch: 'night-scenes', ci_commit_id: 3, hexsha: c, branch: 'dev', project_id: 'isp/denoise', log_dir_url: '/s/logs/s1' }],
    projects: [{ key: 'isp/denoise', waiting: 5, running: 9, ended: 120, failed: 3 }, { key: 'isp/hdr', waiting: 2, running: 4, ended: 80, failed: 2 }, { key: 'slam/vio', waiting: 0, running: 1, ended: 16, failed: 0 }],
    users: [{ key: 'alice', waiting: 4, running: 6, ended: 90, failed: 1 }, { key: 'bob', waiting: 3, running: 5, ended: 70, failed: 4 }, { key: 'ci', waiting: 0, running: 3, ended: 51, failed: 0 }],
    queues: [{ key: 'gpu', waiting: 6, running: 8, ended: 100, failed: 2 }, { key: 'short', waiting: 1, running: 6, ended: 111, failed: 3 }],
    stuck: { older_than: '1week', runs: 3, schedule: null },
  },
  '/api/v1/activity/items': {
    total: 3, group: 'batch', items: [
      batch(7, 'tuning-night', { runs: 40, waiting: 5, running: 9, done: 24, failed: 2, active_since: ago(150) }),
      batch(8, 'default', { project_id: 'isp/hdr', branch: 'master', runs: 30, waiting: 2, running: 4, done: 23, failed: 1, active_since: ago(60 * 24 * 9), users: ['ci'], nb_users: 1, queues: ['short'] }),
      batch(9, 'regression', { runs: 61, done: 59, failed: 2, latest: ago(35), users: ['bob'], nb_users: 1 }),
    ],
  },
  '/api/v1/activity/runs': {
    total: 4, runs: [
      run(1, 'running', 'night/scene_01.dng'), run(2, 'running', 'night/scene_02.dng'),
      run(3, 'waiting', 'night/scene_03.dng'),
      run(4, 'failed', 'night/scene_04.dng', { failed_reason: 'Marked as failed by alice. Its job was not stopped.' }),
    ],
  },
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/s/**', route => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((x, y) => y.length - x.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  // the logs of the batch that starts soon aren't there yet: 404s are expected
  expect(testInfo.errors_seen.filter(e => !e.includes('404'))).toEqual([]);
});

test('see what runs, open a batch\'s runs', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1300 });
  await page.goto('/activity?scope=all');
  await expect(page.getByTestId('total-running')).toContainText('14');
  await expect(page.getByTestId('timeline-bar')).toHaveCount(24);
  await expect(page.getByTestId('starting-soon')).toContainText('sweep-iso');
  await page.getByRole('button', { name: 'Show the runs: Batch tuning-night' }).click();
  await expect(page.getByTestId('run')).toHaveCount(4);
  const dir = process.env.SCREENSHOTS_DIR;
  if (dir) {
    await page.screenshot({ path: `${dir}/activity-light.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.body.classList.add('bp6-dark'));
    await page.screenshot({ path: `${dir}/activity-dark.png`, fullPage: true });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({ path: `${dir}/activity-phone.png`, fullPage: false });
  }
});
