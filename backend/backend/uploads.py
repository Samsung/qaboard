"""
Run files sent over HTTP, for runs that don't share a storage with the server (`storage: upload` in qaboard.yaml):
GitHub-hosted CI, laptops, clusters without the shared volume.

The server saves them in one folder, $QABOARD_UPLOAD_ROOT, and from there on they are files like those `qa` writes
in a shared storage: nginx serves them under /s/, the image server and the file browser read them, deleting runs and
the retention rules remove them. Nothing else in the server knows that they were uploaded.

  <upload root>/<project id>/-/<commit>/<batch>/<configurations>/<input>/<the run's files>

- The server chooses the run's folder (run_dir): clients only name files inside it (PUT /api/v1/output/<id>/files/<path>).
  What clients say about the run (its input, its configurations, its batch) only reaches the path as folder names
  the server makes (folder_name): never as paths, so nothing they send leads elsewhere. Before writing or deleting,
  the server checks that a folder is one it could have chosen for that project (is_run_dir).
- "-" separates the project from its runs, like in GitLab's URLs: the project of a file is read from its path
  (project_of), to know who can read it, and no sub-project's folder can be mistaken for a commit's.
- To keep some projects' files elsewhere (a bucket mounted on the server, another disk), admins add a storage location
  for them (backend/locations.py): their new runs go there, with the same layout under the location's folder, and
  store the location's URL ("s3://team-a/qaboard/<project>/-/..."). Their older runs stay where they are.
  Files are written and renamed inside the run's folder, never across folders: mounted buckets support that.

Docs: website/docs/backend-admin/uploads.mdx. API: upload_output_file and new_output_webhook in backend/api/outputs.py.
"""
import fcntl
import hashlib
import os
import re
import shutil
import uuid
from pathlib import Path, PurePosixPath
from typing import BinaryIO, List, Optional, Tuple

from qaboard.conventions import commit_dir_name, make_hash, slugify_hash

from . import config, locations
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


def bases(project_id: Optional[str] = None) -> List[Path]:
  """
  The folders where the server saved uploaded runs: every storage location's and the upload root. With a project,
  where its new runs go comes first (its most specific storage location, else the upload root): its older runs can
  be in any of them. Whether a location still takes new runs never changes who owns the files already there.
  """
  root = upload_root()
  routed = [location.path for location in locations.for_project(project_id.strip('/'))] if project_id else []
  everything = [*routed, *locations.paths(), *([root] if root is not None else [])]
  return list(dict.fromkeys(everything))


def overlaps_uploads(path) -> bool:
  """
  Whether a folder is in the folders of uploaded runs, or contains one of them: clients that save their results in a
  shared storage can't say their run is there, nor their artifacts. Symlinks are resolved.
  """
  candidates = {Path(os.path.normpath(path)), Path(os.path.realpath(path))}
  for base in bases():
    for real_base in {Path(os.path.normpath(base)), Path(os.path.realpath(base))}:
      if any(c == real_base or c.is_relative_to(real_base) or real_base.is_relative_to(c) for c in candidates):
        return True
  return False


def new_runs_base(project_id: str) -> Optional[Path]:
  """Where the project's new uploaded runs go, None if the server doesn't take them"""
  routed = locations.for_project(project_id.strip('/'))
  return routed[0].path if routed else upload_root()


def enabled(project_id: Optional[str] = None) -> bool:
  """Whether the server takes uploaded runs: of a project, or of any project"""
  if project_id is None:
    return upload_root() is not None or any(location.projects for location in locations.locations())
  return new_runs_base(project_id) is not None


def supports_project(project_id: str) -> bool:
  """Not the projects with a folder named like RUNS_FOLDER in their id: their files' project couldn't be read from paths"""
  return RUNS_FOLDER not in project_id.strip('/').split('/')


def folder_name(text, maxlength: int = 70) -> str:
  """
  One folder's name for what a client sent (an input's path, a batch's label, configurations): lowercase letters,
  digits, ".", "=" and "-", never a path, and never "." or "..". Names that are already like that are kept
  ("unit-tests"); the others get a hash of the text, so that "A/b" and "a-b" are two folders ("a-b-1f2e3d4c").
  """
  slug = slugify_hash(text, maxlength=maxlength).replace('/', '-').strip('.-')
  if isinstance(text, str) and slug == text and slug:
    return slug
  return f"{slug}-{make_hash(text)[:8]}".lstrip('-')


def project_runs_dir(project_id: str, base: Optional[Path] = None) -> Path:
  """The folder of a project's uploaded runs, where its new runs go (or in `base`, one of its `bases`)"""
  if base is None:
    base = new_runs_base(project_id)
    assert base is not None, "uploads aren't enabled for this project"
  return Path(base) / project_id.strip('/') / RUNS_FOLDER


def run_dir(project_id: str, hexsha: str, batch_label: str, platform: str, configurations: list, extra_parameters: dict, input_path: str, database: Optional[str] = None) -> Path:
  """
  Where the files of a run are saved, from what identifies it. Not the shared storage's layout to the letter: an
  input keeps its extension (code names runs "v1.2" and "v1.3"), and each level is one folder.
  """
  # runs outside git are attached to placeholder commits, like "<local:alice>"
  commit_dir = commit_dir_name(hexsha) if re.fullmatch(r'[0-9a-f]{40}', hexsha) else Path('local') / folder_name(hexsha)
  batch_dir = Path('output') if batch_label == 'default' else Path('output') / folder_name(batch_label, maxlength=32)
  # every run of the database has its own folder: all that tells runs apart is in the names
  # (the input's database too: runs on the same input path in two databases are two runs)
  configuration_dir = folder_name([platform, configurations or [], extra_parameters or {}, *([str(database)] if database else [])], maxlength=32)
  directory = project_runs_dir(project_id) / commit_dir / batch_dir / configuration_dir / folder_name(str(input_path))
  if not is_run_dir(directory, project_id):
    raise UploadError(400, "This run can't be saved by the server: its project, batch or input have names that aren't folders' names.", "invalid_run")
  return directory


def is_run_dir(directory, project_id: str) -> bool:
  """
  Whether a folder is one the server could have chosen for a run of the project: under the project's uploaded runs,
  said without "..", symlinks aside (save_file and clean_run_dir check where they really are).
  What the database says a run's folder is isn't enough: other clients say where they saved theirs.
  """
  if not directory or not project_id or not supports_project(project_id) or os.path.normpath(str(directory)) != str(directory):
    return False
  return _runs_dir_of(Path(directory), project_id) is not None


def _runs_dir_of(directory: Path, project_id: str) -> Optional[Path]:
  """The folder of the project's uploaded runs that `directory` is in, if it is in one"""
  for base in bases(project_id):
    runs_dir = project_runs_dir(project_id, base)
    if directory != runs_dir and directory.is_relative_to(runs_dir):
      return runs_dir
  return None


def project_of(path: str) -> Optional[Tuple[str, str]]:
  """(the project's folder, its id) for the files of a project's uploaded runs, else None. `path` is normalized."""
  found = []
  for base in bases():
    base = PurePosixPath(os.path.normpath(base))
    try:
      parts = PurePosixPath(path).relative_to(base).parts
    except ValueError:
      continue
    if RUNS_FOLDER in parts[1:]:
      project_parts = parts[:parts.index(RUNS_FOLDER, 1)]
      found.append((str(PurePosixPath(base, *project_parts)), '/'.join(project_parts)))
  # with a location's folder inside another's, the most specific one
  return max(found, key=lambda f: len(f[0]), default=None)


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


def clean_run_dir(directory: Path, project_id: str) -> None:
  """Removes what a run of the project that starts again left in its folder. The folder stays."""
  runs_dir = _runs_dir_of(directory, project_id) if is_run_dir(directory, project_id) else None
  if runs_dir is None or not directory.is_dir():
    return
  # a symlink above the folder (they aren't ours) must not take us out of the project's runs
  if not Path(os.path.realpath(directory)).is_relative_to(os.path.realpath(runs_dir)):
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
