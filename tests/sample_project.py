"""
A copy of qaboard/sample_project for the tests that run `qa` in it (not a test module: green collects test*.py).

Tests used to run in qaboard/sample_project itself: they left runs in its output/ that other tests depended on,
and since it is in this repository, the checkout's uncommitted changes changed where runs saved their outputs
(qa records local changes, and CI-mode runs use the commit of this checkout). The copy is a git repository of its
own, with one commit and nothing uncommitted.
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Optional
from unittest import mock

root_repo = Path(__file__).resolve().parent.parent
source = root_repo / 'qaboard' / 'sample_project'


def shared_tmp_dir() -> Optional[str]:
  """
  Where the copies go. Runs on LSF are executed on other hosts, that don't see this machine's /tmp: with LSF (bsub on
  the PATH), the copies go in the checkout, which CI machines share with the LSF hosts. $QA_TESTS_TMPDIR overrides.
  None: the system's temporary folder.
  """
  if os.environ.get('QA_TESTS_TMPDIR'):
    return os.environ['QA_TESTS_TMPDIR']
  return str(root_repo) if shutil.which('bsub') else None


def git(cwd, *args):
  return subprocess.run(
    ['git', '-c', 'user.name=QA-Board tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', *args],
    cwd=cwd, check=True, capture_output=True, encoding='utf-8',
  ).stdout.strip()


def copy_sample_project(tmp: Path, files: Optional[Dict[str, str]] = None) -> Path:
  """
  qaboard/sample_project, without what earlier runs left in it, committed in its own git repository at tmp/sample_project.
  `files`: more files to commit with it ({path relative to the project: text}), so that runs see no local changes.
  """
  project = tmp / 'sample_project'
  shutil.copytree(source, project, ignore=shutil.ignore_patterns('output', '__pycache__', '*.batches.yaml'))
  for path, text in (files or {}).items():
    (project / path).write_text(text)
  git(project, 'init', '-q', '.')
  git(project, 'add', '.')
  git(project, 'commit', '-q', '-m', 'The sample project')
  return project


def sample_project_class_fixture(cls: type, files: Optional[Dict[str, str]] = None, **environ: str) -> Path:
  """
  From a setUpClass: a copy of the sample project, with a storage next to it (QA_STORAGE) and `environ`, all undone
  after the class. Returns the project. The class's tests chdir to it (`qa` chdirs without restoring the cwd),
  and call forget_runs(cls) in their setUp.
  """
  shared = shared_tmp_dir()
  tmp = tempfile.TemporaryDirectory(prefix='.tests-', dir=shared)
  cls.addClassCleanup(tmp.cleanup)
  if shared:
    # TemporaryDirectory is 0700: jobs that LSF's wrappers run as another user couldn't create the runs' folders
    os.chmod(tmp.name, os.stat(shared).st_mode & 0o777)
  root = Path(tmp.name).resolve()
  project = copy_sample_project(root, files)
  (root / 'storage').mkdir()
  cls.storage = root / 'storage'
  previous_cwd = os.getcwd()
  cls.addClassCleanup(os.chdir, previous_cwd)
  patch = mock.patch.dict(os.environ, {'QA_STORAGE': str(cls.storage), **environ})
  patch.start()
  cls.addClassCleanup(patch.stop)
  return project



def forget_runs(cls: type):
  """From a setUp: no runs in the copy's output/ or in the storage, whatever the class's other tests did"""
  for output in (cls.project_dir / 'output', *cls.project_dir.glob('*/output')):  # the subproject's too
    shutil.rmtree(output, ignore_errors=True)
  for path in cls.storage.iterdir():
    shutil.rmtree(path) if path.is_dir() else path.unlink()
