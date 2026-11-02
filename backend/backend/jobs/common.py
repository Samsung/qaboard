"""
What the storage jobs share: knowing what's missing on disk without being fooled by storage that isn't mounted,
and what must never be deleted (milestones).
"""
import io
import os
import contextlib
from pathlib import Path
from typing import List

from ..database import db_session
from ..models import Project, CiCommit
from . import params as p


def matching_projects(params: dict) -> List[str]:
  ids = [project_id for (project_id,) in db_session.query(Project.id).order_by(Project.id)]
  return [i for i in ids if p.matches(i, params['projects'], params['exclude_projects'])]


@contextlib.contextmanager
def quiet():
  """rmtree prints every file it deletes: millions of lines we don't want in the logs"""
  with contextlib.redirect_stdout(io.StringIO()):
    yield


def lexists(path) -> bool:
  """Whether the path exists. When we can't tell (e.g. no permission to look), we say it does: we'll try to delete it and report the error."""
  try:
    os.lstat(path)
    return True
  except (FileNotFoundError, NotADirectoryError):
    return False
  except OSError:
    return True


class StorageUnavailable(Exception):
  """A folder is missing so close to a storage root that the storage may just not be mounted"""
  def __init__(self, message, path):
    super().__init__(message)
    self.path = path


def storage_root(path: Path):
  from ..config import storage_roots
  matches = [root for root in storage_roots if path == root or path.is_relative_to(root)]
  return max(matches, key=lambda root: len(root.parts)) if matches else None


class Folders:
  """
  Whether folders exist, remembering the missing ones: what they would contain is missing too, without checking.

  When storage isn't mounted (autofs, NFS outage...), everything in it looks missing: we'd delete the metadata of
  runs whose files are fine. So a folder missing right under a storage root ($QABOARD_STORAGE_ROOTS), or in an empty
  or missing storage root, raises StorageUnavailable instead of answering "missing".
  `outside_storage`: what we answer for folders outside the storage roots, where we can't tell.
  """
  def __init__(self, max_missing=100_000):
    self.missing = set()
    self.max_missing = max_missing
    self.checks = 0
    self.roots_ok = {}

  def root_is_available(self, root: Path) -> bool:
    if root not in self.roots_ok:
      try:
        self.roots_ok[root] = root.is_dir() and any(True for _ in root.iterdir())
      except OSError:
        self.roots_ok[root] = False
    return self.roots_ok[root]

  def exists(self, path, outside_storage=False) -> bool:
    path = Path(path)
    if any(str(parent) in self.missing for parent in (path, *path.parents)):
      return False
    self.checks += 1
    if lexists(path):
      return True
    # the highest missing folder: its other subfolders are missing too
    top = path
    for parent in path.parents:
      if parent == parent.parent:
        break
      self.checks += 1
      if lexists(parent):
        break
      top = parent
    root = storage_root(top)
    if root is None:
      if not outside_storage:
        raise StorageUnavailable(f"{path} is missing, but it's outside the storage roots ($QABOARD_STORAGE_ROOTS): we can't tell if it was deleted or isn't mounted", path)
      return False
    if not self.root_is_available(root):
      raise StorageUnavailable(f"The storage {root} is missing or empty: is it mounted?", path)
    if len(top.relative_to(root).parts) < 2:
      raise StorageUnavailable(f"{top} is missing, right under the storage root {root}: is it mounted?", path)
    if len(self.missing) > self.max_missing:
      self.missing.clear()
    self.missing.add(str(top))
    return False


class SkipProject(Exception):
  pass


class Protection:
  """What we must not delete in a project: its milestones"""
  def __init__(self, project: Project):
    self.project_id = project.id
    self.milestone_batches = project.milestone_batches
    self.commits = set()
    config = (project.data or {}).get('qatools_config') or {}
    project_config = (config.get('project') or {}) if isinstance(config, dict) else {}
    if not isinstance(project_config, dict):
      project_config = {}
    milestones = project_config.get('milestones') or []
    self.reference = project_config.get('reference_branch') or 'master'
    self.protected_refs = [self.reference, *([milestones] if isinstance(milestones, str) else milestones)]
    repo = project.repo if milestones else None
    if milestones and not repo:
      raise SkipProject("could not read its git repository, to know the commits that qaboard.yaml's project.milestones protect")
    if repo:
      self.commits.update(project.protected_ref_commits)
    else:
      # without git: the latest commit we know on the reference branch
      latest = (db_session.query(CiCommit.hexsha)
                .filter(CiCommit.project_id == project.id, CiCommit.branch.in_([self.reference, f'origin/{self.reference}']))
                .order_by(CiCommit.authored_datetime.desc().nullslast()).first())
      if latest:
        self.commits.add(latest[0])

  def protects(self, hexsha: str, label: str) -> bool:
    """Whether a batch is protected"""
    return hexsha in self.commits or label in self.milestone_batches.of_commit(self.project_id, hexsha)

  def protects_commit(self, hexsha: str) -> bool:
    """Whether a commit's artifacts are protected: they're needed to redo or compare its milestones"""
    return hexsha in self.commits or bool(self.milestone_batches.of_commit(self.project_id, hexsha))
