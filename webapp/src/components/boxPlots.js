// What the small box plots of the Summary (metrics.jsx) show. They used to be Plotly's: the statistics are computed
// the same way, and the plots look the same.

// Plotly's default "linear" quartile method. `sorted`: ascending numbers
const quantile = (sorted, q) => {
  const n = q * sorted.length - 0.5;
  if (n < 0) return sorted[0];
  if (n > sorted.length - 1) return sorted.at(-1);
  const frac = n % 1;
  return frac * sorted[Math.ceil(n)] + (1 - frac) * sorted[Math.floor(n)];
};

// The box (quartiles and median), its whiskers (the furthest values within 1.5 times the box's height) and the mean
export const box_stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  return {
    q1,
    median: quantile(sorted, 0.5),
    q3,
    lower: Math.min(q1, sorted.find(v => v >= q1 - 1.5 * iqr)),
    upper: Math.max(q3, sorted.findLast(v => v <= q3 + 1.5 * iqr)),
    mean: sorted.reduce((total, v) => total + v, 0) / sorted.length,
  };
};

// About `count` round values on a linear scale: 1, 2 or 5 times a power of ten apart (see logTickValues for log scales)
export const linear_ticks = (min, max, count = 3) => {
  const rough = (max - min) / count;
  if (!(rough > 0)) return [min];
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(digit => digit * power).find(step => step >= rough);
  const ticks = [];
  for (let k = Math.ceil(min / step); k * step <= max; k++)
    ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
};

// Where to draw the values next to a box: spread across `width` (the same way each time), at `y(value)`.
// Values that would be drawn at the same place, to `cell` pixels, are drawn once: batches can have thousands of runs,
// in plots 100 pixels high.
export const jittered_points = (values, x, width, y, cell = 2) => {
  const seen = new Set();
  const points = [];
  values.forEach((value, i) => {
    // the golden ratio spreads them evenly
    const px = x + width * ((i * 0.618034) % 1 - 0.5);
    const py = y(value);
    const key = `${Math.round(px / cell)} ${Math.round(py / cell)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push([px, py]);
  });
  return points;
};
