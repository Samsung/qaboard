// The image's own values over a region, for the analysis panel, from the app's getPixels: requests of at most 256×256
// pixels (65,536, what QA-Board's server accepts), a few at a time.
//
// Small views are read whole. Larger ones are read in strips across them, evenly spaced: full-width strips for the
// statistics and the profile of the columns, full-height strips for the profile of the rows. The panel says so.
import { normalizePixels } from './pixelTiles';
import { imageKey } from './sources';

export const REQUEST_PIXELS = 256 * 256;
// about 4 MB of 16-bit values, 32 requests
export const BUDGET = 2_000_000;
const STRIP = 32;
const CONCURRENCY = 6;

// The requests that read a region: [{ x, y, w, h, use: { stats, columns, rows } }], and whether they sample it
export const readPlan = (region, budget = BUDGET) => {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const w = Math.max(1, Math.ceil(region.x + region.w) - x0);
  const h = Math.max(1, Math.ceil(region.y + region.h) - y0);
  const requests = [];
  const tile = (x, y, tw, th, use) => {
    // at most REQUEST_PIXELS each: as wide as they can
    const width = Math.min(tw, REQUEST_PIXELS);
    const height = Math.max(1, Math.min(th, Math.floor(REQUEST_PIXELS / width)));
    for (let ty = y; ty < y + th; ty += height)
      for (let tx = x; tx < x + tw; tx += width)
        requests.push({ x: tx, y: ty, w: Math.min(width, x + tw - tx), h: Math.min(height, y + th - ty), use });
  };
  if (w * h <= budget) {
    // squares: neighbors on the server's disk
    for (let ty = y0; ty < y0 + h; ty += 256)
      for (let tx = x0; tx < x0 + w; tx += 256)
        requests.push({ x: tx, y: ty, w: Math.min(256, x0 + w - tx), h: Math.min(256, y0 + h - ty), use: { stats: true, columns: true, rows: true } });
    return { region: { x: x0, y: y0, w, h }, requests, sampled: false, rows: h, columns: w };
  }
  const row_strips = Math.max(2, Math.min(Math.floor(h / STRIP), Math.floor(budget / 2 / (w * STRIP))));
  const column_strips = Math.max(2, Math.min(Math.floor(w / STRIP), Math.floor(budget / 2 / (h * STRIP))));
  const spread = (count, length) => Array.from({ length: count }, (_, i) => Math.floor((i + 0.5) * length / count - STRIP / 2));
  for (const y of spread(row_strips, h)) tile(x0, y0 + Math.max(0, y), w, Math.min(STRIP, h), { stats: true, columns: true, rows: false });
  for (const x of spread(column_strips, w)) tile(x0 + Math.max(0, x), y0, Math.min(STRIP, w), h, { stats: false, columns: false, rows: true });
  return { region: { x: x0, y: y0, w, h }, requests, sampled: true, rows: row_strips * STRIP, columns: column_strips * STRIP };
};

// The values read lately, by image and region: the panel reads them again as users pan
const cache = new Map();
const MAX_CACHED = 256;

const cached = (key, read) => {
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  const promise = read();
  cache.set(key, promise);
  // a request that failed is asked again next time
  promise.catch(() => cache.delete(key));
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return promise;
};

// The values of a region: { x, y, w, h, channels, data, mode, sensor }
export const readRegion = (getPixels, image, { x, y, w, h }, signal) => cached(`${imageKey(image)}|${x},${y},${w},${h}`, async () => {
  // not aborted with the panel: others may want it, and it's cached
  const result = await getPixels(image, { x, y, w, h }, { signal: undefined });
  const pixels = normalizePixels(result);
  return { x, y, w: pixels.w, h: pixels.h, channels: pixels.channels, data: pixels.data, mode: result?.mode, sensor: result?.sensor ?? null };
}).then(value => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return value;
});

// All the requests of a plan, a few at a time. onProgress(done, total)
export const readAll = async (getPixels, image, requests, { signal, onProgress } = {}) => {
  const results = Array.from({ length: requests.length });
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      results[i] = { ...await readRegion(getPixels, image, requests[i], signal), use: requests[i].use };
      done++;
      onProgress?.(done, requests.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, worker));
  return results;
};
