const slam_metrics = {
  translation_rmse: {
    key:'translation_rmse',
    label: 'Translation RMSE',
    short_label: 'tRMSE',
    scale: 100,
    suffix: 'cm',
    threshold: 0.01,
    smaller_is_better: true,
  },

  translation_aape:{
    key:'translation_aape',
    label: 'Translation AAPE',
    short_label: 'tAAPE',
    scale: 100,
    suffix: 'cm',
    threshold: 0.01,
    smaller_is_better: true,
  },
  
  relative_translation_error:{
    key:'relative_translation_error',
    label: 'Relative Translation Error',
    short_label: 'tRTE',
    scale: 100,
    suffix: 'cm',
    threshold: 0.01,
    smaller_is_better: true,
  },


  translation_drift_pc:{
    key:'translation_drift_pc',
    label: 'Translation Relative Drift',
    short_label: 'tDrift',
    scale: 100,
    suffix: '%',
    threshold: 0.01,
    smaller_is_better: true,
  },

  translation_aape_when_good:{
    key:'translation_aape_when_good',
    label: 'Translation AAPE - when GOOD',
    short_label: 'tAAPE_good',
    scale: 100,	
    suffix: 'cm',
    threshold: 0.01,
    smaller_is_better: true,
  },

  rotation_mean:{
    key:'rotation_mean',
    label: 'Rotation Error',
    short_label: 'Rot Error',
    scale: 1,
    suffix: '°',
    threshold: 1.5,
    smaller_is_better: true,
  },

  rotation_mean_when_good:{
    key:'rotation_mean_when_good',
    label: 'Rotation Error - when GOOD',
    short_label: 'Rot Error_good',
    scale: 1,
    suffix: '°',
    threshold: 1.5,
    smaller_is_better: true,
  },

  frac_tracking_state_good:{
    key:'frac_tracking_state_good',
    label: 'Tracking is GOOD',
    short_label: 'Tracking',
    scale: 100,
    suffix: '%',
    threshold: 0.99,
    smaller_is_better: false,
  },

  time_pc_before_first_lost:{
    key:'time_pc_before_first_lost',
    label: 'Time before failure (self-reported)',
    short_label: 'Time before KO (self)',
    scale: 100,
    suffix: '%',
    threshold: .99,
    smaller_is_better: false,
  },
  
  time_pc_before_lost_gt:{
    key:'time_pc_before_lost_gt',
    label: 'Time before failure (vs ground-truth)',
    short_label: 'Time before KO (gt)',
    scale: 100,
    suffix: '%',
    threshold: .99,
    smaller_is_better: false,
  },
  
  cpu_usage_avg:{
    key:'cpu_usage_avg',
    label: 'Average CPU usage',
    short_label: 'CPU avg.',
    scale: 100,
    suffix: '%',
    threshold: 1.00,
    smaller_is_better: true,
  },

  cpu_usage_median:{
    key:'cpu_usage_median',
    label: 'Median CPU usage',
    short_label: 'CPU median',
    scale: 100,
    suffix: '%',
    threshold: 1.00,
    smaller_is_better: true,
  },

 };


// will be shown proeminently in the index page, and first for tuning exploration
const default_metric = 'translation_aape';
// will be shown in the summary histogramms of each commit
const summary_metrics = [
  'translation_aape', 'relative_translation_error', 'translation_drift_pc', 'translation_rmse',
  'rotation_mean',
  'translation_aape_when_good', 'rotation_mean_when_good',
  'frac_tracking_state_good', 'time_pc_before_first_lost', 'time_pc_before_lost_gt',
  'cpu_usage_median'
];
// will be shown in the table and 6dof output cards
const main_metrics = ['translation_aape', 'translation_rmse', 'rotation_mean', 'translation_drift_pc'];


export { slam_metrics, default_metric, main_metrics, summary_metrics };
