// WAV files, read and written in JS: the viewer reads WAVs itself, with their exact samples and sample rate (the Web
// Audio API resamples what it decodes to its context's rate), and the playground and tests write them.

// channels: Float32Arrays in [-1, 1] => a 16-bit PCM WAV, or 32-bit float with { float: true }
export function encodeWav(channels, sample_rate, { float = false } = {}) {
  const length = channels[0]?.length ?? 0;
  const bytes = float ? 4 : 2;
  const data_size = length * channels.length * bytes;
  const buffer = new ArrayBuffer(44 + data_size);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data_size, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sample_rate, true);
  view.setUint32(28, sample_rate * channels.length * bytes, true);
  view.setUint16(32, channels.length * bytes, true);
  view.setUint16(34, bytes * 8, true);
  text(36, 'data');
  view.setUint32(40, data_size, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (const samples of channels) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      if (float) view.setFloat32(offset, samples[i], true);
      else view.setInt16(offset, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
      offset += bytes;
    }
  }
  return buffer;
}

const tag = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

// A WAV's samples: { sample_rate, channels: Float32Array[] }, null if it isn't a WAV.
// PCM 8, 16, 24 and 32 bits, float 32 and 64 bits, and their WAVE_FORMAT_EXTENSIBLE variants. Throws on other codecs
// (ADPCM, µ-law...), which the browser may decode.
export function decodeWav(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') return null;
  let format, offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let code = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the codec is the first 2 bytes of the sub-format GUID
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true);
      format = { code, channels: view.getUint16(body + 2, true), sample_rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV without a fmt chunk');
      // files written while streaming can have a size of 0 or 0xFFFFFFFF: what's left
      const data_size = Math.min(size || Infinity, view.byteLength - body);
      return { sample_rate: format.sample_rate, channels: samples(view, body, data_size, format) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV without a data chunk');
}

function samples(view, offset, size, { code, channels: count, bits }) {
  const bytes = bits / 8;
  const read = code === 3 && bits === 32 ? o => view.getFloat32(o, true)
    : code === 3 && bits === 64 ? o => view.getFloat64(o, true)
    : code === 1 && bits === 8 ? o => (view.getUint8(o) - 128) / 128
    : code === 1 && bits === 16 ? o => view.getInt16(o, true) / 32768
    : code === 1 && bits === 24 ? o => ((view.getUint8(o + 2) << 24 | view.getUint8(o + 1) << 16 | view.getUint8(o) << 8) >> 8) / 8388608
    : code === 1 && bits === 32 ? o => view.getInt32(o, true) / 2147483648
    : null;
  if (!read) throw new Error(`WAV codec ${code} with ${bits} bits isn't supported`);
  const length = Math.floor(size / (bytes * count));
  const channels = Array.from({ length: count }, () => new Float32Array(length));
  for (let i = 0; i < length; i++)
    for (let c = 0; c < count; c++) {
      channels[c][i] = read(offset);
      offset += bytes;
    }
  return channels;
}

// The sample rate in the headers of FLAC, Ogg Vorbis and Ogg Opus files, to decode them at their own rate.
// Opus always decodes at 48 kHz: its header has the rate of what was encoded.
export function sniffSampleRate(buffer) {
  const view = new DataView(buffer, 0, Math.min(buffer.byteLength, 512));
  if (view.byteLength < 42) return undefined;
  if (tag(view, 0) === 'fLaC')
    return (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
  if (tag(view, 0) === 'OggS') {
    const text = String.fromCharCode(...new Uint8Array(view.buffer, 0, view.byteLength));
    const vorbis = text.indexOf('\x01vorbis');
    if (vorbis >= 0 && vorbis + 16 <= view.byteLength) return view.getUint32(vorbis + 12, true);
    if (text.includes('OpusHead')) return 48000;
  }
  return undefined;
}
