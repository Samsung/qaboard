// Performance benchmark: the production build against a large mocked API.
//   npm run build && npm run bench
// Prints a table of medians, and writes them as JSON to $BENCH_OUT if set.
// Each scenario runs in a fresh page. Times are wall-clock milliseconds, "blocking" is the
// main-thread time spent in tasks above 50ms (the Total Blocking Time definition), "script" is
// the time spent running JavaScript (Chrome's ScriptDuration).
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from '@playwright/test';
import { make_api, project } from './fixtures';

const nb_outputs = Number(process.env.BENCH_OUTPUTS ?? 1000);
const nb_commits = Number(process.env.BENCH_COMMITS ?? 300);
const repeats = Number(process.env.BENCH_REPEATS ?? 3);
const api = make_api({ nb_outputs, nb_commits });
const api_keys = Object.keys(api).sort((a, b) => b.length - a.length);
const results = {};

const setup = async page => {
  await page.route('**/api/**', route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const key = api_keys.find(k => pathname.startsWith(k));
    // lists of commits come in pages, like the server's
    if (key === '/api/v1/commits' && searchParams.has('limit')) {
      const limit = Number(searchParams.get('limit'));
      const offset = Number(searchParams.get('offset') ?? 0);
      const has_more = offset + limit < api[key].length;
      return route.fulfill({ json: api[key].slice(offset, offset + limit), headers: { 'X-Has-More': String(has_more) } });
    }
    return route.fulfill({ json: key ? api[key] : {} });
  });
  // the output files cards fetch (manifests...)
  await page.route('**/s/**', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => {
    // the "What's new" dialog would steal the focus
    localStorage.setItem('qaboard.release-notes.last-seen', '2999-01-01');
    window.__long_tasks = [];
    new PerformanceObserver(list => window.__long_tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))))
      .observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return cdp;
};

const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

// Waits until the main thread had no long task for `quiet` ms (at most 60s)
const settle = async (page, quiet = 1000) => {
  await page.waitForFunction(quiet => {
    const last = window.__long_tasks.at(-1);
    const last_end = last ? last.start + last.duration : 0;
    return performance.now() - last_end > quiet;
  }, quiet, { polling: 100, timeout: 60_000 }).catch(() => console.warn('the page did not settle'));
};

const measure = async (page, cdp, action) => {
  await settle(page, 500);
  const before = await metrics(cdp);
  // after a navigation, the page has a new document, with its own clock and long tasks
  const page_t0 = await page.evaluate(() => { window.__same_document = true; return performance.now() });
  const t0 = performance.now();
  await action();
  const time = performance.now() - t0;
  await settle(page);
  const after = await metrics(cdp);
  const blocking = await page.evaluate(page_t0 => {
    const since = window.__same_document ? page_t0 : 0;
    return window.__long_tasks.filter(t => t.start >= since).reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
  }, page_t0);
  return {
    time: Math.round(time),
    blocking: Math.round(blocking),
    script: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    heap_mb: Math.round(after.JSHeapUsedSize / 1e6),
  };
};

const scenarios = {
  'commits list: load': async page => {
    const cdp = await setup(page);
    await page.goto('/');
    return measure(page, cdp, async () => {
      await page.goto(`/${project}/commits`);
      await page.getByText('Commit c0000').first().waitFor({ timeout: 60_000 });
    });
  },
  'commits list: scroll to the end': async page => {
    const cdp = await setup(page);
    await page.goto(`/${project}/commits`);
    await page.getByText('Commit c0000').first().waitFor({ timeout: 60_000 });
    return measure(page, cdp, async () => {
      // pages load as the end of the list comes into view
      while (!await page.getByText(`Commit c${String(nb_commits - 1).padStart(4, '0')}`).count()) {
        await page.mouse.wheel(0, 5000);
        await page.waitForTimeout(50);
      }
    });
  },
  'commit page: load summary': async page => {
    const cdp = await setup(page);
    await page.goto('/');
    return measure(page, cdp, async () => {
      await page.goto(`/${project}/commit/c0000?reference=c0001`);
      await page.getByText('Summary').first().waitFor({ timeout: 60_000 });
      await page.getByText(/^PSNR/).first().waitFor({ timeout: 60_000 });
    });
  },
  'commit page: type a filter': async page => {
    const cdp = await setup(page);
    await page.goto(`/${project}/commit/c0000?reference=c0001`);
    await page.getByText(/^PSNR/).first().waitFor({ timeout: 60_000 });
    // the fixed navbars overlap: focus without clicking
    await page.getByPlaceholder('filter new outputs').focus();
    const typed = 'scene_01';
    let value;
    const result = await measure(page, cdp, async () => {
      await page.keyboard.type(typed, { delay: 30 });
      // the old app lost keystrokes when it was busy
      await page.waitForFunction(typed => document.querySelector('input[placeholder="filter new outputs"]')?.value === typed, typed, { timeout: 30_000 }).catch(() => {});
      value = await page.getByPlaceholder('filter new outputs').inputValue();
    });
    return { ...result, lost_keys: typed.length - value.length };
  },
  'commit page: open the visualizations': async page => {
    const cdp = await setup(page);
    await page.goto(`/${project}/commit/c0000?reference=c0001`);
    await page.getByText(/^PSNR/).first().waitFor({ timeout: 60_000 });
    return measure(page, cdp, async () => {
      await page.getByText('Visualizations').first().click();
      await page.locator('.output-card').nth(10).waitFor({ timeout: 60_000 });
    });
  },
  'commit page: open the metrics table': async page => {
    const cdp = await setup(page);
    await page.goto(`/${project}/commit/c0000?reference=c0001`);
    await page.getByText(/^PSNR/).first().waitFor({ timeout: 60_000 });
    return measure(page, cdp, async () => {
      await page.getByText('Metrics Table').first().click();
      await page.getByText('Quality report').first().waitFor({ timeout: 60_000 });
    });
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  test(name, async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const runs = [];
    for (let i = 0; i < repeats; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      runs.push(await run(page));
      await context.close();
    }
    const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    results[name] = Object.fromEntries(Object.keys(runs[0]).map(k => [k, median(k)]));
  });
}

test.afterAll(() => {
  console.table(results);
  if (process.env.BENCH_OUT)
    fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ nb_outputs, nb_commits, repeats, results }, null, 2));
});
