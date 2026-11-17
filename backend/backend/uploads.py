"""
Run files sent over HTTP, for runs that don't share a storage with the server (`storage: upload` in qaboard.yaml):
GitHub-hosted CI, laptops, clusters without the shared volume.

The server saves them in one folder, $QABOARD_UPLOAD_ROOT, and from there on they are files like those `qa` writes
in a shared storage: nginx serves them under /s/, the image server and the file browser read them, deleting runs and
the retention rules remove them. Nothing else in the server knows that they were uploaded.

  <upload root>/<project id>/-/<commit>/<batch>/<configurations>/<input>/<the run's files>

- The server chooses the run's folder (run_dir): clients only name files inside it (PUT /api/v1/output/<id>/files/<path>).
- "-" separates the project from its runs, like in GitLab's URLs: the project of a file is read from its path
  (project_of), to know who can read it, and no sub-project's folder can be mistaken for a commit's.
- To keep some projects' files elsewhere (another disk, a bucket mounted as a folder), mount it at
  <upload root>/<project id> or above: files are written and renamed inside the run's folder, never across folders.

Docs: website/docs/backend-admin/uploads.mdx. API: backend/api/uploads.py.
"""
import fcntl
import hashlib
import os
import re
import shutil
import uuid
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Optional, Tuple

from qaboard.conventions import batch_folder_name, commit_dir_name, slugify

from . import config
from .storage import check_inside, UnsafePathError

# Between a project's folder and its runs'
RUNS_FOLDER = '-'
# Files being received, next to where they will be: clients can't name files like this
TEMPORARY_PREFIX = '.qaboard-upload-'
MAX_PATH_LENGTH = 1024
MAX_NAME_LENGTH = 255
CHUNK_SIZE = 1024 * 1024


class UploadError(Exception):
  """A file we refuse, as the API answers it: an HTTP status, a message for the user, a reason for programs"""
  def __init__(self, status: int, message: str, reason: str, **details):
    super().__init__(message)
    self.status = status
    self.reason = reason
    self.details = details


def upload_root() -> Optional[Path]:
  return config.upload_root


def enabled() -> bool:
  return upload_root() is not None


def supports_project(project_id: str) -> bool:
  """Not the projects with a folder named like RUNS_FOLDER in their id: their files' project couldn't be read from paths"""
  return RUNS_FOLDER not in project_id.strip('/').split('/')


def run_dir(project_id: str, hexsha: str, batch_label: str, output_folder: str) -> Path:
  """Where the files of a run are saved. `output_folder`: the run's folder in its batch (Output.output_folder)"""
  root = upload_root()
  assert root is not None
  # runs outside git are attached to placeholder commits, like "<local:alice>"
  commit_dir = commit_dir_name(hexsha) if re.fullmatch(r'[0-9a-f]{40}', hexsha) else Path('local') / (slugify(hexsha) or 'commit')
  return root / project_id.strip('/') / RUNS_FOLDER / commit_dir / batch_folder_name(batch_label) / output_folder


def project_of(path: str) -> Optional[Tuple[str, str]]:
  """(the project's folder, its id) for the files of a project's uploaded runs, else None. `path` is normalized."""
  root = upload_root()
  if root is None:
    return None
  try:
    parts = PurePosixPath(path).relative_to(PurePosixPath(os.path.normpath(root))).parts
  except ValueError:
    return None
  if RUNS_FOLDER not in parts[1:]:
    return None
  project_parts = parts[:parts.index(RUNS_FOLDER, 1)]
  return str(PurePosixPath(os.path.normpath(root), *project_parts)), '/'.join(project_parts)


def clean_path(path: str) -> PurePosixPath:
  """The path of a file in its run's folder, as clients name it: relative, with "/", no way out of the folder"""
  if not isinstance(path, str) or not path or '\0' in path or '\\' in path or len(path) > MAX_PATH_LENGTH:
    raise UploadError(400, f"Files are named by their path in the run's folder, like \"plots/loss.png\", of at most {MAX_PATH_LENGTH} characters.", "invalid_path")
  parts = path.split('/')
  if any(part in ('', '.', '..') or len(part.encode()) > MAX_NAME_LENGTH for part in parts):
    raise UploadError(400, f"{path!r} is not a path inside the run's folder: no empty, \".\" or \"..\" parts, and names of at most {MAX_NAME_LENGTH} bytes.", "invalid_path")
  if parts[-1].startswith(TEMPORARY_PREFIX):
    raise UploadError(400, f"Files can't be named {TEMPORARY_PREFIX}*: the server names the files it is receiving like this.", "invalid_path")
  return PurePosixPath(*parts)


def clean_run_dir(directory: Path) -> None:
  """Removes what a run that starts again left in its folder. The folder stays."""
  root = upload_root()
  if root is None or not Path(os.path.realpath(directory)).is_relative_to(os.path.realpath(root)) or not directory.is_dir():
    return
  for entry in os.scandir(directory):
    if entry.is_dir(follow_symlinks=False):
      shutil.rmtree(entry.path, ignore_errors=True)
    else:
      try:
        os.unlink(entry.path)
      except OSError:
        pass


def _copy(source: BinaryIO, target: BinaryIO, length: int, sha256: Optional[str]) -> None:
  """Copies exactly `length` bytes, and checks their SHA-256 when the client sent it"""
  digest = hashlib.sha256()
  left = length
  while left > 0:
    chunk = source.read(min(CHUNK_SIZE, left))
    if not chunk:
      raise UploadError(400, f"The upload stopped {left} bytes before its end (Content-Length: {length}).", "incomplete")
    target.write(chunk)
    digest.update(chunk)
    left -= len(chunk)
  if sha256 and digest.hexdigest() != sha256.lower():
    raise UploadError(422, f"What the server received doesn't have the SHA-256 the client sent ({digest.hexdigest()}, not {sha256.lower()}).", "digest_mismatch")


def save_file(directory: Path, path: str, source: BinaryIO, length: int, sha256: Optional[str] = None, offset: Optional[int] = None) -> int:
  """
  Saves a file of a run, whose folder is `directory`, from `length` bytes of `source`. Returns the file's size.
  - Without `offset`, the file is replaced, at once: who reads it gets the previous file or the new one.
  - With `offset`, the bytes are added at the end of the file, which must have that size (0: no file yet): for the
    files runs append to, like log.txt. Else UploadError 409, with the file's `size`: the client sends it whole.
  Raises UploadError for what we refuse.
  """
  relative = clean_path(path)
  if length < 0 or (offset or 0) < 0:
    raise UploadError(400, "The file's size and offset can't be negative.", "invalid_size")
  if (offset or 0) + length > config.upload_max_file_size:
    raise UploadError(413, f"{path} is larger than what this server accepts ({config.upload_max_file_size // 1024**2} MB). Save big files in a storage shared with the server, or ask its administrators to raise QABOARD_UPLOAD_MAX_FILE_MB.", "too_large", max_file_size=config.upload_max_file_size)
  target = directory / relative
  try:
    target.parent.mkdir(parents=True, exist_ok=True)
    # a symlink in the folder (they aren't ours) must not take the file elsewhere
    check_inside(target, directory)
    if shutil.disk_usage(target.parent).free - length < config.upload_min_free_space:
      raise UploadError(507, "The server's storage for uploaded files is full: tell its administrators.", "storage_full")
    if offset is None:
      _replace(target, source, length, sha256)
      return length
    return _append(target, source, length, sha256, offset)
  except UnsafePathError:
    raise UploadError(400, f"{path!r} is not a path inside the run's folder.", "invalid_path") from None
  except (IsADirectoryError, NotADirectoryError, FileExistsError):
    raise UploadError(409, f"{path} can't be both a file and a folder of the run.", "path_conflict") from None


def _replace(target: Path, source: BinaryIO, length: int, sha256: Optional[str]) -> None:
  temporary = target.with_name(f"{TEMPORARY_PREFIX}{uuid.uuid4().hex}")
  try:
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644), 'wb') as f:
      _copy(source, f, length, sha256)
    if target.is_dir() and not target.is_symlink():
      raise IsADirectoryError(target)
    os.replace(temporary, target)
  finally:
    try:
      os.unlink(temporary)
    except OSError:
      pass


def _append(target: Path, source: BinaryIO, length: int, sha256: Optional[str], offset: int) -> int:
  with os.fdopen(os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o644), 'r+b') as f:
    # one writer at a time: the size we check is the size we write at
    fcntl.flock(f, fcntl.LOCK_EX)
    size = os.fstat(f.fileno()).st_size
    if size != offset:
      raise UploadError(409, f"The file has {size} bytes, not {offset}: send it whole.", "offset_mismatch", size=size)
    f.seek(offset)
    try:
      _copy(source, f, length, sha256)
    except UploadError:
      f.truncate(offset)
      raise
    return offset + length
