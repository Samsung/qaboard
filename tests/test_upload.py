"""
Tests for qaboard/upload.py: what runs without a storage shared with the server send it, and when.
The server is the fake one of test_active_run.py, which answers like backend/api/outputs.py.
"""
import io
import os
import tempfile
from contextlib import redirect_stderr
import time
import unittest
from pathlib import Path
from unittest import mock

from qaboard import upload
from qaboard.upload import Uploader

from .test_active_run import FakeServer


class UploaderTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.run_dir = Path(self.tmp.name) / 'run'
    self.run_dir.mkdir()
    # no waiting between tries
    for name, delays in (('RETRY_DELAYS', (0.0, 0.0)), ('FINAL_RETRY_DELAYS', (0.0, 0.0, 0.0))):
      patch = mock.patch.object(upload, name, delays)
      patch.start()
      self.addCleanup(patch.stop)

  def server(self, **options):
    server = FakeServer(**options)
    self.addCleanup(server.close)
    return server

  def write(self, path, content, mode='wb'):
    file = self.run_dir / path
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file, mode) as f:
      f.write(content)
    return file

  def uploader(self, server, **options):
    return Uploader(server.url, 42, self.run_dir, token='token', **options)


class TestWhileTheRunGoesOn(UploaderTestCase):
  def test_sends_the_log_as_it_grows(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('log.txt', b'epoch 1\n')
    self.assertTrue(uploader.sync())
    self.write('log.txt', b'epoch 2\n', mode='ab')
    self.assertTrue(uploader.sync())
    self.assertTrue(uploader.sync())  # nothing new: nothing sent
    self.assertEqual(server.puts(), [('log.txt', '0', b'epoch 1\n'), ('log.txt', '8', b'epoch 2\n')])
    self.assertEqual(server.files['log.txt'], b'epoch 1\nepoch 2\n')
    self.assertEqual(server.requests[0][3]['Authorization'], 'Bearer token')

  def test_sends_the_small_files_the_run_rewrites_and_nothing_else(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('series.json', b'{"v": 1}')
    self.write('model.onnx', b'weights')
    self.write('plots/loss.png', b'png')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files, {'series.json': b'{"v": 1}'})
    self.assertTrue(uploader.sync())
    self.assertEqual(len(server.puts()), 1)
    file = self.write('series.json', b'{"v": 2}')
    os.utime(file, ns=(1, 1))  # also when the size and the second are the same: the date to the nanosecond
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files, {'series.json': b'{"v": 2}'})

  def test_live_patterns_send_more(self):
    server = self.server()
    uploader = self.uploader(server, live=['plots/*.png', '*.html'])
    self.write('plots/loss.png', b'png')
    self.write('plots/loss.csv', b'csv')
    self.write('report.html', b'<p>')
    self.write('.report.html.123.tmp', b'<')
    self.assertTrue(uploader.sync())
    self.assertEqual(sorted(server.files), ['plots/loss.png', 'report.html'])

  def test_a_log_that_starts_again_is_sent_whole(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('log.txt', b'a long first attempt\n')
    uploader.sync()
    self.write('log.txt', b'again\n')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files['log.txt'], b'again\n')
    self.assertEqual(server.puts()[-1], ('log.txt', None, b'again\n'))

  def test_a_log_the_server_has_differently_is_sent_whole(self):
    server = self.server()
    server.files['log.txt'] = b'what another process sent'
    uploader = self.uploader(server)
    self.write('log.txt', b'ours\n')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files['log.txt'], b'ours\n')
    self.write('log.txt', b'more\n', mode='ab')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files['log.txt'], b'ours\nmore\n')

  def test_a_log_rewritten_longer_is_sent_whole(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('log.txt', b'first attempt: 0123456789\n')
    uploader.sync()
    self.write('log.txt', b'a second attempt, with a longer log than before: all new\n')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files['log.txt'], b'a second attempt, with a longer log than before: all new\n')
    self.write('log.txt', b'and more\n', mode='ab')
    self.assertTrue(uploader.sync())
    self.assertEqual(server.files['log.txt'], b'a second attempt, with a longer log than before: all new\nand more\n')

  def test_one_live_pattern_as_text(self):
    server = self.server()
    self.write('plots/loss.png', b'png')
    self.assertTrue(Uploader(server.url, 42, self.run_dir, token='token', live='plots/*').sync())
    self.assertEqual(list(server.files), ['plots/loss.png'])

  def test_large_logs_are_sent_in_pieces(self):
    server = self.server()
    uploader = self.uploader(server)
    with mock.patch.object(upload, 'APPEND_CHUNK', 4):
      self.write('log.txt', b'0123456789')
      self.assertTrue(uploader.sync())
    self.assertEqual([content for _, _, content in server.puts()], [b'0123', b'4567', b'89'])
    self.assertEqual(server.files['log.txt'], b'0123456789')

  def test_the_thread_sends_until_the_run_finishes(self):
    server = self.server()
    uploader = self.uploader(server).start(interval=0.02)
    self.write('log.txt', b'started\n')
    self.write('result.bin', b'result')
    for _ in range(200):
      if 'log.txt' in server.files:
        break
      time.sleep(0.02)
    self.assertEqual(server.files, {'log.txt': b'started\n'})
    self.assertTrue(uploader.finish())
    self.assertEqual(server.files, {'log.txt': b'started\n', 'result.bin': b'result'})


class TestWhenTheRunEnds(UploaderTestCase):
  def test_sends_everything_once(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('log.txt', b'log\n')
    self.write('series.json', b'{}')
    uploader.sync()
    self.write('metrics.json', b'{"loss": 1}')
    self.write('checkpoints/last.pt', b'weights')
    self.write('a b/é.txt', b'accents')
    self.write('empty.txt', b'')
    self.write('.model.pt.123.tmp', b'half-written')
    (self.run_dir / 'empty-folder').mkdir()
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {
      'log.txt': b'log\n', 'series.json': b'{}', 'metrics.json': b'{"loss": 1}', 'checkpoints/last.pt': b'weights',
      'a b/é.txt': b'accents', 'empty.txt': b'',
    })
    self.assertEqual(len(server.puts('series.json')), 1)
    self.assertEqual((uploader.sent_files, uploader.failed, uploader.refused), (5, {}, None))
    self.assertEqual(uploader.problems(), [])

  def test_tries_again_when_the_server_has_a_problem(self):
    server = self.server(file_errors={'result.bin': [(503, {'error': 'busy'}), (502, {})]})
    self.write('result.bin', b'result')
    uploader = self.uploader(server)
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {'result.bin': b'result'})
    self.assertEqual(len(server.puts('result.bin')), 3)

  def test_the_last_sync_tries_longer(self):
    # what isn't sent at the end is lost: FINAL_RETRY_DELAYS, while the run goes on RETRY_DELAYS
    busy = [(503, {'error': 'busy'})] * 3
    server = self.server(file_errors={'series.json': list(busy), 'result.bin': list(busy)})
    self.write('series.json', b'{}')
    self.write('result.bin', b'result')
    uploader = self.uploader(server)
    self.assertFalse(uploader.sync())
    self.assertEqual(len(server.puts('series.json')), 3)
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {'series.json': b'{}', 'result.bin': b'result'})
    self.assertEqual(len(server.puts('result.bin')), 4)

  def test_links_out_of_the_folder_are_not_sent(self):
    secret = Path(self.tmp.name) / 'id_rsa'
    secret.write_bytes(b'secret')
    self.write('result.bin', b'result')
    (self.run_dir / 'key').symlink_to(secret)
    (self.run_dir / 'log.txt').symlink_to(secret)
    (self.run_dir / 'same.bin').symlink_to(self.run_dir / 'result.bin')
    server = self.server()
    uploader = self.uploader(server)
    with redirect_stderr(io.StringIO()) as stderr:
      self.assertTrue(uploader.sync(final=True))
      self.assertTrue(uploader.sync(final=True))
    # links inside the folder: their content
    self.assertEqual(server.files, {'result.bin': b'result', 'same.bin': b'result'})
    self.assertEqual(stderr.getvalue().count('WARNING'), 1, stderr.getvalue())
    self.assertIn('key, log.txt', stderr.getvalue())

  def test_a_file_that_changed_while_it_was_sent_is_sent_again(self):
    server = self.server(file_errors={'result.bin': [(422, {'error': 'digest', 'reason': 'digest_mismatch'})]})
    self.write('result.bin', b'result')
    uploader = self.uploader(server)
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {'result.bin': b'result'})

  def test_says_which_files_the_server_didnt_take(self):
    too_large = (413, {'error': 'model.pt is larger than what this server accepts (1 MB).', 'reason': 'too_large'})
    server = self.server(file_errors={'model.pt': [too_large]})
    self.write('model.pt', b'weights')
    self.write('metrics.json', b'{}')
    uploader = self.uploader(server)
    self.assertFalse(uploader.sync(final=True))
    self.assertEqual(server.files, {'metrics.json': b'{}'})
    self.assertIsNone(uploader.refused)
    self.assertEqual(len(uploader.problems()), 1)
    self.assertIn('model.pt', uploader.problems()[0])
    self.assertIn('larger than what this server accepts', uploader.problems()[0])
    # not sent again as it is, but still missing
    self.assertEqual(len(server.puts('model.pt')), 1)
    self.assertFalse(uploader.sync(final=True))
    self.assertEqual(len(server.puts('model.pt')), 1)
    # sent again once it changed
    self.write('model.pt', b'smaller')
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files['model.pt'], b'smaller')
    self.assertEqual(uploader.problems(), [])

  def test_sends_what_was_printed_after_the_end(self):
    # e.g. which files weren't sent: the server takes the log until it heard the run ended
    too_large = (413, {'error': 'model.pt is too large', 'reason': 'too_large'})
    server = self.server(file_errors={'model.pt': [too_large]})
    self.write('log.txt', b'run\n')
    self.write('model.pt', b'weights')
    uploader = self.uploader(server)
    self.assertFalse(uploader.finish())
    self.write('log.txt', b'ERROR: model.pt is too large\n', mode='ab')
    self.assertTrue(uploader.send_log())
    self.assertEqual(server.files['log.txt'], b'run\nERROR: model.pt is too large\n')
    self.assertEqual(len(server.puts('model.pt')), 1)

  def test_stops_when_the_server_refuses_the_runs_files(self):
    for status, body in [
      (401, {'error': 'Sign in to do this', 'reason': 'login_required'}),
      (403, {'error': 'You need the developer role', 'reason': 'missing_role'}),
      (400, {'error': "This server doesn't accept uploaded files.", 'reason': 'uploads_disabled'}),
      (409, {'error': 'The run has ended', 'reason': 'not_running'}),
    ]:
      with self.subTest(status=status):
        server = self.server(file_errors={'log.txt': [(status, body)] * 5})
        self.write('log.txt', b'log\n')
        self.write('result.bin', b'result')
        uploader = self.uploader(server)
        self.assertFalse(uploader.sync(final=True))
        self.assertIn(body['error'], uploader.refused)
        self.assertEqual(len(uploader.problems()), 1)
        requests = len(server.requests)
        self.assertFalse(uploader.sync(final=True))
        self.assertEqual(len(server.requests), requests)

  def test_a_server_that_is_away_never_raises(self):
    server = self.server()
    server.close()
    self.write('log.txt', b'log\n')
    self.write('result.bin', b'result')
    uploader = self.uploader(server)
    self.assertFalse(uploader.sync())
    self.assertFalse(uploader.sync(final=True))
    self.assertIsNone(uploader.refused)
    self.assertTrue(uploader.problems())

  def test_files_that_cant_be_read_are_missing(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('result.bin', b'result')
    self.write('log.txt', b'log\n')
    real_open = open
    def no_access(file, *args, **kwargs):
      if str(file).endswith(('result.bin', 'log.txt')):
        raise PermissionError(13, 'Permission denied', str(file))
      return real_open(file, *args, **kwargs)
    with mock.patch('builtins.open', no_access):
      self.assertFalse(uploader.sync(final=True))
    self.assertEqual(sorted(line.split(':')[0] for line in uploader.problems()), ['log.txt', 'result.bin'])
    self.assertIn('Permission denied', uploader.problems()[0])
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(sorted(server.files), ['log.txt', 'result.bin'])

  def test_files_removed_meanwhile_are_not_a_problem(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('result.bin', b'result')
    files = list(uploader._files(final=True))
    (self.run_dir / 'result.bin').unlink()
    self.assertTrue(uploader._put(*files[0]))
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {})



class TestQaUploadFolders(unittest.TestCase):
  def test_links_out_of_the_folder_are_left_out(self):
    from qaboard.upload_command import files_in
    with tempfile.TemporaryDirectory() as tmp:
      folder, secret = Path(tmp) / 'reports', Path(tmp) / 'id_rsa'
      folder.mkdir()
      secret.write_bytes(b'secret')
      (folder / 'junit.xml').write_text('<testsuites/>')
      (folder / 'key').symlink_to(secret)
      (folder / 'same.xml').symlink_to(folder / 'junit.xml')
      with redirect_stderr(io.StringIO()) as stderr:
        files = files_in(folder, Path(os.devnull))
      self.assertEqual([f.name for f in files], ['junit.xml', 'same.xml'])
      self.assertIn('key', stderr.getvalue())


class TestHeartbeat(unittest.TestCase):
  def test_beats_through_problems_until_the_run_ends(self):
    from qaboard import heartbeat
    from qaboard.results import ResultsError
    answers = [ResultsError('away'), ResultsError('busy', status=503), None, ResultsError('The run has ended', status=409, reason='not_running')]
    calls = []
    def beat(server, run_id, token=None, body=None):
      calls.append(run_id)
      answer = answers.pop(0)
      if answer is not None:
        raise answer
    with mock.patch.object(heartbeat, 'beat', beat):
      beating = heartbeat.Heartbeat('http://qaboard', 42, interval=0.01).start()
      beating._thread.join(timeout=5)
    self.assertEqual(calls, [42] * 4)
    self.assertFalse(beating._thread.is_alive())

  def test_stops_when_told(self):
    from qaboard import heartbeat
    with mock.patch.object(heartbeat, 'beat') as beat:
      beating = heartbeat.Heartbeat('http://qaboard', 42, interval=60).start()
      beating.stop()
      beating._thread.join(timeout=5)
    self.assertFalse(beating._thread.is_alive())
    beat.assert_not_called()

if __name__ == '__main__':
  unittest.main()


class TestQaRun(UploaderTestCase):
  """What `qa run` prints after it sent the run's files reaches the log the web app shows"""
  def test_the_end_of_the_log_is_sent(self):
    import sys
    from types import SimpleNamespace
    import qaboard.qa  # noqa: F401 (the module, not the `qa` command the package exports)
    qa = sys.modules['qaboard.qa']
    too_large = (413, {'error': 'model.pt is too large', 'reason': 'too_large'})
    server = self.server(file_errors={'model.pt': [too_large]})
    self.write('log.txt', b'run\n')
    self.write('model.pt', b'weights')
    log = self.run_dir / 'log.txt'
    def printed(message, **kwargs):
      # qa run copies what it prints to its log (fd_tee.py)
      with log.open('a') as f:
        f.write(f"{message}\n")
    def refused(**kwargs):
      printed("WARNING: QA-Board refused the results: metrics are numbers")
    run_context = SimpleNamespace(obj={}, id=42, output_dir=self.run_dir)
    with mock.patch.object(qa, 'sends_files', return_value=True), mock.patch.object(qa, '_reporter', None), \
         mock.patch.object(qa, 'config', {}), mock.patch.object(qa.ui, 'error', printed), \
         mock.patch.object(qa, 'notify_qa_database', refused), mock.patch('qaboard.api.qaboard_url', server.url):
      qa.run_reporter(run_context).start(run_context.id)
      qa.finish_upload(run_context)
      self.assertTrue(qa.files_not_sent())
      self.assertIn(b"model.pt: model.pt is too large", server.files['log.txt'])
      # the server didn't take how the run ended: it still takes its log, with why
      self.assertIsNone(qa.notify_run_ended(run_context, metrics={}))
      self.assertTrue(server.files['log.txt'].endswith(b"refused the results: metrics are numbers\n"))
