// How runs are sorted on the commit page: by their name, batch, database, status, configuration, id, storage,
// a metric or a tuning parameter. Ties are broken by name, then id, so the order is always the same.
// Text sorts A to Z by default, numbers largest first: `sort_order` (1: ascending, -1: descending) is only
// in the URL when users chose it.
import { get as _get } from "es-toolkit/compat";

import { runName } from "../utils/runName";
import { configurationSummary } from "../configurations/tokens";


// e.g. frame_2 before frame_10, case-insensitive
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// failed first when ascending: they're what users look for
const status_rank = output => output.is_failed ? 0 : output.is_running ? 1 : output.is_pending ? 2 : 3;

// What we sort by, besides metrics and tuning parameters. Metrics win over them: a project may have a "status" metric.
export const run_sort_keys = {
  test_input_path: { label: 'Name', value: output => runName(output), text: true },
  'data.batch': { label: 'Batch', value: output => output.data?.batch, text: true },
  test_input_database: { label: 'Database', value: output => output.test_input_database, text: true },
  status: { label: 'Status', value: status_rank },
  configuration: { label: 'Configuration', value: output => configurationSummary(output) || undefined, text: true },
  id: { label: 'Run id', value: (output, id) => Number(output.id ?? id) },
  'data.storage': { label: 'Storage', value: output => output.data?.storage },
};

// [ascending, descending]
export const order_labels = sort_by => {
  if (sort_by === 'status') return ['Failed first', 'Succeeded first'];
  if (sort_by === 'id') return ['Oldest first', 'Newest first'];
  if (sort_by === 'data.storage') return ['Smallest first', 'Largest first'];
  if (run_sort_keys[sort_by]?.text) return ['A to Z', 'Z to A'];
  return ['Lowest first', 'Highest first'];
};

// Text A to Z, failed first; numbers (metrics, ids, storage...) largest first
export const default_sort_order = sort_by => run_sort_keys[sort_by]?.text || sort_by === 'status' ? 1 : -1;
export const effective_sort_order = (sort_by, sort_order) => {
  const order = Number(sort_order);
  return order === 1 || order === -1 ? order : default_sort_order(sort_by);
};

// Without a choice: the project's default metric. Else, when the runs come from several batches of qaboard.yaml,
// by batch, like their names (see components/runNames.jsx); else by name.
export const default_sort_by = (outputs, default_metric) => {
  if (default_metric) return default_metric;
  const batches = new Set();
  for (const output of outputs) {
    if (output?.data?.batch) batches.add(output.data.batch);
    if (batches.size > 1) return 'data.batch';
  }
  return 'test_input_path';
};

export const sort_value = (output, id, sort_by) => {
  const metric = output.metrics?.[sort_by];
  if (metric !== undefined && metric !== null) return metric;
  const key = run_sort_keys[sort_by];
  if (key) return key.value(output, id);
  return output.params?.[sort_by] ?? _get(output.params, sort_by) ?? _get(output, sort_by);
};

const missing = value => value === undefined || value === null || value === '' || (typeof value === 'number' && Number.isNaN(value));
export const compare_values = (a, b) => typeof a === 'number' && typeof b === 'number'
  ? a - b
  : collator.compare(typeof a === 'object' ? JSON.stringify(a) : String(a), typeof b === 'object' ? JSON.stringify(b) : String(b));

// The ids, sorted. Runs without a value come last, whatever the order.
export const sorted_ids = (ids, outputs, sort_by, sort_order) => {
  const order = effective_sort_order(sort_by, sort_order);
  const values = new Map(ids.map(id => [id, sort_value(outputs[id], id, sort_by)]));
  const names = new Map(ids.map(id => [id, runName(outputs[id])]));
  return [...ids].sort((ka, kb) => {
    const a = values.get(ka);
    const b = values.get(kb);
    if (missing(a) !== missing(b)) return missing(a) ? 1 : -1;
    const by_value = missing(a) ? 0 : order * compare_values(a, b);
    if (by_value !== 0) return by_value;
    return collator.compare(names.get(ka), names.get(kb)) || compare_values(Number(ka), Number(kb));
  });
};
