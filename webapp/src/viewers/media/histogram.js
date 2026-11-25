// Histograms logged at each step ({bins: n+1 edges, counts: n}) on one grid of values, to draw their distribution
// over the steps as a heatmap. Each step can have its own bins: their counts are spread on the grid's rows by how
// much of each bin a row covers (as if values were uniform inside a bin). Pure JS.

const valid = item => Array.isArray(item?.bins) && Array.isArray(item?.counts) && item.bins.length === item.counts.length + 1 && item.counts.length > 0;

// The range of values of all the histograms: { min, max }, or null
export const histogramRange = items => {
  let min = Infinity, max = -Infinity;
  for (const item of items) {
    if (!valid(item)) continue;
    for (const edge of item.bins) {
      if (!Number.isFinite(edge)) continue;
      if (edge < min) min = edge;
      if (edge > max) max = edge;
    }
  }
  if (!(min <= max)) return null;
  // all the values in one point: a range around it
  if (min === max) return { min: min - 0.5, max: max + 0.5 };
  return { min, max };
};

// A histogram's counts on `rows` rows of equal size from range.min to range.max: a Float64Array
export const resample = (item, range, rows) => {
  const values = new Float64Array(rows);
  if (!valid(item) || !range) return values;
  const size = (range.max - range.min) / rows;
  const { bins, counts } = item;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    const low = bins[i], high = bins[i + 1];
    if (!count || !Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (high <= low) {
      // a bin of no width: all in the row of its value
      const row = Math.min(rows - 1, Math.max(0, Math.floor((low - range.min) / size)));
      values[row] += count;
      continue;
    }
    const first = Math.max(0, Math.floor((low - range.min) / size));
    const last = Math.min(rows - 1, Math.floor((high - range.min) / size));
    for (let row = first; row <= last; row++) {
      const row_low = range.min + row * size;
      const overlap = Math.min(high, row_low + size) - Math.max(low, row_low);
      if (overlap > 0) values[row] += count * overlap / (high - low);
    }
  }
  return values;
};

// The heatmap: { range, rows, columns: [{ step, values }], max }, the steps in order. null without histograms
export const distribution = (entries, rows = 64, range = histogramRange(entries.map(([, item]) => item))) => {
  if (!range) return null;
  let max = 0;
  const columns = entries.map(([step, item]) => {
    const values = resample(item, range, rows);
    for (const value of values) if (value > max) max = value;
    return { step, values };
  });
  return { range, rows, columns, max };
};

// The values under which a fraction q of a histogram's counts are, for each q: e.g. [0.05, 0.5, 0.95] for the
// 5–95% band and the median. Values are spread evenly inside a bin. null without counts
export const quantiles = (item, qs) => {
  if (!valid(item)) return null;
  const total = item.counts.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (!total) return null;
  return qs.map(q => {
    const target = q * total;
    let cumulated = 0;
    for (let i = 0; i < item.counts.length; i++) {
      const count = item.counts[i] > 0 ? item.counts[i] : 0;
      if (count && cumulated + count >= target) {
        const fraction = (target - cumulated) / count;
        return item.bins[i] + fraction * (item.bins[i + 1] - item.bins[i]);
      }
      cumulated += count;
    }
    return item.bins.at(-1);
  });
};
