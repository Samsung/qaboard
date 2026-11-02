"""
Tests for `qa init`, which fills qaboard.yaml from the git remote
"""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import yaml

from tests.test_git import git


class TestInitFromGitRemote(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.tmp = Path(tmp.name)
    self.repo = self.tmp / 'repo'
    self.repo.mkdir()
    git('init', '-q', cwd=self.repo)
    git('symbolic-ref', 'HEAD', 'refs/heads/main', cwd=self.repo)
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first commit', cwd=self.repo)

  def qa_init(self):
    # Lazy import, see tests/test_config.py
    from qaboard.init import qa_init
    previous_cwd = os.getcwd()
    os.chdir(self.repo)
    try:
      # without the site defaults, if any are installed
      with mock.patch('qaboard.init.site_qaboard_config', return_value={}):
        qa_init(SimpleNamespace(obj={'dryrun': False}))
    finally:
      os.chdir(previous_cwd)
    text = (self.repo / 'qaboard.yaml').read_text()
    return text, yaml.safe_load(text)

  def test_unreachable_remote(self):
    git('remote', 'add', 'origin', 'git@gitlab.example.com:group/project.git', cwd=self.repo)
    # Like without network, or credentials: `git remote show origin` fails
    with mock.patch.dict(os.environ, {'GIT_SSH_COMMAND': 'false'}):
      _, config = self.qa_init()
    self.assertEqual(config['project']['name'], 'group/project')
    self.assertEqual(config['project']['url'], 'git@gitlab.example.com:group/project.git')
    self.assertEqual(config['project']['reference_branch'], 'master')

  def test_remote_head_branch(self):
    remote = self.tmp / 'remote.git'
    git('init', '-q', '--bare', str(remote), cwd=self.tmp)
    git('remote', 'add', 'origin', str(remote), cwd=self.repo)
    git('push', '-q', 'origin', 'main', cwd=self.repo)
    git('--git-dir', str(remote), 'symbolic-ref', 'HEAD', 'refs/heads/main', cwd=self.tmp)
    text, config = self.qa_init()
    self.assertEqual(config['project']['reference_branch'], 'main')
    self.assertIn('reference_branch: main #', text)
    self.assertEqual(config['project']['url'], str(remote))


if __name__ == '__main__':
  unittest.main()
