import { describe, it, expect } from 'vitest';

import { capture_viewport, viewport_after_image_change, unsized_container } from '../viewport';


// A minimal OpenSeadragon viewer, zoomed on a region of its image
const fakeViewer = ({ items = 1, zoom = 4, center = { x: 0.25, y: 0.5 }, container = { clientWidth: 600, clientHeight: 400 }, containerSize = { x: 600, y: 400 } } = {}) => ({
  container,
  world: { getItemCount: () => items },
  viewport: {
    getZoom: () => zoom,
    getCenter: () => center,
    getContainerSize: () => containerSize,
  },
});


describe('capture_viewport', () => {
  it('gives the zoom and center with the image size', () => {
    expect(capture_viewport(fakeViewer(), 1224, 816)).toEqual({ zoom: 4, center: { x: 0.25, y: 0.5 }, width: 1224, height: 816 });
  });

  it('gives nothing before the viewer shows an image', () => {
    expect(capture_viewport(fakeViewer({ items: 0 }), 1224, 816)).toBeNull();
    expect(capture_viewport(fakeViewer(), undefined, undefined)).toBeNull();
    expect(capture_viewport({ id: 'image-viewer-1' }, 1224, 816)).toBeNull(); // not mounted yet
  });
});


describe('viewport_after_image_change', () => {
  const previous = { zoom: 4, center: { x: 0.25, y: 0.5 }, width: 1224, height: 816 };

  it('keeps the zoom and center for another image of the same size (e.g. the next stage)', () => {
    expect(viewport_after_image_change(previous, { width: 1224, height: 816 }))
      .toEqual({ action: 'keep', zoom: 4, center: { x: 0.25, y: 0.5 } });
  });

  it('keeps them for another size with the same aspect ratio: viewport coordinates are relative to the width', () => {
    expect(viewport_after_image_change(previous, { width: 612, height: 408 })).toMatchObject({ action: 'keep', zoom: 4 });
  });

  it('fits the selected ROI preset again for another aspect ratio', () => {
    expect(viewport_after_image_change(previous, { width: 816, height: 1224 })).toEqual({ action: 'refit' });
  });

  it('does nothing special on the first image', () => {
    expect(viewport_after_image_change(null, { width: 1224, height: 816 })).toBeNull();
  });
});


describe('unsized_container', () => {
  it('gives the size of a container that was hidden when it shows', () => {
    // OpenSeadragon saw a 1x1 container while it was hidden
    expect(unsized_container(fakeViewer({ containerSize: { x: 1, y: 1 } }))).toEqual({ x: 600, y: 400 });
  });

  it('gives nothing while it is hidden, or once the viewport has its size', () => {
    expect(unsized_container(fakeViewer({ container: { clientWidth: 0, clientHeight: 0 }, containerSize: { x: 1, y: 1 } }))).toBeNull();
    expect(unsized_container(fakeViewer())).toBeNull();
  });
});
