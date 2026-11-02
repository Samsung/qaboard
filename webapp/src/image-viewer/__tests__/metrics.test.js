import { describe, it, expect } from 'vitest';

import {
  DIFF_METHODS, deltaE2000, diffAt, diffLegend, formatDiffValue, normalizeDiff, renderDiff, srgbToLab, yiqDistance, YIQ_MAX,
} from '../metrics';


describe('srgbToLab', () => {
  it('converts the primaries and the extremes like the references', () => {
    const close = (actual, expected) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 1));
    close(srgbToLab(255, 255, 255), [100, 0, 0]);
    close(srgbToLab(0, 0, 0), [0, 0, 0]);
    close(srgbToLab(255, 0, 0), [53.24, 80.09, 67.20]);
    close(srgbToLab(0, 0, 255), [32.30, 79.19, -107.86]);
  });
});


describe('deltaE2000', () => {
  // From the test data of Sharma, Wu and Dalal, "The CIEDE2000 color-difference formula" (2005)
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
  ];
  it.each(pairs)('%j vs %j is %f', (lab1, lab2, expected) => {
    expect(deltaE2000(lab1, lab2)).toBeCloseTo(expected, 3);
    expect(deltaE2000(lab2, lab1)).toBeCloseTo(expected, 3);
  });

  it('is 0 for the same color', () => {
    expect(deltaE2000([42, 10, -5], [42, 10, -5])).toBe(0);
  });
});


describe('yiqDistance', () => {
  it('goes from 0 to its maximum between black and white', () => {
    expect(yiqDistance([10, 20, 30], [10, 20, 30])).toBe(0);
    // gray levels only differ in luma
    expect(yiqDistance([0, 0, 0], [255, 255, 255])).toBeCloseTo(0.5053 * 255 * 255, 0);
    expect(yiqDistance([255, 0, 0], [0, 0, 255])).toBeLessThan(YIQ_MAX);
  });
});


describe('normalizeDiff', () => {
  it('fills in the setting of the method', () => {
    expect(normalizeDiff({ method: 'absolute' })).toEqual({ method: 'absolute', gain: 4 });
    expect(normalizeDiff({ method: 'deltaE', max: 2 })).toEqual({ method: 'deltaE', max: 2 });
    expect(normalizeDiff({ method: 'exact', max: 2 })).toEqual({ method: 'exact' });
  });

  it('falls back to defaults for invalid settings, e.g. from an old URL', () => {
    expect(normalizeDiff(undefined)).toEqual({ method: 'perceptual', max: 0.05 });
    expect(normalizeDiff({ method: 'ssim' })).toEqual({ method: 'perceptual', max: 0.05 });
    expect(normalizeDiff({ method: 'signed', gain: 'x' })).toEqual({ method: 'signed', gain: 4 });
    expect(normalizeDiff({ method: 'signed', gain: -2 })).toEqual({ method: 'signed', gain: 4 });
  });

  it('has defaults among the values users can pick', () => {
    for (const method of Object.values(DIFF_METHODS).filter(m => m.setting))
      expect(method.values).toContain(method.default);
  });
});


describe('diffAt', () => {
  it('gives the signed difference per channel, whatever the method', () => {
    for (const method of Object.keys(DIFF_METHODS))
      expect(diffAt({ method }, [100, 50, 0], [90, 60, 0]).delta).toEqual([10, -10, 0]);
  });

  it('measures the difference relative to the setting', () => {
    expect(diffAt({ method: 'absolute', gain: 2 }, [100, 0, 0], [0, 0, 0])).toMatchObject({ value: null, amount: 200 / 255 });
    expect(diffAt({ method: 'absolute', gain: 4 }, [100, 0, 0], [0, 0, 0]).amount).toBe(1);
    const signed = diffAt({ method: 'signed', gain: 1 }, [0, 0, 0], [100, 100, 100]);
    expect(signed.value).toBeCloseTo(-100);
    expect(signed.amount).toBeCloseTo(-100 / 255);
    const delta_e = diffAt({ method: 'deltaE', max: 10 }, [128, 128, 128], [128, 128, 128]);
    expect(delta_e).toMatchObject({ value: 0, amount: 0 });
    expect(diffAt({ method: 'deltaE', max: 1 }, [0, 0, 0], [255, 255, 255]).amount).toBe(1);
    expect(diffAt({ method: 'exact' }, [1, 2, 3], [1, 2, 4])).toMatchObject({ value: 1, amount: 1 });
    expect(diffAt({ method: 'exact' }, [1, 2, 3], [1, 2, 3])).toMatchObject({ value: 0, amount: 0 });
  });

  it('compares transparent pixels as if over white', () => {
    expect(diffAt({ method: 'exact' }, [0, 0, 0, 0], [255, 255, 255, 255]).value).toBe(0);
  });
});


describe('formatDiffValue', () => {
  it('shows each method in its unit', () => {
    expect(formatDiffValue('deltaE', 2.345)).toBe('ΔE 2.35');
    expect(formatDiffValue('perceptual', 0.0123)).toBe('1.23%');
    expect(formatDiffValue('signed', 3)).toBe('Δluma +3.0');
    expect(formatDiffValue('absolute', null)).toBe('');
  });
});


describe('renderDiff', () => {
  const pixels = (...colors) => new Uint8ClampedArray(colors.flatMap(c => [...c, 255]));
  const render = (diff, a, b) => Array.from(renderDiff(a, b, new Uint8ClampedArray(a.length), diff));

  it('shows identical pixels as a faded gray image, and differences in color', () => {
    const a = pixels([0, 0, 0], [0, 0, 0]);
    const b = pixels([0, 0, 0], [255, 255, 255]);
    const [r0, g0, b0, , r1, g1, b1] = render({ method: 'perceptual', max: 0.1 }, a, b);
    // black, faded: light gray
    expect(r0).toBe(g0);
    expect(g0).toBe(b0);
    expect(r0).toBeGreaterThan(200);
    // saturated: the darkest color of the reversed colormap
    expect(r1 + g1 + b1).toBeLessThan(30);
  });

  it('amplifies the absolute difference per channel', () => {
    expect(render({ method: 'absolute', gain: 2 }, pixels([10, 20, 200]), pixels([20, 20, 0]))).toEqual([20, 0, 255, 255]);
  });

  it('shows where new is brighter in red, darker in blue', () => {
    const [r, , b] = render({ method: 'signed', gain: 4 }, pixels([200, 200, 200]), pixels([100, 100, 100]));
    expect(r).toBeGreaterThan(b);
    const [r2, , b2] = render({ method: 'signed', gain: 4 }, pixels([100, 100, 100]), pixels([200, 200, 200]));
    expect(b2).toBeGreaterThan(r2);
  });

  it('marks any change in red', () => {
    expect(render({ method: 'exact' }, pixels([1, 1, 1]), pixels([1, 1, 2])).slice(0, 3)).toEqual([230, 30, 30]);
  });
});


describe('diffLegend', () => {
  it('tells what the last color means', () => {
    expect(diffLegend({ method: 'deltaE', max: 5 })).toMatchObject({ colormap: 'inferno', from: '0', to: 'ΔE 5+' });
    expect(diffLegend({ method: 'absolute', gain: 4 })).toMatchObject({ to: '64+' });
  });
});
