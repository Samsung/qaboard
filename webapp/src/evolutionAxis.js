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

// A true/false option of the charts from the URL's query (?relative=false), or its default when the URL doesn't say
export const queryFlag = (params, name, fallback) => {
  const value = params.get(name);
  if (value === null)
    return !!fallback;
  return value.toLowerCase() === 'true';
};
