// The numbers of the commit page's Summary and Metrics Diff views.
// The backend computes the same for GET /api/v1/commit/<sha>/compare, that `qa gate` uses (backend/backend/compare.py):
// both are tested against tests/fixtures/metrics-compare.json. Change one, change the other.
import { median } from "../utils";


// Metric values that are numbers: not strings like badges, nor missing values, nor booleans like is_failed
export const is_number = x => typeof x === 'number' && Number.isFinite(x);

export const metric_values = (outputs, key) => outputs.map(o => o.metrics?.[key]).filter(is_number);


// The runs the Summary aggregates: the finished runs, and the reference's runs on the same inputs
export const summary_outputs = (new_batch, ref_batch) => {
  const outputs_new = new_batch.filtered.outputs
    .map(id => new_batch.outputs[id])
    .filter(o => !o.is_pending)
    .filter(o => o.output_type !== "optim_iteration");
  // We only show reference runs with a matching input.
  // It's debatable, maybe we should show all, or filter also on configurations, platforms, tuning params...
  const inputs_new = new Set(outputs_new.map(o => o.test_input_path));
  const outputs_ref = ref_batch.filtered.outputs
    .map(id => ref_batch.outputs[id])
    .filter(o => inputs_new.has(o.test_input_path))
    .filter(o => !o.is_pending);
  return { outputs_new, outputs_ref };
};


// The parameters that differ between these runs (the Summary warns that it aggregates them together), e.g. a tuning
// sweep's. Parameters all the runs share, like the model's name, don't count. Only for the web app.
export const mixed_parameters = outputs => {
  const values = {};
  const collect = (params, prefix) => Object.entries(params ?? {}).forEach(([key, value]) => {
    const key_ = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") collect(value, key_);
    else (values[key_] ??= new Set()).add(JSON.stringify(value));
  });
  outputs.forEach(o => collect(o.params, ''));
  return Object.keys(values).filter(k => values[k].size > 1 || outputs.some(o => !has_key(o.params, k)));
};

const has_key = (params, key) => {
  let value = params;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== "object" || !(part in value)) return false;
    value = value[part];
  }
  return true;
};

// The share of runs that meet the metric's target, null without a target
export const pass_rate = (values, metric) => {
  if (metric.target === undefined || metric.target === null || values.length === 0)
    return null;
  const passed = metric.smaller_is_better ? values.filter(x => x <= metric.target) : values.filter(x => x >= metric.target);
  return passed.length / values.length;
};


// The Summary's numbers for a metric: medians, their change, and the share of runs that meet the target
export const summary_stats = (new_values, ref_values, metric) => {
  const new_med = median(new_values);
  const ref_med = median(ref_values);
  const delta = new_med - ref_med;
  return {
    new_med,
    ref_med,
    delta,
    // relative to the reference's magnitude, so that the sign says whether the metric went up or down
    delta_relative: delta / Math.abs(ref_med),
    new_pc_good: pass_rate(new_values, metric),
    ref_pc_good: pass_rate(ref_values, metric),
  };
};


// A Metrics Diff cell: the change between a run and its reference run
export const diff_cell = (metric_new, metric_ref) => {
  const delta = metric_new - metric_ref;
  return {
    delta,
    delta_relative: delta / (Math.abs(metric_ref) + 0.00001),
  };
};
