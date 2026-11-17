"""
Tests for qaboard/upload.py: what runs without a storage shared with the server send it, and when.
The server is the fake one of test_active_run.py, which answers like backend/api/outputs.py.
"""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from qaboard import upload
from qaboard.upload import Uploader, problems

from .test_active_run import FakeServer


class UploaderTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.run_dir = Path(self.tmp.name) / 'run'
    self.run_dir.mkdir()
    # no waiting between tries
    patch = mock.patch.object(upload, 'RETRY_DELAYS', (0.0, 0.0))
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
    self.write('a b/é.txt', 'accents'.encode())
    self.write('empty.txt', b'')
    self.write('.model.pt.123.tmp', b'half-written')
    (self.run_dir / 'empty-folder').mkdir()
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {
      'log.txt': b'log\n', 'series.json': b'{}', 'metrics.json': b'{"loss": 1}', 'checkpoints/last.pt': b'weights',
      'a b/é.txt': 'accents'.encode(), 'empty.txt': b'',
    })
    self.assertEqual(len(server.puts('series.json')), 1)
    self.assertEqual((uploader.sent_files, uploader.failed, uploader.refused), (5, {}, None))
    self.assertEqual(problems(uploader), [])

  def test_tries_again_when_the_server_has_a_problem(self):
    server = self.server(file_errors={'result.bin': [(503, {'error': 'busy'}), (502, {})]})
    self.write('result.bin', b'result')
    uploader = self.uploader(server)
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {'result.bin': b'result'})
    self.assertEqual(len(server.puts('result.bin')), 3)

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
    self.assertEqual(len(problems(uploader)), 1)
    self.assertIn('model.pt', problems(uploader)[0])
    self.assertIn('larger than what this server accepts', problems(uploader)[0])
    # not sent again as it is, but still missing
    self.assertEqual(len(server.puts('model.pt')), 1)
    self.assertFalse(uploader.sync(final=True))
    self.assertEqual(len(server.puts('model.pt')), 1)
    # sent again once it changed
    self.write('model.pt', b'smaller')
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files['model.pt'], b'smaller')
    self.assertEqual(problems(uploader), [])

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
        self.assertEqual(len(problems(uploader)), 1)
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
    self.assertTrue(problems(uploader))

  def test_files_removed_meanwhile_are_not_a_problem(self):
    server = self.server()
    uploader = self.uploader(server)
    self.write('result.bin', b'result')
    files = list(uploader._files(final=True))
    (self.run_dir / 'result.bin').unlink()
    self.assertTrue(uploader._put(*files[0]))
    self.assertTrue(uploader.sync(final=True))
    self.assertEqual(server.files, {})


if __name__ == '__main__':
  unittest.main()
