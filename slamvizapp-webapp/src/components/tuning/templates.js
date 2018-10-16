const templates = {
  "none": "{}",
  "simple-combinations": JSON.stringify(
    {
      events_per_frame: [5e3, 10e3, 15e3, 20e3],
      smart_frame_on: [0, 1]
    },
    null,
    2
  ),
  "list-of-combinations": JSON.stringify(
    [
      {
        min_events_per_frame: 5e3,
        max_events_per_frame: 10e3
      },
      {
        min_events_per_frame: 15e3,
        max_events_per_frame: 20e3
      }
    ],
    null,
    2
  ),
  "function":
    `// you can write a javascript function that return your tuning search
let events_per_frame = [10e3, 20e3, 30e3];
let delta = 5e3;

return events_per_frame.map(e => ({
  min_events_per_frame: e,
  max_events_per_frame: e + delta,
  smart_frame_on: [true, false],
}));
`,
  "optimize": `
metric: rmse
# minimize: true
# aggregation: average
evaluations: 10

# you can fix some parameters
fixed:
  verbose: false

# Description of the search space
# Documentation:
#   https://github.com/scikit-optimize/scikit-optimize/blob/master/skopt/space/space.py
#   https://scikit-optimize.github.io/#skopt.Space
space:
  - Integer:
      name: max_events
      low: 1000
      high: 10000

  - Categorical:
      name: solver
      categories:
        - ceres
        - g2o

  - Real:
      name: threshold
      low: 0.0
      high: 1.0

  - Real:
      name: learning_rate
      low: 0.0000001
      high: 0.1
      prior: log-uniform
`,
};


export default templates;