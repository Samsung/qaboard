"""`qa send-batch-log`: the log of a batch QA-Board started in a pod that doesn't see the server's storage"""
import os
import io
import unittest

from qaboard.batch_log import LogSender, forward
from qaboard.results import ResultsError


class FakeServer:
  """Appends at an offset, like PUT /api/v1/batch/submissions/<id>/log"""
  def __init__(self):
    self.log = b''
    self.fail_with = None

  def put(self, offset, data):
    if self.fail_with:
      error, self.fail_with = self.fail_with, None
      raise error
    if offset != len(self.log):
      raise ResultsError("offset", status=409, body={"reason": "offset_mismatch", "size": len(self.log)})
    self.log += data
    return len(self.log)


class TestBatchLog(unittest.TestCase):
  def test_forward(self):
    server, echoed = FakeServer(), []
    read, write = os.pipe()
    os.write(write, b"line 1\nline 2\n")
    os.close(write)
    out = io.BytesIO()
    with os.fdopen(read, 'rb') as source:
      forward(source, out, LogSender(server.put, echoed.append), interval=0.01)
    # the pod's logs, and the server's
    self.assertEqual(out.getvalue(), b"line 1\nline 2\n")
    self.assertEqual(server.log, b"line 1\nline 2\n")

  def test_the_server_wrote_in_the_log_too(self):
    server = FakeServer()
    sender = LogSender(server.put, print)
    sender.add(b"a\n")
    sender.send()
    server.log += b"ERROR from the server\n"
    sender.add(b"b\n")
    sender.send()
    self.assertEqual(server.log, b"a\nERROR from the server\nb\n")

  def test_the_server_cant_be_reached(self):
    server = FakeServer()
    sender = LogSender(server.put, print)
    server.fail_with = ResultsError("timeout")
    sender.add(b"a\n")
    sender.send()
    self.assertEqual(server.log, b"")
    # sent the next time
    sender.send()
    self.assertEqual(server.log, b"a\n")

  def test_the_server_refuses_it(self):
    server, echoed = FakeServer(), []
    sender = LogSender(server.put, echoed.append)
    # e.g. the batch's token expired: said once, then only in the pod's logs
    server.fail_with = ResultsError("expired", status=401)
    for line in (b"a\n", b"b\n"):
      sender.add(line)
      sender.send()
    self.assertEqual(server.log, b"")
    self.assertEqual(len(echoed), 1)
    self.assertIn("only in the pod's logs", echoed[0])

  def test_large_logs_are_sent_in_parts(self):
    from qaboard.batch_log import MAX_REQUEST
    server, sizes = FakeServer(), []
    sender = LogSender(lambda offset, data: (sizes.append(len(data)), server.put(offset, data))[1], print)
    sender.add(b"x" * (2 * MAX_REQUEST + 10))
    sender.send()
    self.assertEqual(sizes, [MAX_REQUEST, MAX_REQUEST, 10])
    self.assertEqual(len(server.log), 2 * MAX_REQUEST + 10)

if __name__ == '__main__':
  unittest.main()
