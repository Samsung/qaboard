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

// differences: by run, the largest difference the server finds, for the regions where they differ (none: identical),
// after diff_delay ms. eight_bit: the image's own values are 8-bit RGB (else 10-bit)
// raw images: the images through a GBRG Bayer CFA, 10-bit with a black level of 64. Only the reference's reader knows it.
const RAW_GAINS = { R: 0.5, G: 1, B: 0.7 };
const rawValue = (image, x, y) => {
  const color = 'GBRG'[2 * (y % 2) + (x % 2)];
  return 64 + Math.round(4 * image.pixel(x, y)['RGB'.indexOf(color)] * RAW_GAINS[color]);
};
const RAW_SENSOR = { cfa: { pattern: 'GBRG', block: 1 }, bit_depth: 10, white_level: 1023, black_level: 64, fields: { pattern: 'GBRG', imageType: 'UI10', pedestal: 64 } };

const setup = async (page, { metadata = {}, manifests, qatools_config = default_config, runs, differences = {}, diff_delay = 0, eight_bit = false, raw = false, signed_in = true } = {}) => {
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': signed_in ? { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' } : { is_authenticated: false },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/commit/new': commit('new', 1, 'New', metadata, qatools_config, runs),
    '/api/v1/commit/ref': commit('ref', 2, 'Reference', metadata, qatools_config, runs),
  };
  const pixel_requests = [];
  const diff_requests = [];
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // The image's "raw" values: 10-bit
    // Where they differ: a square, as much as `differences` says
    if (url.pathname === '/api/v1/output/image/diff') {
      const body = route.request().postDataJSON();
      diff_requests.push(body);
      const run = body.output_dir_url_new.split('/')[4].split('-')[1];
      const value = differences[run];
      if (diff_delay) await new Promise(resolve => setTimeout(resolve, diff_delay));
      return route.fulfill({ json: value ? [{ x: 90, y: 90, w: 60, h: 60, peak_x: 120, peak_y: 120, value, diff: 1 }] : [] });
    }
    if (url.pathname === '/api/v1/output/image/pixels') {
      const [, , , , folder, , ...file] = url.searchParams.get('image_url').split('/');
      const image = imageOf(hexshaOf(folder), file.join('/'));
      const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(k => Number(url.searchParams.get(k)));
      pixel_requests.push({ x, y, w, h });
      const [cw, ch] = [Math.min(w, image.width - x), Math.min(h, image.height - y)];
      if (raw) {
        const data = Uint16Array.from({ length: cw * ch }, (_, i) => rawValue(image, x + (i % cw), y + Math.floor(i / cw)));
        return route.fulfill({
          body: Buffer.from(data.buffer),
          contentType: 'application/octet-stream',
          headers: {
            'X-Pixels-Dtype': 'uint16', 'X-Pixels-Shape': `${ch},${cw}`, 'X-Pixels-Mode': 'I;16',
            ...(hexshaOf(folder) === 'ref' ? { 'X-Pixels-Sensor': JSON.stringify(RAW_SENSOR) } : {}),
          },
        });
      }
      const values = Array.from({ length: ch }, (_, j) => Array.from({ length: cw }, (_, i) => image.pixel(x + i, y + j).map(v => eight_bit ? v : 4 * v)));
      const mode = eight_bit ? 'RGB' : 'RGB;10';
      if (url.searchParams.get('format') === 'binary')
        return route.fulfill({
          body: Buffer.from((eight_bit ? Uint8Array : Uint16Array).from(values.flat(2)).buffer),
          contentType: 'application/octet-stream',
          headers: { 'X-Pixels-Dtype': eight_bit ? 'uint8' : 'uint16', 'X-Pixels-Shape': `${ch},${cw},3`, 'X-Pixels-Mode': mode },
        });
      return route.fulfill({ json: { values, meta: { mode } } });
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

// Another page of the app, without reloading it
const navigate = (page, url) => page.evaluate(url => {
  history.pushState({}, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}, url);

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
  await expect(page.getByRole('button', { name: /^ref 512×384/ })).toBeVisible();

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

  // single: a click or t shows the other image, then the first again, and stays in single mode
  await page.getByRole('radio', { name: 'Single' }).click();
  await expect(page.locator('.qiv-label')).toHaveText(/^new/);
  await stage.click({ position: { x: 50, y: 50 } });
  await expect(page.locator('.qiv-label')).toHaveText(/^ref(?!erence)/);
  await expect(page.getByRole('button', { name: /^Show the new image/ })).toBeVisible();
  await page.keyboard.press('t');
  await expect(page.locator('.qiv-label')).toHaveText(/^new/);
  await expect(page.getByRole('radio', { name: 'Single' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.qiv-diff-pane')).toHaveCount(0);

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
    page.getByRole('button', { name: /^ref 512×384/ }).boundingBox(),
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

test('analyzes the view: histogram, row and column profiles, statistics, and remembers the view', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  const box = await page.locator('.qiv-pane').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('a');
  await expect(page.getByRole('radio', { name: 'Histogram' })).toBeChecked();

  // the values along the row and column under the pointer: blue is 128, away from the square
  await page.getByRole('radio', { name: 'Row / column' }).click();
  await expect(page.locator('.qiv-profile')).toHaveCount(2);
  await page.getByLabel('Profiles of').selectOption('pointer');
  await page.mouse.move(box.x + box.width * 300 / 512, box.y + box.height * 300 / 384);
  await expect(page.locator('.qiv-profile-title').first()).toContainText(/Row (29\d|30[0-4])(?!\d)/);
  await expect(page.locator('.qiv-profile-readout').first()).toContainText('B 128.0 / 128.0');
  // hovering a profile shows its column on the images
  await page.locator('.qiv-profile-plot').first().hover();
  await expect(page.locator('.qiv-guide-x')).toHaveCount(2);

  // the square is dark in the new image only
  await page.getByRole('radio', { name: 'Statistics' }).click();
  const blue = page.locator('.qiv-stats-table tbody tr').filter({ has: page.locator('th', { hasText: /^B$/ }) });
  const min = row => row.locator('td').nth(4);
  await expect(min(blue)).toHaveText('20');
  await expect(min(blue.locator('xpath=following-sibling::tr[1]'))).toHaveText('128');

  // the view picked last opens next time
  await page.reload();
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await page.getByRole('button', { name: /analysis of the view/ }).click();
  await expect(page.getByRole('radio', { name: 'Statistics' })).toBeChecked();
});

test('analyzes raw images by channel of their CFA, from their metadata or guessed from the pixels', async ({ page }) => {
  await setup(page, { raw: true });
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await page.getByRole('button', { name: /analysis of the view/ }).click();
  await page.getByRole('radio', { name: 'Statistics' }).click();
  await page.getByRole('radio', { name: 'Image values' }).click();
  const card = page.locator('.qiv-sensor');
  // the new image has no metadata: guessed, red and blue in an order we can't know
  await expect(card.locator('.qiv-sensor-title')).toContainText(/(GRBG|GBRG) · Bayer/);
  await expect(card.locator('.qiv-sensor-title .qiv-source')).toHaveText('guessed');
  await expect(card).toContainText('10-bit');
  // the reference's reader knows
  await expect(card.locator('.qiv-sensor-other')).toContainText('ref: GBRG · Bayer');
  await expect(card.locator('.qiv-sensor-other .qiv-source').first()).toHaveText('metadata');
  await expect(card.locator('.qiv-sensor-other')).toContainText('black 64');
  // the same sensor: use what the reference's metadata says
  await card.getByRole('button', { name: /^use its .*black level 64/ }).click();
  await expect(card.locator('.qiv-sensor-title')).toContainText('GBRG · Bayer');
  await expect(card.locator('.qiv-sensor-facts')).toContainText('black 64');
  // the statistics of each channel, without the black level: red has half the gain of green, in a scene where red
  // averages 128 and green 96
  const table = page.locator('.qiv-stats-table');
  await expect(table).toContainText('Gr');
  await expect(page.locator('.qiv-ratio', { hasText: 'R/G' }).first()).toContainText(/0\.6[67]\d/);
  // or set it: remembered for the project
  await card.getByRole('button', { name: 'Sensor' }).click();
  await page.getByLabel('Black level').fill('60');
  await page.getByLabel('Black level').press('Enter');
  await expect(card.locator('.qiv-sensor-facts')).toContainText('black 60');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await page.getByRole('button', { name: /analysis of the view/ }).click();
  await expect(page.getByRole('radio', { name: 'Image values' })).toBeChecked();
  await expect(card.locator('.qiv-sensor-title')).toContainText('GBRG · Bayer');
  await expect(card.locator('.qiv-sensor-title .qiv-source')).toHaveText('yours');
  await expect(card.locator('.qiv-sensor-facts')).toContainText('black 60');
});

test('reads the displayed value of the pixel it names, also on the edges of pixels', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  const pane = page.locator('.qiv-pane').first();
  const box = await pane.boundingBox();
  // zoomed on the dark square's left edge (x = 100)
  await page.mouse.move(box.x + box.width * 100 / 512, box.y + box.height * 120 / 384);
  for (let i = 0; i < 4; i++) await page.keyboard.press('+');
  await expect.poll(() => zoom(page)).toBeGreaterThan(300);
  await page.waitForTimeout(1000);
  const readout = page.locator('.qiv-readout');
  const values = /new image (\d+) (\d+) (\d+) RGB;10 display (\d+) (\d+) (\d+)/;
  // across the edge, a fraction of a pixel at a time: the image's values (10-bit, 4x) are those of the color shown
  for (let dx = -12; dx <= 12; dx += 1.3) {
    await page.mouse.move(box.x + box.width * 100 / 512 + dx, box.y + box.height * 120 / 384 + dx / 3);
    await expect(readout).toContainText(values);
    const [, r, g, b, dr, dg, db] = (await readout.textContent()).match(values).map(Number);
    expect([dr, dg, db], `at ${dx}`).toEqual([r / 4, g / 4, b / 4]);
  }
});

test('shows one set of values for 8-bit images', async ({ page }) => {
  await setup(page, { eight_bit: true });
  await expect(page.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  // zoomed out, the screen blends the pixels with their neighbors: their displayed values differ a bit
  const box = await page.locator('.qiv-pane').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.45);
  const readout = page.locator('.qiv-readout');
  await expect(readout).toContainText(/x \d+ y \d+ new/);
  const [x, y] = (await readout.textContent()).match(/x (\d+) y (\d+)/).slice(1).map(Number);
  // the image's values: the gradient's
  await expect(readout).toContainText(`new ${x >> 1} ${y >> 1} 128 ref ${x >> 1} ${y >> 1} 128`);
  await expect(readout).not.toContainText('display');
  await expect(readout).not.toContainText('RGB');
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
  // a tall screen (browsers don't resize a window in full screen)
  await page.setViewportSize({ width: 1280, height: 1024 });
  const before = await page.locator('.qiv-stage').boundingBox();
  await page.getByRole('button', { name: 'Full screen (f)' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('qiv'))).toBe(true);
  // the images take the screen
  await expect.poll(async () => (await page.locator('.qiv-stage').boundingBox()).height).toBeGreaterThan(before.height);
  await page.getByRole('radio', { name: 'Wipe' }).click();
  await expect(page.getByRole('separator', { name: 'Wipe' })).toBeVisible();
  // on a tall screen, the difference goes under the images, where they're larger than in a row
  await page.getByRole('radio', { name: 'Difference' }).click();
  const diff = page.locator('.qiv-diff-between');
  await expect(diff).toBeVisible();
  await expect.poll(async () => (await diff.boundingBox()).y).toBeGreaterThan((await page.getByRole('button', { name: /^new 512×384/ }).boundingBox()).y + 300);
  await page.getByRole('button', { name: 'Exit full screen (f or Esc)' }).click();
  // in the card, in a row
  await expect.poll(async () => Math.abs((await diff.boundingBox()).y - (await page.locator('.qiv-pane').first().boundingBox()).y)).toBeLessThan(2);
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

  // on another page, nothing is compared until users ask
  await navigate(page, `/${project}/commit/ref?reference=new&selected_views=output-list`);
  const other = page.locator('.output-card[data-output-id="200"]');
  await expect(other.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator('.qiv-region')).toHaveCount(0);
  expect(diff_requests).toHaveLength(3);
  // back on the page, what was found shows again
  await page.goBack();
  await expect(first.locator('.qiv-region').first()).toContainText('#1 · 30.0%');
  expect(diff_requests).toHaveLength(3);
});

test('logged out: says to sign in for the images\' own values and to find where they differ', async ({ page }) => {
  const { pixel_requests, diff_requests } = await setup(page, { runs: ['A', 'B'], differences: { A: 0.3 }, signed_in: false });
  const first = page.locator('.output-card[data-output-id="100"]');
  await expect(first.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await expect(first.locator('.qiv-readout')).toContainText("Sign in (in the sidebar) to read the images' own values");
  await first.getByRole('button', { name: 'Regions of interest' }).click();
  // no search over all the runs
  await expect(page.getByRole('menuitem', { name: /in all 2 runs/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Where they differ: perceptual' }).click();
  await expect(first.locator('.qiv-regions')).toContainText('Sign in (in the sidebar) to find where the images differ');
  // hovering shows the displayed values only, without asking the server
  await first.locator('.qiv-stage').hover();
  await expect(first.locator('.qiv-readout')).toContainText('x ');
  expect(pixel_requests).toHaveLength(0);
  expect(diff_requests).toHaveLength(0);
});

test('says which runs it compares, and which wait for their turn', async ({ page }) => {
  await setup(page, { runs: ['A', 'B', 'C', 'D', 'E'], differences: { A: 0.3 }, diff_delay: 1500 });
  const first = page.locator('.output-card').first();
  await expect(first.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await first.getByRole('button', { name: 'Regions of interest' }).click();
  await page.getByRole('menuitem', { name: 'Where they differ, in all 5 runs…' }).click();
  const dialog = page.getByRole('dialog');
  // 3 at a time
  await expect(dialog).toContainText('0 / 5 · comparing 3');
  await expect(dialog.locator('tbody tr', { hasText: 'comparing…' })).toHaveCount(3);
  await expect(dialog.locator('tbody tr', { hasText: 'waiting' })).toHaveCount(2);
  await expect(dialog).toContainText('3 / 5 · comparing 2');
  await expect(dialog).toContainText('5 / 5 · 4 identical');
});

// The labels of a card's images, from left to right
const labelsOf = async card => {
  const labels = await card.locator('.qiv-stage .qiv-label:not(.qiv-label-diff)').evaluateAll(elements => elements
    .filter(e => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden')
    .map(e => [e.getBoundingClientRect().x, e.textContent.replace(/\d+×\d+$/, '').trim()]));
  return labels.sort((a, b) => a[0] - b[0]).map(([, text]) => text);
};

test('swaps or flips the images of every viewer of the page', async ({ page }) => {
  await setup(page, { runs: ['A', 'B'] });
  const [first, second] = [100, 101].map(id => page.locator(`.output-card[data-output-id="${id}"]`));
  await expect(second.getByRole('button', { name: /^new 512×384/ })).toBeVisible();
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
  // t over one viewer swaps them all
  await first.locator('.qiv-pane').first().hover({ position: { x: 50, y: 50 } });
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(second)).toEqual(['ref', 'new']);
  await expect.poll(() => labelsOf(first)).toEqual(['ref', 'new']);
  // in difference mode, the difference stays in the middle
  await first.getByRole('radio', { name: 'Difference' }).click();
  await expect.poll(() => labelsOf(second)).toEqual(['ref', 'new']);
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
  await expect(second.locator('.qiv-diff-between')).toBeVisible();
  // in single mode, a click on one image shows the other in all of them, then the first again
  await first.getByRole('radio', { name: 'Single' }).click();
  await expect.poll(() => labelsOf(second)).toEqual(['new']);
  await first.locator('.qiv-stage').click({ position: { x: 60, y: 60 } });
  await expect.poll(() => labelsOf(second)).toEqual(['ref']);
  await expect.poll(() => labelsOf(first)).toEqual(['ref']);
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(second)).toEqual(['new']);
  await expect.poll(() => labelsOf(first)).toEqual(['new']);
  for (const card of [first, second]) await expect(card.locator('.qiv-diff-pane')).toHaveCount(0);
});

test('takes the keys anywhere on the page, also while scrolling', async ({ page }) => {
  await setup(page, { runs: ['A', 'B'] });
  const [first, second] = [100, 101].map(id => page.locator(`.output-card[data-output-id="${id}"]`));
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
  // the mouse over no viewer, nothing focused
  await page.mouse.move(2, 300);
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(first)).toEqual(['ref', 'new']);
  await expect.poll(() => labelsOf(second)).toEqual(['ref', 'new']);
  await page.keyboard.press('3');
  await expect.poll(() => labelsOf(second)).toEqual(['ref']);
  // after using the toolbar of a viewer
  await second.getByRole('button', { name: /^Show the new image/ }).click();
  await expect.poll(() => labelsOf(second)).toEqual(['new']);
  await page.mouse.move(2, 300);
  await page.mouse.wheel(0, 200);
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(first)).toEqual(['ref']);
  await expect.poll(() => labelsOf(second)).toEqual(['ref']);
  // the arrows scroll the page, they don't change the mode
  await second.getByRole('radio', { name: 'Side by side' }).click();
  await page.keyboard.press('ArrowDown');
  await expect(second.getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true');
});

test('compares with another file of the runs, in every run or one', async ({ page }) => {
  const files = { 'image.png': { st_size: 1000, md5: 'a' }, 'stages/denoise.png': { st_size: 1000, md5: 'b' }, 'notes.txt': { st_size: 10, md5: 'c' } };
  await setup(page, { runs: ['A', 'B'], manifests: { new: files, ref: { ...files, 'image.png': { st_size: 1000, md5: 'd' } } } });
  const [first, second] = [100, 101].map(id => page.locator(`.output-card[data-output-id="${id}"]`));
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
  // the run's other images, found by name
  await first.getByRole('button', { name: /vs ref/ }).click();
  await expect(first.getByRole('option')).toHaveText([/ref/, /stages\/denoise\.png/]);
  await page.keyboard.type('denoise');
  await page.keyboard.press('Enter');
  // every run compares with its own file
  await expect.poll(() => labelsOf(first)).toEqual(['new', 'stages/denoise.png']);
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'stages/denoise.png']);
  await expect(first.locator('.qiv-toast')).toHaveText('Comparing with stages/denoise.png in every run');
  // or only one, to spot-check it
  await second.getByRole('button', { name: /vs stages\/denoise\.png/ }).click();
  await second.getByRole('radio', { name: 'This run' }).click();
  await second.getByRole('option', { name: /ref/ }).click();
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
  await expect.poll(() => labelsOf(first)).toEqual(['new', 'stages/denoise.png']);
  await expect(second.getByRole('button', { name: /vs ref.*this run/ })).toBeVisible();
  // c goes back to the file, in that run only
  await second.locator('.qiv-pane').first().hover({ position: { x: 50, y: 50 } });
  await page.keyboard.press('c');
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'stages/denoise.png']);
  // all the runs again, back to their reference
  await first.getByRole('button', { name: /vs stages\/denoise\.png/ }).click();
  await first.getByRole('radio', { name: 'All runs' }).click();
  await first.getByRole('option', { name: /ref/ }).click();
  await expect.poll(() => labelsOf(first)).toEqual(['new', 'ref']);
  await expect.poll(() => labelsOf(second)).toEqual(['new', 'ref']);
});

test('runs a blind test: shuffled, called A and B, then revealed', async ({ page }) => {
  // the test's seed: the first and third viewers show the reference first, the second doesn't
  await page.addInitScript(() => { Math.random = () => 0.25; });
  await setup(page, { runs: ['A', 'B', 'C'] });
  const cards = [100, 101, 102].map(id => page.locator(`.output-card[data-output-id="${id}"]`));
  await expect(cards[1].getByRole('button', { name: /^new 512×384/ })).toBeVisible();

  // from the toolbar, or h
  await cards[0].getByRole('button', { name: 'Blind test' }).click();
  for (const card of cards.slice(0, 2)) await expect.poll(() => labelsOf(card)).toEqual(['A', 'B']);
  // nothing tells which is new: names, the values' colors, the swap button
  const pane = cards[1].locator('.qiv-pane').first();
  await pane.hover({ position: { x: 120, y: 100 } });
  const readout = cards[1].locator('.qiv-readout');
  await expect(readout).toContainText(/A image \d+/);
  await expect(readout).not.toContainText(/new|ref\b/);
  await expect(cards[0].getByRole('button', { name: /^Swap/ })).toHaveAttribute('aria-pressed', 'false');

  // swapping keeps the names with the images
  await page.keyboard.press('t');
  await expect.poll(() => labelsOf(cards[1])).toEqual(['B', 'A']);
  await page.keyboard.press('t');
  // toggling, from anywhere on the page: A everywhere, then B, then A
  await page.keyboard.press('3');
  await page.mouse.move(2, 300);
  for (const [i, expected] of [['A'], ['B'], ['A']].entries()) {
    if (i > 0) await page.keyboard.press('t');
    for (const card of cards.slice(0, 2)) await expect.poll(() => labelsOf(card)).toEqual(expected);
  }
  await page.keyboard.press('1');

  // which was which
  await cards[1].getByRole('button', { name: 'Reveal' }).click();
  await expect.poll(() => labelsOf(cards[0])).toEqual(['ref · A', 'new · B']);
  await expect.poll(() => labelsOf(cards[1])).toEqual(['new · A', 'ref · B']);
  // done: new first again
  await pane.hover({ position: { x: 120, y: 100 } });
  await page.keyboard.press('h');
  await expect.poll(() => labelsOf(cards[0])).toEqual(['new', 'ref']);
  await expect.poll(() => labelsOf(cards[1])).toEqual(['new', 'ref']);
  await expect(cards[0].getByRole('button', { name: 'Blind test' })).toBeVisible();
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
