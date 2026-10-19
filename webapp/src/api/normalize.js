// Turn API responses into what the app works with. Applied once, when the data is fetched:
// components and hooks never modify server data afterwards.
import { metrics_fill_defaults, merge_metrics_definitions } from "../utils";
import { default_project } from "../defaults";


// The metrics file's definitions, with those declared in code (`definitions`). main_metrics can list metrics
// that were not declared: components show them with neutral definitions (metric_info in utils.js).
export const normalize_metrics = (qatools_metrics, definitions) => {
  const merged = merge_metrics_definitions(qatools_metrics, definitions);
  if (!merged) return merged;
  return {
    ...merged,
    available_metrics: metrics_fill_defaults(merged.available_metrics),
    // dotted keys hide definitions, e.g. YAML anchors
    main_metrics: Array.isArray(merged.main_metrics) ? merged.main_metrics.filter(m => typeof m === 'string' && !m.startsWith('.')) : [],
  };
};

// Commits and projects keep the metrics declared in code next to the metrics file's, see backend/backend/metrics_definitions.py
const normalize_data = data => (data?.qatools_metrics || data?.metrics_definitions)
  ? { ...data, qatools_metrics: normalize_metrics(data.qatools_metrics, data.metrics_definitions) }
  : data;


// Projects without a qaboard.yaml come with data: null
export const normalize_project = project => ({
  ...project,
  data: {
    ...default_project.data,
    ...normalize_data(project?.data),
  },
});

export const normalize_projects = projects => Object.fromEntries(
  Object.entries(projects ?? {}).map(([id, project]) => [id, normalize_project(project)])
);


// Precomputes what's useful to filter, match and compare outputs
export const normalize_output = output => {
  const run_params = output.data?.params;
  const extra_parameters = run_params !== undefined ? { ...output.extra_parameters, ...run_params } : output.extra_parameters;
  let params = {};
  for (const c of [...(output.configurations ?? []), extra_parameters]) {
    if (typeof c === "string" || c === undefined || c === null) continue;
    params = { ...params, ...c };
  }
  return {
    ...output,
    extra_parameters,
    input_path: `${output.test_input_database}/${output.test_input_path}`.replace("//", "/"),
    configurations_str: JSON.stringify(output.configurations),
    extra_parameters_str: JSON.stringify(extra_parameters),
    params,
    metrics: output.metrics ?? {},
  };
};

// Batches can have their own metrics file (e.g. changed locally, with `qa --share`): we add the commit's metrics declared in code
const normalize_batch = (batch, definitions) => ({
  ...batch,
  data: batch.data?.qatools_metrics ? { ...batch.data, qatools_metrics: normalize_metrics(batch.data.qatools_metrics, definitions) } : batch.data,
  outputs: Object.fromEntries(Object.entries(batch.outputs ?? {}).map(([id, o]) => [id, normalize_output(o)])),
});

export const normalize_commit = commit => ({
  ...commit,
  data: normalize_data(commit.data),
  batches: Object.fromEntries(Object.entries(commit.batches ?? {}).map(([label, b]) => [label, normalize_batch(b, commit.data?.metrics_definitions)])),
});
