const available_metrics = {
  is_failed: {
    key: "is_failed",
    label: "Crashed",
    short_label: "Crashed",
    scale: 100,
    suffix: "%",
    threshold: 0,
    smaller_is_better: true,
    plot_scale: "linear"
  },

  rmse_mean: {
    key: "rmse_mean",
    label: "Average RMSE",
    short_label: "RMSE avg",
    scale: 1,
    suffix: "cm",
    threshold: 0.1,
    smaller_is_better: true
  },
  
  pcmd_mean: {
	  key: "pcmd_mean",
	  label: "Average PCMD",
	  short_label: "PCMD avg",
	  scale: 1,
	  suffix: "cm",
	  threshold: 0.1,
	  smaller_is_better: true
  },

  rmse_median: {
    key: "rmse_median",
    label: "Median RMSE",
    short_label: "RMSE med",
    scale: 1,
    suffix: "cm",
    threshold: 0.1,
    smaller_is_better: true
  },

  cpu_avg: {
    key: "cpu_avg",
    label: "Average CPU usage",
    short_label: "CPU avg.",
    scale: 1,
    suffix: "%",
    threshold: 200,
    smaller_is_better: true
  },

  cpu_med: {
    key: "cpu_med",
    label: "Median CPU usage",
    short_label: "CPU median",
    scale: 1,
    suffix: "%",
    threshold: 200,
    smaller_is_better: true
  },

  processing_time_avg: {
    key: "processing_time_avg",
    label: "Average processing",
    short_label: "Processing Avg",
    scale: 1,
    suffix: "ms",
    threshold: 25.0,
    smaller_is_better: true
  },
  processing_time_med: {
    key: "processing_time_med",
    label: "Median processing",
    short_label: "Processing Med",
    scale: 1,
    suffix: "ms",
    threshold: 25.0,
    smaller_is_better: true
  },
  processing_time_q95: {
    key: "processing_time_q95",
    label: "Processing Time @95%",
    short_label: "Processing q95",
    scale: 1,
    suffix: "ms",
    threshold: 25.0,
    smaller_is_better: true
  },
  processing_time_max: {
    key: "processing_time_max",
    label: "Max processing time",
    short_label: "Processing Max",
    scale: 1,
    suffix: "ms",
    threshold: 25.0,
    smaller_is_better: true
  }
};

// will be shown proeminently in the index page, and first for tuning exploration
const default_metric = "rmse_median";
// will be shown in the summary histogramms of each commit
const summary_metrics = [
  "is_failed",
  "rmse_mean",
  "rmse_median",
  "cpu_med",
  "cpu_avg",
  "processing_time_med",
  "processing_time_q95"
];
// will be shown in the table and 6dof output cards
const main_metrics = ["rmse_mean", "pcmd_mean"];
const dashboard_metrics = ["is_failed", "rmse_mean", "rmse_median"];

export {
  available_metrics,
  default_metric,
  main_metrics,
  summary_metrics,
  dashboard_metrics
};
