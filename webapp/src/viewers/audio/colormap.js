// Magma (matplotlib's), from 9 of its colors: dark for silence, light for loud, readable in both themes
const MAGMA = ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55064', '#fb8761', '#fec287', '#fcfdbf']
  .map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

// 256 colors, r, g, b
export const magma = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (MAGMA.length - 1);
    const k = Math.min(MAGMA.length - 2, Math.floor(t));
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = MAGMA[k][c] + (MAGMA[k + 1][c] - MAGMA[k][c]) * (t - k);
  }
  return lut;
})();
