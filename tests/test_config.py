"""
Tests for qaboard.config
https://docs.python.org/3/library/unittest.html
"""
import os
import tempfile
import unittest
from pathlib import Path


class TestFindConfigs(unittest.TestCase):
  """Tests for find_configs' handling of symlinked project paths."""

  def setUp(self):
    # tmp/real contains a root qaboard.yaml, and tmp/link is a symlink to tmp/real.
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.tmp = Path(tmp.name)
    real = self.tmp / 'real'
    real.mkdir()
    (real / 'qaboard.yaml').write_text('root: true' + os.linesep)
    self.link = self.tmp / 'link'
    self.link.symlink_to(real, target_is_directory=True)
    # Lazy import: qaboard.config caches module-level state from the cwd at first import,
    # and test_cli relies on importing it first, after chdir'ing into the sample project.
    from qaboard.config import find_configs
    self.find_configs = find_configs

  def test_preserves_symlink_spelling(self):
    # abspath keeps the path spelling, unlike resolve() which dereferences mapped drives on Windows.
    results = self.find_configs(Path(str(self.link)))
    self.assertTrue(results, "find_configs should find the root qaboard.yaml")
    configs = [config for config, _ in results]
    paths = [path for _, path in results]
    self.assertEqual(paths[0].parent, self.link)
    self.assertIs(configs[0].get('root'), True)

  def test_from_symlinked_cwd(self):
    # On POSIX getcwd() (inside abspath) already resolves the cwd, so this is only meaningful on Windows.
    original_cwd = os.getcwd()
    self.addCleanup(os.chdir, original_cwd)
    os.chdir(self.link)
    results = self.find_configs(Path())
    self.assertTrue(results, "find_configs should find the root qaboard.yaml from a symlinked cwd")
    configs = [config for config, _ in results]
    self.assertIs(configs[0].get('root'), True)


if __name__ == '__main__':
  unittest.main()
