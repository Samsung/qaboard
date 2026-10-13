// The commit page's Logs view (docs-media/shots.yaml: logs/*).
import { shot } from './lib';

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
