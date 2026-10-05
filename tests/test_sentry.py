"""
`qa` reports errors to Sentry only in CI, and only to the site's project (QABOARD_SENTRY_DSN).
"""
import os
import sys
import json
import unittest
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# In a new process: importing qaboard here would load its configuration from the wrong directory for other tests
CHECK = """
import json
from unittest import mock
with mock.patch('sentry_sdk.init') as sentry_init, mock.patch('qaboard.site_config._site_defaults', {}):
  from qaboard.qa import init_sentry
  init_sentry()
calls = sentry_init.call_args_list
print(json.dumps({'calls': len(calls), 'dsn': calls[0].kwargs.get('dsn') if calls else None,
                  'custom_transport': bool(calls) and 'transport' in calls[0].kwargs}))
"""


class TestSentry(unittest.TestCase):
  def init(self, env):
    keys = ('CI', 'QABOARD_SENTRY_DSN', 'QABOARD_SENTRY_VERIFY')
    clean = {k: v for k, v in os.environ.items() if k not in keys}
    # Other tests chdir: run from the checkout, and import it rather than an installed qaboard
    env = {**clean, **env, 'PYTHONPATH': str(ROOT)}
    out = subprocess.run([sys.executable, '-c', CHECK], cwd=ROOT, env=env, capture_output=True, text=True)
    self.assertEqual(out.returncode, 0, out.stderr)
    return json.loads(out.stdout.strip().splitlines()[-1])

  def test_no_dsn(self):
    self.assertEqual(self.init({'CI': 'true'})['calls'], 0)

  def test_not_in_ci(self):
    self.assertEqual(self.init({'QABOARD_SENTRY_DSN': 'https://key@sentry.example.com/1'})['calls'], 0)

  def test_ci_with_dsn(self):
    result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://key@sentry.example.com/1'})
    self.assertEqual(result, {'calls': 1, 'dsn': 'https://key@sentry.example.com/1', 'custom_transport': False})

  def test_without_tls_verification(self):
    result = self.init({'CI': 'true', 'QABOARD_SENTRY_DSN': 'https://k@s/1', 'QABOARD_SENTRY_VERIFY': 'false'})
    self.assertTrue(result['custom_transport'])


if __name__ == '__main__':
  unittest.main()
