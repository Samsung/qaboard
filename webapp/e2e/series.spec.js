// What runs log while they run (run.log() in Python): their series show on their card, without anything in
// qaboard.yaml, next to the reference run's. Against a mocked API and storage.
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const qatools_config = {};

// a training's loss, and the reference's, a bit worse
const curve = (points, scale) => ({
  points,
  step: Array.from({ length: points }, (_, i) => i * 10),
  time: Array.from({ length: points }, (_, i) => i * 2),
  value: Array.from({ length: points }, (_, i) => Number((scale * Math.exp(-i / 40) + 0.05 * Math.sin(i)).toFixed(4))),
});
const series = {
  new: { 'train/loss': curve(200, 2), 'val/loss': curve(20, 2.2), lr: { points: 2, step: [0, 1990], time: [0, 398], value: [0.001, 0.0001] } },
  ref: { 'train/loss': curve(200, 2.5), 'val/loss': curve(20, 2.8) },
};

const output = (id, hexsha, is_running = false) => ({
  id, platform: 'linux', configurations: ['resnet50', { lr: 0.001 }], extra_parameters: {}, data: { sdk: { script: 'train.py' } },
  metrics: { 'train/loss': series[hexsha]['train/loss'].value.at(-1) },
  is_failed: false, is_pending: is_running, is_running, deleted: false,
  created_date: '2026-09-01T10:00:00Z',
  output_dir_url: `/s/mnt/qaboard/${hexsha}/output`,
  test_input_database: '/mnt/database', test_input_path: 'train/coco-mini', test_input_metadata: {},
});
const commit = (hexsha, batch_id, message, is_running) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config },
  batches: { default: {
    id: batch_id, label: 'default', data: {},
    valid_outputs: 1, pending_outputs: 0, running_outputs: is_running ? 1 : 0, failed_outputs: 0, deleted_outputs: 0,
    outputs: { [batch_id]: output(batch_id, hexsha, is_running) },
  } },
});

const setup = async (page, { is_running = false } = {}) => {
  const manifest = { 'series.json': { st_size: 1000, md5: 'a' }, 'series.jsonl': { st_size: 9000, md5: 'b' }, 'model.onnx': { st_size: 5, md5: 'c' } };
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/commit/new': commit('new', 1, 'Lower learning rate', is_running),
    '/api/v1/commit/ref': commit('ref', 2, 'Reference', false),
    // running runs' files are listed by the server
    '/api/v1/output/1/manifest': manifest,
  };
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    const hexsha = pathname.split('/')[4];
    if (pathname.endsWith('/manifest.outputs.json'))
      return route.fulfill({ json: { ...manifest, 'series.json': { st_size: 1000, md5: hexsha } } });
    if (pathname.endsWith('/series.json'))
      return route.fulfill({ json: { format: 'qaboard-series', version: 1, started_at: 1700000000, series: series[hexsha] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`/${project}/commit/new?reference=ref&selected_views=output-list`);
};

const errors = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(() => {
  expect(errors, 'errors in the browser console').toEqual([]);
});

test("a run's logged series are plotted on its card, with the reference's", async ({ page }) => {
  await setup(page);
  const viewer = page.getByTestId('series-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('3 series, logged over 6m 38s')).toBeVisible();
  // one plot per series, drawn by Plotly: the new run's line and the reference's on the same axes
  await expect(viewer.locator('.js-plotly-plot')).toHaveCount(3);
  const loss = viewer.locator('.js-plotly-plot').filter({ hasText: 'train/loss' });
  await expect(loss.locator('.scatterlayer .trace')).toHaveCount(2);
  // the reference didn't log the learning rate
  await expect(viewer.locator('.js-plotly-plot').filter({ has: page.locator('.gtitle', { hasText: /^lr$/ }) }).locator('.scatterlayer .trace')).toHaveCount(1);
  await expect(viewer.getByText('Live')).toHaveCount(0);

  // options are kept in the page's address, for all the cards
  await viewer.getByText('Log scale').click();
  await expect(page).toHaveURL(/controls=.*series.*log/);
  await viewer.getByLabel('Horizontal axis').selectOption('time');
  await expect(loss.locator('.xtitle')).toHaveText('seconds');
});

test('a running run is marked as live', async ({ page }) => {
  await setup(page, { is_running: true });
  const viewer = page.getByTestId('series-viewer');
  await expect(viewer.getByText('Live')).toBeVisible();
  await expect(viewer.locator('.js-plotly-plot')).toHaveCount(3);
});

// The Summary view: all the runs' series on the same plots
const sweep = async page => {
  const lrs = [0.1, 0.01, 0.001];
  const run = (id, lr, i) => ({
    ...output(id, 'new'), id, configurations: ['resnet50', { lr, optimizer: i < 2 ? 'adamw' : 'sgd' }], output_dir_url: `/s/mnt/qaboard/sweep-${i}/output`,
  });
  const batch = { id: 1, label: 'default', data: {}, valid_outputs: 3, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
                  outputs: Object.fromEntries(lrs.map((lr, i) => [10 + i, run(10 + i, lr, i)])) };
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/commit': { ...commit('new', 1, 'Learning rate sweep', false), batches: { default: batch } },
  };
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    const index = Number(pathname.split('/')[4].split('-')[1]);
    if (!pathname.endsWith('/series.json')) return route.fulfill({ status: 404 });
    return route.fulfill({ json: { format: 'qaboard-series', version: 1, started_at: 1700000000, series: {
      'train/loss': curve(200, 2 + index), 'val/loss': curve(20, 2.2 + index),
    } } });
  });
  await page.goto(`/${project}/commit/new?selected_views=summary`);
};

test("the Summary plots all the runs' series together, and people pick the runs", async ({ page }) => {
  await sweep(page);
  const comparison = page.getByTestId('series-comparison');
  await expect(comparison.getByText('3 runs, 2 series')).toBeVisible();
  const loss = comparison.locator('.js-plotly-plot').filter({ has: page.locator('.gtitle', { hasText: 'train/loss' }) });
  await expect(loss.locator('.scatterlayer .trace')).toHaveCount(3);
  // runs are named by what tells them apart
  await expect(comparison.getByRole('button', { name: 'Hide lr=0.1 · optimizer=adamw' })).toBeVisible();

  // hovering a run brings its line forward: the others fade, without the plots being drawn again
  await comparison.getByRole('button', { name: 'Hide lr=0.01 · optimizer=adamw' }).hover();
  await expect(loss.locator('.scatterlayer .trace').first()).toHaveCSS('opacity', '0.12');
  await expect(loss.locator('.scatterlayer .trace').nth(1)).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(loss.locator('.scatterlayer .trace').first()).toHaveCSS('opacity', '1');

  await comparison.getByRole('button', { name: 'Hide lr=0.1 · optimizer=adamw' }).click();
  await expect(loss.locator('.scatterlayer .trace')).toHaveCount(2);
  await expect(comparison.getByText('2 of 3 runs, 2 series')).toBeVisible();
  await comparison.getByRole('button', { name: 'Show all' }).click();

  await comparison.getByLabel('Color the runs by').selectOption('optimizer');
  await comparison.getByRole('button', { name: 'Show only optimizer = sgd' }).click();
  await expect(loss.locator('.scatterlayer .trace')).toHaveCount(1);
});
