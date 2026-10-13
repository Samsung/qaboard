// Tick values for the small box plots of the Summary (metrics.jsx) on a log scale. On a range under a decade, Plotly
// picks ticks as if the axis were linear (0.1, 0.15, 0.2, 0.25, 0.3) or labels every digit (0.1, 9, 8, 7...): in a
// plot 100 px high, they pile up at the top and overlap. These are 1, 2, 5 times a power of ten within the values'
// range, spread out: at most `maxTicks`, at least a fraction of the range apart. The values should include what else
// sets the axis' range, like a target's shading.
const DIGITS = [1, 2, 5];
// In decades: closer values get a single tick
const MIN_SPAN = 0.15;

// 2 significant digits, without floating point noise (0.30000000000000004)
const round2 = v => Number(v.toPrecision(2));

export function logTickValues(values, maxTicks = 4) {
  const positive = values.filter(v => Number.isFinite(v) && v > 0);
  if (positive.length === 0)
    return undefined;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  // values too close for two labels: one, in the middle
  if (Math.log10(max) - Math.log10(min) < MIN_SPAN)
    return [round2(Math.sqrt(min * max))];
  const lo = Math.log10(min);
  const hi = Math.log10(max);
  const candidates = [];
  for (let decade = Math.floor(lo); decade <= Math.ceil(hi); decade++) {
    for (const digit of DIGITS) {
      const v = Number((digit * 10 ** decade).toPrecision(12));
      if (v >= min && v <= max)
        candidates.push(v);
    }
  }
  // fewer than two round values in range: the ends, rounded
  if (candidates.length < 2)
    return [...new Set([round2(min), ...candidates, round2(max)])].sort((a, b) => a - b);
  const gap = (hi - lo) / maxTicks;
  const ticks = [];
  for (const v of candidates) {
    if (ticks.length === 0 || Math.log10(v) - Math.log10(ticks[ticks.length - 1]) >= gap - 1e-9)
      ticks.push(v);
  }
  return ticks.slice(0, maxTicks);
}
