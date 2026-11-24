// What the metrics' definitions say about how they group (`group`, `part_of`, `aggregation`: qaboard/metrics.py),
// for the app's requests: which metrics lists of commits ask the server to aggregate, and whether a project has
// groups that need its runs. The trends (src/trends/, loaded on demand) draw them.

// Totals, their parts, and what else adds up in their groups (the tests' time): totals first, then parts.
export function compositionKeys(definitions = {}) {
  const totals = new Set(Object.values(definitions).map(d => d?.part_of).filter(Boolean));
  const groups = new Set([...totals].map(key => definitions[key]?.group).filter(Boolean));
  const keys = Object.keys(definitions).filter(key => totals.has(key) || totals.has(definitions[key]?.part_of)
    || (groups.has(definitions[key]?.group) && !!definitions[key]?.aggregation));
  const rank = key => totals.has(key) ? 0 : definitions[key]?.part_of ? 1 : 2;
  return keys.sort((a, b) => rank(a) - rank(b));
}

// The ones lists of commits ask for, and so the ones charts over lists can show: the server aggregates a limited
// number of metrics (max_aggregated_metrics in backend/backend/models/Batch.py), the project's own come first.
export const MAX_LIST_METRICS = 10;
export const listMetricKeys = definitions => compositionKeys(definitions).slice(0, MAX_LIST_METRICS);

// Whether some metrics are grouped outside of a total's group, like benchmarks: they can be thousands, the server
// doesn't aggregate them for lists
export function hasGroups(definitions = {}) {
  const totals = new Set(Object.values(definitions).map(d => d?.part_of).filter(Boolean));
  const total_groups = new Set([...totals].map(key => definitions[key]?.group).filter(Boolean));
  return Object.entries(definitions).some(([key, d]) => !!d?.group && !d.part_of && !totals.has(key) && !total_groups.has(d.group));
}

// Whether some metrics say how they group: the trends can show something (else nothing is computed for them)
export const describesTrends = (definitions = {}) => Object.values(definitions ?? {}).some(d => !!d?.group || !!d?.part_of);
// A metric the trends show: the other views of the Trends page can leave it to them
export const isGrouped = (definitions, key) => !!definitions?.[key]?.group || !!definitions?.[key]?.part_of;
