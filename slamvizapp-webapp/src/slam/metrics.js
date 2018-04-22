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

  frac_tracking_state_good:{
    key:'frac_tracking_state_good',
    label: 'Tracking is GOOD',
    short_label: 'Tracking',
    scale: 100,
    suffix: '%',
    threshold: 0.99,
    smaller_is_better: false,
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

  time_pc_before_first_lost:{
    key:'time_pc_before_first_lost',
    label: 'Time before first failure',
    short_label: 'Time before KO',
    scale: 100,
    suffix: '%',
    threshold: .99,
    smaller_is_better: false,
  },
  
  time_pc_before_lost_gt:{
    key:'time_pc_before_lost_gt',
    label: 'Time before failure - GT',
    short_label: 'Time before KO - GT',
    scale: 100,
    suffix: '%',
    threshold: .99,
    smaller_is_better: false,
  },
  
  time_before_lost_gt:{
    key:'time_before_lost_gt',
    label: 'Time before failure - GT',
    short_label: 'Time before failure - GT',
    scale: 0.001,
    suffix: 'k',
    threshold: 999999,
    smaller_is_better: false,
  },

 };


const default_metric = 'translation_aape';
const main_metrics = ['translation_aape', 'translation_rmse', 'rotation_mean', 'translation_drift_pc'];


export { slam_metrics, default_metric, main_metrics };
