"""
Tests for `qa auth`: where tokens are saved and found, the device flow, and what qa says when the server refuses a token.
"""
import io
import os
import json
import stat
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from contextlib import redirect_stderr
from unittest import mock
from urllib.parse import urlsplit

import yaml
import requests
from click.testing import CliRunner

SERVER = 'http://qa.test'
ME = {
  "is_authenticated": True, "user_id": 3, "user_name": "alice", "full_name": "Alice Doe",
  "token": {"id": 12, "name": "qa CLI on host-12", "prefix": "qab_pat_Xk3f", "kind": "cli",
            "scopes": ["read", "ingest", "act"], "projects": [], "expires_at": None},
}
DEVICE_CODE = {
  "device_code": "the-device-code", "user_code": "WDJB-MJHT",
  "verification_uri": f"{SERVER}/device", "verification_uri_complete": f"{SERVER}/device?code=WDJB-MJHT",
  "expires_in": 900, "interval": 5,
}
APPROVED = {"access_token": "qab_pat_new", "token_type": "Bearer", "token_id": 12, "user_name": "alice",
            "scopes": ["read", "ingest", "act"], "expires_at": None, "idle_expiry_days": 180}


def response(status, body=None, headers=None):
  r = requests.models.Response()
  r.status_code = status
  r._content = json.dumps(body).encode() if body is not None else b''
  r.headers['Content-Type'] = 'application/json'
  r.headers.update(headers or {})
  r.request = requests.Request('GET', SERVER, headers={'Authorization': 'Bearer secret'}).prepare()
  return r


class FakeServer:
  """Replaces requests.request. `routes` maps (method, path) to the responses to give in order (the last one repeats)."""
  def __init__(self, routes):
    self.routes = {k: list(v) for k, v in routes.items()}
    self.calls = []

  def __call__(self, method, url, headers=None, json=None, **kwargs):
    path = urlsplit(url).path
    self.calls.append((method, path, headers or {}, json))
    responses = self.routes.get((method, path))
    if not responses:
      return response(404, {"error": "Not found"})
    return responses.pop(0) if len(responses) > 1 else responses[0]

  def paths(self, method=None):
    return [c[1] for c in self.calls if not method or c[0] == method]


class AuthTestCase(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)
    env = {k: v for k, v in os.environ.items() if k not in ('QABOARD_TOKEN', 'QA_TOKEN')}
    env['XDG_CONFIG_HOME'] = str(self.dir / 'config')
    for patcher in [
      mock.patch.dict(os.environ, env, clear=True),
      mock.patch.dict('qaboard.auth.user_secrets', {}, clear=True),
    ]:
      patcher.start()
      self.addCleanup(patcher.stop)
    from qaboard import auth
    self.auth = auth
    self.hosts_path = self.dir / 'config' / 'qaboard' / 'hosts.yaml'

  def qa_auth(self, *args, server=None, input=None):
    """Runs `qa auth ...` against a fake server"""
    server = server or FakeServer({})
    with mock.patch('requests.request', server), mock.patch('time.sleep') as sleep:
      result = CliRunner().invoke(self.auth.auth, [*args], input=input, catch_exceptions=False)
    result.sleeps = [c.args[0] for c in sleep.call_args_list]
    return result

  def save(self, login, url=SERVER):
    self.hosts_path.parent.mkdir(parents=True, exist_ok=True)
    self.hosts_path.write_text(yaml.safe_dump({url: login}))
    self.hosts_path.chmod(0o600)

  def hosts(self):
    return yaml.safe_load(self.hosts_path.read_text()) if self.hosts_path.exists() else {}


class TestStorage(AuthTestCase):
  def test_normalize_url(self):
    normalize_url = self.auth.normalize_url
    self.assertEqual(normalize_url('https://QA.example/'), 'https://qa.example')
    self.assertEqual(normalize_url('https://qa.example:443/some/path?x=1'), 'https://qa.example')
    self.assertEqual(normalize_url('http://qa.example:80'), 'http://qa.example')
    self.assertEqual(normalize_url('http://qa.example:5151/'), 'http://qa.example:5151')
    self.assertEqual(normalize_url('https://qa.example:5151'), 'https://qa.example:5151')
    self.assertEqual(normalize_url('qa-srv:5151'), 'http://qa-srv:5151')
    self.assertEqual(normalize_url('qa-srv', default_scheme='https'), 'https://qa-srv')
    self.assertEqual(normalize_url('http://user@[::1]:5151/'), 'http://[::1]:5151')
    with self.assertRaises(ValueError):
      normalize_url('http://')

  def test_config_dir(self):
    from qaboard.site_config import user_config_dir
    self.assertEqual(user_config_dir(), self.dir / 'config' / 'qaboard')
    with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': ''}):
      self.assertEqual(user_config_dir(), Path.home() / '.config' / 'qaboard')
    # relative paths are invalid
    with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': 'relative/dir'}):
      self.assertEqual(user_config_dir(), Path.home() / '.config' / 'qaboard')
    with mock.patch('sys.platform', 'darwin'):
      self.assertEqual(user_config_dir(), self.dir / 'config' / 'qaboard')

  def test_config_dir_on_windows(self):
    from qaboard.site_config import user_config_dir
    class WindowsPath(PureWindowsPath):
      @classmethod
      def home(cls):
        return cls('C:/Users/alice')
    with mock.patch('os.name', 'nt'), mock.patch('qaboard.site_config.Path', WindowsPath):
      with mock.patch.dict(os.environ, {'APPDATA': 'C:\\Users\\alice\\AppData\\Roaming'}):
        self.assertEqual(user_config_dir(), PureWindowsPath('C:/Users/alice/AppData/Roaming/qaboard'))
      with mock.patch.dict(os.environ, {}, clear=True):
        self.assertEqual(user_config_dir(), PureWindowsPath('C:/Users/alice/AppData/Roaming/qaboard'))

  @unittest.skipIf(os.name == 'nt', "POSIX permissions")
  def test_permissions(self):
    previous_umask = os.umask(0) # as in `qa` commands
    try:
      self.auth.save_login(SERVER, user='alice', token='qab_pat_secret', token_id=12)
    finally:
      os.umask(previous_umask)
    self.assertEqual(stat.S_IMODE(self.hosts_path.stat().st_mode), 0o600)
    self.assertEqual(stat.S_IMODE(self.hosts_path.parent.stat().st_mode), 0o700)
    self.assertEqual(os.listdir(self.hosts_path.parent), ['hosts.yaml'])
    login = self.hosts()[SERVER]
    self.assertEqual((login['user'], login['token'], login['token_id']), ('alice', 'qab_pat_secret', 12))
    self.assertIn('created_at', login)
    # replaced atomically, other servers are kept
    self.hosts_path.chmod(0o644)
    self.auth.save_login('https://other.example', user='bob', token='qab_pat_other')
    self.assertEqual(stat.S_IMODE(self.hosts_path.stat().st_mode), 0o600)
    self.assertEqual(sorted(self.hosts()), ['http://qa.test', 'https://other.example'])

  def test_precedence(self):
    resolve_token = self.auth.resolve_token
    self.assertEqual(resolve_token(SERVER), (None, None))
    with mock.patch.dict('qaboard.auth.user_secrets', {'QA_TOKEN': 'legacy'}):
      self.assertEqual(resolve_token(SERVER), ('legacy', 'secrets.yaml'))
      # keys are normalized, so are hand-edited hosts.yaml
      self.save({'user': 'alice', 'token': 'saved'}, url='HTTP://qa.test:80/')
      self.assertEqual(resolve_token('http://qa.test/'), ('saved', 'hosts.yaml'))
      self.assertEqual(resolve_token('http://other.test'), ('legacy', 'secrets.yaml'))
      with mock.patch.dict(os.environ, {'QA_TOKEN': 'env-alias'}):
        self.assertEqual(resolve_token(SERVER), ('env-alias', 'QA_TOKEN'))
        with mock.patch.dict(os.environ, {'QABOARD_TOKEN': ' env \n'}):
          self.assertEqual(resolve_token(SERVER), ('env', 'QABOARD_TOKEN'))
        # empty means unset
        with mock.patch.dict(os.environ, {'QABOARD_TOKEN': ''}):
          self.assertEqual(resolve_token(SERVER), ('env-alias', 'QA_TOKEN'))

  def test_headers_for_another_server(self):
    from qaboard.api import headers_for
    self.save({'user': 'alice', 'token': 'saved'})
    self.assertEqual(headers_for(SERVER)['Authorization'], 'Bearer saved')
    self.assertNotIn('Authorization', headers_for('http://other.test'))


class TestLogin(AuthTestCase):
  def device_server(self, *token_responses):
    return FakeServer({
      ('POST', '/api/v1/auth/device/code'): [response(200, DEVICE_CODE)],
      ('POST', '/api/v1/auth/device/token'): list(token_responses),
      ('GET', '/api/v1/user/me/'): [response(200, ME)],
    })

  def test_device_flow(self):
    server = self.device_server(
      response(400, {"error": "authorization_pending"}),
      response(400, {"error": "slow_down"}),
      response(400, {"error": "authorization_pending"}),
      response(200, APPROVED),
    )
    with mock.patch('webbrowser.open') as open_browser, mock.patch('socket.gethostname', return_value='host-12'):
      result = self.qa_auth('login', '--server', SERVER, '--no-browser', server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    open_browser.assert_not_called()
    self.assertIn('WDJB-MJHT', result.output)
    self.assertIn(f'open {SERVER}/device and enter the code', result.output)
    self.assertIn(f'{SERVER}/device?code=WDJB-MJHT', result.output)
    self.assertIn(f'Logged in to {SERVER} as alice.', result.output)
    # slow_down adds 5s to the interval
    self.assertEqual(result.sleeps, [5, 5, 10, 10])
    method, path, headers, body = server.calls[0]
    self.assertEqual(body, {"client_name": "qa CLI on host-12", "hostname": "host-12"})
    self.assertNotIn('Authorization', headers)
    self.assertEqual({tuple(c[3].items()) for c in server.calls if c[1].endswith('/device/token')}, {(('device_code', 'the-device-code'),)})
    me_call = server.calls[-1]
    self.assertEqual((me_call[1], me_call[2]['Authorization']), ('/api/v1/user/me/', 'Bearer qab_pat_new'))
    login = self.hosts()[SERVER]
    self.assertEqual((login['user'], login['token'], login['token_id']), ('alice', 'qab_pat_new', 12))

  def test_denied(self):
    result = self.qa_auth('login', '--server', SERVER, '--no-browser', server=self.device_server(
      response(400, {"error": "authorization_pending"}),
      response(400, {"error": "access_denied", "error_description": "The user denied the request"}),
    ))
    self.assertEqual(result.exit_code, 1)
    self.assertIn('The login was denied in the browser.', result.output)
    self.assertFalse(self.hosts_path.exists())

  def test_expired(self):
    result = self.qa_auth('login', '--server', SERVER, '--no-browser', server=self.device_server(response(400, {"error": "expired_token"})))
    self.assertEqual(result.exit_code, 1)
    self.assertIn('The code expired before the login was approved. Run `qa auth login` again.', result.output)
    self.assertFalse(self.hosts_path.exists())

  def test_ctrl_c(self):
    server = self.device_server(response(400, {"error": "authorization_pending"}))
    with mock.patch('requests.request', server), mock.patch('time.sleep', side_effect=KeyboardInterrupt):
      result = CliRunner().invoke(self.auth.auth, ['login', '--server', SERVER, '--no-browser'])
    self.assertEqual(result.exit_code, 130)
    self.assertIn('The login was cancelled.', result.output)
    self.assertFalse(self.hosts_path.exists())

  def test_old_server(self):
    result = self.qa_auth('login', '--server', SERVER, '--no-browser')
    self.assertEqual(result.exit_code, 1)
    self.assertIn("doesn't support `qa auth login` yet", result.output)

  def test_browser(self):
    with mock.patch('webbrowser.open', return_value=True) as open_browser, mock.patch.object(self.auth, 'can_open_browser', return_value=True):
      result = self.qa_auth('login', '--server', SERVER, server=self.device_server(response(200, APPROVED)))
    self.assertEqual(result.exit_code, 0, result.output)
    open_browser.assert_called_once_with(f'{SERVER}/device?code=WDJB-MJHT')

  def test_can_open_browser(self):
    can_open_browser = self.auth.can_open_browser
    with mock.patch.dict(os.environ, {'SSH_CONNECTION': '10.0.0.1 1234 10.0.0.2 22', 'DISPLAY': ':0'}):
      self.assertFalse(can_open_browser())
    with mock.patch.dict(os.environ, {'SSH_TTY': '/dev/pts/1'}), mock.patch('sys.platform', 'darwin'):
      self.assertFalse(can_open_browser())
    for var in ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY'):
      os.environ.pop(var, None)
    with mock.patch('sys.platform', 'linux'), mock.patch('os.name', 'posix'):
      self.assertFalse(can_open_browser())
      with mock.patch.dict(os.environ, {'WAYLAND_DISPLAY': 'wayland-0'}):
        self.assertTrue(can_open_browser())
    with mock.patch('sys.platform', 'darwin'):
      self.assertTrue(can_open_browser())

  def test_with_token(self):
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(200, ME)]})
    result = self.qa_auth('login', '--server', 'qa.test', '--with-token', input='  qab_pat_pasted\n', server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(server.calls[0][2]['Authorization'], 'Bearer qab_pat_pasted')
    login = self.hosts()[SERVER]
    self.assertEqual((login['user'], login['token'], login['token_id']), ('alice', 'qab_pat_pasted', 12))

  def test_with_a_rejected_token(self):
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(401, {"error": "This token was revoked on 2026-10-01.", "reason": "token_revoked"})]})
    result = self.qa_auth('login', '--server', SERVER, '--with-token', input='qab_pat_revoked\n', server=server)
    self.assertEqual(result.exit_code, 1)
    self.assertIn('The token was not accepted: This token was revoked on 2026-10-01.', result.output)
    self.assertFalse(self.hosts_path.exists())
    # older servers ignore unknown tokens
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(200, {"is_authenticated": False})]})
    result = self.qa_auth('login', '--server', SERVER, '--with-token', input='qab_pat_unknown\n', server=server)
    self.assertEqual(result.exit_code, 1)
    self.assertIn('QA-Board did not accept the token.', result.output)

  def test_with_no_token(self):
    result = self.qa_auth('login', '--server', SERVER, '--with-token', input='\n')
    self.assertEqual(result.exit_code, 1)
    self.assertIn('No token was given on stdin', result.output)

  def test_env_token_wins(self):
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(200, ME)]})
    with mock.patch.dict(os.environ, {'QABOARD_TOKEN': 'from-ci'}):
      result = self.qa_auth('login', '--server', SERVER, '--with-token', input='qab_pat_pasted', server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertIn('$QABOARD_TOKEN is set: qa uses it instead of this login', result.output)


class TestStatusLogoutToken(AuthTestCase):
  def test_status(self):
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(200, ME)]})
    result = self.qa_auth('status', '--server', SERVER, server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(server.calls[0][2]['Authorization'], 'Bearer qab_pat_saved')
    for line in [f'QA-Board server: {SERVER}', f'Token from: {self.hosts_path}', 'Logged in as: alice (Alice Doe)',
                 'Token: qa CLI on host-12 (qab_pat_Xk3f...)', 'Scopes: read, ingest, act', 'Expires: never']:
      self.assertIn(line, result.output)

  def test_status_with_an_env_token(self):
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(200, {**ME, 'token': None})]})
    with mock.patch.dict(os.environ, {'QA_TOKEN': 'legacy-env'}):
      result = self.qa_auth('status', '--server', SERVER, server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(server.calls[0][2]['Authorization'], 'Bearer legacy-env')
    self.assertIn('Token from: the QA_TOKEN environment variable', result.output)
    self.assertIn('Token details: not available', result.output)
    self.assertIn('is not used', result.output)

  def test_status_not_logged_in(self):
    result = self.qa_auth('status', '--server', SERVER)
    self.assertEqual(result.exit_code, 1)
    self.assertIn('Not logged in. Run `qa auth login`', result.output)

  def test_status_rejected(self):
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    server = FakeServer({('GET', '/api/v1/user/me/'): [response(401, {"error": "Your token expired on 2026-09-01.", "reason": "token_expired"})]})
    result = self.qa_auth('status', '--server', SERVER, server=server)
    self.assertEqual(result.exit_code, 1)
    self.assertIn('Your token expired on 2026-09-01.', result.output)
    self.assertIn('qa auth login', result.output)

  def test_logout(self):
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    server = FakeServer({('DELETE', '/api/v1/user/tokens/12'): [response(200, {"id": 12, "status": "revoked"})]})
    result = self.qa_auth('logout', '--server', SERVER, server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(server.calls[0][2]['Authorization'], 'Bearer qab_pat_saved')
    self.assertIn('Revoked the token on the server.', result.output)
    self.assertIn(f'Logged out of {SERVER}.', result.output)
    self.assertEqual(self.hosts(), {})

  def test_logout_when_revoking_fails(self):
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    self.auth.save_login('https://other.example', user='bob', token='qab_pat_other')
    server = FakeServer({('DELETE', '/api/v1/user/tokens/12'): [response(500, {"error": "Internal error"})]})
    result = self.qa_auth('logout', '--server', SERVER, server=server)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertIn('Could not revoke the token on the server (500: Internal error). Revoke it in the web app', result.output)
    self.assertEqual(list(self.hosts()), ['https://other.example'])
    with mock.patch('requests.request', side_effect=requests.ConnectionError('unreachable')):
      result = CliRunner().invoke(self.auth.auth, ['logout', '--server', 'https://other.example'])
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertIn("qa doesn't know the token's id", result.output)
    self.assertEqual(self.hosts(), {})

  def test_logout_with_an_env_token(self):
    with mock.patch.dict(os.environ, {'QABOARD_TOKEN': 'from-ci'}):
      result = self.qa_auth('logout', '--server', SERVER)
    self.assertEqual(result.exit_code, 1)
    self.assertIn("The token comes from $QABOARD_TOKEN: `qa auth logout` can't remove it.", result.output)
    result = self.qa_auth('logout', '--server', SERVER)
    self.assertEqual(result.exit_code, 1)
    self.assertIn(f'Not logged in to {SERVER}.', result.output)

  def test_token(self):
    result = self.qa_auth('token', '--server', SERVER)
    self.assertEqual(result.exit_code, 1)
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    result = self.qa_auth('token', '--server', SERVER)
    self.assertEqual((result.exit_code, result.stdout), (0, 'qab_pat_saved\n'))

  def test_qa_auth_needs_no_project(self):
    from qaboard.qa import qa
    self.save({'user': 'alice', 'token': 'qab_pat_saved', 'token_id': 12})
    previous_cwd = os.getcwd()
    try:
      os.chdir(self.dir)
      result = CliRunner().invoke(qa, ['auth', 'token', '--server', SERVER], obj={})
    finally:
      os.chdir(previous_cwd)
    self.assertEqual((result.exit_code, result.stdout), (0, 'qab_pat_saved\n'))


class TestIngestMessages(AuthTestCase):
  def setUp(self):
    super().setUp()
    for patcher in [
      mock.patch('qaboard.api.qa_token', None),
      mock.patch('qaboard.api.qa_token_source', None),
      mock.patch('qaboard.config.is_ci', False),
      mock.patch.object(self.auth, '_warnings_shown', set()),
    ]:
      patcher.start()
      self.addCleanup(patcher.stop)

  def notify(self, r):
    from qaboard.api import notify_qa_database
    stderr = io.StringIO()
    with mock.patch('requests.post', return_value=r) as post, redirect_stderr(stderr):
      result = notify_qa_database(object_type='output', share=True, batch_label='default', user='alice')
    self.assertIsNotNone(post.call_args.kwargs.get('timeout'))
    return result, stderr.getvalue()

  def test_expired_token(self):
    with mock.patch('qaboard.api.qa_token_source', 'hosts.yaml'):
      result, stderr = self.notify(response(401, {"error": "Your token expired on 2026-09-01.", "reason": "token_expired"}))
    self.assertIsNone(result)
    self.assertIn('Failed to update QA-Board: Your token expired on 2026-09-01.', stderr)
    self.assertIn('Run `qa auth login` to get a new token.', stderr)
    self.assertNotIn('Traceback', stderr)
    self.assertNotIn('qaboard_config', stderr)

  def test_expired_env_token(self):
    with mock.patch('qaboard.api.qa_token_source', 'QABOARD_TOKEN'):
      _, stderr = self.notify(response(401, {"error": "This token was revoked.", "reason": "token_revoked"}))
    self.assertIn('The token comes from $QABOARD_TOKEN: replace it, or unset it and run `qa auth login`.', stderr)

  def test_ingest_token_required(self):
    _, stderr = self.notify(response(403, {"error": "This server only accepts runs sent with a token.", "reason": "ingest_token_required"}))
    self.assertIn('This server only accepts runs sent with a token.', stderr)
    self.assertIn('Run `qa auth login`, or in CI set QABOARD_TOKEN', stderr)
    self.assertNotIn('unverified', stderr)

  def test_older_servers(self):
    _, stderr = self.notify(response(401, {"error": "You need to be logged-in to do this."}))
    self.assertIn('Failed to update QA-Board.', stderr)
    self.assertIn('401: {"error": "You need to be logged-in to do this."}', stderr)
    self.assertNotIn('qa auth login', stderr)
    self.assertNotIn('secret', stderr)

  def test_warning_header_and_nudge(self):
    warning = {'X-QABoard-Warning': 'This run was sent without a token: it is saved as unverified.'}
    result, stderr = self.notify(response(200, {"id": 1}, headers=warning))
    self.assertEqual(result, {"id": 1})
    self.assertIn('WARNING: This run was sent without a token: it is saved as unverified.', stderr)
    self.assertIn("Your runs are saved as unverified 'alice'. Run `qa auth login` to sign them.", stderr)
    # once per process, and the nudge once a day
    _, stderr = self.notify(response(200, {"id": 2}, headers=warning))
    self.assertEqual(stderr, '')

  def test_no_nudge_with_a_token_or_in_ci(self):
    with mock.patch('qaboard.api.qa_token', 'qab_pat_saved'):
      _, stderr = self.notify(response(200, {"id": 1}))
    self.assertEqual(stderr, '')
    with mock.patch('qaboard.config.is_ci', True):
      _, stderr = self.notify(response(200, {"id": 1}))
    self.assertEqual(stderr, '')

  def test_gate_message(self):
    from qaboard.gate import fetch_comparison
    r = response(401, {"error": "Your token expired on 2026-09-01.", "reason": "token_expired"})
    with mock.patch('requests.get', return_value=r):
      data, error = fetch_comparison(f'{SERVER}/api/v1', 'p', 'c0ffee', None, 'default', [], False, {}, True)
    self.assertEqual(error, 'Your token expired on 2026-09-01. Run `qa auth login` to get a new token.')


class TestNudge(AuthTestCase):
  def nudge(self):
    stderr = io.StringIO()
    with redirect_stderr(stderr):
      self.auth.nudge_unverified('alice')
    return stderr.getvalue()

  def test_once_a_day(self):
    self.assertIn("unverified 'alice'", self.nudge())
    self.assertEqual(self.nudge(), '')
    path = self.dir / 'config' / 'qaboard' / 'last-auth-nudge'
    path.write_text(str(float(path.read_text()) - 25 * 3600))
    self.assertIn("unverified 'alice'", self.nudge())
    self.assertEqual(self.nudge(), '')
    path.write_text('corrupted')
    self.assertIn("unverified 'alice'", self.nudge())

  @unittest.skipIf(os.name == 'nt' or (hasattr(os, 'geteuid') and os.geteuid() == 0), "root can write anywhere")
  def test_read_only_config_dir(self):
    read_only = self.dir / 'config'
    read_only.mkdir()
    read_only.chmod(0o500)
    self.addCleanup(read_only.chmod, 0o700)
    self.assertEqual(self.nudge(), '')

  def test_unwritable_config_dir(self):
    # e.g. a file where the config directory should be
    (self.dir / 'config').write_text('')
    self.assertEqual(self.nudge(), '')


if __name__ == '__main__':
  unittest.main()
