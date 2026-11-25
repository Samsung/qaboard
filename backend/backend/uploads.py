"""
Run files sent over HTTP, for runs that don't share a storage with the server (`storage: upload` in qaboard.yaml):
GitHub-hosted CI, laptops, clusters without the shared volume.

The server saves them in one folder, $QABOARD_UPLOAD_ROOT, and from there on they are files like those `qa` writes
in a shared storage: nginx serves them under /s/, the image server and the file browser read them, deleting runs and
the retention rules remove them. Nothing else in the server knows that they were uploaded.

  <upload root>/<project id>/-/<commit>/<batch>/<configurations>/<input>/<the run's files>
  <upload root>/<project id>/-/<commit>/artifacts/<the repository's files that `qa save-artifacts` sends>

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

A commit's artifacts (qaboard.yaml, batch files, binaries: what runs QA-Board starts need) are saved the same way, in
the commit's folder (commit_artifacts_dir), with the repository's layout: the server reads them like artifacts in a
shared storage (backend/artifacts.py), and pods without that storage fetch them (qaboard/commit_artifacts.py).

Docs: website/docs/backend-admin/uploads.mdx. API: upload_output_file and new_output_webhook in backend/api/outputs.py.
"""
import logging
import fcntl
import hashlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path, PurePosixPath
from typing import BinaryIO, List, Optional, Tuple

from qaboard.conventions import make_hash, slugify_hash, Reason

from . import config, locations
from .storage import check_inside, UnsafePathError

logger = logging.getLogger(__name__)

# Between a project's folder and its runs'
RUNS_FOLDER = '-'
# Next to the batches' folders ("output", "output/<label>") in a commit's folder: its artifacts
ARTIFACTS_FOLDER = 'artifacts'
# Files being received, next to where they will be: clients can't name files like this
TEMPORARY_PREFIX = '.qaboard-upload-'
MAX_PATH_LENGTH = 1024
MAX_NAME_LENGTH = 255
CHUNK_SIZE = 1024 * 1024
# The hash that tells apart texts with the same folder name: long enough that no one can find another text with it
HASH_LENGTH = 16
# Names that end like a folder name with a hash, 16 characters or the 8 of older folders: hashed too, else "A/b" and
# its folder name "a-b-<hash>" would be one folder. So are names that end with 8 hexadecimal digits, like build-20261119
HASHED_NAME = re.compile(r'.*-[0-9a-f]{8}(?:[0-9a-f]{8})?')


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
  The folders where the server saved uploaded runs: every storage location's, the default one (the upload root)
  included. With a project, where its new runs go comes first: its older runs can be in any of them. Whether a
  location still takes new runs never changes who owns the files already there.
  """
  routed = [location.path for location in locations.for_project(project_id.strip('/'))] if project_id else []
  return list(dict.fromkeys([*routed, *locations.paths()]))


def overlaps_uploads(path, project_ids) -> bool:
  """
  Whether clients that save results in a shared storage may not say their run, or their artifacts, are in `path`:
  deleting them would delete uploaded runs. That is a folder in a project's uploaded runs (<project>/-/...), a folder
  above them (the project's, its group's, the uploads folder or above it), symlinks resolved. The uploads folder can
  also be a storage that runs write to directly, under <project>/<commit>/...: those folders are fine.
  `project_ids`: all the projects, whose uploaded runs may be there, or a function that gives them (called only for
  folders in the uploads folder).
  """
  candidates = {Path(os.path.normpath(path)), Path(os.path.realpath(path))}
  ids: Optional[List[str]] = None
  for candidate in candidates:
    if project_of(str(candidate)):
      return True
  for base in bases():
    for real_base in {Path(os.path.normpath(base)), Path(os.path.realpath(base))}:
      for candidate in candidates:
        if real_base.is_relative_to(candidate):
          return True
        if candidate.is_relative_to(real_base):
          relative = candidate.relative_to(real_base).as_posix()
          if ids is None:
            ids = list(project_ids() if callable(project_ids) else project_ids)
          if any(f"{project_id.strip('/')}/".startswith(f"{relative}/") for project_id in ids):
            return True
  return False


def new_runs_base(project_id: str) -> Optional[Path]:
  """Where the project's new uploaded runs go, None if the server doesn't take them"""
  routed = locations.for_project(project_id.strip('/'))
  return routed[0].path if routed else None


def off_reason() -> str:
  """Why the server refuses uploaded files"""
  return config.upload_off_reason or "no storage location takes this project's runs"


def disabled_message() -> str:
  """Why the server refuses uploaded files, and what to do"""
  return (f"This server doesn't accept uploaded files ({off_reason()}). Save results in a storage shared with it (`storage` in "
          "qaboard.yaml), or ask its administrators to turn uploads on: "
          "https://samsung.github.io/qaboard/docs/backend-admin/uploads")


def enabled(project_id: Optional[str] = None) -> bool:
  """Whether the server takes uploaded runs: of a project, or of any project"""
  if project_id is None:
    return locations.default() is not None or any(location.projects for location in locations.locations())
  return new_runs_base(project_id) is not None


def supports_project(project_id: str) -> bool:
  """Not the projects with a folder named like RUNS_FOLDER in their id: their files' project couldn't be read from paths"""
  return RUNS_FOLDER not in project_id.strip('/').split('/')


def folder_name(text, maxlength: int = 70) -> str:
  """
  One folder's name for what a client sent (an input's path, a batch's label, configurations): lowercase letters,
  digits, ".", "=" and "-", never a path, and never "." or "..". Names that are already like that are kept
  ("unit-tests"); the others get a hash of the text, so that "A/b" and "a-b" are two folders ("a-b-1f2e3d4c5b6a7980"),
  and so do names that end like a hash, so that "a-b-1f2e3d4c5b6a7980" isn't the folder of "A/b".
  """
  slug = slugify_hash(text, maxlength=maxlength).replace('/', '-').strip('.-')
  if isinstance(text, str) and slug == text and slug and not HASHED_NAME.fullmatch(slug):
    return slug
  return f"{slug}-{make_hash(text)[:HASH_LENGTH]}".lstrip('-')


# A git commit's full id
FULL_COMMIT_ID = re.compile(r'[0-9a-f]{40}')
# A commit's folder: 2 characters of its id, then 14 more in a shared storage (qaboard.conventions.commit_dir_name),
# all the rest (38) for uploaded runs (commit_folder)
COMMIT_FOLDER = re.compile(r'(?P<a>[0-9a-f]{2})/(?P<b>[0-9a-f]{14}(?:[0-9a-f]{24})?)')
# Commits' folders in a path: the storage scan finds which commit files belong to with it (jobs/scan.py)
COMMIT_FOLDERS_IN_PATH = re.compile(rf'/{COMMIT_FOLDER.pattern}(?=/|$)')


# What the backend answers nginx when it may receive a file: nginx passes it on with the file
# (services/nginx/snippets/qaboard-uploads-auth.conf, as QABOARD_UPLOAD_CHECKED)
PROXY_CHECKED_HEADER = 'X-QABoard-Upload-Checked'


def unchecked_by_proxy(environ: dict) -> Optional[UploadError]:
  """
  For the endpoints that receive files: why we refuse a request that the proxy didn't check before receiving its
  body, else None. Files reach uwsgi through nginx: if its configuration leaves out the check, or the
  snippets/qaboard-files-server.conf that defines it, anyone could fill its disk, so we refuse them all, saying so.
  uwsgi's own HTTP port (uwsgi.ini, for health checks) doesn't take files either: it has none of nginx's limits.
  `flask run` on its own (development, tests) has no proxy in front.
  """
  if 'uwsgi.version' not in environ or environ.get('QABOARD_UPLOAD_CHECKED') == '1':
    return None
  logger.error("nginx sent %s without checking its token first: its configuration needs `include snippets/qaboard-files-server.conf;` in the server, and `include snippets/qaboard-uploads-auth.conf;` in this location", environ.get('PATH_INFO'))
  return UploadError(500, "The server's proxy doesn't check tokens before receiving files, so the server refuses them: its nginx configuration needs `include snippets/qaboard-files-server.conf;` in the server, and `include snippets/qaboard-uploads-auth.conf;` where files are sent. Tell your QA-Board admins.", Reason.PROXY_MISCONFIGURED)


def commit_folder(hexsha: str) -> Path:
  """
  A commit's folder in the project's uploaded runs: its full id, unlike the shared storage's 16 characters. Anyone
  who can send a project's results creates commits: with a part of the id, one that starts like another commit's
  would share its folder, and replace its runs' files.
  """
  return Path(hexsha[:2]) / hexsha[2:]


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
  commit_dir = commit_folder(hexsha) if FULL_COMMIT_ID.fullmatch(hexsha) else Path('local') / folder_name(hexsha)
  batch_dir = Path('output') if batch_label == 'default' else Path('output') / folder_name(batch_label, maxlength=32)
  # every run of the database has its own folder: all that tells runs apart is in the names
  # (the input's database too: runs on the same input path in two databases are two runs)
  configuration_dir = folder_name([platform, configurations or [], extra_parameters or {}, *([str(database)] if database else [])], maxlength=32)
  directory = project_runs_dir(project_id) / commit_dir / batch_dir / configuration_dir / folder_name(str(input_path))
  if not is_run_dir(directory, project_id):
    raise UploadError(400, "This run can't be saved by the server: its project, batch or input have names that aren't folders' names.", Reason.INVALID_RUN)
  return directory


def commit_artifacts_dir(project_id: str, hexsha: str, base: Optional[Path] = None) -> Path:
  """
  Where the artifacts of a commit of the project are saved: the repository's files, as in a shared storage's
  commit folder (a subproject's files under its path), in the folder of the project's runs of that commit.
  Each (sub)project has its own copy: deleting one's never touches another's.
  """
  if not isinstance(hexsha, str) or not FULL_COMMIT_ID.fullmatch(hexsha):
    raise UploadError(400, "Artifacts are saved for a git commit, named by its full id (40 hexadecimal characters).", Reason.INVALID_COMMIT)
  if not supports_project(project_id):
    raise UploadError(400, f"Projects with a folder named \"{RUNS_FOLDER}\" can't upload their files.", Reason.UPLOADS_UNSUPPORTED_PROJECT)
  return project_runs_dir(project_id, base) / commit_folder(hexsha) / ARTIFACTS_FOLDER


def is_commit_artifacts_dir(directory, project_id: str) -> bool:
  """Whether a folder is one the server could have chosen for the artifacts of a commit of the project"""
  if not directory or not project_id or not supports_project(project_id) or os.path.normpath(str(directory)) != str(directory):
    return False
  directory = Path(directory)
  runs_dir = _runs_dir_of(directory, project_id)
  if runs_dir is None:
    return False
  parts = directory.relative_to(runs_dir).parts
  return len(parts) == 3 and parts[2] == ARTIFACTS_FOLDER and COMMIT_FOLDER.fullmatch(f"{parts[0]}/{parts[1]}") is not None


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
    raise UploadError(400, f"Files are named by their path in the run's folder, like \"plots/loss.png\", of at most {MAX_PATH_LENGTH} characters.", Reason.INVALID_PATH)
  parts = path.split('/')
  if any(part in ('', '.', '..') or len(part.encode()) > MAX_NAME_LENGTH for part in parts):
    raise UploadError(400, f"{path!r} is not a path inside the run's folder: no empty, \".\" or \"..\" parts, and names of at most {MAX_NAME_LENGTH} bytes.", Reason.INVALID_PATH)
  if parts[-1].startswith(TEMPORARY_PREFIX):
    raise UploadError(400, f"Files can't be named {TEMPORARY_PREFIX}*: the server names the files it is receiving like this.", Reason.INVALID_PATH)
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


# A project's id has at most that many folders: deeper, outside a project's uploaded runs, are a shared storage's
MAX_PROJECT_DEPTH = 8
TEMPORARY_FILE = re.compile(rf'{re.escape(TEMPORARY_PREFIX)}[0-9a-f]{{32}}')


def remove_stale_temporary_files(max_age: float = 24 * 3600) -> int:
  """
  Removes the files we were receiving when the server was killed (SIGKILL, uwsgi's harakiri), older than `max_age`
  seconds, in the projects' uploaded runs. Returns how many. Symlinks aren't followed.
  """
  removed = 0
  oldest = time.time() - max_age
  for base in bases():
    # (folder, in a project's runs, depth)
    stack = [(str(base), False, 0)]
    while stack:
      folder, in_runs, depth = stack.pop()
      try:
        entries = list(os.scandir(folder))
      except OSError:
        continue
      for entry in entries:
        try:
          if entry.is_dir(follow_symlinks=False):
            if in_runs or (depth >= 1 and entry.name == RUNS_FOLDER):
              stack.append((entry.path, True, depth + 1))
            elif depth < MAX_PROJECT_DEPTH and not entry.name.startswith('.'):
              stack.append((entry.path, False, depth + 1))
          elif in_runs and TEMPORARY_FILE.fullmatch(entry.name) and entry.stat(follow_symlinks=False).st_mtime < oldest:
            os.unlink(entry.path)
            removed += 1
        except OSError:
          continue
  return removed


def _copy(source: BinaryIO, target: BinaryIO, length: int, sha256: Optional[str]) -> None:
  """Copies exactly `length` bytes, and checks their SHA-256 when the client sent it"""
  digest = hashlib.sha256()
  left = length
  while left > 0:
    chunk = source.read(min(CHUNK_SIZE, left))
    if not chunk:
      raise UploadError(400, f"The upload stopped {left} bytes before its end (Content-Length: {length}).", Reason.INCOMPLETE)
    target.write(chunk)
    digest.update(chunk)
    left -= len(chunk)
  if sha256 and digest.hexdigest() != sha256.lower():
    raise UploadError(422, f"What the server received doesn't have the SHA-256 the client sent ({digest.hexdigest()}, not {sha256.lower()}).", Reason.DIGEST_MISMATCH)


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
    raise UploadError(400, "The file's size and offset can't be negative.", Reason.INVALID_SIZE)
  if (offset or 0) + length > config.upload_max_file_size:
    raise UploadError(413, f"{path} is larger than what this server accepts ({config.upload_max_file_size // 1024**2} MB). Save big files in a storage shared with the server, or ask its administrators to raise QABOARD_UPLOAD_MAX_FILE_MB.", Reason.TOO_LARGE, max_file_size=config.upload_max_file_size)
  target = directory / relative
  try:
    # a symlink in the folder (they aren't ours) must not take the file elsewhere, nor create folders there: the
    # deepest folder that exists must really be inside the run's (check_inside checks the parent of what it's given)
    existing = target.parent
    while not existing.exists() and existing != directory and directory in existing.parents:
      existing = existing.parent
    check_inside(existing / '_', directory)
    target.parent.mkdir(parents=True, exist_ok=True)
    check_inside(target, directory)
    if shutil.disk_usage(target.parent).free - length < config.upload_min_free_space:
      raise UploadError(507, "The server's storage for uploaded files is full: tell its administrators.", Reason.STORAGE_FULL)
    if offset is None:
      _replace(target, source, length, sha256)
      return length
    return _append(target, source, length, sha256, offset)
  except UnsafePathError:
    raise UploadError(400, f"{path!r} is not a path inside the run's folder.", Reason.INVALID_PATH) from None
  except (IsADirectoryError, NotADirectoryError, FileExistsError):
    raise UploadError(409, f"{path} can't be both a file and a folder of the run.", Reason.PATH_CONFLICT) from None
  except FileNotFoundError:
    # clean_run_dir removed the folder, or our temporary file, while we received it
    raise UploadError(409, "The run's folder changed while the file was sent: did the run start again?", Reason.PATH_CONFLICT) from None


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
      raise UploadError(409, f"The file has {size} bytes, not {offset}: send it whole.", Reason.OFFSET_MISMATCH, size=size)
    f.seek(offset)
    try:
      _copy(source, f, length, sha256)
    except BaseException:
      # e.g. the client went away, the disk is full: what was added is not half there
      f.truncate(offset)
      raise
    return offset + length
