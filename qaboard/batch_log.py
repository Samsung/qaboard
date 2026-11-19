"""
`qa send-batch-log`: the log of a `qa batch` QA-Board started in a Kubernetes pod, for a project without a storage
shared with the server. The pod can't write the log where the web app reads it (the batch's folder on the server), so
the driver's script pipes its output here (backend/runner_jobs.py): it goes on to the pod's logs as it comes, and a thread
appends it to the batch's log.txt on the server every few seconds and at the end (PUT /api/v1/batch/submissions/<id>/log, with the
batch's token). A log the server refuses (e.g. the token was revoked) is only in the pod's logs: the server writes
how to read them at the top of log.txt, and we say so when output is missing.
"""
import os
import sys
import threading
from typing import BinaryIO, Callable, Optional

import click

# How often we send what was added: what came meanwhile goes in one request
INTERVAL = 3
# What we keep while the server is slow or can't be reached: older output is only in the pod's logs
MAX_PENDING = 4 * 1024 * 1024
# Under what proxies accept by default (nginx: 1 MiB)
MAX_REQUEST = 512 * 1024
# At the end, how long we try to send what's left: the batch waits for us (backend/artifacts.py's EXIT_TRAP)
FLUSH_TIMEOUT = 60
# How to read the pod's logs, e.g. `kubectl logs -n <namespace> job/<driver>`
POD_LOGS_VARIABLE = 'QABOARD_POD_LOGS'


class LogSender:
  """
  Sends what is added to a log, at the offset the server has: `put(offset, data)` returns the log's new size.
  `add()` never waits on the server: `start()` sends from a thread, `send()` sends now (what `close()` and the
  thread call). `pod_logs`: where the whole output is, e.g. `kubectl logs -n <namespace> job/<driver>`, said in the
  log when some is missing.
  """
  def __init__(self, put: Callable[[int, bytes], int], echo: Callable[[str], None], pod_logs: str = ''):
    self.put = put
    self.echo = echo
    self.pod_logs = pod_logs or "the pod's logs"
    # `add` and the sender share `pending`, `in_flight` and `dropped`. The rest is the sender's
    self.lock = threading.Condition()
    self.offset = 0
    self.pending = bytearray()
    # what we are sending, kept until the server has it: never dropped, so we know what it may have written
    self.in_flight = b''
    self.dropped = 0
    # we didn't hear the server's answer for `in_flight` (a timeout): it may have written it
    self.unconfirmed = False
    self.failed = False
    self.closing = False
    self.thread: Optional[threading.Thread] = None

  def add(self, data: bytes) -> None:
    with self.lock:
      if self.failed:
        return
      self.pending += data
      excess = len(self.in_flight) + len(self.pending) - MAX_PENDING
      if excess > 0:
        # the oldest of what isn't being sent
        self.dropped += excess
        del self.pending[:excess]

  def _next(self) -> bytes:
    """What to send now: what's being sent, or the next part of what's pending"""
    with self.lock:
      if not self.in_flight:
        if self.dropped:
          # what we dropped while the server was slow or couldn't be reached: say where it is, where it would have been
          self.pending[0:0] = (f"\n[qaboard] WARNING: output printed while QA-Board couldn't be reached is missing here ({self.dropped / 1024:.0f} KB). "
                               f"It is in the pod's logs: {self.pod_logs}\n").encode()
          self.dropped = 0
        self.in_flight = bytes(self.pending[:MAX_REQUEST])
        del self.pending[:len(self.in_flight)]
      return self.in_flight

  def send(self) -> bool:
    """
    Sends what is pending, in parts. Keeps it when the server can't be reached, drops it when it refuses it.
    False when it couldn't send everything.
    """
    from .results import ResultsError
    while not self.failed:
      data = self._next()
      if not data:
        return True
      try:
        offset = self.put(self.offset, data)
      except ResultsError as e:
        size = e.body.get('size') if isinstance(e.body, dict) else None
        if e.status == 409 and isinstance(size, int) and size != self.offset:
          if self.unconfirmed and size == self.offset + len(data):
            # it had written what we sent last, but we didn't get its answer: not twice
            with self.lock:
              self.in_flight = b''
          # else the server wrote in the log too (e.g. why a pod was pending): we go on after it
          self.offset, self.unconfirmed = size, False
          continue
        reason = e.body.get('reason') if isinstance(e.body, dict) else None
        # a proxy that doesn't check tokens won't start to
        if e.is_transient and reason != 'proxy_misconfigured':
          self.unconfirmed = True
        else:
          # e.g. the batch's token expired: nothing more will be accepted
          with self.lock:
            self.failed = True
            self.in_flight, self.pending = b'', bytearray()
          self.echo(f"[qaboard] WARNING: QA-Board doesn't take this log anymore ({e}): the rest is only in the pod's logs.")
        return False
      with self.lock:
        self.offset, self.in_flight, self.unconfirmed = offset, b'', False
    return False

  def start(self, interval: float = INTERVAL) -> None:
    """Sends what was added every `interval` seconds, from a thread, until `close()`"""
    def run():
      while True:
        with self.lock:
          self.lock.wait_for(lambda: self.closing, timeout=interval)
          if self.closing:
            break
        self.send()
      # what's left, until close() stops waiting
      while not self.send():
        with self.lock:
          if self.failed or self.lock.wait_for(lambda: self.thread is None, timeout=1):
            return
    self.thread = threading.Thread(target=run, name='send-batch-log', daemon=True)
    self.thread.start()

  def close(self, timeout: float = FLUSH_TIMEOUT) -> None:
    """Sends what's left, waiting at most `timeout` seconds (or now, without `start()`)"""
    thread = self.thread
    if thread is None:
      self.send()
      return
    with self.lock:
      self.closing = True
      self.lock.notify_all()
    thread.join(timeout)
    with self.lock:
      left = len(self.in_flight) + len(self.pending)
      # the thread stops trying (it is a daemon: it doesn't keep us either)
      self.thread = None
      self.lock.notify_all()
    if thread.is_alive() and left and not self.failed:
      self.echo(f"[qaboard] WARNING: QA-Board didn't take the end of this log in time ({left / 1024:.0f} KB): it is only in the pod's logs.")


def forward(source: BinaryIO, out: BinaryIO, sender: LogSender, interval: float = INTERVAL, flush_timeout: float = FLUSH_TIMEOUT) -> None:
  """
  Copies `source` to `out` as it comes, and sends it every `interval` seconds and at the end. Reading never waits on
  the server: else while it is slow, the pipe fills and the batch writing in it blocks.
  """
  fd = source.fileno()
  sender.start(interval)
  try:
    while chunk := os.read(fd, 65536):
      out.write(chunk)
      out.flush()
      sender.add(chunk)
  finally:
    sender.close(flush_timeout)


@click.command(name='send-batch-log', hidden=True)
@click.argument('command_id')
def send_batch_log(command_id: str):
  """Copies stdin to stdout, and appends it to the log of the batch QA-Board started (`command_id`), on the server."""
  from urllib.parse import quote
  from .api import qaboard_url
  from .results import _request

  def put(offset: int, data: bytes) -> int:
    answer = _request(qaboard_url, f"batch/submissions/{quote(command_id, safe='')}/log", params={'offset': offset}, method='PUT',
                      data=data, headers={'Content-Type': 'application/octet-stream'}, timeout=(5, 15))
    return int(answer.get('size', offset + len(data)))

  def echo(message: str) -> None:
    sys.stdout.buffer.write(f"{message}\n".encode())
    sys.stdout.buffer.flush()

  # set by the server (backend/runner_jobs.py)
  forward(sys.stdin.buffer, sys.stdout.buffer, LogSender(put, echo, pod_logs=os.environ.get(POD_LOGS_VARIABLE, '')))


def send_log_command(command_id: str) -> str:
  """The bash line that sends the rest of a script's output to the batch's log on the server (and the pod's logs)"""
  from shlex import quote
  return f"exec > >(qa send-batch-log {quote(command_id)}) 2>&1; QABOARD_LOG_PID=$!"
