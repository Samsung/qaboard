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
// the line above the images with the hovered pixel's coordinates, color swatches and values (and, with histograms,
// the info icon above it)
const pixelValues = (scope: Page | Locator) => scope.getByText(/^x: \d+, y: \d+$/).locator('xpath=../../..');
const controlsPanel = (page: Page) => page.locator('.bp6-card', { has: page.getByText('Controls', { exact: true }) }).last();

// `commit` against `reference`, the linux runs matching `filter` (the hw-model platform runs the same inputs)
const compare = (d: Demo, commit: string, reference: string, filter: string, opts: { view?: 'output-list' | 'bit_accuracy'; controls?: Record<string, unknown> } = {}) =>
  d.commitUrl(IQ, commit, { reference, view: opts.view ?? 'output-list', filter, controls: opts.controls });
// The halos: merge-bilateral against the isp-4.1 release
const halos = (d: Demo, filter: string, controls?: Record<string, unknown>) =>
  compare(d, 'merge-bilateral', 'isp-4-1', `${filter} linux`, { controls });

// Scrolls a run card right below the commit bars, or to `top`
async function showCard(ui: Ui, index = 0, top = 160) {
  await cards(ui.page).nth(index).evaluate((card, top) => window.scrollBy(0, card.getBoundingClientRect().top - top), top);
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

// Clicks a region of interest preset under the viewer, by its label. The viewer opens on the input's first preset,
// but how close depends on its size when it opened: click it again for the same zoom every time.
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
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    await mouseAway(ui);
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
  alt: 'New and reference images of the facade, zoomed on leaves in front of the wall: in the new image, dark halos '
    + 'outline every leaf.',
  caption: 'Both images at the same zoom: only the new denoiser outlines the leaves with dark halos.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await preset(ui, scope, 'Leaves over a window');
    // closer on the leaves at the top right of the region, where the halos are strongest
    await zoom(ui, scope, { x: 82, y: 42 }, 4);
    await mouseAway(ui);
  },
  target: page => imageRow(viewer(page)),
  padding: 0,
});

shot('commit/image-perceptual-diff', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { diff: true }),
  alt: 'New image, Image Diff and reference image of the facade window: in the diff, the window frame\'s edges show in '
    + 'yellow and orange, the flat wall stays white.',
  caption: 'Image Diff shows where the images differ; raise its threshold until only the halos stand out.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    await diffThreshold(ui, viewer(ui.page), 10);
    await mouseAway(ui);
  },
  target: page => imageRow(viewer(page)),
  padding: 4,
});

shot('commit/pixel-tooltip', {
  project: IQ,
  url: d => compare(d, 'bilateral-denoise', 'isp-4-1', 'charts/siemens-star base linux'),
  alt: 'The center of a Siemens star, new and reference: above the images, the hovered pixel\'s coordinates and its RGB '
    + 'values in both images; crosshairs mark the pixel on both.',
  caption: 'Hover a pixel: its values in both images show above them, and a crosshair marks the same spot on the reference.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Center (aliasing)');
    const image = newImage(viewer(ui.page));
    const box = await image.boundingBox();
    // on a spoke's edge, where the denoisers differ
    await ui.hover(image, { position: { x: box!.width * 0.21, y: box!.height * 0.3 } });
    await ui.settle();
  },
  target: page => [pixelValues(viewer(page)), imageRow(viewer(page))],
  // flush: the selected preset's thumbnail is right above the values
  padding: 0,
});

shot('commit/roi-histograms', {
  project: IQ,
  url: d => halos(d, 'photos/sky-gradient low-light'),
  alt: 'A rectangle selected on the sky gradient; below the images, the red, green, blue and luma histograms of the '
    + 'region, new and reference overlaid.',
  caption: 'Select a region to compare its histograms, new against reference.',
  // the images and the histograms under them
  viewport: { width: 1440, height: 1200 },
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Full Image');
    await ui.hover(newImage(scope));
    await ui.click(scope.locator('[title="Select a region to see its histogram"]').first());
    // a band of the sky, where the gradient's banding shows
    const box = (await newImage(scope).boundingBox())!;
    await ui.drag({ x: box.x + box.width * 0.2, y: box.y + box.height * 0.15 }, { x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 });
    await mouseAway(ui);
    await ui.settle();
  },
  // the pixel values, the images, the histograms (their axes and legend, not the plot's empty margins)
  target: page => [
    pixelValues(viewer(page)),
    imageRow(viewer(page)),
    viewer(page).locator('.js-plotly-plot g.cartesianlayer').first(),
    viewer(page).locator('.js-plotly-plot g.legend').first(),
  ],
  padding: 4,
});

shot('commit/auto-roi', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'The View ROIs menu open over the facade run, with Full Image, ROI Presets and Auto ROIs checked; below it, the '
    + 'twenty regions where new and reference differ most, found automatically, and the images zoomed on the first.',
  caption: 'Jump between the regions of interest preset for the input, or let QA-Board find where the images differ most.',
  viewport: { width: 1440, height: 1100 },
  actions: async ui => {
    const scope = viewer(ui.page);
    // lower than the other shots: the menu opens upwards, it must clear the commit bars
    await showCard(ui, 0, 260);
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
  // the run's name and metrics, the viewer, and the menu that opens over them
  target: page => [
    cards(page).first().getByText('photos/facade.png', { exact: true }),
    viewer(page),
    page.locator('.bp6-popover .bp6-menu').last(),
  ],
  padding: 4,
});

shot('commit/image-filters', {
  project: IQ,
  url: d => halos(d, 'photos/night-street low-light'),
  alt: 'The Image Tools panel over the night street\'s shadows, with brightness raised and gamma lowered: the noise '
    + 'of both images shows.',
  caption: 'Image Tools filters apply to both images at once: here brightness and gamma reveal the noise in the shadows.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
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
    await ui.settle();
    const box = (await newImage(scope).boundingBox())!;
    await ui.hover(newImage(scope), { position: { x: box.width * 0.6, y: box.height * 0.45 } });
    await ui.settle();
    // back on the button: the panel and the viewer's buttons hide when the mouse leaves the image
    await ui.hover(scope.locator('[title="Image Tools"]').first());
    await ui.settle();
  },
  // the run's name and metrics, and the viewer
  target: page => [cards(page).first().getByText('photos/night-street.png', { exact: true }), viewer(page)],
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
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    await mouseAway(ui);
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
    await ui.caption('Zoom in one image: the other follows');
    // a screen pixel is 21 pixels of the wall: the wheel gets close to the row of stars, not onto a 64 px one
    await ui.wheel(newImage(scope), -600, { steps: 6, position: { x: box!.width * at.x / 100, y: box!.height * at.y / 100 } });
    await ui.tiles();
    await ui.hold(1200);
    // the preset region fits the star exactly
    await ui.caption('Down to single pixels, in sync');
    await preset(ui, scope, 'Siemens star 64 px');
    await ui.tiles();
    await ui.cursor.moveTo({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    await ui.hold(2500);
  },
});

void refImage;
