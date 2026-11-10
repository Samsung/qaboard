"""
Where the reruns of a run are saved: each attempt has its own directory (docs/rfcs/rerun-directories.md).

    output/<configurations>/<input>/                    the first attempt: where runs were always saved
    output/<configurations>/<input>/latest_attempt.txt  "3": written when the run is done again
    output/<configurations>/<input>_attempt3/           the third attempt

A run has one result, its latest attempt's: earlier attempts' files are removed when a new attempt starts, except
their logs, kept in the new attempt's directory as log.attempt1.txt, log.attempt2.txt...
Everything here only reads and writes the storage, so that it works offline, and from the server.

The names of run directories only have 0-9 a-z . = - (conventions.slugify_hash): the "_" of the suffix can't come
from an input's name, and needs no quoting in shells, on Windows or in URLs.
"""
import os
import re
import uuid
import errno
from pathlib import Path
from typing import List, Optional, Tuple

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
ATTEMPT_LOG = re.compile(r'^log\.attempt(?P<attempt>[1-9][0-9]*)\.txt$')
MAX_KEPT_LOGS = 10


def attempt_log(attempt: int) -> str:
  return f"log.attempt{attempt}.txt"


def kept_logs(output_dir: Path) -> List[int]:
  """The earlier attempts whose logs are in the directory"""
  try:
    names = os.listdir(output_dir)
  except OSError:
    return []
  return sorted(int(match['attempt']) for match in map(ATTEMPT_LOG.match, names) if match)


def attempt_dir(first_dir: Path, attempt: int) -> Path:
  """Where an attempt is saved, given the first attempt's directory"""
  return first_dir if attempt <= 1 else first_dir.with_name(f"{first_dir.name}{SUFFIX}{attempt}")


def split(output_dir) -> Tuple[Path, int]:
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


def reserve(first_dir: Path) -> Path:
  """
  The directory for a new attempt of the run. It stays the same until a run starts in it: `qa batch` reserves it,
  says where the run will be and sends the runners' logs there, then the job's `qa run` reserves it again.
  Raises OSError when latest_attempt.txt can't be written, e.g. the first attempt's directory belongs to someone else.
  """
  if not first_dir.is_dir(): # the usual case, a run's first attempt: one stat
    return first_dir
  attempt = latest_attempt(first_dir)
  if not started(attempt_dir(first_dir, attempt)):
    return attempt_dir(first_dir, attempt)
  attempt += 1
  # directories left by attempts latest_attempt.txt forgot (it was removed by hand...): paths are never used twice
  while attempt_dir(first_dir, attempt).exists():
    attempt += 1
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
  Moves the log of the previous attempt to the new attempt's directory, as log.attempt<N>.txt, with the logs it
  kept from the attempts before it. A failed attempt's log is often all that says why a run was done again.
  """
  logs = {attempt: previous / attempt_log(attempt) for attempt in kept_logs(previous) if attempt < previous_attempt}
  if (previous / LOG).is_file():
    logs[previous_attempt] = previous / LOG
  for attempt in sorted(logs)[-MAX_KEPT_LOGS:]:
    move_file(logs[attempt], output_dir / attempt_log(attempt))


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


def forget(output_dir) -> Optional[Path]:
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


def reruns_mode(config: Optional[dict]) -> str:
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
