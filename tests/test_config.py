"""
Tests for qaboard.config
https://docs.python.org/3/library/unittest.html
"""
import os
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.test_git import make_broken_checkout, git


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


class TestStorageNeededBy(unittest.TestCase):
  def test_commands(self):
    from qaboard.config import storage_needed_by
    # Local runs save their results in output/
    for command in ('run', 'batch', 'get', 'postprocess', 'check-bit-accuracy-manifest', None):
      self.assertIsNone(storage_needed_by(command, share=False, is_ci=False), command)
    for command in ('run', 'batch', 'get'):
      self.assertIn('--share', storage_needed_by(command, share=True, is_ci=False))
      self.assertIn('CI', storage_needed_by(command, share=False, is_ci=True))
    for command in ('save-artifacts', 'check-bit-accuracy', 'optimize'):
      self.assertIn(f'`qa {command}`', storage_needed_by(command, share=False, is_ci=False))
    for command in ('auth', 'init'):
      self.assertIsNone(storage_needed_by(command, share=True, is_ci=True), command)


class TestMissingStorage(unittest.TestCase):
  """
  A new project from `qa init`, whose storage can't be created (e.g. /mnt/qaboard isn't mounted):
  local runs work, and only the commands that use the storage stop.
  """
  @classmethod
  def setUpClass(cls):
    qa = Path(sys.executable).parent / 'qa'
    if not qa.exists():
      raise unittest.SkipTest('needs the qa executable')
    cls.qa_executable = qa
    tmp = tempfile.TemporaryDirectory()
    cls.addClassCleanup(tmp.cleanup)
    cls.tmp = Path(tmp.name)
    cls.project = cls.tmp / 'project'
    cls.project.mkdir()
    # shared results are saved in the commit's folder
    git('init', '-q', cwd=cls.project)
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first commit', cwd=cls.project)
    init = cls.qa('init')
    assert init.returncode == 0, init.stderr
    # Even root can't create a folder in a file
    (cls.tmp / 'a-file').write_text('')
    cls.storage = cls.tmp / 'a-file' / 'qaboard'
    config = cls.project / 'qaboard.yaml'
    config_text = config.read_text()
    assert 'linux: /mnt/qaboard' in config_text
    config.write_text(config_text.replace('linux: /mnt/qaboard', f'linux: {cls.storage}'))
    cls.input = cls.tmp / 'input.txt'
    cls.input.write_text('hello')

  @classmethod
  def qa(cls, *args, **environ):
    """Runs `qa` in the project, outside CI and without our settings, or the site's"""
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_')) and k not in ('CI', 'GIT_COMMIT')}
    env.update({
      'QA_NO_CHECK_FOR_UPDATES': 'true', 'QA_OFFLINE': 'true',
      'QABOARD_URL': 'http://localhost:5151', 'QABOARD_SITE_CONFIG': '',
      **environ,
    })
    return subprocess.run([str(cls.qa_executable), *args], cwd=cls.project, env=env, capture_output=True, encoding='utf-8')

  def test_local_run_warns_once(self):
    out = self.qa('run', '--input', str(self.input), 'echo hi')
    self.assertEqual(out.returncode, 0, out.stderr)
    self.assertIn("'is_failed': False", out.stdout)
    self.assertTrue((self.project / 'output').is_dir())
    # the outputs and artifacts are both saved in the storage: one warning for both
    self.assertEqual(out.stderr.count('storage path does not exist'), 1, out.stderr)
    self.assertIn('WARNING', out.stderr)
    self.assertNotIn('ERROR', out.stderr)

  def test_runs_started_by_batch_dont_warn_again(self):
    out = self.qa('get', 'commit_id', QA_BATCH='true')
    self.assertEqual(out.returncode, 0, out.stderr)
    self.assertNotIn('storage path', out.stderr)

  def test_commands_that_need_the_storage(self):
    for args, environ, reason in [
      (['--share', 'run', '--input', str(self.input), 'echo hi'], {}, '`qa --share` saves results there'),
      (['run', '--input', str(self.input), 'echo hi'], {'CI': 'true'}, 'In CI'),
      (['save-artifacts'], {}, '`qa save-artifacts`'),
    ]:
      with self.subTest(args=args, environ=environ):
        out = self.qa(*args, **environ)
        self.assertEqual(out.returncode, 1, out.stderr)
        self.assertIn(f'ERROR: The storage path does not exist, and qa could not create it: "{self.storage}"', out.stderr)
        self.assertIn(reason, out.stderr)
        self.assertIn('QA_STORAGE', out.stderr)
        self.assertNotIn('is_failed', out.stdout)

  def test_valid_storage(self):
    # As before: `qa` creates the storage, and shared runs save their results there
    storage = self.tmp / 'storage'
    out = self.qa('--share', 'run', '--input', str(self.input), 'echo hi', QA_STORAGE=str(storage))
    self.assertEqual(out.returncode, 0, out.stderr)
    self.assertIn(f'Created: {storage}', out.stderr)
    self.assertNotIn('storage path', out.stderr)
    self.assertTrue(list(storage.rglob('metrics.json')))


if __name__ == '__main__':
  unittest.main()
