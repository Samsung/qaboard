// The audio viewer's computations. Run with: cd webapp && npm test -- --run src/viewers/audio
import { CLIP, dbfs, difference, fft, frequencyRow, levels, loudness, matchingGains, mixdown, peaks, rowFrequency, stft, summarize } from '../dsp';
import { formatDb, formatRate, formatTime, timeTicks } from '../format';
import { magma } from '../colormap';

const sine = (frequency, rate, seconds, amplitude = 1) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));

describe('waveform peaks', () => {
  it('summarizes min and max over bins and channels', () => {
    const left = Float32Array.from([0, 0.5, -0.25, 0.1, 0, 0]);
    const right = Float32Array.from([0, -0.75, 0, 0, 0.9, 0]);
    const summary = summarize([left, right], 2);
    expect(Array.from(summary.min)).toEqual([-0.75, -0.25, 0]);
    expect(Array.from(summary.max)).toEqual([0.5, 0.10000000149011612, 0.8999999761581421]);
  });

  it('aggregates bins into columns', () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => i < 500 ? 0.2 : -0.6);
    const summary = summarize([samples], 10);
    const { min, max } = peaks(summary, { width: 2 });
    expect(Array.from(max).map(v => +v.toFixed(2))).toEqual([0.2, -0.6]);
    expect(Array.from(min).map(v => +v.toFixed(2))).toEqual([0.2, -0.6]);
  });

  it('has a column per pixel even with fewer samples than pixels', () => {
    const summary = summarize([Float32Array.from([1, -1])]);
    const { min, max } = peaks(summary, { width: 4 });
    expect(Array.from(max)).toEqual([1, 1, -1, -1]);
    expect(Array.from(min)).toEqual([1, 1, -1, -1]);
  });

  it('bins long files to a bounded summary', () => {
    const summary = summarize([new Float32Array(48000 * 60)]);
    expect(summary.min.length).toBeLessThanOrEqual(65536 * 2);
    expect(summary.bin).toBeGreaterThan(1);
  });
});

describe('levels', () => {
  it('measures a full-scale sine at 0 dBFS peak and -3 dBFS RMS', () => {
    const { peak, rms, clipped } = levels([sine(1000, 48000, 1)]);
    expect(dbfs(peak)).toBeCloseTo(0, 2);
    expect(dbfs(rms)).toBeCloseTo(-3.01, 1);
    expect(clipped).toBeGreaterThan(0);
  });

  it('counts clipped samples, and silence is -∞', () => {
    expect(levels([Float32Array.from([1, -1, 0.5, CLIP + 1e-5])]).clipped).toBe(3);
    expect(dbfs(levels([new Float32Array(10)]).peak)).toBe(-Infinity);
    expect(formatDb(-Infinity)).toBe('-∞ dBFS');
    expect(formatDb(-3.0103)).toBe('-3.0 dBFS');
  });

  it('mixes channels down, and subtracts tracks', () => {
    expect(Array.from(mixdown([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5]);
    const [diff] = difference([Float32Array.from([1, 0.5, 0.25])], [Float32Array.from([1, 0.25])]);
    expect(Array.from(diff)).toEqual([0, 0.25, 0.25]);
    // different channel counts: the mixdowns
    expect(difference([Float32Array.from([1]), Float32Array.from([0])], [Float32Array.from([0.5])])).toHaveLength(1);
  });
});

describe('loudness', () => {
  it('measures a full-scale 1 kHz sine at -3 LUFS, as BS.1770 says', () => {
    expect(loudness([sine(997, 48000, 3)], 48000)).toBeCloseTo(-3.01, 1);
    // at another rate, and twice as loud on two channels
    expect(loudness([sine(997, 44100, 3), sine(997, 44100, 3)], 44100)).toBeCloseTo(0, 1);
    // 20 dB quieter
    expect(loudness([sine(997, 48000, 3, 0.1)], 48000)).toBeCloseTo(-23.01, 1);
  });

  it('weighs bass less, and gates silence out', () => {
    expect(loudness([sine(40, 48000, 3)], 48000)).toBeLessThan(-6);
    const half_silent = new Float32Array(48000 * 6);
    half_silent.set(sine(997, 48000, 3));
    expect(loudness([half_silent], 48000)).toBeCloseTo(-3.01, 0);
    expect(loudness([new Float32Array(48000)], 48000)).toBe(-Infinity);
    expect(loudness([sine(997, 48000, 0.05)], 48000)).toBeGreaterThan(-6);
  });

  it('matches tracks to the quietest, never up', () => {
    expect(matchingGains([-14, -20])).toEqual([-6, 0]);
    expect(matchingGains([-Infinity, -20])).toEqual([0, 0]);
    expect(matchingGains([-14])).toEqual([0]);
  });
});

describe('FFT and spectrograms', () => {
  it('finds a sine in its bin', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * 5 * i / n));
    const im = new Float64Array(n);
    fft(re, im);
    const magnitudes = Array.from(re, (r, k) => Math.hypot(r, im[k]));
    expect(magnitudes[5]).toBeCloseTo(n / 2, 6);
    expect(magnitudes[59]).toBeCloseTo(n / 2, 6);
    expect(magnitudes[4]).toBeCloseTo(0, 6);
  });

  it('gives a full-scale sine 0 dBFS at its frequency', () => {
    const rate = 16000, size = 1024;
    // on a bin's frequency
    const frequency = 64 * rate / size;
    const spectrogram = stft([sine(frequency, rate, 1)], { size });
    expect(spectrogram.bins).toBe(513);
    expect(spectrogram.frames).toBe(Math.ceil(16000 / (size / 4)));
    const frame = spectrogram.data.subarray(spectrogram.bins * 3, spectrogram.bins * 4);
    expect(frame.indexOf(Math.max(...frame))).toBe(64);
    expect(frame[64]).toBeCloseTo(0, 1);
    expect(frame[200]).toBeLessThan(-60);
    // the mean of the channels
    const stereo = stft([sine(frequency, rate, 1), new Float32Array(rate)], { size });
    expect(stereo.data[stereo.bins * 3 + 64]).toBeCloseTo(-6.02, 1);
  });

  it('computes a frame per column of what is shown', () => {
    expect(stft([new Float32Array(48000 * 600)], { size: 2048 }).frames).toBe(2000);
    // zoomed in on 1 s of a 440 Hz sine, after 1 s of silence
    const rate = 8000;
    const samples = new Float32Array(2 * rate);
    samples.set(sine(440, rate, 1), rate);
    const zoomed = stft([samples], { size: 256, start: 0.5 * rate, end: 1.5 * rate, frames: 100 });
    expect(zoomed.frames).toBe(100);
    const bin = Math.round(440 / rate * 256);
    expect(zoomed.data[10 * zoomed.bins + bin]).toBeLessThan(-100);
    expect(zoomed.data[90 * zoomed.bins + bin]).toBeGreaterThan(-3);
  });

  it('maps rows to log frequencies and back', () => {
    expect(rowFrequency(0, 100, 24000)).toBeCloseTo(24000);
    expect(rowFrequency(99, 100, 24000)).toBeCloseTo(20);
    expect(frequencyRow(rowFrequency(42, 100, 24000), 100, 24000)).toBeCloseTo(42);
  });

  it('has a 256 colors colormap, dark to light', () => {
    expect(magma).toHaveLength(768);
    expect(Array.from(magma.slice(0, 3))).toEqual([0, 0, 4]);
    expect(Array.from(magma.slice(765))).toEqual([252, 253, 191]);
  });
});

describe('formatting', () => {
  it('writes times', () => {
    expect(formatTime(75.5)).toBe('1:15.500');
    expect(formatTime(3725, 0)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('-:--');
    expect(formatTime(0.0004)).toBe('0:00.000');
  });

  it('writes rates', () => {
    expect(formatRate(48000)).toBe('48 kHz');
    expect(formatRate(44100)).toBe('44.1 kHz');
    expect(formatRate(22050)).toBe('22.05 kHz');
    expect(formatRate(800)).toBe('800 Hz');
  });

  it('puts ticks at round times', () => {
    const ticks = timeTicks(0, 30, 900);
    expect(ticks.map(t => t.time)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(ticks[1].label).toBe('0:05');
    expect(timeTicks(0, 0.5, 1000).map(t => t.label).slice(0, 3)).toEqual(['0:00.00', '0:00.05', '0:00.10']);
    // zoomed in: from the first tick in view
    expect(timeTicks(12.34, 12.36, 900).map(t => t.label).slice(0, 2)).toEqual(['0:12.340', '0:12.342']);
    expect(timeTicks(0, 0, 100)).toEqual([]);
  });
});
