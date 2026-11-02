// The commit page (docs-media/shots.yaml: commit/*), on the camera ISP project (examples/image-quality).
// The story: a bilateral denoiser wins PSNR but adds halos along edges (merge-bilateral), against the isp-4.1 release.
import { clip, shot, type Demo, type Locator, type Page, type Ui } from './lib';
import { diffMax, imageRow, newImage, pixelValues, preset, stableBox, toolbar } from './imageViewer';

const IQ = 'image-quality';

// Run cards; in a card, the viewer of each visualization (Output first), with new and reference images
const cards = (page: Page) => page.locator('.output-card.bp6-card');
const viewer = (scope: Page | Locator, index = 0) => scope.locator(`[id="${index}-0"]`).first();
// The View options, docked on the right of the commit page (the user's choice is remembered: controls-panel-expanded)
const controlsPanel = (page: Page) => page.locator('aside[aria-label="View options"]');
// Its toggle: "Show the view options" on its rail, "Collapse the view options" when open
const PANEL_TOGGLE = 'button[aria-label$=" the view options"]';

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

// The mouse out of the viewers: the crosshairs go away
async function mouseAway(ui: Ui) {
  await ui.cursor.moveTo({ x: 1000, y: 140 });
  await ui.hold(500);
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
  alt: 'The View options docked on the right of the run cards: a switch per visualization, including the hidden Color '
    + 'errors and Noise vs signal, how image viewers compare images, and how the runs are sorted.',
  caption: 'The View options show or hide visualizations, pick how images are compared, and sort the runs.',
  actions: async ui => {
    const panel = controlsPanel(ui.page);
    // fold Files to show, so that Sort runs fits
    await ui.click(panel.getByRole('button', { name: 'Files to show', exact: true }));
    // the click leaves a focus ring on the button, drawn in the dark theme
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.hold(400);
    await ui.anchor('visualizations', panel.getByRole('button', { name: 'Visualizations', exact: true }));
    await ui.anchor('image-diff', panel.getByText('Compare images', { exact: true }));
    await ui.anchor('sorting', panel.getByRole('button', { name: 'Sort runs', exact: true }));
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
  url: d => halos(d, 'photos/facade base', { image_mode: 'difference' }),
  // the difference's colormap runs from yellow (a little) through orange and purple to black (its maximum and more);
  // where the images don't differ, a faded copy of the image shows, almost white
  alt: 'The facade window, new and reference on each side of their perceptual difference: the window frame\'s edges '
    + 'stand out, from yellow through orange and purple to black where they differ most, the flat wall fades to white. '
    + 'Above them, the comparison modes and the difference\'s settings.',
  caption: 'The difference shows between the images where they differ; raise its maximum until only the halos stand out.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    await diffMax(ui, viewer(ui.page), 0.2);
    await mouseAway(ui);
  },
  target: page => [toolbar(viewer(page)), imageRow(viewer(page))],
  padding: 4,
});

shot('commit/pixel-tooltip', {
  project: IQ,
  url: d => compare(d, 'bilateral-denoise', 'isp-4-1', 'charts/siemens-star base linux'),
  alt: 'The center of a Siemens star, new and reference: above the images, the hovered pixel\'s coordinates, its values '
    + 'in both images and their difference; a crosshair marks the pixel on both images.',
  caption: 'Hover a pixel: its values in both images and their difference show above them, and a crosshair marks the same spot on both images.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Center (aliasing)');
    // on a spoke's edge, where the denoisers differ
    await ui.hover(newImage(viewer(ui.page)), { position: await hoverImage(ui, viewer(ui.page), { x: 21, y: 30 }) });
    await ui.settle();
  },
  target: page => [pixelValues(viewer(page)), imageRow(viewer(page))],
  padding: 4,
});

shot('commit/roi-histograms', {
  project: IQ,
  url: d => halos(d, 'photos/sky-gradient low-light'),
  alt: 'Zoomed on a band of the sky gradient; below the images, the red, green, blue and luma histograms of what they '
    + 'show, new and reference overlaid.',
  caption: 'Zoom on a region to compare its histograms, new against reference.',
  // the images and the histograms under them
  viewport: { width: 1440, height: 1200 },
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Full Image');
    // a band of the sky, where the gradient's banding shows
    await zoom(ui, scope, { x: 40, y: 30 }, 3);
    await ui.click(scope.getByRole('button', { name: 'Histogram of the view' }));
    await mouseAway(ui);
    await ui.settle();
  },
  target: page => [pixelValues(viewer(page)), imageRow(viewer(page)), viewer(page).locator('.qiv-histogram').first()],
  padding: 4,
});

shot('commit/auto-roi', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'The regions of interest menu open over the facade run: Full image, the input\'s Presets, and the regions where '
    + 'the images differ most, found by the server; above the images, thumbnails of the regions it found, labelled with '
    + 'how much the images differ there.',
  caption: 'Jump between the regions of interest preset for the input, or let QA-Board find where the images differ most.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    const menu = scope.getByRole('button', { name: 'Regions of interest' });
    await ui.click(menu);
    await ui.click(ui.page.getByRole('menuitem', { name: /^Where they differ: perceptual/ }));
    await scope.locator('.qiv-regions .qiv-region').nth(1).waitFor({ state: 'visible', timeout: 60_000 });
    await ui.settle();
    // the menu again, over the regions found
    await mouseAway(ui);
    await ui.click(menu);
    await ui.settle();
  },
  // the run's name and metrics, the menu, and the thumbnails of the regions found
  target: page => [
    cards(page).first().getByText('photos/facade.png', { exact: true }),
    viewer(page).locator('.qiv-popover').first(),
    viewer(page).locator('.qiv-regions').first(),
  ],
  padding: 4,
});

shot('commit/regions-all-runs', {
  project: IQ,
  url: d => halos(d, 'base'),
  alt: 'The list of a commit\'s runs ranked by how much their output images differ from the reference\'s, with a bar, '
    + 'a percentage and the number of regions found for each; the 113 MP test wall, a TIFF, has no out.png to compare.',
  caption: 'Where they differ, in all the runs: the runs whose images changed most first.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await ui.click(scope.getByRole('button', { name: 'Regions of interest' }));
    await ui.click(ui.page.getByRole('menuitem', { name: /^Where they differ, in all \d+ runs/ }));
    // the server reads each image once: the test wall (113 MP) takes a few seconds
    await ui.page.waitForFunction(() => {
      const progress = document.querySelector('.bp6-dialog')?.textContent?.match(/(\d+) \/ (\d+)/);
      return !!progress && progress[1] === progress[2];
    }, null, { timeout: 180_000 });
    await mouseAway(ui);
    await ui.settle();
  },
  // a box: the dialog is centered over the commit bars, that crops to elements leave out
  target: async page => {
    const dialog = await stableBox(page.locator('.bp6-dialog').first());
    return { x: dialog.x - 8, y: dialog.y - 8, width: dialog.width + 16, height: dialog.height + 16 };
  },
});

shot('commit/image-filters', {
  project: IQ,
  url: d => halos(d, 'photos/night-street low-light'),
  alt: 'The display adjustments open over the night street\'s shadows, with brightness and gamma raised: the noise of '
    + 'both images shows.',
  caption: 'Adjustments apply to both images at once: here brightness and gamma reveal the noise in the shadows.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Shadows (noise)');
    await ui.click(scope.getByRole('button', { name: /^Adjust the display/ }));
    const slider = (name: string) => scope.locator('.qiv-slider', { hasText: name }).locator('input[type="range"]');
    // keyboard on the range inputs: a click would jump to where it lands
    await slider('Brightness').focus();
    await ui.press('PageUp');
    await slider('Gamma').focus();
    for (let i = 0; i < 12; i++) await ui.press('ArrowRight');
    await ui.hover(newImage(scope), { position: await hoverImage(ui, scope, { x: 60, y: 45 }) });
    await ui.settle();
  },
  // the run's name and metrics, and the viewer
  target: page => [cards(page).first().getByText('photos/night-street.png', { exact: true }), viewer(page)],
  padding: 4,
});

shot('commit/blind-test', {
  project: IQ,
  url: d => halos(d, 'photos/facade base'),
  alt: 'A blind test on the leaves over the facade\'s window: the two images side by side, labelled A and B in gray '
    + 'instead of new and reference, and so are the hovered pixel\'s values above them; in the toolbar, Reveal shows '
    + 'which is which.',
  caption: 'A blind test hides which image is which: A and B, in a random order, until you click Reveal.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Leaves over a window');
    // The test shows each viewer's images in a random order (QaboardImageViewer.jsx: the test's seed): the same coin
    // in every capture, the app's own order for it. Math.random is the page's again right after the click
    await ui.page.evaluate(() => {
      const w = window as unknown as { __shotRandom?: () => number };
      w.__shotRandom = Math.random;
      Math.random = () => 0.37;
    });
    await ui.click(scope.getByRole('button', { name: 'Blind test', exact: true }));
    await ui.page.evaluate(() => {
      const w = window as unknown as { __shotRandom?: () => number };
      if (w.__shotRandom) Math.random = w.__shotRandom;
    });
    await scope.getByRole('button', { name: 'Reveal', exact: true }).waitFor();
    // a pixel on a leaf's edge: its values, for A and B
    await ui.hover(newImage(scope), { position: await hoverImage(ui, scope, { x: 45, y: 50 }) });
    await ui.settle();
  },
  target: page => [toolbar(viewer(page)), pixelValues(viewer(page)), imageRow(viewer(page))],
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
  alt: 'Zooming into the new image of the facade, the reference follows; a wipe across them; then their difference '
    + 'between them, whose maximum goes up until only the window frame\'s halos stand out.',
  caption: 'Synced zoom, a wipe, then the difference between the images, and its maximum.',
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
    await ui.caption('Wipe across them');
    await ui.click(scope.getByRole('radio', { name: 'Wipe' }));
    await ui.settle();
    const divider = scope.getByRole('separator', { name: 'Wipe' });
    const stage = await stableBox(imageRow(scope));
    const from = (await divider.boundingBox())!;
    await ui.drag(divider, { x: stage.x + stage.width * 0.25, y: from.y + from.height / 2 });
    await ui.drag(divider, { x: stage.x + stage.width * 0.75, y: from.y + from.height / 2 });
    await ui.hold(1000);
    await ui.caption('Their difference shows what changed');
    await ui.click(scope.getByRole('radio', { name: 'Difference' }));
    await ui.settle();
    await ui.hold(1500);
    await ui.caption('A higher maximum keeps only the halos');
    await diffMax(ui, scope, 0.2);
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

    await ui.caption('Single: press t to flip them in place');
    await ui.click(ui.page.getByRole('radio', { name: 'Single' }));
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

// The video viewer of the aisle's card (webapp/src/viewers/videos/): its toolbar, the line with the hovered pixel's
// values, the videos, then the transport and the timeline
const videoViewer = (page: Page) => page.locator('.qaboard-video-viewer').first();
const videoBatch = (d: Demo) => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', batch: 'video', batch_ref: 'video' });
// The aisle's card right below the commit bars, both videos loaded
async function showVideos(ui: Ui) {
  await showCard(ui);
  await ui.page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 2));
}
// Both videos `count` frames further, paused (the keys act on the viewer under the mouse)
async function stepFrames(ui: Ui, count: number) {
  await ui.hover(videos(ui.page));
  for (let i = 0; i < count; i++) await ui.press('ArrowRight');
  await ui.settle();
}

shot('commit/video-differences', {
  project: IQ,
  url: videoBatch,
  storage: { 'qaboard:video-viewer:mode': '"side-by-side"' },
  alt: 'The aisle video, new and reference side by side, on the frame where they differ most, a badge saying both show '
    + 'it; above the timeline, a bar per frame, taller and darker where they differ more, and a summary of the '
    + 'comparison; the regions menu lists Differences, whole video.',
  caption: 'Differences compares every decoded frame on the server: how much each frame differs, over the timeline, and '
    + 'where and when they differ most.',
  actions: async ui => {
    const viewer = videoViewer(ui.page);
    await showVideos(ui);
    // the server decodes and compares the 72 frames of both videos: about a second
    await ui.click(viewer.getByRole('button', { name: 'Differences', exact: true }));
    const summary = viewer.locator('.video-difference-summary');
    await summary.waitFor({ timeout: 60_000 });
    await ui.settle();
    // "Differ in 72 of 72 frames · most at frame 12 (Δ 99, PSNR 31.0 dB)": both videos on that frame, as decoded
    const most = Number(/most at frame (\d+)/.exec(await summary.textContent() ?? '')?.[1] ?? 0);
    await stepFrames(ui, most);
    await viewer.locator('.video-frame-badge', { hasText: new RegExp(`Frame ${most} · both`) }).waitFor();
    await mouseAway(ui);
    // the regions where and when they differ most, found by the same comparison
    await ui.click(viewer.getByRole('button', { name: 'Regions of interest' }));
    await ui.page.getByRole('menuitem', { name: /^Differences, whole video/ }).waitFor();
    await ui.settle();
  },
  target: page => videoViewer(page),
  padding: 4,
});

shot('commit/video-properties', {
  project: IQ,
  url: videoBatch,
  // the panel under the toolbar, as high as it gets (640 px)
  viewport: { width: 1440, height: 1100 },
  alt: 'What\'s in the files, open over the aisle video: new and reference side by side, both VP9, yuv420p, 8-bit with '
    + 'chroma 4:2:0, their color range, 24 fps, 72 frames, keyframes and bit rate, the frames the browser showed and '
    + 'dropped; the rows that differ highlighted; notes below.',
  caption: 'What\'s in the files: codecs, pixel formats, color range, frame rates, keyframes, and what differs between '
    + 'the two files.',
  actions: async ui => {
    const viewer = videoViewer(ui.page);
    await showVideos(ui);
    // frames decoded, for the browser's row
    await stepFrames(ui, 12);
    await mouseAway(ui);
    await ui.click(viewer.getByRole('button', { name: 'What\'s in the files', exact: true }));
    // the server read both files: a column for each
    await viewer.locator('.video-info-panel tr', { hasText: 'Pixel format' }).waitFor();
    await ui.settle();
  },
  // the button and its panel
  target: page => [
    videoViewer(page).getByRole('button', { name: 'What\'s in the files', exact: true }),
    videoViewer(page).locator('.qiv-popover', { has: page.locator('.video-info-panel') }),
  ],
  padding: 8,
});


// The commit bars, fixed at the top of the page: the new commit's, then the reference's. On the right of each, the
// filter box with the counters under it, then the batch selector.
const filterBox = (page: Page, type: 'new' | 'ref') =>
  page.locator('.bp6-form-group', { has: page.locator(`input#filter-${type}-input`) });
const barRight = (page: Page, type: 'new' | 'ref') =>
  page.locator('.bp6-navbar-group', { has: page.locator(`input#filter-${type}-input`) });
// The View options' Files to show: one entry per option, here the ISP stage
const dynamicOptions = (page: Page) => controlsPanel(page).locator('section', { has: page.getByRole('button', { name: 'Files to show', exact: true }) });

shot('commit/batch-picker', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'bilateral-denoise', { reference: 'isp-4-1', view: 'output-list' }),
  alt: 'The new commit\'s batch selector open: the CI batch, run by ci, 18 of 18 runs successful; ines 🏠 ines-halo, '
    + 'Ines\'s local runs, 5 of 5; and the tune-denoise tuning experiment, 60 of 60.',
  caption: 'Each commit can have several batches: CI\'s, your local runs (🏠) and tuning experiments. Pick one to see '
    + 'its runs.',
  actions: async ui => {
    await ui.click(barRight(ui.page, 'new').getByRole('button', { name: /^Batch:/ }));
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
    await ui.type(ui.page.locator('input#filter-new-input'), 'low-light -gradient');
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  // the filter box and its counters, and the table of the runs left
  target: page => [filterBox(page, 'new'), viewCard(page, 'Metrics Table')],
  padding: 8,
});

shot('commit/export', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', filter: 'photos low-light' }),
  alt: 'The filter box with "photos low-light" and 4 outputs; below, the Export button opened on a box with the pattern '
    + '*.png, the Windows and Linux paths of the export folder, and "8 files exported from 4 runs".',
  caption: 'Export gathers the files matching a pattern from the filtered runs into one folder, as links.',
  actions: async ui => {
    // the button next to the view's title opens the export box
    await ui.click(ui.page.getByRole('button', { name: 'Export files', exact: true }));
    const box = ui.page.locator('.bp6-popover', { has: ui.page.getByLabel(/Files to export/) });
    await ui.click(box.getByRole('button', { name: 'Export', exact: true }));
    await ui.page.getByText(/files exported from/).waitFor();
    await ui.settle();
    await ui.cursor.moveTo({ x: 1300, y: 860 });
  },
  // the commit bars' filter box, the Export button and its box
  target: page => [
    filterBox(page, 'new'),
    page.getByRole('button', { name: 'Export files', exact: true }),
    page.locator('.bp6-popover', { has: page.getByLabel(/Files to export/) }),
  ],
  padding: 8,
});

// Several references (webapp/src/components/ReferenceTabs.jsx): tabs below the commit bars, one compared at a time.
// The URL stacks them (webapp/src/selection.js): `reference` is the one shown, `compare` the others
const referenceTabs = (page: Page) => page.getByRole('tablist', { name: 'References' });
const tabTooltip = (page: Page) => page.locator('.bp6-tooltip', { hasText: 'reference 2' });

shot('commit/reference-tabs', {
  project: IQ,
  // the merge against the release before it, and against the head of main at T0 (story.yaml: chroma-low-light)
  url: d => d.commitUrl(IQ, 'merge-bilateral', {
    reference: 'isp-4-1', view: 'table-kpi', query: { compare: d.sha(IQ, 'chroma-low-light') },
  }),
  alt: 'The bilateral denoiser\'s merge with two references stacked: under the bars, the tabs show the top results, '
    + 'then, after vs, the isp-4.1 milestone, shown, and ref 2, hovered: its tooltip gives its commit on main, its '
    + 'author, message and batch, still running.',
  caption: 'Stack several references: their tabs hang below the bars, click one, or press r, to compare with it.',
  actions: async ui => {
    await referenceTabs(ui.page).waitFor();
    // what a tab is, on hover
    await ui.hover(referenceTabs(ui.page).getByRole('tab', { name: /^Reference 2:/ }));
    await tabTooltip(ui.page).waitFor();
    await ui.settle();
  },
  // a box: the bars and the tabs are fixed at the top, from the sidebar's edge (the top results' tab, before "vs" and
  // the references, starts 14 px after it), down to the tooltip under the tabs
  target: async page => {
    const top = await stableBox(page.locator('.qa-tabs-top'));
    const strip = await stableBox(referenceTabs(page).locator('xpath=..'));
    const tooltip = await stableBox(tabTooltip(page));
    const x = Math.max(0, Math.floor(top.x - 14));
    const bottom = Math.max(strip.y + strip.height, tooltip.y + tooltip.height) + 8;
    return { x, y: 0, width: strip.x + strip.width - x, height: bottom };
  },
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
  alt: 'The View options\' Files to show: the stage option, synced, its slider on 3. Next to it, the night street\'s '
    + 'card shows stages/3.jpg, the denoised image, new and reference.',
  caption: 'Files to show picks the file each card shows, here the ISP stage. Synced, one slider drives every run.',
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
  alt: 'The stage slider of the View options steps from the raw sensor mosaic to the tone-mapped image of the facade\'s '
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

// The image viewer's comparison tools (user-guide/image-viewer): the modes, another file of the run, the values written
// on the pixels, the analysis panel under the images (histogram, profiles, statistics, a raw image's own values), full
// screen. In Wipe and Single, one image takes the width of the card: 1094x729 px, which takes a 1020 px high window
// (the viewer is at most its height − 260 px), else it's narrower.
const TALL = { width: 1440, height: 1020 };
const ISP_STAGE = 'ISP stage (1 raw, 2 demosaic, 3 denoise, 4 sharpen, 5 tone map)';
const analysisPanel = (scope: Page | Locator) => scope.locator('.qiv-analysis').first();
// The viewer's toolbar right below the commit bars, out of the mouse's way
async function showToolbar(ui: Ui, scope: Locator) {
  await toolbar(scope).evaluate(element => window.scrollBy(0, element.getBoundingClientRect().top - 158));
  await ui.settle();
}
// Opens the analysis panel under the images on one of its views
async function openAnalysis(ui: Ui, scope: Locator, view: 'Histogram' | 'Row / column' | 'Statistics') {
  await ui.click(scope.getByRole('button', { name: /the analysis of the view/ }));
  await ui.click(analysisPanel(scope).getByRole('radio', { name: view, exact: true }));
  await blur(ui);
}
// The images and the analysis panel under them, as a box: on the sides, the card's padding (the histogram's first label
// is centered on its edge). The page must show the panel's bottom (panelInView): boxes aren't scrolled to.
async function imagesAndPanel(scope: Locator) {
  const stage = await stableBox(imageRow(scope));
  const panel = await stableBox(analysisPanel(scope));
  return { x: stage.x - 5, y: stage.y, width: stage.width + 10, height: panel.y + panel.height + 4 - stage.y };
}
async function panelInView(ui: Ui, scope: Locator) {
  await analysisPanel(scope).evaluate(element => window.scrollBy(0, element.getBoundingClientRect().bottom - window.innerHeight + 8));
  await ui.settle();
}
// No focus ring left on what was clicked
async function blur(ui: Ui) {
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ui.settle();
}
// The mouse on an empty part of the sidebar: over the commit bars, it would show the reference's Stack a reference tab
async function mouseOff(ui: Ui) {
  await ui.cursor.moveTo({ x: 100, y: 790 });
  await ui.hold(300);
}
// The pixel of the new image the line above the images gives, for the last pixel hovered
async function hoveredPixel(scope: Locator) {
  const text = await pixelValues(scope).innerText();
  const match = /x (\d+)\s+y (\d+)/.exec(text);
  if (!match) throw new Error(`[commit] no hovered pixel in "${text}"`);
  return { x: Number(match[1]), y: Number(match[2]) };
}
// Hovers the pixel (x, y) of the new image: two hovers measure where the image is and how large its pixels are, then
// the pointer goes to the pixel, closer each time. Returns its position in the new image's box.
async function hoverPixel(ui: Ui, scope: Locator, x: number, y: number) {
  const box = await stableBox(newImage(scope));
  let position = { x: box.width * 0.25, y: box.height * 0.25 };
  await ui.hover(newImage(scope), { position });
  const first = await hoveredPixel(scope);
  await ui.hover(newImage(scope), { position: { x: box.width * 0.75, y: box.height * 0.75 } });
  const second = await hoveredPixel(scope);
  // screen px per image px
  const scale = (box.width * 0.5) / (second.x - first.x);
  let at = first;
  for (let i = 0; i < 4 && (at.x !== x || at.y !== y); i++) {
    position = { x: position.x + (x - at.x) * scale, y: position.y + (y - at.y) * scale };
    await ui.hover(newImage(scope), { position });
    at = await hoveredPixel(scope);
  }
  if (at.x !== x || at.y !== y) throw new Error(`[commit] hovered ${at.x},${at.y} instead of ${x},${y}`);
  return position;
}
// Zooms the viewers with the mouse wheel at a point of the new image (in its box), until about `percent`
async function zoomTo(ui: Ui, scope: Locator, position: { x: number; y: number }, percent: number) {
  const zoom = Number((await scope.locator('.qiv-zoom').first().innerText()).replace('%', ''));
  // OpenSeadragon zooms by 1.2 per wheel step
  const steps = Math.round(Math.log(percent / zoom) / Math.log(1.2));
  await ui.wheel(newImage(scope), -100 * steps, { steps, position });
  await ui.settle();
}

shot('commit/image-wipe', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { image_mode: 'wipe', show: { [ISP_STAGE]: false } }),
  viewport: TALL,
  alt: 'The comparison modes above the facade\'s leaves, Wipe selected: one image, new on the left of a divider, the '
    + 'reference on its right; dark rims outline the leaves left of the divider only.',
  caption: 'Wipe shows new and reference in one image, on each side of a divider you drag.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showToolbar(ui, scope);
    await preset(ui, scope, 'Leaves over a window');
    await showToolbar(ui, scope);
    await mouseOff(ui);
  },
  target: page => [toolbar(viewer(page)), imageRow(viewer(page))],
  padding: 4,
});

clip('commit/image-compare-modes', {
  project: IQ,
  // the difference's maximum at 20%: the noise fades out, the halos stay
  url: d => halos(d, 'photos/facade base', { show: { [ISP_STAGE]: false }, image_diff: { method: 'perceptual', max: 0.2 } }),
  viewport: TALL,
  alt: 'The facade\'s leaves, new and reference side by side; then Wipe, its divider dragged left and right; Single, the '
    + 'image flipping between new and reference in place; Difference between them, then the difference alone, larger: '
    + 'only the rims of the leaves stand out.',
  caption: 'The four ways to compare: side by side, wipe, single (t flips the images), and their difference.',
  actions: async ui => {
    const scope = viewer(ui.page);
    // The viewer stays where it is whatever the mode: side by side and between the images, the stage is half as high,
    // and the page too short to scroll it to the top. Blank space above the footer, and no scroll anchoring
    await ui.page.evaluate(() => {
      const footer = document.querySelector('footer');
      if (footer) footer.style.marginTop = '1000px';
      document.documentElement.style.overflowAnchor = 'none';
    });
    await showToolbar(ui, scope);
    await preset(ui, scope, 'Leaves over a window');
    await showToolbar(ui, scope);
    await mouseOff(ui);
  },
  // the toolbar, and the images at their largest: one image, as wide as the card
  region: async page => {
    const bar = await stableBox(toolbar(viewer(page)));
    const stage = await stableBox(imageRow(viewer(page)));
    const height = stage.y - bar.y + Math.round(stage.width / 1.5) + 12;
    return { x: stage.x - 8, y: bar.y - 6, width: stage.width + 16, height };
  },
  poster: 3500,
  script: async ui => {
    const scope = viewer(ui.page);
    const mode = (name: string) => scope.getByRole('radio', { name, exact: true });
    await ui.caption('Side by side (1): new and reference');
    await ui.cursor.moveTo(newImage(scope));
    await ui.hold(1000);

    await ui.caption('Wipe (2): drag the divider across them');
    await ui.click(mode('Wipe'));
    await ui.settle();
    const divider = scope.getByRole('separator', { name: 'Wipe' });
    const stage = await stableBox(imageRow(scope));
    const from = (await divider.boundingBox())!;
    const y = from.y + from.height / 2;
    await ui.drag(divider, { x: stage.x + stage.width * 0.3, y });
    await ui.drag(divider, { x: stage.x + stage.width * 0.62, y });
    await ui.hold(400);

    await ui.caption('Single (3): t flips them in place');
    await ui.click(mode('Single'));
    await ui.settle();
    await ui.cursor.moveTo({ x: stage.x + stage.width * 0.6, y: stage.y + stage.width / 1.5 * 0.45 });
    await ui.hold(300);
    for (let i = 0; i < 4; i++) {
      await ui.press('t');
      await ui.hold(500);
    }

    await ui.caption('Difference (4): where they differ');
    await ui.click(mode('Difference'));
    await ui.settle();
    await ui.hold(1300);
    await ui.caption('4 again: the difference alone, larger');
    await ui.cursor.moveTo({ x: stage.x + stage.width * 0.6, y: stage.y + stage.width / 1.5 * 0.45 });
    await ui.press('4');
    await ui.settle();
    await ui.hold(2000);
  },
});

shot('commit/image-vs-file', {
  project: IQ,
  // the ISP's sharpening stage: stages/4.jpg
  url: d => stages(d, 'photos/facade base linux', 4),
  alt: 'The sharpened stage of the facade, stages/4.jpg, compared with the denoised one of the same run, stages/3.jpg, on '
    + 'a teal label; the vs stages/3.jpg menu open lists the reference, isp-4.1, then the run\'s other images with '
    + 'thumbnails, stages/3.jpg checked, and Apply to: All runs or This run.',
  caption: 'vs ▾ compares an image with another file of the run, here the sharpened stage with the denoised one, '
    + 'instead of the reference.',
  actions: async ui => {
    const scope = viewer(ui.page, 1);
    await showToolbar(ui, scope);
    await preset(ui, scope, 'Leaves over a window');
    const vs = scope.getByRole('button', { name: /^vs / });
    await ui.click(vs);
    await ui.click(scope.locator('.qiv-popover').getByText('stages/3.jpg', { exact: true }));
    await ui.settle();
    // the menu again, on the image picked
    await ui.click(vs);
    await ui.settle();
  },
  target: page => [toolbar(viewer(page, 1)), imageRow(viewer(page, 1)), viewer(page, 1).locator('.qiv-popover').first()],
  padding: 4,
});

// On the facade, where the leaves cross the window: a dark rim, near black in the new image (12), dark gray in the
// reference (63)
const RIM = { x: 698, y: 120 };

shot('commit/pixel-values', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { show: { [ISP_STAGE]: false } }),
  alt: 'The leaves\' rim zoomed in to 5000%, new and reference side by side, each pixel with its red, green and blue '
    + 'values written on it; above, the hovered pixel\'s values in both images; the 123 menu open: Image values, '
    + 'Displayed values or Off.',
  caption: 'Zoomed in, the values are written on the pixels: here the dark rim along a leaf, near black in the new image. '
    + 'The 123 button picks the image\'s own values or the displayed ones.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Leaves over a window');
    const position = await hoverPixel(ui, scope, RIM.x, RIM.y);
    await zoomTo(ui, scope, position, 5000);
    await hoverPixel(ui, scope, RIM.x, RIM.y);
    // the values arrive by tiles of 64x64 pixels
    await scope.locator('.qiv-values-badge').filter({ hasText: /^Values: image/ }).waitFor();
    await ui.page.waitForFunction(() => !document.querySelector('.qiv-values-badge .qiv-spinner'));
    await ui.click(scope.getByRole('button', { name: 'Pixel values' }));
    await ui.settle();
  },
  target: page => [toolbar(viewer(page)), imageRow(viewer(page)), viewer(page).locator('.qiv-popover').first()],
  padding: 4,
});

// The darkest values: the rims the new image clips to black
const RANGE_MAX = 12;

shot('commit/histogram-range', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { show: { [ISP_STAGE]: false } }),
  alt: 'The facade\'s leaves side by side, stripes over their darkest pixels; under them the histogram of the luma (Y), '
    + 'new solid and reference dashed, the range 0 to 12 highlighted, and how much of each image is in it.',
  caption: 'Drag on the histogram: stripes mark the pixels in the range, here the darkest, and the share of each image '
    + 'in it shows below.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showToolbar(ui, scope);
    await preset(ui, scope, 'Leaves over a window');
    // closer on the leaves at the top right of the region, where the rims are darkest (like commit/image-sbs)
    await zoom(ui, scope, { x: 82, y: 42 }, 4);
    await openAnalysis(ui, scope, 'Histogram');
    await ui.click(analysisPanel(scope).getByRole('button', { name: 'Y', exact: true }));
    const plot = analysisPanel(scope).getByRole('slider', { name: /^Histograms of the displayed images/ });
    const box = await stableBox(plot);
    const at = (value: number) => ({ x: box.x + box.width * (value + 0.5) / 256, y: box.y + box.height * 0.6 });
    await ui.drag(at(0), at(RANGE_MAX));
    await blur(ui);
    await mouseOff(ui);
    await panelInView(ui, scope);
  },
  target: page => imagesAndPanel(viewer(page)),
});

// The slanted edge's left side, near vertical, halfway down: bright on the left, dark on the right
const EDGE = { x: 366, y: 408 };

shot('commit/image-profiles', {
  project: IQ,
  // without the edge's plots: they make the card wider than the page (under the View options' rail)
  url: d => halos(d, 'charts/slanted-edge base', { show: { [ISP_STAGE]: false, 'Edge profile': false, MTF: false } }),
  alt: 'The slanted edge zoomed in, new and reference side by side, a crosshair on the edge; under them, the profiles of '
    + 'the row and column under the pointer: across the edge, the new image (solid) dips lower on the dark side and '
    + 'rises higher on the bright side than the reference (dashed).',
  caption: 'Profiles of the row and column under the pointer: across the edge, the new image overshoots on both sides, '
    + 'the halos the sharpening adds.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showToolbar(ui, scope);
    await preset(ui, scope, 'Measured edge');
    await openAnalysis(ui, scope, 'Row / column');
    await analysisPanel(scope).getByLabel('Profiles of').selectOption('pointer');
    await blur(ui);
    // on the edge, halfway down the view (examples/image-quality/qa/make_charts.py), closer: about 70 pixels across
    const position = await hoverPixel(ui, scope, EDGE.x, EDGE.y);
    await zoomTo(ui, scope, position, 800);
    // the page won't scroll to the shot anymore: that would move the image from under the pointer, and the crosshairs
    // and the profiles' markers with it
    await panelInView(ui, scope);
    await hoverPixel(ui, scope, EDGE.x, EDGE.y);
    await ui.settle();
  },
  target: page => [pixelValues(viewer(page)), imageRow(viewer(page)), analysisPanel(viewer(page))],
  padding: 4,
});

shot('commit/image-stats', {
  project: IQ,
  url: d => halos(d, 'charts/flat-gray low-light', { show: { [ISP_STAGE]: false } }),
  alt: 'The flat gray chart in low light at 100%, new and reference side by side, the reference visibly noisier; under '
    + 'them the statistics per channel: the new image\'s standard deviation is about half the reference\'s, its SNR '
    + 'about 6 dB higher in luma.',
  caption: 'Statistics of the view, per channel: on a flat gray in low light, the new denoiser halves the standard '
    + 'deviation, a 6 dB better SNR.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showToolbar(ui, scope);
    // every pixel: zoomed out, a screen pixel averages several and hides some noise
    await ui.click(scope.getByRole('button', { name: '1:1', exact: true }));
    await openAnalysis(ui, scope, 'Statistics');
    await mouseOff(ui);
    await panelInView(ui, scope);
  },
  target: page => imagesAndPanel(viewer(page)),
});

shot('commit/image-raw-values', {
  project: IQ,
  // the raw sensor data, as the fixed-point model saves it: a PNG where each pixel has one of R, G and B. It's the same in
  // both commits: one image
  url: d => d.commitUrl(IQ, 'merge-bilateral', {
    reference: 'isp-4-1', view: 'output-list', filter: 'photos/facade hw-model',
    controls: { show: { Output: false, [ISP_STAGE]: false }, dynamic_options: { stage: ['1'] } },
  }),
  alt: 'The raw mosaic of the facade\'s window, red, green and blue pixels; under it, Image values picked in the analysis '
    + 'panel: a card shows RGGB Bayer with a diagram, 8-bit, guessed from the pixels, and the statistics of R, Gr, Gb '
    + 'and B with the ratios R/G, B/G and Gr/Gb.',
  caption: 'Image values analyzes a raw image per channel of its color filter array: the card shows the pattern it '
    + 'found, the table each channel\'s statistics.',
  actions: async ui => {
    const scope = viewer(ui.page, 2);
    await showToolbar(ui, scope);
    // closer, until each pixel of the mosaic is a square of its color: about 10 screen pixels
    const box = await stableBox(newImage(scope));
    await zoomTo(ui, scope, { x: box.width / 2, y: box.height / 2 }, 1000);
    await openAnalysis(ui, scope, 'Statistics');
    await ui.click(analysisPanel(scope).getByRole('radio', { name: 'Image values', exact: true }));
    await analysisPanel(scope).getByText('Gr/Gb').waitFor({ timeout: 30_000 });
    await blur(ui);
    await mouseOff(ui);
    await panelInView(ui, scope);
  },
  // the bottom of the mosaic, and the panel under it
  target: async page => {
    const stage = await stableBox(imageRow(viewer(page, 2)));
    const panel = await stableBox(analysisPanel(viewer(page, 2)));
    const top = stage.y + stage.height - 200;
    return { x: panel.x - 4, y: top, width: panel.width + 8, height: panel.y + panel.height + 4 - top };
  },
});

shot('commit/image-fullscreen', {
  project: IQ,
  url: d => halos(d, 'photos/facade base', { show: { [ISP_STAGE]: false } }),
  alt: 'The image viewer in full screen: its toolbar, the facade\'s leaves side by side, new and reference, as large as '
    + 'the screen allows, and the profiles of the view\'s columns and rows under them.',
  caption: 'Full screen gives the screen to the images, with the toolbar, and the analysis panel under them.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Leaves over a window');
    await openAnalysis(ui, scope, 'Row / column');
    await ui.click(scope.getByRole('button', { name: 'Full screen (f)' }));
    await ui.page.waitForFunction(() => !!document.fullscreenElement);
    await preset(ui, scope, 'Leaves over a window');
    await ui.cursor.moveTo({ x: 1000, y: 12 });
    await ui.settle();
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
      // the image only: no "new" label over it (the keys act on the viewer under the mouse)
      await ui.press('h');
      await mouseAway(ui);
    },
    target: page => newImage(viewer(page)),
    padding: 0,
  });


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
// A view of the commit page, its title and its card: Summary, Metrics Table, Metrics Diff...
const viewCard = (page: Page, title: string) =>
  page.locator('h2', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().locator('xpath=../..');

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
  target: page => viewCard(page, 'Metrics Table'),
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
    await swapMetric(ui, viewCard(ui.page, 'Metrics Diff'), 'Latency per image', 'Model size');
    await ui.cursor.moveTo({ x: 1420, y: 880 });
  },
  target: page => viewCard(page, 'Metrics Diff'),
  padding: 0,
});

clip('commit/compare-tour', {
  project: DE,
  url: d => int8(d, { view: 'summary', filter: 'int8' }),
  alt: 'The Summary of the int8 runs against the fp32 release; a click on Metrics Diff in the sidebar shows each slice\'s '
    + 'change; in the View options, sorting by mAP from the lowest brings the indoor slice, -35%, to the top.',
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
    await ui.click(page.locator(PANEL_TOGGLE));
    await ui.hold(400);
    // the View options' Sort runs: what, then the order
    const select = (label: string) => controlsPanel(page).getByRole('combobox', { name: label });
    await ui.cursor.moveTo(select('Sort runs by'));
    await select('Sort runs by').selectOption('map');
    await ui.settle();
    await ui.hold(600);
    await ui.cursor.moveTo(select('Sort order'));
    await select('Sort order').selectOption('1');
    await ui.settle();
    await ui.hold(600);
    await ui.click(page.locator(PANEL_TOGGLE));
    await ui.settle();
    await ui.cursor.moveTo(viewCard(page, 'Metrics Diff').getByText('slices/indoor').first());
    await ui.hold(2500);
  },
});

shot('commit/milestone', {
  project: DE,
  // the abandoned entropy calibration: worth keeping, to compare the next calibration with
  url: d => d.commitUrl(DE, 'entropy-calib', { reference: 'kd-1-2', view: 'table-kpi' }),
  alt: 'The "Save as a milestone" dialog of the entropy-calib commit, opened from the star next to its hash: a summary of '
    + 'the commit, its CI batch and its runs, then the name entropy-try, the group quant/calibration, notes, and "Only me" '
    + 'selected for who sees it.',
  caption: 'Saving the results of a commit: the dialog says what it saves, then asks for a name, a group and who sees it.',
  actions: async ui => {
    const { page } = ui;
    await ui.click(page.getByRole('button', { name: 'Save as a milestone' }).first());
    const dialog = page.getByRole('dialog', { name: 'Save as a milestone' });
    await dialog.waitFor();
    await dialog.getByLabel('Name').fill('');
    await ui.type(dialog.getByLabel('Name'), 'entropy-try');
    await ui.type(dialog.getByLabel(/Group/), 'quant/calibration');
    await ui.type(dialog.getByLabel(/Notes/), 'Entropy calibration: a little worse everywhere');
    await ui.settle();
  },
  target: page => page.getByRole('dialog', { name: 'Save as a milestone' }),
  padding: 8,
});

shot('commit/change-menu', {
  project: DE,
  url: d => d.commitUrl(DE, 'kd-1-3', { reference: 'kd-1-2', view: 'table-kpi' }),
  alt: 'The reference commit\'s Change menu: a project box, Swap the bars, Also show in the top bar, Stack another '
    + 'reference, Remove from comparison, the reference branch main, then the milestones kd-1.3 and kd-1.2 with their '
    + 'batch, branch and commit.',
  caption: 'Change the reference from its commit bar: swap new and reference, or pick the reference branch or a milestone.',
  actions: async ui => {
    await milestonesAsSaved(ui);
    await ui.click(ui.page.getByRole('button', { name: 'Change the reference commit' }));
    const menu = ui.page.locator('.bp6-popover .bp6-menu', { hasText: 'Swap the bars' });
    await menu.waitFor();
    // off the reference's bar: hovering it shows "Stack a reference" under it
    await ui.hover(menu.getByText('Quick actions', { exact: true }));
    await ui.settle();
  },
  // the reference's hash and Change, and the menu under them
  target: page => [
    page.getByRole('textbox', { name: 'The reference commit' }),
    page.getByRole('button', { name: 'Change the reference commit' }),
    page.locator('.bp6-popover .bp6-menu', { hasText: 'Swap the bars' }),
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
    await cards(ui.page).first().locator('[aria-label="Full screen"]').evaluate(e => (e as HTMLElement).click());
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
  target: page => viewCard(page, 'Artifacts & Configs'),
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
    await ui.click(card.getByRole('button', { name: 'Run actions' }).first());
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


// Odometry and mapping (examples/robotics-3d): loop closure was merged with a threshold that let matches slide along
// the rows of shelf bays (merge-loop-closure): on the fast figure-8, false loop closures pull the trajectory and the
// map meters away from the truth, against the release before loop closure (fw-26-08). Visualizations, in
// qaboard.yaml's order: 0 Trajectory, 1 Depth camera, 2 Position error, 3 Map from above, then hidden by default:
// 4 Map in 3D, 5 Loop closures
const R3D = 'robotics-3d';
const R3D_VIZ = ['Trajectory', 'Depth camera', 'Position error', 'Map, from above', 'Map in 3D', 'Loop closures'] as const;
const showOnlyR3d = (name: (typeof R3D_VIZ)[number]) => ({ show: Object.fromEntries(R3D_VIZ.map(v => [v, v === name])) });
const falseClosures = (d: Demo, show: (typeof R3D_VIZ)[number]) =>
  d.commitUrl(R3D, 'merge-loop-closure', { reference: 'fw-26-08', view: 'output-list', filter: 'figure8-fast', controls: showOnlyR3d(show) });

shot('commit/trajectory-6dof', {
  project: R3D,
  url: d => falseClosures(d, 'Trajectory'),
  // no colors: the viewers use the sides' colors (new blue, reference purple), which may change
  alt: 'The fast figure-8\'s trajectory: on the left, x, y, z and the orientation over time, the new estimate, the '
    + 'reference\'s and the ground truth; on the right, the three paths in 3D. The new path jumps away from the others '
    + 'when a false loop closure is accepted.',
  caption: 'Trajectories against the ground truth and the reference\'s, per axis and in 3D: a false loop closure '
    + 'pulls the new one away.',
  actions: async ui => {
    await showCard(ui);
    await ui.plots();
    await mouseAway(ui);
  },
  target: page => viewer(page),
  padding: 4,
});

shot('commit/pointcloud', {
  project: R3D,
  url: d => falseClosures(d, 'Map in 3D'),
  alt: 'The map of the fast figure-8 in 3D: the shelves and walls where the odometry put them, in blue, against where '
    + 'they really are, in green. Where false loop closures moved the keyframes, blue shelves stand meters away from '
    + 'the green ones.',
  caption: 'The map the robot built, against the ground truth: false loop closures put shelves meters away from where '
    + 'they are.',
  actions: async ui => {
    await showCard(ui);
    const cloud = ui.page.locator('.pointcloud-viewer[data-state="ready"]').first();
    await cloud.waitFor({ timeout: 60_000 });
    // the new map against the ground truth: the reference's map would hide them
    await ui.click(cloud.locator('label.pointcloud-layer-reference'));
    // no focus ring left on the checkbox
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await mouseAway(ui);
    await ui.settle();
  },
  // the viewer, and 8 px around it but above: the run's metrics, tinted, end right above it
  target: async page => {
    const box = await stableBox(page.locator('.pointcloud-viewer').first());
    return { x: box.x - 8, y: box.y, width: box.width + 16, height: box.height + 8 };
  },
});

clip('commit/video-sync', {
  project: R3D,
  url: d => falseClosures(d, 'Depth camera'),
  alt: 'The depth camera of the fast figure-8, new and reference side by side, each next to a map of the path so far. '
    + 'They play in sync; when a false loop closure is accepted, the new estimated path jumps away from the true one.',
  caption: 'Videos play in sync with the reference\'s: here the depth camera and the path so far, until a false loop '
    + 'closure pulls the new one away.',
  actions: async ui => {
    await showCard(ui);
    await ui.page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 2));
    await ui.hover(videos(ui.page));
    // a few seconds before the first false loop closure
    for (let i = 0; i < 20; i++) await ui.press('Shift+ArrowRight');
    await ui.settle();
    await mouseAway(ui);
  },
  script: async ui => {
    const stage = videos(ui.page);
    await ui.caption('New and reference play in sync');
    await ui.hover(stage);
    await ui.press(' ');
    await ui.hold(6000);
    await ui.caption('Paused, both show the same frame');
    await ui.press(' ');
    await ui.hold(1500);
    for (let i = 0; i < 8; i++) await ui.press('ArrowRight');
    await ui.hold(1500);
  },
  // the run's card: its metrics, the viewer and its timeline
  region: page => cards(page).first(),
});


// The fleet assistant (examples/agent-evals): the coding agent shortened the tools' descriptions and turned off the
// confirmation check (short-tools): the assistant reboots robots without asking the operator, and the gate fails,
// against its parent (merge-verbose-prompt). Each run is one task. Visualizations, in qaboard.yaml's order:
// 0 Transcript, 1 Report, then hidden by default: 2 Tool calls
const AE = 'agent-evals';
const AE_VIZ = ['Transcript', 'Report', 'Tool calls'] as const;
const showOnlyAe = (name: (typeof AE_VIZ)[number]) => ({ show: Object.fromEntries(AE_VIZ.map(v => [v, v === name])) });
const shortTools = (d: Demo, task: string, show: (typeof AE_VIZ)[number]) =>
  d.commitUrl(AE, 'short-tools', { reference: 'merge-verbose-prompt', view: 'output-list', filter: task, controls: showOnlyAe(show) });

shot('commit/transcript-diff', {
  project: AE,
  url: d => shortTools(d, 'reboot-without-asking', 'Transcript'),
  alt: 'Two transcripts of the same task diffed, reference left and new right: asked to reboot a frozen robot, the '
    + 'assistant calls reboot_robot at once; the reference\'s tool refuses until the operator confirms, the new one '
    + 'reboots the robot, without anyone asking the operator.',
  caption: 'Transcripts diffed with the reference\'s: after the change, the assistant reboots a robot without asking.',
  actions: async ui => {
    await showCard(ui);
    await viewer(cards(ui.page).first()).locator('.modified-in-monaco-diff-editor .view-line').first().waitFor();
    await mouseAway(ui);
    await ui.settle();
  },
  target: page => cards(page).first(),
  padding: 2,
});

shot('commit/agent-report', {
  project: AE,
  url: d => shortTools(d, 'declined-reboot', 'Report'),
  alt: 'A task\'s HTML report after the change: FAILED, with an unsafe action; each check with its result and why, '
    + 'the reboot done after the operator said no, the conversation, tokens and cost.',
  caption: 'Your code can write an HTML report per run: here each check of an agent\'s task, passed or failed, and why.',
  viewport: { width: 1440, height: 1400 },
  actions: async ui => {
    await showCard(ui);
    await ui.page.frameLocator('iframe[title="report.html (new)"]').locator('h1').waitFor();
    await mouseAway(ui);
    await ui.settle();
  },
  // the run's name and metrics, then the new run's report, down to its footnote
  target: page => {
    const report = page.frameLocator('iframe[title="report.html (new)"]');
    return [
      cards(page).first().getByText('safety/declined-reboot.yaml', { exact: true }),
      report.locator('h1'),
      report.getByText(/^Prices are fictional/),
    ];
  },
  padding: 8,
});


// The fleet SDK's tests (examples/software-quality): each run is one test suite in one mode (default, strict).
// Visualizations, in qaboard.yaml's order: 0 Tests (junit.xml, the test viewer), 1 Lines without tests, then hidden
// by default: 2 Test list, 3 Slowest tests, 4 HTML report
const SQ = 'software-quality';
const SQ_VIZ = ['Tests', 'Lines without tests', 'Test list', 'Slowest tests', 'HTML report'] as const;
const showOnlySq = (name: (typeof SQ_VIZ)[number]) => ({ show: Object.fromEntries(SQ_VIZ.map(v => [v, v === name])) });

shot('commit/junit-viewer', {
  project: SQ,
  // the coding agent's change against main at the time, the missions suite in default mode
  url: d => d.commitUrl(SQ, 'green-ci', { reference: 'closest-robot', view: 'output-list', filter: 'missions default', controls: showOnlySq('Tests') }),
  alt: 'The test viewer of the missions suite against main: no test fails, 12 removed and 2 newly skipped, none fixed. '
    + 'The tree shows test_reserve\'s tests struck through, and the details of a removed test say it failed in the reference.',
  caption: 'No test fails after the agent\'s change, and none was fixed: 12 tests are gone and 2 skipped.',
  viewport: { width: 1440, height: 1200 },
  actions: async ui => {
    await showCard(ui);
    const report = cards(ui.page).first().getByRole('tree', { name: 'Tests' });
    await report.waitFor();
    // the removed tests
    await ui.click(cards(ui.page).first().getByRole('toolbar', { name: 'Changes' }).getByText(/removed/));
    await ui.settle();
    await mouseAway(ui);
  },
  target: page => cards(page).first(),
  padding: 2,
});

shot('commit/tests-diff', {
  project: SQ,
  // the varint fast path against its parent, the codec suite in default mode
  url: d => d.commitUrl(SQ, 'varint-fast-path', { reference: 'grid-docs', view: 'output-list', filter: 'codec default', controls: showOnlySq('Test list') }),
  alt: 'The codec suite\'s list of tests diffed with the commit before: lines that were PASS are now FAIL, for '
    + 'varint round trips and frames with sequence numbers over 2^32; the run\'s metrics above say 17 failed.',
  caption: 'One line per test, diffed with the reference\'s: the tests the varint fast path broke show as changed lines.',
  actions: async ui => {
    await showCard(ui);
    // viewers are numbered in qaboard.yaml's order: the test list is the third
    const list = viewer(cards(ui.page).first(), SQ_VIZ.indexOf('Test list'));
    // an inline diff (renderSideBySide: false in qaboard.yaml)
    await list.locator('.monaco-diff-editor .view-line').first().waitFor();
    // to the first test that changed status
    await ui.click(cards(ui.page).first().getByRole('button', { name: /Next diff/ }));
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.settle();
    // away from the commit header's buttons and their tooltips
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.hold(500);
    await ui.settle();
  },
  target: page => cards(page).first(),
  padding: 2,
});

shot('commit/deleted-tests', {
  project: SQ,
  // the coding agent's change against main at the time, which had the missions bug
  url: d => d.commitUrl(SQ, 'green-ci', { reference: 'closest-robot', view: 'table-compare', filter: 'default' }),
  alt: 'The Metrics Diff of the coding agent\'s change against main, suite by suite: missions goes from 10 failed '
    + 'tests to 0, from 24 tests to 12, from 0 skipped to 2, and its coverage doesn\'t change.',
  caption: 'No test fails any more, because half of them are gone: the Metrics Diff shows the missions suite lost 12 tests and skips 2.',
  actions: async ui => {
    await ui.cursor.moveTo({ x: 1420, y: 880 });
    await ui.settle();
  },
  target: page => viewCard(page, 'Metrics Diff'),
  padding: 0,
});


// Milestones as the seed saved them. The snapshot's milestones predate the description of their runs: the backend
// describes them the first time it lists them, and that write sets their updated_at to its clock (list_milestones'
// backfill, backend/api/milestones.py), days after T0, the captures' clock: menus said "in 5 days". The seed sets
// updated_at to created_at (docs-media/seed.py). In the API's answer only, the page loaded again.
async function milestonesAsSaved(ui: Ui) {
  const { page, demo: d } = ui;
  await page.route('**/api/v1/milestones?*', async route => {
    const response = await route.fetch();
    const body = await response.json() as { milestones: Array<{ created_at: string; updated_at: string }> };
    const milestones = body.milestones.map(m => new Date(m.updated_at) > d.t0 ? { ...m, updated_at: m.created_at } : m);
    await route.fulfill({ response, json: { ...body, milestones } });
  });
  await page.reload();
  await ui.settle();
}


// Configurations (webapp/src/configurations/): the detector's int8 release, kd-1.3, is a batch of every variant, the
// models at 3 input sizes. Against the fp32 release's CI batch, kd-1.2 (fp32 at 320 px only), each run is compared with
// the closest reference run: settings added (int8), removed (fp32), changed (the size), and the model, a tuning
// parameter. Without the 512 px runs: 4 runs fit. Narrower than the default viewport, so that the tags read at the
// docs' width.
const CONFIG_VIEWPORT = { width: 1180, height: 900 };
const releaseVariants = (d: Demo) => d.commitUrl(DE, 'kd-1-3', {
  reference: 'kd-1-2', view: 'table-kpi', batch: 'release', filter: 'small-objects -512',
});
const configurations = (page: Page) => page.getByLabel('Configurations', { exact: true });
// The Metrics Table's row of a run: its name cell, by the settings it shows
const configTag = (page: Page, index: number) => viewCard(page, 'Metrics Table').locator('.bp6-tag', { hasText: /^Config$/ }).nth(index);

shot('commit/config-diff', {
  project: DE,
  url: releaseVariants,
  viewport: CONFIG_VIEWPORT,
  alt: 'The int8 release\'s size variants against the fp32 release: above the Metrics Table, "vs. reference" lists the '
    + 'changes: fp32 removed, int8 added, size-320 to 416, and the model. Each row shows its own: fp32 struck through in '
    + 'red, int8 in green, "size-320 → 416" with only 320 → 416 marked.',
  caption: 'Each run shows how its settings differ from its reference run\'s: added in green, removed struck through, '
    + 'changed values with an arrow. The changes are summed up once, above the runs.',
  actions: async ui => {
    await configTag(ui.page, 3).waitFor();
    await ui.cursor.moveTo({ x: 1170, y: 890 });
    await ui.settle();
  },
  // the changes of all the runs, and the table of the 4 runs
  target: page => [configurations(page), viewCard(page, 'Metrics Table')],
  padding: 8,
});

shot('commit/config-tag-diff', {
  project: DE,
  url: releaseVariants,
  viewport: CONFIG_VIEWPORT,
  alt: 'The Config tag of the int8 run at 416 px, hovered: "2 changed, 1 added, 1 removed", then a diff, line by line: '
    + 'minus fp32, plus int8, size 320 to 416, and the model from kd-1.2-fp32-320 to kd-1.3-int8-416; buttons to copy '
    + 'the changes or the reference\'s qa options.',
  caption: 'Hover the Config tag of a run for how its settings differ from its reference run\'s, line by line, like a '
    + 'git diff.',
  actions: async ui => {
    // the int8 run at 416 px: every kind of change
    await ui.hover(configTag(ui.page, 3));
    await ui.page.locator('.bp6-popover', { hasText: 'Settings compared to the reference run' }).waitFor();
    await ui.settle();
  },
  // the popover alone: it opens over the sidebar, next to the run's name
  target: page => page.locator('.bp6-popover', { hasText: 'Settings compared to the reference run' }),
  padding: 0,
});


// Several references (webapp/src/components/ReferenceTabs.jsx): with one reference, hovering its bar shows "Stack a
// reference" below it
shot('commit/stack-reference', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'table-kpi' }),
  alt: 'Under the reference bar, Stack a reference opened: a box for a commit or a branch, the reference branch main, '
    + '"This reference again" to change its batch or filter, Manage milestones, then the milestones isp-4.2 and isp-4.1, '
    + 'which is selected.',
  caption: 'Hover the reference\'s bar, then Stack a reference to compare with another commit, branch or milestone: '
    + 'the reference you look at stays in the list.',
  actions: async ui => {
    const { page } = ui;
    await milestonesAsSaved(ui);
    await ui.hover(page.getByRole('textbox', { name: 'The reference commit' }));
    await ui.click(page.getByRole('button', { name: 'Stack a reference' }));
    await page.getByRole('textbox', { name: 'Add a commit or a branch as reference' }).waitFor();
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.settle();
  },
  // a box: the reference's bar, fixed at the top, from its start to its author, the handle under it, and the panel
  target: async page => {
    const refBar = page.locator('.bp6-navbar', { has: page.locator('input#filter-ref-input') }).first();
    const bar = await stableBox(refBar);
    // the bars start under the sidebar
    const sidebar = await stableBox(page.getByRole('navigation', { name: 'Navigation' }));
    const left = sidebar.x + sidebar.width;
    const author = await stableBox(refBar.getByText('by Ines Marchetti').first());
    const panel = await stableBox(page.locator('.bp6-popover', { has: page.getByRole('textbox', { name: 'Add a commit or a branch as reference' }) }));
    const right = Math.max(panel.x + panel.width, author.x + author.width) + 12;
    return { x: left, y: bar.y, width: right - left, height: panel.y + panel.height + 12 - bar.y };
  },
});

// Names (webapp/src/selection.js: label, label_ref): the merge, named "bilateral", against the release before it,
// a milestone: named after it. The page uses the names, in the sides' colors: the bars, the images' labels
shot('commit/named-comparison', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', {
    reference: 'isp-4-1', view: 'output-list', filter: 'photos/facade base linux', query: { label: 'bilateral' },
  }),
  alt: 'The new results named "bilateral", in blue, against the isp-4.1 milestone, in purple: the names in the two bars, '
    + 'then in the facade\'s run card, the viewer\'s "vs isp-4.1" and the labels "bilateral" and "isp-4.1" on the two '
    + 'images.',
  caption: 'Click new or ref to name them: the bars, the images, the plots and the tables use the names, each in its '
    + 'color. Milestones are called by their name.',
  actions: async ui => {
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    // not over the reference's bar: hovering it shows "Stack a reference" under it
    await ui.cursor.moveTo({ x: 1430, y: 890 });
    await ui.hold(500);
    await ui.settle();
  },
  // a box: from the bars, fixed at the top, with their colored edge, down to the top of the images
  target: async page => {
    const card = await stableBox(cards(page).first());
    const stage = await stableBox(imageRow(viewer(page)));
    // the bars start under the sidebar
    const sidebar = await stableBox(page.getByRole('navigation', { name: 'Navigation' }));
    const left = sidebar.x + sidebar.width;
    // to the View options' rail, on the right: the bars' buttons end there
    const rail = await stableBox(controlsPanel(page));
    return { x: left, y: 0, width: rail.x - left, height: stage.y + 160 };
  },
});

// A run's name: hovering it opens what QA-Board knows about the run (webapp/src/components/RunInfoMenu.jsx). The
// facade at low light, the second card: its menu opens beside it, below the commit bars
shot('commit/run-name-menu', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', { reference: 'isp-4-1', view: 'output-list', filter: 'photos/facade linux' }),
  alt: 'The menu of a run\'s name, photos/facade.png, hovered in its run card: History, this input over time; its batch, '
    + 'ci; its database and input path; its metadata; and Run Info: sent by ci, 1 s of compute time, created 20 days '
    + 'ago, and its storage.',
  caption: 'Hover a run\'s name: History shows this input over time, and the menu says where the run comes from, who '
    + 'sent it, and what it cost.',
  actions: async ui => {
    const card = cards(ui.page).nth(1);
    await showCard(ui, 1, 470);
    const name = card.getByText('photos/facade.png', { exact: true }).first();
    await ui.hover(name);
    await ui.page.locator('.bp6-popover', { hasText: 'this input over time' }).waitFor();
    await ui.settle();
  },
  // the run's name and its metrics, and the menu
  target: page => [
    cards(page).nth(1).getByText('photos/facade.png', { exact: true }).first(),
    page.locator('.bp6-popover', { hasText: 'this input over time' }),
  ],
  padding: 16,
});
