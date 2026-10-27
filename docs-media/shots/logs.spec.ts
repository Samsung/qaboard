// The commit page's Logs view (docs-media/shots.yaml: logs/*).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { test, type APIRequestContext } from '@playwright/test';
import { clip, shot, type Demo, type Page } from './lib';

const IQ = 'image-quality';

// The camera ISP's one-tile commit: in a single tile, the 113 MP test wall goes over its 3 GB LSF memory limit
shot('logs/lsf-hints', {
  project: IQ,
  login: 'tobias',
  url: d => d.commitUrl(IQ, 'one-tile', { view: 'logs' }),
  // the memory it used is measured when seeding (seed.py: the run's peak, a little over its limit): no number here
  alt: 'The Logs view with the 113 MP test wall\'s run open: tagged "LSF: out of memory", a red summary says the job '
    + 'was killed at its memory limit (TERM_MEMLIMIT), compares the memory it used with the 3072 MB it requested, and '
    + 'says how to ask for more.',
  caption: 'When LSF stops a run, its logs say why, compare what it used with what it asked for, and say what to change.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Open failed runs' }));
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  // the failed run: its row, the LSF summary and the start of its log
  target: page => page.locator('.bp6-collapse', { has: page.getByText(/TERM_MEMLIMIT/) }).locator('xpath=..'),
  padding: 4,
});

// The inference gateway (examples/serving-latency): batcher change batch-overflow writes past a full batch under a
// backlog, and bursty-high panics
const SL = 'serving-latency';
// A run's section in the Logs view: its row and, open, its log
const runSection = (page: Page, input: string) =>
  page.locator('.bp6-collapse', { has: page.locator('.bp6-icon-search, input[placeholder="Search…"]') })
    .locator('xpath=..').filter({ hasText: `profiles/${input}.yaml` }).first();

shot('logs/crash', {
  project: SL,
  login: 'kaito',
  url: d => d.commitUrl(SL, 'batch-overflow', { view: 'logs' }),
  alt: 'The Logs view of the batcher change, its crashed bursty-high run open: searching the log for "panicked" '
    + 'highlights the panic, an index out of bounds in src/batcher.rs at line 163, then its backtrace.',
  caption: 'A crashed run\'s log opens on its last lines; search it to jump to the panic and the line of code it names.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Open failed runs' }));
    await ui.settle();
    const search = runSection(ui.page, 'bursty-high').locator('input[placeholder="Search…"]');
    await ui.type(search, 'panicked');
    await ui.press('Enter');
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 880 });
  },
  target: page => runSection(page, 'bursty-high'),
  padding: 4,
});

// The sharded cache's tune-batching sweep, started by kaito from the web app (story.yaml: cache-sharded), filtered on
// the configuration it picked
shot('logs/batch-commands', {
  project: SL,
  login: 'kaito',
  url: d => d.commitUrl(SL, 'cache-sharded', { view: 'logs', batch: 'tune-batching', filter: 'max_batch:16 max_delay_us:250' }),
  alt: 'The Logs view of the tune-batching sweep: under "Started from QA-Board", the qa batch command kaito\'s tuning '
    + 'request ran, with its grid of max batch and max delay, and the end of its log; then the two runs left by the filter, '
    + 'and the Batch section with the command again.',
  caption: 'A batch started from QA-Board keeps the command it ran and its log, next to its runs\' logs.',
  // from the Logs title to the Batch section
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    await ui.click(ui.page.getByText('qa batch', { exact: true }).first());
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 1260 });
  },
  // the Batch section ends with its command, the same as the submission's
  target: page => [
    page.getByRole('heading', { name: 'Logs', exact: true }),
    page.getByText(/--action-on-existing run/).last().locator('xpath=ancestor::div[.//*[contains(text(), "Show its logs")]][1]'),
  ],
  // the Controls panel's button is on the viewport's edge, 4 px from the sections
  padding: 4,
});

// A run that really runs while the clip records (examples/serving-latency/SPEC.md: logs/live-tail): bursty-high on the
// head of main at T0 (tuned-batching), in its own batch. Its bursts overload the gateway, which logs the requests that
// missed their deadline as errors, every 2 s. It runs this checkout's qa from the example's folder (`uv`; the first
// time, its qa/build.py builds gateway-bench with cargo, about 2 minutes), and shares its results with the demo stack.
// It measures for 2 minutes instead of 8 s (LIVE_SETTINGS), so that it's still running when the clip ends, whatever the
// machine's speed: it's stopped then, and its batch deleted. What it measures changes with every recording: so does the
// clip.
const LIVE = 'live-tail';
// main.py's settings (qa/main.py: DEFAULT_SETTINGS), given as tuning parameters: one long repeat
const LIVE_SETTINGS = JSON.stringify({ repeats: 1, duration_s: 120 });
const REPO = path.resolve(import.meta.dirname, '..', '..');
let liveRun: ChildProcess | undefined;

function startLiveRun(d: Demo) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|CI_.*|GITHUB_.*|GITLAB_.*|QA_.*|QABOARD_.*|VIRTUAL_ENV)$/.test(k)));
  liveRun = spawn('uv', ['run', '-q', '--no-project', '--with-editable', REPO, 'qa', '--share', '--label', LIVE, '--tuning', LIVE_SETTINGS, 'run', '--input', 'profiles/bursty-high.yaml'], {
    cwd: path.join(REPO, 'examples', SL),
    // as the CI of the commit: the run is saved under its sha
    env: { ...env, CI: 'true', GITHUB_SHA: d.sha(SL, 'tuned-batching'), GITHUB_REF: 'refs/heads/main', QABOARD_URL: d.baseUrl, QA_USER: 'adaeze' },
    stdio: 'ignore',
    // its own process group: stopping it stops qa and gateway-bench
    detached: true,
  });
}

// Stops the live run (uv, qa, gateway-bench) and waits until it's gone
async function stopLiveRun() {
  const run = liveRun;
  if (!run?.pid) return;
  if (run.exitCode === null && run.signalCode === null) {
    const exited = new Promise(resolve => run.once('exit', resolve));
    try {
      process.kill(-run.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
    if (run.exitCode === null && run.signalCode === null) {
      try {
        process.kill(-run.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      await exited;
    }
  }
  liveRun = undefined;
}

// Deletes the live batch, with its output files (it's not part of the demo snapshot)
async function deleteLiveBatch(request: APIRequestContext, d: Demo) {
  const commit = await request.get(`${d.baseUrl}/api/v1/commit/${d.sha(SL, 'tuned-batching')}`, { params: { project: d.slug(SL) } });
  const batch = commit.ok() ? (await commit.json()).batches?.[LIVE] : undefined;
  if (!batch?.id) return;
  const login = await request.post(`${d.baseUrl}/api/v1/user/auth/`, { form: { username: 'adaeze', password: 'kitefin-demo' } });
  if (!login.ok()) throw new Error(`[logs.spec] could not log in to delete the ${LIVE} batch: ${login.status()}`);
  const deleted = await request.delete(`${d.baseUrl}/api/v1/batch/${batch.id}/`);
  if (!deleted.ok()) throw new Error(`[logs.spec] could not delete the ${LIVE} batch: ${deleted.status()} ${await deleted.text()}`);
}

test.afterAll(async ({ playwright }) => {
  if (!liveRun) return;
  await stopLiveRun();
  const { demo } = await import('./lib/demo');
  const request = await playwright.request.newContext();
  await deleteLiveBatch(request, demo());
  await request.dispose();
});

clip('logs/live-tail', {
  project: SL,
  url: d => d.commitUrl(SL, 'tuned-batching', { view: 'logs', batch: LIVE }),
  alt: 'The Logs view of a bursty-high run while it runs: its log follows the end as the overloaded gateway prints the '
    + 'requests that missed their deadline and its queue warnings, the error count climbs past a hundred, and a click on '
    + 'it jumps to the first missed deadline.',
  caption: 'While a run runs, its log follows the end; click the error count to jump from error to error.',
  // A real run: its timings, deadlines and request ids change from one recording to the next, and so do how many lines
  // each frame shows (6% of the pixels from one recording to the next). Unchanged unless the page itself changes
  dedupeTolerance: 0.15,
  // 2: the run lasts long enough to be running during the clip (the first recording started after it had ended)
  revision: 2,
  actions: async ui => {
    // gateway-bench, built once per checkout (cargo, about 2 minutes): before the run, which would build it first
    test.setTimeout(900_000);
    execFileSync('uv', ['run', '-q', 'qa/build.py'], { cwd: path.join(REPO, 'examples', SL), stdio: 'ignore', timeout: 600_000 });
    await deleteLiveBatch(ui.page.request, ui.demo);
    startLiveRun(ui.demo);
    // the batch shows once qa has started the run
    const running = ui.page.getByText(/^Running · 1$/);
    for (let attempt = 0; ; attempt++) {
      await ui.page.reload();
      await ui.settle();
      if (await running.isVisible()) break;
      if (attempt === 60) throw new Error(`[logs.spec] the ${LIVE} run didn't start`);
      await ui.page.waitForTimeout(500);
    }
    // its log
    await ui.click(ui.page.getByText('profiles/bursty-high.yaml', { exact: true }).first());
    await ui.page.locator('input[placeholder="Search…"]').first().waitFor();
    // the Logs title right below the commit bar: more of the log shows
    await ui.page.getByRole('heading', { name: 'Logs', exact: true }).evaluate(h => window.scrollBy(0, h.getBoundingClientRect().top - 100));
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  script: async ui => {
    await ui.caption('A running run\'s log follows the end');
    await ui.hold(3500);
    await ui.caption('Missed deadlines count as errors');
    await ui.hold(3500);
    await ui.caption('Click the count to jump to an error');
    await ui.click(ui.page.getByRole('button', { name: /\d+ errors?$/ }).first());
    await ui.hold(2500);
  },
});

// The runs of a batch, one line each (webapp/src/components/BatchLogs.jsx): the camera ISP's one-tile commit, whose
// 113 MP test wall LSF stopped, and its 18 other runs
shot('logs/runs', {
  project: IQ,
  login: 'tobias',
  url: d => d.commitUrl(IQ, 'one-tile', { view: 'logs' }),
  alt: 'The Logs view\'s filters, All · 19, Failed · 1, Running · 0, Successful · 18, then a line per run: the 113 MP '
    + 'test wall first, failed, tagged "LSF: out of memory", then charts and photos, each with its configuration, how '
    + 'long it ran and its buttons.',
  caption: 'Each run on one line: failed runs come first, tagged with why they failed, and the filters above count '
    + 'the runs of each status.',
  actions: async ui => {
    await ui.page.getByText('LSF: out of memory').first().waitFor();
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
  // a box: from the filters to the eighth run, as wide as the list
  target: async page => {
    const box = async (locator: ReturnType<Page['locator']>) => {
      await locator.waitFor();
      const b = await locator.boundingBox();
      if (!b) throw new Error(`[logs/runs] ${locator} has no box`);
      return b;
    };
    const filters = await box(page.getByText(/^All · \d+$/).first());
    const openFailed = await box(page.getByRole('button', { name: 'Open failed runs' }));
    const last = await box(page.getByText('photos/facade.png', { exact: true }).first());
    const x = filters.x - 16;
    const y = filters.y - 12;
    return { x, y, width: openFailed.x + openFailed.width + 24 - x, height: last.y + last.height + 14 - y };
  },
});
