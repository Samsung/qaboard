import { describe, it, expect } from 'vitest';

import { dragRange } from '../histogram';
import { analyzeImage, binsToRange, highlightMask, MASK, rangeToBins } from '../imageAnalysis';

// An analysis as analyzeImage returns it, with only what the highlight needs
const analysisOf = ({ edges, bins, integers = true, chunks = [], channels = [{ key: 'V' }], channelAt = () => 0, sampled = false }) => ({
  edges,
  integers,
  histograms: [new Float64Array(bins)],
  chunks,
  channels,
  channelAt,
  plan: { sampled },
});

describe('binsToRange / rangeToBins', () => {
  it('maps one bin per value to the values', () => {
    const analysis = analysisOf({ edges: [0, 256], bins: 256 });
    expect(binsToRange(analysis, 10, 20)).toEqual({ lo: 10, hi: 20 });
    expect(rangeToBins(analysis, { lo: 10, hi: 20 })).toEqual([10, 20]);
  });
  it('maps wide bins of integers to the integers in them', () => {
    // 14-bit in 256 bins: 64 values each
    const analysis = analysisOf({ edges: [0, 16383], bins: 256 });
    const range = binsToRange(analysis, 64, 65);
    expect(range.lo).toBe(Math.ceil(64 * 16383 / 256));
    expect(range.hi).toBe(Math.ceil(66 * 16383 / 256) - 1);
    expect(rangeToBins(analysis, range)).toEqual([64, 65]);
  });
  it('maps bins of floats to their edges', () => {
    const analysis = analysisOf({ edges: [0, 1], bins: 256, integers: false });
    const range = binsToRange(analysis, 0, 127);
    expect(range).toEqual({ lo: 0, hi: 0.5 });
    expect(rangeToBins(analysis, range)).toEqual([0, 127]);
  });
  it('clamps ranges out of the histogram', () => {
    const analysis = analysisOf({ edges: [0, 256], bins: 256 });
    expect(rangeToBins(analysis, { lo: -5, hi: 1000 })).toEqual([0, 255]);
  });
});

describe('dragRange', () => {
  it('moves within any number of bins', () => {
    expect(dragRange('move', { range: { lo: 900, hi: 1000 }, value: 0 }, 100, 1023)).toEqual({ lo: 923, hi: 1023 });
    expect(dragRange('move', { range: { lo: 200, hi: 250 }, value: 0 }, 100)).toEqual({ lo: 205, hi: 255 });
  });
});

describe('highlightMask', () => {
  // 4×2 mosaic, R G / G B, channels: R 0, G 1, B 2
  const channels = [{ key: 'R', cell: 'R' }, { key: 'G', cell: 'G' }, { key: 'B', cell: 'B' }];
  const channelAt = (x, y) => [[0, 1], [1, 2]][y % 2][x % 2];
  const data = [10, 20, 30, NaN, 40, 50, 60, 70];
  const chunks = [{ x: 0, y: 0, w: 4, h: 2, data, channels: 1, use: { stats: true } }];

  it('marks the pixels of the channels shown in the range', () => {
    const analysis = analysisOf({ edges: [0, 128], bins: 128, chunks, channels, channelAt });
    const mask = highlightMask(analysis, { lo: 15, hi: 55 }, () => true);
    expect(Array.from(mask.chunks[0].states)).toEqual([MASK.out, MASK.in, MASK.in, MASK.none, MASK.in, MASK.in, MASK.out, MASK.out]);
    expect(mask).toMatchObject({ selected: 4, total: 7, sampled: false });
  });
  it("doesn't highlight the channels hidden", () => {
    const analysis = analysisOf({ edges: [0, 128], bins: 128, chunks, channels, channelAt });
    const mask = highlightMask(analysis, { lo: 0, hi: 100 }, channel => channel.key !== 'G');
    // G: (1, 0), (3, 0), (0, 1), (2, 1)
    expect(Array.from(mask.chunks[0].states)).toEqual([MASK.in, MASK.out, MASK.in, MASK.none, MASK.out, MASK.in, MASK.out, MASK.in]);
  });
  it('needs all the channels shown of color values in the range', () => {
    const rgb = [[10, 200, 10], [10, 10, 10], [200, 200, 200]].flat();
    const analysis = analysisOf({
      edges: [0, 256], bins: 256,
      chunks: [{ x: 0, y: 0, w: 3, h: 1, data: rgb, channels: 3, use: { stats: true } }],
      channels: [{ key: 'R' }, { key: 'G' }, { key: 'B' }],
      channelAt: null,
    });
    expect(Array.from(highlightMask(analysis, { lo: 0, hi: 50 }, () => true).chunks[0].states)).toEqual([MASK.out, MASK.in, MASK.out]);
    // without G
    expect(Array.from(highlightMask(analysis, { lo: 0, hi: 50 }, c => c.key !== 'G').chunks[0].states)).toEqual([MASK.in, MASK.in, MASK.out]);
  });
  it('counts only the pixels of the statistics', () => {
    const analysis = analysisOf({
      edges: [0, 256], bins: 256,
      chunks: [{ x: 0, y: 0, w: 2, h: 1, data: [1, 2], channels: 1, use: { stats: true } }, { x: 0, y: 0, w: 2, h: 1, data: [1, 2], channels: 1, use: { stats: false } }],
      sampled: true,
    });
    expect(highlightMask(analysis, { lo: 0, hi: 1 }, () => true)).toMatchObject({ selected: 1, total: 2, sampled: true });
  });
});

describe('analyzeImage', () => {
  it('keeps what it read, to highlight it', async () => {
    const w = 8;
    const h = 8;
    const values = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => 100 * (x % 2) + 10 * (y % 2) + x));
    const getPixels = async (image, region) => ({ values: values.slice(region.y, region.y + region.h).map(row => row.slice(region.x, region.x + region.w)), mode: 'I;16' });
    const analysis = await analyzeImage(getPixels, { url: 'test-keeps-what-it-read' }, { x: 0, y: 0, w, h }, { width: w, height: h }, { kind: 'mono', grouping: 'cfa' });
    expect(analysis.chunks).toHaveLength(1);
    expect(analysis.chunks[0]).toMatchObject({ x: 0, y: 0, w, h });
    const mask = highlightMask(analysis, { lo: 100, hi: 1000 }, () => true);
    // the odd columns
    expect(mask.selected).toBe(32);
    expect(mask.total).toBe(64);
  });
});
