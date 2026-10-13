// The home page of the docs (docs-media/shots.yaml: landing/*). The hero is a muted loop of the commit page, on the
// camera ISP project: the new denoiser wins PSNR but adds halos (examples/image-quality/story.yaml: merge-bilateral).
import { clip, type Locator, type Page, type Ui } from './lib';

const IQ = 'image-quality';

// The sidebar's views
const sidebar = (page: Page, view: string) => page.getByRole('menuitem', { name: view, exact: true }).first();
const cards = (page: Page) => page.locator('.output-card.bp6-card');
const viewer = (scope: Page | Locator) => scope.locator('[id="0-0"]').first();
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
