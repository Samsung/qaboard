import { describe, it, expect } from 'vitest';

import { closeness, compareCandidates } from '../compareWith';

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
