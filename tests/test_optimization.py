"""
The search space / solver YAML dialect is a user-facing contract: users write it in the
web UI and it is saved with their batches. These tests pin the dialect down so it does
not drift with the optimization engine underneath.
"""
import tempfile
import threading
import unittest
from pathlib import Path

import yaml
from optuna.distributions import CategoricalDistribution, FloatDistribution, IntDistribution

from qaboard.optimization import (
  check_config, check_resumable, describe_search_space, make_storage, make_study,
  parse_objective, parse_options, parse_search_space, parse_solver, run_optimization, study_summary,
)


# Kept in sync with the template users are given in the web UI,
# see webapp/src/components/tuning/templates.js
TEMPLATE_SEARCH_SPACE = """
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
"""


def parse(yaml_str):
  return parse_search_space(yaml.safe_load(yaml_str)['search_space'])


class TestSearchSpace(unittest.TestCase):
  def test_the_webapp_template(self):
    """The exact search space we hand every user must keep working."""
    distributions = parse(TEMPLATE_SEARCH_SPACE)
    self.assertEqual(
      list(distributions.keys()),
      ['max_events', 'solver', 'threshold', 'learning_rate'],
    )
    self.assertEqual(distributions['max_events'], IntDistribution(1000, 10000))
    self.assertEqual(distributions['solver'], CategoricalDistribution(['ceres', 'g2o']))
    self.assertEqual(distributions['threshold'], FloatDistribution(0.0, 1.0))
    self.assertEqual(distributions['learning_rate'], FloatDistribution(1e-7, 0.1, log=True))

  def test_log_uniform_prior(self):
    space = parse("search_space:\n  - Integer: {name: n, low: 1, high: 100, prior: log-uniform}")
    self.assertTrue(space['n'].log)

  def test_uniform_is_the_default_prior(self):
    space = parse("search_space:\n  - Real: {name: x, low: 1, high: 2}")
    self.assertFalse(space['x'].log)
    space = parse("search_space:\n  - Real: {name: x, low: 1, high: 2, prior: uniform}")
    self.assertFalse(space['x'].log)

  def test_categories_keep_their_order(self):
    space = parse("search_space:\n  - Categorical: {name: c, categories: [b, a, c]}")
    self.assertEqual(space['c'].choices, ('b', 'a', 'c'))

  def _assert_error(self, yaml_str, *expected_in_message):
    with self.assertRaises(ValueError) as context:
      parse(yaml_str)
    for expected in expected_in_message:
      self.assertIn(expected, str(context.exception))

  # Those errors are shown to users in the web UI, so they must say what is wrong and where
  def test_error_empty(self):
    self._assert_error("search_space:", 'search_space')

  def test_error_not_a_list(self):
    self._assert_error("search_space: {a: 1}", 'must be a list')

  def test_error_unknown_dimension(self):
    self._assert_error("search_space:\n  - Float: {name: x, low: 0, high: 1}", 'Float')

  def test_error_missing_name(self):
    self._assert_error("search_space:\n  - Real: {low: 0, high: 1}", 'search_space[0]', 'name')

  def test_error_missing_bounds(self):
    self._assert_error("search_space:\n  - Real: {name: x, low: 0}", '`x`', 'high')

  def test_error_inverted_bounds(self):
    self._assert_error("search_space:\n  - Real: {name: x, low: 1, high: 0}", '`x`', 'smaller')

  def test_error_missing_categories(self):
    self._assert_error("search_space:\n  - Categorical: {name: c}", '`c`', 'categories')

  def test_error_duplicate_name(self):
    self._assert_error(
      "search_space:\n  - Real: {name: x, low: 0, high: 1}\n  - Real: {name: x, low: 0, high: 1}",
      'twice',
    )

  def test_error_unknown_prior(self):
    self._assert_error("search_space:\n  - Real: {name: x, low: 1, high: 2, prior: normal}", 'normal')

  def test_error_log_uniform_needs_positive_bounds(self):
    self._assert_error(
      "search_space:\n  - Real: {name: x, low: 0, high: 1, prior: log-uniform}",
      'log-uniform', 'above 0',
    )


def has_torch():
  try:
    import torch
    return True
  except ImportError:
    return False


class TestSolver(unittest.TestCase):
  def test_defaults(self):
    """`auto`, the default, works out of the box: Gaussian processes need PyTorch, TPE doesn't"""
    study = make_study({})
    self.assertEqual(study.direction.name, 'MINIMIZE')
    self.assertEqual(type(study.sampler).__name__, 'GPSampler' if has_torch() else 'TPESampler')
    self.assertEqual(parse_solver(None), {'sampler': 'auto', 'seed': 101, 'n_startup_trials': 10})

  @unittest.skipIf(has_torch(), "only checks the missing-torch path")
  def test_gp_without_torch_fails_immediately(self):
    """
    GPSampler only imports torch after `n_startup_trials`. Since every trial is a full
    batch run, a late crash would waste hours: we want the error before trial 1.
    """
    with self.assertRaises(ImportError) as context:
      make_study({'sampler': 'gp'})
    self.assertIn('pip install torch', str(context.exception))
    self.assertIn('tpe', str(context.exception))

  def test_samplers(self):
    for sampler, expected in [('tpe', 'TPESampler'), ('random', 'RandomSampler')]:
      study = make_study({'sampler': sampler})
      self.assertEqual(type(study.sampler).__name__, expected)

  def test_error_unknown_sampler(self):
    with self.assertRaises(ValueError) as context:
      make_study({'sampler': 'grid'})
    self.assertIn('grid', str(context.exception))

  def test_error_unknown_setting(self):
    with self.assertRaises(ValueError) as context:
      make_study({'sampler': 'tpe', 'nb_startup_trials': 3})
    self.assertIn('nb_startup_trials', str(context.exception))

  # Users have saved configs written for the old scikit-optimize solver.
  # We refuse them with an explanation rather than silently ignoring them.
  def test_error_legacy_skopt_settings(self):
    for legacy, expected in [
      ('base_estimator', 'sampler'),
      ('n_initial_points', 'n_startup_trials'),
      ('random_state', 'seed'),
      ('acq_func', 'acquisition'),
      ('n_jobs', 'parallel_sampling'),
    ]:
      with self.assertRaises(ValueError) as context:
        make_study({legacy: 'whatever'})
      self.assertIn(legacy, str(context.exception))
      self.assertIn(expected, str(context.exception))

  def test_error_legacy_solver_name(self):
    with self.assertRaises(ValueError) as context:
      make_study({'name': 'scikit-optimize'})
    self.assertIn('Optuna', str(context.exception))


class TestOptions(unittest.TestCase):
  BASE = {'objective': {'metric_a': {}}, 'evaluations': 50}

  def test_defaults(self):
    options = parse_options(self.BASE)
    self.assertEqual(options, {
      'evaluations': 50, 'parallel_sampling': 1, 'patience': None,
      'pareto': False, 'objective_metrics': ['metric_a'], 'resume': True,
      'objective': {'metric_a': {'goal': None, 'weight': 1, 'loss': 'identity', 'reduce': 'sum', 'margin': 0.0, 'target': None}},
    })

  def test_early_stopping_forms(self):
    """Both `early_stopping: 15` and `early_stopping: {patience: 15}` work."""
    self.assertEqual(parse_options({**self.BASE, 'early_stopping': 15})['patience'], 15)
    self.assertEqual(parse_options({**self.BASE, 'early_stopping': {'patience': 15}})['patience'], 15)

  def test_target_is_not_an_objective_metric(self):
    options = parse_options({**self.BASE, 'objective': {'metric_a': {}, 'target': {'branch': 'main'}}})
    self.assertEqual(options['objective_metrics'], ['metric_a'])

  def _assert_error(self, config, *expected_in_message):
    with self.assertRaises(ValueError) as context:
      parse_options(config)
    for expected in expected_in_message:
      self.assertIn(expected, str(context.exception))

  def test_errors(self):
    self._assert_error({'evaluations': 50}, 'objective')
    self._assert_error({'objective': {'m': {}}}, 'evaluations')
    self._assert_error({**self.BASE, 'evaluations': 0}, 'evaluations')
    self._assert_error({**self.BASE, 'parallel_sampling': 0}, 'parallel_sampling')
    self._assert_error({**self.BASE, 'early_stopping': -3}, 'patience')
    self._assert_error({**self.BASE, 'early_stopping': {'wait': 3}}, 'wait')
    self._assert_error({**self.BASE, 'pareto': 'yes'}, 'pareto')
    self._assert_error({**self.BASE, 'pareto': True}, 'two metrics')
    self._assert_error({**self.BASE, 'resume': 'no'}, 'resume')


class TestObjective(unittest.TestCase):
  """Each metric says which way is better, or leaves it to the code that computes it"""

  def test_forms(self):
    objective = parse_objective(yaml.safe_load("""
      psnr: max
      latency: {goal: min, weight: 0.1}
      ssim:
      size_mb: {weight: 2, loss: relu_shift, target: 4, margin: 0.5}
      target: {branch: main}
    """))
    self.assertEqual(list(objective), ['psnr', 'latency', 'ssim', 'size_mb'])
    self.assertEqual([o['goal'] for o in objective.values()], ['max', 'min', None, None])
    self.assertEqual(objective['latency']['weight'], 0.1)
    self.assertEqual(objective['size_mb'], {'goal': None, 'weight': 2, 'loss': 'relu_shift', 'reduce': 'sum', 'margin': 0.5, 'target': 4})
    # aliases
    self.assertEqual(parse_objective({'a': 'maximize', 'b': {'goal': 'MIN'}}), {
      'a': {**objective['psnr'], 'goal': 'max'}, 'b': {**objective['psnr'], 'goal': 'min'},
    })

  def test_errors(self):
    for options, expected in [
      ('higher', 'expected `max`'),
      ({'goal': 'up'}, 'expected `max`'),
      (3, 'must be `max`, `min`, or a mapping'),
      ({'weight': 0}, 'positive number'),
      ({'loss': 'l2'}, 'identity, shift or relative'),
      ({'reduce': 'mean'}, 'sum, relu, l1 or l2'),
      ({'target': 'high'}, 'must be a number'),
    ]:
      with self.subTest(options=options):
        with self.assertRaises(ValueError) as context:
          parse_objective({'psnr': options})
        self.assertIn(expected, str(context.exception))
        self.assertIn('psnr', str(context.exception))
    # the server and the web app give the same message
    self.assertEqual(len(check_config({'evaluations': 5, 'objective': {'psnr': 'higher'}, 'search_space': [{'Real': {'name': 'x', 'low': 0, 'high': 1}}]})), 1)


SPACE_1D = "search_space:\n  - Real: {name: x, low: 0, high: 1}"


class TestRunOptimization(unittest.TestCase):
  def test_runs_the_budget_and_converges(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    seen = []
    summary = run_optimization(
      study, distributions,
      objective=lambda params, number: {'m': (params['x'] - 0.3) ** 2},
      evaluations=30,
      on_trial=lambda number, params, components, scalar, is_best: seen.append((number, scalar, is_best)),
    )
    self.assertEqual(summary['finished'], 30)
    self.assertFalse(summary['early_stopped'])
    self.assertEqual(len(seen), 30)
    self.assertLess(study.best_value, 0.05)
    # is_best is monotone: the running best over on_trial calls matches the study
    bests = [scalar for _, scalar, is_best in seen if is_best]
    self.assertEqual(bests, sorted(bests, reverse=True))
    self.assertEqual(min(scalar for _, scalar, _ in seen), study.best_value)

  def test_failures_count_toward_budget_but_not_the_search(self):
    from optuna.trial import TrialState
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    summary = run_optimization(
      study, distributions,
      objective=lambda params, number: None if number % 3 == 0 else {'m': params['x']},
      evaluations=12,
    )
    self.assertEqual(summary['finished'], 12)
    self.assertEqual(sum(1 for t in study.trials if t.state == TrialState.FAIL), 4)
    self.assertEqual(sum(1 for t in study.trials if t.state == TrialState.COMPLETE), 8)

  def test_parallel_uses_concurrent_slots(self):
    """With parallel_sampling=4, several evaluations must actually overlap."""
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    in_flight, max_in_flight = [0], [0]
    lock = threading.Lock()
    barrier = threading.Event()
    def objective(params, number):
      with lock:
        in_flight[0] += 1
        max_in_flight[0] = max(max_in_flight[0], in_flight[0])
      if max_in_flight[0] >= 4:
        barrier.set()
      barrier.wait(timeout=10)  # hold until all 4 slots are busy at once
      with lock:
        in_flight[0] -= 1
      return {'m': params['x']}
    run_optimization(study, distributions, objective, evaluations=8, parallel_sampling=4)
    self.assertEqual(max_in_flight[0], 4)

  def test_early_stopping(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    # an objective that never improves after the first evaluation
    summary = run_optimization(
      study, distributions,
      objective=lambda params, number: {'m': 0.0 if number == 0 else 1.0},
      evaluations=100,
      patience=5,
    )
    self.assertTrue(summary['early_stopped'])
    self.assertEqual(summary['finished'], 6)  # 1 best + 5 without improvement

  def test_worker_exceptions_propagate(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    def explodes(params, number):
      raise RuntimeError("infrastructure on fire")
    with self.assertRaises(RuntimeError):
      run_optimization(study, distributions, explodes, evaluations=4, parallel_sampling=2)


class TestStorageResume(unittest.TestCase):
  def test_resume_continues_the_budget(self):
    distributions = parse(SPACE_1D)
    objective = lambda params, number: {'m': params['x']}
    with tempfile.TemporaryDirectory() as tmp:
      storage = make_storage(Path(tmp) / 'optuna-journal.log')
      study = make_study({'sampler': 'random', 'seed': 0}, storage=storage)
      run_optimization(study, distributions, objective, evaluations=5)
      self.assertEqual(len(study.trials), 5)

      # same storage later: past trials are still there, only the remainder runs
      study2 = make_study({'sampler': 'random', 'seed': 0}, storage=make_storage(Path(tmp) / 'optuna-journal.log'))
      self.assertEqual(len(study2.trials), 5)
      summary = run_optimization(study2, distributions, objective, evaluations=8)
      self.assertEqual(summary['finished'], 8)
      self.assertEqual(len(study2.trials), 8)
      # trial numbers continue, so batch labels iter1..iterN never collide
      self.assertEqual([t.number for t in study2.trials], list(range(8)))

  def test_resume_ignores_zombie_running_trials(self):
    """Trials left RUNNING by a crashed run must not eat the budget."""
    distributions = parse(SPACE_1D)
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'optuna-journal.log'
      study = make_study({'sampler': 'random', 'seed': 0}, storage=make_storage(path))
      study.ask(distributions)  # never told: a zombie
      study2 = make_study({'sampler': 'random', 'seed': 0}, storage=make_storage(path))
      summary = run_optimization(study2, distributions, lambda p, n: {'m': p['x']}, evaluations=3)
      self.assertEqual(summary['finished'], 3)

  def test_completed_budget_runs_nothing(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    run_optimization(study, distributions, lambda p, n: {'m': p['x']}, evaluations=4)
    calls = []
    run_optimization(study, distributions, lambda p, n: calls.append(1) or {'m': p['x']}, evaluations=4)
    self.assertEqual(calls, [])


class TestPareto(unittest.TestCase):
  def test_front(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0}, n_objectives=2)
    # two objectives in tension: x and 1-x -- every trial is on the front's line
    summary = run_optimization(
      study, distributions,
      objective=lambda params, number: {'a': params['x'], 'b': 1 - params['x']},
      evaluations=15,
      metric_names=['a', 'b'],
    )
    self.assertEqual(summary['finished'], 15)
    front = study.best_trials
    self.assertGreater(len(front), 1)  # trade-offs, not a single winner
    for t in front:
      self.assertAlmostEqual(sum(t.values), 1.0)

  def test_is_best_is_the_best_sum(self):
    """
    QA-Board keeps the runs of the "best" iteration in the experiment's batch: one of them, so in Pareto mode
    it's the best summed loss too. The front itself is reported as data, see study_summary.
    """
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0}, n_objectives=2)
    seen = []
    run_optimization(
      study, distributions,
      objective=lambda params, number: {'a': params['x'], 'b': (1 - params['x']) ** 2},
      evaluations=12,
      metric_names=['a', 'b'],
      on_trial=lambda number, params, losses, loss, is_best: seen.append((loss, is_best)),
    )
    best = None
    for loss, is_best in seen:
      self.assertEqual(is_best, best is None or loss <= best)
      best = loss if best is None else min(best, loss)


class TestReportsInOrder(unittest.TestCase):
  def test_reports_wait_for_earlier_iterations(self):
    """
    QA-Board's server deletes the iterations' batches up to the one reported: reporting iteration 7 while
    iteration 5 still runs would delete 5's runs. Evaluations end in any order, reports come in order.
    """
    import time
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    ended, reported = [], []
    def objective(params, number):
      time.sleep([0.15, 0.01, 0.08, 0.02][number % 4])  # the first evaluations end last
      ended.append(number)
      return {'m': params['x']}
    run_optimization(
      study, distributions, objective, evaluations=12, parallel_sampling=4,
      on_trial=lambda number, params, losses, loss, is_best: reported.append(number),
    )
    self.assertNotEqual(ended, sorted(ended))  # they really ended out of order
    self.assertEqual(reported, list(range(12)))

  def test_failed_iterations_are_reported_too(self):
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    reported = []
    run_optimization(
      study, distributions, lambda p, n: None if n == 1 else {'m': p['x']}, evaluations=3,
      on_trial=lambda number, params, losses, loss, is_best: reported.append((number, losses is None, is_best)),
    )
    self.assertEqual([(n, failed) for n, failed, _ in reported], [(0, False), (1, True), (2, False)])
    self.assertFalse(reported[1][2])

  def test_non_finite_objectives_count_as_failed(self):
    from optuna.trial import TrialState
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0})
    run_optimization(study, distributions, lambda p, n: {'m': float('nan')} if n == 0 else {'m': 1.0}, evaluations=2)
    self.assertEqual([t.state for t in study.trials], [TrialState.FAIL, TrialState.COMPLETE])


class TestCheckConfig(unittest.TestCase):
  VALID = {
    'evaluations': 20,
    'objective': {'map': {'weight': 1}},
    'search_space': [{'Real': {'name': 'x', 'low': 0, 'high': 1}}],
  }

  def test_valid(self):
    self.assertEqual(check_config(self.VALID), [])
    self.assertEqual(check_config({**self.VALID, 'solver': {'sampler': 'tpe', 'seed': 3}}), [])

  def test_one_message_per_section(self):
    errors = check_config({'evaluations': 0, 'search_space': [], 'solver': {'n_initial_points': 5}})
    self.assertEqual(len(errors), 3)
    self.assertIn('objective', errors[0])
    self.assertIn('search_space', errors[1])
    self.assertIn('n_startup_trials', errors[2])

  def test_not_a_mapping(self):
    self.assertEqual(len(check_config(['a'])), 1)
    self.assertEqual(len(check_config(None)), 1)

  def test_preset_and_tuned(self):
    errors = check_config({**self.VALID, 'preset_params': {'x': 1}})
    self.assertIn('`x`', errors[0])

  def test_objective_weights(self):
    self.assertIn('weight', check_config({**self.VALID, 'objective': {'map': {'weight': -1}}})[0])
    self.assertIn('mapping', check_config({**self.VALID, 'objective': {'map': 1}})[0])

  def test_integer_bounds(self):
    errors = check_config({**self.VALID, 'search_space': [{'Integer': {'name': 'n', 'low': 0.5, 'high': 3}}]})
    self.assertIn('whole numbers', errors[0])

  def test_single_category(self):
    errors = check_config({**self.VALID, 'search_space': [{'Categorical': {'name': 'c', 'categories': ['a']}}]})
    self.assertIn('preset_params', errors[0])


class TestResume(unittest.TestCase):
  def test_objective_must_not_change(self):
    study = make_study({'sampler': 'random'})
    signature = {'objective': {'map': {}}, 'pareto': False, 'search_space': []}
    self.assertIsNone(check_resumable(study, signature))
    self.assertIsNone(check_resumable(study, signature))
    # widening a range and going on is a normal way to work
    self.assertIsNone(check_resumable(study, {**signature, 'search_space': [{'Real': {'name': 'x', 'low': 0, 'high': 2}}]}))
    self.assertIn('objective', check_resumable(study, {**signature, 'objective': {'map': {'weight': 2}}}))
    self.assertIn('objective', check_resumable(study, {**signature, 'pareto': True}))


class TestSummary(unittest.TestCase):
  def test_search_space_for_the_web_app(self):
    self.assertEqual(describe_search_space(parse(TEMPLATE_SEARCH_SPACE)), [
      {'name': 'max_events', 'type': 'integer', 'low': 1000, 'high': 10000, 'log': False},
      {'name': 'solver', 'type': 'categorical', 'choices': ['ceres', 'g2o']},
      {'name': 'threshold', 'type': 'real', 'low': 0.0, 'high': 1.0, 'log': False},
      {'name': 'learning_rate', 'type': 'real', 'low': 1e-7, 'high': 0.1, 'log': True},
    ])

  def test_importances(self):
    import json
    distributions = parse(TEMPLATE_SEARCH_SPACE)
    study = make_study({'sampler': 'random', 'seed': 0})
    summary = study_summary(study)
    self.assertEqual(summary, {'evaluations_completed': 0, 'evaluations_failed': 0})
    run_optimization(study, distributions, lambda p, n: {'m': (p['threshold'] - 0.3) ** 2 + (p['solver'] == 'g2o')}, evaluations=20)
    summary = study_summary(study)
    self.assertEqual(summary['evaluations_completed'], 20)
    importances = summary['importances']
    self.assertEqual(set(importances), {'max_events', 'solver', 'threshold', 'learning_rate'})
    self.assertAlmostEqual(sum(importances.values()), 1, places=2)
    self.assertLess(importances['learning_rate'], 0.2)
    json.dumps(summary)  # sent as the batch's data

  def test_pareto_front(self):
    import json
    distributions = parse(SPACE_1D)
    study = make_study({'sampler': 'random', 'seed': 0}, n_objectives=2)
    run_optimization(study, distributions, lambda p, n: {'a': p['x'], 'b': 1 - p['x']}, evaluations=6, metric_names=['a', 'b'])
    front = study_summary(study, ['a', 'b'])['pareto_front']
    self.assertEqual(len(front), 6)
    self.assertEqual(front[0]['iteration'], 1)
    self.assertEqual(set(front[0]['losses']), {'a', 'b'})
    self.assertIn('x', front[0]['params'])
    json.dumps(front)


class TestAskTell(unittest.TestCase):
  def test_optimizes(self):
    """A full ask/tell loop, the way qaboard/optimize.py drives it."""
    distributions = parse(TEMPLATE_SEARCH_SPACE)
    study = make_study({'sampler': 'random', 'seed': 0})
    for _ in range(20):
      trial = study.ask(distributions)
      params = trial.params
      self.assertEqual(set(params.keys()), set(distributions.keys()))
      self.assertIn(params['solver'], ['ceres', 'g2o'])
      self.assertTrue(1000 <= params['max_events'] <= 10000)
      study.tell(trial, (params['threshold'] - 0.3) ** 2)
    self.assertLess(study.best_value, 0.1)

  def test_failed_trials_do_not_stop_the_search(self):
    from optuna.trial import TrialState
    distributions = parse("search_space:\n  - Real: {name: x, low: 0, high: 1}")
    study = make_study({'sampler': 'random', 'seed': 0})
    for i in range(10):
      trial = study.ask(distributions)
      if i % 2:
        study.tell(trial, state=TrialState.FAIL)
      else:
        study.tell(trial, trial.params['x'])
    completed = [t for t in study.trials if t.state == TrialState.COMPLETE]
    self.assertEqual(len(completed), 5)
    self.assertIsNotNone(study.best_value)

  def test_parallel_sampling_gives_distinct_suggestions(self):
    distributions = parse(TEMPLATE_SEARCH_SPACE)
    study = make_study({'sampler': 'tpe', 'seed': 0})
    trials = [study.ask(distributions) for _ in range(4)]
    self.assertEqual(len({t.number for t in trials}), 4)


if __name__ == '__main__':
  unittest.main()
