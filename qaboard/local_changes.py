"""
What a local run changed in its repository, compared with its commit: docs/rfcs/local-changes.md.

Levels, from least to most: "off", "summary" (whether the tree is dirty, the changed files' paths and counts, whether
HEAD is pushed, a hash of the patch), "patch" (also the patch, saved in the run's folder, and the unpushed commits'
when HEAD isn't pushed). Admins set the most runs may record (the server's `runs.local_changes`), projects choose
within it (`outputs.local_changes` in qaboard.yaml), $QA_LOCAL_CHANGES overrides it for a command.

Capturing never writes in the repository (the index is read from a copy, without a split index) and runs no diff
program (--no-ext-diff, --no-textconv). What the user's own git configuration installs still runs, as with any git
command: an fsmonitor hook, the clean filters of .gitattributes (git-lfs). A clone can't install them. It never fails a run: what we couldn't learn in time is
missing, and `dirty` is None when we couldn't tell.

This module imports nothing from qaboard, so that it can be tested and reused alone.
"""
import os
import json
import time
import logging
import shutil
import fnmatch
import hashlib
import queue
import socket
import tempfile
import threading
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any, NamedTuple, TypeVar
from concurrent.futures import Future
from collections.abc import Callable, Mapping, Sequence

logger = logging.getLogger(__name__)

LEVELS = ('off', 'summary', 'patch')
ENV_LEVEL = 'QA_LOCAL_CHANGES'
# qa batch captures once, its runs read it from there
ENV_STATE = 'QA_LOCAL_CHANGES_STATE'

PATCH_FILE = '.qaboard/local-changes.patch'
UNPUSHED_FILE = '.qaboard/unpushed.patch'
# what qa and the server never list in manifests, nor compare between runs
FOLDER = '.qaboard'

DEFAULT_MAX_PATCH_KB = 2048
DEFAULT_TIMEOUT = 10.0
# changed files listed by path, and excluded files listed by name
MAX_FILES = 500
MAX_EXCLUDED = 100
# unpushed commits listed by their subject
MAX_UNPUSHED_LOG = 50
# Runs of a batch that start within this many seconds of the batch's capture, on its machine, reuse it without
# running git: people rarely edit in between. Later, or elsewhere, they check the fingerprint.
FRESH_BATCH_SECONDS = 5.0
# with more untracked files than this (a build folder that isn't ignored), their contents are left out
MAX_UNTRACKED_CONTENTS = 200
# untracked files larger than this are listed, but their contents left out
MAX_UNTRACKED_FILE_BYTES = 1024 * 1024
# Untracked files that look like secrets: listed by name, never in the patch. Tracked files are already in git.
SECRET_GLOBS = (
  '.env', '.env.*', '*.env', '.netrc', '.pgpass', '.npmrc', '.pypirc', '.htpasswd', '.git-credentials',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx', '*.tfvars', '*.tfstate', '*.tfstate.*',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'kubeconfig', '*service-account*.json', '*serviceaccount*.json',
)
# ... and those whose names say so, unless they are code (tokenizer.py, password_policy.cpp)
SECRET_WORDS = ('*credential*', '*secret*', '*token*', '*password*', '*passwd*', '*apikey*', '*api_key*')
CODE_SUFFIXES = (
  '.py', '.pyx', '.pyi', '.ipynb', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.cu', '.cuh', '.rs', '.go', '.java', '.kt',
  '.scala', '.js', '.jsx', '.ts', '.tsx', '.m', '.mm', '.swift', '.cs', '.rb', '.php', '.lua', '.r', '.jl', '.sh', '.cmake', '.md', '.rst',
)
# ... and everything in folders like these
SECRET_FOLDERS = ('.ssh', '.aws', '.gnupg', '.docker', '.kube', 'secrets', '.secrets')
# Untracked files that are never changes: what programs leave next to the code when it runs
NOISE_GLOBS = ('__pycache__/*', '*/__pycache__/*', '*.pyc', '*.pyo', '.ipynb_checkpoints/*', '*/.ipynb_checkpoints/*', '.DS_Store', '*/.DS_Store')
# git's empty tree, to diff a repository without commits
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
# Flags that make the patch the same whatever the user's git configuration says, and appliable with `git apply`
DIFF_FLAGS = (
  '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-relative', '--submodule=short', '--ignore-submodules=dirty',
  '--src-prefix=a/', '--dst-prefix=b/',
)
# core.splitIndex=false: `git add -N` on the index copy would write a shared index in the user's .git
GIT_CONFIG = ('-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'core.splitIndex=false')


class Settings(NamedTuple):
  level: str = 'patch'
  max_patch_bytes: int = DEFAULT_MAX_PATCH_KB * 1024
  timeout: float = DEFAULT_TIMEOUT
  exclude: tuple[str, ...] = ()


def lowest(*levels: str | None) -> str:
  """The least of the levels, ignoring the unknown ones (None: no say), e.g. the project's and the server's"""
  known = [l for l in levels if l in LEVELS]
  return min(known, key=LEVELS.index) if known else 'off'


def settings(value: Any = None, *, environ: Mapping[str, str] = os.environ, is_ci: bool = False) -> tuple[Settings, list[str]]:
  """
  The settings from qaboard.yaml's `outputs.local_changes` (a level, a boolean, or a mapping with `level`,
  `max_patch_kb`, `timeout`, `exclude`) and $QA_LOCAL_CHANGES, with the problems found. In CI, "off" unless
  $QA_LOCAL_CHANGES says otherwise: checkouts are clean.
  """
  problems: list[str] = []
  base = Settings()
  if value is True or value is None:
    value = {}
  elif value is False:
    value = {'level': 'off'}
  elif isinstance(value, str):
    value = {'level': value}
  if not isinstance(value, dict):
    problems.append(f"outputs.local_changes should be one of {', '.join(LEVELS)}, or a mapping: not {value!r}")
    value = {}
  level = value.get('level', base.level)
  if level is True:
    level = 'patch'
  elif level is False:
    level = 'off'
  if level not in LEVELS:
    problems.append(f"outputs.local_changes.level should be one of {', '.join(LEVELS)}: not {level!r}")
    level = base.level
  max_patch_bytes = base.max_patch_bytes
  if 'max_patch_kb' in value:
    kb = value['max_patch_kb']
    if isinstance(kb, (int, float)) and not isinstance(kb, bool) and kb > 0:
      max_patch_bytes = int(kb * 1024)
    else:
      problems.append(f"outputs.local_changes.max_patch_kb should be a positive number: not {kb!r}")
  timeout = base.timeout
  if 'timeout' in value:
    t = value['timeout']
    if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0:
      timeout = float(t)
    else:
      problems.append(f"outputs.local_changes.timeout should be a positive number of seconds: not {t!r}")
  exclude = value.get('exclude') or ()
  if isinstance(exclude, str):
    exclude = (exclude,)
  if not isinstance(exclude, (list, tuple)) or not all(isinstance(e, str) for e in exclude):
    problems.append("outputs.local_changes.exclude should be a list of globs, like \"data/**\"")
    exclude = ()
  if is_ci:
    level = 'off'
  forced = (environ.get(ENV_LEVEL) or '').strip().lower()
  if forced:
    if forced in LEVELS:
      level = forced
    elif forced in ('1', 'true', 'yes', 'on'):
      level = 'patch'
    elif forced in ('0', 'false', 'no'):
      level = 'off'
    else:
      problems.append(f"${ENV_LEVEL} should be one of {', '.join(LEVELS)}: not {forced!r}")
  return Settings(level, max_patch_bytes, timeout, tuple(exclude)), problems


class Capture(NamedTuple):
  """What capture() found: `state` is what runs record in data.local_changes, the patches are bytes (or None)"""
  state: dict[str, Any]
  patch: bytes | None = None
  unpushed: bytes | None = None
  # what changes when the code changes (_fingerprint)
  fingerprint: str | None = None
  # when git status started (time.time()), and on which machine
  captured_at: float | None = None
  host: str | None = None


class _Budget:
  def __init__(self, seconds: float):
    self.deadline = time.monotonic() + seconds

  def left(self) -> float:
    return self.deadline - time.monotonic()


class _Timeout(Exception):
  pass


def _env(index: str | None = None) -> dict[str, str]:
  env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') or k in ('GIT_SSH', 'GIT_SSH_COMMAND')}
  # no pager, no prompt, no translated messages we would parse, no lock taken on the user's index
  env.update({'GIT_PAGER': 'cat', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'GIT_OPTIONAL_LOCKS': '0'})
  if index:
    env['GIT_INDEX_FILE'] = index
  return env


def _git(root: Path, args: Sequence[str], budget: _Budget, *, index: str | None = None, stdin: bytes | None = None) -> bytes | None:
  """git's output, None when it fails. Raises _Timeout past the budget."""
  left = budget.left()
  if left <= 0:
    raise _Timeout()
  started = time.monotonic()
  try:
    p = subprocess.run(['git', *GIT_CONFIG, *args], cwd=root, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       env=_env(index), timeout=left)
  except subprocess.TimeoutExpired:
    logger.debug("local changes: git %s gave up after %.2fs", args[0], time.monotonic() - started)
    raise _Timeout()
  except OSError:
    return None
  logger.debug("local changes: git %s took %.2fs", _describe_args(args), time.monotonic() - started)
  return p.stdout if p.returncode == 0 else None


def _describe_args(args: Sequence[str]) -> str:
  """git's command and options for the logs, not the paths"""
  shown = [a for a in args[:6] if a.startswith('-') or a == args[0]]
  paths = len(args) - args.index('--') - 1 if '--' in args else 0
  return ' '.join(shown) + (f" ({paths} paths)" if paths else '')


def _stream_diff(root: Path, args: Sequence[str], budget: _Budget, max_bytes: int, *, index: str | None = None,
                 consume: Callable[[bytes], None] | None = None) -> tuple[str | None, bytes | None, int]:
  """
  (sha256, the first max_bytes or None when larger, size) of a diff, read as it comes: large diffs are hashed
  without being kept in memory. `consume` sees each chunk. Raises _Timeout past the budget, (None, None, 0) when git fails.
  """
  if budget.left() <= 0:
    raise _Timeout()
  try:
    p = subprocess.Popen(['git', *GIT_CONFIG, *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_env(index))
  except OSError:
    return None, None, 0
  digest = hashlib.sha256()
  kept: list[bytes] = []
  size = 0
  # read in a thread: a read blocks until git writes, and a slow git (e.g. a filter fetching LFS objects) must not
  # keep us past the budget
  chunks: queue.Queue[bytes | None] = queue.Queue(maxsize=64)

  def read() -> None:
    try:
      assert p.stdout is not None
      for chunk in iter(lambda: p.stdout.read(1 << 16), b''):  # type: ignore[union-attr]
        chunks.put(chunk)
    except (OSError, ValueError):
      pass
    finally:
      chunks.put(None)

  reader = threading.Thread(target=read, name='qaboard-local-changes', daemon=True)
  reader.start()
  try:
    while True:
      left = budget.left()
      if left <= 0:
        raise _Timeout()
      try:
        chunk = chunks.get(timeout=left)
      except queue.Empty:
        raise _Timeout()
      if chunk is None:
        break
      digest.update(chunk)
      if consume is not None:
        consume(chunk)
      size += len(chunk)
      if size <= max_bytes:
        kept.append(chunk)
      else:
        kept = []
    returncode = p.wait(timeout=max(budget.left(), 0.1))
  except (_Timeout, subprocess.TimeoutExpired):
    raise _Timeout()
  finally:
    if p.poll() is None:
      p.kill()
      # the reader may wait to put a chunk: empty the queue so that it ends, for a second at most
      deadline = time.monotonic() + 1
      while reader.is_alive() and time.monotonic() < deadline:
        try:
          chunks.get(timeout=0.1)
        except queue.Empty:
          pass
      p.wait()
    if p.stdout:
      p.stdout.close()
  if returncode != 0:
    return None, None, 0
  return digest.hexdigest(), (b''.join(kept) if size <= max_bytes else None), size


def _matches(path: str, globs: Sequence[str]) -> bool:
  name = PurePosixPath(path).name
  return any(fnmatch.fnmatchcase(path, g) or fnmatch.fnmatchcase(name, g) or path.startswith(g.rstrip('/') + '/')
             for g in globs)


def _looks_secret(path: str) -> bool:
  parts = PurePosixPath(path.lower()).parts
  name = parts[-1]
  if any(part in SECRET_FOLDERS for part in parts[:-1]):
    return True
  if any(fnmatch.fnmatchcase(name, g) for g in SECRET_GLOBS):
    return True
  return not name.endswith(CODE_SUFFIXES) and any(fnmatch.fnmatchcase(name, g) for g in SECRET_WORDS)


class _Status(NamedTuple):
  head: str | None
  branch: str | None
  upstream: str | None
  ahead: int | None
  # path: X/Y status letters, "?" for untracked
  changed: dict[str, str]
  untracked: list[str]


def _parse_status(out: bytes) -> _Status:
  """git status --porcelain=v2 -z --branch"""
  head = branch = upstream = None
  ahead = None
  changed: dict[str, str] = {}
  untracked: list[str] = []
  records = out.split(b'\0')
  i = 0
  while i < len(records):
    record = records[i].decode('utf-8', errors='surrogateescape')
    i += 1
    if not record:
      continue
    if record.startswith('# '):
      key, _, value = record[2:].partition(' ')
      if key == 'branch.oid':
        head = value if value != '(initial)' else None
      elif key == 'branch.head':
        branch = value if value != '(detached)' else None
      elif key == 'branch.upstream':
        upstream = value
      elif key == 'branch.ab':
        try:
          ahead = int(value.split()[0].lstrip('+'))
        except (ValueError, IndexError):
          pass
    elif record.startswith('1 '):
      parts = record.split(' ', 8)
      if len(parts) == 9:
        changed[parts[8]] = parts[1]
    elif record.startswith('2 '):
      # renamed or copied in the index: the next record is the path it came from
      parts = record.split(' ', 9)
      if len(parts) == 10:
        changed[parts[9]] = parts[1]
        if i < len(records):
          origin = records[i].decode('utf-8', errors='surrogateescape')
          i += 1
          # compared with HEAD, without renames, the origin is deleted
          changed.setdefault(origin, 'D.')
    elif record.startswith('u '):
      parts = record.split(' ', 10)
      if len(parts) == 11:
        changed[parts[10]] = 'UU'
    elif record.startswith('? '):
      untracked.append(record[2:])
  return _Status(head, branch, upstream, ahead, changed, untracked)


def _status_letter(xy: str) -> str:
  """Compared with HEAD: A(dded), D(eleted), M(odified), ?(untracked)"""
  if xy == '?':
    return '?'
  if 'D' in xy:
    return 'D'
  if xy[:1] in ('A', 'C', 'R'):
    return 'A'
  return 'M'


_ESCAPES = {ord(k): v for k, v in {'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13, '"': 34, '\\': 92}.items()}


def _unquote(quoted: bytes) -> bytes:
  """A path as git quotes it (core.quotePath): "a/caf\\303\\251" -> a/café"""
  out = bytearray()
  i, n = 1, len(quoted) - 1
  while i < n:
    c = quoted[i]
    if c == 92 and i + 1 < n:  # backslash
      following = quoted[i + 1]
      if 48 <= following <= 55 and i + 3 < n:  # \ooo, a byte in octal
        out.append(int(quoted[i + 1:i + 4], 8) & 0xFF)
        i += 4
        continue
      out.append(_ESCAPES.get(following, following))
      i += 2
      continue
    out.append(c)
    i += 1
  return bytes(out)


def _header_path(line: bytes) -> str | None:
  """The path of `diff --git a/<path> b/<path>`: the same twice, renames are off"""
  rest = line[len(b'diff --git '):]
  # "a/<path>" "b/<path>" when the path is quoted (core.quotePath), else a/<path> b/<path>: both halves have its length
  if rest.startswith(b'"'):
    half = (len(rest) - 1) // 2
    if len(rest) < 7 or (len(rest) - 1) % 2 or rest[half:half + 2] != b' "':
      return None
    path = _unquote(rest[:half])[2:]
  else:
    if len(rest) < 5 or (len(rest) - 5) % 2:
      return None
    path = rest[2:2 + (len(rest) - 5) // 2]
  return path.decode('utf-8', errors='surrogateescape')


class _DiffCounter:
  """
  What `git diff --numstat` says, from the patch `git diff` writes, read as it comes: path -> (added, deleted), None
  for binary files. One diff instead of two: each runs git's filters again (git-lfs). For diffs with --no-renames.
  """
  # a line longer than this is counted from its first byte, not kept whole
  MAX_LINE = 1 << 16

  def __init__(self) -> None:
    self.counts: dict[str, tuple[int | None, int | None]] = {}
    self._path: str | None = None
    self._added = self._deleted = 0
    self._binary = False
    self._in_hunk = False
    self._partial = b''
    self._skipping = False  # in a long content line, already counted

  def feed(self, chunk: bytes) -> None:
    if self._skipping:
      end = chunk.find(b'\n')
      if end == -1:
        return
      self._skipping = False
      chunk = chunk[end + 1:]
    lines = (self._partial + chunk if self._partial else chunk).split(b'\n')
    self._partial = lines.pop()
    for line in lines:
      self._line(line)
    if len(self._partial) > self.MAX_LINE and self._in_hunk and self._partial[:1] in (b'+', b'-', b' ', b'\\'):
      self._line(self._partial[:1])
      self._partial = b''
      self._skipping = True

  def _line(self, line: bytes) -> None:
    first = line[:1]
    if self._in_hunk:
      if first == b'+':
        self._added += 1
        return
      if first == b'-':
        self._deleted += 1
        return
      if first in (b' ', b'\\', b'@'):
        return
    if line.startswith(b'diff --git '):
      self._end_file()
      self._path = _header_path(line)
      self._in_hunk = False
    elif first == b'@' and line.startswith(b'@@ '):
      self._in_hunk = True
    elif not self._in_hunk and line.startswith(b'Binary files ') and line.endswith(b' differ'):
      self._binary = True

  def _end_file(self) -> None:
    if self._path is not None:
      added: int | None = None if self._binary else self._added
      deleted: int | None = None if self._binary else self._deleted
      # a change of type (a link that became a file) is two diffs of the same path, and one line of numstat
      before = self.counts.get(self._path)
      if before is not None:
        added = None if added is None or before[0] is None else added + before[0]
        deleted = None if deleted is None or before[1] is None else deleted + before[1]
      self.counts[self._path] = (added, deleted)
    self._path = None
    self._added = self._deleted = 0
    self._binary = False

  def finish(self) -> dict[str, tuple[int | None, int | None]]:
    if self._partial and not self._skipping:
      self._line(self._partial)
    self._partial = b''
    self._end_file()
    return self.counts


def _pathspecs(paths: Sequence[str]) -> bytes:
  return b''.join(p.encode('utf-8', errors='surrogateescape') + b'\0' for p in paths)


def repository_root(directory: Path) -> Path | None:
  """The working tree's root above a folder, None outside git"""
  out = _git(Path(directory), ['rev-parse', '--show-toplevel'], _Budget(5))
  return Path(out.decode().strip()) if out else None


# Untracked folders in normal mode, without pathspecs: else git doesn't use the untracked cache (core.untrackedCache)
# that the user's own `git status` keeps, and reads every folder of the working tree each time
STATUS_ARGS = ('status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignore-submodules=dirty')
# Past that, git's command line would be too long (Windows: 32K characters): we list or diff the whole tree
MAX_PATHSPEC_CHARS = 24_000


def _folders(ignore: Sequence[str]) -> list[str]:
  return [p.strip('/') for p in ignore if p and p.strip('/') not in ('', '.')]


def _inside(path: str, folders: Sequence[str]) -> bool:
  path = path.rstrip('/')
  return any(path == f or path.startswith(f + '/') for f in folders)


def _chunks(paths: Sequence[str], max_chars: int = MAX_PATHSPEC_CHARS) -> list[list[str]]:
  chunks: list[list[str]] = [[]]
  size = 0
  for path in paths:
    if chunks[-1] and size + len(path) > max_chars:
      chunks.append([])
      size = 0
    chunks[-1].append(path)
    size += len(path) + 12
  return chunks


def _status(root: Path, ignore: Sequence[str], budget: '_Budget') -> '_Status | None':
  """
  git status, without what's in the folders we ignore (e.g. where runs are saved), and with each untracked file:
  git lists new folders as "folder/", we list their files with `git ls-files`, in those folders only.
  """
  out = _git(root, STATUS_ARGS, budget)
  if out is None:
    return None
  status = _parse_status(out)
  folders = _folders(ignore)
  changed = {path: xy for path, xy in status.changed.items() if not _inside(path, folders)}
  untracked = [p for p in status.untracked if not _inside(p, folders)]
  new_folders = [p for p in untracked if p.endswith('/')]
  files = [p for p in untracked if not p.endswith('/')]
  if new_folders:
    # the ignored folders inside the new ones: git doesn't even look in them
    excluded = [f':(exclude,literal){f}' for f in folders if any(f.startswith(d) for d in new_folders)]
    for chunk in _chunks(new_folders):
      listed = _git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', *[f':(literal){d}' for d in chunk], *excluded], budget)
      if listed is None:
        files.extend(chunk)
        continue
      # nested repositories stay listed as "folder/", like `git status --untracked-files=all` does
      files.extend(r.decode('utf-8', errors='surrogateescape') for r in listed.split(b'\0') if r)
  return status._replace(changed=changed, untracked=sorted(set(files)))


# Above that many changed files, there is no fingerprint: the runs of a batch capture again
MAX_FINGERPRINT_FILES = 5000


def _code_paths(status: '_Status', ignore: Sequence[str]) -> list[str]:
  """The untracked files that may be code: not in the folders we ignore, nor what programs leave behind (__pycache__)"""
  ignored = [p.strip('/') for p in ignore if p and p.strip('/') not in ('', '.')]
  return [path for path in status.untracked
          if not any(path == i or path.startswith(i + '/') for i in ignored) and not any(fnmatch.fnmatchcase(path, g) for g in NOISE_GLOBS)]


def _fingerprint(root: Path, status: '_Status', ignore: Sequence[str]) -> str | None:
  """
  What changes when the code changes: the status, and the size and modification time of the files it lists. A
  run of a batch compares it with the batch's: equal, it reuses the batch's capture without computing the patch.
  """
  untracked = _code_paths(status, ignore)
  digest = hashlib.sha256(json.dumps([status.head, status.branch, status.upstream, status.ahead, sorted(status.changed.items()), sorted(untracked)],
                                     ensure_ascii=False).encode('utf-8', errors='surrogateescape'))
  paths = sorted(set(status.changed) | set(untracked))
  # too many to stat each time: runs of the batch capture again
  if len(paths) > MAX_FINGERPRINT_FILES:
    return None
  for path in paths:
    try:
      st = (root / path).lstat()
      digest.update(f"\0{path}\0{st.st_size}\0{st.st_mtime_ns}".encode('utf-8', errors='surrogateescape'))
    except OSError:
      digest.update(f"\0{path}\0-".encode('utf-8', errors='surrogateescape'))
  return digest.hexdigest()


def fingerprint(root: Path, config: Settings = Settings(), *, ignore: Sequence[str] = ()) -> str | None:
  """The working tree's fingerprint now (see _fingerprint), None if git can't tell in time"""
  try:
    status = _status(Path(root), ignore, _Budget(config.timeout))
  except _Timeout:
    return None
  return _fingerprint(Path(root), status, ignore) if status is not None else None


def capture(root: Path, config: Settings = Settings(), *, ignore: Sequence[str] = ()) -> Capture | None:
  """
  The state of the working tree at `root` compared with HEAD, at the level of `config`, or None for "off".
  `ignore` are paths (relative to root, e.g. the project's output/ folder) whose untracked files aren't changes.
  """
  if config.level == 'off':
    return None
  started = time.monotonic()
  at = time.time()
  root = Path(root)
  budget = _Budget(config.timeout)
  state: dict[str, Any] = {'level': config.level, 'dirty': None}
  patch = unpushed = None
  tmp = None
  fingerprint = None
  try:
    found = _status(root, ignore, budget)
    if found is None:
      state['error'] = "git status failed: is it a git repository?"
      return Capture(state, captured_at=at, host=_host())
    status = found
    fingerprint = _fingerprint(root, status, ignore)
    state['head'] = status.head
    state['branch'] = status.branch
    if status.upstream:
      state['upstream'] = status.upstream

    untracked: list[str] = []
    excluded: list[str] = []
    for path in _code_paths(status, ignore):
      if _looks_secret(path) or _matches(path, config.exclude):
        excluded.append(path)
        continue
      untracked.append(path)
    tracked_excluded = [p for p in status.changed if config.exclude and _matches(p, config.exclude)]
    state['dirty'] = bool(status.changed or untracked)
    state['untracked'] = len(untracked)

    # pushed: can others fetch HEAD? With an upstream, nothing ahead of it. Else, reachable from a remote branch.
    if status.head:
      # the upstream may be a local branch: then only remote branches say what others can fetch
      upstream_ref = _git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}'], budget) if status.upstream else None
      if status.upstream and status.ahead is not None and upstream_ref and upstream_ref.startswith(b'refs/remotes/'):
        state['pushed'] = status.ahead == 0
        state['unpushed_commits'] = status.ahead
      else:
        remotes = _git(root, ['remote'], budget)
        if remotes is not None and remotes.strip():
          listed = _git(root, ['rev-list', '--boundary', 'HEAD', '--not', '--remotes'], budget)
          if listed is not None:
            lines = listed.decode().split()
            commits = [l for l in lines if not l.startswith('-')]
            state['pushed'] = not commits
            state['unpushed_commits'] = len(commits)
            boundary = [l[1:] for l in lines if l.startswith('-')]
            if commits and boundary:
              state['base'] = boundary[0]
      if state.get('pushed') is False and 'base' not in state and upstream_ref and upstream_ref.startswith(b'refs/remotes/'):
        base = _git(root, ['merge-base', 'HEAD', '@{upstream}'], budget)
        if base:
          state['base'] = base.decode().strip()

    if excluded:
      state['excluded'] = sorted(excluded)[:MAX_EXCLUDED]
    if not state['dirty'] and not state.get('base'):
      state['files'] = []
      state['files_total'] = state['added'] = state['deleted'] = 0
      return Capture(state, fingerprint=fingerprint, captured_at=at, host=_host())

    # The changes compared with HEAD, new files included: on a copy of the index, with them added "intent to add"
    against = status.head or EMPTY_TREE
    index = None
    if state['dirty']:
      tmp = tempfile.mkdtemp(prefix='qaboard-local-changes-')
      index = os.path.join(tmp, 'index')
      index_path = _git(root, ['rev-parse', '--git-path', 'index'], budget)
      source = (root / index_path.decode().strip()) if index_path else None
      if source is not None and source.is_file():
        # with its mtime: git checks entries as recent as the index again (racy git), else edits made within a
        # second of the last index write would look unchanged
        shutil.copy2(source, index)
      elif status.head:
        _git(root, ['read-tree', 'HEAD'], budget, index=index)
      contents = untracked
      if len(untracked) > MAX_UNTRACKED_CONTENTS:
        state['untracked_contents'] = 'too_many'
        contents = []
      else:
        large = [p for p in untracked if _size(root / p) > MAX_UNTRACKED_FILE_BYTES]
        if large:
          state['untracked_too_large'] = large[:MAX_EXCLUDED]
          contents = [p for p in untracked if p not in set(large)]
      if contents:
        _git(root, ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], budget, index=index, stdin=_pathspecs(contents))

      # Only the paths git status listed: else git diff checks every file of the working tree again. Too
      # many for a command line, the whole tree, without the excluded tracked files (decided here, with the same
      # globs as untracked ones).
      paths = sorted((set(status.changed) - set(tracked_excluded)) | set(contents))
      if paths and sum(len(p) + 12 for p in paths) <= MAX_PATHSPEC_CHARS:
        pathspec = ['--', *[f':(literal){p}' for p in paths]]
      else:
        pathspec = ['--', '.', *[f':(exclude,literal){p}' for p in tracked_excluded]] if tracked_excluded else []
      # the patch, and the counts of `git diff --numstat` from it, in one diff: each runs git's filters (git-lfs)
      counter = _DiffCounter()
      sha256, kept, size = _stream_diff(root, ['diff', against, *DIFF_FLAGS, *pathspec], budget, config.max_patch_bytes, index=index,
                                        consume=counter.feed)
      counts = counter.finish() if sha256 else {}
      # compared with HEAD, the index can differ while the files don't (staged, then reverted): not a change
      if sha256 and not counts and not tracked_excluded:
        state['dirty'] = False
      files = []
      for path in sorted((set(status.changed) - set(tracked_excluded)) | set(untracked)):
        if path not in counts and path not in untracked:
          continue
        letter = '?' if path not in status.changed else _status_letter(status.changed[path])
        added, deleted = counts.get(path, (0, 0) if letter != '?' else (None, None))
        entry: dict[str, Any] = {'path': path, 'status': letter, 'added': added, 'deleted': deleted}
        if added is None and path in counts:
          entry['binary'] = True
        files.append(entry)
      state['files_total'] = len(files)
      state['added'] = sum(f['added'] or 0 for f in files)
      state['deleted'] = sum(f['deleted'] or 0 for f in files)
      state['files'] = files[:MAX_FILES]
      excluded += tracked_excluded
      if excluded:
        state['excluded'] = sorted(excluded)[:MAX_EXCLUDED]

      if not state['dirty']:
        pass
      elif sha256:
        state['sha256'] = sha256
        if config.level == 'patch':
          if kept is not None:
            patch = kept
            state['patch'] = {'path': PATCH_FILE, 'bytes': size}
          else:
            state['patch'] = {'omitted': 'too_large', 'bytes': size}
      else:
        state['patch'] = {'omitted': 'error'}
    else:
      state['files'] = []
      state['files_total'] = state['added'] = state['deleted'] = 0

    # The commits others can't fetch: their subjects, and a patch from the last pushed commit
    if state.get('base') and status.head:
      log = _git(root, ['log', '--no-color', f'--max-count={MAX_UNPUSHED_LOG}', '--format=%H%x00%s', f"{state['base']}..{status.head}", '--'], budget)
      if log is not None:
        entries = [line.split('\0', 1) for line in log.decode('utf-8', errors='replace').splitlines() if '\0' in line]
        state['unpushed_log'] = [{'sha': sha, 'subject': subject[:200]} for sha, subject in entries]
    if config.level == 'patch' and state.get('base') and status.head:
      sha256, kept, size = _stream_diff(root, ['diff', state['base'], status.head, *DIFF_FLAGS], budget, config.max_patch_bytes)
      if sha256 and kept is not None:
        unpushed = kept
        state['unpushed'] = {'path': UNPUSHED_FILE, 'bytes': size, 'sha256': sha256}
      elif sha256:
        state['unpushed'] = {'omitted': 'too_large', 'bytes': size, 'sha256': sha256}
  except _Timeout:
    state['timed_out'] = True
    if 'sha256' not in state and state.get('dirty') is not False:
      state['patch'] = {'omitted': 'timeout'}
  except Exception as e:  # never fail a run
    state['error'] = f"{type(e).__name__}: {e}"
  finally:
    if tmp:
      shutil.rmtree(tmp, ignore_errors=True)
    state['ms'] = int((time.monotonic() - started) * 1000)
  if config.level != 'patch':
    state.pop('patch', None)
  _printable(state)
  return Capture(state, patch, unpushed, fingerprint, at, _host())


def _host() -> str | None:
  try:
    return socket.gethostname()
  except OSError:
    return None


_T = TypeVar('_T')


def in_background(fn: Callable[..., _T], *args: Any, **kwargs: Any) -> 'Future[_T]':
  """
  fn(*args, **kwargs) in a daemon thread, e.g. a capture while qa does something else: .result() waits for it, and
  raises what it raised. A daemon thread doesn't keep the process alive (an executor's would).
  """
  future: Future[_T] = Future()

  def work() -> None:
    if not future.set_running_or_notify_cancel():
      return
    try:
      future.set_result(fn(*args, **kwargs))
    except BaseException as e:
      future.set_exception(e)
  threading.Thread(target=work, name='qaboard-local-changes', daemon=True).start()
  return future


def _printable(state: dict[str, Any]) -> None:
  """File names that aren't UTF-8 are kept for git (surrogateescape): what runs record must be valid text (JSON, PostgreSQL)"""
  def text(value: str) -> str:
    return value.encode('utf-8', errors='surrogateescape').decode('utf-8', errors='replace')
  for f in state.get('files') or []:
    f['path'] = text(f['path'])
  for key in ('excluded', 'untracked_too_large'):
    if key in state:
      state[key] = [text(p) for p in state[key]]
  for key in ('branch', 'upstream'):
    if isinstance(state.get(key), str):
      state[key] = text(state[key])


def _size(path: Path) -> int:
  try:
    return path.lstat().st_size
  except OSError:
    return 0


def at_level(state: dict[str, Any] | None, level: str) -> dict[str, Any] | None:
  """What's left of a state at a lower level: "summary" drops the patches, "off" everything"""
  if not state or level == 'off':
    return None
  recorded = state.get('level') if state.get('level') in LEVELS else 'patch'
  if LEVELS.index(level) >= LEVELS.index(recorded):
    return dict(state)
  reduced = {k: v for k, v in state.items() if k not in ('patch', 'unpushed')}
  reduced['level'] = level
  if state.get('patch'):
    reduced['patch'] = {'omitted': 'level'}
  return reduced


def save(capture: Capture, run_dir: Path, level: str = 'patch') -> dict[str, Any]:
  """Writes the patches in the run's folder, as far as `level` allows. Returns the state the run records."""
  state = at_level(capture.state, level) or {}
  if level != 'patch':
    return state
  for content, key, name in ((capture.patch, 'patch', PATCH_FILE), (capture.unpushed, 'unpushed', UNPUSHED_FILE)):
    if content is None or not (state.get(key) or {}).get('path'):
      continue
    path = Path(run_dir) / name
    try:
      path.parent.mkdir(parents=True, exist_ok=True)
      path.write_bytes(content)
    except OSError as e:
      state[key] = {'omitted': 'error', 'error': str(e)}
  return state


def describe(state: dict[str, Any] | None, *, batch: bool = False, saved_in: str | None = None, saving: bool = True) -> str | None:
  """
  One line for people, e.g. "3 files (1 new), +40 -12, saved in output/a/.qaboard/local-changes.patch".
  `batch`: said once for a batch's runs. `saved_in`: where the patch is. `saving`: False when nothing is saved (qa doctor).
  """
  if not state:
    return None
  if state.get('dirty') is None:
    if state.get('error'):
      return f"unknown: {state['error']}"
    return "unknown: git took too long (outputs.local_changes.timeout, and `qa doctor` to make it faster)" if state.get('timed_out') else "unknown"
  if state.get('dirty') and 'files_total' not in state:
    line = "the code differs from the commit, but git took too long to say how"
  elif state.get('dirty'):
    n = state.get('files_total', 0)
    new = sum(1 for f in state.get('files') or [] if f.get('status') == '?')
    line = f"{n} file{'s' if n != 1 else ''}{f' ({new} new)' if new else ''}, +{state.get('added', 0)} -{state.get('deleted', 0)}"
  else:
    line = "none, the code is the commit's"
  if state.get('pushed') is False:
    n = state.get('unpushed_commits') or 0
    line += f"; {n} commit{'s' if n != 1 else ''} not pushed"
  notes = []
  if state.get('untracked_contents') == 'too_many':
    notes.append(f"{state.get('untracked', 0)} new files listed without their contents: too many (add them to .gitignore, or to outputs.local_changes.exclude)")
  if state.get('untracked_too_large'):
    large = state['untracked_too_large']
    notes.append(f"new files too large to include: {', '.join(large[:3])}{'...' if len(large) > 3 else ''}")
  if state.get('excluded'):
    excluded = state['excluded']
    notes.append(f"not saved, they look like secrets or are excluded: {', '.join(excluded[:3])}{'...' if len(excluded) > 3 else ''}")
  patch = state.get('patch') or {}
  if saving and (state.get('dirty') or state.get('pushed') is False):
    if patch.get('path') or (state.get('unpushed') or {}).get('path'):
      line += ", saved with each run" if batch else (f", saved in {saved_in}" if saved_in else ", saved with the run")
    elif patch.get('omitted') == 'too_large':
      line += f"; the patch is {-(-patch.get('bytes', 0) // 1024)} KB, too large to save (outputs.local_changes.max_patch_kb)"
    elif patch.get('omitted') == 'level':
      line += "; only this summary is saved: the server keeps no code (runs.local_changes)"
    elif patch.get('omitted') == 'no_answer':
      line += "; the patch isn't saved: the server didn't answer when the run started"
    elif (patch.get('omitted') == 'timeout' or state.get('timed_out')) and 'files_total' in state:
      line += "; git took too long to compute the patch (outputs.local_changes.timeout, `qa doctor`)"
    elif patch.get('omitted') == 'unreadable':
      line += "; the patch the batch saved can't be read on this machine: only this summary is saved"
    elif patch.get('omitted') == 'error':
      line += f"; the patch couldn't be saved{': ' + patch['error'] if patch.get('error') else ''}"
  if state.get('changed_since_batch'):
    notes.append("the code changed since the batch started")
  return '; '.join([line, *notes])


# --- qa batch captures once, its runs read it ---

def cache_dir() -> Path:
  return Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'qaboard' / 'local-changes'


def share(capture: Capture, *, max_age_days: float = 7) -> Path | None:
  """
  Saves a capture where the runs of a batch read it: a JSON file named by its content, the patches next to it,
  in the user's cache. Removes what wasn't used for max_age_days. Returns the JSON's path, None if we couldn't save it.
  """
  directory = cache_dir()
  try:
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    now = time.time()
    for entry in os.scandir(directory):
      try:
        if now - entry.stat().st_mtime > max_age_days * 86400:
          os.remove(entry.path)
      except OSError:
        pass
    shared: dict[str, Any] = {'state': capture.state, 'fingerprint': capture.fingerprint, 'captured_at': capture.captured_at, 'host': capture.host}
    for content, key in ((capture.patch, 'patch'), (capture.unpushed, 'unpushed')):
      if content is not None:
        path = directory / f"{hashlib.sha256(content).hexdigest()}.patch"
        if path.exists():
          # used again: not removed while this batch's runs need it
          os.utime(path)
        else:
          _write_private(path, content)
        shared[key] = str(path)
    text = json.dumps(shared, sort_keys=True).encode()
    path = directory / f"{hashlib.sha256(text).hexdigest()[:32]}.json"
    _write_private(path, text)
    return path
  except OSError:
    return None


def _write_private(path: Path, content: bytes) -> None:
  tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
  fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  with os.fdopen(fd, 'wb') as f:
    f.write(content)
  os.replace(tmp, path)


def shared(environ: Mapping[str, str] = os.environ) -> Capture | None:
  """What `qa batch` captured for its runs, if it did. Runs on machines that can't read the patches keep the summary."""
  path = environ.get(ENV_STATE)
  if not path:
    return None
  try:
    data = json.loads(Path(path).read_text())
    state = dict(data['state'])
  except (OSError, ValueError, KeyError, TypeError):
    return None
  state['scope'] = 'batch'
  contents: dict[str, bytes | None] = {}
  for key in ('patch', 'unpushed'):
    contents[key] = None
    if data.get(key):
      try:
        contents[key] = Path(data[key]).read_bytes()
      except OSError:
        if (state.get(key) or {}).get('path'):
          state[key] = {**{k: v for k, v in state[key].items() if k != 'path'}, 'omitted': 'unreadable'}
  captured_at = data.get('captured_at')
  return Capture(state, contents['patch'], contents['unpushed'], data.get('fingerprint'),
                 captured_at if isinstance(captured_at, (int, float)) else None, data.get('host') if isinstance(data.get('host'), str) else None)


def _fresh(capture: Capture, now: float | None = None) -> bool:
  """Captured on this machine a few seconds ago (FRESH_BATCH_SECONDS): its clock says how long ago"""
  if capture.captured_at is None or not capture.host or capture.host != _host():
    return False
  age = (time.time() if now is None else now) - capture.captured_at
  return 0 <= age <= FRESH_BATCH_SECONDS


def inside(root: Path | None, folders: Sequence[Path | None]) -> list[str]:
  """The folders' paths relative to root, for those inside it: what capture() ignores, e.g. where runs are saved"""
  if root is None:
    return []
  paths = []
  real_root = os.path.realpath(root)
  for folder in folders:
    if folder is None:
      continue
    real = os.path.realpath(folder)
    if real != real_root and real.startswith(real_root + os.sep):
      paths.append(Path(os.path.relpath(real, real_root)).as_posix())
  return paths


class ForRun:
  """
  What a run records, in two steps: capture() when it starts, then save() in its folder once the server said how
  much it may record (`local_changes_level` in its answer; older servers don't say).

  In a batch, the run reuses what `qa batch` captured when it started, unless the code changed since: it checks
  the working tree's fingerprint (git status, and the changed files' times), which is cheaper than the patch. Runs
  that start on the batch's machine within FRESH_BATCH_SECONDS of its capture don't check.
  """
  def __init__(self, value: Any = None, *, repo_root: Path | None, is_ci: bool, ignore: Sequence[str] = (),
               commit: str | None = None, environ: Mapping[str, str] = os.environ):
    self.settings, self.problems = settings(value, environ=environ, is_ci=is_ci)
    self.capture: Capture | None = None
    self.state: dict[str, Any] | None = None
    # whether the code changed since the batch started
    self.changed_since_batch = False
    if self.settings.level == 'off' or repo_root is None:
      return
    batch = shared(environ)
    # the batch started on another commit: people committed while it ran
    if batch is not None and commit and batch.state.get('head') not in (None, commit):
      batch = None
    if batch is not None and _fresh(batch):
      self.capture = batch
    elif batch is not None and batch.fingerprint:
      now = fingerprint(Path(repo_root), self.settings, ignore=ignore)
      # git took too long to tell: what the batch saw is the best we know
      if now is None or now == batch.fingerprint:
        self.capture = batch
      else:
        self.changed_since_batch = True
    if self.capture is None:
      self.capture = capture(Path(repo_root), self.settings, ignore=ignore)
      if self.capture is not None and self.changed_since_batch:
        self.capture.state['changed_since_batch'] = True
    # runs of another commit than HEAD (e.g. given by the environment) didn't run the working tree
    if self.capture is not None and commit and self.capture.state.get('head') and self.capture.state['head'] != commit:
      self.capture = None
      return
    if self.capture is not None:
      self.capture.state.setdefault('scope', 'run')
      # what we can say before the server answers: not yet where the patches are
      self.state = {k: v for k, v in self.capture.state.items() if k not in ('patch', 'unpushed')}

  def save(self, run_dir: Path, server_level: str | None = None, *, unanswered: bool = False) -> dict[str, Any] | None:
    """
    Saves the patches at the lowest of the project's level and the server's. `unanswered`: the server should have
    said its level and didn't (it was away): we save no code it may not want, only the summary.
    """
    if self.capture is None:
      return None
    level = lowest(self.settings.level, server_level) if server_level in LEVELS else self.settings.level
    if unanswered:
      level = lowest(level, 'summary')
    self.state = save(self.capture, run_dir, level) or None
    if unanswered and self.state and (self.state.get('patch') or {}).get('omitted') == 'level':
      self.state['patch'] = {'omitted': 'no_answer'}
    return self.state

  def data(self) -> dict[str, Any]:
    """What the run sends in its `data`"""
    if not self.state:
      return {}
    return {'local_changes': self.state, 'dirty': self.state.get('dirty')}
