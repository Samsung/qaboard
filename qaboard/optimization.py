"""
QA-Board's auto-tuning configuration dialect, and the engine that runs it.

Users write their optimization YAML in the web UI (or a file for `qa optimize`), and those
configs are saved with their batches. The dialect is a user-facing contract, so this module
is deliberately the only place that knows how to read it: the optimization library underneath
is an implementation detail we can swap without touching anyone's config.

We learned that the hard way: the dialect used to *be* `skopt.Space.from_yaml()`, and
scikit-optimize stopped being maintained (its repository was archived in 2024, a fork's last
release was in June 2024).

The engine is Optuna, driven through its ask/tell API. `run_optimization` holds the search
loop, free of any QA-Board reporting so it can be tested on synthetic objectives; `qa optimize`
plugs the batch runs and the database updates in as callbacks.

Everything the web app needs to explain an optimization (search space, objective, importances,
Pareto front...) is sent as the batch's `data`: see `describe_optimization` and `study_summary`.
The web app reads it in webapp/src/components/tuning/optimization.js.
"""
import os
import re
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


DEFAULT_SEED = int(os.environ.get('QA_SEED', 101))


def _import_optuna():
  try:
    import optuna
  except ImportError as e:
    import sys
    if sys.version_info < (3, 9):
      raise ImportError("`qa optimize` needs Python 3.9 or newer, for Optuna.") from e
    raise ImportError(
      "`qa optimize` needs Optuna, which is not installed. Install it with:\n"
      "    pip install --upgrade qaboard"
    ) from e
  return optuna


# `search_space` dimensions. The names are historical -- they match what users already
# have saved in their configs -- but they are ours now, not a third-party library's.
DIMENSION_KINDS = ('Integer', 'Real', 'Categorical')

# Keys that used to be forwarded as-is to scikit-optimize's `Optimizer`. They have no meaning
# for the current engine: rather than silently ignoring them we tell users what to write.
LEGACY_SOLVER_KEYS = {
  'base_estimator':       "choose a `sampler` instead: `gp` (Gaussian processes), `tpe` or `random`",
  'n_initial_points':     "it is called `n_startup_trials` now",
  'random_state':         "it is called `seed` now",
  'acq_func':             "the acquisition function is not configurable anymore",
  'acq_funcstring':       "the acquisition function is not configurable anymore",
  'acq_optimizer':        "it is not configurable anymore",
  'acq_func_kwargs':      "it is not configurable anymore",
  'acq_optimizer_kwargs': "it is not configurable anymore",
  'n_restarts_optimizer': "it is not configurable anymore",
  'n_jobs':               "use `parallel_sampling` to evaluate several parameters at once",
  'xi':                   "it is not configurable anymore",
  'kappa':                "it is not configurable anymore",
}

# `auto` picks Gaussian processes when PyTorch is installed, TPE otherwise
SAMPLERS = ('auto', 'gp', 'tpe', 'random')
SAMPLER_LABELS = {
  'gp': 'Gaussian processes',
  'tpe': 'TPE',
  'random': 'random search',
}

DOCS = "https://samsung.github.io/qaboard/docs/auto-optimization"


def parse_search_space(search_space: Any) -> Dict[str, Any]:
  """
  Read the `search_space` section of an optimization config, and return the parameters
  to optimize as a {name: distribution} mapping.

  Error messages are shown to users in the web UI, so they name what went wrong and where.
  The web app checks the same rules as users type: webapp/src/components/tuning/optimize_config.js
  """
  _import_optuna()  # for the friendly error message when it's missing
  from optuna.distributions import CategoricalDistribution, FloatDistribution, IntDistribution

  if not search_space:
    raise ValueError("The configuration must list the parameters to tune in `search_space`.")
  if not isinstance(search_space, list):
    raise ValueError(
      "`search_space` must be a list of parameters, each written as "
      "`- Integer:`, `- Real:` or `- Categorical:`."
    )

  distributions: Dict[str, Any] = {}
  for index, dimension in enumerate(search_space):
    at = f"search_space[{index}]"
    if not isinstance(dimension, dict) or len(dimension) != 1:
      raise ValueError(f"{at} must be one of: {', '.join(f'`{k}:`' for k in DIMENSION_KINDS)}.")
    kind, options = next(iter(dimension.items()))
    if kind not in DIMENSION_KINDS:
      raise ValueError(f"{at} has an unknown type `{kind}`. Expected one of: {', '.join(DIMENSION_KINDS)}.")
    if not isinstance(options, dict):
      raise ValueError(f"{at} (`{kind}`) needs at least a `name`.")

    name = options.get('name')
    if not name or not isinstance(name, str):
      raise ValueError(f"{at} (`{kind}`) needs a `name`.")
    if name in distributions:
      raise ValueError(f"`{name}` is in the search space twice.")
    at = f"`{name}`"

    if kind == 'Categorical':
      categories = options.get('categories')
      if not isinstance(categories, list) or len(categories) == 0:
        raise ValueError(f"{at} needs a list of `categories`.")
      if len(categories) < 2:
        raise ValueError(f"{at} has a single category: set it in `preset_params` instead of tuning it.")
      keys = [repr(c) for c in categories]
      if len(set(keys)) != len(keys):
        raise ValueError(f"{at} lists the same category twice: {categories}")
      for category in categories:
        if not (category is None or isinstance(category, (bool, int, float, str))):
          raise ValueError(f"{at}'s categories must be numbers, strings or booleans, not {category!r}")
      distributions[name] = CategoricalDistribution(categories)
      continue

    # Integer and Real are both bounded ranges
    if 'low' not in options or 'high' not in options:
      raise ValueError(f"{at} needs both `low` and `high` bounds.")
    low, high = options['low'], options['high']
    if isinstance(low, bool) or isinstance(high, bool) or not isinstance(low, (int, float)) or not isinstance(high, (int, float)):
      raise ValueError(f"{at} needs numbers for `low` and `high`.")
    if low >= high:
      raise ValueError(f"{at}'s `low` ({low}) must be smaller than its `high` ({high}).")
    if kind == 'Integer' and (low != int(low) or high != int(high)):
      raise ValueError(f"{at} is an Integer: its bounds must be whole numbers, not {low} and {high}.")

    prior = options.get('prior', 'uniform')
    if prior not in ('uniform', 'log-uniform'):
      raise ValueError(f"{at} has an unknown `prior: {prior}`. Expected `uniform` or `log-uniform`.")
    log = prior == 'log-uniform'
    if log and low <= 0:
      raise ValueError(f"{at} uses `prior: log-uniform`, so its `low` ({low}) must be above 0.")

    if kind == 'Integer':
      distributions[name] = IntDistribution(int(low), int(high), log=log)
    else:
      distributions[name] = FloatDistribution(float(low), float(high), log=log)

  return distributions


def describe_search_space(distributions: Dict[str, Any]) -> List[Dict[str, Any]]:
  """The search space as plain JSON, for the web app (ranges, where the best value sits...)"""
  from optuna.distributions import CategoricalDistribution, IntDistribution
  described = []
  for name, distribution in distributions.items():
    if isinstance(distribution, CategoricalDistribution):
      described.append({"name": name, "type": "categorical", "choices": list(distribution.choices)})
    else:
      described.append({
        "name": name,
        "type": "integer" if isinstance(distribution, IntDistribution) else "real",
        "low": distribution.low,
        "high": distribution.high,
        "log": distribution.log,
      })
  return described


def objective_metrics(config_objective: Any) -> List[str]:
  return [m for m in (config_objective or {}).keys() if m != 'target']


# Each metric of the objective says which way is better: `ap_small: max`, or `ap_small: {goal: max, weight: 2}`.
# Without it, qa optimize asks the code that computes the metric (qaboard.Metric, define_metric), then the metrics file.
GOALS = {'max': 'max', 'maximize': 'max', 'min': 'min', 'minimize': 'min'}
# The `loss` of one run and how runs' losses `reduce`, see make_loss and make_reduce in qaboard/optimize.py
LOSSES = r'(square_)?(relu_)?(identity|shift|relative)'
REDUCES = r'sum|relu|l\d'


def _is_number(value: Any) -> bool:
  return not isinstance(value, bool) and isinstance(value, (int, float))


def parse_objective_metric(metric: str, options: Any) -> Dict[str, Any]:
  """
  One metric of the objective, with its defaults: {goal, weight, loss, reduce, margin, target}.
  `goal` is 'max', 'min', or None when the configuration doesn't say.
  """
  if options is None:
    options = {}
  elif isinstance(options, str):
    options = {'goal': options}
  if not isinstance(options, dict):
    raise ValueError(f"`objective.{metric}` must be `max`, `min`, or a mapping (e.g. `goal: max` and `weight: 2`), not `{options}`.")
  goal = options.get('goal')
  if goal is not None and str(goal).lower() not in GOALS:
    raise ValueError(f"`objective.{metric}` says `{goal}`: expected `max` (higher is better) or `min` (lower is better).")
  weight = options.get('weight', 1)
  if not _is_number(weight) or weight <= 0:
    raise ValueError(f"`objective.{metric}.weight` must be a positive number, not `{weight}`.")
  loss = options.get('loss', 'identity')
  if not re.fullmatch(LOSSES, str(loss)):
    raise ValueError(f"`objective.{metric}.loss` is `{loss}`, expected identity, shift or relative, optionally as relu_X, square_X or square_relu_X.")
  reduce = options.get('reduce', 'sum')
  if not re.fullmatch(REDUCES, str(reduce)):
    raise ValueError(f"`objective.{metric}.reduce` is `{reduce}`, expected sum, relu, l1 or l2.")
  margin = options.get('margin', 0.0)
  if not _is_number(margin):
    raise ValueError(f"`objective.{metric}.margin` must be a number, not `{margin}`.")
  target = options.get('target')
  if target is not None and not _is_number(target):
    raise ValueError(f"`objective.{metric}.target` must be a number, not `{target}`.")
  return {
    'goal': GOALS[str(goal).lower()] if goal is not None else None,
    'weight': weight,
    'loss': str(loss),
    'reduce': str(reduce),
    'margin': margin,
    'target': target,
  }


def parse_objective(config_objective: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
  """The objective's metrics, each with its settings (parse_objective_metric)"""
  return {metric: parse_objective_metric(metric, config_objective[metric]) for metric in objective_metrics(config_objective)}


def parse_options(optim_config: Dict[str, Any]) -> Dict[str, Any]:
  """
  Read and validate the top-level settings of an optimization config.
  Like the search-space errors, these messages are shown to users in the web UI.
  """
  if not isinstance(optim_config, dict):
    raise ValueError("The configuration must be a YAML mapping, with at least `evaluations`, `objective` and `search_space`.")
  objective = optim_config.get('objective')
  if not objective or not isinstance(objective, dict):
    raise ValueError("The configuration must say what to optimize in `objective`, from your project's metrics.")
  metrics = objective_metrics(objective)
  if not metrics:
    raise ValueError("The `objective` must list at least one metric.")
  if "evaluations" not in optim_config:
    raise ValueError("The configuration must set how many parameters to try, with `evaluations`.")

  evaluations = optim_config['evaluations']
  if isinstance(evaluations, bool) or not isinstance(evaluations, int) or evaluations <= 0:
    raise ValueError(f"`evaluations` must be a positive whole number, not `{evaluations}`.")

  parallel_sampling = optim_config.get('parallel_sampling', 1)
  if isinstance(parallel_sampling, bool) or not isinstance(parallel_sampling, int) or parallel_sampling < 1:
    raise ValueError(f"`parallel_sampling` must be a positive whole number, not `{parallel_sampling}`.")

  # `early_stopping: {patience: 15}`, or just `early_stopping: 15`
  early_stopping = optim_config.get('early_stopping')
  if isinstance(early_stopping, dict):
    unknown = set(early_stopping) - {'patience'}
    if unknown:
      raise ValueError(f"Unknown `early_stopping` settings: {', '.join(sorted(unknown))}. Expected: `patience`.")
    patience = early_stopping.get('patience')
  else:
    patience = early_stopping
  if patience is not None and (isinstance(patience, bool) or not isinstance(patience, int) or patience <= 0):
    raise ValueError(f"`early_stopping.patience` must be a positive whole number, not `{patience}`.")

  pareto = optim_config.get('pareto', False)
  if not isinstance(pareto, bool):
    raise ValueError(f"`pareto` must be `true` or `false`, not `{pareto}`.")
  if pareto and len(metrics) < 2:
    raise ValueError("`pareto: true` needs at least two metrics in the `objective`: with one, there is no trade-off to explore.")
  if pareto and len(metrics) > 3:
    raise ValueError("`pareto: true` supports at most three metrics in the `objective`.")

  resume = optim_config.get('resume', True)
  if not isinstance(resume, bool):
    raise ValueError(f"`resume` must be `true` or `false`, not `{resume}`.")

  return {
    "objective": parse_objective(objective),
    "evaluations": evaluations,
    "parallel_sampling": parallel_sampling,
    "patience": patience,
    "pareto": pareto,
    "objective_metrics": metrics,
    "resume": resume,
  }


def has_torch() -> bool:
  try:
    import torch  # noqa: F401
    return True
  except ImportError:
    return False


def parse_solver(solver: Any) -> Dict[str, Any]:
  """Read and validate the `solver` section of an optimization config: {sampler, seed, n_startup_trials}"""
  if solver is None:
    solver = {}
  if not isinstance(solver, dict):
    raise ValueError(f"`solver` must be a mapping, e.g. `sampler: tpe`, not `{solver}`.")
  solver = {**solver}

  name = solver.pop('name', 'optuna')
  if name != 'optuna':
    raise ValueError(
      f"`solver.name: {name}` is not supported anymore: QA-Board tunes parameters with Optuna. "
      f"Remove `name`, and see {DOCS} for the solver's settings."
    )
  for key, hint in LEGACY_SOLVER_KEYS.items():
    if key in solver:
      raise ValueError(f"`solver.{key}` was a scikit-optimize setting: {hint}. See {DOCS}")

  sampler_name = solver.pop('sampler', 'auto')
  if sampler_name not in SAMPLERS:
    raise ValueError(f"Unknown `solver.sampler: {sampler_name}`. Expected one of: {', '.join(SAMPLERS)}.")
  seed = solver.pop('seed', DEFAULT_SEED)
  if isinstance(seed, bool) or not isinstance(seed, int):
    raise ValueError(f"`solver.seed` must be a whole number, not `{seed}`.")
  n_startup_trials = solver.pop('n_startup_trials', 10)
  if isinstance(n_startup_trials, bool) or not isinstance(n_startup_trials, int) or n_startup_trials < 1:
    raise ValueError(f"`solver.n_startup_trials` must be a positive whole number, not `{n_startup_trials}`.")
  if solver:
    raise ValueError(f"Unknown solver settings: {', '.join(sorted(solver))}. Expected: sampler, n_startup_trials, seed.")
  return {"sampler": sampler_name, "seed": seed, "n_startup_trials": n_startup_trials}


def check_config(optim_config: Any) -> List[str]:
  """
  What's wrong with an optimization config, as messages for users: an empty list if nothing.
  QA-Board's server checks configs with it before starting `qa optimize`.
  """
  errors = []
  checks = [
    lambda: parse_options(optim_config),
    lambda: parse_search_space(optim_config.get('search_space')),
    lambda: parse_solver(optim_config.get('solver')),
  ]
  for check in checks:
    try:
      check()
    except ValueError as e:
      errors.append(str(e))
    except (AttributeError, TypeError):
      pass  # parse_options already complained the config isn't a mapping
    if errors and not isinstance(optim_config, dict):
      break
  if isinstance(optim_config, dict) and not errors:
    preset = optim_config.get('preset_params') or {}
    tuned = [d[k].get('name') for d in optim_config['search_space'] for k in d]
    both = [name for name in tuned if name in preset]
    if both:
      errors.append(f"{', '.join(f'`{n}`' for n in both)} is both in `preset_params` and in the `search_space`: keep it in one of them.")
  return errors


def make_sampler(solver: Optional[Dict[str, Any]], parallel_sampling: int = 1):
  """
  Read the `solver` section of an optimization config.
  Returns the Optuna sampler, and the name of the sampler it chose ("gp", "tpe" or "random").
  """
  optuna = _import_optuna()
  settings = parse_solver(solver)
  sampler_name, seed, n_startup_trials = settings['sampler'], settings['seed'], settings['n_startup_trials']

  if sampler_name == 'auto':
    sampler_name = 'gp' if has_torch() else 'tpe'
  if sampler_name == 'gp':
    # GPSampler imports PyTorch only once it starts modelling, after `n_startup_trials`. Each of those
    # trials is a full batch of runs, so we check now rather than fail hours in.
    if not has_torch():
      raise ImportError(
        "`solver.sampler: gp` needs PyTorch, which is not installed. "
        "Install it with `pip install torch`, or use `sampler: tpe` (or `auto`, which picks TPE without PyTorch)."
      )
    return optuna.samplers.GPSampler(seed=seed, n_startup_trials=n_startup_trials), 'gp'
  if sampler_name == 'tpe':
    # multivariate: models the parameters together, which matters with few evaluations.
    # constant_liar: parameters evaluated at the same time don't all land on the same spot.
    return optuna.samplers.TPESampler(
      seed=seed,
      n_startup_trials=n_startup_trials,
      multivariate=True,
      constant_liar=parallel_sampling > 1,
    ), 'tpe'
  return optuna.samplers.RandomSampler(seed=seed), 'random'


def sampler_name(study) -> str:
  return {'GPSampler': 'gp', 'TPESampler': 'tpe', 'RandomSampler': 'random'}.get(type(study.sampler).__name__, type(study.sampler).__name__)


def make_storage(path: Path):
  """
  Where the study is saved, to resume interrupted optimizations. Batch directories are usually on
  shared storage: Optuna's journal file is designed for NFS, where SQLite's locks are unreliable.
  """
  _import_optuna()
  from optuna.storages import JournalStorage
  from optuna.storages.journal import JournalFileBackend
  return JournalStorage(JournalFileBackend(str(path)))


def make_study(solver: Optional[Dict[str, Any]], storage=None, study_name: str = 'qaboard',
               n_objectives: int = 1, parallel_sampling: int = 1):
  """
  The Optuna study that drives the search. It always minimizes: QA-Board's `objective` section
  already flips the sign of metrics where bigger is better.

  With a `storage` (see `make_storage`), creating the study again later resumes with its past trials.
  """
  optuna = _import_optuna()
  sampler, _ = make_sampler(solver, parallel_sampling)
  # QA-Board prints its own progress, we don't want Optuna's per-trial chatter
  optuna.logging.set_verbosity(optuna.logging.WARNING)
  import warnings
  warnings.filterwarnings('ignore', category=optuna.exceptions.ExperimentalWarning)
  return optuna.create_study(
    directions=['minimize'] * n_objectives,
    sampler=sampler,
    storage=storage,
    study_name=study_name,
    load_if_exists=storage is not None,
  )


def check_resumable(study, signature: Dict[str, Any]) -> Optional[str]:
  """
  Whether a saved study can go on with this configuration. Changing the search space is fine:
  widening a range and continuing is a normal way to work. Changing the objective is not:
  past values would mean something else. Returns why it can't resume, or None.
  The signature is saved in the study the first time.
  """
  saved = study.user_attrs.get('qaboard')
  if saved is None:
    study.set_user_attr('qaboard', signature)
    return None
  if saved.get('objective') != signature.get('objective') or saved.get('pareto') != signature.get('pareto'):
    return (
      "The `objective` changed since this experiment started, so its past evaluations can't be compared with new ones. "
      "Start over with `resume: false`, or use a new batch label."
    )
  if saved != signature:
    study.set_user_attr('qaboard', signature)
  return None


def run_optimization(
  study,
  distributions: Dict[str, Any],
  objective: Callable[[Dict[str, Any], int], Optional[Dict[str, float]]],
  evaluations: int,
  parallel_sampling: int = 1,
  patience: Optional[int] = None,
  metric_names: Optional[List[str]] = None,
  on_trial: Optional[Callable] = None,
  log: Callable[[str], None] = lambda message: None,
) -> Dict[str, Any]:
  """
  The search loop. Runs `objective(params, trial_number)` until `evaluations` trials exist in the
  study, with up to `parallel_sampling` evaluations at once. Scheduling is completion-driven: a new
  evaluation starts the moment one finishes, so a slow one never holds the other slots.

  - `objective` returns the loss of each objective metric as {metric: value}, or None if the
    evaluation failed. Failed trials count toward the budget, and are not used by the sampler.
  - `metric_names` with several entries is Pareto mode: each metric is its own objective, and the
    study keeps the front of best trade-offs. Otherwise the losses are summed.
  - `patience` stops after that many evaluations in a row without improvement: a better summed
    loss, or in Pareto mode a change of the front.
  - `on_trial(trial_number, params, losses, loss, is_best)` reports each finished trial, under the
    loop's lock, **in trial order**: a trial that ends before an earlier one waits for it. QA-Board's
    server relies on it, it cleans up iterations up to the one reported. `is_best` means the summed
    loss is the best reported so far, in both modes.

  The budget counts this run's evaluations and every finished trial already in the study, so a
  resumed study continues where it left off. Trials left running by a crashed run are ignored.
  """
  from optuna.trial import TrialState
  pareto = metric_names is not None and len(metric_names) > 1
  finished_states = (TrialState.COMPLETE, TrialState.FAIL, TrialState.PRUNED)

  lock = threading.Lock()
  stop = threading.Event()
  state: Dict[str, Any] = {
    'in_flight': 0, 'finished': 0, 'completed': 0, 'failed': 0,
    'best': None, 'since_improvement': 0, 'front': set(),
    'next_report': None, 'unreported': {},
  }

  # A resumed study starts with history: rebuild the best value and the early-stopping count
  for t in sorted(study.trials, key=lambda t: t.number):
    if t.state not in finished_states:
      continue
    state['finished'] += 1
    if t.state != TrialState.COMPLETE:
      continue
    loss = sum(t.values)
    if state['best'] is None or loss < state['best']:
      state['best'] = loss
      state['since_improvement'] = 0
    else:
      state['since_improvement'] += 1
  if pareto:
    state['front'] = {t.number for t in study.best_trials}
    state['since_improvement'] = 0

  def report(number, params, losses):
    """Tells nothing to the study: updates the best and early stopping, and calls on_trial. Under the lock."""
    if losses is None:
      loss, is_best, improved = None, False, False
    else:
      loss = sum(losses.values())
      previous_best = state['best']
      is_best = previous_best is None or loss <= previous_best
      if previous_best is None or loss < previous_best:
        state['best'] = loss
      if pareto:
        front = {t.number for t in study.best_trials}
        improved = front != state['front']
        state['front'] = front
      else:
        improved = previous_best is None or loss < previous_best
    if losses is not None:
      state['since_improvement'] = 0 if improved else state['since_improvement'] + 1
    if patience is not None and state['since_improvement'] >= patience and not stop.is_set():
      log(f"Stopping early: {patience} evaluations in a row without improvement.")
      stop.set()
    if on_trial:
      on_trial(number, params, losses, loss, is_best)

  def run_one() -> bool:
    with lock:
      if stop.is_set() or state['finished'] + state['in_flight'] >= evaluations:
        return False
      trial = study.ask(distributions)
      params = dict(trial.params)
      if state['next_report'] is None:
        state['next_report'] = trial.number
      state['in_flight'] += 1
    try:
      losses = objective(params, trial.number)
    except BaseException:
      with lock:
        state['in_flight'] -= 1
        stop.set()  # the other workers finish their evaluation and stop
      raise
    with lock:
      state['in_flight'] -= 1
      state['finished'] += 1
      if losses is None or any(not math.isfinite(v) for v in losses.values()):
        if losses is not None:
          log(f"Iteration {trial.number + 1}: the objective is not a finite number ({losses}), counted as failed.")
          losses = None
        study.tell(trial, state=TrialState.FAIL)
        state['failed'] += 1
      else:
        study.tell(trial, [losses[m] for m in (metric_names or [])] if pareto else sum(losses.values()))
        state['completed'] += 1
      # report in trial order
      state['unreported'][trial.number] = (params, losses)
      while state['next_report'] in state['unreported']:
        number = state['next_report']
        report(number, *state['unreported'].pop(number))
        state['next_report'] += 1
    return True

  def worker():
    while run_one():
      pass

  if parallel_sampling == 1:
    worker()
  else:
    with ThreadPoolExecutor(max_workers=parallel_sampling) as executor:
      futures = [executor.submit(worker) for _ in range(parallel_sampling)]
      errors = []
      for future in futures:
        try:
          future.result()
        except BaseException as e:
          errors.append(e)
      if errors:
        raise errors[0]  # re-raise worker errors instead of swallowing them

  return {
    "early_stopped": stop.is_set(),
    "finished": state['finished'],
    "completed": state['completed'],
    "failed": state['failed'],
  }


def _plain(value):
  """JSON-friendly numbers (numpy floats, NaN...)"""
  if isinstance(value, bool) or value is None or isinstance(value, str):
    return value
  if isinstance(value, (int, float)) or hasattr(value, '__float__'):
    number = float(value)
    if not math.isfinite(number):
      return None
    return int(number) if isinstance(value, int) or (hasattr(value, 'dtype') and 'int' in str(value.dtype)) else number
  return value


def study_summary(study, metric_names: Optional[List[str]] = None) -> Dict[str, Any]:
  """
  What the web app shows about the search, as JSON-friendly data for the batch:
  - `importances`: how much each parameter explains the (summed) loss, from 0 to 1. Only once
    enough evaluations finished for it to mean something.
  - `pareto_front` in Pareto mode: the best trade-offs, as iteration numbers (1-based, like the batch's
    iterations), parameters and losses.
  """
  optuna = _import_optuna()
  from optuna.trial import TrialState
  completed = [t for t in study.trials if t.state == TrialState.COMPLETE]
  summary: Dict[str, Any] = {
    "evaluations_completed": len(completed),
    "evaluations_failed": sum(1 for t in study.trials if t.state == TrialState.FAIL),
  }
  pareto = metric_names is not None and len(metric_names) > 1

  # Importances need a few evaluations, and at least 2 parameters to compare
  n_params = len({name for t in completed for name in t.params})
  if len(completed) >= 8 and n_params >= 2:
    try:
      import warnings
      with warnings.catch_warnings():
        # it warns that it explains *low* values: the losses are minimized, that's what we want
        warnings.simplefilter('ignore')
        importances = optuna.importance.get_param_importances(study, target=lambda t: sum(t.values))
      summary["importances"] = {name: round(float(value), 4) for name, value in importances.items()}
    except Exception:
      pass  # e.g. all the losses are equal

  if pareto:
    assert metric_names is not None  # implied by `pareto`, spelled out for type checkers
    summary["pareto_front"] = [
      {
        "iteration": t.number + 1,
        "params": {k: _plain(v) for k, v in t.params.items()},
        "losses": {m: _plain(v) for m, v in zip(metric_names, t.values)},
      }
      for t in sorted(study.best_trials, key=lambda t: t.number)
    ]
  return summary
