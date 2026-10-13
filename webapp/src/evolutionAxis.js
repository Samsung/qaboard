// The y axis of the charts of a metric over commits (CommitsEvolution): its unit, unless the values are relative to
// the first commit (@100), which have none.
export const yAxisSuffix = (metric, relative) => (relative ? '' : (metric?.suffix || ''));
