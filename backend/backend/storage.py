"""
Clients tell QA-Board where they saved their outputs and artifacts, in unauthenticated API calls.
Before writing, deleting or running code in those folders, the server checks they are inside
the storage roots ($QABOARD_STORAGE_ROOTS), and that they are not one of its own folders.

Paths are checked once their symlinks are resolved, but they can change after the check:
users who can write in the storage can still point the server elsewhere with symlinks.
"""
import os
import pwd
from pathlib import Path

from .config import storage_roots, qaboard_data_dir, qaboard_data_shared_dir, qaboard_data_git_dir


class UnsafePathError(ValueError):
  pass


def _real(path) -> Path:
  return Path(os.path.realpath(path))


def private_dirs():
  """The server's own folders: its data, and its user's home (ssh keys...)"""
  dirs = [
    qaboard_data_dir,
    qaboard_data_shared_dir,
    qaboard_data_git_dir,
    os.environ.get('QABOARD_IMAGE_CACHE_DIR', qaboard_data_dir / 'cache' / 'images'),
  ]
  try:
    dirs.append(pwd.getpwuid(os.getuid()).pw_dir)
  except KeyError:
    pass
  return [_real(d) for d in dirs]


def check_storage_path(path) -> Path:
  """Returns `path` if the server may write, delete or run code there, raises UnsafePathError otherwise."""
  real = _real(path)
  if not any(real != root and real.is_relative_to(root) for root in map(_real, storage_roots)):
    raise UnsafePathError(f"{path} is not inside the storage folders that QA-Board manages ($QABOARD_STORAGE_ROOTS)")
  for private_dir in private_dirs():
    if real.is_relative_to(private_dir) or private_dir.is_relative_to(real):
      raise UnsafePathError(f"{path} is one of the QA-Board server's own folders")
  return Path(path)


def is_storage_path(path) -> bool:
  try:
    check_storage_path(path)
    return True
  except UnsafePathError:
    return False


def check_inside(path, parent) -> Path:
  """
  Returns `path` if it is inside `parent` (e.g. a file listed in a manifest), raises UnsafePathError otherwise.
  A symlink in `parent` is inside it, wherever it points to: rmtree deletes the link, not its target.
  """
  path = Path(path)
  real_path = Path(os.path.normpath(_real(path.parent) / path.name))
  if not real_path.is_relative_to(_real(parent)):
    raise UnsafePathError(f"{path} is not inside {parent}")
  return Path(path)
