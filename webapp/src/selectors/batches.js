// Derived data about the batches we compare. Pure functions: they never modify their inputs,
// so the cached server data stays intact and React sees changes.
import { filter_batch, matching_output, index_outputs } from "../utils";
import { empty_batch } from "../defaults";
import { default_sort_by, effective_sort_order, sorted_ids } from "./sorting";


// The batch to show: the selected one if the commit has it, else its only/first batch
export const available_batch = (commit, label) => {
  if (!commit?.batches) return label;
  const labels = Object.keys(commit.batches);
  if (labels.length === 1 || !commit.batches[label])
    return labels[0] ?? label;
  return label;
};


export const compute_config = ({ new_batch, new_commit, project_data, selected }) => {
  // batches keep their own qaboard.yaml when it differs from their commit's, e.g. with `qa --share batch`
  const batch_config = new_batch?.data?.qatools_config ?? new_batch?.data?.config;
  const commit_config = new_commit?.data?.qatools_config;
  const project_config = project_data?.data?.qatools_config ?? {};

  const project_metrics = project_data?.data?.qatools_metrics;
  const metrics = new_batch?.data?.qatools_metrics ?? new_commit?.data?.qatools_metrics ?? project_metrics ?? {};
  const defaults = { summary_metrics: [], available_metrics: {}, main_metrics: [] };
  return {
    git: project_data?.data?.git,
    project_config,
    config: batch_config ?? commit_config ?? project_config,
    project_metrics: { ...defaults, ...project_metrics },
    metrics: { ...defaults, ...metrics },
    selected_metrics: selected?.selected_metrics ?? metrics.main_metrics ?? [],
  };
};


// Outputs with their matching reference output. We reuse the objects when nothing changed,
// so that output cards don't re-render when e.g. the filter changes.
const with_reference_cache = new WeakMap();
const with_reference = (output, reference_id, reference_mismatch) => {
  const cached = with_reference_cache.get(output);
  const same_mismatch = (a, b) => a === b || (!!a && !!b && Object.keys(a).every(k => a[k] === b[k]));
  if (cached && cached.reference_id === reference_id && same_mismatch(cached.reference_mismatch, reference_mismatch))
    return cached;
  const value = { ...output, reference_id, reference_mismatch };
  with_reference_cache.set(output, value);
  return value;
};


// Parameters that vary between outputs (e.g. when tuning), sorted by their number of values
const tuning_parameters = outputs => {
  const extra_parameters = {};
  const add_params = (output_params, prefix = '') => {
    Object.entries(output_params ?? {}).forEach(([key, value]) => {
      const key_ = prefix !== '' ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null)
        add_params(value, key_);
      else
        (extra_parameters[key_] ??= new Set()).add(value);
    });
  };
  const has_optim_iterations = outputs.some(o => o.output_type === "optim_iteration");
  outputs
    .filter(o => !has_optim_iterations || o.output_type === "optim_iteration")
    .forEach(o => add_params(o.params));
  const sorted_extra_parameters = Object.entries(extra_parameters)
    .sort(([, s1], [, s2]) => s2.size - s1.size)
    .map(([k]) => k);
  return { extra_parameters, sorted_extra_parameters };
};


const with_filter = (batch, filter) => {
  const outputs = batch?.outputs ?? {};
  const base = { ...empty_batch, ...batch, outputs };
  return { ...base, filtered: filter_batch(base, filter) };
};


// What the commit page compares: the selected batches of the new and reference commits, filtered
export const compute_batches = ({ new_commit, ref_commit, selected, metrics }) => {
  const selected_batch_new = available_batch(new_commit, selected.selected_batch_new);
  const selected_batch_ref = available_batch(ref_commit, selected.selected_batch_ref);
  const raw_new = new_commit?.batches?.[selected_batch_new] ?? empty_batch;
  const raw_ref = ref_commit?.batches?.[selected_batch_ref] ?? empty_batch;

  const ref_batch = with_filter(raw_ref, selected.filter_batch_ref);
  const new_filtered = with_filter(raw_new, selected.filter_batch_new);

  // the default depends on the runs, not on the filter: the order doesn't change while users type one
  const default_by = default_sort_by(Object.values(new_filtered.outputs), metrics?.default_metric);
  const sort_by = selected.sort_by || default_by;
  const sort_order = effective_sort_order(sort_by, selected.sort_order);
  const filtered_ids = sorted_ids(new_filtered.filtered.outputs, new_filtered.outputs, sort_by, sort_order);

  // we find the matching outputs once
  const index = index_outputs(ref_batch);
  const outputs = { ...new_filtered.outputs };
  for (const id of filtered_ids) {
    const output = new_filtered.outputs[id];
    const { output_ref, mismatch } = matching_output({ output, batch: ref_batch, index });
    outputs[id] = with_reference(output, output_ref.id, mismatch);
  }

  const all_outputs = Object.values(outputs);
  const used_metrics = new Set();
  const metrics_with_refs = new Set();
  all_outputs.forEach(o => {
    Object.keys(o.metrics ?? {}).forEach(m => {
      used_metrics.add(m);
      if (o.reference_id) metrics_with_refs.add(m);
    });
  });

  const new_batch = {
    ...new_filtered,
    outputs,
    filtered: { ...new_filtered.filtered, outputs: filtered_ids },
    ...tuning_parameters(all_outputs),
    used_metrics,
    metrics_with_refs,
  };
  // how the runs are sorted: { by, order, default_by }
  const sorting = { by: sort_by, order: sort_order, default_by };
  return { selected_batch_new, selected_batch_ref, new_batch, ref_batch, sorting };
};
