"""The backend's logs (backend/logs.py): levels, formats, and one line per request without secrets."""
import io
import json
import logging
from types import SimpleNamespace

import pytest
from flask import Flask, g

from backend import logs


@pytest.fixture
def restore_logging():
  root, backend = logging.getLogger(), logging.getLogger('backend')
  saved = list(root.handlers), root.level, backend.level
  yield
  root.handlers[:] = saved[0]
  root.setLevel(saved[1])
  backend.setLevel(saved[2])


def test_levels():
  assert logs.level_from({}) == logging.INFO
  assert logs.level_from({'QABOARD_LOG_LEVEL': 'debug'}) == logging.DEBUG
  assert logs.level_from({'QABOARD_LOG_LEVEL': '30'}) == logging.WARNING
  assert logs.level_from({'QABOARD_LOG_LEVEL': 'loud'}) == logging.INFO


def test_configure(restore_logging):
  logs.configure({'QABOARD_LOG_LEVEL': 'warning'})
  logs.configure({'QABOARD_LOG_LEVEL': 'warning'})
  ours = [h for h in logging.getLogger().handlers if getattr(h, logs._OURS, False)]
  assert len(ours) == 1
  assert logging.getLogger('backend').getEffectiveLevel() == logging.WARNING
  # other libraries: warnings; the migrations' steps
  assert logging.getLogger('sqlalchemy.engine').getEffectiveLevel() == logging.WARNING
  assert logging.getLogger('alembic.runtime.migration').getEffectiveLevel() == logging.INFO


def record(message='hello %s', args=('you',), **extra):
  r = logging.LogRecord('backend.x', logging.INFO, __file__, 1, message, args, None)
  for key, value in extra.items():
    setattr(r, key, value)
  return r


def test_text_format():
  line = logs.TextFormatter().format(record(request_id='abc'))
  assert line.endswith(' INFO backend.x [abc] hello you')
  assert logs.TextFormatter().format(record()).endswith(' INFO backend.x hello you')


def test_json_format():
  line = json.loads(logs.JsonFormatter().format(record(request_id='abc', status=200, user='alice')))
  assert line['level'] == 'INFO' and line['logger'] == 'backend.x' and line['message'] == 'hello you'
  assert line['request_id'] == 'abc' and line['status'] == 200 and line['user'] == 'alice'
  assert line['time'].endswith('Z')
  assert 'args' not in line and 'msg' not in line
  try:
    raise ValueError('boom')
  except ValueError:
    import sys
    r = logging.LogRecord('backend.x', logging.ERROR, __file__, 1, 'failed', (), sys.exc_info())
  assert 'ValueError: boom' in json.loads(logs.JsonFormatter().format(r))['exception']


@pytest.fixture
def requests_log():
  app = Flask('logs_test')
  logs.register_requests(app)

  @app.route('/api/v1/things')
  def things():
    return 'ok'

  @app.route('/api/v1/health')
  def health():
    return 'ok'

  stream = io.StringIO()
  handler = logging.StreamHandler(stream)
  handler.setFormatter(logs.JsonFormatter())
  handler.addFilter(logs.RequestId())
  logger = logging.getLogger('backend.requests')
  level = logger.level
  logger.addHandler(handler)
  logger.setLevel(logging.INFO)

  def call(url, headers=None, user=None, status=200):
    with app.test_request_context(url, headers=headers or {}):
      app.preprocess_request()
      if user:
        g.actor = SimpleNamespace(user=SimpleNamespace(user_name=user))
      response = app.process_response(app.make_response(('ok', status)))
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    stream.truncate(0)
    stream.seek(0)
    return response, lines
  yield call
  logger.removeHandler(handler)
  logger.setLevel(level)


def test_one_line_per_request_without_secrets(requests_log):
  response, lines = requests_log('/api/v1/things?project=foo&token=qab_pat_secret', headers={'Authorization': 'Bearer qab_pat_secret'}, user='alice')
  [line] = lines
  assert line['method'] == 'GET' and line['path'] == '/api/v1/things' and line['status'] == 200
  assert line['user'] == 'alice' and line['project'] == 'foo'
  assert isinstance(line['duration_ms'], float)
  assert line['message'].startswith('GET /api/v1/things 200 ') and 'user=alice project=foo' in line['message']
  assert 'secret' not in json.dumps(line)
  assert response.headers['X-Request-ID'] == line['request_id']


def test_request_id_from_the_proxy(requests_log):
  response, [line] = requests_log('/api/v1/things', headers={'X-Request-ID': 'from-nginx'})
  assert line['request_id'] == 'from-nginx' and response.headers['X-Request-ID'] == 'from-nginx'


def test_health_checks_are_quiet(requests_log):
  _, lines = requests_log('/api/v1/health')
  assert lines == []
  _, [line] = requests_log('/api/v1/health', status=503)
  assert line['level'] == 'WARNING'


def test_url_for_logs():
  assert logs.url_for_logs("https://user:secret@jenkins.example.com:8080/job/a/build?token=abc#x") == "https://jenkins.example.com:8080/job/a/build"
  assert logs.url_for_logs("/api/v1/x?token=abc") == "/api/v1/x"
  assert logs.url_for_logs("http://[::1") == "<invalid URL>"
