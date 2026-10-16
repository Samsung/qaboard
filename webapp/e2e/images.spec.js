// The image viewer on the commit page, against a mocked API and IIIF image server.
import { test, expect } from '@playwright/test';

import { info, tile } from './fixtures/iiif';

const project = 'group/repo';
const qatools_config = { outputs: { visualizations: [{ name: 'Output', path: 'image.png' }] } };

// A gradient. The new image has a dark square the reference doesn't have.
const size = { width: 512, height: 384 };
const square = (x, y) => x >= 100 && x < 140 && y >= 100 && y < 140;
const images = {
  new: { ...size, pixel: (x, y) => square(x, y) ? [20, 20, 20] : [x >> 1, y >> 1, 128] },
  ref: { ...size, pixel: (x, y) => [x >> 1, y >> 1, 128] },
};

const output = (id, hexsha, metadata = {}) => ({
  id, platform: 'linux', configurations: ['base'], extra_parameters: {}, metrics: {}, data: {},
  is_failed: false, is_pending: false, is_running: false, deleted: false,
  created_date: '2026-09-01T10:00:00Z',
  output_dir_url: `/s/mnt/qaboard/${hexsha}/output`,
  test_input_database: '/mnt/database', test_input_path: 'images/A.png', test_input_metadata: metadata,
});
const commit = (hexsha, batch_id, message, metadata) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config },
  batches: { default: {
    id: batch_id, label: 'default', data: {},
    valid_outputs: 1, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
    outputs: { [batch_id]: output(batch_id, hexsha, metadata) },
  } },
});

const setup = async (page, { metadata = {}, manifests } = {}) => {
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/commit/new': commit('new', 1, 'New', metadata),
    '/api/v1/commit/ref': commit('ref', 2, 'Reference', metadata),
  };
  const pixel_requests = [];
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // The image's "raw" values: 10-bit
    if (url.pathname === '/api/v1/output/image/pixels') {
      const hexsha = url.searchParams.get('image_url').split('/')[4];
      const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => Number(url.searchParams.get(k)));
      pixel_requests.push({ x, y, w, h });
      const values = Array.from({ length: h }, (_, j) => Array.from({ length: w }, (_, i) => images[hexsha].pixel(x + i, y + j).map(v => 4 * v)));
      return route.fulfill({ json: { values, meta: { mode: 'RGB;10' } } });
    }
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    const hexsha = pathname.split('/')[4];
    if (pathname.endsWith('/manifest.outputs.json'))
      return route.fulfill({ json: manifests?.[hexsha] ?? { 'image.png': { st_size: 1000, md5: hexsha } } });
    return route.fulfill({ status: 404 });
  });
  await page.route('**/iiif/2/**', route => {
    const { pathname } = new URL(route.request().url());
    const [identifier, ...request] = pathname.replace(/^\/iiif\/2\//, '').split('/');
    const hexsha = decodeURIComponent(identifier).split('/')[2];
    if (request.join('/') === 'info.json') return route.fulfill({ json: info(identifier, images[hexsha]) });
    return route.fulfill({ body: tile(request.join('/'), images[hexsha]), contentType: 'image/png' });
  });
  await page.goto(`/${project}/commit/new?reference=ref&selected_views=output-list`);
  return { pixel_requests };
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

const zoom = async page => parseFloat(await page.locator('.qiv-zoom').textContent());

// How many pixels of a canvas are drawn (dark: and dark), in a region given in fractions of its size
const countPixels = (canvas, [x0, y0, x1, y1], dark) => canvas.evaluate((canvas, [x0, y0, x1, y1, dark]) => {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  const data = context.getImageData(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] > 128 && (!dark || data[i] + data[i + 1] + data[i + 2] < 150)) count++;
  return count;
}, [x0, y0, x1, y1, dark]);
const darkPixels = (canvas, region) => countPixels(canvas, region, true);

test('compares images side by side, with a wipe, toggling, and as their difference', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^reference 512×384/ })).toBeVisible();

  // the values under the pointer: displayed, and the image's own from the server
  const stage = page.locator('.qiv-stage');
  const box = await stage.boundingBox();
  const pane_width = (box.width - 4) / 2;
  await page.mouse.move(box.x + pane_width * 120 / 512, box.y + box.height * 120 / 384);
  const readout = page.locator('.qiv-readout');
  await expect(readout).toContainText(/x 1[12]\d y 1[12]\d/);
  await expect(readout).toContainText('RGB;10 80 80 80');
  await expect(readout).toContainText('Δ −');

  // the difference: dark where the square is, nothing elsewhere
  await page.getByRole('radio', { name: 'Difference' }).click();
  const diff = page.locator('canvas.qiv-diff');
  await expect.poll(() => darkPixels(diff, [0.2, 0.27, 0.27, 0.36])).toBeGreaterThan(100);
  await expect.poll(() => darkPixels(diff, [0.6, 0.6, 0.9, 0.9])).toBe(0);
  // saved in the URL, for links
  await expect(page).toHaveURL(/image_mode.*difference/);
  await page.getByLabel('How to compute the difference').selectOption('deltaE');
  await expect(page.locator('.qiv-legend')).toContainText('ΔE 2000');
  await expect(page).toHaveURL(/deltaE/);

  // wipe: drag the divider
  await page.getByRole('radio', { name: 'Wipe' }).click();
  const divider = page.getByRole('separator', { name: 'Wipe' });
  const stage_box = await stage.boundingBox();
  const divider_box = await divider.boundingBox();
  await page.mouse.move(divider_box.x + divider_box.width / 2, divider_box.y + divider_box.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage_box.x + stage_box.width * 0.75, divider_box.y + divider_box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', /^7[4-6]$/);

  // toggle: click to flip
  await page.getByRole('radio', { name: 'Toggle' }).click();
  await expect(page.locator('.qiv-label')).toHaveText(/^new/);
  await stage.click({ position: { x: 50, y: 50 } });
  await expect(page.locator('.qiv-label')).toHaveText(/^reference/);
  await page.keyboard.press('t');
  await expect(page.locator('.qiv-label')).toHaveText(/^new/);

  // the keyboard picks the mode of the viewer under the mouse
  await page.keyboard.press('1');
  await expect(page.getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true');
});

test('writes the values of the pixels on them when zoomed in', async ({ page }) => {
  const { pixel_requests } = await setup(page);
  const stage = page.locator('.qiv-stage');
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  const fit = await zoom(page);
  // three lines of values need about 40 screen pixels per image pixel
  for (let i = 0; i < 10; i++) await page.keyboard.press('+');
  await expect.poll(() => zoom(page)).toBeGreaterThan(45 * fit);
  // the image's own values are fetched for the region in view
  await expect.poll(() => pixel_requests.some(r => r.w * r.h > 100)).toBe(true);
  const values = page.locator('canvas.qiv-pixel-values').first();
  await expect.poll(() => countPixels(values, [0, 0, 1, 1])).toBeGreaterThan(200);
  // hidden with p
  await page.keyboard.press('p');
  await expect.poll(() => countPixels(values, [0, 0, 1, 1])).toBe(0);
  await page.keyboard.press('p');
});

test('shows the regions of interest of the input', async ({ page }) => {
  await setup(page, { metadata: { roi: [{ x: 100, y: 100, w: 40, h: 40, label: 'Square' }, { x: 0, y: 0, w: 64, h: 48, label: 'Corner' }] } });
  const regions = page.locator('.qiv-regions');
  await expect(regions).toContainText('Presets');
  // the first is shown right away
  await expect(regions.getByRole('button', { name: /Square/ })).toHaveClass(/qiv-active/);
  await expect.poll(() => zoom(page)).toBeGreaterThan(500);
  await page.getByRole('button', { name: 'Next region' }).click();
  await expect(regions.getByRole('button', { name: /Corner/ })).toHaveClass(/qiv-active/);
  // the whole image again
  await page.getByRole('button', { name: 'Regions of interest' }).click();
  await page.getByRole('menuitem', { name: 'Full image' }).click();
  await expect(regions).toHaveCount(0);
  await expect.poll(() => zoom(page)).toBeLessThan(200);
});

test('shows one image when the reference is the same file', async ({ page }) => {
  await setup(page, { manifests: {
    new: { 'image.png': { st_size: 1000, md5: 'same' } },
    ref: { 'image.png': { st_size: 1000, md5: 'same' } },
  } });
  await expect(page.getByText('same as the reference')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Compare' })).toHaveCount(0);
  await expect(page.locator('.qiv-readout')).toContainText('512×384');
});
