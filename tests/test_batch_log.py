"""`qa send-batch-log`: the log of a batch QA-Board started in a pod that doesn't see the server's storage"""
import os
import io
import time
import threading
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

  def test_a_misconfigured_proxy_isnt_asked_again(self):
    server, echoed = FakeServer(), []
    sender = LogSender(server.put, echoed.append)
    # as http_client.error_for says it: final, though a 500
    server.fail_with = ResultsError("proxy", status=500, reason="proxy_misconfigured", body={"reason": "proxy_misconfigured"}, transient=False)
    sender.add(b"a\n")
    sender.send()
    sender.add(b"b\n")
    sender.send()
    self.assertEqual(server.log, b"")
    self.assertEqual(len(echoed), 1)

  def test_large_logs_are_sent_in_parts(self):
    from qaboard.batch_log import MAX_REQUEST
    server, sizes = FakeServer(), []
    sender = LogSender(lambda offset, data: (sizes.append(len(data)), server.put(offset, data))[1], print)
    sender.add(b"x" * (2 * MAX_REQUEST + 10))
    sender.send()
    self.assertEqual(sizes, [MAX_REQUEST, MAX_REQUEST, 10])
    self.assertEqual(len(server.log), 2 * MAX_REQUEST + 10)

  def test_says_where_dropped_output_is(self):
    from qaboard.batch_log import MAX_PENDING
    server = FakeServer()
    sender = LogSender(server.put, print, pod_logs="kubectl logs -n runs job/qa-0123abcd-driver")
    server.fail_with = ResultsError("timeout")
    sender.add(b"a\n")
    sender.send()
    # too much while the server can't be reached: the oldest is dropped
    sender.add(b"x" * MAX_PENDING)
    sender.send()
    self.assertIn(b"couldn't be reached is missing here (0 KB)", server.log)
    self.assertIn(b"kubectl logs -n runs job/qa-0123abcd-driver", server.log)
    # what was being sent is kept, then the note where output is missing
    self.assertTrue(server.log.startswith(b"a\n\n[qaboard] WARNING"))
    self.assertTrue(server.log.endswith(b"x" * (MAX_PENDING - 2)))
    # said once
    sender.add(b"b\n")
    sender.send()
    self.assertEqual(server.log.count(b"is missing here"), 1)

  def test_what_the_server_wrote_without_answering_isnt_sent_twice(self):
    server = FakeServer()
    def put(offset, data):
      size = server.put(offset, data)
      if data == b"a\n":
        raise ResultsError("timeout")  # written, but the answer was lost
      return size
    sender = LogSender(put, print)
    sender.add(b"a\n")
    sender.send()
    sender.add(b"b\n")
    sender.send()
    self.assertEqual(server.log, b"a\nb\n")

  def test_a_slow_server_doesnt_block_the_batch(self):
    from qaboard.batch_log import MAX_PENDING
    server, echoed = FakeServer(), []
    answer, requests = threading.Event(), []
    def put(offset, data):
      requests.append(len(data))
      answer.wait(10)  # the server is slow
      return server.put(offset, data)
    read, write = os.pipe()
    out = io.BytesIO()
    sender = LogSender(put, echoed.append)
    with os.fdopen(read, 'rb') as source:
      forwarding = threading.Thread(target=forward, args=(source, out, sender), kwargs={"interval": 0.01})
      forwarding.start()
      # far more than a pipe holds (64 KiB), and than we keep: writing doesn't wait on the server
      started = time.monotonic()
      for i in range(200):
        os.write(write, (f"{i:04}" + "x" * 65531 + "\n").encode())
      self.assertLess(time.monotonic() - started, 5)
      os.close(write)
      # one request while the server is slow; then what came meanwhile, coalesced
      answer.set()
      forwarding.join(10)
    self.assertFalse(forwarding.is_alive())
    self.assertEqual(out.getvalue().count(b"\n"), 200)
    self.assertLess(len(requests), 20)
    # the oldest of what came meanwhile is dropped, and said where
    self.assertIn(b"is missing here", server.log)
    self.assertTrue(server.log.endswith(b"0199" + b"x" * 65531 + b"\n"))
    # at most: the buffer, the note saying what's missing, and two reads that came after the server answered
    self.assertLess(len(server.log), MAX_PENDING + 65536 * 2 + 1024)
    self.assertEqual(echoed, [])

  def test_the_end_is_sent_at_eof(self):
    server = FakeServer()
    read, write = os.pipe()
    with os.fdopen(read, 'rb') as source:
      # never sent in between: all at the end
      forwarding = threading.Thread(target=forward, args=(source, io.BytesIO(), LogSender(server.put, print)), kwargs={"interval": 3600})
      forwarding.start()
      os.write(write, b"a\n")
      os.write(write, b"the end\n")
      os.close(write)
      forwarding.join(10)
    self.assertFalse(forwarding.is_alive())
    self.assertEqual(server.log, b"a\nthe end\n")

  def test_the_end_is_sent_again_until_the_server_takes_it(self):
    server = FakeServer()
    server.fail_with = ResultsError("timeout")
    sender = LogSender(server.put, print)
    sender.start(interval=3600)
    sender.add(b"the end\n")
    sender.close(timeout=10)
    self.assertEqual(server.log, b"the end\n")

  def test_says_so_when_sending_fails_unexpectedly(self):
    echoed = []
    def put(offset, data):
      raise KeyError('size')  # e.g. an answer we didn't expect
    sender = LogSender(put, echoed.append)
    sender.start(interval=3600)
    sender.add(b"the end\n")
    sender.close(timeout=5)
    self.assertEqual(len(echoed), 1)
    self.assertIn("could not send this log", echoed[0])

  def test_waits_a_bounded_time_at_eof(self):
    server, echoed, answer = FakeServer(), [], threading.Event()
    def put(offset, data):
      answer.wait(10)  # the server doesn't answer
      return server.put(offset, data)
    sender = LogSender(put, echoed.append)
    sender.start(interval=3600)
    sender.add(b"the end\n")
    started = time.monotonic()
    sender.close(timeout=0.2)
    self.assertLess(time.monotonic() - started, 2)
    answer.set()
    self.assertEqual(len(echoed), 1)
    self.assertIn("didn't take the end of this log in time", echoed[0])


if __name__ == '__main__':
  unittest.main()
