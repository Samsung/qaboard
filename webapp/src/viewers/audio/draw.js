// Drawing tracks on canvases: waveforms and spectrograms of the time range [start, end] (seconds) that's shown,
// the same for the compared tracks
import { CLIP, frequencyRow, peaks, rowFrequency, stft } from './dsp';
import { diverging, magma } from './colormap';
import { formatFrequency } from './format';

// canvas => its 2d context, sized for the screen's pixels. null in jsdom.
const prepare = (canvas, width, height) => {
  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
  return context;
};

// The min and max of each column of what's shown: from the summary, or from the samples when zoomed in enough
// that the summary's bins are coarser than the columns
export function columnPeaks(track, { start, end, columns }) {
  const s0 = start * track.sample_rate, s1 = end * track.sample_rate;
  const per_column = (s1 - s0) / columns;
  if (per_column >= track.summary.bin * 2) return peaks(track.summary, { start: s0, end: s1, width: columns });
  const min = new Float32Array(columns), max = new Float32Array(columns);
  for (let x = 0; x < columns; x++) {
    const i0 = Math.max(0, Math.floor(s0 + x * per_column)), i1 = Math.min(track.length, Math.max(i0 + 1, Math.ceil(s0 + (x + 1) * per_column)));
    let lo = Infinity, hi = -Infinity;
    for (const samples of track.channels)
      for (let i = i0; i < i1; i++) {
        if (samples[i] < lo) lo = samples[i];
        if (samples[i] > hi) hi = samples[i];
      }
    min[x] = lo === Infinity ? 0 : lo;
    max[x] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

// the columns [x0, x1) where the track has samples
const extent = (track, { start, end }, w) => [
  Math.max(0, Math.floor(-start / (end - start) * w)),
  Math.min(w, Math.ceil((track.duration - start) / (end - start) * w)),
];

// Columns that reach full scale are drawn in red: clipping is what reviewers look for first.
// Zoomed in to less than a sample per pixel, the samples are joined by a line.
export function drawWaveform(canvas, track, { width, height, start, end, color, clip_color = '#e5484d', axis_color }) {
  const context = prepare(canvas, width, height);
  if (!context) return;
  const { width: w, height: h } = canvas;
  const y = v => (1 - Math.max(-1, Math.min(1, v))) / 2 * (h - 1);
  if (axis_color) {
    context.fillStyle = axis_color;
    context.fillRect(0, Math.floor(h / 2), w, 1);
  }
  const samples_per_column = (end - start) * track.sample_rate / w;
  if (samples_per_column < 1) {
    const ratio = globalThis.devicePixelRatio || 1;
    const i0 = Math.max(0, Math.floor(start * track.sample_rate)), i1 = Math.min(track.length - 1, Math.ceil(end * track.sample_rate));
    const x = i => (i / track.sample_rate - start) / (end - start) * w;
    context.strokeStyle = color;
    context.lineWidth = ratio;
    for (const samples of track.channels) {
      context.beginPath();
      for (let i = i0; i <= i1; i++) context[i === i0 ? 'moveTo' : 'lineTo'](x(i), y(samples[i]));
      context.stroke();
    }
    if (samples_per_column < 0.2) {
      context.fillStyle = color;
      for (const samples of track.channels)
        for (let i = i0; i <= i1; i++) context.fillRect(x(i) - 1.5 * ratio, y(samples[i]) - 1.5 * ratio, 3 * ratio, 3 * ratio);
    }
    return;
  }
  const { min, max } = columnPeaks(track, { start, end, columns: w });
  const [x0, x1] = extent(track, { start, end }, w);
  for (let x = x0; x < x1; x++) {
    const top = Math.round(y(max[x])), bottom = Math.round(y(min[x]));
    context.fillStyle = max[x] >= CLIP || min[x] <= -CLIP ? clip_color : color;
    context.fillRect(x, top, 1, Math.max(1, bottom - top + 1));
  }
}

// Compact rows: the new track's envelope above the axis, the reference's below, mirrored. alpha: fainter, not heard
export function drawSplitWaveform(canvas, sides, { width, height, start, end, axis_color }) {
  const context = prepare(canvas, width, height);
  if (!context) return;
  const { width: w, height: h } = canvas;
  const half = sides.length > 1 ? h / 2 : h;
  sides.forEach(({ track, color, alpha = 1 }, i) => {
    const { min, max } = columnPeaks(track, { start, end, columns: w });
    const [x0, x1] = extent(track, { start, end }, w);
    context.fillStyle = color;
    context.globalAlpha = alpha;
    for (let x = x0; x < x1; x++) {
      const v = Math.min(1, Math.max(Math.abs(min[x]), Math.abs(max[x])));
      const size = Math.max(1, Math.round(v * (half - 1)));
      if (sides.length === 1) context.fillRect(x, Math.round((h - size) / 2), 1, size);
      else context.fillRect(x, i === 0 ? Math.round(half - size) : Math.round(half), 1, size);
    }
  });
  context.globalAlpha = 1;
  if (axis_color && sides.length > 1) {
    context.fillStyle = axis_color;
    context.fillRect(0, Math.round(half), w, 1);
  }
}

// The spectrogram of what's shown, a frame per column. The last one of each track is kept: redraws (the playhead,
// the theme) don't compute it again, zooming does.
const spectrograms = new WeakMap();
export const spectrogramOf = (track, { start, end, columns }) => {
  const key = `${start}:${end}:${columns}`;
  const cached = spectrograms.get(track);
  if (cached?.key === key) return cached.spectrogram;
  const size = track.sample_rate > 64000 ? 4096 : 2048;
  const spectrogram = stft(track.channels, { size, start: start * track.sample_rate, end: end * track.sample_rate, frames: columns });
  spectrograms.set(track, { key, spectrogram });
  return spectrogram;
};

// The color scale of spectrograms, in dB: the same for the compared tracks, from their peaks, so it doesn't change
// when zooming
export const SPECTROGRAM_RANGE = 90;
export const DIFFERENCE_RANGE = 24;
// differences fade out over the 60 dB below the top of the scale
const DIFFERENCE_AUDIBLE = 60;
const DIFFERENCE_BACKGROUND = [17, 20, 24];
export const spectrogramTop = peak_db => Math.min(0, Math.max(-60, Math.ceil(peak_db / 10) * 10));

// Log frequencies from 20 Hz to Nyquist. With `reference`, new - reference in dB, on a diverging colormap.
export function drawSpectrogram(canvas, track, { width, height, start, end, top_db = 0, reference }) {
  const context = prepare(canvas, width, height);
  if (!context) return;
  const { width: w, height: h } = canvas;
  const nyquist = track.sample_rate / 2;
  const range = { start, end, columns: w };
  const spectrogram = spectrogramOf(track, range);
  const other = reference && spectrogramOf(reference, range);
  const image = context.createImageData(w, h);
  // for each row, the bin it shows: between bins at low frequencies, where rows are finer than bins
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) rows[y] = Math.min(spectrogram.bins - 1, rowFrequency(y, h, nyquist) / nyquist * (spectrogram.bins - 1));
  const at = (data, offset, k) => {
    const k0 = Math.floor(k), k1 = Math.min(spectrogram.bins - 1, k0 + 1);
    return data[offset + k0] + (data[offset + k1] - data[offset + k0]) * (k - k0);
  };
  const [x0, x1] = other ? [0, w] : extent(track, range, w);
  for (let x = x0; x < x1; x++) {
    const offset = x * spectrogram.bins;
    for (let y = 0; y < h; y++) {
      const p = (y * w + x) * 4;
      if (other) {
        // the color says which is louder and by how much, its strength how loud it is: differences in what's barely
        // audible (a noise floor, reverb tails) stay dim, those in what's heard stand out
        const floor = top_db - SPECTROGRAM_RANGE;
        const a = Math.max(floor, at(spectrogram.data, offset, rows[y])), b = Math.max(floor, at(other.data, offset, rows[y]));
        const level = Math.max(0, Math.min(255, Math.round(((a - b) / DIFFERENCE_RANGE + 1) / 2 * 255)));
        const weight = Math.max(0.12, Math.min(1, (Math.max(a, b) - top_db + DIFFERENCE_AUDIBLE) / DIFFERENCE_AUDIBLE));
        for (let c = 0; c < 3; c++) image.data[p + c] = DIFFERENCE_BACKGROUND[c] + (diverging[level * 3 + c] - DIFFERENCE_BACKGROUND[c]) * weight;
      } else {
        const level = Math.max(0, Math.min(255, Math.round((at(spectrogram.data, offset, rows[y]) - top_db + SPECTROGRAM_RANGE) / SPECTROGRAM_RANGE * 255)));
        for (let c = 0; c < 3; c++) image.data[p + c] = magma[level * 3 + c];
      }
      image.data[p + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  drawFrequencyAxis(context, { h, nyquist });
}

// Ticks on the left, labeled where there's room
const FREQUENCIES = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000];
function drawFrequencyAxis(context, { h, nyquist }) {
  const ratio = globalThis.devicePixelRatio || 1;
  context.font = `${10 * ratio}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  context.textBaseline = 'middle';
  let last = -Infinity;
  for (const hz of FREQUENCIES) {
    if (hz >= nyquist * 0.95) continue;
    const y = Math.round(frequencyRow(hz, h, nyquist));
    context.fillStyle = 'rgba(255, 255, 255, 0.35)';
    context.fillRect(0, y, 4 * ratio, ratio);
    if (Math.abs(y - last) < 16 * ratio || y < 7 * ratio || y > h - 7 * ratio) continue;
    last = y;
    const label = `${formatFrequency(hz)}Hz`;
    const text_width = context.measureText(label).width;
    context.fillStyle = 'rgba(17, 20, 24, 0.55)';
    context.fillRect(5 * ratio, y - 6 * ratio, text_width + 4 * ratio, 12 * ratio);
    context.fillStyle = 'rgba(255, 255, 255, 0.85)';
    context.fillText(label, 7 * ratio, y);
  }
}
