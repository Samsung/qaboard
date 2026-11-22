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

// Short-time Fourier transform of the mix of the channels, in dBFS (a full-scale sine is 0 dB), with a Hann window.
// Long files get a larger hop: at most max_frames frames, about a column per pixel.
// data[frame * bins + bin], frame f is centered on sample f * hop + size / 2.
// Long files: only the samples of the frames are read, it doesn't mix the channels first.
export function stft(channels, { size = 2048, hop, max_frames = 2000 } = {}) {
  const length = channels[0].length;
  hop = hop ?? Math.max(size / 4, Math.ceil((length - size) / max_frames));
  const frames = Math.max(1, Math.floor((length - size) / hop) + 1);
  const bins = size / 2 + 1;
  const window = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
    sum += window[i];
  }
  // the mean of the channels, and a full-scale sine at 0 dB
  const scale = (2 / sum / channels.length) ** 2;
  const data = new Float32Array(frames * bins);
  const re = new Float64Array(size), im = new Float64Array(size);
  let max = -Infinity;
  for (let f = 0; f < frames; f++) {
    const offset = f * hop;
    re.fill(0);
    im.fill(0);
    for (const samples of channels) {
      const end = Math.min(size, length - offset);
      for (let i = 0; i < end; i++) re[i] += samples[offset + i] * window[i];
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      // 10 log10(power): no square root
      const db = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * scale + 1e-24);
      data[f * bins + k] = db;
      if (db > max) max = db;
    }
  }
  return { size, hop, frames, bins, data, max };
}

// Frequency (Hz) of a row of a log-frequency spectrogram `rows` high, top row is Nyquist
export const rowFrequency = (row, rows, nyquist, min_frequency = 20) =>
  min_frequency * (nyquist / min_frequency) ** (1 - row / Math.max(1, rows - 1));
export const frequencyRow = (frequency, rows, nyquist, min_frequency = 20) =>
  (1 - Math.log(frequency / min_frequency) / Math.log(nyquist / min_frequency)) * (rows - 1);
