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
