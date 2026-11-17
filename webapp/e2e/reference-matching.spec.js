// How runs find their reference run: pairing inputs by name (a register sweep without metadata ids), picking another
// reference run for a run, and two reference shots with the same metadata.id.
import { test, expect } from '@playwright/test';

import { info, tile } from './fixtures/iiif';

const project = 'group/repo';
const qatools_config = { outputs: { visualizations: [{ name: 'Output', path: 'image.png' }] } };

const output = (id, test_input_path, { metadata = {}, psnr = 30, platform = 'linux' } = {}) => ({
  id, platform, configurations: ['base'], extra_parameters: {}, metrics: { psnr }, data: {},
  is_failed: false, is_pending: false, is_running: false, deleted: false,
  created_date: '2026-09-01T10:00:00Z', output_dir_url: `/s/mnt/qaboard/${id}/output`,
  test_input_database: '/mnt/captures', test_input_path, test_input_metadata: metadata,
});
const batch = (id, label, outputs) => ({
  id, label, data: {}, valid_outputs: outputs.length, pending_outputs: 0, running_outputs: 0, failed_outputs: 0, deleted_outputs: 0,
  outputs: Object.fromEntries(outputs.map(o => [o.id, o])),
});
const commit = (hexsha, message, batches) => ({
  id: hexsha, hexsha, project_id: project, branch: 'master', committer_name: 'Alice', message,
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z', parents: [], deleted: false,
  data: { qatools_config }, batches: Object.fromEntries(batches.map(b => [b.label, b])),
});

// A register sweep: both batches ran on captures whose names say the register's value
const scenes = ['street_dusk', 'office_tl84', 'macbeth_d65', 'star_a', 'zone_plate'];
const sweep = commit('sweep', 'Register sweep', [
  batch(1, 'sweep-0x1A=05', [
    ...scenes.map((s, i) => output(100 + i, `sweep/${s}_reg0x1A=05_g4.raw`, { psnr: 31 + i })),
    output(110, 'sweep/ramp_16bit_reg0x1A=05_g8.raw', { psnr: 46 }),
    output(111, 'sweep/night_moon_reg0x1A=05_g4.raw', { psnr: 27 }),
  ]),
  batch(2, 'sweep-0x1A=03', [
    ...scenes.map((s, i) => output(200 + i, `sweep/${s}_reg0x1A=03_g4.raw`, { psnr: 30 + i })),
    output(210, 'sweep/ramp_16bit_reg0x1A=03_g4.raw', { psnr: 45 }),
    // a run on another scene, with the same register value: one name part differs, but it's no comparison
    output(211, 'sweep/office_d65_reg0x1A=05_g4.raw', { psnr: 35 }),
  ]),
]);

// Two sensors: runs compared by metadata.id. The reference has two shots of the Macbeth chart, alike.
const sensors = commit('sensors', 'New sensor', [
  batch(3, 'imx766', [
    output(300, 'imx766/macbeth_d65.raw', { metadata: { id: 'macbeth_d65' }, psnr: 41.8 }),
    output(301, 'imx766/street_dusk.raw', { metadata: { id: 'street_dusk' }, psnr: 31.2 }),
  ]),
  batch(4, 'imx586', [
    output(400, 'imx586/macbeth_d65_unit1.raw', { metadata: { id: 'macbeth_d65', unit: 1 }, psnr: 40.9 }),
    output(401, 'imx586/macbeth_d65_unit2.raw', { metadata: { id: 'macbeth_d65', unit: 2 }, psnr: 41.5 }),
    output(402, 'imx586/street_dusk.raw', { metadata: { id: 'street_dusk' }, psnr: 30.1 }),
  ]),
]);
const commits = { sweep, sensors };
const all_outputs = Object.values(commits).flatMap(c => Object.values(c.batches).flatMap(b => Object.values(b.outputs)));

const scene_image = run => {
  const name = run?.test_input_path ?? '';
  const seed = [...name.replace(/reg0x1A=0\d_|_unit\d|imx\d+\//g, '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const gain = name.includes('=05') ? 1.15 : 1;
  const noise = Math.max(2, (46 - (run?.metrics.psnr ?? 40)) * 3);
  const [r0, g0, b0] = [seed % 200, (seed >> 8) % 200, (seed >> 16) % 200];
  return {
    width: 320, height: 200,
    pixel: (x, y) => {
      const n = ((x * 7919 + y * 104729 + run.id * 31) % 97) / 97 - 0.5;
      const patch = ((x >> 5) + (y >> 5)) % 2 ? 1 : 0.6;
      return [r0, g0, b0].map(v => Math.max(0, Math.min(255, Math.round((40 + v * patch) * gain + n * noise))));
    },
  };
};

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.errors_seen = [];
  page.on('console', msg => msg.type() === 'error' && testInfo.errors_seen.push(msg.text()));
  page.on('pageerror', error => testInfo.errors_seen.push(error.message));
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
  const api = {
    '/api/v1/config': {},
    '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
    '/api/v1/projects': { [project]: { data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 2 } },
    '/api/v1/project': { qatools_config },
    '/api/v1/project/branches': ['master'],
    '/api/v1/milestones': { milestones: [], favorite_groups: [] },
  };
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const id = pathname.match(/^\/api\/v1\/commit\/([a-z]+)$/)?.[1];
    if (id) return route.fulfill({ json: commits[id] });
    const key = Object.keys(api).sort((x, y) => y.length - x.length).find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.route('**/s/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/manifest.outputs.json')) return route.fulfill({ json: { 'image.png': { st_size: 1000, md5: pathname } } });
    return route.fulfill({ status: 404 });
  });
  // each run's image: a scene, brighter with the register's higher value, noisier when its PSNR is lower
  await page.route('**/iiif/2/**', route => {
    const { pathname } = new URL(route.request().url());
    const [identifier, ...request] = pathname.replace(/^\/iiif\/2\//, '').split('/');
    const id = Number(decodeURIComponent(identifier).match(/qaboard\/(\d+)\//)?.[1]);
    const run = all_outputs.find(o => o.id === id);
    const image = scene_image(run);
    if (request.join('/') === 'info.json') return route.fulfill({ json: info(identifier, image) });
    return route.fulfill({ body: tile(request.join('/'), image), contentType: 'image/png' });
  });
});

// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_seen.filter(e => !e.includes('404')), 'errors in the browser console').toEqual([]);
});

const sweep_page = `/${project}/commit/sweep?reference=sweep&batch=sweep-0x1A%3D05&batch_ref=sweep-0x1A%3D03&selected_views=output-list`;

test('pairs runs on other inputs by name', async ({ page }) => {
  await page.goto(sweep_page);
  await expect(page.getByText('no reference').first()).toBeVisible();
  // above the runs: the change that pairs the most runs first, not the scenes that differ
  const matching = page.getByRole('region', { name: 'Configurations' });
  await expect(matching.getByText('7 runs have no reference run.')).toBeVisible();
  await matching.getByRole('button', { name: 'Pair reg0x1A=05 → 03' }).click();
  await expect(page).toHaveURL(/pair=reg0x1A%3D05%7Creg0x1A%3D03/);
  await expect(matching.getByText('Paired by name:')).toBeVisible();
  await expect(page.getByText('↔ reg0x1A=03').first()).toBeVisible();
  // with Undo
  await expect(page.getByText(/5 runs paired by name/)).toBeVisible();
  // the ramp ran with another gain: its name differs by two parts, users pick it
  // cards show their tags once they're on screen
  await page.getByText('ramp_16bit_reg0x1A=05_g8.raw').scrollIntoViewIfNeeded();
  await page.getByText('no reference · 1 similar').click();
  await expect(page.getByRole('dialog', { name: /Compare .*ramp_16bit/ })).toBeVisible();
  await page.getByRole('option', { name: /ramp_16bit_reg0x1A=03_g4/ }).click();
  await expect(page).toHaveURL(/pin=110%3A210/);
  await expect(page.getByText('picked by you', { exact: true })).toBeVisible();
  // back to the default, and undo it
  await matching.getByRole('button', { name: 'Reset to default matching' }).click();
  await expect(page).not.toHaveURL(/pair=|pin=/);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(/pair=.*pin=/);
});

test('says when two reference runs fit equally well, and picks the other for all the runs', async ({ page }) => {
  await page.goto(`/${project}/commit/sensors?reference=sensors&batch=imx766&batch_ref=imx586&selected_views=output-list`);
  const tied = page.getByText('1 of 2');
  await expect(tied).toBeVisible();
  // the run with a single reference run on another input says which, quietly
  await expect(page.getByText('≈ street_dusk')).toBeVisible();
  await tied.click();
  await page.getByText('All runs like this').click();
  await page.getByRole('option', { name: /macbeth_d65_unit2/ }).click();
  await expect(page).toHaveURL(/prefer=meta%3Aunit%3D2/);
  // on the run, and in the rules above the runs
  await expect(page.getByText('unit = 2', { exact: true })).toHaveCount(2);
  await expect(page.getByText('1 of 2')).toHaveCount(0);
});

test('opens the picker from the run menu, even when nothing shows on the run', async ({ page }) => {
  await page.goto(`/${project}/commit/sensors?reference=sensors&batch=imx766&batch_ref=imx766&selected_views=output-list`);
  await expect(page.getByText('1 of 2')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run actions' }).first().click();
  await page.getByRole('menuitem', { name: /Change reference run/ }).click();
  await expect(page.getByRole('dialog', { name: /Compare .* with another reference run/ })).toBeVisible();
  await expect(page.getByText('Same input')).toBeVisible();
});
