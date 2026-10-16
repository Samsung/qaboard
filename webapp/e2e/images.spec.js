// The image viewer on the commit page, against a mocked API and IIIF image server.
import { test, expect } from '@playwright/test';

import { info, tile } from './fixtures/iiif';

const project = 'group/repo';
const default_config = { outputs: { visualizations: [{ name: 'Output', path: 'image.png' }] } };

// A gradient. The new image has a dark square the reference doesn't have.
const size = { width: 512, height: 384 };
const square = (x, y) => x >= 100 && x < 140 && y >= 100 && y < 140;
const images = {
  new: { ...size, pixel: (x, y) => square(x, y) ? [20, 20, 20] : [x >> 1, y >> 1, 128] },
  ref: { ...size, pixel: (x, y) => [x >> 1, y >> 1, 128] },
};
// the image of a file of a run: stages/denoise.png is the inverted image
const imageOf = (hexsha, file) => file === 'stages/denoise.png'
  ? { ...size, pixel: (x, y) => images[hexsha].pixel(x, y).map(v => 255 - v) }
  : images[hexsha];

// a run of the commit: `run` names its input (A by default), and its folder (hexsha-run)
const output = (id, hexsha, metadata = {}, run = null) => ({
  id, platform: 'linux', configurations: ['base'], extra_parameters: {}, metrics: {}, data: {},
  is_failed: false, is_pending: false, is_running: false, deleted: false,
  created_date: '2026-09-01T10:00:00Z',
  output_dir_url: `/s/mnt/qaboard/${hexsha}${run ? `-${run}` : ''}/output`,
  test_input_database: '/mnt/database', test_input_path: `images/${run ?? 'A'}.png`, test_input_metadata: metadata,
});
// the runs' ids: the batch's, or batch * 100 + their index
const runOutputs = (hexsha, batch_id, metadata, runs) => Object.fromEntries(runs.length === 1 && !runs[0]
  ? [[batch_id, output(batch_id, hexsha, metadata)]]
  : runs.map((run, i) => [batch_id * 100 + i, output(batch_id * 100 + i, hexsha, metadata, run)]));
// the commit of a run's folder (hexsha-run)
const hexshaOf = folder => folder.split('-')[0];
const commit = (hexsha, batch_id, message, metadata, qatools_config, runs = [null]) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config },
  batches: { default: {
    id: batch_id, label: 'default', data: {},
    valid_outputs: runs.length, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
    outputs: runOutputs(hexsha, batch_id, metadata, runs),
  } },
});

// differences: by run, the largest difference the server finds, for the regions where they differ (none: identical)
const setup = async (page, { metadata = {}, manifests, qatools_config = default_config, runs, differences = {} } = {}) => {
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/commit/new': commit('new', 1, 'New', metadata, qatools_config, runs),
    '/api/v1/commit/ref': commit('ref', 2, 'Reference', metadata, qatools_config, runs),
  };
  const pixel_requests = [];
  const diff_requests = [];
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // The image's "raw" values: 10-bit
    // Where they differ: a square, as much as `differences` says
    if (url.pathname === '/api/v1/output/image/diff') {
      const body = route.request().postDataJSON();
      diff_requests.push(body);
      const run = body.output_dir_url_new.split('/')[4].split('-')[1];
      const value = differences[run];
      return route.fulfill({ json: value ? [{ x: 90, y: 90, w: 60, h: 60, peak_x: 120, peak_y: 120, value, diff: 1 }] : [] });
    }
    if (url.pathname === '/api/v1/output/image/pixels') {
      const [, , , , folder, , ...file] = url.searchParams.get('image_url').split('/');
      const image = imageOf(hexshaOf(folder), file.join('/'));
      const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => Number(url.searchParams.get(k)));
      pixel_requests.push({ x, y, w, h });
      const [cw, ch] = [Math.min(w, image.width - x), Math.min(h, image.height - y)];
      const values = Array.from({ length: ch }, (_, j) => Array.from({ length: cw }, (_, i) => image.pixel(x + i, y + j).map(v => 4 * v)));
      if (url.searchParams.get('format') === 'binary')
        return route.fulfill({
          body: Buffer.from(Uint16Array.from(values.flat(2)).buffer),
          contentType: 'application/octet-stream',
          headers: { 'X-Pixels-Dtype': 'uint16', 'X-Pixels-Shape': `${ch},${cw},3`, 'X-Pixels-Mode': 'RGB;10' },
        });
      return route.fulfill({ json: { values, meta: { mode: 'RGB;10' } } });
    }
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    const hexsha = hexshaOf(pathname.split('/')[4]);
    if (pathname.endsWith('/manifest.outputs.json'))
      return route.fulfill({ json: manifests?.[hexsha] ?? { 'image.png': { st_size: 1000, md5: hexsha } } });
    return route.fulfill({ status: 404 });
  });
  await page.route('**/iiif/2/**', route => {
    const { pathname } = new URL(route.request().url());
    const [identifier, ...request] = pathname.replace(/^\/iiif\/2\//, '').split('/');
    const [, , folder, , ...file] = decodeURIComponent(identifier).split('/');
    const image = imageOf(hexshaOf(folder), file.join('/'));
    if (request.join('/') === 'info.json') return route.fulfill({ json: info(identifier, image) });
    return route.fulfill({ body: tile(request.join('/'), image), contentType: 'image/png' });
  });
  await page.goto(`/${project}/commit/new?reference=ref&selected_views=output-list`);
  return { pixel_requests, diff_requests };
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
// The zoom once its animation is over
const settledZoom = async page => {
  let last = null;
  await expect.poll(async () => {
    const previous = last;
    last = await zoom(page);
    return last === previous;
  }, { intervals: [250] }).toBe(true);
  return last;
};

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
  // the image's own values (10-bit), and the displayed ones
  await expect(readout).toContainText('image 80 80 80 RGB;10');
  await expect(readout).toContainText('display 20 20 20');
  await expect(readout).toContainText('Δ image −');

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

test('shows the difference between the images, or alone', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await page.getByRole('radio', { name: 'Difference' }).click();

  // new | difference | reference
  const diff_pane = page.locator('.qiv-diff-between');
  await expect(diff_pane).toBeVisible();
  const [a, diff, b] = await Promise.all([
    page.getByRole('button', { name: /^new 512×384/ }).boundingBox(),
    diff_pane.boundingBox(),
    page.getByRole('button', { name: /^reference 512×384/ }).boundingBox(),
  ]);
  expect(a.x).toBeLessThan(diff.x);
  expect(diff.x + diff.width).toBeLessThan(b.x);
  await expect(page.locator('.qiv-label-diff')).toHaveText('difference');
  await expect.poll(() => darkPixels(page.locator('canvas.qiv-diff'), [0.2, 0.27, 0.27, 0.36])).toBeGreaterThan(100);

  // hovering the difference: the pixel's values, and a cross on both images
  await page.mouse.move(diff.x + diff.width * 120 / 512, diff.y + diff.height * 120 / 384);
  await expect(page.locator('.qiv-readout')).toContainText(/x 1[12]\d y 1[12]\d/);
  await expect(page.locator('.qiv-crosshair')).toHaveCount(3);

  // the wheel on the difference zooms the images
  const before = await zoom(page);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
  }
  await expect.poll(() => zoom(page)).toBeGreaterThan(before * 1.5);
  await expect(page.locator('.qiv-readout')).toContainText(/x 1[12]\d y 1[12]\d/);

  // Difference again: the difference alone, larger
  await page.getByRole('radio', { name: 'Difference' }).click();
  await expect(diff_pane).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeHidden();
  expect((await page.locator('.qiv-diff-pane').boundingBox()).width).toBeGreaterThan(1.5 * diff.width);
  await expect(page).toHaveURL(/alone/);
  // and back
  await page.keyboard.press('4');
  await expect(diff_pane).toBeVisible();
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
  // fetched by tiles of 64x64
  expect(pixel_requests.every(r => r.w <= 64 && r.h <= 64)).toBe(true);
  await expect(page.locator('.qiv-values-badge')).toHaveText('Values: image (RGB;10)');
  // or the displayed ones
  await page.getByRole('button', { name: 'Pixel values' }).click();
  await page.getByRole('radio', { name: /^Displayed values/ }).check();
  await expect(page.locator('.qiv-values-badge')).toHaveText('Values: displayed, 8-bit');
  await page.keyboard.press('Escape');
  // hidden with p, and back
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.keyboard.press('p');
  await expect.poll(() => countPixels(values, [0, 0, 1, 1])).toBe(0);
  await expect(page.locator('.qiv-values-badge')).toHaveCount(0);
  await page.keyboard.press('p');
  await expect(page.locator('.qiv-values-badge')).toHaveText('Values: displayed, 8-bit');
});

test('keeps the zoom when the file shown changes', async ({ page }) => {
  const files = { 'stages/denoise.png': { st_size: 1000, md5: 'a' }, 'stages/sharpen.png': { st_size: 1000, md5: 'b' } };
  await setup(page, {
    qatools_config: { outputs: { visualizations: [{ name: 'Output', path: 'stages/:stage.png' }] } },
    manifests: { new: files, ref: { 'stages/denoise.png': { st_size: 1000, md5: 'c' }, 'stages/sharpen.png': { st_size: 1000, md5: 'd' } } },
  });
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  // where the stage is picked (the panel narrows the viewer)
  await page.getByRole('button', { name: 'Show the view options' }).click();
  await page.waitForTimeout(500);
  const box = await page.locator('.qiv-stage').boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) await page.keyboard.press('+');
  const before = await settledZoom(page);
  expect(before).toBeGreaterThan(400);
  // the first stage, inverted
  await expect(page.locator('.qiv-readout')).toContainText('x 256 y 192 new image 508 636 508');
  await page.getByLabel('Stage', { exact: true }).selectOption('sharpen');
  // the same pixel is under the pointer, of the other stage
  await page.mouse.move(box.x + box.width / 4 + 1, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await expect(page.locator('.qiv-readout')).toContainText('x 256 y 192 new image 512 384 512');
  expect(await settledZoom(page)).toBe(before);
});

test('compares in full screen', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  const before = await page.locator('.qiv-stage').boundingBox();
  await page.getByRole('button', { name: 'Full screen (f)' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('qiv'))).toBe(true);
  // the images take the screen
  await expect.poll(async () => (await page.locator('.qiv-stage').boundingBox()).height).toBeGreaterThan(before.height);
  await page.getByRole('radio', { name: 'Wipe' }).click();
  await expect(page.getByRole('separator', { name: 'Wipe' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit full screen (f or Esc)' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
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

test('finds where the images differ in all the runs, and ranks them', async ({ page }) => {
  const { diff_requests } = await setup(page, { runs: ['A', 'B', 'C'], differences: { A: 0.3, C: 0.05 } });
  const first = page.locator('.output-card[data-output-id="100"]');
  await expect(first.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await first.getByRole('button', { name: 'Regions of interest' }).click();
  await page.getByRole('menuitem', { name: 'Where they differ, in all 3 runs…' }).click();

  // the runs that differ most first
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Where the images differ, in 3 runs');
  await expect(dialog).toContainText('3 / 3 · 1 identical');
  const rows = dialog.locator('tbody tr');
  await expect(rows.nth(0)).toContainText('images/A.png');
  await expect(rows.nth(0)).toContainText('30.0%');
  await expect(rows.nth(1)).toContainText('images/C.png');
  await expect(rows.nth(1)).toContainText('5.0%');
  await expect(rows.nth(2)).toContainText('identical');
  expect(diff_requests.map(body => body.path)).toEqual(['image.png', 'image.png', 'image.png']);

  // go to a run: its viewer shows where its images differ
  await rows.nth(1).getByRole('button', { name: 'Show' }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator('.output-card[data-output-id="102"]');
  await expect(card.locator('.qiv-regions')).toContainText('Where they differ: perceptual');
  await expect(card.locator('.qiv-region').first()).toContainText('#1 · 5.0%');
  // and so do the others, with what was found already
  await expect(first.locator('.qiv-region').first()).toContainText('#1 · 30.0%');
  expect(diff_requests).toHaveLength(3);
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
