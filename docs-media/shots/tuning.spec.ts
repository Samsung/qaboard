// Running tests and tuning from the web app (docs-media/shots.yaml: tuning/*), on the object detector
// (examples/detection-eval): its int8 model is tuned with `qa optimize` (the tune-int8 batch of int8-percentile).
// Only tuning/launch-to-analysis sends something: its batch runs in the backend's container, and is deleted afterwards.
// The others fill forms and editors, and the server gets no write.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { clip, shot, type Locator, type Page, type Ui } from './lib';

const DE = 'detection-eval';
const REPO = path.resolve(import.meta.dirname, '..', '..');

// The server lists the detector's tests from its inputs: the example's, linked into the commits' artifacts while these
// shots are captured (docs-media/demo/webapp_runs.py). tuning/launch-to-analysis also builds what its runs need.
function webappRuns(...args: string[]) {
  execFileSync('uv', ['run', '-q', path.join(REPO, 'docs-media', 'demo', 'webapp_runs.py'), ...args, '--project', DE], {
    stdio: 'inherit', timeout: 900_000,
  });
}
// The experiment the forms fill, and the launch starts
const EXPERIMENT = 'int8-nms';
const GRID = '{\n  "score_threshold": [0.2, 0.3],\n  "nms_iou": [0.5, 0.7]\n}';
const deleteLaunched = () => webappRuns('delete-batch', '--commit', 'int8-percentile', '--label', EXPERIMENT);
test.beforeAll(() => webappRuns('link'));
test.afterAll(() => {
  deleteLaunched();
  webappRuns('unlink');
});

// Only reads reach the server: no batch is started, no batch file saved
async function readOnly(page: Page) {
  await page.route('**/api/v1/**', route => {
    const request = route.request();
    const allowed = request.method() === 'GET' || /\/api\/v1\/(tests\/group|user\/)/.test(request.url());
    return allowed ? route.fallback() : route.abort();
  });
}

// Replaces what's in a Monaco editor, as a paste would (typing would auto-indent each line)
async function paste(ui: Ui, editor: Locator, text: string) {
  const { page } = ui;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ui.demo.baseUrl).origin });
  await page.evaluate(text => navigator.clipboard.writeText(text), text);
  // the editor loads lazily, and shows its first value before it takes input
  const firstLine = text.split('\n')[0];
  await editor.locator('.view-lines').waitFor();
  await ui.settle();
  for (let attempt = 1; ; attempt++) {
    await ui.click(editor);
    // the keys go to the editor once it has the focus
    await editor.evaluate(e => new Promise<void>(resolve => {
      const check = () => (e.contains(document.activeElement) ? resolve() : requestAnimationFrame(check));
      check();
    }));
    await ui.press('Control+a');
    await ui.press('Control+v');
    // the paste lands a moment later, then the editor shows the end of the text
    const lastLine = text.trim().split('\n').at(-1)!.trim();
    await editor.locator('.view-line', { hasText: lastLine }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    // back to the top: the editor only draws the lines in view
    await ui.press('Control+Home');
    await ui.settle();
    const first = await editor.locator('.view-line').first().innerText();
    if (first.replace(/\s+/g, ' ').trim() === firstLine.replace(/\s+/g, ' ').trim()) break;
    if (attempt === 3) throw new Error(`[tuning.spec] the editor starts with "${first}" after pasting`);
  }
}

// The Available Tests editor, and its side panel
const editor = (page: Page) => page.locator('.monaco-editor').first();

shot('tuning/available-tests', {
  project: DE,
  url: d => d.commitUrl(DE, 'kd-1-3', { view: 'groups' }),
  alt: 'The Available Tests editor on Arjun\'s private batches: two int8 batches, the second\'s configs line indented one '
    + 'space too far and underlined in red; under the editor, the error with its line, at the top "1 error" and '
    + '"Unsaved changes"; on the side, the Batches panel lists int8-indoor and int8-small.',
  caption: 'Edit your private batches, or the shared ones, in the browser: mistakes show as you type, before you save.',
  actions: async ui => {
    await readOnly(ui.page);
    await paste(ui, editor(ui.page), [
      '# qa batch int8-indoor, or every int8 batch: qa batch "int8-*"',
      'int8-indoor:',
      '  inputs:',
      '  - slices/indoor',
      '  configs: [int8, size-320]',
      '',
      'int8-small:',
      '  inputs:',
      '  - slices/small-objects',
      '   configs: [int8, size-320]',
      '',
    ].join('\n'));
    await ui.page.getByText(/^1 error$/).waitFor();
    // the mouse away from the editor, the caret hidden by the capture
    await ui.cursor.moveTo({ x: 700, y: 880 });
    await ui.settle();
  },
  // the view, without the commit bar and the sidebar: its title and tabs, the editor and its problems, the side panel
  target: page => [
    page.locator('h1, h2, h3', { hasText: /^Available Tests$/ }),
    page.getByRole('list', { name: 'Problems' }),
    page.getByRole('list', { name: 'Batches' }).locator('xpath=ancestor::div[contains(@class, "bp6-section")][1]'),
  ],
  padding: 8,
});

// The form of Run Tests / Tuning, on the commit where the int8 model was tuned. Opened from the sidebar: the form
// takes the logged-in user when it opens
async function openForm(ui: Ui, { send = false } = {}) {
  if (!send) await readOnly(ui.page);
  await ui.click(ui.page.getByText('Run Tests/Tuning', { exact: true }).or(ui.page.getByText('Run Tests / Tuning', { exact: true })).first());
  await ui.page.getByPlaceholder('my-tuning-experiment').waitFor();
  await ui.settle();
  await ui.type(ui.page.getByPlaceholder('my-tuning-experiment'), EXPERIMENT);
  await ui.type(ui.page.getByPlaceholder('my-batch, batch-*'), 'quant-search');
  await ui.settle();
}
const form = (page: Page) => page.locator('.bp6-card', { has: page.getByPlaceholder('my-tuning-experiment') }).first();
// The form's button: "Start 8 runs", "Start auto-tuning"
const start = (page: Page) => form(page).getByRole('button', { name: /^Start (auto-tuning|\d+ runs?|runs)$/ });

shot('tuning/auto-form', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { view: 'summary' }),
  alt: 'The Automated tuning tab of the Run Tests / Tuning form, with the int8 model\'s tuning in YAML: 20 evaluations, '
    + 'the solver\'s seed and 8 initial points, then the objective, AP small and mAP; the Start auto-tuning button below.',
  caption: 'Automated tuning searches the parameters with `qa optimize`: describe the search space and the objective in YAML.',
  // tall enough that the Controls panel's button, halfway down the screen, is below the editor
  viewport: { width: 1440, height: 1600 },
  actions: async ui => {
    await openForm(ui);
    await ui.click(ui.page.getByRole('tab', { name: 'Automated tuning' }));
    await ui.settle();
    // examples/detection-eval/qa/tune-int8.yaml, without its header (how to run it from a terminal)
    const yaml = fs.readFileSync(path.join(REPO, 'examples/detection-eval/qa/tune-int8.yaml'), 'utf8');
    await paste(ui, form(ui.page).locator('.monaco-editor').last(), yaml.slice(yaml.indexOf('evaluations:')));
    // no caret, no highlighted word
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.cursor.moveTo({ x: 1400, y: 1550 });
    await ui.settle();
  },
  // the tabs, the editor and the Start button
  target: page => [form(page).getByRole('tablist'), start(page)],
  padding: 8,
});

// The Available Tests view's "Which tests run?": the commit's ci batch, as `qa batch ci` would run it on this commit
shot('tuning/which-tests-run', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { view: 'groups' }),
  alt: 'The "Which tests run?" panel over the Available Tests view: the ci batch resolves to 8 tests on 4 inputs, the '
    + 'indoor, outdoor, warehouse and small-objects slices, each with the fp32 and the int8 model at size 320.',
  caption: 'Check which tests a batch runs on this commit, with all the batch files: its inputs and their configurations.',
  actions: async ui => {
    await readOnly(ui.page);
    await ui.click(ui.page.getByRole('button', { name: /Check any batch or pattern/ }));
    await ui.type(ui.page.getByRole('textbox', { name: 'Batch to check' }), 'ci');
    await ui.press('Enter');
    await ui.page.getByText(/^8 tests$/).waitFor();
    await ui.cursor.moveTo({ x: 1400, y: 540 });
    await ui.settle();
  },
  // the whole window: the drawer over the view, down to the end of the list
  viewport: { width: 1440, height: 560 },
});

// Manual tuning: a grid over the detector's score threshold and NMS IoU, on the 2 slices of quant-search
async function fillGrid(ui: Ui) {
  await ui.click(ui.page.getByRole('tab', { name: 'Manual tuning' }));
  await ui.settle();
  await paste(ui, form(ui.page).locator('.monaco-editor').last(), GRID);
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await form(ui.page).getByText(/^8 total runs/).waitFor();
}

shot('tuning/manual-form', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { view: 'summary' }),
  alt: 'The Run Tests / Tuning form: experiment int8-nms on the quant-search batch (2 tests), the Manual tuning tab '
    + 'with a grid of score_threshold 0.2 and 0.3 by nms_iou 0.5 and 0.7, "Explores 4 combinations", "8 total runs", '
    + 'and the Start 8 runs button.',
  caption: 'Run a batch with other parameters: here every combination of 2 score thresholds and 2 NMS IoUs, 8 runs.',
  viewport: { width: 1440, height: 1500 },
  actions: async ui => {
    await openForm(ui);
    await fillGrid(ui);
    await ui.cursor.moveTo({ x: 1400, y: 1450 });
    await ui.settle();
  },
  // from the batch's label to the Start button
  target: page => [
    form(page).getByText('Batch label', { exact: false }).first(),
    start(page),
  ],
  // not the callout above
  padding: 8,
});

// A real launch: the grid above runs in the backend's container (8 runs of the int8 model, about a minute, cut from the
// clip), then its Analysis. It needs the detector's inputs and models (webapp_runs.py build: the first time, a few
// minutes). The batch is deleted afterwards: it isn't part of the demo snapshot. Accuracy metrics are the same from
// one recording to the next, latency isn't: the Analysis plots move a little.
clip('tuning/launch-to-analysis', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { view: 'summary' }),
  alt: 'The Run Tests / Tuning form with a grid of score_threshold by nms_iou on quant-search, 8 runs: Start 8 runs launches it. '
    + 'Then its batch, int8-nms, is picked, and its Analysis shows the runs in parallel coordinates.',
  caption: 'Start a sweep from the browser, then compare its runs in the Analysis view.',
  dedupeTolerance: 0.01,
  actions: async ui => {
    test.setTimeout(1_200_000);
    webappRuns('build');
    deleteLaunched();
    await openForm(ui, { send: true });
    await fillGrid(ui);
    // from the batch's name to the Start button, below the commit bars
    await form(ui.page).getByText('Batch of inputs+configurations').evaluate(e => window.scrollBy(0, e.getBoundingClientRect().top - 170));
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  script: async ui => {
    const { page } = ui;
    await ui.caption('A grid of 2 parameters: 8 runs');
    await ui.hold(1500);
    await ui.caption('Start runs it on this commit');
    const launched = page.waitForResponse(r => /\/api\/v1\/commit\/[0-9a-f]+\/batch/.test(r.url()) && r.request().method() === 'POST', { timeout: 600_000 });
    await ui.click(start(page));
    // the runs, cut from the clip
    const response = await launched;
    if (!response.ok()) throw new Error(`[tuning.spec] the batch failed: ${response.status()} ${(await response.text()).slice(-2000)}`);
    await ui.settle();
    // the page reloads the commit 1 s later
    await ui.hold(1500);
    await ui.caption('Pick its batch');
    const picker = page.locator('.bp6-navbar-group', { has: page.locator('input#filter-new-input') })
      .getByRole('button', { name: /^Batch:/ });
    await ui.click(picker);
    await ui.click(page.locator('.bp6-popover .bp6-menu-item', { hasText: EXPERIMENT }).first());
    await ui.caption('Its Analysis compares the runs');
    await ui.click(page.getByText(/^(Tuning )?Analysis$/).first());
    // from its title: the page kept the form's scroll
    await page.evaluate(() => window.scrollTo(0, 0));
    await ui.plots({ timeout: 60_000 });
    await ui.hold(3500);
  },
});

// The tune-int8 experiment: `qa optimize`, 20 evaluations of the quant-search batch (int8 at 320 px on outdoor and
// small-objects), the objective is -(AP small + mAP) + 0.005 per MB (examples/detection-eval/qa/tune-int8.yaml)
const section = (page: Page, heading: string) => page.locator('h4', { hasText: heading }).first();

shot('tuning/analysis', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { batch: 'tune-int8', view: 'optimization' }),
  alt: 'The Analysis of the tune-int8 experiment: the best parameters found at iteration 10 of 20 (percentile 99.999, '
    + 'nothing kept in fp32, score 0.2, NMS 0.4) with their mAP, AP small and model size; parallel coordinates of the 20 '
    + 'iterations; the convergence of the objective.',
  caption: 'The Analysis of an automated tuning: the best parameters, every iteration in parallel coordinates, and how '
    + 'the search converged.',
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    await ui.plots();
    await ui.cursor.moveTo({ x: 1420, y: 1250 });
    await ui.settle();
  },
  // from the best parameters down to the convergence plot
  target: page => [
    page.locator('.bp6-callout', { hasText: 'Best parameters' }),
    section(page, 'Convergence').locator('xpath=following::div[contains(@class, "js-plotly-plot")][1]'),
  ],
  padding: 4,
});

// Tuning experiments (docs-media/shots.yaml: tuning/*): the Analysis view of a batch of runs with different parameters.

const SL = 'serving-latency';

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
