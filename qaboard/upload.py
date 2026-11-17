"""
Sends a run's files to the server, for runs that don't save them in a storage shared with it (`storage: upload`
in qaboard.yaml, or no storage at all): GitHub-hosted CI, a laptop, a cluster without the shared volume.

The run writes its files in a local folder, like a run that isn't shared. An `Uploader` sends that folder to the
server (PUT /api/v1/output/<id>/files/<path>, backend/uploads.py), which saves it where it serves runs' files from.
`qa run` and `qaboard.start_run()` both use it:

    uploader = Uploader(server, run_id, output_dir)
    uploader.start()            # a thread sends the run's log, series and metrics as it goes: uploader.sync()
    ...
    uploader.finish()           # when it ends: everything, uploader.sync(final=True)

Like the rest of what runs tell the server (qaboard/active_run.py), it sends the folder's state, not events:
`sync()` compares the files with what it sent and sends what differs. Nothing to replay when a request fails: the
next `sync()` sends what is missing, and the last one sends everything.

While the run goes on, only what people look at then is sent: the files that grow (log.txt, series.jsonl) by what
was added, the small files the run rewrites (series.json, run.json), and the files matching the project's
`outputs.live` patterns. The rest goes at the end.
"""
import hashlib
import os
import stat as stat_module
import time
from concurrent.futures import ThreadPoolExecutor
from fnmatch import fnmatchcase
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Dict, Iterator, List, Optional, Sequence, Tuple
from urllib.parse import quote

from .results import ResultsError, _request

# Files runs add to, at the root of their folder: we send what was added
APPENDED_FILES = ('log.txt', 'series.jsonl')
# Small files runs rewrite as they go, at the root of their folder
LIVE_FILES = ('series.json', 'run.json')
# What we read and send of a growing file per request
APPEND_CHUNK = 4 * 1024 * 1024
# How many files are sent at once when the run ends
WORKERS = 4
# How often the files that changed are sent while the run goes on, in seconds
SYNC_INTERVAL = 10.0
# (connect, read) timeouts, and how long we wait before trying a request again
TIMEOUT = (10.0, 600.0)
RETRY_DELAYS = (1.0, 4.0)
# Why the server won't take any file of the run: we stop asking
FATAL_REASONS = ('uploads_disabled', 'not_uploaded', 'not_running')

Stat = Tuple[int, int]  # size, mtime_ns


def is_temporary(name: str) -> bool:
  """Files being written, e.g. by log_artifact(): .<name>.<pid>.tmp"""
  return name.startswith('.') and name.endswith('.tmp')


class Uploader:
  """
  Sends the files of `directory` to the run `run_id` of `server`.
  - `live`: patterns of files also sent while the run goes on, like "plots/*.png" (`outputs.live` in qaboard.yaml)
  - after `sync()`: `refused` says why the server takes no file of this run, `failed` which files it didn't take
    and why, `sent_files` and `sent_bytes` what was sent.
  """
  def __init__(self, server: str, run_id: int, directory: Path, token: Optional[str] = None, live: Sequence[str] = ()):
    self.server = server
    self.run_id = run_id
    self.directory = Path(directory)
    self.live = tuple(str(pattern) for pattern in live or ())
    self.refused: Optional[str] = None
    self.failed: Dict[str, str] = {}
    self.sent_files = 0
    self.sent_bytes = 0
    self._token = token
    self._sent: Dict[str, Stat] = {}      # whole files, as they were when we sent them
    self._offsets: Dict[str, int] = {}    # growing files: how much the server has
    self._rejected: Dict[str, Stat] = {}  # files the server won't take as they are, e.g. too large
    self._lock = Lock()
    self._counters = Lock()
    self._thread: Optional[Thread] = None
    self._stop = Event()

  def start(self, interval: float = SYNC_INTERVAL) -> 'Uploader':
    """Sends what changes while the run goes on, from a thread, every `interval` seconds, until `finish()`"""
    def loop() -> None:
      while not self._stop.wait(interval):
        self.sync()
    if self._thread is None:
      self._thread = Thread(target=loop, name='qaboard-upload', daemon=True)
      self._thread.start()
    return self

  def finish(self) -> bool:
    """Sends everything that the server doesn't have yet, when the run ends. Returns whether it has it all."""
    self._stop.set()
    if self._thread is not None:
      self._thread.join()
      self._thread = None
    return self.sync(final=True)

  def sync(self, final: bool = False) -> bool:
    """
    Sends what changed in the folder since the last call: while the run goes on, the files people look at then;
    with `final`, everything. Returns whether the server has all it should. Never raises.
    """
    with self._lock:
      # at the end, once more for the files that changed while we sent them
      for _ in range(2 if final else 1):
        if self.refused:
          return False
        try:
          if self._send_changes(final):
            self.failed.pop('*', None)
            return True
        except Exception as e: # sending files must not end runs
          self.failed['*'] = repr(e)
      return False

  def _send_changes(self, final: bool) -> bool:
    ok = True
    for path in APPENDED_FILES:
      ok = self._append(path) and ok
    files = [(path, stat) for path, stat in self._files(final) if self._sent.get(path) != stat]
    # those the server refused as they are: said again, not sent again
    ok = ok and not any(self._rejected.get(path) == stat for path, stat in files)
    files = [(path, stat) for path, stat in files if self._rejected.get(path) != stat]
    if len(files) > 1 and not self.refused:
      with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix='qaboard-upload') as pool:
        ok = all(list(pool.map(lambda file: self._put(*file), files))) and ok
    else:
      ok = all([self._put(*file) for file in files]) and ok
    return ok and not self.refused

  # --- which files ---------------------------------------------------------------------------------------------------
  def _files(self, final: bool) -> Iterator[Tuple[str, Stat]]:
    """The whole files to send now, with their size and date: (path in the folder, with "/", stat)"""
    if not final and not self.live:
      # the usual case, every few seconds: no need to list a folder that may have thousands of files
      for name in LIVE_FILES:
        stat = self._stat(self.directory / name)
        if stat is not None:
          yield name, stat
      return
    for root, dirs, names in os.walk(self.directory):
      for name in names:
        file = Path(root) / name
        path = file.relative_to(self.directory).as_posix()
        if path in APPENDED_FILES or is_temporary(name):
          continue
        if not final and path not in LIVE_FILES and not any(fnmatchcase(path, pattern) for pattern in self.live):
          continue
        stat = self._stat(file)
        if stat is not None:
          yield path, stat

  @staticmethod
  def _stat(file: Path) -> Optional[Stat]:
    try:
      stat = os.stat(file)
    except OSError:
      return None
    return (stat.st_size, stat.st_mtime_ns) if stat_module.S_ISREG(stat.st_mode) else None

  # --- sending -------------------------------------------------------------------------------------------------------
  def _put(self, path: str, stat: Stat) -> bool:
    """Sends a whole file. `stat`: what it was when we decided to send it; if it changes meanwhile, we send it again later."""
    file = self.directory / path
    try:
      digest = hashlib.sha256()
      with open(file, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
          digest.update(chunk)
      self._request(path, lambda: open(file, 'rb'), headers={'X-Content-SHA256': digest.hexdigest()})
    except OSError:
      return True  # the run removed it: nothing to send
    except ResultsError as e:
      return self._failed(path, stat, e)
    self._sent[path] = stat
    self.failed.pop(path, None)
    self._count(stat[0])
    return True

  def _append(self, path: str) -> bool:
    """Sends what was added to a file that grows since we last sent it, or all of it if it isn't what the server has"""
    file = self.directory / path
    stat = self._stat(file)
    if stat is None:
      return True
    size, offset = stat[0], self._offsets.get(path, 0)
    if self._rejected.get(path) == stat:
      return False
    try:
      if size < offset:
        # the run started the file again
        return self._put_growing(path, file, stat)
      with open(file, 'rb') as f:
        f.seek(offset)
        while offset < size:
          chunk = f.read(min(APPEND_CHUNK, size - offset))
          if not chunk:
            break
          try:
            self._request(path, lambda: chunk, params={'offset': offset}, headers={'X-Content-SHA256': hashlib.sha256(chunk).hexdigest()})
          except ResultsError as e:
            if e.status == 409 and e.body.get('reason') == 'offset_mismatch':
              # the server has something else, e.g. what a previous process of the run sent
              return self._put_growing(path, file, stat)
            raise
          offset += len(chunk)
          self._offsets[path] = offset
          self._count(len(chunk), files=0)
    except OSError:
      return True
    except ResultsError as e:
      return self._failed(path, stat, e)
    self.failed.pop(path, None)
    return True

  def _put_growing(self, path: str, file: Path, stat: Stat) -> bool:
    try:
      with open(file, 'rb') as f:
        content = f.read(stat[0])
      self._request(path, lambda: content, headers={'X-Content-SHA256': hashlib.sha256(content).hexdigest()})
    except OSError:
      return True
    except ResultsError as e:
      return self._failed(path, stat, e)
    self._offsets[path] = len(content)
    self._count(len(content))
    return True

  def _request(self, path: str, body, params: Optional[Dict[str, int]] = None, headers: Optional[Dict[str, str]] = None) -> None:
    """One file's request, tried again when the server or the network had a problem. `body()` gives the content, or a file to read."""
    for delay in (*RETRY_DELAYS, None):
      data = body()
      try:
        _request(self.server, f"output/{self.run_id}/files/{quote(path)}", params=params, token=self._token, method='PUT',
                 data=data, headers={'Content-Type': 'application/octet-stream', **(headers or {})}, timeout=TIMEOUT)
        return
      except ResultsError as e:
        again = e.status is None or e.status in (408, 429, 502, 503, 504)
        if not again or delay is None or self.refused:
          raise
        time.sleep(delay)
      finally:
        if hasattr(data, 'close'):
          data.close()

  def _failed(self, path: str, stat: Stat, error: ResultsError) -> bool:
    reason = error.reason or error.body.get('reason')
    if error.status in (401, 403) or reason in FATAL_REASONS:
      # no file of this run will be accepted
      self.refused = str(error)
    elif error.status is not None and 400 <= error.status < 500 and error.status not in (408, 409, 422, 429):
      # this file won't be accepted as it is, e.g. it is too large: not again until it changes
      self._rejected[path] = stat
    self.failed[path] = str(error)
    return False

  def _count(self, size: int, files: int = 1) -> None:
    with self._counters:
      self.sent_files += files
      self.sent_bytes += size


def problems(uploader: Uploader, limit: int = 5) -> List[str]:
  """What to tell the user after a `sync()` that returned False: one line per problem"""
  if uploader.refused:
    return [f"the server doesn't take the run's files: {uploader.refused}"]
  lines = [f"{path}: {message}" if path != '*' else message for path, message in list(uploader.failed.items())[:limit]]
  if len(uploader.failed) > limit:
    lines.append(f"... and {len(uploader.failed) - limit} more files")
  return lines
