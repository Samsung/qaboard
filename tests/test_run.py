"""
Tests for RunContext, what users' run() functions get.
"""
import unittest
from pathlib import Path


def run_context(configurations, extra_parameters, output_dir=Path()):
  from qaboard.run import RunContext
  return RunContext(
    type='default',
    input_path=Path('input'),
    database=Path(),
    platform='linux',
    configurations=configurations,
    extra_parameters=extra_parameters,
    output_dir=output_dir,
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


class TestIsFailed(unittest.TestCase):
  def test_empty_metrics_json_is_failed(self):
    """A killed run can leave a 0-byte metrics.json: it counts as a failed run instead of crashing"""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp)
      (output_dir / 'metrics.json').write_text('')
      context = run_context([], {}, output_dir=output_dir)
      self.assertTrue(context.is_failed())              # no exception raised
      self.assertTrue(context.is_failed(verbose=True))  # prints the [ERROR] message, still True

  def test_corrupt_metrics_json_is_failed(self):
    """Truncated/partial metrics.json is also treated as a failed run"""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp)
      (output_dir / 'metrics.json').write_text('{"is_failed": fa')  # truncated mid-write
      self.assertTrue(run_context([], {}, output_dir=output_dir).is_failed())

  def test_valid_metrics_json_unchanged(self):
    """A valid metrics.json still decides success/failure as before"""
    import tempfile, json
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp)
      (output_dir / 'metrics.json').write_text(json.dumps({'is_failed': False}))
      self.assertFalse(run_context([], {}, output_dir=output_dir).is_failed())
      (output_dir / 'metrics.json').write_text(json.dumps({'is_failed': True}))
      self.assertTrue(run_context([], {}, output_dir=output_dir).is_failed())
      (output_dir / 'metrics.json').write_text(json.dumps({}))  # missing key defaults to failed
      self.assertTrue(run_context([], {}, output_dir=output_dir).is_failed())

  def test_missing_metrics_json_is_failed(self):
    """A run without any metrics.json is failed (existing behavior, pinned)"""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
      self.assertTrue(run_context([], {}, output_dir=Path(tmp)).is_failed())


if __name__ == '__main__':
  unittest.main()
