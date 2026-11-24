// What the audio viewer computes from samples: waveform peaks, levels, spectrograms. Plain functions on Float32Arrays,
// without the Web Audio API, so that they run in tests.

// Waveforms of long files: we summarize the samples once, as the min and max of bins of `bin` samples over all
// channels, then each redraw only aggregates bins into pixel columns. 64k bins is ~1 per pixel on a 4K screen, with zoom.
export const SUMMARY_BINS = 65536;
export function summarize(channels, bin) {
  const length = channels[0]?.length ?? 0;
  bin = bin ?? Math.max(1, Math.floor(length / SUMMARY_BINS));
  const count = Math.ceil(length / bin);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let lo = Infinity, hi = -Infinity;
    const end = Math.min(length, (b + 1) * bin);
    for (const samples of channels) {
      for (let i = b * bin; i < end; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { bin, length, min, max };
}

// The min and max of each of `width` columns, for samples [start, end)
export function peaks(summary, { start = 0, end = summary.length, width }) {
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  const per_column = (end - start) / width;
  const bins = summary.min.length;
  for (let x = 0; x < width; x++) {
    const b0 = Math.floor((start + x * per_column) / summary.bin);
    const b1 = Math.max(b0 + 1, Math.ceil((start + (x + 1) * per_column) / summary.bin));
    let lo = Infinity, hi = -Infinity;
    for (let b = Math.max(0, b0); b < Math.min(bins, b1); b++) {
      if (summary.min[b] < lo) lo = summary.min[b];
      if (summary.max[b] > hi) hi = summary.max[b];
    }
    // past the end of the file
    min[x] = lo === Infinity ? 0 : lo;
    max[x] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

// Samples at or above this are clipped: what a 16-bit file saturates at, 32767/32768
export const CLIP = 0.99995;

// Peak and RMS over all channels, linear, and the number of clipped samples
export function levels(channels) {
  let peak = 0, sum = 0, n = 0, clipped = 0;
  for (const samples of channels) {
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
      if (v >= CLIP) clipped++;
      sum += v * v;
    }
    n += samples.length;
  }
  return { peak, rms: n ? Math.sqrt(sum / n) : 0, clipped };
}

export const dbfs = value => value > 0 ? 20 * Math.log10(value) : -Infinity;

export function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const samples of channels)
    for (let i = 0; i < out.length; i++) out[i] += samples[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}

// new - reference, sample by sample (same sample rate), over the longest: what's left of a null test.
// With a different channel count, the mixdowns.
export function difference(channels, channels_ref) {
  const [a, b] = channels.length === channels_ref.length ? [channels, channels_ref] : [[mixdown(channels)], [mixdown(channels_ref)]];
  return a.map((samples, c) => {
    const other = b[c];
    const out = new Float32Array(Math.max(samples.length, other.length));
    for (let i = 0; i < out.length; i++) out[i] = (samples[i] ?? 0) - (other[i] ?? 0);
    return out;
  });
}

// In-place iterative radix-2 FFT. re and im have a power of 2 length.
const tables = new Map();
const tableOf = n => {
  let table = tables.get(n);
  if (!table) {
    table = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2), reversed: new Uint32Array(n) };
    for (let k = 0; k < n / 2; k++) {
      table.cos[k] = Math.cos(-2 * Math.PI * k / n);
      table.sin[k] = Math.sin(-2 * Math.PI * k / n);
    }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      table.reversed[i] = j;
    }
    tables.set(n, table);
  }
  return table;
};
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, reversed } = tableOf(n);
  for (let i = 1; i < n; i++) {
    const j = reversed[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Short-time Fourier transform of the mean of the channels, in dBFS (a full-scale sine is 0 dB), with a Hann window.
// `frames` frames centered at regular intervals over samples [start, end): one per pixel column of what's shown, so
// zooming in computes finer frames. Only the samples of the frames are read: long files cost what's drawn.
// data[frame * bins + bin]
export function stft(channels, { size = 2048, start = 0, end = channels[0].length, frames } = {}) {
  const length = channels[0].length;
  frames = Math.max(1, frames ?? Math.min(2000, Math.ceil((end - start) / (size / 4))));
  const hop = (end - start) / frames;
  const bins = size / 2 + 1;
  const window = windowOf(size);
  // the mean of the channels, and a full-scale sine at 0 dB
  const scale = (2 / window.sum / channels.length) ** 2;
  const data = new Float32Array(frames * bins);
  const re = new Float64Array(size), im = new Float64Array(size);
  let max = -Infinity;
  for (let f = 0; f < frames; f++) {
    const offset = Math.round(start + (f + 0.5) * hop - size / 2);
    re.fill(0);
    im.fill(0);
    const i0 = Math.max(0, -offset), i1 = Math.min(size, length - offset);
    for (const samples of channels)
      for (let i = i0; i < i1; i++) re[i] += samples[offset + i] * window.values[i];
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      // 10 log10(power): no square root
      const db = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * scale + 1e-24);
      data[f * bins + k] = db;
      if (db > max) max = db;
    }
  }
  return { size, start, end, hop, frames, bins, data, max };
}

const windows = new Map();
const windowOf = size => {
  if (!windows.has(size)) {
    const values = new Float32Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      values[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
      sum += values[i];
    }
    windows.set(size, { values, sum });
  }
  return windows.get(size);
};

// Loudness in LUFS, as ITU-R BS.1770 measures it: K-weighting, 400 ms blocks overlapping by 75%, an absolute gate at
// -70 LUFS and a relative gate 10 LU below. All channels weigh 1 (no surround weights). What "match loudness" equalizes:
// RMS overrates bass and silence, so the louder-sounding track would still win A/B.
export function loudness(channels, sample_rate) {
  const length = channels[0]?.length ?? 0;
  if (!length) return -Infinity;
  const [shelf, highpass] = kWeighting(sample_rate);
  // mean squares of 100 ms steps, summed over channels
  const step = Math.min(length, Math.round(0.1 * sample_rate));
  const steps = Math.floor(length / step);
  const power = new Float64Array(steps);
  const filtered = new Float32Array(length);
  for (const samples of channels) {
    biquad(samples, shelf, filtered);
    biquad(filtered, highpass, filtered);
    for (let s = 0; s < steps; s++) {
      let sum = 0;
      for (let i = s * step; i < (s + 1) * step; i++) sum += filtered[i] * filtered[i];
      power[s] += sum / step;
    }
  }
  // 400 ms blocks are 4 steps
  const blocks = [];
  for (let b = 0; b <= Math.max(0, steps - 4); b++) {
    const n = Math.min(4, steps - b);
    let z = 0;
    for (let s = b; s < b + n; s++) z += power[s];
    blocks.push(z / n);
  }
  const lufs = z => -0.691 + 10 * Math.log10(z);
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const loud = blocks.filter(z => lufs(z) > -70);
  if (!loud.length) return -Infinity;
  const relative = lufs(mean(loud)) - 10;
  const gated = loud.filter(z => lufs(z) > relative);
  return lufs(mean(gated));
}

// The two biquads of the K-weighting at any sample rate, as libebur128 computes them (the standard's coefficients at
// 48 kHz): a high shelf for the head, then a high pass
const kWeighting = rate => {
  let K = Math.tan(Math.PI * 1681.974450955533 / rate), Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  K = Math.tan(Math.PI * 38.13547087602444 / rate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highpass = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, highpass];
};

// [b0, b1, b2, a1, a2], normalized. output can be input.
function biquad(input, [b0, b1, b2, a1, a2], output) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    output[i] = y;
  }
}

// The gains (dB) that bring tracks to the loudness of the quietest: never up, so nothing clips
export function matchingGains(loudnesses) {
  const finite = loudnesses.filter(Number.isFinite);
  if (finite.length < 2) return loudnesses.map(() => 0);
  const target = Math.min(...finite);
  return loudnesses.map(l => Number.isFinite(l) ? target - l : 0);
}

// Frequency (Hz) of a row of a log-frequency spectrogram `rows` high, top row is Nyquist
export const rowFrequency = (row, rows, nyquist, min_frequency = 20) =>
  min_frequency * (nyquist / min_frequency) ** (1 - row / Math.max(1, rows - 1));
export const frequencyRow = (frequency, rows, nyquist, min_frequency = 20) =>
  (1 - Math.log(frequency / min_frequency) / Math.log(nyquist / min_frequency)) * (rows - 1);
