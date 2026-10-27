"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest

import os
from pathlib import Path

class TestConventions(unittest.TestCase):
  def test_location_spec(self):
    from qaboard.conventions import location_from_spec
    self.assertEqual(location_from_spec({"linux": "/mnt/qaboard"}), Path("/mnt/qaboard"))
    self.assertEqual(location_from_spec("/mnt/qaboard"), Path("/mnt/qaboard"))
    os.environ['XXXXX'] = "user"
    self.assertEqual(location_from_spec("/mnt/${XXXXX}"), Path("/mnt/user"))
    self.assertEqual(location_from_spec("/mnt/{subproject.parts[0]}", {"subproject": Path("x/y")}), Path("/mnt/x"))
    self.assertEqual(location_from_spec("/mnt/{subproject_parts[0]}", {"subproject_parts": ["x","y"]}), Path("/mnt/x"))
    self.assertEqual(location_from_spec("/mnt/{subproject.name}", {"subproject": Path("x/y")}), Path("/mnt/y"))
    # https://docs.python.org/3/library/string.html#formatspec
    # https://www.python.org/dev/peps/pep-3101
    # self.assertEqual(location_from_spec("/mnt/{subproject_parts[-1]}", {"subproject_parts": ["x","y"]}), Path("/mnt/y"))


  def test_serialize_config(self):
    from qaboard.conventions import serialize_config
    self.assertEqual(serialize_config(['a', 'b', 'c']), 'a:b:c')
    self.assertEqual(serialize_config(['a', {'b': 1}]), 'a:{"b": 1}')
    self.assertEqual(serialize_config(['a', '{"b":1']), 'a:{"b":1')

  def test_deserialize_config(self):
    from qaboard.conventions import deserialize_config
    self.assertEqual(deserialize_config('a:b:c'), ['a', 'b', 'c'])
    self.assertEqual(deserialize_config('a:{"b":1}'), ['a', {'b': 1}])
    self.assertEqual(deserialize_config('a:{"b":1'), ['a', '{"b":1'])
    # we do those adjustments only on windows...
    # self.assertEqual(deserialize_config('a:C://path:b'), ['a', 'C://path', 'b'])
    # self.assertEqual(deserialize_config('C://path:a'), ['C://path', 'a'])


  def test_batches_files_no_inputs_config(self):
    """
    Regression test: legacy qatools-style projects may define no inputs.groups
    or inputs.batches in their qatools.yaml. batches_files() used to return
    None in that case, crashing callers like `qa save-artifacts` with
    "'NoneType' object is not iterable". It must return an empty list instead.
    """
    from qaboard.conventions import batches_files
    legacy_config = {'inputs': {}}  # no groups, no batches
    self.assertEqual(batches_files(legacy_config, None, 'proj', Path('.'), Path('.')), [])
    configured_config = {'inputs': {'groups': ['a', 'b']}}
    self.assertEqual(batches_files(configured_config, None, 'proj', Path('.'), Path('.')), [Path('a'), Path('b')])

  def test_batches_files_globs_without_chdir(self):
    """The server lists batches files from many threads: the globs are relative to the project, the cwd never changes"""
    import sys
    import tempfile
    from unittest import mock
    from qaboard.conventions import batches_files
    if sys.version_info < (3, 10):
      self.skipTest("glob(root_dir=) needs python 3.10")
    with tempfile.TemporaryDirectory() as root:
      (Path(root) / 'qa').mkdir()
      (Path(root) / 'qa' / 'a.yaml').write_text('{}')
      (Path(root) / 'qa' / 'b.yaml').write_text('{}')
      config = {'inputs': {'groups': ['qa/*.yaml']}}
      with mock.patch('os.chdir', side_effect=AssertionError("chdir is process-wide")):
        paths = batches_files(config, None, 'proj', Path('.'), Path(root))
      self.assertEqual(sorted(paths), ['qa/a.yaml', 'qa/b.yaml'])


if __name__ == '__main__':
  unittest.main()
