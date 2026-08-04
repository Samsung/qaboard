"""
QA-Board's auto-tuning configuration dialect, and the engine that runs it.

Users write their optimization YAML in the web UI, and those configs are saved
alongside batches. The dialect is therefore a user-facing contract, and this module is
deliberately the only place that knows how to read it -- the optimization engine
underneath is an implementation detail we can swap without touching a single user's
config.

We learned that the hard way: the dialect used to *be* `skopt.Space.from_yaml()`, so
when scikit-optimize was archived (2024-02-28, never made numpy-2 compatible) the format
went down with the library. Now we own it.

The engine is currently Optuna, driven through its ask/tell API. `run_optimization`
holds the whole search loop, free of any QA-Board reporting so it can be tested on a
synthetic objective; `qa optimize` plugs the batch-running and database updates in as
callbacks.
"""
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional


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


def parse_options(optim_config: Dict[str, Any]) -> Dict[str, Any]:
  """
  Read and validate the top-level settings of an optimization config.
  Like the search-space errors, these messages are shown to users in the web UI.
  """
  if "objective" not in optim_config:
    raise ValueError('ERROR: the configuration must provide an `objective`.')
  if "evaluations" not in optim_config:
    raise ValueError('ERROR: the configuration must provide an `evaluations` budget.')

  evaluations = optim_config['evaluations']
  if not isinstance(evaluations, int) or evaluations <= 0:
    raise ValueError(f"ERROR: `evaluations` must be a positive integer, got `{evaluations}`.")

  parallel_sampling = optim_config.get('parallel_sampling', 1)
  if not isinstance(parallel_sampling, int) or parallel_sampling < 1:
    raise ValueError(f"ERROR: `parallel_sampling` must be a positive integer, got `{parallel_sampling}`.")

  # `early_stopping: {patience: 15}`, or just `early_stopping: 15`
  early_stopping = optim_config.get('early_stopping')
  if isinstance(early_stopping, dict):
    unknown = set(early_stopping) - {'patience'}
    if unknown:
      raise ValueError(f"ERROR: unknown `early_stopping` settings: {', '.join(sorted(unknown))}. Expected: patience.")
    patience = early_stopping.get('patience')
  else:
    patience = early_stopping
  if patience is not None and (not isinstance(patience, int) or patience <= 0):
    raise ValueError(f"ERROR: `early_stopping.patience` must be a positive integer, got `{patience}`.")

  pareto = optim_config.get('pareto', False)
  if not isinstance(pareto, bool):
    raise ValueError(f"ERROR: `pareto` must be true or false, got `{pareto}`.")

  objective_metrics = [m for m in optim_config['objective'].keys() if m != 'target']
  if pareto and len(objective_metrics) < 2:
    raise ValueError(
      "ERROR: `pareto: true` needs at least two metrics in the `objective` -- "
      "with a single metric there is no trade-off to explore."
    )
  if pareto and len(objective_metrics) > 3:
    raise ValueError(
      "ERROR: `pareto: true` supports at most three objective metrics -- "
      "beyond that the Pareto front cannot be visualized meaningfully."
    )

  resume = optim_config.get('resume', True)
  if not isinstance(resume, bool):
    raise ValueError(f"ERROR: `resume` must be true or false, got `{resume}`.")

  return {
    "evaluations": evaluations,
    "parallel_sampling": parallel_sampling,
    "patience": patience,
    "pareto": pareto,
    "objective_metrics": objective_metrics,
    "resume": resume,
  }


def make_study(solver: Dict[str, Any], storage: Optional[str] = None,
               study_name: str = 'qaboard', n_objectives: int = 1):
  """
  Read the `solver` section of an optimization config, and return the Optuna study that
  will drive the search. We always minimize: QA-Board's `objective` section already
  handles per-metric sign inversion via `smaller_is_better`.

  With a `storage` URL (eg sqlite:///path/to/optuna.db), the study is persistent:
  creating it again later resumes with all its past trials.
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

  seed = solver.pop('seed', int(os.environ.get('QA_SEED', 42)))
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
  return optuna.create_study(
    directions=['minimize'] * n_objectives,
    sampler=sampler,
    storage=storage,
    study_name=study_name,
    load_if_exists=storage is not None,
  )


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
  The search loop. Runs `objective(params, trial_number)` until `evaluations` trials
  exist in the study, with up to `parallel_sampling` evaluations in flight at once.
  Scheduling is completion-driven: a new trial starts the moment one finishes, so a
  slow evaluation never blocks the other slots.

  - `objective` returns the per-metric loss components as {metric: value}, or None if
    the evaluation failed. Failed trials count toward the budget but not the search.
  - `metric_names` with more than one entry switches to Pareto mode: each component is
    its own objective and the study tracks the front. Otherwise components are summed.
  - `patience` stops the search after that many completed trials without improvement
    (a better value, or in Pareto mode a change of the front).
  - `on_trial(trial_number, params, components, scalar, is_best)` is called after each
    trial, serialized under the loop's lock -- it can safely touch shared state.

  The `evaluations` budget counts this run's in-flight trials plus every finished trial
  already in the study -- so a resumed study continues where it left off -- but ignores
  zombie RUNNING trials left by a crashed run.
  """
  from optuna.trial import TrialState
  pareto = metric_names is not None and len(metric_names) > 1
  finished_states = (TrialState.COMPLETE, TrialState.FAIL, TrialState.PRUNED)

  lock = threading.Lock()
  stop = threading.Event()
  state: Dict[str, Any] = {'in_flight': 0, 'finished': 0, 'best': None, 'since_improvement': 0, 'front': set()}

  # A resumed study starts with history: rebuild the early-stopping state from it
  for t in study.trials:
    if t.state not in finished_states:
      continue
    state['finished'] += 1
    if pareto or t.state != TrialState.COMPLETE:
      continue
    if state['best'] is None or t.value < state['best']:
      state['best'] = t.value
      state['since_improvement'] = 0
    else:
      state['since_improvement'] += 1
  if pareto:
    state['front'] = {t.number for t in study.best_trials}
    state['since_improvement'] = 0

  def run_one() -> bool:
    with lock:
      if stop.is_set() or state['finished'] + state['in_flight'] >= evaluations:
        return False
      trial = study.ask(distributions)
      params = dict(trial.params)
      state['in_flight'] += 1
    try:
      components = objective(params, trial.number)
    except Exception:
      with lock:
        state['in_flight'] -= 1
      raise
    with lock:
      state['in_flight'] -= 1
      state['finished'] += 1
      if components is None:
        study.tell(trial, state=TrialState.FAIL)
        scalar, is_best = None, False
      else:
        scalar = sum(components.values())
        if pareto:
          assert metric_names is not None  # implied by `pareto`, spelled out for type checkers
          study.tell(trial, [components[m] for m in metric_names])
          front = {t.number for t in study.best_trials}
          improved = front != state['front']
          state['front'] = front
          is_best = trial.number in front
        else:
          study.tell(trial, scalar)
          previous_best = state['best']
          is_best = previous_best is None or scalar <= previous_best
          improved = previous_best is None or scalar < previous_best
          if improved:
            state['best'] = scalar
        state['since_improvement'] = 0 if improved else state['since_improvement'] + 1
        if patience is not None and state['since_improvement'] >= patience and not stop.is_set():
          log(f"Early stopping: no improvement in the last {patience} evaluations.")
          stop.set()
      if on_trial:
        on_trial(trial.number, params, components, scalar, is_best)
    return True

  def worker():
    while run_one():
      pass

  if parallel_sampling == 1:
    worker()
  else:
    with ThreadPoolExecutor(max_workers=parallel_sampling) as executor:
      futures = [executor.submit(worker) for _ in range(parallel_sampling)]
      for future in futures:
        future.result()  # re-raise worker errors instead of swallowing them

  return {
    "early_stopped": stop.is_set(),
    "finished": state['finished'],
  }


def make_plots(study, dir, metric_names: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
  """
  Write interactive Plotly visualizations of the search into `dir`:
  - tuning-plots.json: the figures as Plotly JSON, rendered natively by the web UI
    (webapp/src/components/tuning/TuningExploration.js)
  - tuning-report.html: the same figures as a self-contained page, for sharing

  Returns the payload written to tuning-plots.json, or None if plotting was skipped.
  Every figure is optional: whatever cannot be drawn yet (eg importances before enough
  trials) is silently left out, and plotting problems never break the search.
  """
  import json
  try:
    import plotly.io as pio
    import optuna.visualization as vis
  except ImportError:
    return None
  optuna = _import_optuna()
  from optuna.trial import TrialState

  pareto = metric_names is not None and len(metric_names) > 1
  scalar = lambda t: sum(t.values)  # noqa: E731

  figures = []  # (key, title, figure)
  def add(key, title, plot, **kwargs):
    try:
      figures.append((key, title, plot(study, **kwargs)))
    except Exception:
      pass

  if pareto:
    assert metric_names is not None  # implied by `pareto`, spelled out for type checkers
    add('pareto_front', "Pareto front", vis.plot_pareto_front, target_names=metric_names)
    for index, metric in enumerate(metric_names):
      add(f'importances_{metric}', f"Parameter importances ({metric})", vis.plot_param_importances,
          target=lambda t, i=index: t.values[i], target_name=metric)
    add('slice', "Objective (sum) per parameter", vis.plot_slice, target=scalar, target_name="objective (sum)")
    add('parallel_coordinate', "Parallel coordinates", vis.plot_parallel_coordinate, target=scalar, target_name="objective (sum)")
  else:
    add('history', "Convergence", vis.plot_optimization_history)
    add('importances', "Parameter importances", vis.plot_param_importances)
    add('slice', "Objective per parameter", vis.plot_slice)
    add('parallel_coordinate', "Parallel coordinates", vis.plot_parallel_coordinate)
  add('timeline', "Timeline", vis.plot_timeline)

  importances = None
  if not pareto:
    try:
      importances = optuna.importance.get_param_importances(study)
    except Exception:
      pass

  trials = study.trials
  payload = {
    "version": 1,
    "n_trials": len(trials),
    "n_completed": sum(1 for t in trials if t.state == TrialState.COMPLETE),
    "n_failed": sum(1 for t in trials if t.state == TrialState.FAIL),
    "pareto": pareto,
    "metric_names": metric_names,
    "importances": importances,
    "plots": [
      {"key": key, "title": title, "figure": json.loads(pio.to_json(figure))}
      for key, title, figure in figures
    ],
  }

  if not dir.exists():
    dir.mkdir(parents=True, exist_ok=True)
  with (dir / 'tuning-plots.json').open('w') as f:
    json.dump(payload, f)

  # a standalone report: QA-Board often runs on intranets, so Plotly's JS is inlined
  html_parts = [
    "<!doctype html><html><head><meta charset='utf-8'><title>Tuning report</title></head>",
    "<body style='font-family: sans-serif; max-width: 1100px; margin: auto'>",
    "<h1>Tuning report</h1>",
    f"<p>{payload['n_completed']} evaluations ({payload['n_failed']} failed)</p>",
  ]
  for index, (key, title, figure) in enumerate(figures):
    html_parts.append(f"<h2>{title}</h2>")
    html_parts.append(pio.to_html(figure, include_plotlyjs=(index == 0), full_html=False))
  html_parts.append("</body></html>")
  with (dir / 'tuning-report.html').open('w') as f:
    f.write(''.join(html_parts))

  return payload
