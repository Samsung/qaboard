import { FIT, fitRect, zoomLimits, transformOf, zoomAt, zoomTo, panBy, videoPointAt } from '../viewTransform';

const pane = { width: 800, height: 450 };
const media = { width: 1920, height: 1080 };

describe('viewTransform', () => {
  test('fits videos in their pane', () => {
    expect(fitRect(pane, media)).toEqual({ x: 0, y: 0, width: 800, height: 450 });
    expect(fitRect(pane, { width: 100, height: 100 })).toEqual({ x: 175, y: 0, width: 450, height: 450 });
    expect(transformOf(FIT, pane, media)).toEqual({ x: 0, y: 0, scale: 1, width: 800, height: 450 });
  });

  test('zoom limits', () => {
    const { min, max, native } = zoomLimits(pane, media);
    expect(native).toBeCloseTo(2.4);
    expect(min).toBe(1);
    expect(max).toBeCloseTo(32 * 2.4);
    // smaller than the pane: we can zoom out to its actual size
    expect(zoomLimits(pane, { width: 400, height: 225 }).min).toBe(0.5);
  });

  test('zooms on the pointer', () => {
    const point = { x: 200, y: 100 };
    const before = videoPointAt(point, FIT, pane, media);
    const view = zoomAt(FIT, 3, point, pane, media);
    expect(view.zoom).toBe(3);
    const after = videoPointAt(point, view, pane, media);
    expect(after.u).toBeCloseTo(before.u);
    expect(after.v).toBeCloseTo(before.v);
  });

  test('the video always covers the pane when zoomed in', () => {
    // zooming at the top-left corner
    const view = zoomAt(FIT, 2, { x: 0, y: 0 }, pane, media);
    expect(transformOf(view, pane, media)).toMatchObject({ x: 0, y: 0 });
    // panning too far
    const panned = panBy(view, 10000, -10000, pane, media);
    const t = transformOf(panned, pane, media);
    expect(t.x).toBe(0);
    expect(t.y).toBeCloseTo(pane.height - 2 * pane.height);
  });

  test('pans by pixels', () => {
    const view = zoomTo(FIT, 4, pane, media);
    const t = transformOf(view, pane, media);
    const moved = transformOf(panBy(view, 30, -20, pane, media), pane, media);
    expect(moved.x - t.x).toBeCloseTo(30);
    expect(moved.y - t.y).toBeCloseTo(-20);
  });

  test('clamps the zoom', () => {
    expect(zoomAt(FIT, 0.1, { x: 0, y: 0 }, pane, media)).toEqual(FIT);
    expect(zoomTo(FIT, 1e6, pane, media).zoom).toBeCloseTo(32 * 2.4);
  });

  test('the view is independent of the pane size', () => {
    const view = zoomAt(FIT, 2, { x: 100, y: 100 }, pane, media);
    const small = { width: 400, height: 225 };
    const t = transformOf(view, small, media);
    const big = transformOf(view, pane, media);
    expect(t.x * 2).toBeCloseTo(big.x);
    expect(t.y * 2).toBeCloseTo(big.y);
  });
});
