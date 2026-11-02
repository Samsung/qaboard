"""
Tests for RunContext, what users' run() functions get.
"""
import unittest
from pathlib import Path


def run_context(configurations, extra_parameters):
  from qaboard.run import RunContext
  return RunContext(
    type='default',
    input_path=Path('input'),
    database=Path(),
    platform='linux',
    configurations=configurations,
    extra_parameters=extra_parameters,
  )


class TestConfigs(unittest.TestCase):
  def test_tuning_configs(self):
    """`--tuning '"hello"' --tuning '{"key": "value"}'` gives {'_configs': ['hello'], 'key': 'value'}"""
    context = run_context(['base'], {'_configs': ['hello'], 'key': 'value'})
    self.assertEqual(context.configs, ['base', 'hello', {'key': 'value'}])
    self.assertEqual(context.params, {'key': 'value'})
    # not changed
    self.assertEqual(context.extra_parameters, {'_configs': ['hello'], 'key': 'value'})

  def test_only_tuning_configs(self):
    context = run_context(['base'], {'_configs': ['hello']})
    self.assertEqual(context.configs, ['base', 'hello'])
    self.assertEqual(context.params, {})

  def test_tuning_parameters(self):
    context = run_context(['base', {'a': 1}], {'b': 2})
    self.assertEqual(context.configs, ['base', {'a': 1}, {'b': 2}])
    self.assertEqual(context.params, {'a': 1, 'b': 2})
    self.assertEqual(run_context(['base'], {}).configs, ['base'])


if __name__ == '__main__':
  unittest.main()
