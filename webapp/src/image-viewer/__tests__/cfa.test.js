import { describe, it, expect } from 'vitest';

import { bitDepthOf, cellAt, cellNames, cfaChannels, channelRatios, channelStats, ChannelValues, guessCfa, histogramOfSorted, normalizeCfa, planeOf, subPixelLevels } from '../cfa';

// A random generator with a seed, for tests that don't flake
const random = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

// A raw image of a scene (gradients, a few edges, noise) through a CFA, 10-bit with a black level
const GAINS = { R: 0.45, G: 1, B: 0.65 };
const mosaic = (cfa, { w = 192, h = 160, black = 64, noise = 6, levels = null, seed = 7 } = {}) => {
  const rand = random(seed);
  const plane = new Float64Array(w * h);
  const colors = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const scene = 300 + 250 * Math.sin(x / 37) * Math.cos(y / 23) + (x > w / 2 ? 120 : 0) + (y % 50 < 8 ? 80 : 0);
      const color = cfa.pattern[cellAt(cfa, x, y)];
      let level = 1;
      if (levels) {
        const s = (((y + cfa.offset.y) % cfa.block) * cfa.block) + ((x + cfa.offset.x) % cfa.block);
        level = levels[s];
      }
      plane[y * w + x] = Math.min(1023, Math.round(black + scene * GAINS[color] * level + noise * (rand() - 0.5) * 2));
      colors[y * w + x] = 'RGB'.indexOf(color);
    }
  return { plane, colors, w, h };
};

describe('CFAs', () => {
  it('names the cells, and the greens of the red and blue rows', () => {
    expect(cellNames('GRBG')).toEqual(['Gr', 'R', 'B', 'Gb']);
    expect(cellNames('RGGB')).toEqual(['R', 'Gr', 'Gb', 'B']);
    expect(cellNames('BGGR')).toEqual(['B', 'Gb', 'Gr', 'R']);
    const tetra = normalizeCfa({ pattern: 'grbg', block: 2, offset: { x: 5, y: -1 } });
    // shifted by a cell down: the rows swap
    expect(tetra).toEqual({ pattern: 'BGGR', block: 2, offset: { x: 1, y: 1 } });
    expect(normalizeCfa({ pattern: 'XYZW' })).toBe(null);
  });

  it('maps the pixels of the period to channels', () => {
    const cfa = normalizeCfa({ pattern: 'GRBG', block: 2 });
    const { channels, table, period } = cfaChannels(cfa, 'cfa');
    expect(channels.map(c => c.name)).toEqual(['R', 'Gr', 'Gb', 'B']);
    expect(period).toBe(4);
    // top left 2x2: Gr, then R
    expect([table[0], table[1], table[2], table[3]]).toEqual([1, 1, 0, 0]);
    expect(table[4 * 2]).toBe(3);
    const sub = cfaChannels(cfa, 'sub');
    expect(sub.channels).toHaveLength(16);
    expect(sub.channels[sub.table[1]].name).toBe('Gr2');
    expect(sub.channels[sub.table[4 + 2]].name).toBe('R3');
    expect(cfaChannels(cfa, 'rgb').channels.map(c => c.name)).toEqual(['R', 'G', 'B']);
  });
});

describe('guessing the CFA', () => {
  for (const [pattern, block, offset] of [['GRBG', 1, { x: 0, y: 0 }], ['GRBG', 2, { x: 0, y: 0 }], ['RGGB', 2, { x: 1, y: 0 }], ['GRBG', 3, { x: 2, y: 1 }], ['RGGB', 4, { x: 0, y: 0 }]])
    it(`finds ${pattern} in cells of ${block}x${block}, offset by ${offset.x},${offset.y}`, () => {
      const cfa = normalizeCfa({ pattern, block, offset });
      const { plane, w, h } = mosaic(cfa);
      const guess = guessCfa(plane, w, h);
      expect(guess.mosaic).toBe(true);
      expect(guess.cfa.block).toBe(block);
      expect(guess.cfa.offset).toEqual(cfa.offset);
      // the greens, red and blue aside
      expect([...guess.cfa.pattern].map(c => c === 'G')).toEqual([...pattern].map(c => c === 'G'));
      expect(guess.redBlueKnown).toBe(false);
      expect(guess.confidence).not.toBe('low');
    });

  it('works on a region away from the origin', () => {
    const cfa = normalizeCfa({ pattern: 'GBRG', block: 2, offset: { x: 0, y: 0 } });
    const { plane, w } = mosaic(cfa, { w: 200, h: 200 });
    // the region at (6, 5) of the image
    const region = new Float64Array(120 * 120);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) region[y * 120 + x] = plane[(y + 5) * w + x + 6];
    const guess = guessCfa(region, 120, 120, 6, 5);
    expect(guess.cfa.block).toBe(2);
    expect(guess.cfa.offset).toEqual({ x: 0, y: 0 });
    expect([...guess.cfa.pattern].map(c => c === 'G')).toEqual([true, false, false, true]);
  });

  it('says when there is no mosaic', () => {
    const rand = random(3);
    const w = 128;
    const plane = Float64Array.from({ length: w * w }, (_, i) => 300 + 200 * Math.sin((i % w) / 20) + 5 * rand());
    expect(guessCfa(plane, w, w).mosaic).toBe(false);
  });

  it('reads the exact CFA of pixels with one color each', () => {
    const cfa = normalizeCfa({ pattern: 'BGGR', block: 3, offset: { x: 1, y: 2 } });
    const { plane, colors, w, h } = mosaic(cfa);
    const guess = guessCfa(plane, w, h, 0, 0, colors);
    expect(guess.cfa).toEqual(cfa);
    expect(guess.redBlueKnown).toBe(true);
    expect(guess.exact).toBe(true);
  });

  it('finds the sub-pixels with other exposures', () => {
    const cfa = normalizeCfa({ pattern: 'GRBG', block: 2 });
    // Quad HDR-like: the diagonal of each cell is 4x brighter
    const { plane, w, h } = mosaic(cfa, { levels: [1, 0.25, 0.25, 1], noise: 2 });
    const levels = subPixelLevels(plane, w, h, cfa, 0, 0, 64);
    expect(levels.bright).toEqual([0, 3]);
    expect(levels.ratio).toBeGreaterThan(3);
    const flat = subPixelLevels(mosaic(cfa).plane, w, h, cfa, 0, 0, 64);
    expect(flat.bright).toEqual([]);
  });
});

describe('planes', () => {
  it('picks a plane from gray, one-hot or color pixels', () => {
    expect(planeOf({ data: [1, 2, 3, 4], w: 2, h: 2, channels: 1 }).kind).toBe('mono');
    expect(planeOf({ data: [5, 5, 5, 9, 9, 9], w: 2, h: 1, channels: 3 }).kind).toBe('mono');
    const onehot = planeOf({ data: [0, 7, 0, 3, 0, 0], w: 2, h: 1, channels: 3 });
    expect(onehot.kind).toBe('onehot');
    expect(Array.from(onehot.plane)).toEqual([7, 3]);
    expect(Array.from(onehot.colors)).toEqual([1, 0]);
    expect(planeOf({ data: [1, 2, 3, 4, 5, 6], w: 2, h: 1, channels: 3 }).kind).toBe('rgb');
  });
});

describe('statistics by channel', () => {
  it('computes them without the black level, with the clipped shares', () => {
    const stats = channelStats(Float64Array.from([64, 74, 84, 1023]), 64, 1023);
    expect(stats.mean).toBeCloseTo(311.25);
    expect(stats.signal).toBeCloseTo(247.25);
    expect(stats.median).toBe(74);
    expect(stats.low).toBe(0.25);
    expect(stats.high).toBe(0.25);
  });

  it('profiles and counts each channel', () => {
    const cfa = normalizeCfa({ pattern: 'RGGB', block: 1 });
    const { channels, table, period } = cfaChannels(cfa, 'cfa');
    const { plane, w, h } = mosaic(cfa, { w: 32, h: 16, noise: 0 });
    const region = { x: 0, y: 0, w, h };
    const values = new ChannelValues(channels.length, region, period);
    values.add(plane, 0, 0, w, h, (x, y) => table[period * (y % period) + (x % period)]);
    const { stats, columns, rows } = values.finish({ black: 64, white: 1023 });
    expect(stats.map(s => s.count)).toEqual([128, 128, 128, 128]);
    expect(columns.length).toBe(16);
    expect(rows.length).toBe(8);
    expect(columns.stride).toBe(4);
    const ratios = channelRatios(channels, stats);
    expect(ratios.find(r => r.key === 'R/G').value).toBeCloseTo(0.45, 1);
    expect(ratios.find(r => r.key === 'Gr/Gb').value).toBeCloseTo(1, 1);
  });

  it('knows the bit depth, from the type or the values', () => {
    expect(bitDepthOf(500, 'UI10')).toEqual({ bits: 10, source: 'mode' });
    expect(bitDepthOf(3000, 'L')).toEqual({ bits: 12, source: 'values' });
    expect(bitDepthOf(3000, 'I;16')).toEqual({ bits: 12, source: 'values' });
    expect(bitDepthOf(30, 'RGB;10')).toEqual({ bits: 10, source: 'mode' });
    expect(bitDepthOf(30, 'UI16')).toEqual({ bits: 16, source: 'mode' });
    expect(bitDepthOf(0.5, 'F')).toBe(null);
    expect(Array.from(histogramOfSorted([0, 1, 2, 3], 0, 4, 2))).toEqual([2, 2]);
  });
});
