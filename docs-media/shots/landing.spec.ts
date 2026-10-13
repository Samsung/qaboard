// The home page of the docs (docs-media/shots.yaml: landing/*). The hero is a muted loop of the commit page, on the
// camera ISP project: the new denoiser wins PSNR but adds halos (examples/image-quality/story.yaml: merge-bilateral).
import fs from 'node:fs';
import path from 'node:path';
import { clip, shot, type Box, type Demo, type Locator, type Page, type Ui } from './lib';

const IQ = 'image-quality';

// The sidebar's views
const sidebar = (page: Page, view: string) => page.getByRole('menuitem', { name: view, exact: true }).first();
const cards = (page: Page) => page.locator('.output-card.bp6-card');
const viewer = (scope: Page | Locator, index = 0) => scope.locator(`[id="${index}-0"]`).first();
const newImage = (scope: Page | Locator) => scope.locator('[id^="image-viewer-"]').first();
const controlsPanel = (page: Page) => page.locator('.bp6-card', { has: page.getByText('Controls', { exact: true }) }).last();

// An element's box once it stopped moving: hovering an image shows the pixel values above it, which push it down
async function stableBox(target: Locator) {
  let previous = await target.boundingBox();
  for (let i = 0; i < 20; i++) {
    await target.page().waitForTimeout(150);
    const box = await target.boundingBox();
    if (box && JSON.stringify(box) === JSON.stringify(previous)) return box;
    previous = box;
  }
  if (!previous) throw new Error(`[landing.spec] ${target} has no box`);
  return previous;
}

// A point of the new image, in % of its box, once it stopped moving
async function imagePoint(scope: Page | Locator, at: { x: number; y: number }) {
  const box = await stableBox(newImage(scope));
  return { x: (box.width * at.x) / 100, y: (box.height * at.y) / 100 };
}

clip('landing/hero', {
  project: IQ,
  // the facade photo and the slanted edge chart, the facade first
  url: d => d.commitUrl(IQ, 'merge-bilateral', {
    reference: 'isp-4-1', view: 'table-compare', filter: 'facade.png|slanted base linux', query: { sort_by: 'input_test_path' },
  }),
  alt: 'The Metrics Diff of a new denoiser: PSNR up, edge overshoot up 163%. In the facade\'s images, zooming into one '
    + 'zooms the other, Image Diff turns on, and a higher threshold leaves only the halos; then back to the Metrics Diff.',
  caption: 'Metrics and images side by side: the new denoiser wins PSNR, and the images show the halos it adds.',
  loop: true,
  poster: 8000,
  script: async ui => {
    await ui.caption('PSNR is up, and so is the edge overshoot');
    await ui.hold(2400);

    await ui.caption('Look at the images: zoom in one, the other follows');
    await ui.click(sidebar(ui.page, 'Visualizations'));
    await ui.tiles();
    const scope = viewer(cards(ui.page).first());
    // Not recorded: the card right below the commit bars, the region preset again, for the same zoom every time, and a
    // first hover, which shows the pixel values above the images and pushes them down
    await cards(ui.page).first().evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 160));
    await ui.settle();
    await scope.locator('a.bp6-button', { hasText: /^Window frame \(halos\)$/ }).first().click();
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // the zoom to the region is animated: done before the hover, the same pixel is under the mouse every time
    await ui.tiles();
    await newImage(scope).hover({ position: await imagePoint(scope, { x: 50, y: 50 }) });
    await ui.settle();
    await ui.page.mouse.move(1000, 140);
    await ui.settle();
    const at = await imagePoint(scope, { x: 25, y: 25 });
    await ui.wheel(newImage(scope), -400, { steps: 4, position: at });
    await ui.tiles();
    await ui.hold(1300);

    await ui.caption('Image Diff shows what changed');
    // The Controls panel slides in and out, for longer than the wait after a click (it runs the page's clock in real
    // time): another wait, and it's always done
    const togglePanel = async () => {
      await ui.click(ui.page.locator('[title="Toggle Controls Panel"]'));
      await ui.settle();
    };
    await togglePanel();
    await ui.hold(300);
    await ui.click(controlsPanel(ui.page).locator('label', { hasText: 'Image Diff' }));
    await ui.settle();
    await togglePanel();
    await ui.hold(1300);

    await ui.caption('A higher threshold leaves the halos');
    // from 5% to 15%: the slider spans 0-30% over the width of an image
    const handle = scope.locator('.bp6-slider-handle').first();
    const track = (await scope.locator('.bp6-slider').first().boundingBox())!;
    const from = (await handle.boundingBox())!;
    await ui.drag(handle, { x: from.x + from.width / 2 + track.width / 3, y: from.y + from.height / 2 });
    await ui.settle();
    await ui.hold(2200);

    await ui.caption('PSNR is up, and so is the edge overshoot');
    await ui.click(sidebar(ui.page, 'Metrics Diff'));
    await ui.settle();
    // as it started: no cursor, the mouse on nothing, no focus ring on the sidebar
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.page.mouse.move(1300, 860);
    await ui.cursor.hide();
    await ui.settle();
    await ui.hold(1400);
  },
});


// The tiles of the landing's "Polish you'd never build in-house" grid (website/src/pages/index.tsx): 16:10 crops of
// the commit page, shown about 370 px wide, so that their text stays readable. Their captions are short, for the same
// reason. commit/* shots show the same features in context, for the docs.
const TILE_RATIO = 16 / 10;

// `commit` against `reference`, the runs matching `filter`
const compare = (d: Demo, commit: string, reference: string, filter: string, opts: { view?: 'output-list' | 'bit_accuracy'; controls?: Record<string, unknown> } = {}) =>
  d.commitUrl(IQ, commit, { reference, view: opts.view ?? 'output-list', filter, controls: opts.controls });

// Scrolls a run card right below the commit bars
async function showCard(ui: Ui, index = 0) {
  await cards(ui.page).nth(index).evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 160));
  await ui.settle();
}

// Clicks a region of interest preset under the viewer, by its label: the same zoom every time
async function preset(ui: Ui, scope: Page | Locator, label: string) {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await ui.click(scope.locator('a.bp6-button', { hasText: exact }).first());
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ui.settle();
}

// A 16:10 box of `width` in a box, horizontally from its left, vertically at `align` (0 top, 0.5 middle, 1 bottom)
function tileIn(box: Box, width: number, align: number): Box {
  const height = Math.round(width / TILE_RATIO);
  return { x: box.x, y: box.y + (box.height - height) * align, width, height };
}

clip('landing/deep-zoom', {
  project: IQ,
  url: d => compare(d, 'merge-bilateral', 'isp-4-1', 'charts/test-wall base linux'),
  alt: 'The 113-megapixel test wall: zooming from the whole wall into a small Siemens star until single pixels show.',
  caption: 'Deep zoom on a 113 MP image: the viewer loads only the tiles it shows.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Full Image');
    // the pixel values show above the images from the first hover on: not while recording, they'd push them down
    await newImage(ui.page).hover({ position: await imagePoint(ui.page, { x: 50, y: 50 }) });
    await ui.settle();
    await ui.page.mouse.move(1000, 140);
    await ui.settle();
  },
  // the new image, its bottom: the row of small stars is near the bottom of the wall
  region: async page => {
    const box = await stableBox(newImage(page));
    return tileIn(box, box.width, 1);
  },
  script: async ui => {
    const scope = viewer(ui.page);
    await ui.caption('A 113 MP image');
    // the 64 px Siemens star at (3904, 8192) of the 12288x9216 wall
    const at = await imagePoint(ui.page, { x: (3904 / 12288) * 100, y: (8192 / 9216) * 100 });
    const box = (await newImage(ui.page).boundingBox())!;
    await ui.cursor.moveTo({ x: box.x + at.x, y: box.y + at.y });
    await ui.hold(900);
    await ui.caption('Zoom in: tiles load as needed');
    await ui.wheel(newImage(scope), -600, { steps: 6, position: at });
    await ui.tiles();
    await ui.hold(1100);
    await ui.caption('Down to single pixels');
    await ui.click(scope.locator('a.bp6-button', { hasText: /^Siemens star 64 px$/ }).first());
    await ui.tiles();
    await ui.cursor.moveTo({ x: box.x + box.width / 2, y: box.y + box.height * 0.6 });
    await ui.hold(2600);
  },
});

// Dynamic outputs: `stages/:stage.jpg` in qaboard.yaml gives a slider over the ISP's stages, synced across runs
const dynamicOptions = (page: Page) => controlsPanel(page).getByText('Dynamic Options', { exact: true }).locator('xpath=../..');

clip('landing/every-stage', {
  project: IQ,
  url: d => d.commitUrl(IQ, 'merge-bilateral', {
    reference: 'isp-4-1', view: 'output-list', filter: 'facade low-light',
    controls: { show: { Output: false }, dynamic_options: { stage: ['1'] }, dynamic_options_sync: { stage: true } },
  }),
  // the stage slider is in the Controls panel, out of the tile
  storage: { 'controls-panel-expanded': 'true' },
  alt: 'The facade\'s window, stage by stage of the camera pipeline: the raw sensor mosaic, demosaiced, denoised, '
    + 'sharpened, then tone-mapped.',
  caption: 'A slider over the camera pipeline\'s stages, from the raw mosaic to the output.',
  actions: async ui => {
    await showCard(ui);
    // the ISP stage, the card's second visualization (Output is hidden)
    await preset(ui, viewer(ui.page, 1), 'Window frame (halos)');
    await newImage(viewer(ui.page, 1)).hover({ position: { x: 100, y: 100 } });
    await ui.settle();
    await ui.page.mouse.move(1000, 140);
    await ui.settle();
  },
  // the new image, its middle: the window
  region: async page => {
    const box = await stableBox(newImage(viewer(page, 1)));
    return tileIn(box, box.width, 0.5);
  },
  script: async ui => {
    const handle = dynamicOptions(ui.page).locator('.bp6-slider-handle').first();
    await ui.caption('1: raw sensor data');
    await ui.click(handle);
    await ui.cursor.hide();
    await ui.hold(1500);
    for (const label of ['2: demosaic', '3: denoise', '4: sharpen', '5: tone map']) {
      await ui.caption(label);
      await ui.press('ArrowRight');
      await ui.tiles();
      await ui.hold(label.startsWith('5') ? 2600 : 1400);
    }
  },
});

// Output Files on the fixed-point model: the rounding change (fxp-round-half-even), then a docs-only commit
const treeFile = (scope: Locator, label: string) => scope.locator('.bp6-tree-node-content').getByText(label, { exact: true }).first();
const bitAccuracy = (d: Demo, commit: string) => compare(d, commit, 'isp-4-1', 'photos/facade hw-model', { view: 'bit_accuracy' });

clip('landing/bit-accuracy', {
  project: IQ,
  login: 'tobias',
  url: d => bitAccuracy(d, 'fxp-round-half-even'),
  // the card and the diff under its files
  viewport: { width: 1440, height: 1300 },
  alt: 'The files of a run on the hardware model that differ from the reference; a click on regs.txt shows its diff: '
    + 'the ROUNDING register went from 0 to 2. Then a commit that only changed the docs: its run is bit-accurate.',
  caption: 'Only the output files that changed, and their diff; a commit that changes none is bit-accurate.',
  // the diff, rounding 0 → 2
  poster: 5500,
  // the card's files and the diff below them
  region: async page => {
    const card = (await cards(page).first().boundingBox())!;
    return { x: card.x, y: card.y, width: 720, height: 720 / TILE_RATIO };
  },
  script: async ui => {
    const card = cards(ui.page).first();
    await ui.caption('The files that changed');
    await ui.hold(1300);
    await ui.caption('Click one: its diff');
    await ui.click(treeFile(card, 'regs.txt'));
    await ui.settle();
    // one column: the tile shows both sides of the change
    await ui.click(card.getByText('Side-by-side', { exact: true }).first());
    await ui.click(card.getByRole('button', { name: 'Next Diff' }).first());
    await ui.settle();
    await ui.caption('Rounding 0 → 2');
    await ui.hold(2200);
    await ui.caption('A docs-only commit: bit-accurate');
    await ui.cursor.moveTo({ x: 1000, y: 1200 });
    await ui.goto(bitAccuracy(ui.demo, 'docs-tuning-guide'));
    await ui.hold(2400);
  },
});

// On the window frame's left edge, where the new denoiser adds a halo; near the image's left, so that the
// reference's crosshair is in the tile too
const PIXEL = { x: 24.3, y: 50 };

shot('landing/pixel-values', {
  project: IQ,
  url: d => compare(d, 'merge-bilateral', 'isp-4-1', 'photos/facade base linux'),
  alt: 'The facade\'s window frame, new and reference images: above them, the hovered pixel\'s coordinates and its RGB '
    + 'values in both images, with their colors; crosshairs mark the pixel in both.',
  caption: 'Hover a pixel: its values in both images, and a crosshair on the other.',
  actions: async ui => {
    await showCard(ui);
    await preset(ui, viewer(ui.page), 'Window frame (halos)');
    // the pixel values show above the images on the first hover, and push them down: then the image stays in place
    await newImage(ui.page).hover({ position: { x: 100, y: 100 } });
    await ui.settle();
    await ui.hover(newImage(ui.page), { position: await imagePoint(ui.page, PIXEL) });
    await ui.settle();
  },
  // the values above the images, the new image and the start of the reference, where its crosshair is
  target: async page => {
    const image = await stableBox(newImage(page));
    const width = 784;
    const height = Math.round(width / TILE_RATIO);
    return { x: image.x - 4, y: image.y + image.height + 4 - height, width, height };
  },
});

// The social card (Open Graph image of the docs: website/docusaurus.config.ts), 1200x630 at scale 1: the logo and the
// tagline (templates/social-card.html), and a crop of the commit page like the hero's, the facade's run with Image Diff
const SOCIAL_CARD = { width: 1200, height: 630 };
const TEMPLATES = path.join(import.meta.dirname, 'templates');
const LOGO = path.join(import.meta.dirname, '..', '..', 'website', 'static', 'img', 'twemoji_poodle.svg');

shot('landing/social-card', {
  project: IQ,
  url: d => compare(d, 'merge-bilateral', 'isp-4-1', 'photos/facade base linux', { controls: { diff: true } }),
  scale: 1,
  alt: 'QA-Board, "Tests tell you it runs. QA-Board shows you it\'s better." Next to it, a run on the commit page: PSNR '
    + 'and SSIM up, the new image of a window and its Image Diff, where the frame\'s halos stand out.',
  caption: 'The social card of the docs.',
  actions: async ui => {
    const scope = viewer(ui.page);
    await showCard(ui);
    await preset(ui, scope, 'Window frame (halos)');
    // a higher diff threshold leaves the halos (like commit/image-perceptual-diff)
    await ui.click(scope.locator('.bp6-slider-handle').first());
    for (let i = 0; i < 10; i++) await ui.press('ArrowRight');
    await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ui.page.mouse.move(1000, 140);
    await ui.settle();
    // the card's metrics, presets and its first two images, down to their bottom, at 1:1 in the template
    const card = (await cards(ui.page).first().boundingBox())!;
    const image = await stableBox(newImage(scope));
    const clip = { x: card.x, y: card.y, width: 640, height: Math.round(image.y + image.height - card.y) };
    const crop = await ui.page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const html = fs.readFileSync(path.join(TEMPLATES, 'social-card.html'), 'utf8')
      .replace('{{logo}}', fs.readFileSync(LOGO, 'utf8').replace(/<\?xml[^>]*>/, ''))
      .replace('{{shot}}', `data:image/png;base64,${crop.toString('base64')}`);
    await ui.page.setViewportSize(SOCIAL_CARD);
    await ui.page.setContent(html);
    await ui.settle();
  },
});
