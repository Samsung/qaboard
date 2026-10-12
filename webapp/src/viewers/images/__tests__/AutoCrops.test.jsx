import { describe, it, expect } from 'vitest';

import AutoCrops from '../AutoCrops';


const viewer = { world: { getItemAt: () => ({ getContentSize: () => ({ x: 1000, y: 500 }) }) } };

describe('AutoCrops.blobToRoi', () => {
  it('turns a blob found by the server into a colored ROI inside the image', () => {
    const auto_crops = new AutoCrops({ viewer });
    const roi = auto_crops.blobToRoi({ x: 980, y: -10, r: 40, diff: 0.25 });
    expect(roi).toMatchObject({ x: 980, y: 0, w: 20, h: 30, diff: 0.25 });
    expect(roi.color.formatHex()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gives the largest differences the darkest color', () => {
    const auto_crops = new AutoCrops({ viewer });
    const brightness = diff => {
      const { r, g, b } = auto_crops.blobToRoi({ x: 10, y: 10, r: 5, diff }).color;
      return r + g + b;
    };
    expect(brightness(1)).toBeLessThan(brightness(0));
    expect(brightness(3)).toEqual(brightness(1));
  });
});
