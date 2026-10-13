// Tuning experiments (docs-media/shots.yaml: tuning/*): the Analysis view of a batch of runs with different parameters.
import { shot, type Locator, type Page, type Ui } from './lib';

const SL = 'serving-latency';

// The section of the Analysis view that starts at this heading, down to its plot
const section = (page: Page, heading: string) => page.locator('h4', { hasText: heading }).first();
const plotAfter = (page: Page, heading: string) => section(page, heading).locator('xpath=following::div[contains(@class, "js-plotly-plot")][1]');

// Hovers the point of a Plotly scatter whose hover text has all these strings in it
async function hoverPointWith(ui: Ui, plot: Locator, texts: string[]) {
  await ui.plots();
  const position = await plot.evaluate((gd, texts) => {
    const { data, _fullLayout: layout } = gd as unknown as {
      data: Array<{ x: number[]; y: number[]; text: string[] }>;
      _fullLayout: { xaxis: { _offset: number; d2p(v: number): number }; yaxis: { _offset: number; d2p(v: number): number } };
    };
    const { x, y, text } = data[0];
    const at = (i: number) => ({ x: layout.xaxis._offset + layout.xaxis.d2p(x[i]), y: layout.yaxis._offset + layout.yaxis.d2p(y[i]) });
    const i = text.findIndex(t => texts.every(s => t.includes(s)));
    if (i < 0) throw new Error(`no point with ${texts.join(', ')} in ${text.join(' | ')}`);
    // Plotly hovers the closest point: when another one almost overlaps it, aim a few pixels away from that one
    const point = at(i);
    const others = x.map((_, j) => at(j)).filter((_, j) => j !== i);
    const closest = others.sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0];
    const distance = closest ? Math.hypot(closest.x - point.x, closest.y - point.y) : Infinity;
    if (distance < 12) {
      const away = distance > 0 ? 4 / distance : 0;
      return { x: point.x + (point.x - closest.x) * away, y: point.y + (point.y - closest.y) * away };
    }
    return point;
  }, texts);
  await ui.hover(plot, { position });
}

// The sharded cache's sweep (examples/serving-latency/story.yaml: cache-sharded, tune-batching): max batch 1, 16 and
// 64 by max delay 0, 250, 1000 and 4000 µs, on steady-high and heavy-tail-high, each the median of 3 repeats. The
// defaults it picked, max batch 16 and 250 µs, are on the frontier of CPU per request and p99.
shot('tuning/frontier', {
  project: SL,
  login: 'kaito',
  url: d => d.commitUrl(SL, 'cache-sharded', {
    batch: 'tune-batching', view: 'optimization',
    query: { selected_metric: 'cpu_per_req', selected_metric2: 'latency_p99', selected_parameter: 'max_delay_us', selected_parameter_2: 'max_batch' },
  }),
  alt: 'The efficient frontier of the tune-batching sweep: one point per configuration of max batch and max delay, CPU '
    + 'per request against p99, colored by max delay. The hovered point, max batch 16 and max delay 250 µs, sits on the '
    + 'lower left edge.',
  caption: 'Each configuration\'s CPU per request against its p99: the defaults picked, max batch 16 and 250 µs of delay, '
    + 'are on the frontier.',
  actions: async ui => {
    // The Analysis view computes the metrics picked above its plots (the project's main metrics): add CPU per request
    const metrics = ui.page.locator('.bp6-tag-input', { hasText: 'Latency p99' }).first();
    await ui.click(metrics.locator('input'));
    await ui.type(metrics.locator('input'), 'CPU per');
    await ui.page.getByRole('menuitem', { name: /CPU per request/ }).first().waitFor();
    await ui.press('Enter');
    await ui.press('Escape');
    await metrics.getByText('CPU per request').waitFor();
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.settle();
    const plot = plotAfter(ui.page, 'Efficient frontier');
    await plot.evaluate(p => window.scrollBy(0, p.getBoundingClientRect().top - 300));
    await ui.settle();
    await hoverPointWith(ui, plot, ['"max_batch":16', '"max_delay_us":250']);
    await ui.settle();
  },
  target: page => [section(page, 'Efficient frontier'), plotAfter(page, 'Efficient frontier')],
});
