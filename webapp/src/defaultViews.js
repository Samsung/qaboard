// The view a commit page opens on when qaboard.yaml doesn't choose one (outputs.default_tab_details): the most useful
// with what the project set up. Visualizations when it has some, else the metrics' summary when runs have metrics,
// else the files the runs created. When every run failed, their logs.
import { config_visualizations } from "./viewers/controls";
import { started_from_code } from "./viewers/runView";

// The views of the metrics: one entry in the sidebar, switched from the page
export const metrics_views = ['summary', 'table-kpi', 'table-compare'];
export const is_metrics_view = view => metrics_views.includes(view);

// Every run has them: they say nothing about its results
export const automatic_metrics = new Set(['is_failed', 'compute_time']);

// Whether runs have metrics about their results, not only those every run has
export const has_result_metrics = used_metrics => [...(used_metrics ?? [])]
  .some(key => !automatic_metrics.has(key) && !key.startsWith('.'));

// What the runs of a batch say about the default view.
// `ready`: they say enough to choose for good: they all finished, or one succeeded. Until then, the choice can change.
export const batch_facts = ({ config_outputs, outputs }) => {
  const runs = Object.values(outputs ?? {}).filter(o => o && o.output_type !== 'optim_iteration');
  const finished = runs.filter(o => !o.is_pending && !o.is_running);
  const succeeded = finished.filter(o => !o.is_failed);
  const used_metrics = new Set(succeeded.flatMap(o => Object.keys(o.metrics ?? {})));
  return {
    // runs started from code (qaboard.start_run()) show what they logged without any visualization in qaboard.yaml
    has_visualizations: config_visualizations(config_outputs).length > 0 || runs.some(started_from_code),
    has_metrics: has_result_metrics(used_metrics),
    all_failed: finished.length > 0 && finished.length === runs.length && succeeded.length === 0,
    ready: runs.length > 0 && (succeeded.length > 0 || finished.length === runs.length),
  };
};

export const automatic_default_view = ({ has_visualizations, has_metrics, all_failed }) => {
  if (all_failed) return 'logs';
  if (has_visualizations) return 'output-list';
  if (has_metrics) return 'summary';
  return 'bit-accuracy';
};

// qaboard.yaml's choice, e.g. `default_tab_details: output_list` or a list of views, else the automatic one
export const default_views_of = (configured, automatic_view) => configured
  ? [].concat(configured).map(view => view.replace('_', '-'))
  : [automatic_view];
