import { describe, it, expect } from 'vitest';

import { cellAt, describeCfa } from '../cfa';
import { analyzeImage, forgetGuess } from '../imageAnalysis';

// A raw image of a textured scene through a Bayer GRBG filter, 10-bit, with a black level
const W = 256;
const H = 256;
const GAINS = { R: 0.45, G: 1, B: 0.65 };
const raw = (() => {
  const cfa = { pattern: 'GRBG', block: 1, offset: { x: 0, y: 0 } };
  const plane = new Uint16Array(W * H);
  let seed = 7;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      seed = (seed * 16807) % 2147483647;
      const scene = 300 + 250 * Math.sin(x / 37) * Math.cos(y / 23) + (x > W / 2 ? 120 : 0) + (y % 50 < 8 ? 80 : 0);
      const color = cfa.pattern[cellAt(cfa, x, y)];
      plane[y * W + x] = Math.min(1023, Math.round(64 + scene * GAINS[color] + 6 * ((seed / 2147483647) - 0.5)));
    }
  return plane;
})();

// The image's reader on the server says it's a Tetra 2×2: wrong
const pixelsWith = sensor => async (image, { x, y, w, h }) => {
  const data = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) data.set(raw.subarray((y + j) * W + x, (y + j) * W + x + w), j * w);
  return { data, width: w, height: h, channels: 1, mode: 'I;16', sensor };
};
const analyze = async (sensor, setting, name) => {
  const image = { url: `sensor-guess-${name}` };
  forgetGuess(image);
  return (await analyzeImage(pixelsWith(sensor), image, { x: 0, y: 0, w: W, h: H }, { width: W, height: H }, { grouping: 'cfa', ...setting })).sensor;
};

describe('guessing the CFA from the view', () => {
  it('keeps the metadata, and says the pixels disagree', async () => {
    const sensor = await analyze({ cfa: { pattern: 'GRBG', block: 2 } }, { kind: 'auto' }, 'metadata');
    expect(sensor.sources.cfa).toBe('metadata');
    expect(describeCfa(sensor.cfa)).toBe('GRBG · Tetra 2×2');
    expect(sensor.check.agree).toBe(false);
    expect(sensor.guess.mosaic).toBe(true);
  });

  it('uses the guess over the metadata when users ask for it, and says the metadata disagrees', async () => {
    const sensor = await analyze({ cfa: { pattern: 'GRBG', block: 2 } }, { kind: 'auto', cfaFrom: 'pixels' }, 'from-pixels');
    expect(sensor.sources.cfa).toBe('pixels');
    expect(sensor.cfa.block).toBe(1);
    expect(sensor.check).toMatchObject({ agree: false, metadata: { block: 2 } });
    expect(sensor.guessFailed).toBe(false);
    expect(sensor.patch).toMatchObject({ x: 0, y: 0, w: 256, h: 256 });
  });

  it('says when the metadata agrees with the guess', async () => {
    const sensor = await analyze({ cfa: { pattern: 'GRBG', block: 1 } }, { kind: 'auto', cfaFrom: 'pixels' }, 'agree');
    expect(sensor.check).toMatchObject({ agree: true });
  });

  it("keeps the metadata when the pixels show no mosaic, and says the guess failed", async () => {
    const flat = async (image, { w, h }) => ({ data: new Uint16Array(w * h).fill(500), width: w, height: h, channels: 1, mode: 'I;16', sensor: { cfa: { pattern: 'RGGB', block: 1 } } });
    const image = { url: 'sensor-guess-flat' };
    forgetGuess(image);
    const { sensor } = await analyzeImage(flat, image, { x: 0, y: 0, w: W, h: H }, { width: W, height: H }, { kind: 'auto', grouping: 'cfa', cfaFrom: 'pixels' });
    expect(sensor.sources.cfa).toBe('metadata');
    expect(sensor.cfa.pattern).toBe('RGGB');
    expect(sensor.guessFailed).toBe(true);
  });

  it('gives each guess an id, the same until guessed again', async () => {
    const image = { url: 'sensor-guess-id' };
    forgetGuess(image);
    const getPixels = pixelsWith(null);
    const run = () => analyzeImage(getPixels, image, { x: 0, y: 0, w: W, h: H }, { width: W, height: H }, { kind: 'auto', grouping: 'cfa' });
    const first = (await run()).sensor.guess.id;
    expect((await run()).sensor.guess.id).toBe(first);
    forgetGuess(image);
    expect((await run()).sensor.guess.id).not.toBe(first);
  });
});
