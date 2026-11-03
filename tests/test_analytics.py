"""
Tests for the CLI's usage event (qaboard/analytics.py): when it's sent, what it says, and that it never gets in the way.
"""
import os
import time
import unittest
from unittest import mock

os.environ['QA_TESTING'] = 'true'


class TestEnabled(unittest.TestCase):
  def setUp(self):
    from qaboard import analytics
    self.analytics = analytics
    analytics._state.clear()
    self.environ = mock.patch.dict(os.environ, {}, clear=False)
    self.environ.start()
    os.environ.pop('QA_NO_ANALYTICS', None)

  def tearDown(self):
    self.environ.stop()
    self.analytics._state.clear()

  def test_enabled_with_a_server_and_a_person(self):
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.assertTrue(self.analytics.enabled())

  def test_not_in_ci(self):
    with mock.patch('qaboard.config.is_ci', True), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.assertFalse(self.analytics.enabled())

  def test_not_with_the_opt_out(self):
    os.environ['QA_NO_ANALYTICS'] = ''
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.assertFalse(self.analytics.enabled())

  def test_not_offline(self):
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.assertFalse(self.analytics.enabled(offline=True))
      self.analytics.start('run', offline=True)
      self.assertFalse(self.analytics.enabled())

  def test_not_from_the_commands_qa_batch_starts(self):
    os.environ['QA_BATCH_ROOT_COMMAND_ID'] = 'abc'
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.assertFalse(self.analytics.enabled())
      self.analytics.start('run')
      self.assertFalse(self.analytics.enabled())

  def test_a_batch_someone_typed_is_tracked(self):
    # `qa batch` marks its own environment for the runs it starts: what counts is the environment it started in
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', '$QABOARD_URL'):
      self.analytics.start('batch')
      os.environ['QA_BATCH'] = 'true'
      self.assertTrue(self.analytics.enabled())

  def test_not_without_a_server(self):
    with mock.patch('qaboard.config.is_ci', False), mock.patch('qaboard.api.qaboard_url_source', None):
      self.assertFalse(self.analytics.enabled())


class TestEvent(unittest.TestCase):
  def setUp(self):
    from qaboard import analytics
    self.analytics = analytics
    analytics._state.clear()

  def tearDown(self):
    self.analytics._state.clear()

  def test_properties(self):
    analytics = self.analytics
    analytics.start('batch', share=True, tuning=True, dryrun=False, offline=False)
    analytics.note(runner='lsf', n_batches=2, nothing=None)
    with mock.patch('qaboard.api.project_name', return_value='repo/sub'):
      e = analytics.event(analytics._state['command'], analytics._state['started_at'], 0, analytics._state['properties'])
    self.assertEqual(e['event'], 'cli_command')
    self.assertEqual(e['project_id'], 'repo/sub')
    self.assertTrue(e['timestamp'].endswith('Z'))
    p = e['properties']
    self.assertEqual(p['command'], 'batch')
    self.assertEqual(p['runner'], 'lsf')
    self.assertEqual(p['n_batches'], 2)
    self.assertNotIn('nothing', p)
    self.assertTrue(p['share'])
    self.assertTrue(p['tuning'])
    self.assertFalse(p['dryrun'])
    self.assertEqual(p['exit_code'], 0)
    self.assertIsInstance(p['duration_s'], float)
    self.assertRegex(p['python'], r'^\d+\.\d+$')
    self.assertIn(p['os'], ('linux', 'windows', 'darwin'))
    self.assertIn('version', p)

  def test_exit_codes(self):
    analytics = self.analytics
    with mock.patch('qaboard.api.project_name', return_value=None):
      self.assertEqual(analytics.event('run', None, None)['properties']['exit_code'], 0)
      self.assertEqual(analytics.event('run', None, 2)['properties']['exit_code'], 2)
      self.assertEqual(analytics.event('run', None, 'oops')['properties']['exit_code'], 1)
      self.assertIsNone(analytics.event('run', None, 0)['properties']['duration_s'])
      self.assertIsNone(analytics.event('run', None, 0)['project_id'])

  def test_auth_subcommands(self):
    command_name = self.analytics.command_name
    self.assertEqual(command_name('run'), 'run')
    self.assertEqual(command_name('auth', ['auth', 'login', '--no-browser']), 'auth_login')
    self.assertEqual(command_name('auth', ['--offline', 'auth', '--server', 'x', 'status']), 'auth_status')
    self.assertEqual(command_name('auth', ['auth', 'whatever']), 'auth')
    self.assertEqual(command_name('auth', ['auth']), 'auth')
    self.assertIsNone(command_name(None))

  def test_payload(self):
    with mock.patch('qaboard.config.user', 'alice'):
      payload = self.analytics.payload({"event": "cli_command"})
    self.assertEqual(payload['source'], 'cli')
    self.assertEqual(payload['user_name'], 'alice')
    self.assertEqual(payload['events'][0]['event'], 'cli_command')


class TestSend(unittest.TestCase):
  def test_swallows_errors(self):
    from qaboard import analytics
    def boom(*args, **kwargs):
      raise ConnectionError("no server")
    with mock.patch('requests.post', side_effect=boom) as post:
      analytics.send({"source": "cli", "events": []})  # must not raise
    self.assertEqual(post.call_count, 1)
    args, kwargs = post.call_args
    self.assertTrue((kwargs.get('url') or args[0]).endswith('/events'))
    self.assertEqual(kwargs['timeout'], analytics.TIMEOUT)


class TestFinish(unittest.TestCase):
  def setUp(self):
    from qaboard import analytics
    self.analytics = analytics
    analytics._state.clear()
    self.sender = analytics._sender

  def tearDown(self):
    self.analytics._sender = self.sender
    self.analytics._state.clear()

  def test_sends_once_without_blocking(self):
    analytics = self.analytics
    sent = []
    def slow_sender(payload):
      sent.append(payload)
      time.sleep(5)
    analytics._sender = slow_sender
    analytics.start('run')
    with mock.patch('qaboard.analytics.enabled', return_value=True), mock.patch('qaboard.api.project_name', return_value='p'):
      started = time.monotonic()
      analytics.finish(3)
      analytics.finish(3)
    self.assertLess(time.monotonic() - started, analytics.JOIN_TIMEOUT + 1)
    self.assertEqual(len(sent), 1)
    self.assertEqual(sent[0]['events'][0]['properties']['exit_code'], 3)
    self.assertEqual(sent[0]['events'][0]['properties']['command'], 'run')

  def test_nothing_without_start_or_when_disabled(self):
    analytics = self.analytics
    sent = []
    analytics._sender = sent.append
    analytics.finish(0)
    analytics.start('run')
    with mock.patch('qaboard.analytics.enabled', return_value=False):
      analytics.finish(0)
    self.assertEqual(sent, [])

  def test_never_raises(self):
    analytics = self.analytics
    def broken(payload):
      raise RuntimeError("broken sender")
    analytics._sender = broken
    analytics.start('run')
    with mock.patch('qaboard.analytics.enabled', side_effect=RuntimeError("broken enabled")):
      analytics.finish(0)  # must not raise


if __name__ == '__main__':
  unittest.main()
