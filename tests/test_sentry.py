"""
`qa` reports errors to Sentry only in CI, and only to the site's project (QABOARD_SENTRY_DSN).
The settings shared with the backend and the celery workers are in qaboard/sentry_utils.py.
"""
import os
import sys
import json
import unittest
import tempfile
import subprocess
import importlib.util
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent

# In a new process: importing qaboard here would load its configuration from the wrong directory for other tests
CHECK = """
import json
from unittest import mock
with mock.patch('sentry_sdk.init') as sentry_init, mock.patch('qaboard.site_config._site_defaults', {}):
  from qaboard.qa import init_sentry
  init_sentry()
calls = sentry_init.call_args_list
kwargs = calls[0].kwargs if calls else {}
print(json.dumps({'calls': len(calls), 'dsn': kwargs.get('dsn'),
                  'custom_transport': 'transport' in kwargs,
                  'release': kwargs.get('release'), 'environment': kwargs.get('environment'),
                  'ca_certs': kwargs.get('ca_certs'), 'traces_sample_rate': kwargs.get('traces_sample_rate'),
                  'send_default_pii': kwargs.get('send_default_pii'),
                  'scrubs': kwargs.get('before_send') is not None and kwargs.get('before_send_transaction') is not None}))
"""

SENTRY_ENV = ('CI', 'QABOARD_SENTRY_DSN', 'QABOARD_SENTRY_VERIFY', 'SENTRY_CA_CERTS', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE',
              'SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_SAMPLE_RATE', 'SENTRY_PROFILES_SAMPLE_RATE',
              'SENTRY_PROFILE_SESSION_SAMPLE_RATE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE')

def load_sentry_utils():
  """Without importing the qaboard package (see above)"""
  spec = importlib.util.spec_from_file_location('qaboard_sentry_utils', ROOT / 'qaboard' / 'sentry_utils.py')
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


class TestSentry(unittest.TestCase):
  def init(self, env):
    clean = {k: v for k, v in os.environ.items() if k not in SENTRY_ENV}
    # Other tests chdir: run from the checkout, and import it rather than an installed qaboard
    env = {**clean, **env, 'PYTHONPATH': str(ROOT)}
    out = subprocess.run([sys.executable, '-c', CHECK], cwd=ROOT, env=env, capture_output=True, text=True)
    self.assertEqual(out.returncode, 0, out.stderr)
    result = json.loads(out.stdout.strip().splitlines()[-1])
    result['stderr'] = out.stderr
    return result

  def test_no_dsn(self):
    self.assertEqual(self.init({'CI': 'true'})['calls'], 0)

  def test_not_in_ci(self):
    self.assertEqual(self.init({'QABOARD_SENTRY_DSN': 'https://key@sentry.example.com/1'})['calls'], 0)

  def test_ci_with_dsn(self):
    result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://key@sentry.example.com/1'})
    self.assertEqual(result['calls'], 1)
    self.assertEqual(result['dsn'], 'https://key@sentry.example.com/1')
    self.assertFalse(result['custom_transport'])
    self.assertTrue(result['release'].startswith('qaboard@'))
    self.assertEqual(result['environment'], 'ci')
    self.assertEqual(result['traces_sample_rate'], 1.0)
    self.assertFalse(result['send_default_pii'])
    self.assertTrue(result['scrubs'])

  def test_environment_and_sample_rate(self):
    result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://k@s/1', 'SENTRY_ENVIRONMENT': 'staging',
                        'SENTRY_SAMPLE_RATE': '0.5'})
    self.assertEqual(result['environment'], 'staging')
    self.assertEqual(result['traces_sample_rate'], 0.5)

  def test_ca_bundle(self):
    with tempfile.NamedTemporaryFile(suffix='.pem') as f:
      result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://k@s/1', 'SENTRY_CA_CERTS': f.name})
      self.assertEqual(result['ca_certs'], f.name)
      self.assertFalse(result['custom_transport'])
      result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://k@s/1', 'QABOARD_SENTRY_VERIFY': f.name})
      self.assertEqual(result['ca_certs'], f.name)

  def test_without_tls_verification(self):
    result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://k@s/1', 'QABOARD_SENTRY_VERIFY': 'false'})
    self.assertTrue(result['custom_transport'])
    self.assertIn("not checking the server's TLS certificate", result['stderr'])


class TestSentryUtils(unittest.TestCase):
  def setUp(self):
    self.utils = load_sentry_utils()
    patcher = mock.patch.dict(os.environ)
    patcher.start()
    self.addCleanup(patcher.stop)
    for key in SENTRY_ENV:
      os.environ.pop(key, None)

  def test_defaults(self):
    options = self.utils.sentry_options('https://k@s/1', release='abc')
    self.assertEqual(options['release'], 'abc')
    self.assertEqual(options['environment'], 'production')
    self.assertEqual(options['traces_sample_rate'], 0.2)
    self.assertEqual(options['profile_session_sample_rate'], 0.1)
    self.assertEqual(options['profile_lifecycle'], 'trace')
    self.assertNotIn('profiles_sample_rate', options)
    self.assertFalse(options['send_default_pii'])

  def test_env_overrides(self):
    os.environ.update({'SENTRY_RELEASE': 'r1', 'SENTRY_ENVIRONMENT': 'staging', 'SENTRY_TRACES_SAMPLE_RATE': '1',
                       'SENTRY_SAMPLE_RATE': '0.5', 'SENTRY_PROFILE_SESSION_SAMPLE_RATE': '0'})
    options = self.utils.sentry_options('https://k@s/1', release='abc')
    self.assertEqual(options['release'], 'r1')
    self.assertEqual(options['environment'], 'staging')
    # The new name wins over the former one
    self.assertEqual(options['traces_sample_rate'], 1.0)
    self.assertEqual(options['profile_session_sample_rate'], 0.0)

  def test_invalid_rate(self):
    os.environ['SENTRY_TRACES_SAMPLE_RATE'] = 'lots'
    with mock.patch('sys.stderr'):
      self.assertEqual(self.utils.sentry_options('https://k@s/1')['traces_sample_rate'], 0.2)

  def test_transaction_based_profiling(self):
    os.environ['SENTRY_PROFILES_SAMPLE_RATE'] = '0.3'
    options = self.utils.sentry_options('https://k@s/1')
    self.assertEqual(options['profiles_sample_rate'], 0.3)
    self.assertNotIn('profile_session_sample_rate', options)

  def test_ca_certs(self):
    ca_certs = self.utils.ca_certs
    with mock.patch.object(self.utils, 'has_added_cas', return_value=False):
      self.assertEqual(ca_certs(None), (None, True))
      self.assertEqual(ca_certs('true'), (None, True))
    with mock.patch.object(self.utils, 'has_added_cas', return_value=True), \
         mock.patch.object(self.utils, 'system_ca_bundle', return_value='/etc/ssl/certs/ca-certificates.crt'):
      self.assertEqual(ca_certs(None), ('/etc/ssl/certs/ca-certificates.crt', True))
      self.assertEqual(ca_certs('system'), ('/etc/ssl/certs/ca-certificates.crt', True))
      # sentry_sdk uses them
      os.environ['SSL_CERT_FILE'] = '/some/bundle.pem'
      self.assertEqual(ca_certs(None), (None, True))
    with mock.patch('sys.stderr'):
      self.assertEqual(ca_certs('/some/ca.pem'), ('/some/ca.pem', True))
      self.assertEqual(ca_certs('false'), (None, False))
      self.assertEqual(ca_certs(False), (None, False))

  def test_scrub_strings(self):
    scrub = self.utils.scrub_string
    self.assertEqual(scrub('a=1&token=abc'), 'a=1&token=[Filtered]')
    self.assertEqual(scrub('GET https://git/api?private_token=x#y'), 'GET https://git/api?private_token=[Filtered]#y')
    self.assertEqual(scrub('author=bob&auth=x;password=y'), 'author=bob&auth=[Filtered];password=[Filtered]')
    self.assertEqual(scrub('SELECT * FROM tokens WHERE tokens.token = %(token_1)s'),
                     'SELECT * FROM tokens WHERE tokens.token = %(token_1)s')
    self.assertEqual(scrub(None), None)

  def test_scrub_event(self):
    event = {
      'request': {
        'url': 'https://qa/api/v1/x', 'query_string': 'project=a&token=secret1',
        'headers': {'Authorization': 'Bearer secret2', 'X-Gitlab-Token': 'secret3', 'Cookie': 'session=secret4', 'Accept': '*/*'},
        'cookies': {'session': 'secret4'},
      },
      'breadcrumbs': {'values': [{'category': 'httplib', 'data': {'url': 'https://git/api?private_token=secret5'}}]},
      'spans': [{'description': 'GET https://git/api?access_token=secret6', 'data': {'url': 'https://git/api', 'http.query': 'access_token=secret6'}}],
      'contexts': {'trace': {'data': {'http.query': 'token=secret7'}}},
      'exception': {'values': [{'stacktrace': {'frames': [{'vars': {
        'environ': {'QUERY_STRING': "'token=secret8'", 'HTTP_AUTHORIZATION': "'Bearer secret9'"},
        'token_str': "'secret10'",
      }}]}}]},
    }
    scrubbed = json.dumps(self.utils.scrub_event(event, {}))
    for n in range(1, 11):
      self.assertNotIn(f'secret{n}', scrubbed)
    self.assertEqual(event['request']['headers']['Accept'], '*/*')
    self.assertEqual(event['request']['query_string'], 'project=a&token=[Filtered]')


if __name__ == '__main__':
  unittest.main()
