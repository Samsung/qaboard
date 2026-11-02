// The analysis of the image's own values over the view (the "Image values" of the analysis panel): what the sensor
// is (CFA, bit depth, black level), and the statistics, profiles and histograms of each of its channels.
//
// What we know about the sensor comes, in this order, from:
// 1. users: the `sensor` prop, e.g. saved for the project,
// 2. the image's metadata: what getPixels returns as `sensor`, e.g. from the image's reader on the server,
// 3. the pixels: the CFA guessed from a patch of the view (cfa.js), the bit depth from the largest value.
// Each value says where it comes from, for the panel to tell.
import { bitDepthOf, cfaChannels, ChannelValues, guessCfaChecked, histogramOfSorted, normalizeCfa, planeOf, subPixelLevels } from './cfa';
import { readAll, readPlan, readRegion } from './regionValues';
import { imageKey } from './sources';

// the patch the CFA is guessed from
const GUESS_SIZE = 256;
const mod = (a, n) => ((a % n) + n) % n;

// What users set: { kind?: 'auto' | 'mosaic' | 'mono', pattern?, block?, offset?, blackLevel?, grouping? }
export const normalizeSensorSetting = setting => ({
  kind: ['mosaic', 'mono'].includes(setting?.kind) ? setting.kind : 'auto',
  pattern: setting?.pattern ?? null,
  block: setting?.block ?? null,
  offset: setting?.offset ?? null,
  blackLevel: Number.isFinite(setting?.blackLevel) ? setting.blackLevel : null,
  grouping: ['rgb', 'cfa', 'sub'].includes(setting?.grouping) ? setting.grouping : 'cfa',
});

// The guesses of the CFA, by image: they don't change as users pan, until they guess again
const guesses = new Map();
export const forgetGuess = image => guesses.delete(imageKey(image));

const guessRegion = (region, size) => {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const w = Math.min(GUESS_SIZE, size?.width ?? GUESS_SIZE);
  const h = Math.min(GUESS_SIZE, size?.height ?? GUESS_SIZE);
  const x = Math.max(0, Math.min((size?.width ?? Infinity) - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min((size?.height ?? Infinity) - h, Math.round(cy - h / 2)));
  return { x, y, w, h };
};

// The sensor of an image, from what users set, its metadata and its pixels
const sensorOf = async (getPixels, image, region, size, setting, signal) => {
  const key = imageKey(image);
  if (!guesses.has(key)) {
    const patch_region = guessRegion(region, size);
    guesses.set(key, readRegion(getPixels, image, patch_region, signal).then(patch => {
      const { kind, plane, colors } = planeOf(patch);
      const guess = kind === 'rgb' ? null : guessCfaChecked(plane, patch.w, patch.h, patch.x, patch.y, colors);
      let max = -Infinity;
      if (plane) for (let i = 0; i < plane.length; i++) if (plane[i] > max) max = plane[i];
      return { patch: { ...patch_region, w: patch.w, h: patch.h }, kind, plane, guess, meta: patch.sensor, mode: patch.mode, max };
    }).catch(error => {
      guesses.delete(key);
      throw error;
    }));
  }
  const { patch, kind: values_kind, plane, guess, meta, mode, max } = await guesses.get(key);
  const sources = {};
  // what the values are: a mosaic (one channel, through a CFA), one channel (no CFA), or color (RGB)
  const meta_cfa = normalizeCfa(meta?.cfa);
  const user_cfa = setting.pattern || setting.block ? normalizeCfa({
    pattern: setting.pattern ?? meta_cfa?.pattern ?? guess?.cfa?.pattern ?? 'GRBG',
    block: setting.block ?? meta_cfa?.block ?? guess?.cfa?.block ?? 1,
    offset: setting.offset ?? meta_cfa?.offset ?? (setting.block ? { x: 0, y: 0 } : guess?.cfa?.offset),
  }) : null;
  let kind;
  if (values_kind === 'rgb') {
    kind = 'rgb';
    sources.kind = 'values';
  } else if (setting.kind !== 'auto') {
    kind = setting.kind;
    sources.kind = 'user';
  } else if (meta?.mono) {
    kind = 'mono';
    sources.kind = 'metadata';
  } else if (user_cfa || meta_cfa || guess?.mosaic) {
    kind = 'mosaic';
    sources.kind = user_cfa ? 'user' : meta_cfa ? 'metadata' : 'pixels';
  } else {
    kind = 'mono';
    sources.kind = 'pixels';
  }
  let cfa = null;
  if (kind === 'mosaic') {
    cfa = user_cfa ?? meta_cfa ?? guess?.cfa ?? normalizeCfa({ pattern: 'GRBG', block: 1 });
    sources.cfa = user_cfa ? 'user' : meta_cfa ? 'metadata' : guess?.mosaic ? 'pixels' : 'default';
  }
  // the bit depth, and the levels
  let bits = null;
  if (meta?.bitDepth) {
    bits = meta.bitDepth;
    sources.bits = 'metadata';
  } else {
    const depth = bitDepthOf(max, mode);
    if (depth) {
      bits = depth.bits;
      sources.bits = depth.source === 'mode' ? 'mode' : 'pixels';
    }
  }
  let white = null;
  if (meta?.whiteLevel) {
    white = meta.whiteLevel;
    sources.white = 'metadata';
  } else if (bits && bits <= 16) {
    white = 2 ** bits - 1;
    sources.white = sources.bits;
  }
  let black = null;
  if (setting.blackLevel !== null) {
    black = setting.blackLevel;
    sources.black = 'user';
  } else if (meta?.blackLevel) {
    black = meta.blackLevel;
    sources.black = 'metadata';
  }
  // do the pixels agree with the metadata, or what users set?
  let check = null;
  if (cfa && guess?.mosaic && sources.cfa !== 'pixels') {
    const g = guess.cfa;
    const greens = p => [...p].map(c => c === 'G').join();
    if (g.block !== cfa.block) check = { agree: false, text: `The pixels look like cells of ${g.block}×${g.block}` };
    else if (greens(g.pattern) !== greens(cfa.pattern) || g.offset.x !== cfa.offset.x || g.offset.y !== cfa.offset.y)
      check = { agree: false, text: `The pixels put the greens elsewhere: like ${g.pattern}${g.offset.x || g.offset.y ? ` from (${g.offset.x}, ${g.offset.y})` : ''}` };
    else check = { agree: true, text: 'The pixels agree' };
  } else if (cfa && guess && !guess.mosaic && sources.cfa !== 'pixels') {
    check = { agree: null, text: "The pixels don't show a clear mosaic here: a flat or gray area?" };
  }
  const levels = kind === 'mosaic' && cfa.block > 1 && plane ? subPixelLevels(plane, patch.w, patch.h, cfa, patch.x, patch.y, black ?? 0) : null;
  return { kind, cfa, bits, white, black, sources, guess, meta, mode, patch, check, levels, max };
};

// The channels of the analysis, and the channel of a pixel
const channelsOf = (sensor, grouping) => {
  if (sensor.kind === 'mosaic') {
    const { channels, table, period } = cfaChannels(sensor.cfa, grouping);
    const { offset } = sensor.cfa;
    return { channels, period, channelAt: (x, y) => table[period * mod(y + offset.y, period) + mod(x + offset.x, period)] };
  }
  if (sensor.kind === 'rgb')
    return { channels: ['R', 'G', 'B'].map(name => ({ key: name, name, color: { R: '#e5484d', G: '#30a46c', B: '#3e63dd' }[name] })), period: 1, perChannel: true };
  return { channels: [{ key: 'V', name: 'Values', color: null }], period: 1, channelAt: () => 0 };
};

// The statistics, profiles and histograms of an image's values over a region
export const analyzeImage = async (getPixels, image, region, size, setting, { signal, onProgress } = {}) => {
  const sensor = await sensorOf(getPixels, image, region, size, setting, signal);
  const grouping = sensor.kind === 'mosaic' ? setting.grouping : null;
  const { channels, period, channelAt, perChannel } = channelsOf(sensor, grouping);
  const plan = readPlan(region);
  const chunks = await readAll(getPixels, image, plan.requests, { signal, onProgress });
  const values = new ChannelValues(channels.length, plan.region, period);
  for (const chunk of chunks) {
    if (perChannel) {
      const n = chunk.w * chunk.h;
      for (let c = 0; c < channels.length; c++) {
        const plane = new Float64Array(n);
        for (let i = 0; i < n; i++) plane[i] = chunk.data[chunk.channels * i + c];
        values.add(plane, chunk.x, chunk.y, chunk.w, chunk.h, () => c, chunk.use);
      }
      continue;
    }
    const { plane } = planeOf(chunk);
    values.add(plane ?? chunk.data, chunk.x, chunk.y, chunk.w, chunk.h, channelAt, chunk.use);
  }
  const result = values.finish({ black: sensor.black, white: sensor.white });
  // histograms over the values' range
  let lo = 0;
  let hi = sensor.white ?? -Infinity;
  for (const sorted of result.sorted)
    if (sorted.length) {
      lo = Math.min(lo, sorted[0]);
      if (sensor.white === null) hi = Math.max(hi, sorted[sorted.length - 1]);
    }
  if (!(hi > lo)) hi = lo + 1;
  const integers = result.sorted.every(sorted => sorted.length === 0 || (Number.isInteger(sorted[0]) && Number.isInteger(sorted[sorted.length - 1])));
  const bins = integers && hi - lo + 1 <= 512 ? Math.max(1, Math.ceil(hi - lo + 1)) : 256;
  const histograms = result.sorted.map(sorted => histogramOfSorted(sorted, lo, integers && bins === hi - lo + 1 ? hi + 1 : hi, bins));
  return { sensor, grouping, channels, plan, stats: result.stats, columns: result.columns, rows: result.rows, histograms, range: [lo, hi], integers };
};
