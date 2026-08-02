"""
The search space / solver YAML dialect is a user-facing contract: users write it in the
web UI and it is saved with their batches. These tests pin the dialect down so it does
not drift with the optimization engine underneath.
"""
import unittest

import yaml
from optuna.distributions import CategoricalDistribution, FloatDistribution, IntDistribution

from qaboard.optimization import make_study, parse_search_space


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
    self._assert_error("search_space:\n  - Real: {name: x, low: 1, high: 0}", '`x`', '>=')

  def test_error_missing_categories(self):
    self._assert_error("search_space:\n  - Categorical: {name: c}", '`c`', 'categories')

  def test_error_duplicate_name(self):
    self._assert_error(
      "search_space:\n  - Real: {name: x, low: 0, high: 1}\n  - Real: {name: x, low: 0, high: 1}",
      'more than once',
    )

  def test_error_unknown_prior(self):
    self._assert_error("search_space:\n  - Real: {name: x, low: 1, high: 2, prior: normal}", 'normal')

  def test_error_log_uniform_needs_positive_bounds(self):
    self._assert_error(
      "search_space:\n  - Real: {name: x, low: 0, high: 1, prior: log-uniform}",
      'log-uniform', '> 0',
    )


def has_torch():
  try:
    import torch
    return True
  except ImportError:
    return False


class TestSolver(unittest.TestCase):
  @unittest.skipUnless(has_torch(), "the default `gp` sampler needs torch")
  def test_defaults(self):
    study = make_study({})
    self.assertEqual(study.direction.name, 'MINIMIZE')
    self.assertEqual(type(study.sampler).__name__, 'GPSampler')

  @unittest.skipIf(has_torch(), "only checks the missing-torch path")
  def test_gp_without_torch_fails_immediately(self):
    """
    GPSampler only imports torch after `n_startup_trials`. Since every trial is a full
    batch run, a late crash would waste hours: we want the error before trial 1.
    """
    with self.assertRaises(ImportError) as context:
      make_study({'sampler': 'gp'})
    self.assertIn('qaboard[opt]', str(context.exception))
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
    ]:
      with self.assertRaises(ValueError) as context:
        make_study({legacy: 'whatever'})
      self.assertIn(legacy, str(context.exception))
      self.assertIn(expected, str(context.exception))

  def test_error_legacy_solver_name(self):
    with self.assertRaises(ValueError) as context:
      make_study({'name': 'scikit-optimize'})
    self.assertIn('optuna', str(context.exception))


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
