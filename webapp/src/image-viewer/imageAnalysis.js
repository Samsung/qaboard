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

// What users set: { kind?: 'auto' | 'mosaic' | 'mono', pattern?, block?, offset?, blackLevel?, grouping?, cfaFrom? }
// cfaFrom: 'pixels' when users asked to guess the CFA from the view: the guess wins over the metadata
export const normalizeSensorSetting = setting => ({
  kind: ['mosaic', 'mono'].includes(setting?.kind) ? setting.kind : 'auto',
  cfaFrom: setting?.cfaFrom === 'pixels' ? 'pixels' : 'auto',
  pattern: setting?.pattern ?? null,
  block: setting?.block ?? null,
  offset: setting?.offset ?? null,
  blackLevel: Number.isFinite(setting?.blackLevel) ? setting.blackLevel : null,
  grouping: ['rgb', 'cfa', 'sub'].includes(setting?.grouping) ? setting.grouping : 'cfa',
});

// The guesses of the CFA, by image: they don't change as users pan, until they guess again
const guesses = new Map();
// each guess has an id: the panel tells when a new one arrives
let guess_count = 0;
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
      return { patch: { ...patch_region, w: patch.w, h: patch.h }, kind, plane, guess: guess && { ...guess, id: ++guess_count }, meta: patch.sensor, mode: patch.mode, max };
    }).catch(error => {
      guesses.delete(key);
      throw error;
    }));
  }
  const { patch, kind: values_kind, plane, guess, meta, mode, max } = await guesses.get(key);
  const sources = {};
  // users asked for the pixels' guess: it wins over the metadata, when the pixels show a mosaic
  const from_pixels = setting.cfaFrom === 'pixels' && !!guess?.mosaic;
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
  } else if (from_pixels) {
    kind = 'mosaic';
    sources.kind = 'pixels';
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
    cfa = from_pixels ? guess.cfa : user_cfa ?? meta_cfa ?? guess?.cfa ?? normalizeCfa({ pattern: 'GRBG', block: 1 });
    sources.cfa = from_pixels ? 'pixels' : user_cfa ? 'user' : meta_cfa ? 'metadata' : guess?.mosaic ? 'pixels' : 'default';
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
  } else if (cfa && sources.cfa === 'pixels' && meta_cfa) {
    // guessed when the metadata knows: do they agree?
    const greens = p => [...p].map(c => c === 'G').join();
    const same = meta_cfa.block === cfa.block && greens(meta_cfa.pattern) === greens(cfa.pattern) && meta_cfa.offset.x === cfa.offset.x && meta_cfa.offset.y === cfa.offset.y;
    check = same ? { agree: true, text: 'The metadata agrees' } : { agree: false, text: 'The metadata says otherwise', metadata: meta_cfa };
  }
  // asked to guess, but the pixels show no mosaic: what's used instead
  const guess_failed = setting.cfaFrom === 'pixels' && !from_pixels;
  const levels = kind === 'mosaic' && cfa.block > 1 && plane ? subPixelLevels(plane, patch.w, patch.h, cfa, patch.x, patch.y, black ?? 0) : null;
  return { kind, cfa, bits, white, black, sources, guess, meta, mode, patch, check, levels, max, guessFailed: guess_failed };
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
  // what was read, to highlight a range of values on the image (see highlightMask)
  const read = [];
  for (const chunk of chunks) {
    if (perChannel) {
      const n = chunk.w * chunk.h;
      for (let c = 0; c < channels.length; c++) {
        const plane = new Float64Array(n);
        for (let i = 0; i < n; i++) plane[i] = chunk.data[chunk.channels * i + c];
        values.add(plane, chunk.x, chunk.y, chunk.w, chunk.h, () => c, chunk.use);
      }
      read.push({ x: chunk.x, y: chunk.y, w: chunk.w, h: chunk.h, data: chunk.data, channels: chunk.channels, use: chunk.use });
      continue;
    }
    const { plane } = planeOf(chunk);
    values.add(plane ?? chunk.data, chunk.x, chunk.y, chunk.w, chunk.h, channelAt, chunk.use);
    read.push({ x: chunk.x, y: chunk.y, w: chunk.w, h: chunk.h, data: plane ?? chunk.data, channels: 1, use: chunk.use });
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
  const top = integers && bins === hi - lo + 1 ? hi + 1 : hi;
  const histograms = result.sorted.map(sorted => histogramOfSorted(sorted, lo, top, bins));
  return {
    sensor, grouping, channels, plan, stats: result.stats, columns: result.columns, rows: result.rows, histograms, range: [lo, hi], integers,
    // the histograms' bins: from edges[0] to edges[1], evenly
    edges: [lo, top],
    chunks: read,
    channelAt: perChannel ? null : channelAt,
  };
};


// --- Highlighting a range of values on the image ---

// The range of values of the histogram's bins k0 to k1: { lo, hi }, both included. Integers: the integers in the bins.
export const binsToRange = (analysis, k0, k1) => {
  const [lo, top] = analysis.edges;
  const bins = analysis.histograms[0]?.length ?? 1;
  const edge = k => lo + k * (top - lo) / bins;
  if (analysis.integers) return { lo: Math.ceil(edge(k0)), hi: Math.max(Math.ceil(edge(k0)), Math.ceil(edge(k1 + 1)) - 1) };
  return { lo: edge(k0), hi: edge(k1 + 1) };
};

// Where a range is on the histogram: its first and last bins, clamped to it
export const rangeToBins = (analysis, range) => {
  const [lo, top] = analysis.edges;
  const bins = analysis.histograms[0]?.length ?? 1;
  const width = (top - lo) / bins || 1;
  const bin = v => Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width + 1e-9)));
  // the last bin with values in the range
  const last = analysis.integers ? bin(range.hi) : Math.min(bins - 1, Math.max(0, Math.ceil((range.hi - lo) / width - 1e-9) - 1));
  return [bin(range.lo), Math.max(bin(range.lo), last)];
};

export const MASK = { none: 0, out: 1, in: 2 };

// The pixels read, within the range or not: [{ x, y, w, h, states: Uint8Array of MASK }], and how many pixels of the
// statistics are in it. A pixel is in the range when its channel is shown (shown(channel)) and its value in the range;
// for color values, when all the channels shown are. Pixels without a value (NaN), or no channel, are none.
export const highlightMask = (analysis, range, shown) => {
  const { chunks, channels, channelAt } = analysis;
  const visible = channels.map(shown);
  const inRange = v => v >= range.lo && v <= range.hi;
  let selected = 0;
  let total = 0;
  const masks = chunks.map(({ x, y, w, h, data, channels: per_pixel, use }) => {
    const states = new Uint8Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const p = j * w + i;
        let state;
        if (per_pixel > 1 || !channelAt) {
          // color values: all the channels shown in the range
          state = MASK.in;
          for (let c = 0; c < channels.length; c++) {
            const v = data[per_pixel * p + c];
            if (v === null || v === undefined || Number.isNaN(v)) {
              state = MASK.none;
              break;
            }
            if (visible[c] && !inRange(v)) state = MASK.out;
          }
        } else {
          const v = data[p];
          const c = channelAt(x + i, y + j);
          if (c < 0 || v === null || v === undefined || Number.isNaN(v)) state = MASK.none;
          else state = visible[c] && inRange(v) ? MASK.in : MASK.out;
        }
        states[p] = state;
        if (use?.stats !== false && state !== MASK.none) {
          total++;
          if (state === MASK.in) selected++;
        }
      }
    return { x, y, w, h, states };
  });
  return { chunks: masks, selected, total, sampled: !!analysis.plan?.sampled };
};
