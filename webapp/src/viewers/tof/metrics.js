const available_metrics = {
  is_failed: {
    key: "is_failed",
    label: "Crashed",
    short_label: "Crashed",
    scale: 100,
    suffix: "%",
    target: 0,
    smaller_is_better: true,
    plot_scale: "linear"
  },

  area_mtf_mean: {
    key: "area_mtf_mean",
    label: "Average area MTF",
    short_label: "MTF avg",
    scale: 1,
    suffix: "",
    target: 20000,
    smaller_is_better: false
  },

  snr_mean: {
    key: "snr_mean",
    label: "Average SNR",
    short_label: "SNR avg",
    scale: 1,
    suffix: "db",
    target: 40,
    smaller_is_better: false
  },

  precision_mean: {
    key: "precision_mean",
    label: "Average precision",
    short_label: "precision avg",
    scale: 1,
    suffix: "cm",
    target: 0.1,
    smaller_is_better: true
  },

  rmse_mean: {
    key: "rmse_mean",
    label: "Average RMSE",
    short_label: "RMSE avg",
    scale: 1,
    suffix: "cm",
    target: 0.1,
    smaller_is_better: true
  },
  
  pcmd_mean: {
	  key: "pcmd_mean",
	  label: "Average PCMD",
	  short_label: "PCMD avg",
	  scale: 1,
	  suffix: "cm",
	  target: 0.1,
	  smaller_is_better: true
  },

  rmse_median: {
    key: "rmse_median",
    label: "Median RMSE",
    short_label: "RMSE med",
    scale: 1,
    suffix: "cm",
    target: 0.1,
    smaller_is_better: true
  },

  cpu_avg: {
    key: "cpu_avg",
    label: "Average CPU usage",
    short_label: "CPU avg.",
    scale: 1,
    suffix: "%",
    target: 200,
    smaller_is_better: true
  },

  cpu_med: {
    key: "cpu_med",
    label: "Median CPU usage",
    short_label: "CPU median",
    scale: 1,
    suffix: "%",
    target: 200,
    smaller_is_better: true
  },

  processing_time_avg: {
    key: "processing_time_avg",
    label: "Average processing",
    short_label: "Processing Avg",
    scale: 1,
    suffix: "ms",
    target: 25.0,
    smaller_is_better: true
  },
  processing_time_med: {
    key: "processing_time_med",
    label: "Median processing",
    short_label: "Processing Med",
    scale: 1,
    suffix: "ms",
    target: 25.0,
    smaller_is_better: true
  },
  processing_time_q95: {
    key: "processing_time_q95",
    label: "Processing Time @95%",
    short_label: "Processing q95",
    scale: 1,
    suffix: "ms",
    target: 25.0,
    smaller_is_better: true
  },
  processing_time_max: {
    key: "processing_time_max",
    label: "Max processing time",
    short_label: "Processing Max",
    scale: 1,
    suffix: "ms",
    target: 25.0,
    smaller_is_better: true
  }
};

// will be shown proeminently in the index page, and first for tuning exploration
const default_metric = "pcmd_mean";
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
const main_metrics = ["rmse_mean", "pcmd_mean", "area_mtf_mean", "snr_mean", "precision_mean"];
const dashboard_metrics = ["pcmd_mean"];

export {
  available_metrics,
  default_metric,
  main_metrics,
  summary_metrics,
  dashboard_metrics
};