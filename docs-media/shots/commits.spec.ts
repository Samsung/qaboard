// A project's commits (docs-media/shots.yaml: commits/*), on the inference gateway (examples/serving-latency): the
// commits of every branch grouped by day, main's with the chart of its metrics above them, and the filter box.
import { shot, type Demo, type Locator, type Page, type Ui } from './lib';

const SL = 'serving-latency';
const DAY = 24 * 3600 * 1000;

// A day of the demo story, as the date pickers want it: -42 is six weeks before T0
const day = (d: Demo, offset: number) => new Date(d.t0.getTime() + offset * DAY).toISOString().slice(0, 10);
// When a story commit was authored: `at` in examples/<project>/story.yaml, e.g. -20d 10:30 (UTC)
const at = (d: Demo, days: number, time: string) => `${day(d, days)}T${time}:00Z`;

// The commits' cards, one per day
const days = (page: Page) => page.locator('.bp6-card', { has: page.getByText(/ — \d+ commits?$/) });
const filterBox = (page: Page) => page.locator('.bp6-navbar input[placeholder="Search..."]').first();

// Hovers the point of the first line of a Plotly chart at that date (CommitsEvolution draws a point per commit)
async function hoverPoint(ui: Ui, plot: Locator, date: string) {
  await ui.plots();
  const position = await plot.evaluate((gd, date) => {
    const { data, _fullLayout: layout } = gd as unknown as {
      data: Array<{ x: string[]; y: number[] }>;
      _fullLayout: { xaxis: { _offset: number; d2p(v: string): number }; yaxis: { _offset: number; d2p(v: number): number } };
    };
    const { x, y } = data[0];
    const i = x.findIndex(v => Math.abs(new Date(v).getTime() - new Date(date).getTime()) < 60_000);
    if (i < 0) throw new Error(`no point at ${date}`);
    return { x: layout.xaxis._offset + layout.xaxis.d2p(x[i]), y: layout.yaxis._offset + layout.yaxis.d2p(y[i]) };
  }, date);
  await ui.hover(plot, { position });
}

shot('commits/feed', {
  project: SL,
  // the week of the batcher's crash: main, the queue-policy branch, and the coding agent's cache
  url: d => d.url(SL, 'commits', { from: day(d, -28), to: day(d, -20) }),
  alt: 'The inference gateway\'s commits from all branches, grouped by day: each with its message, author, branch, the '
    + 'median and p99 of its CI batch, and "1 crashed" in red on the batcher change that panics under bursts.',
  caption: 'The commits of every branch, grouped by day, with their CI batch\'s results: here a commit that crashed '
    + 'some runs.',
  actions: async ui => {
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
});

shot('commits/branch-evolution', {
  project: SL,
  url: d => d.url(SL, 'commits/main', { from: day(d, -42), to: day(d, 0) }),
  alt: 'Above main\'s commits, a chart of the median p99 of each commit\'s CI batch over six weeks, falling from over '
    + '10 ms to a few. The point of the int8 commit is hovered: below the chart, it shows as New, the commit before it as Reference.',
  caption: 'A branch\'s page charts a metric over its commits. Hover a point: its commit and the one before show below '
    + 'the chart, a click opens their comparison.',
  actions: async ui => {
    const plot = ui.page.locator('.js-plotly-plot').first();
    // int8 (story.yaml: -38d 02:40), a one-line message: the hover label shows the whole message, over the chart
    await hoverPoint(ui, plot, at(ui.demo, -38, '02:40'));
    await ui.settle();
  },
  target: page => page.locator('.bp6-card', { has: page.locator('.js-plotly-plot') }).first(),
  // flush: the card starts right after the sidebar
  padding: 0,
});

shot('commits/filter', {
  project: SL,
  // the coding agent's shared cache, then its sharded fix (story.yaml: -20d to -14d)
  url: d => d.url(SL, 'commits', { from: day(d, -21), to: day(d, -13) }),
  alt: 'The filter box of the commits page with "cache" typed in: it suggests the agent/result-cache and '
    + 'perf/sharded-cache branches, and "Go to commit: cache"; below, only the commits that mention the cache.',
  caption: 'The filter box narrows down the commits, suggests branches, and goes straight to a commit from its hash.',
  actions: async ui => {
    // Focused, the box opens its suggestions and fetches the branches: a key typed meanwhile can be lost. Open it first,
    // then type at a person's pace, and check what's in the box
    await ui.click(filterBox(ui.page));
    await ui.settle();
    await ui.type(filterBox(ui.page), 'cache', { delayMs: 80 });
    await ui.page.waitForFunction(() => (document.querySelector('.bp6-navbar input[placeholder="Search..."]') as HTMLInputElement | null)?.value === 'cache',
      undefined, { timeout: 5000 });
    await ui.page.locator('.bp6-popover .bp6-menu', { hasText: 'Go to commit' }).waitFor();
    // the caret at the end, nothing selected
    await ui.press('End');
    await ui.settle();
  },
  // the date range and the filter box, its suggestions, and the first two days of commits left
  target: page => [
    page.locator('.bp6-navbar').first(), page.locator('.bp6-popover .bp6-menu', { hasText: 'Go to commit' }), days(page).nth(1),
  ],
  padding: 0,
});

// A project's commits (docs-media/shots.yaml: commits/*): the sidebar's menus.

const DE = 'detection-eval';

shot('commits/milestones-menu', {
  project: DE,
  // the abandoned entropy calibration branch, saved as a private milestone first
  url: d => d.commitUrl(DE, 'entropy-calib', { view: 'table-kpi' }),
  alt: 'The sidebar\'s Milestones menu on the detector\'s commits: the shared milestones kd-1.3 and kd-1.2, each with '
    + 'its branch, commit and author, then a private milestone, entropy-try, on the quant/entropy branch.',
  caption: 'The Milestones menu lists the shared milestones, then your private ones: pick one to compare with.',
  actions: async ui => {
    const { page } = ui;
    // A private milestone stays in the browser: the server must not get one. New milestones start shared
    await page.route('**/api/v1/project/milestones/**', route => route.abort());
    await ui.click(page.locator('button:has(.bp6-icon-star-empty)').first());
    const dialog = page.locator('.bp6-popover', { hasText: 'Milestone Info' });
    await dialog.waitFor();
    const shared = dialog.getByRole('switch', { name: 'Shared' }).or(dialog.locator('input[type="checkbox"]')).first();
    if (await shared.isChecked()) await ui.click(dialog.locator('label', { hasText: 'Shared' }));
    if (await shared.isChecked()) throw new Error('[commits.spec] the milestone would be shared');
    await ui.type(dialog.locator('#text-input'), 'entropy-try');
    await ui.type(dialog.locator('textarea'), 'entropy calibration: a little worse everywhere');
    await ui.click(dialog.getByRole('button', { name: 'Save' }));
    await dialog.waitFor({ state: 'hidden' });
    // the project's commits, without reloading the page (the milestone is in the app's state)
    await ui.click(page.locator('.bp6-menu-item, a', { hasText: /^detector$/ }).or(page.getByText('detector', { exact: true })).first());
    await page.waitForURL(/\/kitefin\/detector\/?(commits)?(\?.*)?$/);
    await ui.settle();
    // "set 1 hour ago": the private milestone was just saved, and "N seconds ago" would change from one capture to the next
    await page.clock.fastForward('01:00:00');
    await ui.hover(page.getByText('Milestones', { exact: true }).first());
    const menu = page.locator('.bp6-popover .bp6-menu', { hasText: 'Select a private milestone' });
    await menu.getByText('entropy-try').waitFor();
    await ui.settle();
  },
  // the sidebar's menu item and the menu
  target: page => [
    page.getByText('Milestones', { exact: true }).first().locator('xpath=ancestor::a[1]'),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Select a private milestone' }),
  ],
  padding: 8,
});
