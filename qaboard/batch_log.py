"""
`qa send-batch-log`: the log of a `qa batch` QA-Board started in a Kubernetes pod, for a project without a storage
shared with the server. The pod can't write the log where the web app reads it (the batch's folder on the server), so
the driver's script pipes its output here (backend/runner_jobs.py): it goes on to the pod's logs, and is appended to
the batch's log.txt on the server every few seconds and at the end (PUT /api/v1/batch/submissions/<id>/log, with the
batch's token). A log the server refuses (e.g. the token was revoked) is only in the pod's logs.
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


class LogSender:
  """Sends what is added to a log, at the offset the server has: `put(offset, data)` returns the log's new size"""
  def __init__(self, put: Callable[[int, bytes], int], echo: Callable[[str], None]):
    self.put = put
    self.echo = echo
    self.offset = 0
    self.pending = bytearray()
    self.failed = False

  def add(self, data: bytes) -> None:
    self.pending += data
    if len(self.pending) > MAX_PENDING:
      del self.pending[:len(self.pending) - MAX_PENDING]

  def send(self) -> None:
    if not self.pending or self.failed:
      return
    from .results import ResultsError
    data = bytes(self.pending)
    try:
      self.offset = self.put(self.offset, data)
    except ResultsError as e:
      size = e.body.get('size') if isinstance(e.body, dict) else None
      if e.status == 409 and isinstance(size, int):
        # the server wrote in the log too (e.g. why a pod was pending): we go on after it
        self.offset = size
        return self.send()
      if not e.is_transient:
        # e.g. the batch's token was revoked: nothing more will be accepted
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
                      data=data, headers={'Content-Type': 'application/octet-stream'}, timeout=(10, 30))
    return int(answer.get('size', offset + len(data)))

  def echo(message: str) -> None:
    sys.stdout.buffer.write(f"{message}\n".encode())
    sys.stdout.buffer.flush()

  forward(sys.stdin.buffer, sys.stdout.buffer, LogSender(put, echo))


def send_log_command(command_id: str) -> str:
  """The bash line that sends the rest of a script's output to the batch's log on the server (and the pod's logs)"""
  from shlex import quote
  return f"exec > >(qa send-batch-log {quote(command_id)}) 2>&1; QABOARD_LOG_PID=$!"
