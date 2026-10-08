"""
Tests for reading the HEAD commit, including from git worktrees.
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from qaboard.git import git_head


def git(*args, cwd):
  env = {
    **os.environ,
    'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
  }
  return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, encoding='utf8', stdout=subprocess.PIPE).stdout.strip()


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


if __name__ == '__main__':
  unittest.main()
