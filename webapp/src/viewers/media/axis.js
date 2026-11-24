// The values at which to label an axis of `width` pixels: about one per 110 px, round numbers. The timeline and the
// histograms' steps use the same.
export const axisTicks = (min, max, width) => {
  if (max <= min) return [min];
  const count = Math.max(1, Math.floor(width / 110));
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= raw) ?? raw;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
};
