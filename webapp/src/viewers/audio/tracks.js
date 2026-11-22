// Audio files => tracks: decoded samples, with what the viewer shows of them computed once (waveform summary, levels)
import { decodeWav, sniffSampleRate } from './wav';
import { levels, summarize } from './dsp';

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
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  return { sample_rate: buffer.sampleRate, channels, buffer, resampled: rate === undefined };
}

export function toTrack({ sample_rate, channels, buffer, resampled }) {
  if (!channels.length || !channels[0].length) throw new Error('the file has no samples');
  const length = channels[0].length;
  return {
    sample_rate, channels, buffer, resampled, length,
    duration: length / sample_rate,
    summary: summarize(channels),
    levels: levels(channels),
  };
}

export async function loadTrack(src, { signal, decode = decodeAudio } = {}) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'error'}`.trim());
  const decoded = await decode(await response.arrayBuffer());
  return toTrack(decoded);
}
