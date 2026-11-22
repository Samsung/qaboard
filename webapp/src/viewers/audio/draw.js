// Drawing tracks on canvases: waveforms and spectrograms, on a time axis of `duration` seconds shared by the tracks
import { CLIP, frequencyRow, peaks, rowFrequency, stft } from './dsp';
import { magma } from './colormap';
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

// Columns that reach full scale are drawn in red: clipping is what reviewers look for first
export function drawWaveform(canvas, track, { width, height, duration, color, clip_color = '#cd4246', axis_color }) {
  const context = prepare(canvas, width, height);
  if (!context) return;
  const { width: w, height: h } = canvas;
  const columns = Math.min(w, Math.round(w * track.duration / duration));
  const { min, max } = peaks(track.summary, { width: columns });
  if (axis_color) {
    context.fillStyle = axis_color;
    context.fillRect(0, Math.floor(h / 2), w, 1);
  }
  for (let x = 0; x < columns; x++) {
    const top = Math.round((1 - Math.min(1, max[x])) / 2 * (h - 1));
    const bottom = Math.round((1 - Math.max(-1, min[x])) / 2 * (h - 1));
    context.fillStyle = max[x] >= CLIP || min[x] <= -CLIP ? clip_color : color;
    context.fillRect(x, top, 1, Math.max(1, bottom - top + 1));
  }
}

// Spectrograms, cached per track: they take ~100ms for minutes of audio
const spectrograms = new WeakMap();
export const spectrogramOf = track => {
  if (!spectrograms.has(track)) {
    const size = track.sample_rate > 64000 ? 4096 : 2048;
    spectrograms.set(track, stft(track.channels, { size }));
  }
  return spectrograms.get(track);
};

// Log frequencies from 20 Hz to Nyquist, colors over the `range` dB below `max_db` (the same for compared tracks)
export function drawSpectrogram(canvas, track, { width, height, duration, max_db, range = 90, text_color = 'rgba(255, 255, 255, 0.8)' }) {
  const context = prepare(canvas, width, height);
  if (!context) return;
  const spectrogram = spectrogramOf(track);
  const { width: w, height: h } = canvas;
  const nyquist = track.sample_rate / 2;
  const top = max_db ?? spectrogram.max;
  const image = context.createImageData(w, h);
  // for each row, the bin it shows
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) rows[y] = Math.min(spectrogram.bins - 1, rowFrequency(y, h, nyquist) / nyquist * (spectrogram.bins - 1));
  for (let x = 0; x < w; x++) {
    const t = (x + 0.5) / w * duration;
    if (t > track.duration) break;
    const frame = Math.max(0, Math.min(spectrogram.frames - 1, Math.round((t * track.sample_rate - spectrogram.size / 2) / spectrogram.hop)));
    const offset = frame * spectrogram.bins;
    for (let y = 0; y < h; y++) {
      // between bins at low frequencies, where rows are finer than bins
      const k = rows[y], k0 = Math.floor(k), k1 = Math.min(spectrogram.bins - 1, k0 + 1);
      const db = spectrogram.data[offset + k0] + (spectrogram.data[offset + k1] - spectrogram.data[offset + k0]) * (k - k0);
      const level = Math.max(0, Math.min(255, Math.round((db - top + range) / range * 255)));
      const p = (y * w + x) * 4;
      image.data[p] = magma[level * 3];
      image.data[p + 1] = magma[level * 3 + 1];
      image.data[p + 2] = magma[level * 3 + 2];
      image.data[p + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  // a few frequencies, for reference
  const ratio = globalThis.devicePixelRatio || 1;
  context.font = `${10 * ratio}px sans-serif`;
  context.fillStyle = text_color;
  context.textBaseline = 'middle';
  for (const hz of [100, 1000, 10000, 40000]) {
    if (hz >= nyquist * 0.9) continue;
    const y = frequencyRow(hz, h, nyquist);
    context.fillText(`${formatFrequency(hz)}Hz`, 4 * ratio, y);
  }
}
