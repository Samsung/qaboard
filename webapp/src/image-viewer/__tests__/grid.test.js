import { describe, it, expect } from 'vitest';

import { distanceMatrix, formatDistance, gridLayout, hasSource, meanDifference, nextShown, tileColor, tileName } from '../grid';

const view = (width, height, color) => {
  const data = new Uint8ClampedArray(4 * width * height);
  for (let i = 0; i < width * height; i++) data.set([...color, 255], 4 * i);
  return { width, height, data };
};

describe('the tiles of more than two images', () => {
  it('lays them out as large as the room allows', () => {
    // wide and short: one row
    expect(gridLayout({ count: 4, available: 1600, maxHeight: 300, aspect: 0.75 })).toMatchObject({ columns: 4, rows: 1 });
    // room below: two rows of larger tiles
    const grid = gridLayout({ count: 4, available: 1000, maxHeight: 900, aspect: 0.75, gap: 4 });
    expect(grid).toMatchObject({ columns: 2, rows: 2, width: 498, height: 373, stageWidth: 1000, stageHeight: 750 });
    expect(grid.slot(0)).toEqual({ left: 0, top: 0 });
    expect(grid.slot(3)).toEqual({ left: 502, top: 377 });
    // 5 images: 3 + 2
    expect(gridLayout({ count: 5, available: 1200, maxHeight: 800, aspect: 0.75 })).toMatchObject({ columns: 3, rows: 2 });
  });

  it('shows them in one row when asked, e.g. for a contact sheet', () => {
    expect(gridLayout({ count: 5, available: 1000, maxHeight: 900, aspect: 0.75, columns: 5 })).toMatchObject({ columns: 5, rows: 1 });
    expect(gridLayout({ count: 1, available: 1000, maxHeight: 300, aspect: 0.75, columns: 5 })).toMatchObject({ columns: 1, rows: 1, width: 400 });
  });

  it('names and colors the images that have no label or color', () => {
    expect([0, 1, 2].map(i => tileName(null, i))).toEqual(['new', 'reference', 'image 3']);
    expect(tileName({ label: 'v1.2' }, 2)).toBe('v1.2');
    expect(tileColor({}, 0).color).toBe('#2d72d2');
    expect(tileColor({ color: '#123456', textColor: '#000' }, 1)).toEqual({ color: '#123456', textColor: '#000' });
    // past the palette: gray
    expect(tileColor({}, 7)).toEqual({ color: '#738091', textColor: '#fff' });
  });

  it('skips the images that are loading or missing when showing them one at a time', () => {
    const images = [{ url: '/a.png' }, { label: 'ref 2', loading: true }, { iiif: '/iiif/c' }, { label: 'ref 4', missing: 'No file' }];
    expect(images.map(hasSource)).toEqual([true, false, true, false]);
    expect(nextShown(images, 0)).toBe(2);
    expect(nextShown(images, 2)).toBe(0);
    expect(nextShown(images, 0, -1)).toBe(2);
    expect(nextShown([{ url: '/a.png' }], 0)).toBe(0);
  });
});

describe('how far apart the images are', () => {
  it('is the mean difference of their colors, in levels', () => {
    const black = view(10, 10, [0, 0, 0]);
    expect(meanDifference(black, view(10, 10, [0, 0, 0]))).toBe(0);
    expect(meanDifference(black, view(10, 10, [30, 0, 0]))).toBe(10);
    // views of other sizes show other regions
    expect(meanDifference(black, view(10, 20, [0, 0, 0]))).toBe(null);
    expect(meanDifference(black, null)).toBe(null);
  });

  it('is zero only when every pixel is the same, whatever it samples', () => {
    // large views are sampled: every 16th pixel of 1200 columns would be the same columns of every row
    const a = view(1200, 800, [0, 0, 0]);
    const b = view(1200, 800, [255, 255, 255]);
    for (let y = 0; y < 800; y++) for (let x = 0; x < 1200; x += 16) b.data.set([0, 0, 0, 255], 4 * (y * 1200 + x));
    expect(meanDifference(a, b)).toBeGreaterThan(200);
    // one pixel differs: not "the same", even when the sample misses it
    const c = view(1200, 800, [0, 0, 0]);
    c.data[4 * 7 + 1] = 9;
    expect(meanDifference(a, c)).toBeGreaterThan(0);
    expect(formatDistance(meanDifference(a, c))).toBe('<0.1');
  });

  it('compares all the images, or only with the anchor', () => {
    const views = [view(4, 4, [0, 0, 0]), view(4, 4, [3, 3, 3]), null, view(4, 4, [3, 3, 3])];
    expect(distanceMatrix(views)).toEqual([[0, 3, null, 3], [3, 0, null, 0], [null, null, 0, null], [3, 0, null, 0]]);
    expect(distanceMatrix(views, 0)[1]).toEqual([3, 0, null, null]);
  });

  it('says when images are the same', () => {
    expect([0, 0.01, 5.14, null].map(formatDistance)).toEqual(['same', '<0.1', '5.1', '–']);
  });
});
