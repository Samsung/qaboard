// The y axis of the charts of a metric over commits (CommitsEvolution): its unit, unless the values are relative to
// the first commit (@100), which have none.
export const yAxisSuffix = (metric, relative) => (relative ? '' : (metric?.suffix || ''));

// Whether a commit's batch has every metric, aggregated: the branch chart leaves out the commits that don't, instead
// of drawing a gap
export const hasAllMetrics = (commit, batch_label, metrics, aggregation) => {
  const batch = commit?.batches?.[batch_label];
  if (batch === undefined)
    return false;
  return metrics.every(metric => {
    const value = batch.aggregated_metrics?.[`${metric}_${aggregation}`];
    return value !== undefined && value !== null;
  });
};

// The sum of a metric over a batch's runs, e.g. the number of tests of a commit when each run is a suite of tests.
// Like the backend's `{metric}_sum` (backend/models/Batch.py): values that aren't numbers are left out, and without
// any number there is no sum.
export const sum = values => {
  const numbers = values.filter(x => typeof x === 'number' && !isNaN(x));
  return numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0);
};

// A true/false option of the charts from the URL's query (?relative=false), or its default when the URL doesn't say
export const queryFlag = (params, name, fallback) => {
  const value = params.get(name);
  if (value === null)
    return !!fallback;
  return value.toLowerCase() === 'true';
};
