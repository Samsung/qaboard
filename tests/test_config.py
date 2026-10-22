"""
Tests for qaboard.config
https://docs.python.org/3/library/unittest.html
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.test_git import make_broken_checkout


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


class TestStorageRoots(unittest.TestCase):
  def setUp(self):
    # Lazy import, see TestFindConfigs
    from qaboard.config import storage_roots
    self.storage_roots = storage_roots
    self.config = {"storage": {"outputs": "/algo/outputs/{user}", "artifacts": "/algo/artifacts/{project}"}}
    previous = os.environ.pop('QA_STORAGE', None)
    if previous is not None:
      self.addCleanup(os.environ.__setitem__, 'QA_STORAGE', previous)

  def test_user_name(self):
    # The server uses it to know the folders of restricted projects, with any user
    outputs, artifacts, _ = self.storage_roots(self.config, Path('group/repo'), Path('.'), user_name='{user}')
    self.assertEqual(outputs, Path('/algo/outputs/{user}'))
    self.assertEqual(artifacts, Path('/algo/artifacts/group/repo'))
    outputs, _, _ = self.storage_roots(self.config, Path('group/repo'), Path('.'), user_name='alice')
    self.assertEqual(outputs, Path('/algo/outputs/alice'))

  def test_current_user(self):
    from qaboard.config import user
    outputs, _, _ = self.storage_roots(self.config, Path('group/repo'), Path('.'))
    self.assertEqual(outputs, Path(f'/algo/outputs/{user}'))


class TestGitHeadFallback(unittest.TestCase):
  def test_unresolvable_head_warns_and_uses_placeholders(self):
    from qaboard.config import _git_head_or_placeholder, user
    with tempfile.TemporaryDirectory() as tmp, \
         mock.patch('qaboard.config.is_in_git_repo', True), \
         mock.patch('qaboard.config.click.secho') as secho:
      self.assertEqual(_git_head_or_placeholder(make_broken_checkout(Path(tmp))), (f'<local:{user}>', f'<local:{user}>'))
    self.assertIn('Could not read the git HEAD', secho.call_args.args[0])


class TestStorageHelp(unittest.TestCase):
  def messages(self, env):
    from importlib import import_module
    config = import_module('qaboard.config') # qaboard.config is also the configuration (qaboard/__init__.py)
    with tempfile.TemporaryDirectory() as tmp, \
         mock.patch.dict(os.environ, env), \
         mock.patch.object(config, 'ignore_config_errors', False), \
         mock.patch.object(config, 'config_has_error', False), \
         mock.patch('qaboard.config.click.secho') as secho:
      (Path(tmp) / 'file').touch()
      config.mkdir(Path(tmp) / 'file' / 'storage') # can't be created
      self.assertTrue(config.config_has_error)
    return '\n'.join(c.args[0] for c in secho.call_args_list)

  def test_site_explains_how_to_get_storage(self):
    messages = self.messages({'QABOARD_STORAGE_HELP': 'Ask IT at https://helpdesk.example.com'})
    self.assertIn('The storage path does not exist', messages)
    self.assertIn('Ask IT at https://helpdesk.example.com', messages)

  def test_no_site_help(self):
    messages = self.messages({'QABOARD_STORAGE_HELP': ''})
    self.assertIn('The storage path does not exist', messages)
    self.assertNotIn('INFO', messages)


if __name__ == '__main__':
  unittest.main()
