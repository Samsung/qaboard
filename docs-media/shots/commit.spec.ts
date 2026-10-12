// The commit page (docs-media/shots.yaml: commit/*), on the camera ISP project (examples/image-quality).
// The story: a bilateral denoiser wins PSNR but adds halos along edges (merge-bilateral), against the isp-4.1 release.
import { clip, shot, type Demo, type Locator, type Page, type Ui } from './lib';

const IQ = 'image-quality';

// Run cards; in a card, the viewer of each visualization (Output first), with new and reference images
const cards = (page: Page) => page.locator('.output-card.bp6-card');
const viewer = (scope: Page | Locator, index = 0) => scope.locator(`[id="${index}-0"]`).first();
const images = (scope: Page | Locator) => scope.locator('[id^="image-viewer-"]');
const newImage = (scope: Page | Locator) => images(scope).nth(0);
const refImage = (scope: Page | Locator) => images(scope).nth(1);
// the images (new, Image Diff, reference) with their labels
const imageRow = (scope: Page | Locator) => newImage(scope).locator('xpath=../..');
const controlsPanel = (page: Page) => page.locator('.bp6-card', { has: page.getByText('Controls', { exact: true }) }).last();

// `commit` against `reference`, the linux runs matching `filter` (the hw-model platform runs the same inputs)
const compare = (d: Demo, commit: string, reference: string, filter: string, opts: { view?: 'output-list' | 'bit_accuracy'; controls?: Record<string, unknown> } = {}) =>
  d.commitUrl(IQ, commit, { reference, view: opts.view ?? 'output-list', filter, controls: opts.controls });
// The halos: merge-bilateral against the isp-4.1 release
const halos = (d: Demo, filter: string, controls?: Record<string, unknown>) =>
  compare(d, 'merge-bilateral', 'isp-4-1', `${filter} linux`, { controls });

// Scrolls the first run card right below the commit bars
async function showCard(ui: Ui, index = 0) {
  await cards(ui.page).nth(index).evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 160));
  await ui.settle();
}

// Zooms the synced viewers with the mouse wheel, at a point of the new image given in % of its box
async function zoom(ui: Ui, scope: Page | Locator, at: { x: number; y: number }, steps: number) {
  const image = newImage(scope);
  const box = await image.boundingBox();
  if (!box) throw new Error('[commit.spec] the new image has no box');
  await ui.wheel(image, -100 * steps, { steps, position: { x: (box.width * at.x) / 100, y: (box.height * at.y) / 100 } });
  await ui.settle();
}

// The mouse out of the viewers: their buttons fade out, the crosshairs go away
async function mouseAway(ui: Ui) {
  await ui.cursor.moveTo({ x: 1000, y: 140 });
  await ui.hold(500);
}

// Clicks a region of interest preset under the viewer, by its label
async function preset(ui: Ui, scope: Page | Locator, label: string) {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await ui.click(scope.locator('a.bp6-button', { hasText: exact }).first());
  await ui.settle();
}

// The diff threshold: the slider above the Image Diff, 1% per arrow key
async function diffThreshold(ui: Ui, scope: Page | Locator, steps: number) {
  const handle = scope.locator('.bp6-slider-handle').first();
  await ui.click(handle);
  for (let i = 0; i < steps; i++) await ui.press('ArrowRight');
  await ui.settle();
}


shot('commit/visualizations', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'A run card of the facade photo: PSNR, SSIM and runtime with their changes against the reference, preset regions '
    + 'of interest, and the new and reference images side by side, zoomed on a window.',
  caption: 'Each run shows its main metrics against the reference, then its outputs, new and reference side by side.',
  actions: async ui => {
    await showCard(ui);
  },
});

shot('commit/controls-panel', {
  project: IQ,
  // the color chart and the slanted edge have plots, some hidden by default
  url: d => halos(d, 'charts/(color|slanted) base'),
  storage: { 'controls-panel-expanded': 'true' },
  alt: 'The Controls panel open on the right of the run cards: an Image Diff switch, a switch per visualization, '
    + 'including the hidden Color errors and Noise vs signal, and the sorting options.',
  caption: 'The Controls panel shows or hides visualizations, turns Image Diff on, and sorts the runs.',
  actions: async ui => {
    const panel = controlsPanel(ui.page);
    // fold Dynamic Options, so that Sorting fits
    await ui.click(panel.getByText('Dynamic Options', { exact: true }));
    await ui.hold(400);
    await ui.anchor('visualizations', panel.getByText('Visualizations', { exact: true }));
    await ui.anchor('image-diff', panel.locator('label', { hasText: 'Image Diff' }));
    await ui.anchor('sorting', panel.getByText('Sorting', { exact: true }));
  },
});

shot('commit/image-sbs', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'New and reference images of the facade, zoomed on the corner of a window frame: the new image has light halos '
    + 'along the dark frame.',
  caption: 'Zoom on one image and the other follows: the new denoiser leaves halos along the window frame.',
  actions: async ui => {
    // the viewer opens on the input's first preset region, the window frame: closer on its corner
    await zoom(ui, viewer(ui.page), { x: 25, y: 25 }, 4);
    await mouseAway(ui);
  },
  target: page => imageRow(viewer(page)),
  padding: 0,
});

shot('commit/image-perceptual-diff', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { diff: true }),
  alt: 'New image, Image Diff and reference image of the facade window: in the diff, the window frame\'s edges glow, '
    + 'the flat wall stays dark.',
  caption: 'Image Diff shows where the images differ; raise its threshold until only the halos stand out.',
  actions: async ui => {
    await diffThreshold(ui, viewer(ui.page), 10);
    await mouseAway(ui);
  },
  target: page => imageRow(viewer(page)),
  padding: 4,
});

shot('commit/pixel-tooltip', {
  project: IQ,
  url: d => compare(d, 'bilateral-denoise', 'isp-4-1', 'charts/siemens-star base linux'),
  alt: 'The center of a Siemens star, new and reference: the cursor is on the new image, the pixel\'s coordinates and '
    + 'RGB values of both images show above, and a crosshair marks the same pixel on the reference.',
  caption: 'Hover a pixel: its values in both images, and a crosshair at the same spot on the reference.',
  actions: async ui => {
    const image = newImage(viewer(ui.page));
    const box = await image.boundingBox();
    // on a spoke's edge, where the denoisers differ
    await ui.hover(image, { position: { x: box!.width * 0.21, y: box!.height * 0.3 } });
    await ui.settle();
  },
  target: page => [viewer(page).getByText(/^x: \d+, y: \d+$/), imageRow(viewer(page))],
  padding: 4,
});

shot('commit/roi-histograms', {
  project: IQ,
  url: d => halos(d, 'photos/sky-gradient low-light'),
  alt: 'A rectangle selected on the sky gradient; below the images, the red, green, blue and luma histograms of the '
    + 'region, new and reference overlaid.',
  caption: 'Select a region to compare its histograms, new against reference.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await preset(ui, scope, 'Full Image');
    await ui.hover(newImage(scope));
    await ui.click(scope.locator('[title="Select a region to see its histogram"]').first());
    // a band of the sky, where the gradient's banding shows
    const box = (await newImage(scope).boundingBox())!;
    await ui.drag({ x: box.x + box.width * 0.2, y: box.y + box.height * 0.15 }, { x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 });
    await mouseAway(ui);
    await ui.settle();
  },
  target: page => viewer(page),
  padding: 4,
});

shot('commit/auto-roi', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'The View ROIs menu open over the facade run, with Full Image, ROI Presets and Auto ROIs, and below it the '
    + 'regions where new and reference differ most, found automatically.',
  caption: 'Jump between the regions of interest preset for the input, or let QA-Board find where the images differ most.',
  actions: async ui => {
    const scope = viewer(ui.page);
    const menu = scope.getByText(/^View /).first();
    await ui.hover(menu);
    await ui.click(ui.page.getByRole('menuitem', { name: 'Auto ROIs' }));
    await ui.click(scope.getByRole('button', { name: 'Find Regions of Interest' }));
    await ui.settle();
    // the menu again, over the regions found
    await mouseAway(ui);
    await ui.hover(menu);
    await ui.settle();
  },
  // the viewer, and the menu that opens over it
  target: page => [viewer(page), page.locator('.bp6-popover .bp6-menu').last()],
  padding: 4,
});

shot('commit/image-filters', {
  project: IQ,
  url: d => halos(d, 'photos/night-street low-light'),
  alt: 'The Image Tools panel over the night street\'s shadows, with brightness, gamma and sharpen raised: the noise '
    + 'of both images shows.',
  caption: 'Brightness, gamma and sharpen apply to both images at once: here they reveal the noise in the shadows.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await preset(ui, scope, 'Shadows (noise)');
    await ui.hover(newImage(scope));
    await ui.click(scope.locator('[title="Image Tools"]').first());
    // the new image's tools (the reference viewer has its own, synced)
    const tools = ui.page.locator('[id^="osd-imagetools-"]').first();
    const slider = (name: string) => tools.locator(`input[type="range"][id^="osd-filter-${name}-"]`);
    // keyboard on the range inputs: a click would jump to where it lands
    await slider('Brightness').focus();
    await ui.press('PageUp');
    await slider('Gamma').focus();
    for (let i = 0; i < 8; i++) await ui.press('ArrowLeft');
    await slider('Sharpen').focus();
    for (let i = 0; i < 10; i++) await ui.press('ArrowRight');
    await ui.settle();
  },
  target: page => viewer(page),
  padding: 4,
});

shot('commit/output-files', {
  project: IQ,
  login: 'tobias',
  url: d => compare(d, 'fxp-round-half-even', 'isp-4-1', 'photos/facade hw-model', { view: 'bit_accuracy' }),
  alt: 'Output Files of the facade run on the hw-model platform: the stages folder open, its changed files marked, '
    + 'and the help that explains the icons.',
  caption: 'Output Files lists what changed in each run: here the fixed-point model\'s stage buffers after a rounding change.',
  actions: async ui => {
    await ui.click(ui.page.getByText('stages', { exact: true }).first());
    await ui.click(ui.page.getByText('raw', { exact: true }).first());
    await ui.settle();
    await ui.hover(ui.page.getByText('Help', { exact: true }));
    await ui.settle();
  },
});


clip('commit/image-diff', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'Zooming into the new image of the facade, the reference follows; the Controls panel opens and Image Diff turns '
    + 'on; raising the threshold leaves only the window frame\'s halos.',
  caption: 'Synced zoom, then Image Diff and its threshold.',
  actions: async ui => {
    await showCard(ui);
  },
  script: async ui => {
    const scope = viewer(ui.page);
    await ui.caption('Zoom in one image: the other follows');
    await zoom(ui, scope, { x: 25, y: 25 }, 4);
    await ui.hold(1500);
    await ui.caption('Image Diff shows what changed');
    await ui.click(ui.page.locator('[title="Toggle Controls Panel"]'));
    await ui.hold(500);
    await ui.click(controlsPanel(ui.page).locator('label', { hasText: 'Image Diff' }));
    await ui.settle();
    await ui.click(ui.page.locator('[title="Toggle Controls Panel"]'));
    await ui.hold(1500);
    await ui.caption('A higher threshold keeps only the halos');
    // from 5% to 15%: the slider spans 0-30% over the width of an image
    const handle = scope.locator('.bp6-slider-handle').first();
    const track = (await scope.locator('.bp6-slider').first().boundingBox())!;
    const from = (await handle.boundingBox())!;
    await ui.drag(handle, { x: from.x + from.width / 2 + track.width / 3, y: from.y + from.height / 2 });
    await ui.settle();
    await ui.hold(2500);
  },
});

clip('commit/deep-zoom', {
  project: IQ,
  url: d => halos(d, 'charts/test-wall base'),
  alt: 'The 113-megapixel test wall, new and reference side by side: zooming from the whole wall to a small Siemens '
    + 'star until single pixels show, both images in sync.',
  caption: 'Deep zoom on a 113 MP image: the viewers load only the tiles they show.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Full Image');
  },
  script: async ui => {
    const scope = viewer(ui.page);
    await ui.caption('A 113 MP test wall, new and reference');
    // the 64 px Siemens star at (3904, 8192) of the 12288x9216 wall
    const at = { x: (3904 / 12288) * 100, y: (8192 / 9216) * 100 };
    const box = await newImage(scope).boundingBox();
    await ui.cursor.moveTo({ x: box!.x + (box!.width * at.x) / 100, y: box!.y + (box!.height * at.y) / 100 });
    await ui.hold(1000);
    await ui.caption('Down to single pixels, in sync');
    for (let i = 0; i < 4; i++) {
      const now = await newImage(scope).boundingBox();
      await ui.wheel(newImage(scope), -700, { steps: 7, position: { x: now!.width * at.x / 100, y: now!.height * at.y / 100 } });
      await ui.hold(900);
    }
    await ui.tiles();
    await ui.hold(2000);
  },
});

void refImage;
