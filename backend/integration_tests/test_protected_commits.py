"""The commits that qaboard.yaml protects from deletion (Project.protected_ref_commits), read from the project's clone"""
import subprocess

import pytest


def git(repo, *args):
  return subprocess.run(['git', '-C', str(repo), '-c', 'user.name=a', '-c', 'user.email=a@example.com', *args],
                        check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def clone(tmp_path, monkeypatch):
  """A repository with commits on master, a branch, tags, and how many times the project opened it"""
  from git import Repo
  from backend.models import Project
  repo = tmp_path / 'repo'
  repo.mkdir()
  git(repo, 'init', '-b', 'master')
  commits = {}
  for name in ('tagged', 'light', 'odd', 'branch', 'latest'):
    git(repo, 'commit', '--allow-empty', '-m', name)
    commits[name] = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'tag', '-a', 'v1', '-m', 'release', commits['tagged'])
  git(repo, 'tag', 'v2', commits['light'])
  # a tag named like a remote branch
  git(repo, 'tag', '-a', 'origin/feature', '-m', 'odd', commits['odd'])
  git(repo, 'branch', 'feature', commits['branch'])
  for i in range(50):
    git(repo, 'tag', f'other-{i}', commits['tagged'])
  opened = []
  def open_repo(self):
    opened.append(self.id)
    return Repo(str(repo))
  monkeypatch.setattr(Project, 'repo', property(open_repo))
  return commits, opened


def test_protected_ref_commits(clone):
  from backend.models import Project
  commits, opened = clone
  project = Project(id='group/repo', data={'qatools_config': {'project': {
    # a commit (the same as the branch's), and "feature", which also protects the tag origin/feature
    'reference_branch': 'master', 'milestones': ['v1', 'v2', 'feature', 'does-not-exist', commits['branch'][:10]],
  }}})
  protected = project.protected_ref_commits
  assert set(protected) == {commits['latest'], commits['tagged'], commits['light'], commits['branch'], commits['odd']}
  assert len(protected) == len(set(protected))
  assert opened == ['group/repo']


def test_without_clone(monkeypatch):
  from backend.models import Project
  monkeypatch.setattr(Project, 'repo', property(lambda self: None))
  assert Project(id='group/repo', data={}).protected_ref_commits == []


def test_cache(clone):
  """Within protected_ref_commits_cache(), projects that share a clone and refs read it once, with the same results"""
  from backend.models import Project
  from backend.models.Project import protected_ref_commits_cache
  commits, opened = clone
  config = {'qatools_config': {'project': {'reference_branch': 'master', 'milestones': ['v1']}}}
  def subproject(name, data=config):
    return Project(id=f'group/repo/{name}', data={**data, 'git': {'path_with_namespace': 'group/repo'}})
  expected = subproject('a').protected_ref_commits
  assert set(expected) == {commits['latest'], commits['tagged']}
  opened.clear()
  with protected_ref_commits_cache():
    assert subproject('a').protected_ref_commits == expected
    with protected_ref_commits_cache():  # nested: the same cache
      assert subproject('b').protected_ref_commits == expected
    # a caller changing the list doesn't change the cache
    subproject('c').protected_ref_commits.append('x')
    assert subproject('c').protected_ref_commits == expected
    assert len(opened) == 1
    # other refs (any value in qaboard.yaml), another computation
    other = subproject('d', {'qatools_config': {'project': {'reference_branch': 'master', 'milestones': [{'odd': 1}]}}})
    assert other.protected_ref_commits == [commits['latest']]
    assert len(opened) == 2
  # without the cache: computed again
  assert subproject('a').protected_ref_commits == expected
  assert len(opened) == 3
