import * as slam_metrics from "./slam/metrics";
import * as tof_metrics from "./tof/metrics";
import { get } from "axios";




var project_metrics = (localStorage.project_metrics !==undefined && new Map(JSON.parse(localStorage.project_metrics))) || new Map([])

// for projects build without qatools
const hardcoded_project_metrics = new Map([
  ["dvs/psp_swip", slam_metrics],
  ["tof/swip_tof", tof_metrics]
]);
project_metrics = new Map([...hardcoded_project_metrics, ...project_metrics])


const default_metrics = {
  available_metrics: {},
  default_metric: null,
  summary_metrics: [],
  main_metrics: [],
  dashboard_metrics: []
};


// try downloading
// and load into localstorage for next calls...
get("/api/v1/projects")
  .then(response => {
    const projects = response.data
    for (var [project, details] of Object.entries(projects)) {
      if (details && details.information && details.information.qatools_metrics)
        project_metrics.set(project, details.information.qatools_metrics)
    }
    localStorage.project_metrics = JSON.stringify(Array.from(project_metrics.entries()));
  })
  .catch(error => {
    console.log(error);
  });



var metrics = new Proxy(project_metrics, {
  get: function(target, id) {
    return target.has(id) ? target.get(id) : default_metrics;
  }
});

export { metrics };
