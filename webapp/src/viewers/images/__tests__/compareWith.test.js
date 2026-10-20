import { describe, it, expect } from 'vitest';

import { closeness, comparedFor, compareCandidates, pickCompared } from '../compareWith';

const manifest = paths => Object.fromEntries(paths.map(path => [path, { st_size: 1 }]));

describe('the images to compare with', () => {
  it("lists the run's other images, the likeliest first", () => {
    const candidates = compareCandidates('out/0001.png', manifest([
      'out/0001.png', 'out/0002.png', 'out/0001_gt.png', 'gt/0001.png', 'debug/zz.png', 'metrics.json', 'log.txt',
    ]));
    expect(candidates.map(({ path, suggested }) => [path, suggested])).toEqual([
      ['gt/0001.png', true],
      ['out/0001_gt.png', true],
      ['out/0002.png', true],
      ['debug/zz.png', false],
    ]);
    expect(candidates[0].reason).toBe('Same name, in gt/');
  });

  it("doesn't list the TIFF shown for a PNG", () => {
    const paths = compareCandidates('a.png', manifest(['a.png', 'a.tiff', 'b.png', 'b.tiff', 'c.tiff'])).map(({ path }) => path);
    expect(paths).toEqual(['b.png', 'c.tiff']);
  });

  it("lists the formats the site's image servers open", () => {
    const files = manifest(['a.png', 'frame.yuv', 'frame.RAW12', 'notes.txt']);
    expect(compareCandidates('a.png', files).map(({ path }) => path)).toEqual([]);
    const servers = { default: '/iiif/2/', 'yuv, raw12': '/iiif/cde/' };
    expect(compareCandidates('a.png', files, servers).map(({ path }) => path)).toEqual(['frame.RAW12', 'frame.yuv']);
  });

  it('sorts the others like people do', () => {
    const paths = compareCandidates('x/a.png', manifest(['x/a.png', 'y/frame10.png', 'y/frame2.png'])).map(({ path }) => path);
    expect(paths).toEqual(['y/frame2.png', 'y/frame10.png']);
  });

  it('only suggests images with a reason', () => {
    expect(closeness('out/a.png', 'other/b.png').score).toBe(0);
    expect(closeness('out/frame.png', 'out/frame_gt.png').score).toBeGreaterThan(closeness('out/frame.png', 'out/frame_x.png').score);
    expect(compareCandidates('a.png', undefined)).toEqual([]);
  });
});

describe('what the runs compare with', () => {
  it('is the same file for every run, or one run picks alone', () => {
    let entry = pickCompared(undefined, 1, 'gt/a.png', 'all');
    expect(comparedFor(entry, 1)).toEqual({ compared: 'gt/a.png', alone: false });
    expect(comparedFor(entry, 2)).toEqual({ compared: 'gt/a.png', alone: false });
    // a spot check: run 2 goes back to its reference, the others don't
    entry = pickCompared(entry, 2, null, 'run');
    expect(comparedFor(entry, 2)).toEqual({ compared: null, alone: true });
    expect(comparedFor(entry, 1)).toEqual({ compared: 'gt/a.png', alone: false });
    // picking for all the runs again undoes it
    entry = pickCompared(entry, 1, 'input.png', 'all');
    expect(comparedFor(entry, 2)).toEqual({ compared: 'input.png', alone: false });
    expect(comparedFor(undefined, 1)).toEqual({ compared: null, alone: false });
  });
});
