// The image viewer (webapp/src/image-viewer/), for the shots of the commit page, the landing and the history: its
// toolbar, the line with the hovered pixel's values, the regions of interest, then the images.
import type { Locator, Page, Ui } from './lib';

// the new image's pane (then the reference's, then the difference's)
export const newImage = (scope: Page | Locator) => scope.locator('.qiv-pane').first();
// the images: side by side, one over the other, or on each side of their difference
export const imageRow = (scope: Page | Locator) => scope.locator('.qiv-stage').first();
export const toolbar = (scope: Page | Locator) => scope.locator('.qiv-toolbar').first();
// the line above the images with the hovered pixel's coordinates, colors and values
export const pixelValues = (scope: Page | Locator) => scope.locator('.qiv-readout').first();

// An element's box once it stopped moving, e.g. after the layout changed with the comparison mode, or the first hover
// showed the pixel values above the images
export async function stableBox(target: Locator) {
  let previous = await target.boundingBox();
  for (let i = 0; i < 20; i++) {
    await target.page().waitForTimeout(150);
    const box = await target.boundingBox();
    if (box && JSON.stringify(box) === JSON.stringify(previous)) return box;
    previous = box;
  }
  if (!previous) throw new Error(`[imageViewer] ${target} has no box`);
  return previous;
}

// A point of the new image, in % of its box, once it stopped moving
export async function imagePoint(scope: Page | Locator, at: { x: number; y: number }) {
  const box = await stableBox(newImage(scope));
  return { x: (box.width * at.x) / 100, y: (box.height * at.y) / 100 };
}

// Shows a region of interest by its label, from the thumbnails above the images, or the whole image ("Full Image": the
// zoom button fits it, the thumbnails stay). The viewer opens on the input's first preset, but how close depends on its
// size when it opened: click it again for the same zoom every time.
export async function preset(ui: Ui, scope: Page | Locator, label: string) {
  if (label === 'Full Image') {
    await ui.click(scope.locator('.qiv-zoom').first());
  } else {
    const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    await ui.click(scope.locator('.qiv-region', { hasText: exact }).first());
  }
  // no focus ring left around the thumbnail
  await ui.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ui.settle();
}

// The difference shown with the colormap's last color (perceptual: 0.01 to 0.3), above the images. In clips, the
// cursor goes to the setting first.
export async function diffMax(ui: Ui, scope: Page | Locator, max: number) {
  const select = scope.getByLabel('Difference shown in the last color').first();
  await ui.hover(select);
  await select.selectOption(String(max));
  await ui.settle();
}
