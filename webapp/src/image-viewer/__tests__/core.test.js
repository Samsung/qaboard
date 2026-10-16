import { describe, it, expect, vi, afterEach } from 'vitest';

import { iiifTileFormat, iiifTileSource, iiifUrl, imageKey, normalizeImage, openImage, thumbnailUrl } from '../sources';
import { joinSyncGroup, syncGroupKey, viewportAfterImageChange } from '../sync';
import { clipRegion, regionAsYaml, regionToViewport, scaleRegion, uniqueRegions, viewportToRegion } from '../regions';
import { changedAdjustments, describeAdjustments, filterPrimitives } from '../adjustments';
import { cellFont, formatNumber, formatSigned, textColorOn, visiblePixels } from '../pixels';
import { normalizePixels, PixelTiles, TILE } from '../pixelTiles';


describe('images', () => {
  it('accepts URLs or objects', () => {
    expect(normalizeImage('/a.png')).toEqual({ url: '/a.png' });
    expect(normalizeImage({ iiif: '/iiif/2/a', label: 'new' })).toEqual({ iiif: '/iiif/2/a', label: 'new' });
    expect(normalizeImage(null)).toBe(null);
    expect(imageKey('/a.png')).toBe(imageKey({ url: '/a.png', label: 'other label' }));
    expect(imageKey({ iiif: '/a.png' })).not.toBe(imageKey('/a.png'));
  });

  it('encodes the slashes of IIIF identifiers', () => {
    expect(iiifUrl('/iiif/2/', 'mnt/runs/1/out #1.png')).toBe('/iiif/2/mnt%2Fruns%2F1%2Fout%20%231.png');
  });

  it('asks for PNG tiles unless the server only serves JPEG', () => {
    expect(iiifTileFormat({ profile: ['http://iiif.io/api/image/2/level2.json', { formats: ['jpg'] }] })).toBe('png');
    expect(iiifTileFormat({ profile: ['http://iiif.io/api/image/2/level1.json', {}] })).toBe('png');
    expect(iiifTileFormat({ profile: ['http://iiif.io/api/image/2/level1.json', { formats: ['jpg', 'png'] }] })).toBe('png');
    expect(iiifTileFormat({ profile: ['http://iiif.io/api/image/2/level1.json', { formats: ['jpg'] }] })).toBe('jpg');
    expect(iiifTileFormat({ profile: 'level1', extraFormats: ['png'] })).toBe('png');
  });

  it('uses our URL over the id the IIIF server gives', () => {
    const source = iiifTileSource({ '@id': 'http://internal:8182/iiif/2/x', width: 10, height: 5, profile: ['level2'] }, 'https://public/iiif/2/x');
    expect(source).toMatchObject({ '@id': 'https://public/iiif/2/x', width: 10, height: 5, preferredFormats: ['png'] });
  });

  it('builds thumbnails of IIIF regions', () => {
    expect(thumbnailUrl({ iiif: '/iiif/2/a' }, { x: 1.4, y: 2.6, w: 10, h: 20 })).toBe('/iiif/2/a/1,3,10,20/,48/0/default.jpg');
    expect(thumbnailUrl({ iiif: '/iiif/2/a' })).toBe('/iiif/2/a/full/,48/0/default.jpg');
    expect(thumbnailUrl('/a.png')).toBe(null);
  });

  describe('openImage', () => {
    afterEach(() => vi.unstubAllGlobals());

    it("reads the IIIF image's size from its info.json", async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ '@context': 'http://iiif.io/api/image/2/context.json', width: 40, height: 30, profile: ['level2'] })));
      vi.stubGlobal('fetch', fetch);
      const { width, height, tileSource } = await openImage({ iiif: '/iiif/2/a' });
      expect(fetch.mock.calls[0][0]).toBe('/iiif/2/a/info.json');
      expect({ width, height }).toEqual({ width: 40, height: 30 });
      expect(tileSource['@id']).toBe('/iiif/2/a');
    });

    it('says which URL failed', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404, statusText: 'Not Found' })));
      await expect(openImage({ iiif: '/iiif/2/a' })).rejects.toMatchObject({ url: '/iiif/2/a/info.json', message: expect.stringContaining('404') });
    });
  });
});


describe('sync groups', () => {
  const member = () => ({ setViewport: vi.fn(), setPointer: vi.fn() });

  it('makes the others follow the viewer users move', () => {
    const [a, b, c] = [member(), member(), member()];
    const [ga, gb] = [joinSyncGroup('k', a), joinSyncGroup('k', b)];
    const gc = joinSyncGroup('other', c);
    const viewport = { zoom: 2, center: { x: 0.5, y: 0.2 } };
    // b doesn't lead: ignored
    gb.publish(viewport);
    expect(a.setViewport).not.toHaveBeenCalled();
    ga.lead();
    ga.publish(viewport);
    expect(b.setViewport).toHaveBeenCalledWith(viewport);
    expect(a.setViewport).not.toHaveBeenCalled();
    expect(c.setViewport).not.toHaveBeenCalled();
    expect(gb.viewport()).toBe(viewport);
    ga.pointer({ x: 1, y: 2 });
    expect(b.setPointer).toHaveBeenCalledWith({ x: 1, y: 2 });
    [ga, gb, gc].forEach(g => g.leave());
  });

  it('starts over when all viewers left', () => {
    const g = joinSyncGroup('k2', member());
    g.lead();
    g.publish({ zoom: 3, center: { x: 0, y: 0 } });
    g.leave();
    expect(joinSyncGroup('k2', member()).viewport()).toBe(null);
  });

  it('only syncs images of the same aspect ratio', () => {
    expect(syncGroupKey('input', 4000, 3000)).toBe(syncGroupKey('input', 400, 300));
    expect(syncGroupKey('input', 4000, 3000)).not.toBe(syncGroupKey('input', 4000, 2000));
    expect(syncGroupKey(null, 4000, 3000)).toBe(null);
  });

  it('keeps the viewport when the image changes for one of the same aspect ratio', () => {
    const previous = { zoom: 4, center: { x: 0.3, y: 0.2 }, width: 4000, height: 3000 };
    expect(viewportAfterImageChange(previous, { width: 2000, height: 1500 })).toEqual({ action: 'keep', zoom: 4, center: { x: 0.3, y: 0.2 } });
    expect(viewportAfterImageChange(previous, { width: 2000, height: 2000 })).toEqual({ action: 'refit' });
    expect(viewportAfterImageChange(null, { width: 2000, height: 2000 })).toBe(null);
  });
});


describe('regions', () => {
  // defined on a 2000x1000 input, shown on a 1000x500 output
  const region = { x: 100, y: 50, w: 400, h: 200, imageWidth: 2000, imageHeight: 1000, label: 'Detail' };
  const size = { width: 1000, height: 500 };

  it('scales regions to the image shown', () => {
    expect(scaleRegion(region, size)).toEqual({ x: 50, y: 25, w: 200, h: 100 });
    expect(scaleRegion({ x: 1, y: 2, w: 3, h: 4 }, size)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('clips regions to the image, and rejects those outside', () => {
    expect(clipRegion({ x: 900, y: -10, w: 200, h: 50 }, size)).toEqual({ x: 900, y: 0, w: 100, h: 40 });
    expect(clipRegion({ x: 100, y: 100, w: -50, h: 10 }, size)).toEqual({ x: 50, y: 100, w: 50, h: 10 });
    expect(clipRegion({ x: 2000, y: 0, w: 10, h: 10 }, size)).toBe(null);
    expect(clipRegion({ x: NaN, y: 0, w: 10, h: 10 }, size)).toBe(null);
  });

  it('converts to and from viewport coordinates, relative to the width', () => {
    const viewport = regionToViewport(region, size);
    expect(viewport).toEqual({ x: 0.05, y: 0.025, width: 0.2, height: 0.1 });
    expect(viewportToRegion(viewport, size)).toEqual({ x: 50, y: 25, w: 200, h: 100 });
  });

  it('copies regions in the format of presets', () => {
    expect(regionAsYaml({ x: 1.2, y: 2, w: 3.7, h: 4, label: 'a' }, size)).toBe('width: 1000\nheight: 500\n- {x: 1, y: 2, w: 4, h: 4, label: "a"}');
  });

  it('removes duplicates', () => {
    expect(uniqueRegions([region, { ...region }, { ...region, label: 'other' }])).toHaveLength(2);
  });
});


describe('adjustments', () => {
  it('does nothing by default', () => {
    expect(filterPrimitives({})).toEqual([]);
    expect(changedAdjustments({})).toEqual([]);
  });

  it('applies the gamma, then brightness and contrast around mid-gray', () => {
    const [gamma, linear] = filterPrimitives({ gamma: 2, brightness: 51, contrast: 2 });
    expect(gamma.functions[0]).toMatchObject({ channel: 'R', type: 'gamma', exponent: 0.5 });
    expect(linear.functions[2]).toMatchObject({ channel: 'B', type: 'linear', slope: 2, intercept: -0.3 });
  });

  it('shows a channel as gray levels, and maps gray levels to false colors', () => {
    const [matrix] = filterPrimitives({ channel: 'g' });
    expect(matrix.attributes.values).toBe('0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 1 0');
    const [luma, table] = filterPrimitives({ falseColor: 'turbo' });
    expect(luma.attributes.values.startsWith('0.299 0.587 0.114')).toBe(true);
    expect(table.functions[0].tableValues.split(' ')).toHaveLength(33);
  });

  it('describes what changed', () => {
    expect(describeAdjustments({ gamma: 2.2, channel: 'r' })).toEqual(['gamma 2.20', 'R channel']);
  });
});


describe('pixels', () => {
  it('formats values', () => {
    expect(formatNumber(255, 16)).toBe('0xff');
    expect(formatNumber(0.123456)).toBe('0.1235');
    expect(formatNumber(1.5, 16)).toBe('1.5');
    expect(formatSigned(-3)).toBe('−3');
    expect(formatSigned(3)).toBe('+3');
  });

  it('picks a readable text color', () => {
    expect(textColorOn(255, 255, 255)).toBe('#000');
    expect(textColorOn(20, 20, 60)).toBe('#fff');
  });

  it('finds the visible pixels', () => {
    // the image starts 15px left of the view, 10 view pixels per image pixel
    expect(visiblePixels({ origin: { x: -15, y: 0 }, scale: 10 }, { width: 100, height: 50 }, { width: 8, height: 100 }))
      .toEqual({ x0: 1, y0: 0, x1: 8, y1: 5 });
    expect(visiblePixels({ origin: { x: 200, y: 0 }, scale: 10 }, { width: 100, height: 50 }, { width: 8, height: 100 })).toBe(null);
  });

  it('fits the values in the pixels, once they are large enough', () => {
    expect(cellFont(20, 1, 3)).toBe(null);
    expect(cellFont(40, 1, 3)).toBeGreaterThan(cellFont(40, 3, 3));
    expect(cellFont(32, 3, 3)).toBe(null);
    expect(cellFont(200, 1, 3)).toBe(16);
  });
});


describe('pixel tiles', () => {
  const image = { iiif: '/iiif/2/a', file: 'a.tiff' };
  const size = { width: 100, height: 70 };
  // a 16-bit RGB image whose values say where they are
  const getPixels = vi.fn(async (_, { x, y, w, h }) => ({
    data: Uint16Array.from({ length: w * h * 3 }, (_, i) => {
      const pixel = Math.floor(i / 3);
      return [x + (pixel % w), y + Math.floor(pixel / w), 7][i % 3];
    }),
    width: w,
    height: h,
    channels: 3,
    mode: 'RGB;16',
  }));
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it('reads nested rows (numpy tolist) or flat arrays', () => {
    expect(normalizePixels({ values: [[1, 2], [3, 4]] })).toEqual({ w: 2, h: 2, channels: 1, data: [1, 2, 3, 4] });
    expect(normalizePixels({ values: [[[1, 2], [3, null]]] })).toEqual({ w: 2, h: 1, channels: 2, data: [1, 2, 3, null] });
    expect(normalizePixels({ data: new Uint8Array(6), width: 2, height: 1 }).channels).toBe(3);
  });

  it('asks for the tiles of a region once, cut at the edges of the image', async () => {
    getPixels.mockClear();
    const tiles = new PixelTiles();
    tiles.setGetPixels(getPixels);
    expect(tiles.get(image, 70, 65)).toBe(undefined);
    tiles.request(image, size, { x0: 60, y0: 60, x1: 70, y1: 70 });
    tiles.request(image, size, { x0: 60, y0: 60, x1: 70, y1: 70 });
    await flush();
    expect(getPixels.mock.calls.map(([, region]) => region)).toEqual([
      { x: 0, y: 0, w: TILE, h: TILE },
      { x: TILE, y: 0, w: 100 - TILE, h: TILE },
      { x: 0, y: TILE, w: TILE, h: 70 - TILE },
      { x: TILE, y: TILE, w: 100 - TILE, h: 70 - TILE },
    ]);
    expect(tiles.get(image, 70, 65)).toEqual([70, 65, 7]);
    expect(tiles.mode(image)).toBe('RGB;16');
    // another image doesn't share them
    expect(tiles.get({ iiif: '/iiif/2/b' }, 70, 65)).toBe(undefined);
  });

  it('only asks for the latest pixel under the pointer while one is in flight', async () => {
    getPixels.mockClear();
    const tiles = new PixelTiles();
    tiles.setGetPixels(getPixels);
    tiles.requestLatest(image, size, 1, 1);
    tiles.requestLatest(image, size, 70, 1);
    tiles.requestLatest(image, size, 1, 65);
    tiles.requestLatest(image, size, 70, 65);
    await flush();
    await flush();
    expect(getPixels.mock.calls.map(([, { x, y }]) => [x, y])).toEqual([[0, 0], [TILE, TILE]]);
  });

  it("says why values can't be read, and doesn't ask again right away", async () => {
    const failing = vi.fn(async () => { throw new Error('Cannot find out.tiff'); });
    const tiles = new PixelTiles();
    tiles.setGetPixels(failing);
    tiles.requestLatest(image, size, 1, 1);
    await flush();
    expect(tiles.get(image, 1, 1)).toBe(null);
    expect(tiles.error(image)).toBe('Cannot find out.tiff');
    tiles.requestLatest(image, size, 2, 2);
    tiles.request(image, size, { x0: 0, y0: 0, x1: 5, y1: 5 });
    expect(failing).toHaveBeenCalledTimes(1);
  });
});


describe('the package', () => {
  // its source files, as text
  const sources = import.meta.glob(['../*.{js,jsx}', '!../*.d.ts'], { query: '?raw', import: 'default', eager: true });

  it("doesn't import anything from the app: other apps install it", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, source] of Object.entries(sources)) {
      const imported = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
      for (const specifier of imported)
        expect([file, specifier]).toEqual([file, expect.stringMatching(/^(\.\/[\w./-]+|react|react-dom|react-dom\/client|openseadragon)$/)]);
    }
  });
});
