// Playback and decoding with a fake Web Audio API: jsdom has none. Run with: cd webapp && npm test -- --run src/viewers/audio
import { createPlayer } from '../player';
import { cachedTrack, decodeAudio, MAX_CACHED_SAMPLES } from '../tracks';
import { encodeWav } from '../wav';

class FakeBuffer {
  constructor(count, length, rate) {
    Object.assign(this, { numberOfChannels: count, length, sampleRate: rate, duration: length / rate });
    this.data = Array.from({ length: count }, () => new Float32Array(length));
  }
  copyToChannel(samples, c) { this.data[c].set(samples.subarray(0, this.length)); }
  getChannelData(c) { return this.data[c]; }
}
const node = () => ({ gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} });
const contexts = [];
let created = { buffers: [], sources: [] };
let resume = async () => {};
class FakeContext {
  constructor() { contexts.push(this); }
  state = 'suspended';
  currentTime = 0;
  destination = {};
  createGain() { return node(); }
  createBuffer(count, length, rate) {
    const buffer = new FakeBuffer(count, length, rate);
    created.buffers.push(buffer);
    return buffer;
  }
  createBufferSource() {
    const source = { ...node(), start: vi.fn(), stop() {}, loop: false };
    created.sources.push(source);
    return source;
  }
  resume() { return resume().then(() => { this.state = 'running'; }); }
}

const track = (seconds, rate = 8000, extra = {}) => {
  const length = seconds * rate;
  return { channels: [new Float32Array(length).fill(0.5)], length, sample_rate: rate, duration: seconds, ...extra };
};

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeContext);
  created = { buffers: [], sources: [] };
  resume = async () => {};
  contexts.forEach(context => { context.state = 'suspended'; });
});
afterEach(() => vi.unstubAllGlobals());

describe('the audio player', () => {
  it("isn't stuck playing when the browser refuses to resume the audio", async () => {
    const player = createPlayer({ new: track(1) });
    resume = async () => { throw new Error('not allowed'); };
    await expect(player.play()).rejects.toThrow('not allowed');
    expect(player.playing).toBe(false);
    // it can be tried again
    resume = async () => {};
    await player.play();
    expect(player.playing).toBe(true);
    player.dispose();
  });

  it('plays buffers of its own, not the decoded ones (Firefox detaches their arrays)', async () => {
    const decoded = new FakeBuffer(1, 8000, 8000);
    const player = createPlayer({ new: track(1, 8000, { buffer: decoded }) });
    await player.play();
    expect(created.sources[0].buffer).not.toBe(decoded);
    expect(created.sources[0].buffer.getChannelData(0)[10]).toBe(0.5);
    player.dispose();
  });

  it('pads shorter tracks with silence: loops stay in sync, also after the end of the shorter', async () => {
    const player = createPlayer({ new: track(2), reference: track(1) });
    player.setLoop({ start: 1.5, end: 1.8 });
    await player.play();
    expect(created.buffers.map(buffer => buffer.length)).toEqual([16000, 16000]);
    // silence where the reference has no audio
    expect(created.buffers[1].getChannelData(0)[12000]).toBe(0);
    expect(created.buffers[1].getChannelData(0)[100]).toBe(0.5);
    expect(created.sources.map(source => [source.loopStart, source.loopEnd])).toEqual([[1.5, 1.8], [1.5, 1.8]]);
    player.dispose();
  });
});

describe('decoding', () => {
  it("copies what the browser decodes: the tracks don't share the AudioBuffer's arrays", async () => {
    const decoded = new FakeBuffer(1, 4, 8000);
    decoded.data[0].set([0.1, 0.2, 0.3, 0.4]);
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData(bytes, resolve) { resolve(decoded); } });
    const result = await decodeAudio(new TextEncoder().encode('ID3 an mp3').buffer);
    expect(result.channels[0]).not.toBe(decoded.data[0]);
    expect(Array.from(result.channels[0])).toEqual(Array.from(decoded.data[0]));
    expect(result.buffer).toBeUndefined();
  });

  it('keeps about 100 MB of decoded tracks', async () => {
    expect(MAX_CACHED_SAMPLES).toBeLessThanOrEqual(25e6);
    // two tracks of 13M samples (8-bit: 13 MB of file each) are more than that: the first one is decoded again
    const big = encodeWav([], 8000);
    const length = 13e6;
    const file = new Uint8Array(44 + length).fill(128);
    file.set(new Uint8Array(big).subarray(0, 44));
    const view = new DataView(file.buffer);
    view.setUint32(4, 36 + length, true);
    view.setUint16(22, 1, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    view.setUint32(40, length, true);
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => file.buffer.slice(0) }));
    vi.stubGlobal('fetch', fetch);
    await cachedTrack('/cache/a.wav');
    await cachedTrack('/cache/a.wav');
    expect(fetch).toHaveBeenCalledTimes(1);
    await cachedTrack('/cache/b.wav');
    await cachedTrack('/cache/a.wav');
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 30000);
});
