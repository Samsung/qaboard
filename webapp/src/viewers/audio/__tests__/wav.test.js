// WAV files, read and written by the audio viewer. Run with: cd webapp && npm test -- --run src/viewers/audio
import { decodeWav, encodeWav, sniffSampleRate } from '../wav';
import { generatePair, synthesize } from '../generate';

describe('WAV files', () => {
  it('round-trips 16-bit PCM', () => {
    const channels = [Float32Array.from([0, 0.5, -0.5, 1, -1]), Float32Array.from([0.25, -0.25, 0, 0, 0])];
    const decoded = decodeWav(encodeWav(channels, 44100));
    expect(decoded.sample_rate).toBe(44100);
    expect(decoded.channels).toHaveLength(2);
    decoded.channels.forEach((samples, c) => samples.forEach((v, i) => expect(v).toBeCloseTo(channels[c][i], 4)));
  });

  it('round-trips 32-bit float exactly', () => {
    const channels = [Float32Array.from([0.123456, -0.987654, 1.5])];
    const decoded = decodeWav(encodeWav(channels, 96000, { float: true }));
    expect(Array.from(decoded.channels[0])).toEqual(Array.from(channels[0]));
  });

  it('reads 24-bit PCM, after other chunks', () => {
    const buffer = new ArrayBuffer(12 + 24 + 12 + 8 + 6);
    const view = new DataView(buffer);
    const text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 24000, true); view.setUint16(32, 3, true); view.setUint16(34, 24, true);
    text(36, 'LIST'); view.setUint32(40, 4, true); text(44, 'INFO');
    text(48, 'data'); view.setUint32(52, 6, true);
    // 0x400000 = 0.5, 0xC00000 = -0.5
    [0x00, 0x00, 0x40, 0x00, 0x00, 0xc0].forEach((b, i) => view.setUint8(56 + i, b));
    const decoded = decodeWav(buffer);
    expect(Array.from(decoded.channels[0])).toEqual([0.5, -0.5]);
  });

  it("isn't for other files, and says which codecs it doesn't read", () => {
    expect(decodeWav(new TextEncoder().encode('ID3 an mp3...').buffer)).toBeNull();
    const buffer = encodeWav([new Float32Array(4)], 8000);
    new DataView(buffer).setUint16(20, 2, true);  // MS ADPCM
    expect(() => decodeWav(buffer)).toThrow(/codec 2/);
  });

  it('finds the sample rate of FLAC files', () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x66, 0x4c, 0x61, 0x43]);
    // 44100 = 0xAC44, in 20 bits from byte 18
    bytes.set([0x0a, 0xc4, 0x40], 18);
    expect(sniffSampleRate(bytes.buffer)).toBe(44100);
    expect(sniffSampleRate(new Uint8Array(64).buffer)).toBeUndefined();
  });

  it('generates a pair that differs', () => {
    const pair = generatePair({ seconds: 0.5, rate: 8000, channels: 1 });
    const [a] = decodeWav(pair.new).channels, [b] = decodeWav(pair.reference).channels;
    expect(a).toHaveLength(4000);
    expect(a.some((v, i) => Math.abs(v - b[i]) > 0.01)).toBe(true);
    expect(synthesize({ seconds: 0.1, rate: 8000, channels: 3 })).toHaveLength(3);
  });

  it('throws on headers that make no sense, instead of looping forever', () => {
    const broken = (offset, value, bits = 16) => {
      const buffer = encodeWav([new Float32Array(10)], 8000);
      const view = new DataView(buffer);
      if (bits === 32) view.setUint32(offset, value, true); else view.setUint16(offset, value, true);
      return buffer;
    };
    expect(() => decodeWav(broken(22, 0))).toThrow(/0 channels/);
    expect(() => decodeWav(broken(24, 0, 32))).toThrow(/sample rate of 0/);
    expect(() => decodeWav(broken(34, 12))).toThrow(/12 bits/);
    expect(() => decodeWav(broken(34, 0))).toThrow(/0 bits/);
    expect(() => decodeWav(broken(16, 8, 32))).toThrow(/fmt chunk of 8 bytes/);
  });
});
