// The video viewer on the commit page, with real videos, against a mocked API.
// The fixtures are AV1: Playwright's Chromium can't decode H.264.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const qatools_config = { outputs: { visualizations: [{ name: 'Camera', path: 'video.mp4' }] } };

const output = (id, hexsha) => ({
  id, platform: 'linux', configurations: ['base'], extra_parameters: {}, metrics: {}, data: {},
  is_failed: false, is_pending: false, is_running: false, deleted: false,
  created_date: '2026-09-01T10:00:00Z',
  output_dir_url: `/s/mnt/qaboard/${hexsha}/output`,
  test_input_database: '/mnt/database', test_input_path: 'videos/A.mp4', test_input_metadata: {},
});
// the batches need different ids, else the runs are compared with themselves
const commit = (hexsha, batch_id, message) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config },
  batches: { default: {
    id: batch_id, label: 'default', data: {},
    valid_outputs: 1, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
    outputs: { [batch_id]: output(batch_id, hexsha) },
  } },
});

// Longest matching prefix wins
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
  '/api/v1/project': { qatools_config },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commit/new': commit('new', 1, 'New'),
  '/api/v1/commit/ref': commit('ref', 2, 'Reference'),
};

const videos = {
  new: readFileSync(new URL('./fixtures/video-new.mp4', import.meta.url)),
  ref: readFileSync(new URL('./fixtures/video-reference.mp4', import.meta.url)),
};

// Like nginx: with range requests, browsers can seek without downloading everything
const serveVideo = (route, video) => {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
  if (!range) return route.fulfill({ body: video, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' } });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
  return route.fulfill({
    status: 206,
    body: video.subarray(start, end + 1),
    contentType: 'video/mp4',
    headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${video.length}` },
  });
};

const setup = async (page, { manifests }) => {
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  // the runs' files
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    const hexsha = pathname.split('/')[4];
    if (pathname.endsWith('/manifest.outputs.json')) return route.fulfill({ json: manifests[hexsha] ?? {} });
    if (pathname.endsWith('/video.mp4') && videos[hexsha]) return serveVideo(route, videos[hexsha]);
    return route.fulfill({ json: {} });
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

const loaded = video => expect.poll(() => video.evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
const times = page => page.locator('video').evaluateAll(videos => videos.map(v => Math.round(v.currentTime * 1000) / 1000));

test('compares videos frame by frame, in sync', async ({ page }) => {
  await setup(page, { manifests: {
    new: { 'video.mp4': { st_size: videos.new.length, md5: 'new' } },
    ref: { 'video.mp4': { st_size: videos.ref.length, md5: 'ref' } },
  } });
  const video_new = page.getByLabel('New video');
  const video_ref = page.getByLabel('Reference video');
  await loaded(video_new);
  await loaded(video_ref);
  const frame = page.getByLabel('Frame', { exact: true });
  await expect(frame).toHaveText('frame ?');

  // the frame rate is found when we step through frames
  const stage = page.locator('.video-stage');
  await stage.hover();
  await page.keyboard.press('ArrowRight');
  await expect(frame).toHaveText('frame 1 / 100');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await expect(frame).toHaveText('frame 11 / 100');
  await expect.poll(() => times(page)).toEqual([0.46, 0.46]);

  // play and pause: both show the same frame
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(() => times(page)).not.toEqual([0.46, 0.46]);
  await page.waitForTimeout(500);
  await stage.click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect.poll(async () => {
    const [t_new, t_ref] = await times(page);
    return t_new > 0.8 && t_new === t_ref;
  }).toBe(true);

  // wipe: drag the divider
  await page.getByText('Wipe').click();
  const divider = page.locator('.video-wipe');
  await expect(divider).toBeVisible();
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const divider_box = await divider.boundingBox();
  expect(divider_box.x - box.x).toBeCloseTo(box.width * 0.75, -1);

  // zoom on the box drawn only in the new video
  const zoom = async () => parseInt(await page.locator('.video-zoom').textContent());
  const fit = await zoom();
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.72);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await expect.poll(zoom).toBeGreaterThan(3 * fit);
  await expect(page.getByLabel('Pixel')).toHaveText(/x 2[0-5]\d y 1[2-4]\d/);
  await page.keyboard.press('0');

  // the difference shows the box drawn only in the new video
  await page.getByText('Difference').click();
  await expect.poll(() => page.locator('.video-stage canvas').evaluate(canvas => {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const brightest = (x, y, w, h) => Math.max(...context.getImageData(x, y, w, h).data.filter((_, i) => i % 4 !== 3));
    return [canvas.width, brightest(210, 115, 40, 30) > 100, brightest(10, 10, 60, 60) < 40];
  })).toEqual([320, true, true]);
});

test('plays a video without reference', async ({ page }) => {
  // it used to throw "pause is not a function"
  await setup(page, { manifests: {
    new: { 'video.mp4': { st_size: videos.new.length, md5: 'new' } },
    ref: {},
  } });
  const video = page.getByLabel('New video');
  await loaded(video);
  await expect(page.getByLabel('Reference video')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Comparison' })).toHaveCount(0);
  await page.locator('.video-stage').click();
  await expect.poll(() => video.evaluate(v => v.paused)).toBe(false);
  await page.locator('.video-stage').click();
  await expect.poll(() => video.evaluate(v => v.paused)).toBe(true);
});
