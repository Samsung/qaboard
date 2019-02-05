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
  optimize: (config, metrics) => {
    return `# We will optimize the objective function within a budget of this many evaluations
# Currently, if your objective is cheap to evaluate, the optimization will be dominiated by call overheads.
evaluations: 50

# You can optimize objective functions of the form:
#
#  argmin        ∑     weight * reduce(   ⋃     loss(metric, target) ) / #outputs
#  params     metrics                   outputs
#


objective:
  ${metrics.default_metric}:
    weight: 1
    reduce: sum
    #     | l1
    #     | l2
    #     | relu   # => relu(sum)
    # 
    # Some metrics need to be maximized, not minimized.
    # This is defined via "smaller_is_better" in qatools' metrics configuration file.
    #     ɛ = 1 if smaller_is_better else -1
    #
    loss: identity # error, target => ɛ * error
    #   | shift    # error, target => ɛ * error-target
    #   | relative # error, target => ɛ * error-target / target
    #   | relu_X   # error, target => relu(X(error, target))  eg relu_identity, relu_shift, relu_relative
    #   | square_X # error, target => X(error, target) ^2     eg square_relative, square_relu_relative
    #
    #       if not smaller_is_better in qatools's configuration,
    #       we redefine the 'loss = -loss'

  # ${(metrics.main_metrics.length > 0 && metrics.main_metrics[1]) || 'metric2'}:
  #   ...
  #   ...

  # target:
    # The target metrics used in the loss function can be chosen...
    # # ...either (default) using the quality target you defined in the qatools config
    # eg ${metrics.default_metric && metrics.available_metrics[metrics.default_metric] && metrics.available_metrics[metrics.default_metric].target} for ${metrics.default_metric}
    # # Or from a specific git revision: 
    # branch: ${config.project.reference_branch}  # a git branch/tag
    # id: some_commit_id                 # a git commit id
    # # We look for reference outputs in a batch called
    # batch: default


# preset_params:
#   verbose: false
#   create_optionnal_plots: false

search_space:
  # Find some examples below. More info here:
  #   https://github.com/scikit-optimize/scikit-optimize/blob/master/skopt/space/space.py
  #   https://scikit-optimize.github.io/#skopt.Space
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
`
},
};


export default templates;