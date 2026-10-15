"""
Tests for backend/sentry.py: the options of Sentry's SDK, scrubbing, and who we say the user is.
"""
import os
import sys
import json
import textwrap
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
from flask import Flask, g, jsonify, request

BACKEND_DIR = Path(__file__).resolve().parent.parent

SENTRY_ENV = ('SENTRY_DSN', 'SENTRY_CA_CERTS', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE', 'QABOARD_VERSION',
              'SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_SAMPLE_RATE', 'SENTRY_PROFILES_SAMPLE_RATE',
              'SENTRY_PROFILE_SESSION_SAMPLE_RATE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE')


@pytest.fixture
def sentry_env(monkeypatch):
  for key in SENTRY_ENV:
    monkeypatch.delenv(key, raising=False)
  return monkeypatch


def test_no_dsn(sentry_env):
  from backend import sentry
  with mock.patch('sentry_sdk.init') as init:
    assert sentry.init_sentry() is False
  init.assert_not_called()


def test_init(sentry_env):
  from backend import sentry
  sentry_env.setattr(sentry, '_initialized', False)
  sentry_env.setenv('SENTRY_DSN', 'https://key@sentry.example.com/1')
  with mock.patch('sentry_sdk.init') as init:
    assert sentry.init_sentry() is True
    assert sentry.init_sentry() is True
  init.assert_called_once()
  assert init.call_args.kwargs['dsn'] == 'https://key@sentry.example.com/1'


def test_options(sentry_env):
  from backend.sentry import backend_sentry_options
  from qaboard.sentry_utils import scrub_event
  sentry_env.setenv('QABOARD_VERSION', 'abcd1234')
  with mock.patch('qaboard.sentry_utils.has_added_cas', return_value=False):
    options = backend_sentry_options('https://key@sentry.example.com/1')
  assert options['release'] == 'abcd1234'
  assert options['environment'] == 'production'
  assert options['traces_sample_rate'] == 0.2
  assert options['profile_session_sample_rate'] == 0.1
  assert options['profile_lifecycle'] == 'trace'
  assert options['send_default_pii'] is False
  assert options['before_send'] is scrub_event
  assert options['before_send_transaction'] is scrub_event
  # No more insecure transport
  assert 'transport' not in options
  assert 'ca_certs' not in options
  assert [i.identifier for i in options['integrations']] == ['flask']


def test_options_from_env(sentry_env, tmp_path):
  from backend.sentry import backend_sentry_options
  ca = tmp_path / 'ca.pem'
  ca.write_text('')
  sentry_env.setenv('QABOARD_VERSION', 'abcd1234')
  sentry_env.setenv('SENTRY_RELEASE', 'custom')
  sentry_env.setenv('SENTRY_ENVIRONMENT', 'staging')
  # the former name still works
  sentry_env.setenv('SENTRY_SAMPLE_RATE', '0.5')
  sentry_env.setenv('SENTRY_PROFILES_SAMPLE_RATE', '0.25')
  sentry_env.setenv('SENTRY_CA_CERTS', str(ca))
  options = backend_sentry_options('https://key@sentry.example.com/1')
  assert options['release'] == 'custom'
  assert options['environment'] == 'staging'
  assert options['traces_sample_rate'] == 0.5
  assert options['profiles_sample_rate'] == 0.25
  assert 'profile_session_sample_rate' not in options
  assert options['ca_certs'] == str(ca)


def test_system_ca_bundle_when_a_ca_was_added(sentry_env):
  from backend.sentry import backend_sentry_options
  with mock.patch('qaboard.sentry_utils.has_added_cas', return_value=True), \
       mock.patch('qaboard.sentry_utils.system_ca_bundle', return_value='/etc/ssl/certs/ca-certificates.crt'):
    options = backend_sentry_options('https://key@sentry.example.com/1')
  assert options['ca_certs'] == '/etc/ssl/certs/ca-certificates.crt'


def test_sentry_user():
  from backend.sentry import sentry_user, flask_sentry_user
  assert sentry_user(None) is None
  assert sentry_user({'is_authenticated': False}) is None
  # Only the username, no email/full name
  assert sentry_user({'user_name': 'alice', 'email': 'a@x', 'full_name': 'Alice'}) == {'username': 'alice'}
  app = Flask(__name__)
  with app.app_context():
    assert flask_sentry_user(g) is None
    g._login_user = SimpleNamespace(is_authenticated=False, user_name='anonymous')
    assert flask_sentry_user(g) is None
    g._login_user = SimpleNamespace(is_authenticated=True, user_name='bob', email='b@x')
    assert flask_sentry_user(g) == {'username': 'bob'}
    g.user = {'user_name': 'alice', 'is_authenticated': True}
    assert flask_sentry_user(g) == {'username': 'alice'}


# With the real SDK and SQLAlchemy, in another process: conftest.py mocks sqlalchemy, and the SDK's state is global
END_TO_END = textwrap.dedent("""
  import json, sys, importlib.util
  import sentry_sdk
  from sentry_sdk.transport import Transport
  from flask import Flask, g, jsonify
  from sqlalchemy import create_engine, text

  spec = importlib.util.spec_from_file_location('backend_sentry', sys.argv[1])
  backend_sentry = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(backend_sentry)

  envelopes = []
  class Capture(Transport):
    def capture_envelope(self, envelope):
      for item in envelope.items:
        if item.type in ('event', 'transaction'):
          envelopes.append(item.payload.json)

  options = backend_sentry.backend_sentry_options('https://key@sentry.example.com/1')
  options.update(transport=Capture, traces_sample_rate=1.0, profile_session_sample_rate=0)
  sentry_sdk.init(**options)

  engine = create_engine('sqlite://')
  app = Flask(__name__)
  backend_sentry.track_users(app)

  @app.route('/api/v1/error')
  def error():
    g.user = {'user_name': 'alice', 'email': 'alice' + '@example.com'}  # not in the source context sent to Sentry
    raise ValueError('boom')

  @app.route('/api/v1/query')
  def query():
    with engine.connect() as connection:
      connection.execute(text('SELECT 1')).all()
    return jsonify({})

  client = app.test_client()
  client.get('/api/v1/error?project=a&token=secret1', headers={'Authorization': 'Bearer secret2', 'Cookie': 'session=secret3'})
  client.get('/api/v1/query?token=secret4')
  sentry_sdk.flush()
  print(json.dumps(envelopes))
""")


def test_end_to_end(tmp_path):
  pytest.importorskip('sentry_sdk')
  script = tmp_path / 'end_to_end.py'
  script.write_text(END_TO_END)
  env = {k: v for k, v in os.environ.items() if k not in SENTRY_ENV}
  env['BACKEND_TEST_MODE'] = 'no-mock'
  out = subprocess.run([sys.executable, str(script), str(BACKEND_DIR / 'backend' / 'sentry.py')],
                       env=env, capture_output=True, text=True, cwd=tmp_path)
  assert out.returncode == 0, out.stderr
  events = json.loads(out.stdout.strip().splitlines()[-1])
  serialized = json.dumps(events)
  for n in range(1, 5):
    assert f'secret{n}' not in serialized

  errors = [e for e in events if e.get('type') != 'transaction']
  assert len(errors) == 1
  assert errors[0]['exception']['values'][0]['value'] == 'boom'
  assert errors[0]['user'] == {'username': 'alice'}
  assert 'alice@example.com' not in serialized

  transactions = {e['transaction']: e for e in events if e.get('type') == 'transaction'}
  assert set(transactions) == {'error', 'query'}
  assert transactions['error']['user'] == {'username': 'alice'}
  # Database spans
  db_spans = [s for s in transactions['query']['spans'] if s['op'] == 'db']
  assert [s['description'] for s in db_spans] == ['SELECT 1']
