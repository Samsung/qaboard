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

// An element's box once it stopped moving. Hovering an image shows the hovered pixel's values above the images, which
// pushes them down: measured before, a point on the image would land elsewhere, depending on timing.
async function stableBox(target: Locator) {
  let previous = await target.boundingBox();
  for (let i = 0; i < 20; i++) {
    await target.page().waitForTimeout(150);
    const box = await target.boundingBox();
    if (box && JSON.stringify(box) === JSON.stringify(previous)) return box;
    previous = box;
  }
  if (!previous) throw new Error(`[commit.spec] ${target} has no box`);
  return previous;
}

// Hovers a point of the new image, given in % of its box, once the images stopped moving
async function hoverImage(ui: Ui, scope: Page | Locator, at: { x: number; y: number }) {
  const image = newImage(scope);
  const position = async () => {
    const box = await stableBox(image);
    return { x: (box.width * at.x) / 100, y: (box.height * at.y) / 100 };
  };
  await ui.hover(image, { position: await position() });
  return position();
}

// Zooms the synced viewers with the mouse wheel, at a point of the new image given in % of its box
async function zoom(ui: Ui, scope: Page | Locator, at: { x: number; y: number }, steps: number) {
  const position = await hoverImage(ui, scope, at);
  await ui.wheel(newImage(scope), -100 * steps, { steps, position });
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
  // no focus ring left around the thumbnail
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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
    // on a spoke's edge, where the denoisers differ
    await ui.hover(newImage(viewer(ui.page)), { position: await hoverImage(ui, viewer(ui.page), { x: 21, y: 30 }) });
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
    await hoverImage(ui, scope, { x: 50, y: 50 });
    await ui.click(scope.locator('[title="Select a region to see its histogram"]').first());
    // a band of the sky, where the gradient's banding shows. On the tool's button, the pixel values went away: back on
    // the image, they show again and push the images down, before the drag starts
    await hoverImage(ui, scope, { x: 20, y: 15 });
    // The values show a moment after the mouse is back on the image, and push it down: measured before, the region
    // landed 18 px higher in some captures (the hovered pixel at y 329 instead of 367). Once they show, the image stays
    // in place
    await pixelValues(scope).waitFor({ state: 'visible' });
    const box = await stableBox(newImage(scope));
    await ui.drag({ x: box.x + box.width * 0.2, y: box.y + box.height * 0.15 }, { x: box.x + box.width * 0.6, y: box.y + box.height * 0.45 });
    const after = await newImage(scope).boundingBox();
    if (JSON.stringify(after) !== JSON.stringify(box))
      throw new Error(`[commit.spec] the image moved during the drag: ${JSON.stringify(box)} then ${JSON.stringify(after)}`);
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
  alt: 'The View ROIs menu open over the facade run, with Full Image, ROI Presets and Auto ROIs checked; below it, '
    + 'thumbnails of the twenty regions where new and reference differ most, found automatically, a dot colored by how much.',
  caption: 'Jump between the regions of interest preset for the input, or let QA-Board find where the images differ most.',
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
  // the run's name and metrics, the menu, and the thumbnails of the regions found (not the images below, zoomed on the
  // first region until its pixels show)
  target: page => [
    cards(page).first().getByText('photos/facade.png', { exact: true }),
    page.locator('.bp6-popover .bp6-menu').last(),
    viewer(page).locator('a.bp6-button').last().locator('xpath=ancestor::div[1]'),
  ],
  // flush: the images' labels start right below the thumbnails
  padding: 0,
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
    await hoverImage(ui, scope, { x: 50, y: 50 });
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
    await ui.hover(newImage(scope), { position: await hoverImage(ui, scope, { x: 60, y: 45 }) });
    await ui.settle();
    // back on the button: the panel and the viewer's buttons hide when the mouse leaves the image. OpenSeadragon shows
    // the button's hover image (its third <img>) when it sees the mouse enter: a viewer redrawn under the mouse misses
    // that, so enter again until it shows
    const button = scope.locator('[title="Image Tools"]').first();
    for (let attempt = 1; ; attempt++) {
      await ui.hover(button);
      try {
        await button.locator('img').nth(2).waitFor({ state: 'visible', timeout: 1000 });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await ui.hover(newImage(scope), { position: { x: 20, y: 20 } });
      }
    }
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
  alt: 'The files of the facade run on the hw-model platform that differ from the reference: metrics.json, greyed and '
    + 'tagged "not checked", then out.png, stages 4 and 5 in raw/ and stages/, and regs.txt, whose diff below shows the '
    + 'ROUNDING register going from 0 to 2.',
  caption: 'Output Files lists only the files that changed: a rounding change in the fixed-point model shows in its '
    + 'register dump, then in the last two stages\' buffers.',
  // the card, its diff below the tree
  viewport: { width: 1440, height: 1300 },
  actions: async ui => {
    await showCard(ui);
    // folders open with their caret (a click on the name does nothing)
    const caret = (folder: string) => ui.page.locator('.bp6-tree-node-content')
      .filter({ has: ui.page.getByText(folder, { exact: true }) }).locator('.bp6-tree-node-caret').first();
    await ui.click(caret('stages'));
    await ui.click(caret('raw'));
    // a file's diff with the reference opens below the tree
    await ui.click(ui.page.locator('.bp6-tree-node-content').getByText('regs.txt', { exact: true }).first());
    await ui.settle();
    await mouseAway(ui);
  },
  target: page => cards(page).first(),
  padding: 4,
});


clip('commit/image-diff', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'Zooming into the new image of the facade, the reference follows; the Controls panel opens and Image Diff turns '
    + 'on; raising the threshold leaves only the window frame\'s halos.',
  caption: 'Synced zoom, then Image Diff and its threshold.',
  // While the Controls panel is open, its text lands 1 pixel apart in about a third of the recordings (0.27-0.30% of
  // the frames differ, cause unknown): docs-media/README.md#known-issues
  dedupeTolerance: 0.005,
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    // the pixel values show above the images from the first hover on: not while recording, they'd push them down
    await hoverImage(ui, viewer(ui.page), { x: 50, y: 50 });
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
    // the pixel values show above the images from the first hover on: not while recording, they'd push them down
    await hoverImage(ui, viewer(ui.page), { x: 50, y: 50 });
    await mouseAway(ui);
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

// Videos: the camera driving down the aisle in low light, every frame through the ISP (qa/video.py), in their own
// `video` batch. The viewer's keys act on the viewer under the mouse. Side by side, the stage is half as high as in the
// other modes: the clip stays in the others, so that nothing moves on the page.
const videos = (page: Page) => page.getByRole('application', { name: /^Videos/ }).first();

clip('commit/video-compare', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', batch: 'video', batch_ref: 'video' }),
  alt: 'A video down a warehouse aisle in low light, new left of a divider, reference right, stepping frame by frame '
    + 'together; then zoomed on a white package where the new one draws dark rims, flipped in place, and their difference.',
  caption: 'Videos in sync, frame by frame: with a wipe, zoomed in, flipped in place, and their difference.',
  // the viewer remembers its mode in the browser
  storage: { 'qaboard:video-viewer:mode': '"wipe"', 'qaboard:video-viewer:gain': '4' },
  actions: async ui => {
    await showCard(ui);
    await ui.page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 2));
    // a few frames in: the camera starts moving
    await ui.hover(videos(ui.page));
    for (let i = 0; i < 24; i++) await ui.press('ArrowRight');
    await ui.settle();
    await mouseAway(ui);
  },
  script: async ui => {
    const stage = videos(ui.page);
    const box = (await stage.boundingBox())!;
    const at = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
    // the white package, where the halos are
    const zoomAt = { x: 0.6, y: 0.62 };

    await ui.caption('New and reference, in sync frame by frame');
    await ui.cursor.moveTo(at(0.3, 0.4));
    for (let i = 0; i < 10; i++) await ui.press('ArrowRight');
    await ui.hold(500);

    await ui.caption('Wipe: drag the divider');
    await ui.drag(at(0.5, 0.5), at(0.25, 0.5));
    await ui.drag(at(0.25, 0.5), at(zoomAt.x, 0.5));
    await ui.hold(400);

    await ui.caption('Zoom in: both videos follow');
    await ui.wheel(stage, -1000, { steps: 5, position: { x: box.width * zoomAt.x, y: box.height * zoomAt.y } });
    await ui.hold(1200);

    await ui.caption('Toggle: press t to flip them in place');
    await ui.click(ui.page.getByRole('radio', { name: 'Toggle' }));
    await ui.settle();
    await ui.cursor.moveTo(at(zoomAt.x + 0.08, zoomAt.y + 0.1));
    await ui.hold(400);
    for (let i = 0; i < 4; i++) {
      await ui.press('t');
      await ui.hold(600);
    }

    await ui.caption('Their difference shows what changed');
    await ui.click(ui.page.getByRole('radio', { name: 'Difference' }));
    await ui.settle();
    await ui.hold(2000);
  },
});


// The commit bars, fixed at the top of the page: the new commit's, then the reference's. On the right of each, the
// filter box with the counters under it, then the batch selector.
const filterBox = (page: Page, type: 'new' | 'ref') =>
  page.locator('.bp6-form-group', { has: page.locator(`input[placeholder="filter ${type} outputs"]`) });
const barRight = (page: Page, type: 'new' | 'ref') =>
  page.locator('.bp6-navbar-group.bp6-align-right', { has: page.locator(`input[placeholder="filter ${type} outputs"]`) });
// The Controls panel's Dynamic Options: one entry per option, here the ISP stage
const dynamicOptions = (page: Page) => controlsPanel(page).getByText('Dynamic Options', { exact: true }).locator('xpath=../..');

shot('commit/batch-picker', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'bilateral-denoise', { reference: 'isp-4-1', view: 'output-list' }),
  alt: 'The new commit\'s batch selector open: the CI batch, run by ci, 18 of 18 runs successful; ines 🏠 ines-halo, '
    + 'Ines\'s local runs, 5 of 5; and the tune-denoise tuning experiment, 60 of 60.',
  caption: 'Each commit can have several batches: CI\'s, your local runs (🏠) and tuning experiments. Pick one to see '
    + 'its runs.',
  actions: async ui => {
    await ui.click(barRight(ui.page, 'new').locator('.bp6-popover-target button').first());
    await ui.page.locator('.bp6-popover', { hasText: 'tune-denoise' }).waitFor();
    await ui.settle();
  },
  target: page => [barRight(page, 'new'), page.locator('.bp6-popover', { hasText: 'tune-denoise' })],
  padding: 8,
});

shot('commit/output-filter', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'table-kpi' }),
  alt: 'The new commit\'s filter box with "low-light -gradient", 8 outputs under it, and the Metrics Table below listing '
    + 'only the low-light runs, the sky gradient left out.',
  caption: 'Words narrow down the runs, a minus sign leaves some out; the counters under the box count what\'s left.',
  actions: async ui => {
    await ui.type(ui.page.locator('input[placeholder="filter new outputs"]'), 'low-light -gradient');
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  // the filter box and its counters, and the table of the runs left
  target: page => [filterBox(page, 'new'), page.locator('.bp6-card', { hasText: 'Quality report' })],
  padding: 8,
});

shot('commit/export', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', filter: 'photos low-light' }),
  alt: 'The filter box with "photos low-light" and 4 outputs; below, the Export box with the pattern *.png, the Windows '
    + 'and Linux paths of the export folder, and "8 files exported from 4 runs".',
  caption: 'Export gathers the files matching a pattern from the filtered runs into one folder, as links.',
  actions: async ui => {
    await ui.click(ui.page.getByRole('button', { name: 'Export' }));
    await ui.page.getByText(/files exported from/).waitFor();
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  // the commit bars' filter box, and the Export box
  target: page => [filterBox(page, 'new'), page.locator('.bp6-callout', { has: page.getByRole('button', { name: 'Export' }) })],
  padding: 8,
});

// Dynamic outputs: `stages/:stage.jpg` in qaboard.yaml gives a slider over the ISP's stages, synced across runs
const stages = (d: Demo, filter: string, stage: number) => d.commitUrl(IQ, 'merge-bilateral', {
  reference: 'isp-4-1', view: 'output-list', filter,
  controls: { show: { Output: false }, dynamic_options: { stage: [String(stage)] }, dynamic_options_sync: { stage: true } },
});

shot('commit/dynamic-options', {
  project: IQ,
  url: d => stages(d, 'night-street|facade low-light', 3),
  storage: { 'controls-panel-expanded': 'true' },
  alt: 'The Controls panel\'s Dynamic Options: the stage option, synced, its slider on 3. Next to it, the night street\'s '
    + 'card shows stages/3.jpg, the denoised image, new and reference.',
  caption: 'Dynamic Options pick the file each card shows, here the ISP stage. Synced, one slider drives every run.',
  actions: async ui => {
    const card = cards(ui.page).filter({ hasText: 'photos/night-street.png' }).first();
    const scrollToCard = () => card.evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 160));
    // the browser keeps what's in view in place when the page above changes, more or less depending on the timing
    await ui.page.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; });
    await scrollToCard();
    await ui.settle();
    // the ISP stage, the card's second visualization (Output is hidden)
    await preset(ui, viewer(card, 1), 'Shadows (noise)');
    await mouseAway(ui);
    // the facade's card above grows when its images show, sometimes after the first scroll: back in place
    await scrollToCard();
    await ui.settle();
  },
});

clip('commit/dynamic-outputs', {
  project: IQ,
  url: d => stages(d, 'night-street|facade low-light', 1),
  storage: { 'controls-panel-expanded': 'true' },
  alt: 'The stage slider of the Controls panel steps from the raw sensor mosaic to the tone-mapped image of the facade\'s '
    + 'window, new and reference changing together; scrolling down, the night street\'s card follows the slider too.',
  caption: 'One slider over the ISP\'s stages drives every run\'s card.',
  // the facade's tone-mapped output, new and reference
  poster: 7000,
  actions: async ui => {
    // The night street's card on the full image, then the facade's on its window, where the halos show. The reference's
    // image only shows from stage 3 (stages 1 and 2 are the same in both commits): the viewers keep their region
    for (const [index, region] of [[1, 'Full Image'], [0, 'Window frame (halos)']] as const) {
      await showCard(ui, index);
      await preset(ui, viewer(cards(ui.page).nth(index), 1), region);
    }
    // the pixel values show above the images from the first hover on: not while recording, they'd push them down
    await hoverImage(ui, viewer(cards(ui.page).first(), 1), { x: 50, y: 50 });
    await mouseAway(ui);
    // the browser keeps what's in view in place when the page above changes, more or less depending on the timing
    await ui.page.evaluate(() => { document.documentElement.style.overflowAnchor = 'none'; });
  },
  script: async ui => {
    const handle = dynamicOptions(ui.page).locator('.bp6-slider-handle').first();
    // Not recorded: a card right below the commit bars. Twice: the cards change height when the reference's image
    // shows (from stage 3), and load their images once in view, which makes the page longer
    const pin = async (index: number) => {
      for (let i = 0; i < 2; i++) {
        await cards(ui.page).nth(index).evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 160));
        await ui.settle();
      }
    };
    await pin(0);
    await ui.caption('1: the raw sensor data');
    await ui.click(handle);
    await pin(0);
    await ui.hold(1300);
    for (const label of ['2: demosaic', '3: denoise', '4: sharpen', '5: tone map, the output']) {
      await ui.caption(label);
      await ui.press('ArrowRight');
      await pin(0);
      await ui.hold(1200);
    }
    await ui.caption('Every run\'s card follows');
    // down to the next card, at once (with the mouse wheel, what's under the mouse would change)
    await pin(1);
    await ui.hold(300);
    await ui.cursor.moveTo(handle);
    await ui.press('ArrowLeft');
    await ui.press('ArrowLeft');
    await pin(1);
    await ui.hold(2000);
  },
});

// Output Files: the tree of a run's files, only those that differ from the reference's by default. A folder opens with
// its caret (a click on its name does nothing), a file shows its diff below the tree.
const treeCaret = (scope: Locator, folder: string) => scope.locator('.bp6-tree-node-content')
  // the inner locator is relative to each node: from the page
  .filter({ has: scope.page().getByText(folder, { exact: true }) }).locator('.bp6-tree-node-caret').first();
const treeFile = (scope: Page | Locator, label: string) =>
  scope.locator('.bp6-tree-node-content').getByText(label, { exact: true }).first();

clip('commit/bit-accuracy-diff', {
  project: IQ,
  login: 'tobias',
  // the rounding change of the fixed-point model, on the hw-model platform
  url: d => compare(d, 'fxp-round-half-even', 'isp-4-1', 'photos/facade hw-model', { view: 'bit_accuracy' }),
  alt: 'Output Files of the facade run on the hw-model platform: a click on regs.txt shows its diff below the tree, Next '
    + 'Diff jumps to the ROUNDING register, from 0 to 2; a Ctrl-click on metrics.json adds its diff below. Then a commit '
    + 'that only changed the docs: its run is bit-accurate.',
  caption: 'Click files to diff them with the reference, Ctrl-click to diff several. A commit that leaves every file '
    + 'identical is bit-accurate.',
  actions: async ui => {
    await showCard(ui);
    await ui.click(treeCaret(cards(ui.page).first(), 'stages'));
    await ui.settle();
    await mouseAway(ui);
  },
  script: async ui => {
    const card = cards(ui.page).first();
    // The page scrolls down to the diffs, at once: a mouse wheel would scroll the diff editor when it's under the
    // mouse, more or less depending on the recording
    const scroll = async (dy: number) => {
      await ui.page.evaluate(dy => window.scrollBy(0, dy), dy);
      await ui.settle();
      await ui.hold(200);
    };
    await ui.caption('Click a file to diff it with the reference');
    await ui.click(treeFile(card, 'regs.txt'));
    await ui.settle();
    await scroll(360);
    await ui.hold(800);
    await ui.caption('Next Diff jumps to the change: rounding 0 → 2');
    await ui.click(card.getByRole('button', { name: 'Next Diff' }).first());
    await ui.settle();
    await ui.hold(1800);
    await ui.caption('Ctrl-click another file to diff it too');
    await ui.click(treeFile(card, 'metrics.json'), { modifiers: ['Control'] });
    await ui.settle();
    await scroll(300);
    await ui.hold(2200);
    // a commit that didn't touch the fixed-point model (story.yaml: docs-tuning-guide), on the same run
    await ui.caption('A docs-only commit: every file identical');
    await ui.cursor.moveTo({ x: 1000, y: 140 });
    await ui.goto(compare(ui.demo, 'docs-tuning-guide', 'isp-4-1', 'photos/facade hw-model', { view: 'bit_accuracy' }));
    await showCard(ui);
    await ui.hold(2500);
  },
});

// The halos, on the leaves in front of the facade's window, before and after the clamp: the same crop as
// commit/image-sbs, the new image only, for <Compare>
for (const [id, commit, alt, caption] of [
  ['commit/halo-before', 'merge-bilateral',
    'Leaves in front of the facade, after the bilateral denoiser: a dark rim outlines every leaf against the wall.',
    'With the bilateral denoiser and its detail boost, dark halos outline the leaves.'],
  ['commit/halo-after', 'merge-halo-clamp',
    'The same leaves once the sharpening is clamped: the edges stay crisp, with only faint rims.',
    'With the clamp, the edges stay crisp and the halos fade.'],
] as const)
  shot(id, {
    project: IQ,
    url: d => compare(d, commit, 'isp-4-1', 'photos/facade base linux'),
    alt,
    caption,
    actions: async ui => {
      const scope = viewer(ui.page);
      await preset(ui, scope, 'Leaves over a window');
      await zoom(ui, scope, { x: 82, y: 42 }, 4);
      await mouseAway(ui);
    },
    target: page => newImage(viewer(page)),
    padding: 0,
  });

void refImage;


// The object detector (examples/detection-eval): the first int8 model (int8-minmax) is 3.5x smaller than fp32, but
// loses much of the indoor slice and some small objects. CI runs both models on every commit, on 4 slices of the test
// set; the int8 runs compare with the fp32 release kd-1.2's runs on the same slice. Visualizations, in qaboard.yaml's
// order: 0 Detections (images/:image.jpg), 1 Precision-recall, 2 Recall by object size, 3 Report, then hidden by
// default: Confusions, Detections (JSON)
const DE = 'detection-eval';
const DET_VIZ = ['Detections', 'Precision-recall', 'Recall by object size', 'Report'] as const;
const showOnly = (...names: Array<(typeof DET_VIZ)[number]>) => ({ show: Object.fromEntries(DET_VIZ.map(v => [v, names.includes(v)])) });
// int8-minmax against the fp32 release
const int8 = (d: Demo, opts: { view?: 'summary' | 'table-kpi' | 'table-compare' | 'output-list'; filter?: string; controls?: Record<string, unknown> } = {}) =>
  d.commitUrl(DE, 'int8-minmax', { reference: 'kd-1-2', view: opts.view ?? 'output-list', filter: opts.filter, controls: opts.controls });
// The view's card: Summary, Quality report (Metrics Table), Improvement report (Metrics Diff)...
const viewCard = (page: Page, heading: string) =>
  page.locator('.bp6-card', { has: page.locator('h1, h2, h3', { hasText: new RegExp(`^${heading}$`) }) }).first();

// The metrics a view shows: a tag input above it. Replaces one metric with another
async function swapMetric(ui: Ui, scope: Locator, remove: string, add: string) {
  const input = scope.locator('.bp6-tag-input').first();
  await ui.click(input.locator('.bp6-tag', { hasText: remove }).locator('.bp6-tag-remove'));
  await ui.click(input.locator('input'));
  await ui.type(input.locator('input'), add);
  await ui.page.getByRole('menuitem', { name: new RegExp(add) }).first().waitFor();
  await ui.press('Enter');
  await input.locator('.bp6-tag', { hasText: add }).waitFor();
  // the query stays in the box once the metric is picked
  await input.locator('input').fill('');
  await ui.press('Escape');
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ui.settle();
}

shot('commit/summary', {
  project: DE,
  url: d => int8(d, { view: 'summary', filter: 'int8' }),
  alt: 'The Summary of the int8 runs against the fp32 release: median mAP -5%, AP small -21% and recall of small '
    + 'objects -4% in red, model size 3.86 MB against 13.8 MB (-72%) in green; pass-rate bars under the metrics with a '
    + 'target, box plots on the right.',
  caption: 'The Summary compares the medians over the runs: the int8 model is much smaller, and finds fewer small objects.',
  actions: async ui => {
    await swapMetric(ui, viewCard(ui.page, 'Summary'), 'Latency per image', 'Model size');
    await ui.plots();
    await ui.cursor.moveTo({ x: 1400, y: 880 });
  },
  target: page => viewCard(page, 'Summary'),
  padding: 0,
});

shot('commit/metrics-table', {
  project: DE,
  url: d => int8(d, { view: 'table-kpi' }),
  alt: 'The Metrics Table of the first int8 commit: a row per slice and model, mAP, AP50, AP small and latency, new and '
    + 'reference. mAP cells go from green on small-objects to orange on indoor and warehouse, by their distance to the '
    + '0.15 target in the header; latency cells are green.',
  caption: 'One row per test, colored by the distance to the targets set in metrics.yaml, shown in the headers.',
  actions: async ui => {
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.settle();
  },
  target: page => viewCard(page, 'Quality report'),
  padding: 0,
});

shot('commit/metrics-diff', {
  project: DE,
  url: d => int8(d, { view: 'table-compare', filter: 'int8' }),
  alt: 'The Metrics Diff of the int8 runs against the fp32 release, slice by slice: indoor mAP -35% and AP small -34% in '
    + 'orange, AP small -7% on small-objects and -15% outdoor, warehouse better, and the model size -72% in green on '
    + 'every slice.',
  caption: 'The Metrics Diff shows each test\'s change: the int8 model is smaller everywhere, and much worse indoors.',
  actions: async ui => {
    await swapMetric(ui, viewCard(ui.page, 'Improvement report'), 'Latency per image', 'Model size');
    await ui.cursor.moveTo({ x: 1420, y: 880 });
  },
  target: page => viewCard(page, 'Improvement report'),
  padding: 0,
});

clip('commit/compare-tour', {
  project: DE,
  url: d => int8(d, { view: 'summary', filter: 'int8' }),
  alt: 'The Summary of the int8 runs against the fp32 release; a click on Metrics Diff in the sidebar shows each slice\'s '
    + 'change; in the Controls panel, sorting by mAP from the lowest brings the indoor slice, -35%, to the top.',
  caption: 'From the Summary to each test\'s change, sorted to bring the worst slice to the top.',
  actions: async ui => {
    await ui.plots();
    await ui.cursor.moveTo({ x: 700, y: 600 });
  },
  script: async ui => {
    const { page } = ui;
    await ui.caption('The Summary: int8 against the fp32 release');
    await ui.hold(2500);
    await ui.caption('The Metrics Diff: the change on each test');
    await ui.click(page.getByRole('link', { name: 'Metrics Diff' }).or(page.getByText('Metrics Diff', { exact: true })).first());
    await ui.settle();
    await ui.hold(2500);
    await ui.caption('Sort by mAP, the worst slice first');
    await ui.click(page.locator('[title="Toggle Controls Panel"]'));
    await ui.hold(400);
    // the Controls panel's Sorting: a select after each label
    const select = (label: string) => page.getByText(label, { exact: true }).last().locator('xpath=following::select[1]');
    await ui.cursor.moveTo(select('Sort By'));
    await select('Sort By').selectOption('map');
    await ui.settle();
    await ui.hold(600);
    await ui.cursor.moveTo(select('Order'));
    await select('Order').selectOption('1');
    await ui.settle();
    await ui.hold(600);
    await ui.click(page.locator('[title="Toggle Controls Panel"]'));
    await ui.settle();
    await ui.cursor.moveTo(viewCard(page, 'Improvement report').getByText('slices/indoor').first());
    await ui.hold(2500);
  },
});

shot('commit/milestone', {
  project: DE,
  url: d => d.commitUrl(DE, 'kd-1-3', { reference: 'kd-1-2', view: 'table-kpi' }),
  alt: 'The milestone dialog of the kd-1.3 release commit, opened from the crown next to its hash: Shared on, the label '
    + 'kd-1.3, the notes "int8, per-channel, recalibrated", and the Delete and Save buttons.',
  caption: 'A commit\'s star makes it a milestone: give it a label and notes, and share it with everyone on the project.',
  actions: async ui => {
    // the new commit's bar: a crown, it's a shared milestone
    await ui.click(ui.page.locator('button:has(.bp6-icon-crown)').first());
    await ui.page.locator('.bp6-popover', { hasText: 'Milestone Info' }).waitFor();
    await ui.settle();
    await ui.anchor('shared', ui.page.locator('.bp6-popover label', { hasText: 'Shared' }));
  },
  // the crown, and the dialog next to it
  target: page => [page.locator('button:has(.bp6-icon-crown)').first(), page.locator('.bp6-popover', { hasText: 'Milestone Info' })],
  padding: 8,
});

shot('commit/change-menu', {
  project: DE,
  url: d => d.commitUrl(DE, 'kd-1-3', { reference: 'kd-1-2', view: 'table-kpi' }),
  alt: 'The reference commit\'s Change menu: a project box, Switch new/reference, Also Select as New, Remove from '
    + 'comparison, then the reference branch main and the shared milestones kd-1.3 and kd-1.2 with their commits.',
  caption: 'Change the reference from its commit bar: swap new and reference, or pick the reference branch or a milestone.',
  actions: async ui => {
    await ui.hover(ui.page.locator('.bp6-navbar').nth(1).getByText('Change', { exact: true }));
    await ui.page.locator('.bp6-popover .bp6-menu', { hasText: 'Switch new/reference' }).waitFor();
    await ui.settle();
  },
  // the reference's hash and Change, and the menu under them
  target: page => [
    page.locator('.bp6-navbar').nth(1).locator('.bp6-input-group', { hasText: 'Change' }),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Switch new/reference' }),
  ],
  padding: 8,
});

shot('commit/run-badges', {
  project: DE,
  url: d => d.commitUrl(DE, 'kd-1-3', {
    reference: 'kd-1-2', view: 'output-list', filter: 'small-objects int8', controls: showOnly('Precision-recall'),
  }),
  alt: 'The header of a run card: the input slices/small-objects with its int8 and size-320 configuration tags, Config '
    + 'and Tuning tags in orange, then a "Model card kd-1.3" badge with a link icon next to the run\'s model parameter, '
    + 'and its metrics against the reference.',
  caption: 'Runs can return badges, like a link to the model card of the model they evaluated.',
  actions: async ui => {
    await showCard(ui);
    await mouseAway(ui);
    await ui.anchor('badge', cards(ui.page).first().getByText('Model card kd-1.3'));
  },
  // the card's header: its title and tags, the badges, the metrics (not its h5, as wide as the card)
  target: page => [
    cards(page).first().getByText('slices/small-objects', { exact: true }),
    cards(page).first().locator('.bp6-tag', { hasText: /^size-320$/ }).first(),
    cards(page).first().locator('.bp6-tag', { hasText: 'Model card kd-1.3' }),
    cards(page).first().locator('.bp6-tag', { hasText: 'model:' }).first(),
    cards(page).first().locator('.bp6-tag', { hasText: /^Latency/ }).first(),
  ],
  padding: 8,
});

shot('commit/plotly-overlay', {
  project: DE,
  url: d => int8(d, { filter: 'indoor int8', controls: showOnly('Precision-recall') }),
  alt: 'Precision-recall curves of the indoor slice, one per class: the int8 model\'s solid, the fp32 release\'s dashed '
    + 'in the same color. The legend gives each curve\'s AP50: person drops from 0.19 to 0.06.',
  caption: 'Plots of the reference are drawn over the new ones, dashed: here the int8 model\'s precision-recall curves '
    + 'over fp32\'s.',
  actions: async ui => {
    await showCard(ui);
    await ui.plots();
    await mouseAway(ui);
  },
  // the run's metrics, the plot's title and the plot
  target: page => [
    cards(page).first().locator('.bp6-tag', { hasText: /^mAP/ }).first(),
    cards(page).first().locator('.bp6-tag', { hasText: /^Latency/ }).first(),
    cards(page).first().locator('.js-plotly-plot').first(),
  ],
  padding: 8,
});

shot('commit/detections', {
  project: DE,
  // the first image of small-objects: int8 misses two people that fp32 finds (story_checks.py: misses_what_fp32_finds)
  url: d => int8(d, {
    filter: 'small-objects int8',
    controls: { ...showOnly('Detections'), dynamic_options: { image: ['1'] } },
  }),
  alt: 'A hall with people and cars pasted in, new and reference side by side: the int8 model (left) finds one of the '
    + 'people, the fp32 release (right) three. What each missed is outlined in red: two more people on the left; the faded '
    + 'person and the three cars on both.',
  caption: 'Each run draws its detections, ground truth in red where it missed: the int8 model misses two people fp32 finds.',
  // in full screen, each image is half as wide as the screen: at 2x, a little smaller than the photo (and its budget)
  viewport: { width: 840, height: 640 },
  actions: async ui => {
    // In full screen, the images fill the screen, whatever the cards' width (qaboard.yaml: outputs.style.width)
    await cards(ui.page).first().locator('[title="Enter Full Screen"]').evaluate(e => (e as HTMLElement).click());
    await ui.page.waitForFunction(() => !!document.fullscreenElement);
    await ui.settle();
    await ui.tiles();
    await ui.cursor.moveTo({ x: 830, y: 630 });
    await ui.settle();
  },
  // the images and their labels
  target: page => imageRow(page),
  padding: 0,
});

shot('commit/html-report', {
  project: DE,
  url: d => int8(d, { filter: 'small-objects int8', controls: showOnly('Report') }),
  alt: 'The int8 run\'s HTML report on small-objects: mAP 0.338, AP50 0.507, AP small 0.341, latency and model size; '
    + 'AP per class for person and car, AP and recall by object size, latency, then the images with the most missed '
    + 'objects, boxes drawn.',
  caption: 'Your code can write an HTML report: it shows in the run\'s card, here with the images where the model missed '
    + 'the most objects.',
  viewport: { width: 1440, height: 1400 },
  actions: async ui => {
    await showCard(ui);
    await mouseAway(ui);
    await ui.settle();
  },
  // the new run's report, down to the image with the most missed objects
  target: page => [
    page.frameLocator('iframe[title="report.html (new)"]').locator('h1'),
    page.frameLocator('iframe[title="report.html (new)"]').locator('figure').first(),
  ],
  padding: 8,
});

shot('commit/artifacts-configs', {
  project: DE,
  url: d => d.commitUrl(DE, 'int8-per-channel', { reference: 'int8-minmax', view: 'parameters', query: { params_artifact: 'build' } }),
  alt: 'Artifacts & Configurations of the per-channel commit against the first int8 commit: build/flags.json differs, '
    + 'and its diff shows quant_per_channel going from false to true.',
  caption: 'Artifacts saved by `qa save-artifacts` are diffed with the reference\'s: here the flags the model was built with.',
  actions: async ui => {
    // a file's diff with the reference's opens below the tree
    await ui.click(treeFile(ui.page, 'flags.json'));
    await ui.settle();
    await mouseAway(ui);
  },
  target: page => viewCard(page, 'Artifacts & Configurations'),
  padding: 0,
});



// The inference gateway (examples/serving-latency): the coding agent's shared result cache (cache-shared) holds its
// one lock while workers run the model and render responses, against its parent, batch-overflow-fix. Visualizations,
// in qaboard.yaml's order: 0 latency percentiles, 1 where the time goes, 2 latency over time, 3 throughput vs p99
// (ramp runs only), 4 CPU flame graph, then hidden by default: 5 CPU per core, 6 batch sizes, 7 latency histogram,
// 8 percentiles.txt
const SL = 'serving-latency';
const VIZ = {
  cdf: 'Latency percentiles (log tail)', breakdown: 'Where the time goes', timeline: 'Latency over time',
  sweep: 'Throughput vs p99', flame: 'CPU flame graph', cores: 'CPU per core', batches: 'Batch sizes',
  histogram: 'Latency histogram', percentiles: 'Percentiles',
} as const;
// Only these visualizations
const only = (...names: Array<keyof typeof VIZ>) => ({ show: Object.fromEntries(Object.entries(VIZ).map(([k, v]) => [v, names.includes(k as keyof typeof VIZ)])) });
const sharedCache = (d: Demo, filter: string, controls?: Record<string, unknown>) =>
  d.commitUrl(SL, 'cache-shared', { reference: 'batch-overflow-fix', view: 'output-list', filter, controls });
// A run card's input name, its tags and metrics are on the lines below
const runTitle = (page: Page, input: string) => cards(page).first().getByText(`profiles/${input}.yaml`, { exact: true });
// What a card shows of a visualization: its title and its plot (Plotly's title is in the plot)
const plotOf = (page: Page, index: number) => viewer(cards(page).first(), index).locator('.js-plotly-plot').first();

shot('commit/latency-cdf', {
  project: SL,
  url: d => sharedCache(d, 'steady-high', only('cdf')),
  alt: 'The steady-high run of the shared cache against its parent: p50 and p99 a hundred times the reference\'s or '
    + 'more. On log axes, the new line sits near a second from the median on, the reference\'s stays under the 12 ms '
    + 'SLO line until the far tail.',
  caption: 'Latency percentiles on a log tail: at 6,000 requests/s, with the shared cache every percentile is a hundred '
    + 'times slower or more. Requests queue for its lock.',
  actions: async ui => {
    await showCard(ui);
    await ui.plots();
    await mouseAway(ui);
  },
  target: page => [runTitle(page, 'steady-high'), plotOf(page, 0)],
  padding: 8,
});

shot('commit/throughput-p99', {
  project: SL,
  url: d => sharedCache(d, 'ramp', only('sweep')),
  alt: 'Throughput against p99 in the ramp run, from 20% to 120% of 6,000 requests/s: the reference\'s p99 stays low '
    + 'under the 12 ms SLO until the last steps; the shared cache\'s takes off well before full load, to hundreds of milliseconds.',
  caption: 'The ramp raises the load step by step: with the shared cache, p99 takes off at a lower throughput.',
  actions: async ui => {
    await showCard(ui);
    await ui.plots();
    await mouseAway(ui);
  },
  target: page => [runTitle(page, 'ramp'), plotOf(page, 3)],
  padding: 8,
});

shot('commit/flame-diff', {
  project: SL,
  url: d => sharedCache(d, 'steady-high', only('flame')),
  alt: 'A differential CPU flame graph of the steady-high run: in the workers and the ingress, the shared cache\'s '
    + 'respond and lookup, with the response rendering under them, are new, in orange; the model\'s forward pass, '
    + 'which runs less, is blue.',
  caption: 'A differential flame graph: rendering responses under the shared cache\'s lock is new (orange), and the '
    + 'model runs less (blue): cache hits skip it.',
  // the Controls panel's button sits on the viewport's edge: a wider window keeps it away from the flame graph
  viewport: { width: 1760, height: 1000 },
  actions: async ui => {
    await showCard(ui);
    await mouseAway(ui);
    await ui.settle();
  },
  // the run's name and metrics, the flame graph (narrower than the card) and the comparison picker under it
  target: page => [
    runTitle(page, 'steady-high'),
    viewer(cards(page).first(), 4).locator('.flame-graph svg').first(),
    viewer(cards(page).first(), 4).locator('select').first(),
  ],
  padding: 8,
});

shot('commit/core-heatmap', {
  project: SL,
  url: d => sharedCache(d, 'steady-high', only('cores', 'batches')),
  alt: 'Per-core CPU heatmaps of the steady-high run, new and reference side by side: with the shared cache the '
    + 'worker cores stay mostly idle, the reference\'s are busy. Below, the batch sizes overlaid: every new batch is full.',
  caption: 'With the shared cache, the gateway runs one batch at a time: its cores idle while requests queue, and every '
    + 'batch is full.',
  actions: async ui => {
    await showCard(ui);
    await ui.plots();
    await mouseAway(ui);
  },
  target: page => [runTitle(page, 'steady-high'), plotOf(page, 6)],
  padding: 8,
});

shot('commit/text-diff', {
  project: SL,
  url: d => sharedCache(d, 'steady-high', only('percentiles')),
  alt: 'HdrHistogram\'s percentile distribution of the steady-high run, reference and new side by side in a diff '
    + 'editor: from the median on, latencies go from 3 ms to over 500 ms.',
  caption: 'Text outputs are diffed with the reference; Next Diff jumps to the next change.',
  actions: async ui => {
    await showCard(ui);
    await mouseAway(ui);
  },
  // the file's name and buttons, and its first 20 lines, both sides: down to the reference's line 20, and as far right
  // as the new file's header line goes (the editors are as wide as the card, which fits the window: qaboard.yaml sets
  // no width)
  target: page => {
    const editor = (side: string) => viewer(cards(page).first(), 8).locator(`.${side}-in-monaco-diff-editor`);
    return [
      runTitle(page, 'steady-high'),
      editor('original').locator('.view-line', { hasText: '0.900000000000' }).first(),
      editor('modified').locator('.view-line > span', { hasText: 'TotalCount' }).first(),
    ];
  },
  // flush: no sliver of line 21
  padding: 2,
});

shot('commit/run-menu', {
  project: SL,
  url: d => sharedCache(d, 'steady-high', only('cdf')),
  alt: 'The menu of the steady-high run\'s card, open under its menu icon: Redo, Delete, and Delete Output Files.',
  caption: 'From a run\'s menu: redo it, delete it, or delete only its output files.',
  actions: async ui => {
    await showCard(ui);
    const card = cards(ui.page).first();
    await ui.hover(card.locator('.bp6-icon-menu').first());
    await ui.page.locator('.bp6-popover .bp6-menu', { hasText: 'Delete Output Files' }).waitFor();
    await ui.settle();
  },
  // the card's header: the run's name and its metrics, the menu under it
  target: page => [
    runTitle(page, 'steady-high'), cards(page).first().getByText('SLO miss', { exact: true }).locator('xpath=..'),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Delete Output Files' }),
  ],
  padding: 8,
});
