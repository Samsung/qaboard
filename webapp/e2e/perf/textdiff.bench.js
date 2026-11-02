// Performance benchmark: diffing big text files (e.g. logs) with the reference run's.
//   npm run build && BENCH_TEXT_LINES=100000 BENCH_FILE_DELAY=500 npm run bench -- textdiff
// Times are from the click that opens the view to the first lines of Monaco's diff editor.
// BENCH_BUILD_DIR=path/to/other/build compares with another build.
import { performance } from 'node:perf_hooks';
import { test } from '@playwright/test';
import { make_api, project } from './fixtures';

const nb_lines = Number(process.env.BENCH_TEXT_LINES ?? 50_000);
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
// how long the server takes to send each text file: big files take a while
const file_delay = Number(process.env.BENCH_FILE_DELAY ?? 500);
const api = make_api({ nb_outputs: 1, nb_commits: 2 });
const api_keys = Object.keys(api).sort((a, b) => b.length - a.length);

// Log-like lines; the reference differs every 1000 lines
const make_log = reference => Array.from({ length: nb_lines }, (_, i) =>
  `[2026-09-01 10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}] INFO step ${i}: loss=${(1 / (i + 1)).toFixed(6)} ${reference && i % 1000 === 0 ? 'changed' : 'ok'}`
).join('\n');
const logs = { new: make_log(false), reference: make_log(true) };

const setup = async page => {
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const key = api_keys.find(k => pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  // output ids are `${seed}0`: 10 for the new commit, 20 for the reference
  await page.route('**/s/outputs/**', route => {
    const { pathname } = new URL(route.request().url());
    const is_reference = pathname.startsWith('/s/outputs/20/');
    if (pathname.endsWith('/manifest.outputs.json'))
      return route.fulfill({ json: { 'output.txt': { st_size: logs.new.length, md5: is_reference ? 'ref' : 'new' } } });
    if (pathname.endsWith('/output.txt'))
      return new Promise(resolve => setTimeout(resolve, file_delay))
        .then(() => route.fulfill({ body: is_reference ? logs.reference : logs.new, contentType: 'text/plain' }));
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('**/s/**', route => route.fallback());
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '2999-01-01'));
};

const diff_shown = page => page.locator('.monaco-diff-editor .editor.modified .view-line').first().waitFor({ timeout: 120_000 });

const scenarios = {
  // a text visualization: the diff shows with the card
  visualizations: async page => {
    await page.getByText('Visualizations').first().click();
    await diff_shown(page);
  },
  // Output Files: users click a file in the tree to see its diff
  'output files': async page => {
    await page.getByText('Output Files').first().click();
    await page.locator('.bp6-tree-node-label', { hasText: 'output.txt' }).first().click();
    await diff_shown(page);
  },
};

for (const [name, open] of Object.entries(scenarios))
  test(`${name}: text diff of ${nb_lines} lines`, async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const times = [];
    for (let i = 0; i < repeats; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await setup(page);
      await page.goto(`/${project}/commit/c0000?reference=c0001`);
      await page.getByText(/^PSNR/).first().waitFor({ timeout: 60_000 });
    // the Summary's plots load Plotly: don't count it
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
      const t0 = performance.now();
      await open(page);
      times.push(Math.round(performance.now() - t0));
      await context.close();
    }
    console.log(`${name}: text diff of ${nb_lines} lines: ${times.join(', ')} ms (median ${times.sort((a, b) => a - b)[Math.floor(times.length / 2)]})`);
  });
