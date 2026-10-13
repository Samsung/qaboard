// The History page (docs-media/shots.yaml: history/*): metrics over a branch's commits, one line per test, and what
// changed in the hovered commit's outputs.
import { shot, type Demo, type Locator, type Ui } from './lib';

const IQ = 'image-quality';
const DAY = 24 * 3600 * 1000;

// A day of the demo story, as the date pickers want it: -42 is six weeks before T0
const day = (d: Demo, offset: number) => new Date(d.t0.getTime() + offset * DAY).toISOString().slice(0, 10);
// When a story commit was authored: `at` in examples/<project>/story.yaml, e.g. -20d 10:30 (UTC)
const at = (d: Demo, days: number, time: string) => `${day(d, days)}T${time}:00Z`;

// In the card of the hovered run, the viewer of its first visualization, and the images in it (new, reference)
const viewer = (scope: Locator) => scope.locator('.output-card [id="0-0"]').first();
const newImage = (scope: Locator) => scope.locator('[id^="image-viewer-"]').first();

// An element's box once it stopped moving: hovering an image shows the pixel values above it, which push it down
async function stableBox(target: Locator) {
  let previous = await target.boundingBox();
  for (let i = 0; i < 20; i++) {
    await target.page().waitForTimeout(150);
    const box = await target.boundingBox();
    if (box && JSON.stringify(box) === JSON.stringify(previous)) return box;
    previous = box;
  }
  if (!previous) throw new Error(`[history.spec] ${target} has no box`);
  return previous;
}

// Clicks a region of interest preset under the viewer, by its label
async function preset(ui: Ui, scope: Locator, label: string) {
  await ui.click(scope.locator('a.bp6-button').filter({ hasText: new RegExp(`^${label}$`) }).first());
  // no focus ring left around the thumbnail
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ui.settle();
}

// Zooms the synced viewers with the mouse wheel, at a point of the new image given in % of its box
async function zoom(ui: Ui, scope: Locator, point: { x: number; y: number }, steps: number) {
  const image = newImage(scope);
  await ui.hover(image, { position: { x: 10, y: 10 } });
  const box = await stableBox(image);
  await ui.wheel(image, -100 * steps, { steps, position: { x: (box.width * point.x) / 100, y: (box.height * point.y) / 100 } });
  await ui.settle();
}

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
