// Generated audio for the playground and tests: a "new" track, and a reference that differs from it in known ways
import { encodeWav } from './wav';

// deterministic white noise in [-1, 1): murmur3's finalizer, without the periods of simpler hashes (they'd be tones)
const noise = i => {
  let x = Math.imul(i ^ (i >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 2147483648 - 1;
};

// A chirp from 110 Hz up 6 octaves and back, with a beat of short tones every second, then a little noise.
// - pitch: multiplies the frequencies
// - noise, clip: what the reference adds: a noise floor (linear amplitude), and gain into clipping
export function synthesize({ seconds = 10, rate = 48000, channels = 2, pitch = 1, noise: noise_level = 0, clip = 1 } = {}) {
  const length = Math.round(seconds * rate);
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const u = (t / seconds) * 2;
    const octaves = 6 * (u < 1 ? u : 2 - u);
    phase += 2 * Math.PI * 110 * pitch * 2 ** octaves / rate;
    const beat_t = t % 1;
    const beat = beat_t < 0.08 ? Math.sin(2 * Math.PI * 880 * pitch * t) * (1 - beat_t / 0.08) : 0;
    const base = 0.45 * Math.sin(phase) + 0.3 * beat;
    for (let c = 0; c < channels; c++) {
      // the channels pan slowly
      const pan = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / 4 + c * Math.PI);
      const v = base * (0.6 + 0.4 * pan) * clip + noise_level * noise(i * channels + c);
      out[c][i] = Math.max(-1, Math.min(1, v));
    }
  }
  return out;
}

// { new, reference } WAV files, as ArrayBuffers
export function generatePair({ seconds = 10, rate = 48000, channels = 2 } = {}) {
  return {
    new: encodeWav(synthesize({ seconds, rate, channels }), rate),
    // a little noise, too much gain, and a quarter tone up
    reference: encodeWav(synthesize({ seconds, rate, channels, noise: 0.01, clip: 1.6, pitch: 2 ** (0.5 / 12) }), rate),
  };
}
