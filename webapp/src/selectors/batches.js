// Derived data about the batches we compare. Pure functions: they never modify their inputs,
// so the cached server data stays intact and React sees changes.
import { get as _get } from "es-toolkit/compat";

import { filter_batch, matching_output, index_outputs } from "../utils";
import { empty_batch } from "../defaults";


// The batch to show: the selected one if the commit has it, else its only/first batch
export const available_batch = (commit, label) => {
  if (!commit?.batches) return label;
  const labels = Object.keys(commit.batches);
  if (labels.length === 1 || !commit.batches[label])
    return labels[0] ?? label;
  return label;
};


export const compute_config = ({ new_batch, new_commit, project_data, selected }) => {
  const batch_config = new_batch?.data?.config;
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


const sort_value = (output, id, sort_by) =>
  output.metrics?.[sort_by] ?? output.params?.[sort_by] ?? _get(output.params, sort_by) ?? _get(output, sort_by) ?? id;

const sorted_ids = (ids, outputs, sort_by, sort_order) => {
  const values = new Map(ids.map(id => [id, sort_value(outputs[id], id, sort_by)]));
  return [...ids].sort((ka, kb) => {
    const a = values.get(ka);
    const b = values.get(kb);
    if (a === undefined || a === null) return 1;
    if (a > b) return sort_order;
    if (a < b) return -sort_order;
    return 0;
  });
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

  const sort_by = selected.sort_by || metrics?.default_metric || 'input_test_path';
  const filtered_ids = sorted_ids(new_filtered.filtered.outputs, new_filtered.outputs, sort_by, selected.sort_order ?? -1);

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
  return { selected_batch_new, selected_batch_ref, new_batch, ref_batch };
};
