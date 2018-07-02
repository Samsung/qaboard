import * as slam_metrics from "./slam/metrics";
import * as tof_metrics from "./tof/metrics";

const project_metrics = new Map([
  ["dvs/psp_swip", slam_metrics],
  ["tof/swip_tof", tof_metrics]
]);
const default_metrics = {
  available_metrics: {},
  default_metric: null,
  summary_metrics: [],
  main_metrics: [],
  dashboard_metrics: []
};

var metrics = new Proxy(project_metrics, {
  get: function(target, id) {
    return target.has(id) ? target.get(id) : default_metrics;
  }
});

export { metrics };
