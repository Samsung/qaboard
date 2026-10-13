// Running tests and tuning from the web app (docs-media/shots.yaml: tuning/*), on the object detector
// (examples/detection-eval): its int8 model is tuned with `qa optimize` (the tune-int8 batch of int8-percentile).
// Nothing is sent: these shots fill forms and editors, and the server gets no write.
import fs from 'node:fs';
import path from 'node:path';
import { shot, type Locator, type Page, type Ui } from './lib';

const DE = 'detection-eval';
const REPO = path.resolve(import.meta.dirname, '..', '..');

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
async function openForm(ui: Ui) {
  await readOnly(ui.page);
  await ui.click(ui.page.getByText('Run Tests/Tuning', { exact: true }).or(ui.page.getByText('Run Tests / Tuning', { exact: true })).first());
  await ui.page.getByPlaceholder('my-tuning-experiment').waitFor();
  await ui.settle();
  await ui.type(ui.page.getByPlaceholder('my-tuning-experiment'), 'int8-nms');
  await ui.type(ui.page.getByPlaceholder('my-batch, batch-*'), 'quant-search');
  await ui.settle();
}
const form = (page: Page) => page.locator('.bp6-card', { has: page.getByPlaceholder('my-tuning-experiment') }).first();

shot('tuning/auto-form', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-percentile', { view: 'summary' }),
  alt: 'The Automated tuning tab of the Run Tests / Tuning form, with the int8 model\'s tuning in YAML: 20 evaluations, '
    + 'the solver\'s seed and 8 initial points, then the objective, AP small and mAP, with a small weight on the model size.',
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
  // the tabs and the editor (the demo server can't list the batch's inputs: the examples' inputs aren't on it)
  target: page => [form(page).getByRole('tablist'), form(page).locator('.monaco-editor').last()],
  // flush: the Send button is right below the editor
  padding: 0,
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
