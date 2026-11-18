"""
Tests for RunContext, what users' run() functions get.
"""
import unittest
from pathlib import Path, PureWindowsPath


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

class TestWinNormalize(unittest.TestCase):
  """_win_normalize strips Windows extended-length prefixes so resolved paths compare equal.

  On Windows, Path.resolve() keeps the `\\\\?\\UNC\\` prefix for paths that don't exist yet
  (the next `qa run` attempt directory) but normalizes existing paths to plain `\\\\server\\share`,
  which used to crash `assert output_dir.resolve().relative_to(batch_conf_dir.resolve())`.
  We test with PureWindowsPath so the scenarios run on Linux too.
  """

  def _normalize(self):
    from qaboard.run import _win_normalize
    return _win_normalize

  def test_extended_unc_is_stripped(self):
    normalize = self._normalize()
    self.assertEqual(str(normalize(PureWindowsPath(r'\\?\UNC\netapp\vol23_algo\outputs\run'))),
                     r'\\netapp\vol23_algo\outputs\run')

  def test_extended_drive_is_stripped(self):
    normalize = self._normalize()
    self.assertEqual(str(normalize(PureWindowsPath(r'\\?\D:\data\outputs\run'))),
                     r'D:\data\outputs\run')

  def test_plain_unc_unchanged(self):
    normalize = self._normalize()
    path = PureWindowsPath(r'\\netapp\vol23_algo\outputs')
    self.assertEqual(normalize(path), path)

  def test_drive_unchanged(self):
    normalize = self._normalize()
    path = PureWindowsPath(r'D:\data\outputs')
    self.assertEqual(normalize(path), path)

  def test_relative_to_with_mismatched_prefixes(self):
    """Reproduces the Windows crash: extended-length `\\\\?\\UNC\\...` output vs plain `\\\\...` batch dir"""
    normalize = self._normalize()
    output_dir = normalize(PureWindowsPath(r'\\?\UNC\netapp\vol23_algo\outputs\delivery\windows\input\attempt_1'))
    batch_conf_dir = normalize(PureWindowsPath(r'\\netapp\vol23_algo\outputs\delivery\windows'))
    # this is the expression from RunContext.from_click_run_context: it must not raise
    self.assertTrue(output_dir.relative_to(batch_conf_dir))

  def test_escape_still_blocked(self):
    """The normalization must not defeat the assert's purpose: a GENUINE `../` escape still fails"""
    import ntpath
    normalize = self._normalize()
    base = normalize(PureWindowsPath(r'\\?\UNC\netapp\vol23_algo\outputs\delivery\windows'))
    escape = normalize(PureWindowsPath(r'\\?\UNC\netapp\vol23_algo\outputs\delivery\windows\..\..\elsewhere\run'))
    # Lexically, relative_to sees the `..` components (and raises on interpreters where it rejects
    # `..` remainders); the real-world `..` collapsing happens via Path.resolve() before the
    # comparison in RunContext. We model that collapse with ntpath.normpath, which is safe on Linux,
    # then assert the resolved escape is OUTSIDE the base: a real escape is blocked, not a
    # sibling-component mismatch.
    collapsed_base = type(base)(ntpath.normpath(str(base)))
    collapsed_escape = type(escape)(ntpath.normpath(str(escape)))
    with self.assertRaises(ValueError):
      collapsed_escape.relative_to(collapsed_base)
    # string-level confirmation of the same fact
    self.assertFalse(ntpath.normpath(str(escape)).startswith(ntpath.normpath(str(base)) + '\\'))

  def test_rel_input_path_with_extended_prefix(self):
    """rel_input_path compares with _win_normalize, so `\\\\?\\UNC\\` inputs vs plain `\\\\` databases work"""
    from qaboard.run import RunContext
    ctx = RunContext(
      type='default',
      input_path=PureWindowsPath(r'\\?\UNC\netapp\vol23_algo\db\inputs\img.png'),
      database=PureWindowsPath(r'\\netapp\vol23_algo\db'),
      platform='linux',
      configurations=[],
    )
    self.assertEqual(ctx.rel_input_path, PureWindowsPath('inputs/img.png'))


if __name__ == '__main__':
  unittest.main()
