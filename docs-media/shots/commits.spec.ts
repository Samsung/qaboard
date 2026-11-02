// A project's commits (docs-media/shots.yaml: commits/*), on the inference gateway (examples/serving-latency): the
// commits of every branch grouped by day, main's with the chart of its metrics above them, and the filter box.
import { shot, type Demo, type Locator, type Page, type Ui } from './lib';
import { stableBox } from './imageViewer';

const SL = 'serving-latency';
const DAY = 24 * 3600 * 1000;

// A day of the demo story, as the date pickers want it: -42 is six weeks before T0
const day = (d: Demo, offset: number) => new Date(d.t0.getTime() + offset * DAY).toISOString().slice(0, 10);
// When a story commit was authored: `at` in examples/<project>/story.yaml, e.g. -20d 10:30 (UTC)
const at = (d: Demo, days: number, time: string) => `${day(d, days)}T${time}:00Z`;

// The commits' cards, one per day
const days = (page: Page) => page.locator('.bp6-card', { has: page.getByText(/ — \d+ commits?$/) });
const filterBox = (page: Page) => page.locator('.bp6-navbar input[placeholder^="Search commits"]').first();

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
  // a click keeps the point's commit as the reference (CommitsEvolution.jsx: onClick), for the points hovered next
  caption: 'A branch\'s page charts a metric over its commits. Hover a point: its commit and the one before show below '
    + 'the chart; click one to keep it as the reference while you hover others.',
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
    await ui.page.waitForFunction(() => (document.querySelector('.bp6-navbar input[placeholder^="Search commits"]') as HTMLInputElement | null)?.value === 'cache',
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

// When milestones were last updated, as the seed saved them. The snapshot's milestones predate the description of
// their runs (datasets, qa batches): the backend describes them the first time it lists them, and that write sets
// their updated_at to the server's clock (backend/api/milestones.py: list_milestones' backfill), days after T0, the
// captures' clock: menus said "in 5 days". The seed sets updated_at to created_at (docs-media/seed.py).
const asSaved = (milestone: any, t0: Date) =>
  new Date(milestone.updated_at) > t0 ? { ...milestone, updated_at: milestone.created_at } : milestone;

// A personal milestone in a group, and a favorite, without changing the demo's database: in the API's answer only, the
// page loaded again. entropy-try is the entropy calibration commit's CI batch, as commit/milestone saves it (its runs
// are the release's: the same CI batch), kd-1.3 a favorite
async function withEntropyTry(ui: Ui) {
  const { page, demo: d } = ui;
  await page.route('**/api/v1/milestones?*', async route => {
    const response = await route.fetch();
    const body = await response.json() as { milestones: any[] };
    const milestones = body.milestones.map(m => asSaved(m, d.t0));
    const release = milestones.find((m: any) => m.label === 'kd-1.3') ?? milestones[0];
    // story.yaml: entropy-calib, -10d 15:00, saved after its CI batch
    const saved = at(d, -10, '17:00');
    const entropy = {
      ...release, id: 900, label: 'entropy-try', group: 'quant/calibration', shared: false, is_favorite: false, slug: 'entropy-try',
      notes: 'Entropy calibration: a little worse everywhere', commit: d.sha(DE, 'entropy-calib'), branch: 'quant/entropy',
      message: 'feat(quant): try entropy calibration', created_at: saved, updated_at: saved,
    };
    const marked = milestones.map((m: any) => m.id === release?.id ? { ...m, is_favorite: true } : m);
    await route.fulfill({ response, json: { ...body, milestones: [...marked, entropy] } });
  });
  await page.reload();
  await ui.settle();
}

// The sidebar's Milestones menu
const milestonesMenu = (page: Page) => page.getByRole('menu', { name: 'Milestones' });
async function openMilestonesMenu(ui: Ui) {
  await ui.click(ui.page.getByRole('menuitem', { name: /^Milestones/ }).first());
  await milestonesMenu(ui.page).getByText('entropy-try').waitFor();
}

shot('commits/milestones-menu', {
  project: DE,
  url: d => d.url(DE, 'commits'),
  alt: 'The sidebar\'s Milestones menu on the detector\'s commits: a search box, the favorite kd-1.3, then "My '
    + 'milestones" with the releases kd-1.3 and kd-1.2 and, in the group quant / calibration, entropy-try. Each shows its '
    + 'batch, branch, commit and date.',
  caption: 'Your favorites first, then your milestones by group, then the project\'s: pick one to open it.',
  actions: async ui => {
    await withEntropyTry(ui);
    await openMilestonesMenu(ui);
    await ui.settle();
  },
  // the sidebar's menu item and the menu
  target: page => [
    page.getByRole('menuitem', { name: /^Milestones/ }).first(),
    page.getByRole('menu', { name: 'Milestones' }),
  ],
  padding: 8,
});

shot('commits/manage-milestones', {
  project: DE,
  // on a commit page, each milestone can also be the reference
  url: d => d.commitUrl(DE, 'kd-1-3', { reference: 'kd-1-2', view: 'table-kpi' }),
  alt: 'The Milestones table, from Manage milestones…: entropy-try in its group, kd-1.3, a favorite, and kd-1.2, each '
    + 'with notes, batch, runs and datasets, commit and branch, owner and date, and Open and As reference; the releases '
    + 'selected, the footer offers to compare them.',
  caption: 'Manage milestones… lists all the project\'s milestones: sort and search them, open one, use it as the '
    + 'reference, or select two to compare them.',
  actions: async ui => {
    const { page } = ui;
    await withEntropyTry(ui);
    await openMilestonesMenu(ui);
    await ui.click(milestonesMenu(page).getByRole('menuitem', { name: /^Manage milestones/ }));
    const dialog = page.getByRole('dialog', { name: 'Milestones', exact: true });
    await dialog.getByText('entropy-try').waitFor();
    // the two releases: the footer compares them, the most recently updated as new. Blueprint's checkboxes are under
    // their labels
    for (const name of ['kd-1.3', 'kd-1.2'])
      await ui.click(dialog.locator('label.bp6-checkbox', { has: page.getByRole('checkbox', { name: `Select ${name}`, exact: true }) }));
    await dialog.getByText('2 selected').waitFor();
    // no row under the mouse
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // a box: the dialog is centered over the commit bars, that crops to elements leave out (commit/regions-all-runs)
  target: async page => {
    const dialog = await stableBox(page.getByRole('dialog', { name: 'Milestones', exact: true }));
    return { x: dialog.x - 8, y: dialog.y - 8, width: dialog.width + 16, height: dialog.height + 16 };
  },
});

// A project's page, signed in (webapp/src/CiCommitList.jsx, BatchList.jsx): your batches first, everyone's commits
// one click away, and the density of the commit lists.

const IQ = 'image-quality';

// Preferences follow users on the server (webapp/src/stores/prefsSync.js). A shot that needs one, e.g. the compact
// commit list, gets it in the API's answer, and what the page sends back never reaches the server: the persona's
// preferences stay as the demo has them for the other shots. The page is loaded again with it.
async function withPreferences(ui: Ui, preferences: Record<string, unknown>) {
  await ui.page.route('**/api/v1/user/preferences', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, json: {} });
    const response = await route.fetch();
    const body = await response.json() as { preferences?: Record<string, unknown> };
    await route.fulfill({ response, json: { ...body, preferences: { ...body.preferences, ...preferences } } });
  });
  await ui.page.reload();
  await ui.settle();
}

shot('commits/compact', {
  project: SL,
  // two weeks of everyone's commits: the allocators, the queue policies, the batcher's crash and the agent's cache
  url: d => d.url(SL, 'commits', { from: day(d, -31), to: day(d, -20), scope: 'all', view: 'commits' }),
  alt: 'The inference gateway\'s commits in the compact list: one line each, grouped by day, in aligned columns: a '
    + 'status icon, hash, message, branch, committer, date, the CI batch\'s average p99 and its runs; the batcher change '
    + 'that crashed shows a red icon and "1 failed".',
  caption: 'Compact puts each commit on one line, in columns that line up from one day to the next: hover a cell for '
    + 'what doesn\'t fit.',
  actions: async ui => {
    await withPreferences(ui, { commitListDensity: 'compact' });
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // from the Comfortable / Compact switch to the fifth day
  target: page => [page.getByRole('radiogroup', { name: 'Commit list density' }), days(page).nth(4)],
  padding: 8,
});

shot('commits/yours', {
  project: IQ,
  url: d => d.url(IQ),
  alt: 'The camera ISP project signed in as Ines, Yours selected: the latest commit on main, its CI batch still '
    + 'running, then her tune-denoise and ines-halo batches, both ticked, and "Compare tune-denoise with ines-halo".',
  caption: 'Signed in, a project\'s page starts with the batches you started. Tick two of them to compare them.',
  actions: async ui => {
    const { page } = ui;
    for (const batch of ['tune-denoise', 'ines-halo'])
      await ui.click(page.locator('label.bp6-checkbox', { has: page.getByRole('checkbox', { name: `Select ${batch} to compare it` }) }));
    await page.getByRole('button', { name: 'Compare', exact: true }).waitFor();
    // no focus ring left on the checkbox
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // from the Yours / Everyone switches to the batches' card
  target: page => [
    page.getByText(/in these dates/).first(),
    page.locator('.bp6-card', { hasText: 'Latest on main' }).first(),
    page.locator('.bp6-card', { has: page.getByRole('list', { name: 'Batches' }) }).first(),
  ],
  padding: 16,
});
