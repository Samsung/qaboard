// What the viewers call the compared tracks, and their colors
import { dbfs } from './dsp';
import { formatDb, formatLufs, formatRate, formatTime } from './format';

// light and dark theme colors, like the app's for the new and reference sides
const COLORS = { new: ['#2d72d2', '#4c90f0'], reference: ['#9752fe', '#9c4bf5'], difference: ['#5f6b7c', '#abb3bf'] };

// a label's color: a CSS color, or the app's side colors { hex, hex_dark }. Canvases can't draw CSS variables.
export const colorOf = (labels, side, dark) => {
  const color = labels?.colors?.[side];
  if (typeof color === 'string' && !color.startsWith('var(')) return color;
  if (color?.hex) return dark ? color.hex_dark ?? color.hex : color.hex;
  return COLORS[side][dark ? 1 : 0];
};

export const nameOf = (labels, side) => side === 'difference' ? 'Difference' : labels?.[side] ?? side;

export const channelsName = count => count === 1 ? 'mono' : count === 2 ? 'stereo' : `${count} channels`;

// "48 kHz · stereo · 0:30.000 · peak -1.0 dBFS · RMS -14.2 dBFS · -16.1 LUFS"
export const describe = track => [
  `${formatRate(track.sample_rate)}${track.resampled ? ' (as decoded)' : ''}`,
  channelsName(track.channels.length),
  formatTime(track.duration),
  `peak ${formatDb(dbfs(track.levels.peak))}`,
  `RMS ${formatDb(dbfs(track.levels.rms))}`,
  formatLufs(track.loudness),
].join(' · ');
