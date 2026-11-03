import { describe, it, expect, vi } from 'vitest';

import { differenceToRegion, formatDifference, presetRegions, registerRegionProvider, regionProviders } from '../regionProviders';


describe('presetRegions', () => {
  it("lists the input's and the configurations' regions once, in the input's coordinates", () => {
    const roi = { x: 0, y: 0, w: 10, h: 10, label: 'a' };
    const output = Object.freeze({
      configurations: Object.freeze(['base', Object.freeze({ roi: Object.freeze([Object.freeze({ ...roi }), Object.freeze({ x: 5, y: 5, w: 1, h: 1, label: 'b', image_width: 20, image_height: 10 })]) })]),
      test_input_metadata: Object.freeze({ roi: Object.freeze([Object.freeze(roi)]), width: 100, height: 50 }),
    });
    const regions = presetRegions(output);
    expect(regions.map(r => r.label)).toEqual(['a', 'b']);
    expect(regions[0]).toEqual({ ...roi, imageWidth: 100, imageHeight: 50 });
    // their own size wins
    expect(regions[1]).toMatchObject({ imageWidth: 20, imageHeight: 10 });
    expect(regions[1]).not.toHaveProperty('image_width');
  });

  it('has nothing without regions', () => {
    expect(presetRegions({ configurations: [] })).toEqual([]);
    expect(presetRegions({ configurations: ['base'], test_input_metadata: { roi: [null] } })).toEqual([]);
  });
});


describe('differenceToRegion', () => {
  it('labels the regions found by the server with how much the images differ there', () => {
    expect(differenceToRegion('yiq')({ x: 90, y: 40, w: 20, h: 30, value: 0.0321, diff: 0.25 }, 2))
      .toMatchObject({ x: 90, y: 40, w: 20, h: 30, value: 0.0321, label: '#3 · 3.2%' });
    // with the size of the difference itself
    expect(differenceToRegion('yiq')({ x: 90, y: 40, w: 20, h: 30, value: 0.0321, diff: 0.25, spot: { x: 95, y: 50, w: 6, h: 4 } }, 0).label)
      .toBe('#1 · 3.2% · 6×4 px');
    expect(formatDifference('ciede2000', 4.56)).toBe('ΔE 4.6');
    expect(formatDifference('ssim', 0.214)).toBe('1−SSIM 0.21');
  });

  it('gives the largest differences the darkest color', () => {
    const brightness = diff => differenceToRegion('yiq')({ x: 10, y: 10, w: 5, h: 5, value: 1, diff }, 0).color.match(/\d+/g).map(Number).reduce((a, b) => a + b);
    expect(brightness(1)).toBeLessThan(brightness(0));
    expect(brightness(3)).toEqual(brightness(1));
  });
});


describe('region providers', () => {
  const context = { output_new: { configurations: [], test_input_metadata: { roi: [{ x: 1, y: 2, w: 3, h: 4 }] } }, output_ref: null, path: 'out.png' };

  it('offers the presets, and the regions where images differ only with a reference', () => {
    const available = providers => providers.filter(p => !p.available || p.available(context)).map(p => p.id);
    expect(available(regionProviders())).toEqual(['presets']);
    expect(regionProviders().filter(p => p.available?.({ ...context, output_ref: { output_dir_url: '/s/ref' } })).map(p => p.id))
      .toEqual(['auto-yiq', 'auto-ssim', 'auto-ciede2000']);
  });

  it('lets sites add their own, or replace one', () => {
    const find = vi.fn(async () => [{ x: 0, y: 0, w: 1, h: 1 }]);
    registerRegionProvider({ id: 'charts', label: 'Test charts', find });
    registerRegionProvider({ id: 'charts', label: 'Charts', find });
    const charts = regionProviders().filter(p => p.id === 'charts');
    expect(charts).toHaveLength(1);
    expect(charts[0].label).toBe('Charts');
  });
});


describe('annotations', () => {
  it('are regions, in groups with their colors, the user\'s first', async () => {
    const { annotationProvider, annotationsToRegions, groupColors, inputPath, isGroupShown } = await import('../regionProviders');
    const found = annotationsToRegions({
      groups: [{ id: '7', label: 'Workspace 7', url: 'https://app/7' }, { id: '8', label: 'Night', mine: true }],
      annotations: [
        { id: '1', group: '7', x: 1, y: 2, w: 3, h: 4, label: 'Noise', tags: ['night'], url: 'https://app/7' },
        { id: '2', group: '7', x: 1, y: 2, w: 3, h: 4, label: 'Blur' },
      ],
    }, 'IQE', { imageWidth: 100, imageHeight: 50 });
    expect(found.groups.map(g => [g.id, g.count])).toEqual([['8', 0], ['7', 2]]);
    expect(found.groups[0].color).not.toBe(found.groups[1].color);
    expect(found.regions[0]).toMatchObject({ x: 1, label: 'Noise', group: '7', detail: 'Workspace 7', href: 'https://app/7', hrefLabel: 'Open in IQE', color: found.groups[1].color, imageWidth: 100 });
    // users see theirs, until they pick
    expect(isGroupShown(found.groups[0], undefined)).toBe(true);
    expect(isGroupShown(found.groups[1], {})).toBe(false);
    expect(isGroupShown(found.groups[0], { 8: false })).toBe(false);
    // distinct on an image, the same for a group
    const ids = Array.from({ length: 8 }, (_, i) => ({ id: `${i}` }));
    expect(new Set(Object.values(groupColors(ids))).size).toBe(8);
    expect(groupColors([{ id: 'a' }]).a).toBe(groupColors([{ id: 'a' }, { id: 'b' }]).a);

    expect(inputPath({ test_input_database: '/data/db/', test_input_path: 'in/a.bmp' })).toBe('/data/db/in/a.bmp');
    expect(inputPath({ test_input_database: '/', test_input_path: '/abs/a.bmp' })).toBe('/abs/a.bmp');
    expect(inputPath({ test_input_database: 'relative', test_input_path: 'a.bmp' })).toBe(null);
    const provider = annotationProvider({ id: 'iqe', label: 'IQE', group_noun: 'workspace' });
    expect(provider).toMatchObject({ id: 'annotations-iqe', source: 'iqe', section: 'Annotations', auto: true, overview: true, group_noun: 'workspace' });
    // the input's, whatever the image shown
    const output_new = { test_input_database: '/db', test_input_path: 'a.bmp' };
    expect(provider.key({ output_new, path: 'out.png' })).toEqual(['/db/a.bmp']);
    expect(provider.available({ output_new: { ...output_new, deleted: true } })).toBe(false);
  });
});
