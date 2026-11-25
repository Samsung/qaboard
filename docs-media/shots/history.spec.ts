// The Trends page, formerly History (docs-media/shots.yaml: history/*, the area keeps its name: ids are permanent):
// tests and benchmarks over a branch's commits, then metrics over the commits, one line per test, and what changed in
// the hovered commit's outputs. The shots taken before the rename open its old address, /history, which still works.
import { clip, shot, type Demo, type Locator, type Page, type Ui } from './lib';
import { newImage, preset, stableBox } from './imageViewer';

const IQ = 'image-quality';
const DAY = 24 * 3600 * 1000;

// A day of the demo story, as the date pickers want it: -42 is six weeks before T0
const day = (d: Demo, offset: number) => new Date(d.t0.getTime() + offset * DAY).toISOString().slice(0, 10);
// When a story commit was authored: `at` in examples/<project>/story.yaml, e.g. -20d 10:30 (UTC)
const at = (d: Demo, days: number, time: string) => `${day(d, days)}T${time}:00Z`;

// In the card of the hovered run, the viewer of its first visualization, and the images in it (new, reference)
const viewer = (scope: Locator) => scope.locator('.output-card [id="0-0"]').first();

// Zooms the synced viewers with the mouse wheel, at a point of the new image given in % of its box
async function zoom(ui: Ui, scope: Locator, point: { x: number; y: number }, steps: number) {
  const image = newImage(scope);
  await ui.hover(image, { position: { x: 10, y: 10 } });
  const box = await stableBox(image);
  await ui.wheel(image, -100 * steps, { steps, position: { x: (box.width * point.x) / 100, y: (box.height * point.y) / 100 } });
  await ui.settle();
}

// Where the point at that date is, on the first line of a Plotly chart, or the first whose name has `line` in it
// (CommitsEvolution draws a point per commit, a line per test named after its input)
async function pointAt(ui: Ui, plot: Locator, date: string, line?: string) {
  await ui.plots();
  return plot.evaluate((gd, [date, line]) => {
    const { data, _fullLayout: layout } = gd as unknown as {
      data: Array<{ x: string[]; y: number[]; name?: string }>;
      _fullLayout: { xaxis: { _offset: number; d2p(v: string): number }; yaxis: { _offset: number; d2p(v: number): number } };
    };
    const trace = line === undefined ? data[0] : data.find(t => t.name?.includes(line));
    if (!trace) throw new Error(`no line named ${line}: ${data.map(t => t.name).join(', ')}`);
    const { x, y } = trace;
    const i = x.findIndex(v => Math.abs(new Date(v).getTime() - new Date(date).getTime()) < 60_000);
    if (i < 0) throw new Error(`no point at ${date}`);
    return { x: layout.xaxis._offset + layout.xaxis.d2p(x[i]), y: layout.yaxis._offset + layout.yaxis.d2p(y[i]) };
  }, [date, line] as const);
}

// Hovers the point at that date, on the first line of a Plotly chart or the one named `line`
async function hoverPoint(ui: Ui, plot: Locator, date: string, line?: string) {
  await ui.hover(plot, { position: await pointAt(ui, plot, date, line) });
}

shot('history/image-diff', {
  project: IQ,
  url: d => d.historyUrl(IQ, 'main', { from: day(d, -42), to: day(d, 0), filter: 'photos/facade base linux' }),
  alt: 'PSNR of the facade photo over six weeks of main, a point per commit, with a jump at the merge of the bilateral '
    + 'denoiser. Below, that commit and the one before, and their output images: only the new one outlines the leaves.',
  caption: 'Hover a point to compare its commit\'s outputs with the commit before: the PSNR jumps when the bilateral '
    + 'denoiser is merged, and the leaves get halos.',
  // the chart, the commits and the output images
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    const plot = ui.page.locator('.js-plotly-plot').first();
    const scope = viewer(ui.page.locator('body'));
    // the merge of the bilateral denoiser (story.yaml: merge-bilateral, -20d 10:30), then the hovered commit's run, its
    // output first
    await hoverPoint(ui, plot, at(ui.demo, -20, '10:30'));
    await scope.waitFor();
    await ui.settle();
    // the leaves, where the halos show most (like commit/image-sbs). The commits stay selected, marked on the chart
    await preset(ui, scope, 'Leaves over a window');
    await zoom(ui, scope, { x: 82, y: 42 }, 4);
    await ui.cursor.moveTo({ x: 1000, y: 140 });
    await ui.settle();
    await ui.tiles();
  },
  target: page => [page.getByText('Performance over time', { exact: true }), viewer(page.locator('body'))],
  // flush: the next visualization starts right below the images
  padding: 4,
});


// The inference gateway (examples/serving-latency), main's last two weeks: from the merge of the sharded cache
// (-14d), payload-copy (-9d 02:20) pads every batch to its longest request, which only heavy-tail-high's p99 shows (3 to
// 12 ms), until payload-borrow (-3d 03:40). Before the sharded cache, p99 at 6,000 requests/s swings from 6 to 1,000 ms
// and hides it.
const SL = 'serving-latency';
const lastTwoWeeks = (d: Demo, filter?: string) => d.historyUrl(SL, 'main', { from: day(d, -15), to: day(d, 0), ...(filter ? { filter } : {}) });
// The chart, its title and options
// The History view's title and its card (the title is above the card, like the commit page's views)
const performanceOverTime = (page: Page) => page.locator('h2', { hasText: /^Performance over time/ }).first().locator('xpath=../..');

shot('history/performance-over-time', {
  project: SL,
  // bursty-high's p99 is around 200 ms: its line would flatten the others
  url: d => lastTwoWeeks(d, '-bursty'),
  alt: 'Performance over time on main, the last two weeks: Latency p99, a line per test, and the 12 ms target dashed. '
    + 'One line more than triples and comes back four commits later; hovered, its point at the jump '
    + 'names heavy-tail-high, and the commit below copies payloads into fixed slots.',
  caption: 'A metric over a branch\'s commits, a line per test: hover the jump to see the test and the commit.',
  actions: async ui => {
    const plot = performanceOverTime(ui.page).locator('.js-plotly-plot').first();
    await hoverPoint(ui, plot, at(ui.demo, -9, '02:20'), 'heavy-tail-high');
    await ui.settle();
  },
  // the title and options, the chart, the hovered commit and the one before it, and the hovered run's metrics
  target: page => [
    performanceOverTime(page).getByText('Performance over time', { exact: true }),
    performanceOverTime(page).getByText('SLO miss', { exact: true }).locator('xpath=../..'),
  ],
});

shot('history/relative', {
  project: SL,
  url: d => lastTwoWeeks(d),
  alt: 'The same chart Relative to start: every test\'s p99 as a percentage of its value at the first commit, so that '
    + 'the 200 ms bursty test and the 2 ms steady ones share a scale. Heavy-tail-high climbs to about four times its start for four commits.',
  caption: 'Relative to start puts every test on the same scale, whatever its units: 100 is its value at the first commit.',
  actions: async ui => {
    await ui.click(performanceOverTime(ui.page).locator('label', { hasText: 'Relative to start' }));
    // no focus ring left on the switch
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.settle();
    await ui.plots();
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
  // the title and options, and the chart
  target: page => [performanceOverTime(page).getByText('Performance over time', { exact: true }), performanceOverTime(page).locator('.js-plotly-plot').first()],
  padding: 8,
});

// main's commits in the last two weeks (story.yaml: `at`), from merge-sharded-cache to payload-borrow
const MAIN_COMMITS: Array<[number, string]> = [[-14, '10:02'], [-13, '11:30'], [-10, '09:20'], [-9, '02:20'], [-7, '13:40'], [-6, '10:15'], [-3, '03:40']];

clip('history/find-regression', {
  project: SL,
  url: d => lastTwoWeeks(d, 'heavy-tail-high'),
  alt: 'History filtered on the heavy-tail-high test: the cursor moves along its p99 line and the commits below follow; '
    + 'where the batcher copies payloads into fixed slots, p99 more than triples. A click keeps it as '
    + 'the reference: the commit that borrows payloads again is back near 3 ms.',
  caption: 'Hover along a test\'s line to find the commit that changed it, click to compare later ones with it.',
  // the chart, the commits and the hovered run's latency percentiles
  viewport: { width: 1440, height: 1100 },
  actions: async ui => {
    await ui.plots();
    await ui.cursor.moveTo({ x: 1300, y: 1060 });
  },
  script: async ui => {
    const plot = ui.page.locator('.js-plotly-plot').first();
    const point = async ([days, time]: [number, string], hold: number) => {
      await hoverPoint(ui, plot, at(ui.demo, days, time), 'heavy-tail-high');
      await ui.settle();
      await ui.hold(hold);
    };
    await ui.caption('heavy-tail-high\'s p99 on main, commit by commit');
    for (const commit of MAIN_COMMITS.slice(0, 3)) await point(commit, 900);
    await ui.caption('p99 more than triples: payloads copied to fixed slots');
    await point(MAIN_COMMITS[3], 2400);
    await ui.caption('Click: it stays the reference');
    await ui.click(plot, { position: await pointAt(ui, plot, at(ui.demo, ...MAIN_COMMITS[3]), 'heavy-tail-high') });
    await ui.settle();
    await ui.hold(1200);
    for (const commit of MAIN_COMMITS.slice(4, 6)) await point(commit, 700);
    await ui.caption('Borrowing payloads again brings it back');
    await point(MAIN_COMMITS[6], 2600);
  },
});

// The fleet SDK's tests (examples/software-quality): each run is one test suite in one mode (default, strict)
const SQ = 'software-quality';

shot('history/test-volume', {
  project: SQ,
  // six weeks of main, one line: the sum of the suites' tests over the default-mode runs (strict runs the same tests)
  url: d => d.historyUrl(SQ, 'main', {
    from: day(d, -43), to: day(d, 0), filter: 'default',
    selected_metric: 'tests', breakdown_per_test: 'false', selected_aggregation: 'sum',
  }),
  alt: 'Performance over time on main for six weeks: the sum of Tests over the five suites, default mode. It climbs '
    + 'from 131 as frame, A*, range, registry and reserve tests are written, flat at 249, then jumps to 609 when the '
    + 'codec runs 200 fuzz cases per round trip.',
  caption: 'The number of tests of every suite added up, commit by commit: written tests make steps, fuzz cases a jump.',
  actions: async ui => {
    await ui.plots();
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
  // down to the note under the chart, which starts right under the plot: a crop above it would cut it in half
  target: page => [
    performanceOverTime(page).getByText('Performance over time', { exact: true }),
    performanceOverTime(page).locator('.js-plotly-plot').first(),
    performanceOverTime(page).getByText(/may not be evaluated on the same tests/),
  ],
  padding: 8,
});


// Trends (webapp/src/trends/, the Trends page's first section, "Tests and benchmarks over time"): what the fleet SDK's
// metrics say about how they group (examples/software-quality/qa/metrics.yaml: the tests' counts; qa/main.py: the
// benchmarks), charted without configuration. The page's new address, /<project>/trends/<branch> (/history still works).
// Filtered on the default mode: each suite runs in two modes, and their tests would count twice. Up to the day before
// T0: the CI batch of the last commit (cold-batteries, -0d) is still running, and only half its suites have a report.
const trendsUrl = (d: Demo, query: Record<string, string>) => d.url(SQ, 'trends/main', { filter: 'default', ...query });
const sixWeeks = (d: Demo) => trendsUrl(d, { from: day(d, -43), to: day(d, -1) });
// The trends' sections (webapp/src/trends/Trends.jsx): a total and its parts (Tests), each test, groups (Benchmarks)
const trendsTitle = (page: Page) => page.locator('h2', { hasText: /^Tests and benchmarks over time/ }).first();
const trendsSection = (page: Page, heading: RegExp) => page.locator('section.qa-trends-section', { has: page.locator('h3', { hasText: heading }) }).first();

shot('history/trends-tests', {
  project: SQ,
  url: sixWeeks,
  alt: 'Six weeks of the fleet SDK\'s main, default mode. Tests: a column per commit, passed and skipped stacked, from '
    + '131 to 609 in steps. Below, on their own scale, those not passing: codec failures at the varint fast path, '
    + 'missions failures at the closest robot, a flaky test for weeks. Then the test time.',
  caption: 'Tests per commit, and on their own scale those that didn\'t pass: when tests were written, which commits '
    + 'broke some, and how long a flaky test stayed.',
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    await trendsSection(ui.page, /^Tests$/).locator('svg').first().waitFor();
    await ui.cursor.moveTo({ x: 1430, y: 1290 });
    await ui.settle();
  },
  target: page => [trendsTitle(page), trendsSection(page, /^Tests$/)],
  padding: 8,
});

shot('history/trends-each-test', {
  project: SQ,
  // up to the commit that ignored the robots' battery reserve (story.yaml: closest-robot, -17d 08:20), its fix not merged yet
  url: d => trendsUrl(d, { from: day(d, -43), to: day(d, -17) }),
  alt: 'Each test over the commits, once their reports are read: chips Failing now, Flaky, Slower, Fixed, Added, '
    + 'Removed and Slowest with their counts, Failing now selected. Missions tests of the battery reserve, failing '
    + 'since the closest-robot change, each with a strip of its status per commit.',
  caption: 'Read the commits\' test reports to see each test over time: which fail and since which commit, which are '
    + 'flaky, slower, added or removed.',
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    const section = ui.page.locator('#trends-each-test');
    await ui.click(section.getByRole('button', { name: /^Read the test reports of/ }));
    // a request or more per commit: the progress bar goes, then the table comes
    await section.locator('table').waitFor({ timeout: 60_000 });
    await ui.settle();
    await ui.cursor.moveTo({ x: 1430, y: 1290 });
    await ui.settle();
  },
  target: page => page.locator('#trends-each-test'),
  padding: 8,
});

shot('history/trends-benchmarks', {
  project: SQ,
  url: sixWeeks,
  alt: 'The Benchmarks section, latest against the first commit: how many got better or worse, their geometric mean, '
    + 'which drops at the CRC lookup table, a small chart per group (client, crc, frames, varint), and those '
    + 'that moved, with their first and latest times, change, and the commit where they moved.',
  caption: 'Benchmarks summarized over the same scope, then the ones that moved and where: here the commit that gave '
    + 'the CRC a lookup table.',
  viewport: { width: 1440, height: 1500 },
  actions: async ui => {
    await trendsSection(ui.page, /^Benchmarks/).locator('table').waitFor();
    await ui.cursor.moveTo({ x: 1430, y: 1490 });
    await ui.settle();
  },
  target: page => trendsSection(page, /^Benchmarks/),
  padding: 8,
});
