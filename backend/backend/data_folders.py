"""
Data folders: folders QA-Board reads but never changes, e.g. the datasets of projects' inputs (/mnt/nas/datasets).
Admins add them in the web app (Admin → Storage → Data folders) or with `qaboard-admin data-folders`.

The server's folders come in two kinds, and every check says which one it needs:
- **managed**: the storage roots ($QABOARD_STORAGE_ROOTS) and the storage locations' folders (backend/locations.py).
  Runs are written there, deletes and cleanups delete files there, scans and storage usage count them.
  `storage.check_storage_path` / `storage.is_storage_path` (all_storage_roots) are the only checks before writing,
  deleting or running code: data folders are never part of them.
- **readable**: the managed folders and the data folders, minus the server's own folders. Thumbnails, the input
  file endpoint, the image and video viewers and the file browser's listings read there: `files.is_readable`.

They are kept as a setting (backend/settings.py, `storage.data_folders`: in the settings table, cached a few seconds
per process), but edited only here, so each change records `data_folder.add` / `data_folder.remove`.

Who adds them is an admin's session in the web app, so what it can open is limited: never "/", nor the server's own
folders (storage.private_dirs, its code, its key file) or a folder in them, nor the system's folders (SYSTEM_DIRS,
e.g. /proc/self/environ has the server's secrets) or a folder in or around them. A data folder can contain the
server's own folders (e.g. /home): they stay unreadable in it. This is checked again for each file, symlinks
resolved: a data folder later replaced by a symlink to /etc reads nothing.
"""
import os
from pathlib import Path
from typing import Callable, List, Optional

KEY = 'storage.data_folders'

# The system's folders: an admin's session must not read the server's secrets, configuration or processes.
# A data folder can't be one, be inside one, or contain one (/var contains /var/lib).
SYSTEM_DIRS = tuple(Path(p) for p in (
  '/proc', '/sys', '/dev', '/etc', '/run', '/var/run', '/boot', '/root', '/usr', '/bin', '/sbin', '/lib', '/lib32',
  '/lib64', '/libx32', '/var/lib', '/var/log', '/var/spool', '/var/cache', '/snap',
))
# Too wide to be a data folder themselves, where every process leaves files: their sub-folders are fine
TOO_WIDE = ('/', '/tmp', '/var/tmp', '/var')
# The server's code and its configuration (Docker: /qaboard)
CODE_DIR = Path(__file__).resolve().parents[2]


class DataFolderError(ValueError):
  """A change admins asked for that we refuse, with what to do instead"""
  def __init__(self, message: str, reason: str = 'invalid'):
    super().__init__(message)
    self.reason = reason  # invalid, not_found, exists, forbidden, not_a_folder


def _real(path) -> Path:
  return Path(os.path.realpath(path))


def system_dirs() -> List[Path]:
  return list(dict.fromkeys([*SYSTEM_DIRS, *(_real(d) for d in SYSTEM_DIRS)]))


def own_dirs() -> List[Path]:
  """The server's own folders (storage.private_dirs: its data, its home), its code and its secret files"""
  from .storage import private_dirs
  dirs = [*private_dirs(), CODE_DIR]
  key_file = os.environ.get('QABOARD_ENCRYPTION_KEY_FILE', '').strip()
  if key_file:
    dirs.append(_real(key_file))
  return list(dict.fromkeys(dirs))


def forbidden_dirs() -> List[Path]:
  """What a data folder never reads, symlinks resolved"""
  return [*own_dirs(), *system_dirs()]


def check_path(path, check: bool = True) -> str:
  """A data folder, normalized, or a DataFolderError"""
  if not isinstance(path, str) or not path.strip():
    raise DataFolderError("Which folder? Give its absolute path, e.g. /mnt/nas/datasets.")
  path = path.strip()
  if '\0' in path or not os.path.isabs(path):
    raise DataFolderError(f"{path} must be an absolute path, e.g. /mnt/nas/datasets.")
  normalized = os.path.normpath(path)
  if normalized.startswith('//'):  # POSIX keeps a leading "//"
    normalized = '/' + normalized.lstrip('/')
  if normalized in TOO_WIDE or str(_real(normalized)) in TOO_WIDE:
    raise DataFolderError(f"{path} would let QA-Board read too many of the server's files: add the folders of your data instead.")
  for candidate in {Path(normalized), _real(normalized)}:
    for d in own_dirs():
      # a folder containing them is fine (e.g. /home): they stay unreadable in it
      if candidate.is_relative_to(d):
        raise DataFolderError(f"{path} is one of the QA-Board server's own folders ({d}), or inside one.", 'forbidden')
    for d in system_dirs():
      if candidate.is_relative_to(d) or d.is_relative_to(candidate):
        raise DataFolderError(f"{path} is, contains or is inside one of the system's folders ({d}).", 'forbidden')
  if check and not _real(normalized).is_dir():
    raise DataFolderError(f"{path} isn't a folder the server sees: mount it there first, in the backend, the proxy and the image server.", 'not_a_folder')
  return normalized


def check_setting(value) -> None:
  """For backend/settings.py: raises ValueError"""
  for path in value:
    try:
      check_path(path, check=False)
    except DataFolderError as e:
      raise ValueError(f"has an invalid folder: {e}")


def paths() -> List[str]:
  """The data folders, as admins added them"""
  from .settings import setting
  try:
    value = setting(KEY)
  except Exception:  # e.g. no database: the server works without
    return []
  return [p for p in value or [] if isinstance(p, str)]


def contains(real: Path) -> bool:
  """
  Whether a data folder lets the server read `real` (symlinks already resolved), never in a forbidden folder.
  Only for reading: what QA-Board may change is `storage.check_storage_path`.
  """
  matched = False
  for folder in paths():
    try:
      folder_real = _real(folder)
    except (OSError, ValueError):
      continue
    if str(folder_real) in TOO_WIDE:  # e.g. replaced by a symlink to / since it was added
      continue
    if real == folder_real or real.is_relative_to(folder_real):
      matched = True
      break
  if not matched:
    return False
  return not any(real == d or real.is_relative_to(d) for d in forbidden_dirs())


# ==========================================
# Changes, from the admin API and `qaboard-admin data-folders`. Callers commit.
def add(path: str, check: bool = True, by=None, record: Optional[Callable] = None) -> str:
  from . import settings
  from .audit import audit
  path = check_path(path, check)
  current = paths()
  if path in current:
    raise DataFolderError(f"{path} is already a data folder.", 'exists')
  settings.save(KEY, [*current, path], by=by)
  (record or audit)('data_folder.add', target_type='data_folder', target_id=path, target_label=path)
  return path


def remove(path: str, by=None, record: Optional[Callable] = None) -> str:
  from . import settings
  from .audit import audit
  current = paths()
  if isinstance(path, str) and path not in current and path.startswith('/'):
    path = os.path.normpath(path)
  if path not in current:
    raise DataFolderError(f"{path} isn't a data folder.", 'not_found')
  remaining = [p for p in current if p != path]
  settings.save(KEY, remaining or None, by=by)
  (record or audit)('data_folder.remove', target_type='data_folder', target_id=path, target_label=path)
  return path


def in_storage(path: str) -> bool:
  """Whether QA-Board already manages (and so reads) the folder: inside a storage root or a storage location"""
  from .storage import all_storage_roots
  real = _real(path)
  return any(real.is_relative_to(_real(root)) for root in all_storage_roots())


def serialize(path: str) -> dict:
  return {"path": path, "reachable": Path(path).is_dir(), "in_storage": in_storage(path)}
