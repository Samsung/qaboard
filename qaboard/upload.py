"""
Sends a run's files to the server, for runs that don't save them in a storage shared with it (`storage: upload`
in qaboard.yaml, or no storage at all): GitHub-hosted CI, a laptop, a cluster without the shared volume.

The run writes its files in a local folder, like a run that isn't shared. An `Uploader` sends that folder to the
server (PUT /api/v1/output/<id>/files/<path>, backend/uploads.py), which saves it where it serves runs' files from.
`qa run` and `qaboard.start_run()` both use it, through their run's reporter (qaboard/reporting.py):

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
import sys
from concurrent.futures import ThreadPoolExecutor
from fnmatch import fnmatchcase
from pathlib import Path
from threading import Event, Lock, Thread, current_thread
from typing import Dict, Iterator, List, Optional, Sequence, Set, Tuple, Union
from urllib.parse import quote

from .conventions import Reason, RUN_FILES_REFUSALS
from .http_client import ResultsError, FILE_TIMEOUT, FINAL_RETRY_DELAYS, RETRY_DELAYS, request

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
# (connect, read) timeouts. How long we wait before trying a request again: RETRY_DELAYS (qaboard/http_client.py),
# FINAL_RETRY_DELAYS at the end: what isn't sent then is lost
TIMEOUT = FILE_TIMEOUT
# Why the server won't take any file of the run: we stop asking
FATAL_REASONS = RUN_FILES_REFUSALS
# How much of the end of what we sent of a growing file we remember, to know it is still the same file
TAIL_SIZE = 64

Stat = Tuple[int, int]  # size, mtime_ns


def is_outside_link(file: Path, folder: Path) -> bool:
  """A symbolic link to something outside `folder`, e.g. ~/.ssh: not sent, it isn't the run's"""
  if not os.path.islink(file):
    return False
  try:
    Path(file).resolve().relative_to(Path(folder).resolve())
  except (ValueError, OSError, RuntimeError):
    return True
  return False


def warn_outside_links(links: Sequence[str], limit: int = 5) -> None:
  shown = ', '.join(links[:limit]) + (f" and {len(links) - limit} more" if len(links) > limit else '')
  print(f"WARNING: not sending links to files outside the run's folder: {shown}", file=sys.stderr)


def is_temporary(name: str) -> bool:
  """Files being written, e.g. by log_artifact(): .<name>.<pid>.tmp"""
  return name.startswith('.') and name.endswith('.tmp')


class Uploader:
  """
  Sends the files of `directory` to the run `run_id` of `server`.
  - `live`: patterns of files also sent while the run goes on, like "plots/*.png" (`outputs.live` in qaboard.yaml)
  - after `sync()`: `refused` says why the server takes no file of this run, `failed` which files it doesn't have
    and why (`problems()` says both in a few lines), `sent_files` and `sent_bytes` what was sent.
  """
  def __init__(self, server: str, run_id: int, directory: Path, token: Optional[str] = None, live: Union[str, Sequence[str], None] = None):
    self.server = server
    self.run_id = run_id
    self.directory = Path(directory)
    self.live = (live,) if isinstance(live, str) else tuple(str(pattern) for pattern in live or ())
    self.refused: Optional[str] = None
    self.failed: Dict[str, str] = {}
    self.sent_files = 0
    self.sent_bytes = 0
    self._token = token
    # What the server has, as far as we know. Whole files: their size and date when we sent them
    self._sent: Dict[str, Stat] = {}
    # Growing files: how much we sent, and the end of it
    self._offsets: Dict[str, int] = {}
    self._tails: Dict[str, bytes] = {}
    # Files the server won't take as they are, e.g. too large: not sent again until they change
    self._rejected: Dict[str, Tuple[Stat, str]] = {}
    self._sync_lock = Lock()   # one sync() at a time: the thread's, or the last one
    self._state_lock = Lock()  # files are sent from several threads
    self._thread: Optional[Thread] = None
    self._stop = Event()
    # set by the last sync(): what fails then is lost, we try longer (FINAL_RETRY_DELAYS)
    self._final = False
    # a file still failed after the longest retries: the others don't wait as long
    self._unreachable = False
    # links to files outside the folder, not sent (warned once each)
    self.outside_links: Set[str] = set()
    self._new_links: List[str] = []

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
    self.stop()
    return self.sync(final=True)

  def stop(self) -> None:
    """Stops the thread of `start()`, without sending anything more. Idempotent"""
    self._stop.set()
    thread, self._thread = self._thread, None
    if thread is not None and thread is not current_thread():
      thread.join()

  def sync(self, final: bool = False) -> bool:
    """
    Sends what changed in the folder since the last call: while the run goes on, the files people look at then;
    with `final`, everything. Returns whether the server has all it should. Never raises.
    """
    with self._sync_lock:
      self._final = self._final or final
      try:
        # at the end, once more for the files that changed while we sent them
        for _ in range(2 if final else 1):
          if self.refused:
            return False
          try:
            if self._send_changes(final):
              return True
          except Exception as e: # sending files must not end runs
            self._fail('', repr(e))
        return False
      finally:
        with self._state_lock:
          links, self._new_links = self._new_links, []
        if links:
          warn_outside_links(sorted(links))

  def send_log(self) -> bool:
    """
    Sends what was added to log.txt only, e.g. after `finish()`, what was printed about the files that weren't sent:
    the server still takes it until it hears the run ended. Returns whether it has the whole log. Never raises.
    """
    with self._sync_lock:
      if self.refused:
        return False
      try:
        return self._append('log.txt')
      except Exception as e:
        return self._fail('log.txt', repr(e))

  def problems(self, limit: int = 5) -> List[str]:
    """What to tell the user after a `sync()` that returned False: one line per problem"""
    if self.refused:
      return [f"the server doesn't take the run's files: {self.refused}"]
    failed = list(self.failed.items())
    lines = [f"{path}: {message}" if path else message for path, message in failed[:limit]]
    if len(failed) > limit:
      lines.append(f"... and {len(failed) - limit} more files")
    return lines

  # --- which files ---------------------------------------------------------------------------------------------------
  def _send_changes(self, final: bool) -> bool:
    with self._state_lock:
      self.failed = {}
    ok = all([self._append(path) for path in APPENDED_FILES])
    files = [(path, stat) for path, stat in self._files(final) if self._sent.get(path) != stat]
    if files and not self.refused:
      with ThreadPoolExecutor(max_workers=min(WORKERS, len(files)), thread_name_prefix='qaboard-upload') as pool:
        ok = all(list(pool.map(lambda file: self._put(*file), files))) and ok
    return ok and not self.refused

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

  def _stat(self, file: Path) -> Optional[Stat]:
    """The size and date of a file to send, None when there is none or it's a link out of the folder"""
    if is_outside_link(file, self.directory):
      path = Path(file).relative_to(self.directory).as_posix()
      with self._state_lock:
        if path not in self.outside_links:
          self.outside_links.add(path)
          self._new_links.append(path)
      return None
    try:
      stat = os.stat(file)
    except OSError:
      return None
    return (stat.st_size, stat.st_mtime_ns) if stat_module.S_ISREG(stat.st_mode) else None

  # --- sending -------------------------------------------------------------------------------------------------------
  def _put(self, path: str, stat: Stat) -> bool:
    """Sends a whole file. `stat`: what it was when we decided to send it; if it changes meanwhile, we send it again later."""
    if path in self._rejected and self._rejected[path][0] == stat:
      return self._fail(path, self._rejected[path][1])
    file = self.directory / path
    try:
      digest = hashlib.sha256()
      with open(file, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
          digest.update(chunk)
      self._request(path, lambda: open(file, 'rb'), headers={'X-Content-SHA256': digest.hexdigest()})
    except FileNotFoundError:
      return True  # the run removed it: nothing to send
    except (OSError, ResultsError) as e:
      return self._failed(path, stat, e)
    with self._state_lock:
      self._sent[path] = stat
      self.sent_files += 1
      self.sent_bytes += stat[0]
    return True

  def _append(self, path: str) -> bool:
    """Sends what was added to a file that grows since we last sent it, or all of it when it isn't what the server has"""
    file = self.directory / path
    stat = self._stat(file)
    if stat is None:
      return True
    if path in self._rejected and self._rejected[path][0] == stat:
      return self._fail(path, self._rejected[path][1])
    size, offset = stat[0], self._offsets.get(path, 0)
    try:
      with open(file, 'rb') as f:
        if not self._is_what_we_sent(f, path, size):
          # the run started the file again
          return self._put_growing(path, f, stat)
        f.seek(offset)
        while offset < size:
          chunk = f.read(min(APPEND_CHUNK, size - offset))
          if not chunk:
            break
          try:
            self._request(path, lambda: chunk, params={'offset': offset}, headers={'X-Content-SHA256': hashlib.sha256(chunk).hexdigest()})
          except ResultsError as e:
            if e.status == 409 and e.reason == Reason.OFFSET_MISMATCH:
              # the server has something else, e.g. what a previous process of the run sent
              return self._put_growing(path, f, stat)
            raise
          offset += len(chunk)
          self._sent_growing(path, offset, chunk)
    except FileNotFoundError:
      return True
    except (OSError, ResultsError) as e:
      return self._failed(path, stat, e)
    return True

  def _is_what_we_sent(self, f, path: str, size: int) -> bool:
    """Whether the file still starts with what we sent of it: not smaller, and the end of what we sent is there"""
    offset, tail = self._offsets.get(path, 0), self._tails.get(path, b'')
    if size < offset:
      return False
    f.seek(offset - len(tail))
    return f.read(len(tail)) == tail

  def _put_growing(self, path: str, f, stat: Stat) -> bool:
    """Sends a growing file whole, as it was when we looked: what is added meanwhile goes next time"""
    f.seek(0)
    content = f.read(stat[0])
    try:
      self._request(path, lambda: content, headers={'X-Content-SHA256': hashlib.sha256(content).hexdigest()})
    except ResultsError as e:
      return self._failed(path, stat, e)
    self._tails.pop(path, None)
    self._sent_growing(path, len(content), content)
    return True

  def _sent_growing(self, path: str, offset: int, sent: bytes) -> None:
    with self._state_lock:
      self._offsets[path] = offset
      self._tails[path] = (self._tails.get(path, b'') + sent)[-TAIL_SIZE:]
      self.sent_bytes += len(sent)

  def _request(self, path: str, body, params: Optional[Dict[str, int]] = None, headers: Optional[Dict[str, str]] = None) -> None:
    """One file's request, tried again when the server or the network had a problem. `body()` gives the content, or a file to read."""
    # PUTs are idempotent; appends too: when an answer is lost, trying again gets a 409 offset_mismatch, then the whole file
    final = self._final
    try:
      request(self.server, f"output/{self.run_id}/files/{quote(path)}", params=params, token=self._token, method='PUT', data=body,
              headers={'Content-Type': 'application/octet-stream', **(headers or {})}, timeout=TIMEOUT, retries=FINAL_RETRY_DELAYS if final else RETRY_DELAYS,
              give_up=lambda: bool(self.refused) or (final and self._unreachable)).close()
    except ResultsError as e:
      if final and e.is_transient:
        self._unreachable = True
      raise

  def _failed(self, path: str, stat: Stat, error: Exception) -> bool:
    """A file wasn't sent. Returns False"""
    status = getattr(error, 'status', None)
    reason = getattr(error, 'reason', None)
    if status in (401, 403) or reason in FATAL_REASONS:
      # no file of this run will be accepted
      self.refused = str(error)
    elif status is not None and 400 <= status < 500 and status not in (408, 409, 422, 429):
      # this file won't be accepted as it is, e.g. it is too large: not again until it changes
      self._rejected[path] = (stat, str(error))
    return self._fail(path, str(error))

  def _fail(self, path: str, message: str) -> bool:
    with self._state_lock:
      self.failed[path] = message
    return False
