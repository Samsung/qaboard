"""
Where the reruns of a run are saved: each attempt has its own directory (docs/rfcs/rerun-directories.md).

    output/<configurations>/<input>/                    the first attempt: where runs were always saved
    output/<configurations>/<input>/latest_attempt.txt  "3": written when the run is done again
    output/<configurations>/<input>_attempt3/           the third attempt

A run has one result, its latest attempt's: earlier attempts' files are removed when a new attempt starts, except
their logs, kept in the new attempt's directory as log.attempt1.txt, log.attempt2.txt..., and the logs runners wrote
next to them as log.attempt1.lsf.txt...: when a scheduler killed a job, e.g. it used too much memory, they say why.
Everything here only reads and writes the storage, so that it works offline, and from the server.

The names of run directories only have 0-9 a-z . = - (conventions.slugify_hash): the "_" of the suffix can't come
from an input's name, and needs no quoting in shells, on Windows or in URLs.
"""
import os
import re
import uuid
import errno
from pathlib import Path

import click

# In the first attempt's directory: the number of the latest attempt, as text. No file means 1.
POINTER = 'latest_attempt.txt'
SUFFIX = '_attempt'
ATTEMPT_DIR = re.compile(rf'^(?P<first>.+){SUFFIX}(?P<attempt>[1-9][0-9]*)$')
# What says a run started in a directory, or ran there: `qa run` writes run.json first, and deleting a run's files
# (in the web app, by retention rules) keeps its manifest. Runners' logs and scripts, written before, don't.
STARTED_MARKERS = ('run.json', 'manifest.outputs.json')
IN_PLACE, NEW_DIRECTORY = 'in-place', 'new-directory'
# The log of a run, and those of its earlier attempts, kept in the latest attempt's directory: the last MAX_KEPT_LOGS
LOG = 'log.txt'
# What runners write next to it (qaboard/runners/): LSF's output and job report, which says why LSF ended the job,
# Dask's, the output of a Kubernetes pod, why a pod was pending. Kept as log.attempt<N>.<runner>.txt
RUNNER_LOGS = ('log.lsf.txt', 'log.dask.txt', 'log.k8s.txt', 'log.pending.txt')
ATTEMPT_LOG = re.compile(r'^log\.attempt(?P<attempt>[1-9][0-9]*)(?:\.(?P<runner>[a-z0-9]+))?\.txt$')
MAX_KEPT_LOGS = 10


def attempt_log(attempt: int, log: str = LOG) -> str:
  """The name an earlier attempt's log is kept as: log.txt -> log.attempt3.txt, log.lsf.txt -> log.attempt3.lsf.txt"""
  return f"log.attempt{attempt}{log[len('log'):]}"


def _kept(output_dir: Path) -> list[tuple[int, str]]:
  """(attempt, name) of the earlier attempts' logs in the directory"""
  try:
    names = os.listdir(output_dir)
  except OSError:
    return []
  kept = []
  for name in names:
    match = ATTEMPT_LOG.match(name)
    if match and (match['runner'] is None or f"log.{match['runner']}.txt" in RUNNER_LOGS):
      kept.append((int(match['attempt']), name))
  return kept


def kept_logs(output_dir: Path) -> list[int]:
  """The earlier attempts whose log.txt is in the directory"""
  return sorted(attempt for attempt, name in _kept(output_dir) if name == attempt_log(attempt))


def kept_log_files(output_dir: Path) -> list[str]:
  """The names of the earlier attempts' logs in the directory, theirs and their runners', by attempt"""
  return [name for _, name in sorted(_kept(output_dir))]


def kept_logs_data(output_dir: Path) -> dict:
  """What `qa` tells the server of the earlier attempts' logs (Output.data)"""
  return {"attempt_logs": kept_logs(output_dir), "attempt_log_files": kept_log_files(output_dir)}


def attempt_dir(first_dir: Path, attempt: int) -> Path:
  """Where an attempt is saved, given the first attempt's directory"""
  return first_dir if attempt <= 1 else first_dir.with_name(f"{first_dir.name}{SUFFIX}{attempt}")


def split(output_dir) -> tuple[Path, int]:
  """An attempt's directory -> (the first attempt's directory, the attempt's number)"""
  output_dir = Path(output_dir)
  match = ATTEMPT_DIR.match(output_dir.name)
  if not match or int(match['attempt']) < 2:
    return output_dir, 1
  return output_dir.with_name(match['first']), int(match['attempt'])


def attempt_of(output_dir) -> int:
  return split(output_dir)[1]


def latest_attempt(first_dir: Path) -> int:
  for tries in (1, 2):
    try:
      return max(1, int((first_dir / POINTER).read_text().strip()))
    except OSError as e:
      # NFS: latest_attempt.txt was replaced on another host, and this one still had the old file's handle. Once
      # more gets the new file, else we'd say attempt 1, and runs would be read from, or saved to, the wrong one
      if e.errno == errno.ESTALE and tries == 1:
        continue
      return 1  # no file: the run wasn't done again
    except ValueError:
      return 1
  return 1


def latest_dir(first_dir: Path) -> Path:
  """Where the run's results are: its latest attempt's directory."""
  return attempt_dir(first_dir, latest_attempt(first_dir))


def started(output_dir: Path) -> bool:
  """Whether a run started in the directory, or ran there."""
  return any((output_dir / marker).exists() for marker in STARTED_MARKERS)


def _next_attempt(first_dir: Path) -> tuple[int, bool]:
  """The attempt a new run would use, and whether latest_attempt.txt must say so"""
  if not first_dir.is_dir(): # the usual case, a run's first attempt: one stat
    return 1, False
  attempt = latest_attempt(first_dir)
  if not started(attempt_dir(first_dir, attempt)):
    return attempt, False
  attempt += 1
  # directories left by attempts latest_attempt.txt forgot (it was removed by hand...): paths are never used twice
  while attempt_dir(first_dir, attempt).exists():
    attempt += 1
  return attempt, True


def next_dir(first_dir: Path) -> Path:
  """
  Where a new attempt of the run would be saved, without reserving it: what `reserve` would return now.
  For `qa batch --list` and --dryrun, which say where the runs they would start would be.
  """
  return attempt_dir(first_dir, _next_attempt(first_dir)[0])


def reserve(first_dir: Path) -> Path:
  """
  The directory for a new attempt of the run. It stays the same until a run starts in it: `qa batch` reserves it,
  says where the run will be and sends the runners' logs there, then the job's `qa run` reserves it again.
  Raises OSError when latest_attempt.txt can't be written, e.g. the first attempt's directory belongs to someone else.
  """
  attempt, new = _next_attempt(first_dir)
  if not new:
    return attempt_dir(first_dir, attempt)
  # atomic: readers see the previous attempt or this one
  # unique: on shared storage, processes on two hosts can have the same pid
  temporary = first_dir / f"{POINTER}.{uuid.uuid4().hex}.tmp"
  try:
    temporary.write_text(f"{attempt}\n")
    os.replace(temporary, first_dir / POINTER)
  except OSError:
    try:
      temporary.unlink()
    except OSError:
      pass
    raise
  return attempt_dir(first_dir, attempt)


def move_file(source: Path, destination: Path) -> bool:
  """Best effort: the file may belong to someone else, then we copy it."""
  import shutil
  try:
    os.replace(source, destination)
    return True
  except OSError:
    try:
      shutil.copyfile(source, destination)
      return True
    except OSError:
      return False


def keep_previous_logs(previous: Path, output_dir: Path, previous_attempt: int) -> None:
  """
  Moves the logs of the previous attempt to the new attempt's directory, as log.attempt<N>.txt and
  log.attempt<N>.lsf.txt..., with the logs it kept from the attempts before it. A failed attempt's logs are often
  all that says why a run was done again. The logs of the last MAX_KEPT_LOGS attempts are kept.
  A runner's log our own output goes to stays: a job its scheduler started again writes there (see remove_previous).
  """
  from .utils import own_log_files
  logs: dict[int, list[tuple[Path, str]]] = {}
  for attempt, name in _kept(previous):
    if attempt < previous_attempt:
      logs.setdefault(attempt, []).append((previous / name, name))
  own = own_log_files()
  for log in (LOG, *RUNNER_LOGS):
    path = previous / log
    if log != LOG and is_own_file(path, own):
      continue
    if path.is_file():
      logs.setdefault(previous_attempt, []).append((path, attempt_log(previous_attempt, log)))
  for attempt in sorted(logs)[-MAX_KEPT_LOGS:]:
    for path, name in logs[attempt]:
      move_file(path, output_dir / name)


def is_own_file(path: Path, own: set[tuple[int, int]]) -> bool:
  """Whether `path` is one of the files (device, inode) in `own`"""
  try:
    path_stat = path.stat()
  except OSError:
    return False
  return (path_stat.st_dev, path_stat.st_ino) in own


def remove_previous(output_dir: Path) -> None:
  """
  When a new attempt starts in `output_dir`: keeps the logs of the attempt before it (and those it kept), then
  removes its files. Best effort, like the rerun in place that emptied the directory.
  The first attempt's directory stays, for latest_attempt.txt.
  """
  from .utils import clean_output_dir
  first_dir, attempt = split(output_dir)
  if attempt < 2:
    return
  previous = attempt_dir(first_dir, attempt - 1)
  if not previous.is_dir():
    return
  is_first = previous == first_dir
  try:
    output_dir.mkdir(parents=True, exist_ok=True)
    keep_previous_logs(previous, output_dir, attempt - 1)
  except OSError as e:
    click.secho(f"WARNING: Could not keep the log of the previous attempt. [{e}]", fg='yellow', err=True)
  # Not rmtree: a job that LSF started again has its output redirected to a log in the previous attempt
  clean_output_dir(previous, keep=(POINTER,) if is_first else ())
  if is_first:
    left = [path.name for path in previous.iterdir() if path.name != POINTER]
  else:
    try:
      previous.rmdir()
      left = []
    except OSError:
      left = [path.name for path in previous.iterdir()] if previous.is_dir() else []
  if left:
    click.secho(f"WARNING: Could not remove the files of the previous attempt ({', '.join(sorted(left)[:3])}{'...' if len(left) > 3 else ''}): {previous}", fg='yellow', err=True)


def forget(output_dir) -> Path | None:
  """
  After a run's directory was removed for good (hard delete): removes the first attempt's directory if only
  latest_attempt.txt is left in it. Returns the directory removed, if any.
  A run done again after that starts from its first attempt.
  """
  first_dir, attempt = split(output_dir)
  if attempt < 2:
    return None
  try:
    if [path.name for path in first_dir.iterdir()] != [POINTER]:
      return None
    (first_dir / POINTER).unlink()
    first_dir.rmdir()
  except OSError:
    return None
  return first_dir


def reruns_mode(config: dict | None) -> str:
  """`outputs.reruns` in qaboard.yaml, or $QA_RERUNS: 'new-directory' (default) or 'in-place'"""
  mode = os.environ.get('QA_RERUNS') or ((config or {}).get('outputs') or {}).get('reruns') or NEW_DIRECTORY
  return IN_PLACE if str(mode).lower().replace('_', '-') == IN_PLACE else NEW_DIRECTORY


def reserve_or_keep(output_dir: Path) -> Path:
  """
  The directory for a new attempt of the run whose latest attempt is in `output_dir`.
  When it can't be reserved, warns and returns `output_dir`: the run is done again in place.
  """
  first_dir, _ = split(output_dir)
  try:
    return reserve(first_dir)
  except OSError as e:
    click.secho(f"WARNING: Could not save the run in a new directory, it will replace the previous results in place. [{e}]", fg='yellow', err=True)
    return output_dir
