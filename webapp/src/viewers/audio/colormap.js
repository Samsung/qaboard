// Colormaps of spectrograms, as 256 colors (r, g, b): they draw on their own dark surface, the same in both themes
const lut = stops => {
  const colors = stops.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (colors.length - 1);
    const k = Math.min(colors.length - 2, Math.floor(t));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = colors[k][c] + (colors[k + 1][c] - colors[k][c]) * (t - k);
  }
  return out;
};

// Magma (matplotlib's), from 9 of its colors: dark for silence, light for loud
export const magma = lut(['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf']);

// Differences, dark where tracks are alike: orange where the reference is louder (low), blue where the new one is (high),
// blue like the new results everywhere in the app
export const diverging = lut(['#ffd08a', '#e07b24', '#7a3410', '#111418', '#13305e', '#2d72d2', '#9cc8ff']);

// for legends
export const gradient = (colors, steps = 12) => `linear-gradient(to right, ${Array.from({ length: steps }, (_, i) => {
  const k = Math.round(i / (steps - 1) * 255) * 3;
  return `rgb(${colors[k]}, ${colors[k + 1]}, ${colors[k + 2]})`;
}).join(', ')})`;
