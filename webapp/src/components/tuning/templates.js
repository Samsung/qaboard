const templates = {
  "no tuning": "",
  "none": "{}",
  "simple-combinations": JSON.stringify(
    {
      "block.register_en": [0, 1],
      "some_parameter_str": ["a", "b"],
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
  "1x2 matrix": JSON.stringify(
    {
      "block.register_1x2_matrix": [[0, 0], [1, 1]],
    },
    null,
    2
  ),
  "function":
    `// you can write a javascript function that return your tuning search

// ========================================= //
// Example A: test 10 values from 0 to 100
samples = 10;
scale = 10;


// 1. Using Iterators, return a tuning set
range = [...Array(samples).keys()]
return {
  "my_block|parameter_enable": 1,
  "my_block|parameter": range.map(i => scale * i),
}

// 2. Using Iterators, return a list of tuning sets
return range.map(i => ({
  "my_block|parameter": scale * i,
  "my_block|parameter_enable": 1,
}))

// 3. Using for loops
search = []
for (var i = 0; i <= 10; i++) {
  search.push({
    "my_block|parameter": scale * i,
    "my_block|parameter_enable": 1,
  })
}
return search



// ========================================= //
// Example A: test 10 values from 0 to 100
//            for a specific matrix value
return {
  "my_block|parameter_enable": 1,
  "my_block|parameter": range.map( i => [0, 0, 0, i * scale, 0])	
}

`,
  optimize: (config, metrics) => {
    return `# We will call the objective function that many times
evaluations: 50

# You can configure the the solver:
# https://scikit-optimize.github.io/stable/modules/generated/skopt.optimizer.Optimizer.html#skopt.optimizer.Optimizer
# solver:
#   base_estimator: GP
#   n_initial_points: 10
#   acq_funcstring: gp_hedge
#   # etc


# You can optimize objective functions of the form:
#
#  argmin        ∑     ɛ * weight * reduce(   ⋃     loss(metric, target) ) / nb_outputs
#  params     metrics                      outputs
#
# The example objective below is just the mean ${metrics.default_metric}.



# Some metrics need to be maximized, not minimized.
# This is handled automatically via each metrics's "smaller_is_better" configuration .
#     ɛ = 1 if smaller_is_better else -1


objective:
  ${metrics.default_metric}:
    weight: 1
    reduce: sum
    #     | l1
    #     | l2
    #     | relu   # => relu(sum)
    # 
    #
    loss: identity #  (error, target) => ɛ * error
    #   | shift    #  (error, target) => ɛ * error-target
    #   | relative #  (error, target) => ɛ * error-target / target
    #   | relu_X   #  (error, target) => relu(X(error, target))  eg relu_identity, relu_shift, relu_relative
    #   | square_X #  (error, target) => X(error, target) ^2     eg square_relative, square_relu_relative

  # ${(metrics.main_metrics.length > 0 && metrics.main_metrics[1]) || 'metric2'}:
  #   ...
  #   ...

  # target:
  #   # The target metric value used in the loss function can be chosen
  #   # either, by default, using the target defined in your metrics configuration
  #   # (Refer to https://samsung.github.io/qaboard/docs/computing-quantitative-metrics)
  #   # eg ${metrics.default_metric && metrics.available_metrics[metrics.default_metric] && metrics.available_metrics[metrics.default_metric].target} for ${metrics.default_metric}
  #   # Or from a specific git revision: 
  #   branch: ${config.project.reference_branch}  # a git branch/tag
  #   id: some_commit_id                 # a git commit id
  #   # Look for reference outputs in a batch called
  #   batch: default

# In addition to the auto-tuning, you can set tuning parameters to fixed values
# preset_params:
#   key: value

search_space:
  # Below are some examples.
  # More info at https://scikit-optimize.github.io/stable/modules/classes.html#module-skopt.space.space
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