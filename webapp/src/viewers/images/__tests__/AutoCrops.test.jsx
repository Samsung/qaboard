import { describe, it, expect } from 'vitest';

import { blobToRoi } from '../AutoCrops';


describe('blobToRoi', () => {
  it('turns a blob found by the server into a colored ROI inside the image', () => {
    const roi = blobToRoi({ x: 980, y: -10, r: 40, diff: 0.25 }, 1000, 500);
    expect(roi).toMatchObject({ x: 980, y: 0, w: 20, h: 30, diff: 0.25 });
    expect(roi.color.formatHex()).toMatch(/^#[0-9a-f]{6}$/);
    expect(blobToRoi({ x: -2, y: 95, r: 10, diff: 0.5 }, 100, 100)).toMatchObject({ x: 0, y: 95, w: 8, h: 5 });
  });

  it('gives the largest differences the darkest color', () => {
    const brightness = diff => {
      const { r, g, b } = blobToRoi({ x: 10, y: 10, r: 5, diff }, 1000, 500).color;
      return r + g + b;
    };
    expect(brightness(1)).toBeLessThan(brightness(0));
    expect(brightness(3)).toEqual(brightness(1));
  });
});
