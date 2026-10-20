"""
Tests for reading the HEAD commit, including from git worktrees.
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


def git_head(repo_root):
  # Importing qaboard reads qaboard.yaml from the current directory: import it late,
  # once the CLI tests changed directory into the sample projects
  from qaboard.git import git_head
  return git_head(repo_root)


def git(*args, cwd):
  env = {
    **os.environ,
    'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
  }
  return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, encoding='utf8', stdout=subprocess.PIPE).stdout.strip()


@contextmanager
def windows_with_mappings(mappings):
  """Run the body as if on Windows, with these (windows_prefix, linux_prefix) path mappings."""
  from qaboard import compat
  with mock.patch('os.name', 'nt'), mock.patch.object(compat, 'mappings', tuple(mappings)):
    yield


def make_broken_checkout(root):
  """Create a checkout whose .git pointer cannot be resolved."""
  broken = root / 'broken'
  broken.mkdir(exist_ok=True)
  (broken / '.git').write_text('gitdir: /nonexistent/repo/.git/worktrees/broken\n')
  return broken


class TestPointerToWindows(unittest.TestCase):
  def test_absolute_pointer(self):
    from qaboard.git import _safe_linux_to_windows
    with windows_with_mappings(((r'\\fileserver\share', '/home'),)):
      self.assertEqual(_safe_linux_to_windows('/home/proj/.git/worktrees/x'), r'\\fileserver\share\proj\.git\worktrees\x')
    with windows_with_mappings((('C:', '/home'),)):
      self.assertEqual(_safe_linux_to_windows('/home/proj/.git'), r'C:\proj\.git')

  def test_relative_pointer(self):
    from qaboard.git import _safe_linux_to_windows
    with windows_with_mappings(((r'\\fileserver\share', '/home'),)):
      self.assertEqual(_safe_linux_to_windows('../main/.git/worktrees/x'), '../main/.git/worktrees/x')

  def test_linux(self):
    from qaboard.git import _safe_linux_to_windows
    self.assertEqual(_safe_linux_to_windows('/home/proj/.git'), '/home/proj/.git')


@unittest.skipIf(shutil.which('git') is None, "git is not installed")
class TestGitHead(unittest.TestCase):
  def setUp(self):
    self.tmp = Path(tempfile.mkdtemp())
    self.main = self.tmp / 'main'
    self.main.mkdir()
    git('init', '-q', '-b', 'master', cwd=self.main)
    git('commit', '-q', '--allow-empty', '-m', 'first', cwd=self.main)
    self.main_sha = git('rev-parse', 'HEAD', cwd=self.main)
    self.worktree = self.tmp / 'worktree'
    git('worktree', 'add', '-q', '-b', 'CIS/feature', str(self.worktree), cwd=self.main)
    git('commit', '-q', '--allow-empty', '-m', 'second', cwd=self.worktree)
    self.worktree_sha = git('rev-parse', 'HEAD', cwd=self.worktree)

  def tearDown(self):
    shutil.rmtree(self.tmp, ignore_errors=True)

  def test_main_checkout(self):
    self.assertEqual(git_head(self.main), ('master', self.main_sha))

  def test_worktree(self):
    self.assertEqual(git_head(self.worktree), ('CIS/feature', self.worktree_sha))

  def test_worktree_packed_refs(self):
    git('pack-refs', '--all', cwd=self.main)
    self.assertFalse((self.main / '.git' / 'refs' / 'heads' / 'CIS' / 'feature').exists())
    self.assertEqual(git_head(self.worktree), ('CIS/feature', self.worktree_sha))

  def test_worktree_relative_gitdir(self):
    # like `git worktree add --relative-paths`, or submodules
    dot_git = self.worktree / '.git'
    gitdir = Path(dot_git.read_text().split(':', 1)[1].strip())
    dot_git.write_text(f"gitdir: {os.path.relpath(gitdir, self.worktree)}\n")
    self.assertEqual(git_head(self.worktree), ('CIS/feature', self.worktree_sha))

  def test_worktree_detached(self):
    git('checkout', '-q', '--detach', cwd=self.worktree)
    self.assertEqual(git_head(self.worktree), (self.worktree_sha, self.worktree_sha))

  def test_worktree_absolute_commondir(self):
    from qaboard.git import git_dirs
    commondir_path = self.main / '.git' / 'worktrees' / self.worktree.name / 'commondir'
    commondir_path.write_text(f'{self.main / ".git"}\n')
    git_dir, common_dir = git_dirs(self.worktree)
    self.assertEqual(git_dir, self.main / '.git' / 'worktrees' / self.worktree.name)
    self.assertEqual(common_dir, self.main / '.git')
    self.assertEqual(git_head(self.worktree), ('CIS/feature', self.worktree_sha))

  def test_unresolvable_pointer_raises(self):
    # config.py falls back to placeholders
    with self.assertRaises(OSError):
      git_head(make_broken_checkout(self.tmp))


if __name__ == '__main__':
  unittest.main()
