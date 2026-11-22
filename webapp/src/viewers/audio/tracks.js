// Audio files => tracks: decoded samples, with what the viewer shows of them computed once (waveform summary, levels)
import { decodeWav, sniffSampleRate } from './wav';
import { levels, loudness, summarize } from './dsp';

// bytes => { sample_rate, channels: Float32Array[], resampled? }. WAVs are read here, the rest by the browser.
export async function decodeAudio(bytes) {
  const wav = decodeWav(bytes);
  if (wav) return wav;
  const Context = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Context) throw new Error("this browser can't decode audio");
  // decodeAudioData resamples to the context's rate: we give it the file's when the header says it
  const rate = sniffSampleRate(bytes);
  const context = new Context(1, 1, rate ?? 48000);
  const buffer = await new Promise((resolve, reject) => {
    // Safari had only the callback form. It detaches the bytes.
    const promise = context.decodeAudioData(bytes.slice(0), resolve, error => reject(error ?? new Error('could not decode the file')));
    promise?.catch?.(() => {});
  }).catch(error => {
    throw new Error(error?.message ? `could not decode the file (${error.message})` : 'could not decode the file: unsupported codec?');
  });
  // copies: tracks are cached and shared, and Firefox detaches the arrays of an AudioBuffer once it plays (player.js
  // plays buffers of its own)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)));
  return { sample_rate: buffer.sampleRate, channels, resampled: rate === undefined };
}

export function toTrack({ sample_rate, channels, resampled }) {
  if (!channels.length || !channels[0].length) throw new Error('the file has no samples');
  const length = channels[0].length;
  return {
    sample_rate, channels, resampled, length,
    duration: length / sample_rate,
    summary: summarize(channels),
    levels: levels(channels),
    loudness: loudness(channels, sample_rate),
  };
}

// fresh: ask the server again, not the browser's cache (a file that can still change)
export async function loadTrack(src, { signal, decode = decodeAudio, fresh = false } = {}) {
  const response = await fetch(src, fresh ? { signal, cache: 'no-cache' } : { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'error'}`.trim());
  const decoded = await decode(await response.arrayBuffer());
  return toTrack(decoded);
}

// The tracks decoded last, by URL and version: going back to a step, or expanding a compact row, doesn't decode again.
// Up to 25M samples (100 MB of Float32): a few long files (10 minutes of stereo at 48 kHz is 58M samples: alone, it
// stays until the next one), or hundreds of short ones.
// - version: what identifies the file's contents when it's known, e.g. its hash: a file written again is decoded again
// - live: the file can still change (its run is running): without a version, it's fetched and decoded every time
export const MAX_CACHED_SAMPLES = 25e6;
const cache = new Map();
export function cachedTrack(src, { version, live = false } = {}) {
  if (live && !version) return loadTrack(src, { fresh: true });
  const key = version ? `${src}\n${version}` : src;
  if (cache.has(key)) {
    const entry = cache.get(key);
    cache.delete(key);
    cache.set(key, entry);
    return entry.promise;
  }
  const entry = { samples: 0 };
  entry.promise = loadTrack(src, { fresh: !!version }).then(track => {
    entry.samples = track.length * track.channels.length;
    let total = 0;
    for (const e of cache.values()) total += e.samples;
    for (const [key, e] of cache) {
      if (total <= MAX_CACHED_SAMPLES || e === entry) break;
      total -= e.samples;
      cache.delete(key);
    }
    return track;
  }, error => {
    // a file may be written later (the run is running): try again next time
    cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  return entry.promise;
}
