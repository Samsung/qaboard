"""
`qa send-batch-log`: the log of a `qa batch` QA-Board started in a Kubernetes pod, for a project without a storage
shared with the server. The pod can't write the log where the web app reads it (the batch's folder on the server), so
the driver's script pipes its output here (backend/runner_jobs.py): it goes on to the pod's logs, and is appended to
the batch's log.txt on the server every few seconds and at the end (PUT /api/v1/batch/submissions/<id>/log, with the
batch's token). A log the server refuses (e.g. the token was revoked) is only in the pod's logs: the server writes
how to read them at the top of log.txt, and we say so when output is missing.
"""
import os
import sys
import time
import select
from typing import BinaryIO, Callable

import click

# How often we send what was added
INTERVAL = 3
# What we keep while the server can't be reached: older output is only in the pod's logs
MAX_PENDING = 4 * 1024 * 1024
# Under what proxies accept by default (nginx: 1 MiB)
MAX_REQUEST = 512 * 1024
# How to read the pod's logs, e.g. `kubectl logs -n <namespace> job/<driver>`
POD_LOGS_VARIABLE = 'QABOARD_POD_LOGS'


class LogSender:
  """
  Sends what is added to a log, at the offset the server has: `put(offset, data)` returns the log's new size.
  `pod_logs`: where the whole output is, e.g. `kubectl logs -n <namespace> job/<driver>`, said in the log when some is
  missing.
  """
  def __init__(self, put: Callable[[int, bytes], int], echo: Callable[[str], None], pod_logs: str = ''):
    self.put = put
    self.echo = echo
    self.pod_logs = pod_logs or "the pod's logs"
    self.offset = 0
    self.pending = bytearray()
    self.dropped = 0
    self.failed = False

  def add(self, data: bytes) -> None:
    self.pending += data
    if len(self.pending) > MAX_PENDING:
      self.dropped += len(self.pending) - MAX_PENDING
      del self.pending[:len(self.pending) - MAX_PENDING]

  def send(self) -> None:
    """Sends what is pending, in parts. Keeps it when the server can't be reached, drops it when it refuses it."""
    from .results import ResultsError
    if self.dropped and not self.failed:
      # what we dropped while the server couldn't be reached: say where it is, where it would have been
      self.pending[:0] = (f"\n[qaboard] WARNING: output printed while QA-Board couldn't be reached is missing here ({self.dropped / 1024:.0f} KB). "
                          f"It is in the pod's logs: {self.pod_logs}\n").encode()
      self.dropped = 0
    while self.pending and not self.failed:
      data = bytes(self.pending[:MAX_REQUEST])
      try:
        self.offset = self.put(self.offset, data)
      except ResultsError as e:
        size = e.body.get('size') if isinstance(e.body, dict) else None
        if e.status == 409 and isinstance(size, int) and size != self.offset:
          # the server wrote in the log too (e.g. why a pod was pending): we go on after it
          self.offset = size
          continue
        if not e.is_transient:
          # e.g. the batch's token expired: nothing more will be accepted
          self.failed = True
          self.echo(f"[qaboard] WARNING: QA-Board doesn't take this log anymore ({e}): the rest is only in the pod's logs.")
        return
      del self.pending[:len(data)]


def forward(source: BinaryIO, out: BinaryIO, sender: LogSender, interval: float = INTERVAL) -> None:
  """Copies `source` to `out` as it comes, and sends it every `interval` seconds and at the end"""
  fd = source.fileno()
  last = time.monotonic()
  while True:
    ready, _, _ = select.select([fd], [], [], interval)
    chunk = os.read(fd, 65536) if ready else b''
    if ready and not chunk:
      break
    if chunk:
      out.write(chunk)
      out.flush()
      sender.add(chunk)
    if time.monotonic() - last >= interval:
      sender.send()
      last = time.monotonic()
  sender.send()


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
