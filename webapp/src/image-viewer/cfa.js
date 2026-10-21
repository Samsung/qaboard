// The color filter arrays (CFA) of image sensors, to analyze raw images by channel: R, Gr, Gb, B, or each pixel of
// their cells (sub-pixels). Used by the analysis panel on the image's own values (getPixels), never the displayed ones.
//
// A CFA is { pattern, block, offset }:
// - pattern: the colors of the 2x2 cells, row by row, e.g. 'GRBG' (G R on top, B G under),
// - block: the size of a cell, in pixels: 1 for Bayer, 2 for Tetra (Quad Bayer), 3 for Nona, 4 for 16-cell...
// - offset: { x, y } where the cells start: pixel (x, y) is in cell ((x + offset.x) / block) of the pattern.
// The period of the CFA is 2 * block pixels, in both directions.

export const CFA_PATTERNS = ['RGGB', 'GRBG', 'GBRG', 'BGGR'];
export const MAX_BLOCK = 9;
export const BLOCKS = Array.from({ length: MAX_BLOCK }, (_, i) => i + 1);
const BLOCK_NAMES = { 1: 'Bayer', 2: 'Tetra', 3: 'Nona', 4: '16-cell' };
export const blockName = block => BLOCK_NAMES[block] ?? `${block}×${block} cells`;
export const describeCfa = cfa => `${cfa.pattern} · ${blockName(cfa.block)}${cfa.block > 1 ? ` ${cfa.block}×${cfa.block}` : ''}`;

export const COLORS = { R: '#e5484d', G: '#30a46c', B: '#3e63dd' };
// the greens of the red and blue rows: two greens
export const CHANNEL_COLORS = { R: '#e5484d', Gr: '#30a46c', Gb: '#12a594', B: '#3e63dd', G: '#30a46c', Y: null };

const mod = (a, n) => ((a % n) + n) % n;

export const normalizeCfa = cfa => {
  if (!cfa) return null;
  const pattern = String(cfa.pattern ?? '').toUpperCase();
  if (!CFA_PATTERNS.includes(pattern)) return null;
  const block = Math.min(MAX_BLOCK, Math.max(1, Math.round(Number(cfa.block) || 1)));
  const period = 2 * block;
  let x = mod(Math.round(cfa.offset?.x ?? 0), period);
  let y = mod(Math.round(cfa.offset?.y ?? 0), period);
  // the same layout, with offsets within a cell: shifted by a cell, the pattern's columns (or rows) swap
  let cells = [...pattern];
  if (x >= block) {
    x -= block;
    cells = [cells[1], cells[0], cells[3], cells[2]];
  }
  if (y >= block) {
    y -= block;
    cells = [cells[2], cells[3], cells[0], cells[1]];
  }
  return { pattern: cells.join(''), block, offset: { x, y } };
};

// The cell (0: top left, 1: top right, 2: bottom left, 3: bottom right) of a pixel
export const cellAt = (cfa, x, y) => {
  const cx = mod(Math.floor((x + cfa.offset.x) / cfa.block), 2);
  const cy = mod(Math.floor((y + cfa.offset.y) / cfa.block), 2);
  return 2 * cy + cx;
};

// The names of the 4 cells: R, Gr, Gb, B. Gr is the green of the red row.
export const cellNames = pattern => {
  const red_row = pattern.indexOf('R') < 2 ? 0 : 1;
  return [...pattern].map((color, cell) => color !== 'G' ? color : (cell < 2 ? 0 : 1) === red_row ? 'Gr' : 'Gb');
};

// How channels are grouped:
// - 'rgb': R, G, B (both greens together)
// - 'cfa': R, Gr, Gb, B
// - 'sub': each pixel of each cell, e.g. R1…R4 in Tetra: they differ when the pixels of a cell have different exposures
export const GROUPINGS = [
  { value: 'rgb', label: 'R G B', title: 'The greens together' },
  { value: 'cfa', label: 'R Gr Gb B', title: 'The greens of the red and blue rows apart' },
  { value: 'sub', label: 'Sub-pixels', title: 'Each pixel of the cells apart, e.g. R1 to R4 in Tetra: they differ with different exposures (long, short…)' },
];

const ORDER = ['R', 'Gr', 'Gb', 'B'];
const lighten = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = v => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
};
const darken = (hex, amount) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = v => Math.round(v * (1 - amount));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
};
// a shade of the color for each sub-pixel, from dark to light
const shade = (hex, i, count) => {
  if (count <= 1) return hex;
  const t = i / (count - 1) - 0.5;
  return t < 0 ? darken(hex, -t * 0.7) : lighten(hex, t * 0.8);
};

// The channels of a CFA for a grouping: [{ key, name, color, cell?, sub? }], and a table of the channel of each pixel of
// the period (2 * block pixels square): the channel of (x, y) is table[period * mod(y + offset.y, period) + mod(x + offset.x, period)]
export const cfaChannels = (cfa, grouping) => {
  const { pattern, block } = cfa;
  const period = 2 * block;
  const names = cellNames(pattern);
  let channels;
  let channelOf;
  if (grouping === 'rgb') {
    channels = ['R', 'G', 'B'].map(name => ({ key: name, name, color: COLORS[name], colors: [name[0]] }));
    channelOf = cell => ['R', 'G', 'B'].indexOf(pattern[cell]);
  } else if (grouping === 'sub' && block > 1) {
    channels = [];
    for (const name of ORDER)
      for (let s = 0; s < block * block; s++)
        channels.push({ key: `${name}${s + 1}`, name: `${name}${s + 1}`, color: shade(CHANNEL_COLORS[name], s, block * block), cell: name, sub: { x: s % block, y: Math.floor(s / block) } });
    channelOf = (cell, sx, sy) => ORDER.indexOf(names[cell]) * block * block + sy * block + sx;
  } else {
    channels = ORDER.map(name => ({ key: name, name, color: CHANNEL_COLORS[name], cell: name }));
    channelOf = cell => ORDER.indexOf(names[cell]);
  }
  const table = new Int16Array(period * period);
  for (let ry = 0; ry < period; ry++)
    for (let rx = 0; rx < period; rx++) {
      const cell = 2 * Math.floor(ry / block) + Math.floor(rx / block);
      table[ry * period + rx] = channelOf(cell, rx % block, ry % block);
    }
  return { channels, table, period };
};


// --- Guessing the CFA from the pixels ---

// The values of a single plane: [values, width, height]. Picks what makes a mosaic of a region of pixels:
// - one channel: the values,
// - gray stored as RGB: the first channel,
// - RGB where each pixel has one channel (a "colored" raw image): that channel, and which it is (exact colors).
// Returns { kind: 'mono' | 'rgb' | 'onehot', plane, colors? }
export const planeOf = ({ data, w, h, channels }) => {
  if (channels === 1) return { kind: 'mono', plane: data };
  const n = w * h;
  let gray = 0;
  let onehot = 0;
  let lit = 0;
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) {
    const r = data[channels * i];
    const g = data[channels * i + 1];
    const b = data[channels * i + 2];
    if (r === g && g === b) gray++;
    const nonzero = (r > 0) + (g > 0) + (b > 0);
    if (nonzero) lit++;
    if (nonzero === 1) onehot++;
  }
  const samples = Math.ceil(n / step);
  if (gray >= 0.99 * samples) {
    const plane = new Float64Array(n);
    for (let i = 0; i < n; i++) plane[i] = data[channels * i];
    return { kind: 'mono', plane };
  }
  if (lit > 0 && onehot >= 0.95 * lit) {
    const plane = new Float64Array(n);
    const colors = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      let best = 255;
      let value = 0;
      for (let c = 0; c < 3; c++) {
        const v = data[channels * i + c];
        if (v > value) {
          value = v;
          best = c;
        }
      }
      plane[i] = value;
      colors[i] = best;
    }
    return { kind: 'onehot', plane, colors };
  }
  return { kind: 'rgb', plane: null };
};

// The sums of the plane over rectangles, in constant time: an integral image
const integralOf = (plane, w, h) => {
  const sums = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const v = plane[y * w + x];
      row += Number.isFinite(v) ? v : 0;
      sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1] + row;
    }
  }
  return sums;
};

// How much the position in a period of 2 * block pixels explains the values, once the scene is removed: the mean
// over a period around each pixel has all the colors in equal parts, so the pixel minus that mean is its color's
// difference (and noise, and the scene's details). Returns { score: the share of the variance explained (R²),
// f: the F statistic, means: the mean difference at each position of the period }
const periodicity = (plane, sums, w, h, block, x0, y0) => {
  const period = 2 * block;
  const stride = w + 1;
  const position_sums = new Float64Array(period * period);
  const position_counts = new Float64Array(period * period);
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w - period) * (h - period) / 60000)));
  for (let y = block; y + block <= h; y += step) {
    const py = mod(y + y0, period);
    for (let x = block; x + block <= w; x += step) {
      const v = plane[y * w + x];
      if (!Number.isFinite(v)) continue;
      const box = sums[(y + block) * stride + x + block] - sums[(y - block) * stride + x + block]
        - sums[(y + block) * stride + x - block] + sums[(y - block) * stride + x - block];
      const r = v - box / (period * period);
      const p = py * period + mod(x + x0, period);
      position_sums[p] += r;
      position_counts[p]++;
      sum += r;
      sum2 += r * r;
      n++;
    }
  }
  if (n < 4 * period * period) return null;
  const mean = sum / n;
  const total = sum2 - n * mean * mean;
  let between = 0;
  const means = new Float64Array(period * period);
  for (let p = 0; p < period * period; p++) {
    means[p] = position_sums[p] / (position_counts[p] || 1);
    between += position_counts[p] * (means[p] - mean) ** 2;
  }
  const score = total > 0 ? between / total : 0;
  const k = period * period;
  const f = score < 1 ? (score / (k - 1)) / ((1 - score) / Math.max(1, n - k)) : Infinity;
  return { score, f, means };
};

// Where the cells start: the offset that makes the period's means most alike within cells
const cellOffset = (means, block) => {
  const period = 2 * block;
  let best = null;
  for (let oy = 0; oy < block; oy++)
    for (let ox = 0; ox < block; ox++) {
      const sums = [0, 0, 0, 0];
      const sums2 = [0, 0, 0, 0];
      for (let py = 0; py < period; py++)
        for (let px = 0; px < period; px++) {
          const cell = 2 * Math.floor(mod(py + oy, period) / block) + Math.floor(mod(px + ox, period) / block);
          const v = means[py * period + px];
          sums[cell] += v;
          sums2[cell] += v * v;
        }
      const m = block * block;
      const within = sums2.reduce((total, s2, cell) => total + s2 - sums[cell] ** 2 / m, 0);
      if (!best || within < best.within - 1e-12) best = { within, offset: { x: ox, y: oy }, cells: sums.map(s => s / m) };
    }
  // how much of the period's variation the cells explain: a CFA's values are about the same within its cells
  const all = Array.from(means);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const total = all.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  best.fit = total > 0 ? 1 - best.within / total : 0;
  return best;
};

// A CFA's neighboring cells have other colors, along x and along y (a G next to an R or a B)
const looksLikeCfa = (cells, fit) => {
  const [a, b, c, d] = cells;
  const spread = Math.max(...cells) - Math.min(...cells);
  const across_x = Math.max(Math.abs(a - b), Math.abs(c - d));
  const across_y = Math.max(Math.abs(a - c), Math.abs(b - d));
  return fit >= 0.7 && across_x >= 0.25 * spread && across_y >= 0.25 * spread;
};

// How much the cells on each diagonal differ, period by period, relative to their values: { a: top left and bottom right, b: the others }
const diagonalDifferences = (plane, w, h, x0, y0, cfa) => {
  const { block, offset } = cfa;
  const period = 2 * block;
  // the first period that starts in the region
  const start_x = mod(-(x0 + offset.x), period);
  const start_y = mod(-(y0 + offset.y), period);
  let a = 0;
  let b = 0;
  const cell = new Float64Array(4);
  for (let py = start_y; py + period <= h; py += period)
    for (let px = start_x; px + period <= w; px += period) {
      cell.fill(0);
      for (let y = 0; y < period; y++)
        for (let x = 0; x < period; x++) cell[2 * Math.floor(y / block) + Math.floor(x / block)] += plane[(py + y) * w + px + x];
      if (!cell.every(Number.isFinite)) continue;
      // relative: the scene's gradients change all the channels alike, their gains aside
      a += Math.abs(cell[0] - cell[3]) / (Math.abs(cell[0]) + Math.abs(cell[3]) || 1);
      b += Math.abs(cell[1] - cell[2]) / (Math.abs(cell[1]) + Math.abs(cell[2]) || 1);
    }
  return { a, b };
};

// The CFA of a mosaic, from the values of a region at (x0, y0) of the image (a few 10k pixels are enough).
// For each cell size, we measure how much the position in its period explains the values (periodicity above): the
// right size, and its multiples, explain them; we take the smallest. The greens are the diagonal of cells most alike.
// Red and blue can't be told apart from a single plane: we say so, and assume red on the top row.
// Returns { mosaic, cfa, scores: [{ block, score }], cells, confidence: 'high' | 'medium' | 'low', redBlueKnown }
export const guessCfa = (plane, w, h, x0 = 0, y0 = 0, colors = null) => {
  if (colors) return cfaOfColors(colors, w, h, x0, y0);
  const sums = integralOf(plane, w, h);
  const results = [];
  for (const block of BLOCKS) {
    if (4 * block > Math.min(w, h) / 2) break;
    const result = periodicity(plane, sums, w, h, block, x0, y0);
    if (result) results.push({ block, ...result });
  }
  const scores = results.map(({ block, score }) => ({ block, score }));
  const best = results.reduce((a, b) => !a || b.score > a.score ? b : a, null);
  // significant, and large enough to matter
  if (!best || best.f < 50 || best.score < 0.005) return { mosaic: false, scores, confidence: !best || best.f < 10 ? 'high' : 'low' };
  // multiples of the cell size explain the values as well: the smallest that does
  const chosen = results.find(r => best.block % r.block === 0 && r.score >= 0.85 * best.score) ?? best;
  const { block } = chosen;
  const { offset, cells, fit } = cellOffset(chosen.means, block);
  // a repeating pattern, e.g. of the scene, that isn't a CFA's
  if (!looksLikeCfa(cells, fit)) return { mosaic: false, scores, confidence: 'low', repeating: block };
  // the greens: the diagonal whose cells are most alike in each period (both see the scene's green, a cell apart), where
  // red and blue differ with the scene's colors
  const { a: diagonal_a, b: diagonal_b } = diagonalDifferences(plane, w, h, x0, y0, { pattern: 'RGGB', block, offset });
  const greens_first = diagonal_a < diagonal_b || (diagonal_a === diagonal_b && cells[0] + cells[3] > cells[1] + cells[2]);
  // red on the top row: an assumption
  const pattern = greens_first ? 'GRBG' : 'RGGB';
  const alike = Math.min(diagonal_a, diagonal_b);
  const other = Math.max(diagonal_a, diagonal_b);
  const greens_clear = other > 0 && alike / other < 0.5;
  // the best of the sizes that aren't multiples or divisors
  const second = Math.max(0, ...results.filter(r => best.block % r.block !== 0 && r.block % block !== 0).map(r => r.score));
  const confidence = chosen.score >= 0.05 && chosen.score >= 2 * second && greens_clear ? 'high'
    : chosen.score >= 1.3 * second && (other === 0 || alike / other < 0.8) ? 'medium' : 'low';
  return {
    mosaic: true,
    cfa: normalizeCfa({ pattern, block, offset }),
    scores,
    // how each cell differs from the local mean, in the order of the pattern
    cells,
    greens: { alike, other },
    redBlueKnown: false,
    confidence,
  };
};

// The guess, checked on the 4 quarters of the region: when they don't agree with it, we're not sure
export const guessCfaChecked = (plane, w, h, x0 = 0, y0 = 0, colors = null) => {
  const guess = guessCfa(plane, w, h, x0, y0, colors);
  if (colors || !guess.mosaic || w < 128 || h < 128) return guess;
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);
  const same = cfa => cfa.block === guess.cfa.block && cfa.offset.x === guess.cfa.offset.x && cfa.offset.y === guess.cfa.offset.y
    && [...cfa.pattern].map(c => c === 'G').join() === [...guess.cfa.pattern].map(c => c === 'G').join();
  let agree = 0;
  for (const [qx, qy] of [[0, 0], [hw, 0], [0, hh], [hw, hh]]) {
    const quarter = new Float64Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) quarter[y * hw + x] = plane[(y + qy) * w + x + qx];
    const q = guessCfa(quarter, hw, hh, x0 + qx, y0 + qy);
    if (q.mosaic && same(q.cfa)) agree++;
  }
  const confidence = agree >= 3 ? guess.confidence : agree === 2 && guess.confidence === 'high' ? 'medium' : 'low';
  return { ...guess, confidence, quarters: agree };
};

// The CFA of an image whose pixels each have one color: exact, red and blue included
const cfaOfColors = (colors, w, h, x0, y0) => {
  let best = null;
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 20000)));
  for (const block of BLOCKS) {
    if (2 * block > Math.min(w, h)) break;
    for (let oy = 0; oy < block; oy++)
      for (let ox = 0; ox < block; ox++) {
        const cfa = { pattern: 'RGGB', block, offset: { x: ox, y: oy } };
        // the color of each cell: the most common
        const votes = [0, 1, 2, 3].map(() => [0, 0, 0]);
        let total = 0;
        for (let y = 0; y < h; y += step)
          for (let x = 0; x < w; x += step) {
            const color = colors[y * w + x];
            if (color > 2) continue;
            votes[cellAt(cfa, x, y)][color]++;
            total++;
          }
        if (!total) return { mosaic: false, scores: [], confidence: 'low' };
        const cell_colors = votes.map(v => v.indexOf(Math.max(...v)));
        const agree = votes.reduce((sum, v, cell) => sum + v[cell_colors[cell]], 0) / total;
        if (!best || agree > best.agree + 1e-9) best = { agree, block, offset: { x: ox, y: oy }, pattern: cell_colors.map(c => 'RGB'[c]).join('') };
      }
    if (best?.agree >= 0.995) break;
  }
  if (!best || !CFA_PATTERNS.includes(best.pattern) || best.agree < 0.9) return { mosaic: false, scores: [], confidence: 'low' };
  const period = 2 * best.block;
  return {
    mosaic: true,
    cfa: normalizeCfa({ pattern: best.pattern, block: best.block, offset: { x: mod(best.offset.x - x0, period), y: mod(best.offset.y - y0, period) } }),
    scores: [],
    exact: true,
    agreement: best.agree,
    redBlueKnown: true,
    confidence: best.agree >= 0.99 ? 'high' : 'medium',
  };
};

// Whether the pixels of a cell have different levels, e.g. long and short exposures (Quad HDR, staggered...). Per
// sub-pixel, its mean relative to its cell's, averaged over the 4 cells. Returns null without a difference, else
// { levels: [n*n], bright: [sub-pixels in the brighter group], ratio }.
export const subPixelLevels = (plane, w, h, cfa, x0 = 0, y0 = 0, black = 0) => {
  const { block } = cfa;
  if (block < 2) return null;
  const n = block * block;
  const sums = new Float64Array(4 * n);
  const counts = new Float64Array(4 * n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = plane[y * w + x];
      if (!Number.isFinite(v)) continue;
      const X = x + x0 + cfa.offset.x;
      const Y = y + y0 + cfa.offset.y;
      const cell = cellAt(cfa, x + x0, y + y0);
      const s = mod(Y, block) * block + mod(X, block);
      sums[cell * n + s] += v - black;
      counts[cell * n + s]++;
    }
  const levels = new Float64Array(n);
  const spread = new Float64Array(n);
  for (let cell = 0; cell < 4; cell++) {
    let total = 0;
    for (let s = 0; s < n; s++) total += sums[cell * n + s] / (counts[cell * n + s] || 1);
    const mean = total / n;
    for (let s = 0; s < n; s++) {
      const level = mean > 0 ? sums[cell * n + s] / (counts[cell * n + s] || 1) / mean : 1;
      levels[s] += level / 4;
      spread[s] += level * level / 4;
    }
  }
  const sorted = [...levels].map((level, s) => ({ level, s })).sort((a, b) => a.level - b.level);
  // the largest step between sorted levels splits them in two groups
  let split = 0;
  let step = 1;
  for (let i = 1; i < n; i++) {
    const ratio = sorted[i].level / Math.max(1e-9, sorted[i - 1].level);
    if (ratio > step) {
      step = ratio;
      split = i;
    }
  }
  const low = sorted.slice(0, split);
  const high = sorted.slice(split);
  const mean = group => group.reduce((sum, g) => sum + g.level, 0) / group.length;
  const ratio = split ? mean(high) / Math.max(1e-9, mean(low)) : 1;
  // consistent over the cells: the spread of a sub-pixel's level is small next to the difference
  const consistent = [...levels].every((level, s) => Math.sqrt(Math.max(0, spread[s] - level * level)) < 0.25 * Math.abs(ratio - 1) * level);
  if (ratio < 1.25 || !consistent) return { levels: Array.from(levels), bright: [], ratio: 1 };
  return { levels: Array.from(levels), bright: high.map(g => g.s).sort((a, b) => a - b), ratio };
};


// --- Statistics and profiles by channel ---

// The bit depth of values: from their type when it says it (e.g. 'UI10', 'RGB;10'), else the smallest that holds the
// largest value: 16-bit containers (e.g. 'I;16') often hold 10 or 12-bit values
export const bitDepthOf = (max, mode) => {
  const explicit = /^U(?:I|INT)?(\d+)$/i.exec(mode ?? '') ?? /^[A-Z]+;(\d+)$/i.exec(mode ?? '');
  if (explicit && ![8, 16, 32].includes(Number(explicit[1])) || /^U(?:I|INT)?\d+$/i.test(mode ?? '')) return { bits: Number(explicit[1]), source: 'mode' };
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isInteger(max) || max > 65535) return null;
  for (const bits of [8, 10, 12, 14, 16]) if (max < 2 ** bits) return { bits, source: 'values' };
  return null;
};

// Accumulates the values of pixels by channel: all of them (for percentiles), and their profiles along x and y,
// binned by `bin` pixels (the CFA's period: every channel has values in each bin)
export class ChannelValues {
  constructor(count, region, bin = 1) {
    this.count = count;
    this.region = region;
    this.bin = bin;
    this.values = Array.from({ length: count }, () => ({ data: new Float64Array(4096), n: 0 }));
    this.columns = profileAccumulator(Math.ceil(region.w / bin), count);
    this.rows = profileAccumulator(Math.ceil(region.h / bin), count);
  }

  // A chunk of a plane at (x, y), with a function giving the channel of a pixel (-1: none). `use`: what it counts for
  add(plane, x0, y0, w, h, channelAt, use = { stats: true, columns: true, rows: true }) {
    const { region, bin } = this;
    for (let y = 0; y < h; y++) {
      const Y = y0 + y;
      const row_bin = Math.floor((Y - region.y) / bin);
      for (let x = 0; x < w; x++) {
        const v = plane[y * w + x];
        if (v === null || v === undefined || Number.isNaN(v)) continue;
        const X = x0 + x;
        const c = channelAt(X, Y);
        if (c < 0) continue;
        if (use.stats) push(this.values[c], v);
        if (use.columns) addTo(this.columns, Math.floor((X - region.x) / bin), c, v);
        if (use.rows) addTo(this.rows, row_bin, c, v);
      }
    }
  }

  // { stats: [per channel], columns, rows: profiles (see analysis.js alongImage) }
  finish({ black = null, white = null } = {}) {
    const stats = this.values.map(({ data, n }) => channelStats(data.subarray(0, n), black, white));
    const { region, bin } = this;
    return {
      stats,
      columns: finishProfile(this.columns, k => region.x + (k + 0.5) * bin),
      rows: finishProfile(this.rows, k => region.y + (k + 0.5) * bin),
      sorted: this.values.map(({ data, n }) => data.subarray(0, n)),
    };
  }
}

const push = (store, v) => {
  if (store.n === store.data.length) {
    const grown = new Float64Array(store.data.length * 2);
    grown.set(store.data);
    store.data = grown;
  }
  store.data[store.n++] = v;
};

const profileAccumulator = (n, stride) => ({
  n,
  stride,
  count: new Float64Array(n * stride),
  sum: new Float64Array(n * stride),
  sum2: new Float64Array(n * stride),
  min: new Float64Array(n * stride).fill(Infinity),
  max: new Float64Array(n * stride).fill(-Infinity),
});

const addTo = (acc, k, c, v) => {
  if (k < 0 || k >= acc.n) return;
  const i = k * acc.stride + c;
  acc.count[i]++;
  acc.sum[i] += v;
  acc.sum2[i] += v * v;
  if (v < acc.min[i]) acc.min[i] = v;
  if (v > acc.max[i]) acc.max[i] = v;
};

// The profile's positions with values for all the channels
const finishProfile = (acc, position) => {
  const { stride } = acc;
  const keep = [];
  for (let k = 0; k < acc.n; k++) {
    let all = true;
    for (let c = 0; c < stride; c++) if (!acc.count[k * stride + c]) all = false;
    if (all) keep.push(k);
  }
  const m = keep.length;
  const out = { length: m, stride, x: new Float64Array(m), mean: new Float64Array(m * stride), std: new Float64Array(m * stride), min: new Float64Array(m * stride), max: new Float64Array(m * stride) };
  keep.forEach((k, j) => {
    out.x[j] = position(k);
    for (let c = 0; c < stride; c++) {
      const i = k * stride + c;
      const mean = acc.sum[i] / acc.count[i];
      out.mean[j * stride + c] = mean;
      out.std[j * stride + c] = Math.sqrt(Math.max(0, acc.sum2[i] / acc.count[i] - mean * mean));
      out.min[j * stride + c] = acc.min[i];
      out.max[j * stride + c] = acc.max[i];
    }
  });
  return out;
};

// The statistics of the values of a channel (sorted in place)
export const channelStats = (values, black = null, white = null) => {
  const n = values.length;
  if (!n) return null;
  values.sort();
  let sum = 0;
  let sum2 = 0;
  let low = 0;
  let high = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sum2 += v * v;
    if (black !== null && v <= black) low++;
    if (white !== null && v >= white) high++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const at = p => values[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  const signal = mean - (black ?? 0);
  return {
    count: n,
    mean,
    signal,
    std,
    snr: std > 0 && signal > 0 ? 20 * Math.log10(signal / std) : signal > 0 ? Infinity : null,
    min: values[0],
    p1: at(0.01),
    median: at(0.5),
    p99: at(0.99),
    max: values[n - 1],
    low: black !== null ? low / n : null,
    high: white !== null ? high / n : null,
  };
};

// Histograms of sorted values, `bins` bins over [lo, hi]
export const histogramOfSorted = (sorted, lo, hi, bins = 256) => {
  const counts = new Float64Array(bins);
  const width = (hi - lo) / bins || 1;
  for (let i = 0; i < sorted.length; i++) {
    const k = Math.floor((sorted[i] - lo) / width);
    counts[Math.min(bins - 1, Math.max(0, k))]++;
  }
  return counts;
};

// Ratios between channels, without the black level: white balance (R/G, B/G) and the greens' imbalance (Gr/Gb)
export const channelRatios = (channels, stats) => {
  const signal = name => {
    const i = channels.findIndex(c => c.key === name);
    return i >= 0 ? stats[i]?.signal : undefined;
  };
  const g = signal('G') ?? ((signal('Gr') ?? NaN) + (signal('Gb') ?? NaN)) / 2;
  const out = [];
  if (Number.isFinite(signal('R') / g) && g > 0) out.push({ key: 'R/G', value: signal('R') / g, title: 'Red over green, without the black level: the white balance gain of red is its inverse' });
  if (Number.isFinite(signal('B') / g) && g > 0) out.push({ key: 'B/G', value: signal('B') / g, title: 'Blue over green, without the black level: the white balance gain of blue is its inverse' });
  if (signal('Gr') > 0 && signal('Gb') > 0) out.push({ key: 'Gr/Gb', value: signal('Gr') / signal('Gb'), title: 'Green imbalance: the greens of the red and blue rows differ (crosstalk, a lens…). 1 is none' });
  return out;
};
