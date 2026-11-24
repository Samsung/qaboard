"""
Tests for qaboard/log_setup.py: qa's diagnostic logs, and the SDK that configures none.
"""
import io
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from qaboard import log_setup
from qaboard.log_setup import level_for, parse_level, scrub, setup


class TestLevels(unittest.TestCase):
  def test_warnings_by_default(self):
    self.assertEqual(level_for(0, {}), logging.WARNING)

  def test_flags(self):
    self.assertEqual(level_for(1, {}), logging.INFO)
    self.assertEqual(level_for(2, {}), logging.DEBUG)
    self.assertEqual(level_for(3, {}), logging.DEBUG)

  def test_environment(self):
    self.assertEqual(level_for(0, {'QA_LOG_LEVEL': 'debug'}), logging.DEBUG)
    self.assertEqual(level_for(0, {'QABOARD_LOG_LEVEL': 'INFO'}), logging.INFO)
    self.assertEqual(level_for(0, {'QA_LOG_LEVEL': '40'}), logging.ERROR)
    self.assertEqual(level_for(0, {'QA_LOG_LEVEL': 'error', 'QABOARD_LOG_LEVEL': 'debug'}), logging.ERROR)
    # older scripts
    self.assertEqual(level_for(0, {'QA_VERBOSE': ''}), logging.DEBUG)

  def test_flags_win(self):
    self.assertEqual(level_for(1, {'QA_LOG_LEVEL': 'error'}), logging.INFO)

  def test_unknown_levels_are_ignored(self):
    self.assertIsNone(parse_level('loud'))
    self.assertIsNone(parse_level(' '))
    self.assertEqual(level_for(0, {'QA_LOG_LEVEL': 'loud'}), logging.WARNING)


class TestScrub(unittest.TestCase):
  def test_tokens_are_filtered(self):
    for line in ("GET http://qa/api/v1/x?token=abc123&a=1", "Authorization: Bearer abc123", "using qab_pat_abc123 from $QABOARD_TOKEN"):
      self.assertNotIn('abc123', scrub(line), line)
    self.assertIn('a=1', scrub("GET http://qa/api/v1/x?token=abc123&a=1"))

  def test_realistic_secrets_are_filtered(self):
    lines = {
      # query parameters: presigned S3 URLs, OAuth
      "GET https://bucket.s3.amazonaws.com/k?X-Amz-Credential=AKIAX%2F20261124&X-Amz-Signature=SECRET1&X-Amz-Security-Token=SECRET2": ('SECRET1', 'SECRET2'),
      "GET https://api/x?access_token=SECRET1&api_key=SECRET2": ('SECRET1', 'SECRET2'),
      # headers, as libraries print them, and in dicts
      "send: b'GET / HTTP/1.1\\r\\nCookie: session=SECRET1\\r\\nPRIVATE-TOKEN: SECRET2\\r\\n'": ('SECRET1', 'SECRET2'),
      "Authorization: Token SECRET1": ('SECRET1',),
      "headers={'Authorization': 'Bearer SECRET1', 'Cookie': 'session=SECRET2', 'X-Api-Key': 'SECRET3'}": ('SECRET1', 'SECRET2', 'SECRET3'),
      '{"username": "alice", "password": "SECRET1", "client_secret": "SECRET2"}': ('SECRET1', 'SECRET2'),
      # credentials in URLs: CI's git remotes, databases
      "git fetch https://gitlab-ci-token:SECRET1@gitlab.example.com/group/project.git": ('SECRET1',),
      "postgresql://qaboard:SECRET1@db:5432/qaboard, redis://:SECRET2@cache:6379/0": ('SECRET1', 'SECRET2'),
      # well-known formats, wherever they are
      "CI_JOB_TOKEN=glcbt-64_SECRET1abcdef, GITHUB_TOKEN ghs_SECRET1abcdefghijklmnopqrstuv": ('SECRET1',),
      "id token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOngiLCJhdWQiOiJxYWJvYXJkIn0.SECRET1sig": ('SECRET1',),
    }
    for line, secrets in lines.items():
      for secret in secrets:
        self.assertNotIn(secret, scrub(line), line)
    self.assertIn('username": "alice"', scrub('{"username": "alice", "password": "SECRET1"}'))
    self.assertEqual(scrub("git fetch https://gitlab-ci-token:SECRET1@gitlab/x.git"), "git fetch https://gitlab-ci-token:[Filtered]@gitlab/x.git")

  def test_other_lines_are_kept(self):
    for line in ("POST http://qa/api/v1/output/ => 200 in 3ms", "GET http://qa:5151/api/v1/x?project=a/b => 200",
                 "run 12: sent 3 files (100 bytes) from /home/u/p/output", "{'metric': 'loss', 'value': 0.1}"):
      self.assertEqual(scrub(line), line)


class LoggerState(unittest.TestCase):
  """Saves and restores the loggers setup() changes"""
  def setUp(self):
    self.loggers = [logging.getLogger('qaboard'), logging.getLogger()]
    self.saved = [(logger, list(logger.handlers), logger.level, logger.propagate) for logger in self.loggers]
    self.stderr = io.StringIO()
    stderr = patch.object(sys, 'stderr', self.stderr)
    stderr.start()
    self.addCleanup(stderr.stop)

  def tearDown(self):
    for logger, handlers, level, propagate in self.saved:
      for handler in list(logger.handlers):
        if handler not in handlers:
          logger.removeHandler(handler)
          handler.close()
      logger.setLevel(level)
      logger.propagate = propagate


class TestSetup(LoggerState):
  def test_levels_and_plain_lines_off_a_terminal(self):
    setup(0, env={})
    logger = logging.getLogger('qaboard.config')
    logger.info("hidden")
    logger.warning("shown")
    self.assertNotIn('hidden', self.stderr.getvalue())
    self.assertIn('WARNING qaboard.config: shown', self.stderr.getvalue())

    setup(2, env={})
    logger.debug("details")
    self.assertIn('DEBUG qaboard.config: details', self.stderr.getvalue())

  def test_colors_in_ci(self):
    """CI's web views render colors: rich's handler, though stderr isn't a terminal"""
    setup(0, env={'GITLAB_CI': 'true'})
    logging.getLogger('qaboard.x').warning("colored")
    self.assertIn('\x1b[', self.stderr.getvalue())
    self.assertIn('colored', self.stderr.getvalue())

  def test_no_color_wins(self):
    setup(0, env={'CI': 'true', 'NO_COLOR': '1'})
    logging.getLogger('qaboard.x').warning("plain")
    self.assertNotIn('\x1b[', self.stderr.getvalue())
    self.assertIn('WARNING qaboard.x: plain', self.stderr.getvalue())

  def test_from_the_environment(self):
    self.assertEqual(setup(0, env={'QA_LOG_LEVEL': 'info'}), logging.INFO)
    logging.getLogger('qaboard.x').info("from env")
    self.assertIn('from env', self.stderr.getvalue())

  def test_called_again_replaces_its_handlers(self):
    setup(1, env={})
    setup(1, env={})
    ours = [h for h in logging.getLogger('qaboard').handlers if getattr(h, log_setup._OURS, False)]
    self.assertEqual(len(ours), 1)

  def test_leaves_the_root_logger_alone(self):
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    setup(2, env={})
    self.assertEqual(root.handlers, handlers)
    self.assertEqual(root.level, level)
    # what the code `qa run` runs configures doesn't show our logs twice
    self.assertFalse(logging.getLogger('qaboard').propagate)

  def test_other_libraries_with_vvv(self):
    setup(3, env={})
    logging.getLogger('urllib3.connectionpool').debug("a library's log")
    self.assertIn("a library's log", self.stderr.getvalue())

  def test_secrets_are_scrubbed(self):
    setup(2, env={})
    logging.getLogger('qaboard.x').debug("GET %s", "http://qa/api/v1/x?token=abc123")
    self.assertNotIn('abc123', self.stderr.getvalue())
    self.assertIn('token=[Filtered]', self.stderr.getvalue())

  def test_secrets_are_scrubbed_from_tracebacks(self):
    setup(2, env={})
    try:
      raise ConnectionError("Max retries exceeded with url: /api/v1/x?token=abc123 (https://ci:glpat-abcdef123456@git)")
    except ConnectionError:
      logging.getLogger('qaboard.x').debug("request failed", exc_info=True)
    logged = self.stderr.getvalue()
    self.assertIn('ConnectionError', logged)
    self.assertNotIn('abc123', logged)
    self.assertNotIn('glpat-abcdef123456', logged)

  def test_log_file_gets_debug_logs(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'qa.log'
      setup(0, env={'QA_LOG_FILE': str(path)})
      logging.getLogger('qaboard.x').debug("in the file")
      for handler in logging.getLogger('qaboard').handlers:
        handler.flush()
      self.assertIn('in the file', path.read_text())
      self.assertNotIn('in the file', self.stderr.getvalue())
      self.tearDown()  # closes the file before it's removed (Windows)

  def test_runs_started_by_qa_batch_log_like_it(self):
    with patch.dict(os.environ, {}, clear=False):
      os.environ.pop('QA_LOG_LEVEL', None)
      setup(1)
      self.assertEqual(os.environ['QA_LOG_LEVEL'], 'INFO')


class TestHttpLogs(LoggerState):
  def test_requests_are_logged_without_secrets(self):
    from qaboard.http_client import log_response
    setup(2, env={})
    response = SimpleNamespace(request=SimpleNamespace(method='GET', headers={'Authorization': 'Bearer abc123'}),
                               url='http://qa/api/v1/output/1?token=abc123', status_code=200, elapsed=timedelta(milliseconds=12))
    log_response(response)
    output = self.stderr.getvalue()
    self.assertIn('GET http://qa/api/v1/output/1?token=[Filtered] => 200 in 12ms', output)
    self.assertNotIn('abc123', output)

  def test_requests_and_retries_through_http_client(self):
    import requests
    from qaboard import http_client
    setup(2, env={})
    answers = [SimpleNamespace(status_code=503, headers={}, text='busy', json=lambda: {}, close=lambda: None),
               SimpleNamespace(status_code=200, headers={}, text='{}', json=lambda: {}, close=lambda: None)]

    def answer(method, url, **kwargs):
      self.assertEqual(kwargs['headers']['Authorization'], 'Bearer qab_pat_abc123')
      r = answers.pop(0)
      r.request, r.url, r.elapsed = SimpleNamespace(method=method), url, timedelta(milliseconds=5)
      return r
    session = requests.Session()
    with patch.object(http_client, '_session', return_value=session), patch.object(session, 'request', side_effect=answer), \
         patch.object(http_client.time, 'sleep'):
      http_client.request('http://qa', 'output/1', token='qab_pat_abc123', retries=(1,))
    output = self.stderr.getvalue()
    self.assertIn('GET http://qa/api/v1/output/1 => 503 in 5ms', output)
    self.assertIn('INFO qaboard.http_client: trying again in 1s (1/1)', output)
    self.assertIn('GET http://qa/api/v1/output/1 => 200 in 5ms', output)
    self.assertNotIn('abc123', output)


class TestTerminal(unittest.TestCase):
  def test_colors(self):
    from qaboard import terminal
    self.assertFalse(terminal.colors(io.StringIO(), {}))
    for name in ('CI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'TF_BUILD'):
      self.assertTrue(terminal.colors(io.StringIO(), {name: 'x'}), name)
    self.assertFalse(terminal.colors(io.StringIO(), {'CI': 'true', 'NO_COLOR': '1'}))
    # an empty NO_COLOR doesn't count (no-color.org)
    self.assertTrue(terminal.colors(io.StringIO(), {'CI': 'true', 'NO_COLOR': ''}))

  def test_width(self):
    from qaboard import terminal
    self.assertEqual(terminal.width(io.StringIO(), {'CI': 'true'}), terminal.CI_WIDTH)
    self.assertEqual(terminal.width(io.StringIO(), {'CI': 'true', 'COLUMNS': '200'}), 200)
    self.assertIsNone(terminal.width(io.StringIO(), {}))


class TestLibrary(unittest.TestCase):
  def test_the_sdk_configures_no_logging(self):
    """In users' code: no handler on the root logger, and qaboard's warnings don't reach stderr unless they configure logging"""
    code = (
      "import logging, qaboard, qaboard.http_client, qaboard.upload\n"
      "assert logging.getLogger().handlers == [], logging.getLogger().handlers\n"
      "assert logging.getLogger().level == logging.WARNING\n"
      "logging.getLogger('qaboard.upload').warning('should not show')\n"
      "logging.basicConfig(level=logging.DEBUG)\n"
      "logging.getLogger('qaboard.upload').debug('shown by their config')\n"
    )
    p = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, cwd=str(Path(__file__).parent.parent))
    self.assertEqual(p.returncode, 0, p.stderr)
    self.assertNotIn('should not show', p.stderr)
    self.assertIn('shown by their config', p.stderr)


if __name__ == '__main__':
  unittest.main()
