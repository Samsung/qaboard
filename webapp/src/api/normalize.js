// Turn API responses into what the app works with. Applied once, when the data is fetched:
// components and hooks never modify server data afterwards.
import { metrics_fill_defaults } from "../utils";
import { default_project } from "../defaults";


export const normalize_metrics = qatools_metrics => {
  if (!qatools_metrics) return qatools_metrics;
  const available_metrics = metrics_fill_defaults(qatools_metrics.available_metrics);
  return {
    ...qatools_metrics,
    available_metrics,
    main_metrics: (qatools_metrics.main_metrics ?? []).filter(m => !!available_metrics[m]),
  };
};

const normalize_data = data => data?.qatools_metrics ? { ...data, qatools_metrics: normalize_metrics(data.qatools_metrics) } : data;


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

const normalize_batch = batch => ({
  ...batch,
  data: normalize_data(batch.data),
  outputs: Object.fromEntries(Object.entries(batch.outputs ?? {}).map(([id, o]) => [id, normalize_output(o)])),
});

export const normalize_commit = commit => ({
  ...commit,
  data: normalize_data(commit.data),
  batches: Object.fromEntries(Object.entries(commit.batches ?? {}).map(([label, b]) => [label, normalize_batch(b)])),
});
