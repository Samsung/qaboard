import { describe, it, expect } from 'vitest';

import { alongImage, formatStat, formatStatDelta, nearest, niceTicks, normalizeAnalysis, profilesOf, STATS, statsOf, statsTsv, valueDomain, valueRange } from '../analysis';

// 3x2 RGBA: a red and a gray column, then a transparent one
const data = new Uint8ClampedArray([
  200, 0, 0, 255, 100, 100, 100, 255, 0, 0, 0, 0,
  100, 0, 0, 255, 50, 50, 50, 255, 0, 0, 0, 0,
]);

describe('profiles', () => {
  it('averages the columns and rows of the pixels shown', () => {
    const { columns, rows } = profilesOf(data, 3, 2);
    const profile = alongImage(columns, k => k);
    expect(profile.length).toBe(2);
    expect(profile.mean[0]).toBe(150);
    expect(profile.std[0]).toBe(50);
    expect(profile.min[0]).toBe(100);
    expect(profile.max[0]).toBe(200);
    expect(profile.mean[4 + 1]).toBe(75);
    const by_row = alongImage(rows, k => k);
    expect(by_row.mean[0]).toBe(150);
    expect(by_row.mean[4]).toBe(75);
  });

  it('reads one row and one column along a line', () => {
    const { columns, rows } = profilesOf(data, 3, 2, { line: { x: 1, y: 1 } });
    expect(alongImage(columns, k => k).mean[0]).toBe(100);
    const column = alongImage(rows, k => k);
    expect(Array.from(column.x)).toEqual([0, 1]);
    expect(column.mean[0]).toBe(100);
    expect(column.std[0]).toBe(0);
  });

  it('merges the screen pixels over the same image pixel', () => {
    const { columns } = profilesOf(data, 3, 2);
    // zoomed in 2x: both columns are image pixel 0
    const profile = alongImage(columns, k => k / 2, true);
    expect(profile.length).toBe(1);
    expect(profile.x[0]).toBe(0.5);
    expect(profile.mean[0]).toBe((200 + 100 + 100 + 50) / 4);
  });

  it('finds the nearest position, and the range of the values', () => {
    const profile = alongImage(profilesOf(data, 3, 2).columns, k => 10 * k);
    expect(nearest(profile, 3)).toBe(0);
    expect(nearest(profile, 7)).toBe(1);
    expect(valueRange([profile], [true, false, false, false], 'minmax')).toEqual([50, 200]);
    expect(valueRange([profile], [true, false, false, false], 'none')).toEqual([75, 150]);
  });
});

describe('axes', () => {
  it('has round ticks', () => {
    expect(niceTicks(0, 255, 5)).toEqual([0, 50, 100, 150, 200, 250]);
    expect(niceTicks(0, 1000, 4)).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(niceTicks(10.2, 11.1, 4)).toEqual([10.2, 10.4, 10.6, 10.8, 11]);
  });

  it('fits the values, or shows them all', () => {
    expect(valueDomain([100, 200], 'full')).toEqual([0, 255]);
    const [lo, hi] = valueDomain([100, 200], 'fit');
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(200);
    expect(valueDomain(null, 'fit')).toEqual([0, 255]);
  });

  it('knows the views', () => {
    expect(normalizeAnalysis('stats')).toBe('stats');
    expect(normalizeAnalysis('nope')).toBe('histogram');
  });
});

describe('statistics', () => {
  const bins = new Float64Array(256);
  bins[0] = 1;
  bins[100] = 2;
  bins[255] = 1;

  it('are computed from the histogram', () => {
    const stats = statsOf(bins, 4);
    expect(stats.mean).toBeCloseTo((200 + 255) / 4);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(255);
    expect(stats.median).toBe(100);
    expect(stats.low).toBe(0.25);
    expect(stats.high).toBe(0.25);
    expect(statsOf(bins, 0)).toBe(null);
  });

  it('have an infinite SNR on flat areas', () => {
    const flat = new Float64Array(256);
    flat[128] = 10;
    expect(statsOf(flat, 10).snr).toBe(Infinity);
    expect(formatStat(STATS.find(s => s.key === 'snr'), Infinity)).toBe('∞');
  });

  it('are formatted, with their differences', () => {
    const mean = STATS.find(s => s.key === 'mean');
    const high = STATS.find(s => s.key === 'high');
    expect(formatStat(mean, 12.345)).toBe('12.35');
    expect(formatStat(high, 0.5)).toBe('50.0%');
    expect(formatStatDelta(mean, 12, 10.5)).toBe('+1.50');
    expect(formatStatDelta(mean, 10, 12)).toBe('−2.00');
    expect(formatStatDelta(high, 0.5, 0.25)).toBe('+25.00 pt');
    expect(formatStatDelta(mean, 1, 1)).toBe('0.00');
  });

  it('copy as tab-separated values', () => {
    const tsv = statsTsv([{ channel: 'R', image: 'new', stats: statsOf(bins, 4) }]);
    const [header, row] = tsv.split('\n');
    expect(header.split('\t').slice(0, 3)).toEqual(['Channel', 'Image', 'Mean']);
    expect(row.split('\t').slice(0, 3)).toEqual(['R', 'new', '113.75']);
  });
});
