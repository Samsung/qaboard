"""
QA-Board's auto-tuning configuration dialect.

Users write the `search_space` and `solver` sections of their optimization YAML in the
web UI, and those configs are saved alongside batches. The dialect is therefore a
user-facing contract, and this module is deliberately the only place that knows how to
read it -- the optimization engine underneath is an implementation detail we can swap
without touching a single user's config.

We learned that the hard way: the dialect used to *be* `skopt.Space.from_yaml()`, so
when scikit-optimize was archived (2024-02-28, never made numpy-2 compatible) the format
went down with the library. Now we own it.

The engine is currently Optuna, driven through its ask/tell API.
"""
from typing import Any, Dict, List


def _import_optuna():
  try:
    import optuna
  except ImportError as e:
    raise ImportError(
      "`qa optimize` needs Optuna, which is not installed.\n"
      "Install it with:\n"
      "    pip install 'qaboard[opt]'"
    ) from e
  return optuna


# `search_space` dimensions. The names are historical -- they match what users already
# have saved in their configs -- but they are ours now, not a third-party library's.
DIMENSION_KINDS = ('Integer', 'Real', 'Categorical')

# Keys that used to be forwarded as-is to `skopt.Optimizer`. They have no meaning for
# the current engine, so rather than silently ignoring them we tell users what to write.
LEGACY_SOLVER_KEYS = {
  'base_estimator':       "use `sampler: gp` for Gaussian processes, or `sampler: tpe`",
  'n_initial_points':     "renamed to `n_startup_trials`",
  'random_state':         "renamed to `seed`",
  'acq_func':             "acquisition functions are not configurable anymore; `sampler: gp` uses log-EI",
  'acq_funcstring':       "acquisition functions are not configurable anymore; `sampler: gp` uses log-EI",
  'acq_optimizer':        "not configurable anymore",
  'n_restarts_optimizer': "not configurable anymore",
  'n_jobs':               "use the `parallel_sampling` setting instead",
  'xi':                   "not configurable anymore",
  'kappa':                "not configurable anymore",
}

SAMPLERS = ('gp', 'tpe', 'random')


def parse_search_space(search_space: Any) -> Dict[str, Any]:
  """
  Read the `search_space` section of an optimization config, and return the parameters
  to optimize as a {name: distribution} mapping.

  Error messages are shown to users in the web UI, so they name what went wrong and where.
  """
  _import_optuna()  # for the friendly error message when it's missing
  from optuna.distributions import CategoricalDistribution, FloatDistribution, IntDistribution

  if not search_space:
    raise ValueError("ERROR: the configuration must provide a non-empty `search_space`.")
  if not isinstance(search_space, list):
    raise ValueError(
      "ERROR: `search_space` must be a list of dimensions, each written as "
      "`- Integer:`, `- Real:` or `- Categorical:`."
    )

  distributions: Dict[str, Any] = {}
  for index, dimension in enumerate(search_space):
    at = f"search_space[{index}]"
    if not isinstance(dimension, dict) or len(dimension) != 1:
      raise ValueError(
        f"ERROR: {at} must be a single-key mapping, one of: {', '.join(DIMENSION_KINDS)}."
      )
    kind, options = next(iter(dimension.items()))
    if kind not in DIMENSION_KINDS:
      raise ValueError(
        f"ERROR: {at} has unknown dimension type `{kind}`. Expected one of: {', '.join(DIMENSION_KINDS)}."
      )
    if not isinstance(options, dict):
      raise ValueError(f"ERROR: {at} (`{kind}`) must be a mapping with at least a `name`.")

    name = options.get('name')
    if not name:
      raise ValueError(f"ERROR: {at} (`{kind}`) is missing a `name`.")
    if name in distributions:
      raise ValueError(f"ERROR: `{name}` is defined more than once in the search space.")
    at = f"search_space[{index}] (`{name}`)"

    if kind == 'Categorical':
      categories = options.get('categories')
      if not categories:
        raise ValueError(f"ERROR: {at} is missing its `categories`.")
      if not isinstance(categories, list):
        raise ValueError(f"ERROR: {at} expects `categories` to be a list.")
      distributions[name] = CategoricalDistribution(categories)
      continue

    # Integer and Real are both bounded ranges
    if 'low' not in options or 'high' not in options:
      raise ValueError(f"ERROR: {at} needs both `low` and `high` bounds.")
    low, high = options['low'], options['high']
    if not isinstance(low, (int, float)) or not isinstance(high, (int, float)):
      raise ValueError(f"ERROR: {at} expects numbers for `low` and `high`.")
    if low >= high:
      raise ValueError(f"ERROR: {at} has `low` ({low}) >= `high` ({high}).")

    prior = options.get('prior', 'uniform')
    if prior not in ('uniform', 'log-uniform'):
      raise ValueError(
        f"ERROR: {at} has unknown `prior: {prior}`. Expected `uniform` or `log-uniform`."
      )
    log = prior == 'log-uniform'
    if log and low <= 0:
      raise ValueError(f"ERROR: {at} uses `prior: log-uniform`, so `low` ({low}) must be > 0.")

    if kind == 'Integer':
      distributions[name] = IntDistribution(int(low), int(high), log=log)
    else:
      distributions[name] = FloatDistribution(float(low), float(high), log=log)

  return distributions


def make_study(solver: Dict[str, Any]):
  """
  Read the `solver` section of an optimization config, and return the Optuna study that
  will drive the search. We always minimize: QA-Board's `objective` section already
  handles per-metric sign inversion via `smaller_is_better`.
  """
  optuna = _import_optuna()

  solver = {**solver}
  name = solver.pop('name', 'optuna')
  if name != 'optuna':
    raise ValueError(
      f"ERROR: unknown solver `name: {name}`. The only supported solver is `optuna`.\n"
      "       (scikit-optimize was archived upstream in 2024 and has been removed.)"
    )

  for key, hint in LEGACY_SOLVER_KEYS.items():
    if key in solver:
      raise ValueError(
        f"ERROR: `solver.{key}` was a scikit-optimize setting and is not supported anymore: {hint}.\n"
        "       See https://samsung.github.io/qaboard/docs/auto-optimization"
      )

  sampler_name = solver.pop('sampler', 'gp')
  if sampler_name not in SAMPLERS:
    raise ValueError(
      f"ERROR: unknown `solver.sampler: {sampler_name}`. Expected one of: {', '.join(SAMPLERS)}."
    )

  seed = solver.pop('seed', 42)
  n_startup_trials = solver.pop('n_startup_trials', 10)
  if solver:
    raise ValueError(
      f"ERROR: unknown solver settings: {', '.join(sorted(solver))}.\n"
      f"       Expected: sampler, n_startup_trials, seed."
    )

  if sampler_name == 'gp':
    # GPSampler only imports torch once it starts modelling, ie after `n_startup_trials`.
    # Each of those trials is a full batch run, so we check now rather than crash hours in.
    try:
      import torch
    except ImportError as e:
      raise ImportError(
        "`solver.sampler: gp` needs PyTorch, which is not installed.\n"
        "Install it with:\n"
        "    pip install 'qaboard[opt]'\n"
        "or use a sampler that does not need it:\n"
        "    solver:\n"
        "      sampler: tpe"
      ) from e
    sampler = optuna.samplers.GPSampler(seed=seed, n_startup_trials=n_startup_trials)
  elif sampler_name == 'tpe':
    sampler = optuna.samplers.TPESampler(seed=seed, n_startup_trials=n_startup_trials)
  else:
    sampler = optuna.samplers.RandomSampler(seed=seed)

  # QA-Board prints its own progress, we don't want Optuna's per-trial chatter
  optuna.logging.set_verbosity(optuna.logging.WARNING)
  return optuna.create_study(direction='minimize', sampler=sampler)
