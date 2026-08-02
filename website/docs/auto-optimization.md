---
id: auto-optimization
sidebar_label: Auto-Opt
title: Auto-Optimization
---


### `qa optimize`
> **EXPERIMENTAL**: This feature is experimental and the API is subject to change at any time.

QA-Board can search for the parameters that minimize your [metrics](computing-quantitative-metrics), using black-box optimization. You can start a run from the web UI ("Tuning" > "Automated tuning"), or from the CLI.

You need the optimization extra, which you can install with
```bash
pip install 'qaboard[opt]'
```

```bash
qa optimize --config-file optimize.yaml --batch my-batch
qa optimize --help
```

## Configuration

The configuration is a YAML file — the same one you edit in the web UI.

```yaml
# We will call the objective function that many times
evaluations: 50
# How many parameter sets to evaluate at once
parallel_sampling: 1

solver:
  sampler: gp          # gp (gaussian processes) | tpe | random
  n_startup_trials: 10 # random exploration before the sampler kicks in
  seed: 42

objective:
  my_metric:
    weight: 1
    reduce: sum
    loss: identity

# In addition to the auto-tuning, you can set tuning parameters to fixed values
preset_params:
  my_block|debug: false

search_space:
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
```

### `search_space`

A list of the parameters to optimize. Each is one of:

| Type | Options |
|:--|:--|
| `Integer` | `name`, `low`, `high`, optional `prior` |
| `Real` | `name`, `low`, `high`, optional `prior` |
| `Categorical` | `name`, `categories` |

`prior` is either `uniform` (default) or `log-uniform`. Use `log-uniform` for parameters that span orders of magnitude, like learning rates — it requires `low > 0`.

Parameters are sent to your runs like any other [tuning parameter](tuning-from-the-webapp).

### `solver`

| Setting | Default | Description |
|:--|:--|:--|
| `sampler` | `gp` | `gp` for bayesian optimization with gaussian processes, `tpe` for tree-structured Parzen estimators (cheaper in high dimensions), `random` for a random search baseline |
| `n_startup_trials` | `10` | Random evaluations before the sampler starts modelling the objective |
| `seed` | `42` | For reproducible runs |

### `objective`

The objective is minimized, and has the form:

```
argmin        ∑     ɛ * weight * reduce(   ⋃     loss(metric, target) ) / nb_outputs
params     metrics                      outputs
```

Metrics that need to be maximized are handled automatically via each metric's `smaller_is_better` configuration (`ɛ = 1 if smaller_is_better else -1`).

- `reduce`: `sum` (default), `l1`, `l2`, or `relu`
- `loss`: `identity` (default), `shift`, `relative`, `relu_X`, or `square_X`
- `target`: which reference values the loss compares against — by default the targets from your metrics configuration, or the results of a given `branch`/`id` and `batch`.

## Under the hood

The solver is [Optuna](https://optuna.org/), driven through its ask/tell API. QA-Board owns the configuration format above, so the solver can be changed without breaking your saved configs.

> Before 2026 the solver was [scikit-optimize](https://github.com/scikit-optimize/scikit-optimize), which was archived upstream in 2024 and never became compatible with numpy 2. The `search_space` and `objective` sections are unchanged, but the `solver` section is not: `base_estimator` is now `sampler`, `n_initial_points` is now `n_startup_trials`, `random_state` is now `seed`, and the acquisition-function settings (`acq_func`, `acq_funcstring`...) are gone. `qa optimize` will tell you if it finds an old setting.
