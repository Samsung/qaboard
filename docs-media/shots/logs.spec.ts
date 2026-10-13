// The commit page's Logs view (docs-media/shots.yaml: logs/*).
import { shot, type Page } from './lib';

const IQ = 'image-quality';

// The camera ISP's one-tile commit: in a single tile, the 113 MP test wall goes over its 3 GB LSF memory limit
shot('logs/lsf-hints', {
  project: IQ,
  login: 'tobias',
  url: d => d.commitUrl(IQ, 'one-tile', { view: 'logs' }),
  alt: 'The Logs view with the 113 MP test wall\'s run open: tagged "LSF: out of memory", a red summary says the job '
    + 'was killed at its memory limit (TERM_MEMLIMIT), 3113 MB used for 3072 MB requested, and how to ask for more.',
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
