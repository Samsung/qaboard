import { describe, it, expect } from 'vitest';

import { ALL_CHANNELS, dragRange, formatShare, histogramMax, histogramOf, inRange, rangeDrag, renderHighlight, toggleChannel, valueAt } from '../histogram';

const ONLY_RED = [true, false, false, false];

describe('histograms', () => {
  // red, gray, and a transparent pixel
  const data = new Uint8ClampedArray([200, 10, 10, 255, 100, 100, 100, 255, 0, 0, 0, 0]);

  it('counts the values of the pixels shown, and those highlighted', () => {
    const { bins, total, selected } = histogramOf(data, 3, 1, { lo: 150, hi: 255, channels: ONLY_RED });
    expect(total).toBe(2);
    expect(bins[0][200]).toBe(1);
    expect(bins[0][100]).toBe(1);
    expect(bins[0][0]).toBe(0);
    expect(bins[3][Math.round(0.299 * 200 + 0.587 * 10 + 0.114 * 10)]).toBe(1);
    expect(selected).toBe(1);
  });

  it('highlights the pixels whose channels shown are all in the range', () => {
    expect(inRange(200, 10, 10, { lo: 150, hi: 255, channels: ONLY_RED })).toBe(true);
    expect(inRange(200, 10, 10, { lo: 150, hi: 255, channels: ALL_CHANNELS })).toBe(false);
    expect(inRange(100, 100, 100, { lo: 100, hi: 100, channels: ALL_CHANNELS })).toBe(true);
  });

  it('scales to the channels shown, without the clipped values', () => {
    const { bins, total } = histogramOf(data, 3, 1);
    const series = [{ bins, total }];
    expect(histogramMax(series, ALL_CHANNELS)).toBe(0.5);
    bins[0][255] = 100;
    expect(histogramMax(series, ALL_CHANNELS)).toBe(0.5);
    expect(histogramMax(series, [false, false, false, false])).toBe(0);
  });

  it('draws stripes on the highlighted pixels, and dims the others', () => {
    const out = new Uint8ClampedArray(data.length);
    renderHighlight(data, out, 3, { lo: 150, hi: 255, channels: ONLY_RED });
    expect(Array.from(out.slice(0, 4))).toEqual([255, 214, 10, 217]);
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 0, 115]);
    expect(out[11]).toBe(0);
  });
});

describe('the range users drag', () => {
  it('maps positions to values', () => {
    expect(valueAt(0)).toBe(0);
    expect(valueAt(0.5)).toBe(128);
    expect(valueAt(1)).toBe(255);
    expect(valueAt(-1)).toBe(0);
  });

  it('picks what to drag', () => {
    const range = { lo: 100, hi: 150 };
    expect(rangeDrag(null, 120)).toBe('new');
    expect(rangeDrag(range, 101)).toBe('lo');
    expect(rangeDrag(range, 149)).toBe('hi');
    expect(rangeDrag(range, 120)).toBe('move');
    expect(rangeDrag(range, 20)).toBe('new');
  });

  it('drags new ranges, edges and ranges', () => {
    const range = { lo: 100, hi: 150 };
    expect(dragRange('new', { range: null, value: 80 }, 20)).toEqual({ lo: 20, hi: 80 });
    expect(dragRange('lo', { range, value: 100 }, 90)).toEqual({ lo: 90, hi: 150 });
    // past the other edge
    expect(dragRange('lo', { range, value: 100 }, 200)).toEqual({ lo: 150, hi: 200 });
    expect(dragRange('move', { range, value: 120 }, 130)).toEqual({ lo: 110, hi: 160 });
    // not past the ends
    expect(dragRange('move', { range, value: 120 }, 250)).toEqual({ lo: 205, hi: 255 });
    expect(dragRange('move', { range, value: 0 }, -500)).toEqual({ lo: 0, hi: 50 });
  });

  it('shows a channel alone, or all of them again', () => {
    expect(toggleChannel(ALL_CHANNELS, 0)).toEqual(ONLY_RED);
    expect(toggleChannel(ONLY_RED, 0)).toEqual(ALL_CHANNELS);
    expect(toggleChannel(ONLY_RED, 1, true)).toEqual([true, true, false, false]);
    // not none
    expect(toggleChannel(ONLY_RED, 0, true)).toEqual(ONLY_RED);
  });

  it('formats shares', () => {
    expect(formatShare(0, 0)).toBe('–');
    expect(formatShare(0, 10)).toBe('0%');
    expect(formatShare(1, 1e6)).toBe('<0.01%');
    expect(formatShare(1, 3)).toBe('33.3%');
    expect(formatShare(1, 30)).toBe('3.33%');
  });
});
