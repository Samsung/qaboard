"""
Tests for qaboard/reporting.py: what a run tells the server besides its results, for `qa run` and start_run().
The server is the fake one of test_active_run.py, which answers like backend/api/outputs.py.
"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from qaboard import upload
from qaboard.reporting import RunReporter
from qaboard.results import ResultsError

from .test_active_run import FakeServer


class ReporterTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.run_dir = Path(self.tmp.name) / 'run'
    self.run_dir.mkdir()
    (self.run_dir / 'log.txt').write_text('working\n')
    (self.run_dir / 'model.pt').write_bytes(b'weights')
    patch = mock.patch.object(upload, 'RETRY_DELAYS', (0.0, 0.0))
    patch.start()
    self.addCleanup(patch.stop)
    self.server = FakeServer()
    self.addCleanup(self.server.close)

  def reporter(self, **options):
    reporter = RunReporter(self.server.url, self.run_dir, token='token', **options)
    self.addCleanup(reporter.close)
    return reporter


class TestLifecycle(ReporterTestCase):
  def test_a_run_that_sends_its_files(self):
    reporter = self.reporter(uploads=True, sync_interval=0.05, beat_while_running=True, heartbeat_interval=0.05)
    reporter.start(42)
    self.assertTrue(reporter.known)
    self.assertTrue(reporter.uploader._thread.is_alive())
    self.assertTrue(reporter._heartbeat._thread.is_alive())
    self.assertTrue(reporter.finish())
    self.assertEqual(self.server.files['model.pt'], b'weights')
    # finish() again, e.g. qa run's handler of Ctrl+C after postprocess: nothing more is sent
    sent = len(self.server.puts())
    self.assertTrue(reporter.finish())
    self.assertEqual(len(self.server.puts()), sent)
    reporter.ended(known=True)
    reporter.close()
    self.assertIsNone(reporter.uploader._thread)
    self.assertIsNone(reporter._heartbeat)

  def test_the_server_never_heard_of_the_run(self):
    reporter = self.reporter(uploads=True)
    created = []
    def create():
      created.append(True)
      return 42
    self.assertTrue(reporter.finish(create=create))
    self.assertEqual((created, reporter.id), ([True], 42))
    self.assertEqual(self.server.files['model.pt'], b'weights')
    # the files are sent once, at the end: no thread for what changes
    self.assertIsNotNone(reporter.uploader)
    self.assertIsNone(reporter.uploader._thread)

  def test_the_server_still_doesnt_know_it(self):
    reporter = self.reporter(uploads=True)
    self.assertFalse(reporter.finish(create=lambda: None))
    self.assertIsNone(reporter.uploader)
    self.assertIs(reporter.files_sent, False)
    self.assertEqual(self.server.requests, [])

  def test_runs_that_dont_send_their_files(self):
    reporter = self.reporter(uploads=False, beat_while_running=False)
    reporter.start(42)
    self.assertTrue(reporter.finish(create=lambda: self.fail('nothing to create the run for')))
    self.assertIsNone(reporter.uploader)
    self.assertEqual(self.server.puts(), [])

  def test_heartbeats_while_the_last_files_go(self):
    """start_run() reports its progress itself while it runs: the reporter beats only from finish()"""
    reporter = self.reporter(uploads=True, beat_while_running=False, heartbeat_interval=60)
    reporter.start(42)
    self.assertIsNone(reporter._heartbeat)
    started = threading.Event()
    def slow_finish():
      started.set()
      return True
    with mock.patch.object(reporter.uploader, 'finish', slow_finish):
      reporter.finish()
    self.assertTrue(started.is_set())
    self.assertIsNotNone(reporter._heartbeat)
    reporter.ended(known=True)
    self.assertIsNone(reporter._heartbeat)

  def test_the_end_of_the_log_when_the_server_refused_how_the_run_ended(self):
    reporter = self.reporter(uploads=True)
    reporter.start(42)
    reporter.finish()
    with (self.run_dir / 'log.txt').open('a') as f:
      f.write("WARNING: QA-Board refused the results\n")
    reporter.ended(known=False)
    self.assertEqual(self.server.files['log.txt'], b"working\nWARNING: QA-Board refused the results\n")

  def test_nothing_more_once_closed(self):
    with self.reporter(uploads=True, sync_interval=0.05) as reporter:
      reporter.start(42)
      thread = reporter.uploader._thread
    self.assertFalse(thread.is_alive())
    reporter.start(43)
    self.assertEqual(reporter.id, 42)
    reporter.close()  # again

  def test_start_from_another_thread_while_finishing(self):
    reporter = self.reporter(uploads=True, sync_interval=0.05)
    threads = [threading.Thread(target=reporter.start, args=(42,)) for _ in range(8)]
    for thread in threads:
      thread.start()
    for thread in threads:
      thread.join()
    uploader = reporter.uploader
    self.assertTrue(uploader._thread.is_alive())
    self.assertIs(reporter.uploader, uploader)
    self.assertTrue(reporter.finish())


class TestProgress(ReporterTestCase):
  def test_progress_and_heartbeats(self):
    reporter = self.reporter()
    reporter.start(42)
    reporter.progress({'metrics': {'loss': 0.5}})
    self.assertTrue(reporter.beat())
    self.assertEqual(self.server.progress(), [{'metrics': {'loss': 0.5}}, {}])
    self.assertLess(reporter.silent_for(), 5)

  def test_servers_without_heartbeats(self):
    reporter = self.reporter()
    reporter.start(42)
    with mock.patch('qaboard.heartbeat.beat', side_effect=ResultsError('not found', status=404)):
      self.assertFalse(reporter.beat())
    self.assertFalse(reporter.heartbeats)
    self.assertFalse(reporter.beat())  # not asked again
    # problems that may pass are the caller's to handle
    reporter.heartbeats = True
    with mock.patch('qaboard.heartbeat.beat', side_effect=ResultsError('away', status=503)):
      with self.assertRaises(ResultsError):
        reporter.beat()
    self.assertTrue(reporter.heartbeats)


if __name__ == '__main__':
  unittest.main()
