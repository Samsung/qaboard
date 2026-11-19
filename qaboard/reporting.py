"""
What a run tells the server besides its results, for `qa run` (qaboard/qa.py) and `qaboard.start_run()`
(qaboard/active_run.py): that it still runs (qaboard/heartbeat.py), and its files when there is no storage shared
with the server (qaboard/upload.py). One `RunReporter` per run:

    reporter = RunReporter(server, output_dir, uploads=True, live=["plots/*.png"])
    reporter.start(run_id)            # once the server knows the run: files as they change, heartbeats
    reporter.progress({...})          # PATCH .../progress: what the run looks like now, or beat() for "still running"
    reporter.finish(create=...)       # the run's work is done: all its files. `create()` first when the server
                                      # never heard of the run: it only takes the files of a run it knows
    ...                               # the caller tells the server how the run ended (POST /api/v1/output/)
    reporter.ended(known=...)         # then: the end of the log if the server refused that, and heartbeats stop

What the run says about itself (identity, metrics, how it ended) is the caller's: `qa run` and start_run() build it
from different places (qaboard/payloads.py). The reporter doesn't print either: callers say what went wrong in their
words, from `uploader.problems()`, `files_sent` and `known`.

Every step can be called again, or skipped: `start()` once the run has an id, `finish()` once, `close()` (or the end
of a `with` block) stops the threads without sending anything more. Thread-safe: the run's own thread can call
`start()` when the server answers while the main thread finishes it.
"""
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Union

from . import heartbeat
from .results import ResultsError, _request
from .upload import SYNC_INTERVAL, Uploader


class RunReporter:
  """
  - uploads: the run's files are sent to the server, not saved in a storage it reads
  - live: patterns of files also sent while the run goes on (`outputs.live` in qaboard.yaml)
  - sync_interval: how often files are sent while the run goes on
  - beat_while_running: a thread says the run still runs every heartbeat.INTERVAL, from `start()`. False when the
    caller reports its progress itself (start_run() sends its metrics): the thread then only runs from `finish()`,
    while the last files go, which can take longer than the time after which the server fails silent runs
  - before_log: called before the log is sent at the end, e.g. to wait for what was just printed to reach it
  """
  def __init__(self, server: str, directory: Union[str, Path], *, token: Optional[str] = None, uploads: bool = False,
               live: Union[str, Sequence[str], None] = None, sync_interval: float = SYNC_INTERVAL,
               beat_while_running: bool = True, heartbeat_interval: Optional[float] = None,
               before_log: Optional[Callable[[], None]] = None):
    self.server = server
    self.directory = Path(directory)
    self.uploads = uploads
    self.live = live
    self.sync_interval = sync_interval
    self.beat_while_running = beat_while_running
    self.heartbeat_interval = heartbeat_interval
    self.id: Optional[int] = None
    self.uploader: Optional[Uploader] = None
    # after finish(): whether the server has all the run's files (True when it doesn't take them: they aren't its)
    self.files_sent: Optional[bool] = None
    # False once the server said it doesn't take heartbeats: older servers don't fail silent runs either
    self.heartbeats = True
    self._token = token
    self._before_log = before_log
    self._heartbeat: Optional[heartbeat.Heartbeat] = None
    self._reported_at = time.time()
    self._finishing = False
    self._closed = False
    self._lock = threading.RLock()

  @property
  def known(self) -> bool:
    """Whether the server knows the run"""
    return self.id is not None

  @property
  def finished(self) -> bool:
    """Whether `finish()` was called"""
    return self._finishing

  # --- while the run goes on -----------------------------------------------------------------------------------------
  def start(self, run_id: int) -> 'RunReporter':
    """The server knows the run: its files go as they change, and heartbeats start (see `beat_while_running`)"""
    with self._lock:
      if self._closed:
        return self
      if self.id is None:
        self.id = run_id
      self.reported()
      if self.uploads and self.uploader is None:
        self.uploader = Uploader(self.server, self.id, self.directory, token=self._token, live=self.live)
        if not self._finishing:
          self.uploader.start(interval=self.sync_interval)
      if self.beat_while_running or self._finishing:
        self._start_heartbeat()
    return self

  def reported(self) -> None:
    """The server just heard from the run, e.g. it took a request about it: no heartbeat needed for a while"""
    self._reported_at = time.time()

  def silent_for(self) -> float:
    """How long since the server last heard from the run, in seconds"""
    return time.time() - self._reported_at

  def progress(self, body: Dict[str, Any], timeout: Any = heartbeat.TIMEOUT) -> None:
    """PATCH /api/v1/output/<id>/progress: what the run looks like now (its metrics...). Raises ResultsError"""
    assert self.id is not None, "the server doesn't know the run yet"
    _request(self.server, f"output/{self.id}/progress", method='PATCH', json=body, token=self._token, timeout=timeout)
    self.reported()

  def beat(self) -> bool:
    """
    Says once that the run still runs. Returns False, and stops trying, when the server doesn't take heartbeats.
    Raises ResultsError when it may later: it is away, or the token is refused.
    """
    if not self.heartbeats or self.id is None:
      return False
    try:
      heartbeat.beat(self.server, self.id, self._token)
    except ResultsError as e:
      if e.is_transient or e.status in (401, 403):
        raise
      # a server from before runs reported their progress: it doesn't fail silent runs either
      self.heartbeats = False
      return False
    self.reported()
    return True

  # --- when it ends --------------------------------------------------------------------------------------------------
  def finish(self, create: Optional[Callable[[], Optional[int]]] = None) -> bool:
    """
    The run's work is done: sends all its files, before the caller says how it ended (the files of finished runs
    don't change). `create()`: when the server never heard of the run, tells it that it runs, and returns its id or
    None: it only takes the files of a run it knows. Returns whether the server has all the run's files. Called
    again, returns the same.
    """
    with self._lock:
      if self._finishing:
        return bool(self.files_sent)
      self._finishing = True
    if not self.uploads:
      self.files_sent = True
      return True
    if self.id is None and create is not None:
      run_id = create()
      if run_id is not None:
        self.start(run_id)
    if self.id is not None:
      self.start(self.id)  # the uploader, without its thread, when the server learned of the run just now
    if self.uploader is None:
      self.files_sent = False
      return False
    self._start_heartbeat()
    self._wait_for_the_log()
    self.files_sent = self.uploader.finish()
    return self.files_sent

  def send_log(self) -> bool:
    """
    After `finish()`: sends what was added to log.txt since, e.g. which files couldn't be sent. The server takes it
    until it hears that the run ended, or after it refused that. Returns whether it has the whole log.
    """
    if self.uploader is None or not self._finishing:
      return False
    self._wait_for_the_log()
    return self.uploader.send_log()

  def ended(self, known: bool) -> None:
    """
    The caller told the server how the run ended. `known`: whether the server took that. If it refused it, its
    log still gets why: what the caller printed. Then nothing more is sent.
    """
    if not known:
      self.send_log()
    self.close()

  def close(self) -> None:
    """Stops sending anything: the files' thread and the heartbeats. Idempotent"""
    with self._lock:
      self._closed = True
      beating, self._heartbeat = self._heartbeat, None
      uploader = self.uploader
    if beating is not None:
      beating.stop()
    if uploader is not None:
      uploader.stop()

  def problems(self) -> List[str]:
    """Why the server doesn't have all the run's files, after `finish()` returned False: one line each"""
    return self.uploader.problems() if self.uploader is not None else []

  def __enter__(self) -> 'RunReporter':
    return self

  def __exit__(self, *exc: Any) -> None:
    self.close()

  # --- internals -----------------------------------------------------------------------------------------------------
  def _start_heartbeat(self) -> None:
    with self._lock:
      if self._heartbeat is None and self.heartbeats and self.id is not None and not self._closed:
        interval = self.heartbeat_interval if self.heartbeat_interval is not None else heartbeat.INTERVAL
        self._heartbeat = heartbeat.Heartbeat(self.server, self.id, self._token, interval=interval).start()

  def _wait_for_the_log(self) -> None:
    if self._before_log is not None:
      try:
        self._before_log()
      except Exception:
        pass
