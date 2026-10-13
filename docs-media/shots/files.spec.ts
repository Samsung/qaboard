// The file browser (docs-media/shots.yaml: files/*): the results storage served under /s/, on a run's output folder of
// the inference gateway (examples/serving-latency): the coding agent's shared cache, steady-high.
import { clip, shot, type Demo, type Page } from './lib';

const SL = 'serving-latency';
// The CI run's folder: <commit>/output/<platform>/<input> (qaboard/conventions.py)
const runFolder = (d: Demo) => d.filesUrl(SL, 'cache-shared', 'output/linux/profiles-steady-high/');
const header = (page: Page) => page.locator('.fb-header');
const runBar = (page: Page) => page.locator('section.fb-run');
const table = (page: Page) => page.locator('table.fb-table');

// Natural sort shows in a folder of numbered files: the detector's images of a slice, with its detections drawn
// (examples/detection-eval, the merge of the int8 model)
shot('files/browser', {
  project: 'detection-eval',
  url: d => d.filesUrl('detection-eval', 'merge-int8', 'output/7622c337-20/slices-indoor/images/'),
  alt: 'The file browser in the images folder of a detector run: the path as breadcrumbs, the run bar, a filter box, '
    + 'and 25 images sorted naturally, 1.jpg, 2.jpg, then 10.jpg after 9.jpg, with their sizes and dates.',
  caption: 'The file browser sorts names naturally (2 before 10) and shows each file\'s size and date.',
  actions: async ui => {
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
  target: page => [header(page), table(page)],
  padding: 0,
});

shot('files/runbar', {
  project: SL,
  url: runFolder,
  alt: 'The run bar above a run\'s files: Done, run on profiles/steady-high.yaml on linux by ci, and the Results, Redo '
    + 'and Delete buttons.',
  caption: 'In a run\'s folder, the run bar says what ran and links back to its results.',
  actions: async ui => {
    await ui.cursor.moveTo({ x: 1300, y: 880 });
    await ui.settle();
  },
  // the path above it, at a narrower width: the bar spreads over the page
  viewport: { width: 1100, height: 700 },
  target: page => [header(page), runBar(page)],
  padding: 0,
});

shot('files/hotkeys', {
  project: SL,
  url: runFolder,
  alt: 'The keyboard shortcuts dialog of the file browser: filter, go to a path, next and previous, open, parent folder, '
    + 'copy the path, show hidden files, refresh.',
  caption: 'Press ? for the keyboard shortcuts.',
  actions: async ui => {
    await ui.page.locator('body').click({ position: { x: 700, y: 800 } });
    // "?" is Shift and the slash key
    await ui.press('Shift+Slash');
    await ui.page.locator('.bp6-hotkey-dialog').waitFor();
    await ui.settle();
  },
  target: page => page.locator('.bp6-hotkey-dialog'),
});

clip('files/keyboard', {
  project: SL,
  // the commit's runs, a folder each
  url: d => d.filesUrl(SL, 'cache-shared', 'output/linux/'),
  alt: 'In the folder of a commit\'s runs, the selection moves down the folders with j and back with k, Enter opens '
    + 'steady-high\'s, / filters its files to percentiles.txt, the down arrow selects it and c copies its path.',
  caption: 'Browse the results from the keyboard.',
  // the run's 15 files, and the notification at the bottom
  viewport: { width: 1440, height: 560 },
  actions: async ui => {
    await ui.page.mouse.move(1300, 540);
  },
  script: async ui => {
    // keys only: no cursor
    await ui.cursor.hide();
    await ui.caption('j and k move through the folders');
    for (const key of ['j', 'j', 'j', 'j', 'j', 'k']) {
      await ui.press(key);
      await ui.hold(350);
    }
    await ui.caption('Enter opens one');
    await ui.press('Enter');
    await ui.page.getByText('percentiles.txt', { exact: true }).waitFor();
    await ui.settle();
    await ui.hold(1500);
    await ui.caption('/ filters its files');
    await ui.press('/');
    // focused, the filter box gets the keys
    for (const key of 'perc') await ui.press(key);
    await ui.hold(900);
    await ui.caption('↓ selects, c copies the path');
    await ui.press('ArrowDown');
    await ui.hold(500);
    await ui.press('c');
    await ui.page.locator('.bp6-toast').first().waitFor();
    await ui.settle();
    await ui.hold(2200);
  },
});
