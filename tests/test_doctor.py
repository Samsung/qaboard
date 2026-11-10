"""
Tests for `qa doctor`: each check passes and fails as it should and says how to fix it, the runners' checks,
and the command on the sample project. Offline: HTTP requests, LSF and Celery are faked.
"""
import os
import sys
import json
import errno
import datetime
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest import mock
from importlib import import_module, reload
from urllib.parse import urlsplit

import yaml
import requests
import click
from click.testing import CliRunner

from qaboard.checks import Check, OK, WARNING, ERROR, SKIPPED

SERVER = 'http://qa.test'
TOKEN = 'qab_pat_Xk3fSECRETSECRETSECRET1234'
root_repo = Path(__file__).resolve().parent.parent


def response(status, body=None, text=None):
  """A JSON response, or a web page with `text`"""
  r = requests.models.Response()
  r.status_code = status
  r._content = text.encode() if text is not None else json.dumps(body).encode() if body is not None else b''
  r.headers['Content-Type'] = 'text/html' if text is not None else 'application/json'
  r.request = requests.Request('GET', SERVER).prepare()
  return r


class FakeGet:
  """Replaces requests.get. `routes` maps paths to a response, or an exception to raise. Others are 404 web pages."""
  def __init__(self, routes):
    self.routes = routes
    self.calls = []

  def __call__(self, url, headers=None, params=None, **kwargs):
    path = urlsplit(url).path
    self.calls.append((path, headers or {}, params))
    route = self.routes.get(path)
    if isinstance(route, Exception):
      raise route
    return route if route is not None else response(404, text='<html><title>Not Found</title></html>')


def server(where='$QABOARD_URL'):
  from qaboard.auth import Server
  return Server(SERVER, f"{SERVER}/api/v1", where)


def statuses(checks):
  return [c.status for c in checks]


def write(path: Path, text: str) -> Path:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(text)
  return path


class TempDirTestCase(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.tmp = Path(tmp.name).resolve()


VALID_CONFIG = "project:\n  name: group/repo\n  url: https://git.example/group/repo\n  entrypoint: main.py\nstorage: /tmp\n"


class TestConfigChecks(TempDirTestCase):
  def test_no_config(self):
    from qaboard.doctor import check_config
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, ERROR)
    self.assertIn('No qaboard.yaml', check.message)
    self.assertIn('qa init', check.fix)
    self.assertIn('https://samsung.github.io/qaboard/docs/project-init', check.fix)

  def test_invalid_yaml(self):
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', "project:\n  name: a/b\n url: x\n")
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, ERROR)
    self.assertIn('not valid YAML', check.message)
    self.assertIn('line 3', check.message)

  def test_not_a_mapping(self):
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', "- a\n- b\n")
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, ERROR)
    self.assertIn('mapping', check.message)

  def test_missing_project_settings(self):
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', "project:\n  name: a/b\n")
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, ERROR)
    self.assertIn('project.url', check.message)
    self.assertIn('url: https://github.com/group/repo', check.fix)
    write(self.tmp / 'qaboard.yaml', "project:\n  name: 3\n  url: x\n")
    [check] = check_config(self.tmp)
    self.assertIn('needs project.name, as text', check.message)

  def test_missing_include(self):
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', VALID_CONFIG + "include: base.yaml\n")
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, ERROR)
    self.assertIn('base.yaml', check.message)

  def test_valid_and_subproject(self):
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', VALID_CONFIG)
    write(self.tmp / 'sub' / 'qaboard.yaml', '')
    [check] = check_config(self.tmp / 'sub' / 'folder')
    self.assertEqual(check.status, OK)
    self.assertIn(str(self.tmp / 'sub' / 'qaboard.yaml'), check.message)

  def test_root_stops_the_search(self):
    from qaboard.doctor import find_config_files
    write(self.tmp / 'qaboard.yaml', "- not valid for qa")
    write(self.tmp / 'project' / 'qaboard.yaml', VALID_CONFIG + "root: true\n")
    found, error = find_config_files(self.tmp / 'project')
    self.assertIsNone(error)
    self.assertEqual([p for _, p in found], [self.tmp / 'project' / 'qaboard.yaml'])

  def test_load_error(self):
    # qaboard.config couldn't load the project for a reason qa doctor doesn't know
    from qaboard.doctor import check_config
    write(self.tmp / 'qaboard.yaml', VALID_CONFIG)
    [check] = check_config(self.tmp, load_error='something broke')
    self.assertEqual(check.status, ERROR)
    self.assertIn('something broke', check.message)

  def test_schema(self):
    from qaboard.doctor import check_config
    try:
      import jsonschema  # noqa: F401
    except ImportError:
      self.skipTest("jsonschema is not installed")
    write(self.tmp / 'qaboard.yaml', VALID_CONFIG + "runners:\n  lsff:\n    queue: q\n")
    [check] = check_config(self.tmp)
    self.assertEqual(check.status, WARNING)
    self.assertIn("'lsff' was unexpected", check.message)
    self.assertIn('yaml-language-server', check.fix)

  def test_sample_project(self):
    from qaboard.doctor import check_config
    [check] = check_config(root_repo / 'qaboard' / 'sample_project')
    self.assertEqual(check.status, OK)


class TestProjectChecks(TempDirTestCase):
  def test_entrypoint(self):
    from qaboard.doctor import check_project
    config = {'project': {'name': 'a/b', 'entrypoint': 'main.py'}}
    checks = list(check_project(Path('a/b'), Path('a/b'), Path('.'), config, self.tmp))
    self.assertEqual(statuses(checks), [OK, ERROR])
    self.assertIn("main.py doesn't exist", checks[1].message)
    write(self.tmp / 'main.py', "def run(context):\n  return {\n")
    checks = list(check_project(Path('a/b'), Path('a/b'), Path('.'), config, self.tmp))
    self.assertEqual(statuses(checks), [OK, ERROR])
    self.assertIn('syntax error', checks[1].message)
    write(self.tmp / 'main.py', "def run(context):\n  return {}\n")
    checks = list(check_project(Path('a/b/sub'), Path('a/b'), Path('sub'), config, self.tmp))
    self.assertEqual(statuses(checks), [OK, OK])
    self.assertIn('subproject sub of a/b', checks[0].message)
    checks = list(check_project(Path('a/b'), Path('a/b'), Path('.'), {'project': {}}, self.tmp))
    self.assertEqual(statuses(checks), [OK, ERROR])
    self.assertIn('entrypoint: qa/main.py', checks[1].fix)

  def test_batches_files(self):
    from qaboard.doctor import check_batches_files
    check = check_batches_files([], self.tmp)
    self.assertEqual(check.status, WARNING)
    self.assertIn('batches: qa/batches.yaml', check.fix)
    self.assertEqual(check_batches_files(['qa/batches.yaml'], self.tmp).status, ERROR)
    write(self.tmp / 'qa' / 'batches.yaml', "a: [\n")
    self.assertIn('not valid YAML', check_batches_files(['qa/batches.yaml'], self.tmp).message)
    write(self.tmp / 'qa' / 'batches.yaml', ".common: &common\n  configs: []\nsmoke:\n  inputs: [a]\nnightly:\n  inputs: [b]\n")
    check = check_batches_files(['qa/batches.yaml'], self.tmp)
    self.assertEqual(check.status, OK)
    self.assertIn('2 batches (smoke, nightly)', check.message)

  def test_git(self):
    from qaboard.doctor import check_git
    placeholder = '<local:alice>'
    self.assertEqual(check_git(True, 'a' * 40, 'main', False, placeholder).status, OK)
    check = check_git(False, placeholder, placeholder, False, placeholder)
    self.assertEqual(check.status, WARNING)
    self.assertIn('git init', check.fix)
    self.assertIn('git commit', check_git(True, placeholder, placeholder, False, placeholder).fix)
    self.assertIn('CI_COMMIT_SHA', check_git(False, None, None, True, placeholder).fix)

  def test_version(self):
    from qaboard.doctor import check_version
    with mock.patch.dict(os.environ, {'QABOARD_UPGRADE_COMMAND': 'pip install -U qaboard-site'}):
      check = check_version('1.1.1', '1.2.0', (3, 11, 4))
    self.assertEqual(check.status, WARNING)
    self.assertEqual(check.fix, 'pip install -U qaboard-site')
    self.assertEqual(check_version('1.2.0', '1.2.0', (3, 11, 4)).status, OK)
    self.assertEqual(check_version('1.3.0.dev1', '1.2.0', (3, 11, 4)).status, OK)
    self.assertIn('could not check', check_version('1.2.0', None, (3, 11, 4)).message)
    self.assertEqual(check_version('unknown', '1.2.0', (3, 11, 4)).status, OK)
    self.assertEqual(check_version('1.2.0', '1.2.0', (3, 8, 10)).status, WARNING)


class TestStorageChecks(TempDirTestCase):
  def test_test_dir(self):
    from qaboard.doctor import make_test_dir, remove_test_dir
    write(self.tmp / 'output' / 'kept', '')
    path, existing = make_test_dir({'command_id': 'abcdefgh-1', 'batch_dir': str(self.tmp / 'output' / 'a' / 'b')})
    self.assertEqual(path, self.tmp / 'output' / 'a' / 'b' / 'doctor' / 'abcdefgh')
    self.assertEqual(existing, self.tmp / 'output')
    write(path / 'result.txt', 'user: alice')
    remove_test_dir(path, existing)
    self.assertEqual(sorted(p.name for p in (self.tmp / 'output').iterdir()), ['kept'])

  def test_writable(self):
    from qaboard.doctor import check_folder
    before = sorted(os.listdir(self.tmp))
    check = check_folder("Results storage", self.tmp / 'a' / 'b', root=self.tmp)
    self.assertEqual(check.status, OK)
    self.assertIn('qa will create it', check.message)
    self.assertIn('writable', check.message)
    # nothing left behind
    self.assertEqual(sorted(os.listdir(self.tmp)), before)
    self.assertFalse((self.tmp / 'a').exists())

  def test_missing_root(self):
    from qaboard.doctor import check_folder
    root = self.tmp / 'missing'
    # qa can create it: maybe a shared drive isn't mounted
    check = check_folder("Results storage", root / 'project', root=root)
    self.assertEqual(check.status, WARNING)
    self.assertIn("qa will create it", check.message)
    self.assertFalse(root.exists())
    # it can't
    with mock.patch('qaboard.doctor.tempfile.mkstemp', side_effect=PermissionError(errno.EACCES, 'Permission denied')):
      check = check_folder("Results storage", root / 'project', root=root)
      self.assertEqual(check.status, ERROR)
      self.assertIn("doesn't exist, and qa can't create it", check.message)
      self.assertIn(f"mkdir -p {root}", check.fix)
      self.assertIn('export QA_STORAGE=', check.fix)
      self.assertIn('/docs/storage/where-is-the-data', check.fix)
      self.assertEqual(check_folder("Artifacts", root / 'project', root=root, required=False).status, WARNING)

  def test_not_writable(self):
    from qaboard.doctor import check_folder
    with mock.patch('qaboard.doctor.tempfile.mkstemp', side_effect=PermissionError(errno.EACCES, 'Permission denied')):
      check = check_folder("Results storage", self.tmp / 'x', root=self.tmp, purpose="Runs save their results there")
    self.assertEqual(check.status, ERROR)
    self.assertIn('permission denied', check.message)
    self.assertIn('Runs save their results there', check.message)
    self.assertIn(f'ls -ld {self.tmp}', check.fix)
    with mock.patch('qaboard.doctor.tempfile.mkstemp', side_effect=OSError(errno.ENOSPC, 'No space left on device')):
      check = check_folder("Results storage", self.tmp, root=self.tmp)
    self.assertIn('no space left', check.message)
    self.assertIn('du -sh', check.fix)

  def test_low_disk_space(self):
    from qaboard.doctor import check_folder
    with mock.patch('qaboard.doctor.shutil.disk_usage', return_value=mock.Mock(free=10 * 1024 ** 2)):
      check = check_folder("Results storage", self.tmp)
    self.assertEqual(check.status, WARNING)
    self.assertIn('10.0 MB free', check.message)

  def test_storage_setting(self):
    from qaboard.doctor import check_storage_setting
    with mock.patch.dict(os.environ):
      os.environ.pop('QA_STORAGE', None)
      check = check_storage_setting({}, Path('a/b'), Path('.'))
      self.assertEqual(check.status, ERROR)
      self.assertIn('linux: /mnt/qaboard', check.fix)
      check = check_storage_setting({'storage': {'nope': '/x'}}, Path('a/b'), Path('.'))
      self.assertIn('no path for this machine', check.message)
      self.assertIn('wrong', check_storage_setting({'storage': ['/a']}, Path('a/b'), Path('.')).message)
      # `qa doctor` doesn't raise, but check_storage_setting still sees it
      with mock.patch('qaboard.config.is_doctor_command', True):
        check = check_storage_setting({'storage': {'windows': '//x/y'}}, Path('a/b'), Path('.'))
      self.assertIn('no path for this machine', check.message)
      self.assertIsNone(check_storage_setting({'storage': {'linux': '/x', 'windows': '//x'}}, Path('a/b'), Path('.')))
      os.environ['QA_STORAGE'] = str(self.tmp)
      self.assertIsNone(check_storage_setting({}, Path('a/b'), Path('.')))

  def test_database(self):
    from qaboard.doctor import check_database
    self.assertEqual(check_database(self.tmp).status, OK)
    check = check_database(self.tmp / 'nope')
    self.assertEqual(check.status, ERROR)
    self.assertIn('qa --database', check.fix)
    write(self.tmp / 'file', '')
    self.assertEqual(check_database(self.tmp / 'file').status, ERROR)
    check = check_database(Path('.'), configured=False)
    self.assertEqual(check.status, WARNING)
    self.assertIn('inputs:\n  database:', check.fix)
    self.assertIn('(images)', check_database(self.tmp, 'images').name)


class TestServerChecks(unittest.TestCase):
  def test_unreachable(self):
    from qaboard.doctor import check_server
    get = FakeGet({'/api/v1/health': requests.ConnectionError('Connection refused')})
    with mock.patch('requests.get', get):
      check, site = check_server(server())
    self.assertIsNone(site)
    self.assertEqual(check.status, ERROR)
    self.assertIn('connection refused', check.message)
    self.assertIn(f'curl {SERVER}/api/v1/health', check.fix)
    # Without QABOARD_URL, we say how to set it
    with mock.patch('requests.get', get):
      check, _ = check_server(server(where=None))
    self.assertIn('export QABOARD_URL=', check.fix)
    self.assertIn('/docs/get-started/quickstart', check.fix)

  def test_untrusted_certificate(self):
    from qaboard.doctor import check_server
    get = FakeGet({'/api/v1/health': requests.exceptions.SSLError('CERTIFICATE_VERIFY_FAILED')})
    with mock.patch('requests.get', get):
      check, _ = check_server(server())
    self.assertIn('export QABOARD_API_VERIFY=', check.fix)

  def test_timeouts_are_short(self):
    from qaboard.doctor import check_server
    get = mock.Mock(side_effect=requests.Timeout())
    with mock.patch('requests.get', get):
      check, _ = check_server(server())
    self.assertIn('timed out', check.message)
    self.assertLessEqual(sum(get.call_args.kwargs['timeout']), 10)

  def test_database_down(self):
    from qaboard.doctor import check_server
    with mock.patch('requests.get', FakeGet({'/api/v1/health': response(503, {"status": "error", "database": "connection refused"})})):
      check, site = check_server(server())
    self.assertEqual(check.status, ERROR)
    self.assertIn('database', check.message)
    self.assertIn('QA-Board admins', check.fix)

  def test_not_qaboard(self):
    from qaboard.doctor import check_server
    with mock.patch('requests.get', FakeGet({})):
      check, site = check_server(server())
    self.assertEqual(check.status, ERROR)
    self.assertIn("not QA-Board's API", check.message)
    self.assertIn('Is QABOARD_URL right?', check.fix)

  def test_ok(self):
    from qaboard.doctor import check_server
    get = FakeGet({'/api/v1/health': response(200, {"status": "ok"}), '/api/v1/config': response(200, {"ingest_auth": "warn"})})
    with mock.patch('requests.get', get):
      check, site = check_server(server())
      self.assertEqual(check.status, OK)
      self.assertEqual(site, {"ingest_auth": "warn"})
      # an older server, without /health
      del get.routes['/api/v1/health']
      check, site = check_server(server())
      self.assertEqual(check.status, OK)
      # QABOARD_URL isn't set, but the default answers
      check, _ = check_server(server(where=None))
      self.assertEqual(check.status, WARNING)
      self.assertIn(f'export QABOARD_URL={SERVER}', check.fix)


ME = {"is_authenticated": True, "user_name": "alice", "token": {"prefix": "qab_pat_Xk3f", "scopes": ["read", "ingest", "act"], "projects": [], "expires_at": None}}


class TestSignIn(unittest.TestCase):
  def sign_in(self, token, site, me=None, token_source='QABOARD_TOKEN', ci=False, project='group/repo', **kwargs):
    from qaboard.doctor import check_sign_in
    with mock.patch('requests.get', FakeGet({'/api/v1/user/me/': me if me is not None else response(200, ME)})):
      checks, accepted = check_sign_in(server(), token, token_source, site, project, ci=ci, **kwargs)
    for check in checks:
      self.assertNotIn(TOKEN, f"{check.message} {check.fix}")
    return checks, accepted

  def test_no_token(self):
    checks, accepted = self.sign_in(None, {"ingest_auth": "off"})
    self.assertEqual(statuses(checks), [OK])
    self.assertFalse(accepted)
    checks, _ = self.sign_in(None, {"ingest_auth": "warn"})
    self.assertEqual(statuses(checks), [WARNING])
    self.assertIn('qa auth login', checks[0].fix)
    checks, _ = self.sign_in(None, {"ingest_auth": "token"})
    self.assertEqual(statuses(checks), [ERROR])
    # in CI there is no one to sign in
    checks, _ = self.sign_in(None, {"ingest_auth": "token"}, ci=True)
    self.assertIn('QABOARD_TOKEN', checks[0].fix)
    self.assertIn(f'{SERVER}/settings/tokens', checks[0].fix)
    self.assertNotIn('qa auth login', checks[0].fix)
    checks, _ = self.sign_in(None, {"require_sign_in": True})
    self.assertEqual(statuses(checks), [ERROR])

  def test_valid_token(self):
    checks, accepted = self.sign_in(TOKEN, {"ingest_auth": "token"})
    self.assertEqual(statuses(checks), [OK])
    self.assertTrue(accepted)
    self.assertIn('as alice', checks[0].message)
    self.assertIn('qab_pat_Xk3f...', checks[0].message)

  def test_refused_token(self):
    me = response(401, {"error": "This token was revoked.", "reason": "token_revoked"})
    checks, accepted = self.sign_in(TOKEN, {}, me=me)
    self.assertEqual(statuses(checks), [ERROR])
    self.assertFalse(accepted)
    self.assertIn('revoked', checks[0].message)
    self.assertIn('Replace $QABOARD_TOKEN', checks[0].fix)
    checks, _ = self.sign_in(TOKEN, {}, me=me, token_source='hosts.yaml')
    self.assertIn('qa auth login', checks[0].fix)
    # older servers answer 200 to tokens they don't know
    checks, _ = self.sign_in(TOKEN, {}, me=response(200, {"is_authenticated": False}))
    self.assertEqual(statuses(checks), [ERROR])
    self.assertIn('did not accept', checks[0].message)

  def test_token_scopes_and_projects(self):
    me = response(200, {**ME, "token": {**ME['token'], "scopes": ["read"], "projects": ["other/*"]}})
    checks, _ = self.sign_in(TOKEN, {"ingest_auth": "warn"}, me=me)
    self.assertEqual(statuses(checks), [OK, WARNING, WARNING])
    self.assertIn('Ingest scope', checks[1].message)
    self.assertIn(f'{SERVER}/settings/tokens', checks[1].fix)
    self.assertIn('not group/repo', checks[2].message)
    checks, _ = self.sign_in(TOKEN, {"ingest_auth": "token"}, me=me)
    self.assertEqual(statuses(checks), [OK, ERROR, ERROR])
    me = response(200, {**ME, "token": {**ME['token'], "projects": ["group/*"]}})
    self.assertEqual(statuses(self.sign_in(TOKEN, {}, me=me)[0]), [OK])

  def test_token_expiry(self):
    now = datetime.datetime(2026, 11, 2, tzinfo=datetime.timezone.utc)
    me = response(200, {**ME, "token": {**ME['token'], "expires_at": "2026-11-05T00:00:00Z"}})
    checks, _ = self.sign_in(TOKEN, {}, me=me, now=now)
    self.assertEqual(statuses(checks), [OK, WARNING])
    me = response(200, {**ME, "token": {**ME['token'], "expires_at": "2026-11-01T00:00:00Z"}})
    self.assertEqual(statuses(self.sign_in(TOKEN, {}, me=me, now=now)[0]), [OK, ERROR])
    # the fix depends on where the token comes from
    checks, _ = self.sign_in(TOKEN, {}, me=me, now=now, token_source='secrets.yaml')
    self.assertIn('qa auth login', checks[1].fix)
    self.assertNotIn('$secrets.yaml', checks[1].fix)
    checks, _ = self.sign_in(TOKEN, {}, me=me, now=now, token_source='QABOARD_TOKEN')
    self.assertIn('Replace $QABOARD_TOKEN', checks[1].fix)

  def test_token_matches_project(self):
    from qaboard.doctor import token_matches_project
    self.assertTrue(token_matches_project([], 'a/b'))
    self.assertTrue(token_matches_project(['a/b'], 'a/b/sub'))
    self.assertTrue(token_matches_project(['a/*'], 'a/b/sub'))
    self.assertFalse(token_matches_project(['a/bc'], 'a/b'))
    self.assertFalse(token_matches_project(['a/b'], None))


class TestProjectAccess(unittest.TestCase):
  def access(self, route, site=None):
    from qaboard.doctor import check_project_access
    get = FakeGet({'/api/v1/project/access': route})
    with mock.patch('requests.get', get):
      check = check_project_access(server(), TOKEN, 'hosts.yaml', 'group/repo', site or {"ingest_auth": "warn"}, ci=False)
    self.assertEqual(get.calls[0][2], {'project': 'group/repo'})
    return check

  def test_roles(self):
    self.assertEqual(self.access(response(200, {"my_role": "developer"})).status, OK)
    self.assertEqual(self.access(response(200, {"my_role": "owner"})).status, OK)
    check = self.access(response(200, {"my_role": "viewer", "owners": [{"name": "bob"}]}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('unverified', check.message)
    self.assertIn('Ask an owner (bob) of group/repo for the developer role', check.fix)
    self.assertIn(f'{SERVER}/group/repo/access', check.fix)
    check = self.access(response(200, {"my_role": None}), site={"ingest_auth": "token"})
    self.assertEqual(check.status, ERROR)
    self.assertIn("don't have a role", check.message)

  def test_refused(self):
    check = self.access(response(403, {"error": "You don't have access to group/repo.", "reason": "missing_role", "owners": [{"name": "bob"}]}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('developer role', check.fix)

  def test_older_server(self):
    self.assertEqual(self.access(response(404, text='Not Found')).status, SKIPPED)
    self.assertEqual(self.access(requests.ConnectionError()).status, SKIPPED)


class TestServerSeesStorage(unittest.TestCase):
  def sees(self, route, token=TOKEN):
    from qaboard.doctor import check_server_sees
    get = FakeGet({'/s/mnt/qaboard/': route})
    with mock.patch('requests.get', get):
      check = check_server_sees(server(), Path('/mnt/qaboard'), token)
    self.assertEqual(get.calls[0][1]['Accept'], 'application/json')
    return check

  def test_refusals(self):
    # the server can't read the folder: not about signing in
    check = self.sees(response(403, {"error": "The QA-Board server doesn't have the permissions to read /mnt/qaboard.", "reason": "permissions"}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('give the server read access', check.fix)
    check = self.sees(response(403, {"error": "Only some users can see the project a/b.", "reason": "forbidden"}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('Only some users', check.message)
    check = self.sees(response(401, {"error": "Sign in to see these files.", "reason": "login"}), token=None)
    self.assertEqual(check.status, SKIPPED)
    self.assertIn('qa auth login', check.message)
    check = self.sees(response(401, {"error": "Sign in to see these files.", "reason": "login"}))
    self.assertIn("didn't accept your token", check.message)

  def test_server_sees(self):
    self.assertEqual(self.sees(response(200, [{"name": "project"}])).status, OK)
    check = self.sees(response(403, {"error": "...", "reason": "not-listable"}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('QABOARD_STORAGE_ROOTS', check.fix)
    check = self.sees(response(404, {"error": "...", "reason": "not-found"}))
    self.assertEqual(check.status, WARNING)
    self.assertIn('mount it on the server at /mnt/qaboard', check.fix)
    self.assertEqual(self.sees(response(404, text='<title>nginx</title>')).status, SKIPPED)
    self.assertEqual(self.sees(response(401, {"error": "Sign in", "reason": "sign_in_required"})).status, SKIPPED)


class TestRunnerChecks(TempDirTestCase):
  def test_job_options(self):
    from qaboard.doctor import runner_job_options
    config = {'runners': {'lsf': {'queue': 'q', 'memory': 100}, 'local': {'concurrency': 2}, 'jenkins': {'build_url': 'http://j/job/x'}}}
    options = runner_job_options('lsf', config, Path('a/b'), 'alice', self.tmp, self.tmp, command_id='abcdefgh-1')
    self.assertEqual(options['type'], 'lsf')
    self.assertEqual(options['command_id'], 'abcdefgh-1')
    self.assertEqual((options['queue'], options['max_memory'], options['project'], options['user']), ('q', 100, 'a/b', 'alice'))
    self.assertEqual(options['batch_dir'], str(self.tmp))
    self.assertEqual(runner_job_options('local', config, None, 'alice', self.tmp, self.tmp)['concurrency'], 2)
    self.assertEqual(runner_job_options('local', config, None, 'alice', self.tmp, self.tmp, environ={'QA_BATCH_CONCURRENCY': '3'})['concurrency'], '3')
    self.assertEqual(runner_job_options('windows', config, None, 'alice', self.tmp, self.tmp)['build_url'], 'http://j/job/x')
    self.assertEqual(runner_job_options('dask', config, Path('a/b'), 'alice', self.tmp, self.tmp)['lsf'], {'project': 'a/b', 'queue': 'q'})
    self.assertTrue(runner_job_options('local', {}, None, 'alice', self.tmp, self.tmp)['command_id'])

  def test_unknown_runner(self):
    from qaboard.doctor import check_runner
    [check] = check_runner('lsff', {}, registry={'local': None, 'lsf': None})
    self.assertEqual(check.status, ERROR)
    self.assertIn('local, lsf', check.message)
    self.assertIn('default: local', check.fix)
    [check] = check_runner('jenkins', {}, registry={'windows': None})
    self.assertIn('named `windows`', check.fix)

  def test_runner_exceptions(self):
    from qaboard.doctor import check_runner
    class Broken:
      @classmethod
      def doctor(cls, job_options, test_job=False):
        yield Check("first", OK, "fine")
        raise RuntimeError("boom")
    checks = list(check_runner('broken', {}, registry={'broken': Broken}))
    self.assertEqual(statuses(checks), [OK, ERROR])
    self.assertIn('RuntimeError: boom', checks[1].message)
    class Empty:
      @classmethod
      def doctor(cls, job_options, test_job=False):
        return []
    self.assertEqual(statuses(check_runner('empty', {}, registry={'empty': Empty})), [SKIPPED])

  def test_all_runners_have_checks(self):
    from qaboard.doctor import check_runner
    from qaboard.runners import runners
    for name in ('local', 'lsf', 'celery', 'windows'):
      with self.subTest(name), mock.patch('requests.get', FakeGet({})), mock.patch('qaboard.runners.lsf.shutil.which', return_value=None):
        checks = list(check_runner(name, {'command_id': 'abcdefgh-1', 'cwd': str(self.tmp), 'batch_dir': str(self.tmp)}, registry=runners))
        self.assertTrue(checks)
        self.assertNotIn('failed unexpectedly', ' '.join(c.message for c in checks))


class TestLocalRunner(TempDirTestCase):
  def doctor(self, test_job=False, **job_options):
    from qaboard.runners.local import LocalRunner
    with mock.patch.dict(os.environ, {'QA_TESTING': 'true'}), mock.patch('os.cpu_count', return_value=4):
      return list(LocalRunner.doctor({'cwd': str(root_repo / 'qaboard' / 'sample_project'), **job_options}, test_job=test_job))

  def test_concurrency(self):
    self.assertIn('one run at a time', self.doctor()[0].message)
    self.assertIn('4 at the same time', self.doctor(concurrency=-1)[0].message)
    self.assertIn('3 at the same time', self.doctor(concurrency=-2)[0].message)
    self.assertEqual(self.doctor(concurrency=8)[0].status, WARNING)
    # like joblib: negative values count from the number of CPUs, at least 1
    from joblib import effective_n_jobs
    with mock.patch('os.cpu_count', return_value=4), mock.patch('joblib.parallel.cpu_count', return_value=4):
      self.assertEqual(effective_n_jobs(-10), 1)
    check = self.doctor(concurrency=-10)[0]
    self.assertEqual(check.status, OK)
    self.assertIn('1 at the same time', check.message)
    for invalid in (0, 'many', 'abc'):
      check = self.doctor(concurrency=invalid)[0]
      self.assertEqual(check.status, ERROR)
      self.assertIn('concurrency: -1', check.fix)
    self.assertEqual([c for c in self.doctor(timeout=-1) if 'timeout' in c.name][0].status, ERROR)
    self.assertEqual([c for c in self.doctor(timeout='abc') if 'timeout' in c.name][0].status, ERROR)

  def test_qa_on_path(self):
    from qaboard.runners.local import LocalRunner
    with mock.patch.dict(os.environ), mock.patch('qaboard.runners.local.shutil.which', return_value=None):
      os.environ.pop('QA_TESTING', None)
      checks = list(LocalRunner.doctor({}))
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn('pip install qaboard', checks[-1].fix)

  def test_test_job(self):
    checks = self.doctor(test_job=True)
    self.assertEqual(checks[-1].name, "Test job")
    self.assertEqual(checks[-1].status, OK, checks[-1].message)
    with mock.patch('qaboard.doctor.subprocess.run', return_value=subprocess.CompletedProcess('', 1, stdout='Traceback: ImportError')):
      checks = self.doctor(test_job=True)
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn('ImportError', checks[-1].message)


REAL_RUN = subprocess.run

def fake_lsf(bqueues='QUEUE_NAME PRIO STATUS\nnormal 30 Open:Active\n', bqueues_code=0, run_jobs=True, stat='DONE', bwait=0):
  """
  Replaces subprocess.run for LSF commands: bsub runs its script with bash, here (unless not `run_jobs`).
  `stat` is the jobs' status for bjobs -o stat, `bwait` bwait's exit code, or an exception it raises.
  """
  commands = []
  def run(command, shell=True, **kwargs):
    commands.append(command)
    if 'bsub' in command:
      if run_jobs:
        script = command.split('<< "EOF"\n', 1)[1].rsplit('\nEOF', 1)[0]
        REAL_RUN(['bash', '-c', script], check=True)
      return subprocess.CompletedProcess(command, 0, stdout='Job <1> is submitted', stderr='')
    if 'bqueues' in command:
      return subprocess.CompletedProcess(command, bqueues_code, stdout=bqueues if bqueues_code == 0 else 'nope: No such queue', stderr='')
    if 'bjobs' in command and '-o "stat"' in command:
      return subprocess.CompletedProcess(command, 0, stdout=f'{stat}\n', stderr='')
    if 'bjobs' in command:
      return subprocess.CompletedProcess(command, 0, stdout='No unfinished job found\n', stderr='')
    if 'bwait' in command:
      if isinstance(bwait, BaseException):
        raise bwait
      return subprocess.CompletedProcess(command, bwait, stdout='', stderr='')
    return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
  run.commands = commands
  return run


@unittest.skipIf(os.name == 'nt', "LSF")
class TestLsfRunner(TempDirTestCase):
  def doctor(self, run, which=lambda name: f'/usr/bin/{name}', test_job=False, **job_options):
    from qaboard.runners.lsf import LsfRunner
    # the batch's folder doesn't exist yet: the test job creates it, then removes it
    options = {'command_id': 'abcdefgh-1234', 'batch_dir': str(self.tmp / 'output' / 'batch'), **job_options}
    with mock.patch('qaboard.runners.lsf.shutil.which', side_effect=which), mock.patch('qaboard.runners.lsf.subprocess.run', run), \
         mock.patch('qaboard.doctor.subprocess.run', run), mock.patch('qaboard.runners.lsf.time.sleep'), mock.patch('qaboard.runners.lsf.secho'):
      return list(LsfRunner.doctor(options, test_job=test_job))

  def test_no_bsub(self):
    checks = self.doctor(fake_lsf(), which=lambda name: None)
    self.assertEqual(statuses(checks), [ERROR])
    self.assertIn('profile.lsf', checks[0].fix)
    self.assertIn('--runner local', checks[0].fix)

  def test_no_bwait(self):
    checks = self.doctor(fake_lsf(), which=lambda name: None if name == 'bwait' else f'/usr/bin/{name}')
    self.assertEqual(checks[1].status, WARNING)
    self.assertIn('--no-wait', checks[1].fix)

  def test_queue(self):
    run = fake_lsf()
    checks = self.doctor(run, queue='normal')
    self.assertEqual(statuses(checks), [OK, OK, OK])
    self.assertIn("bqueues -w normal", run.commands[0])
    checks = self.doctor(fake_lsf(bqueues_code=255), queue='nope')
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn("no LSF queue named 'nope'", checks[-1].message)
    self.assertIn('queue: <queue>', checks[-1].fix)
    checks = self.doctor(fake_lsf(bqueues='QUEUE_NAME PRIO STATUS\nnormal 30 Closed:Active\n'), queue='normal')
    [queue] = [c for c in checks if c.name == "LSF queue"]
    self.assertEqual(queue.status, ERROR)
    self.assertIn('closed', queue.message)

  def test_lsf_hangs(self):
    run = mock.Mock(side_effect=subprocess.TimeoutExpired('bqueues', 20))
    checks = self.doctor(run)
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn("didn't answer", checks[-1].message)

  def test_bridge(self):
    run = fake_lsf()
    checks = self.doctor(run, which=lambda name: None, bridge='ssh lsf-host {bsub_command}')
    self.assertEqual(statuses(checks), [OK, OK, OK])
    self.assertTrue(run.commands[0].startswith('ssh lsf-host bqueues'))
    checks = self.doctor(run, which=lambda name: None, bridge='ssh {host} {bsub_command}')
    self.assertEqual(statuses(checks), [ERROR])
    self.assertIn('{bsub_command}', checks[0].fix)
    self.assertEqual(statuses(self.doctor(run, which=lambda name: None, bridge='ssh lsf-host')), [ERROR])

  def test_test_job(self):
    run = fake_lsf()
    with mock.patch.dict(os.environ, {'PATH': os.pathsep.join(['/usr/bin', '/bin'])}):
      checks = self.doctor(run, test_job=True, queue='normal')
    self.assertEqual(checks[-1].name, "LSF test job")
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn("`qa` isn't on its PATH", checks[-1].message)
    # nothing left behind
    self.assertEqual(list(self.tmp.iterdir()), [])
    with tempfile.TemporaryDirectory() as bin_dir:
      qa = Path(bin_dir) / 'qa'
      qa.write_text('#!/bin/sh\n')
      qa.chmod(0o755)
      with mock.patch.dict(os.environ, {'PATH': os.pathsep.join([bin_dir, '/usr/bin', '/bin'])}):
        checks = self.doctor(run, test_job=True, queue='normal')
    self.assertEqual(checks[-1].status, OK, checks[-1].message)
    self.assertIn(f'found {qa}', checks[-1].message)

  def test_test_job_without_bwait(self):
    # we poll bjobs instead
    run = fake_lsf()
    checks = self.doctor(run, which=lambda name: None if name == 'bwait' else f'/usr/bin/{name}', test_job=True)
    self.assertEqual(checks[-1].name, "LSF test job")
    self.assertIn('ran on', checks[-1].message)
    self.assertFalse(any('bwait' in c for c in run.commands))
    self.assertTrue(any('bjobs -a -noheader -o "stat" -J "abcdefgh_doctor"' in c for c in run.commands))
    self.assertFalse(any('bkill' in c for c in run.commands))
    self.assertEqual(list(self.tmp.iterdir()), [])

  def test_test_job_never_ends(self):
    from qaboard.runners.lsf import LsfRunner
    run = fake_lsf(run_jobs=False, stat='PEND', bwait=255)
    options = {'command_id': 'abcdefgh-1234', 'batch_dir': str(self.tmp / 'batch')}
    with mock.patch('qaboard.runners.lsf.subprocess.run', run), mock.patch('qaboard.doctor.subprocess.run', run), \
         mock.patch('qaboard.runners.lsf.time.sleep'), mock.patch('qaboard.runners.lsf.secho'), mock.patch('qaboard.runners.lsf.shutil.which', return_value='/usr/bin/bsub'):
      checks = list(LsfRunner.doctor_test_job(options, lambda c: c, use_bwait=True, timeout=0))
      self.assertEqual(checks[-1].status, WARNING)
      self.assertIn("didn't end", checks[-1].message)
      self.assertIn('bkill -J "abcdefgh_doctor"', run.commands[-1])
      self.assertEqual(list(self.tmp.iterdir()), [])
      # Ctrl-C while waiting: the job is stopped too
      run = fake_lsf(run_jobs=False, bwait=KeyboardInterrupt())
      with mock.patch('qaboard.runners.lsf.subprocess.run', run), self.assertRaises(KeyboardInterrupt):
        list(LsfRunner.doctor_test_job(options, lambda c: c, use_bwait=True))
      self.assertIn('bkill -J "abcdefgh_doctor"', run.commands[-1])
      self.assertEqual(list(self.tmp.iterdir()), [])
    self.assertTrue(any('bwait -w "ended(abcdefgh_doctor)"' in c for c in run.commands))
    self.assertEqual(list(self.tmp.iterdir()), [])

  def test_test_job_not_visible(self):
    # The job runs elsewhere, and doesn't see the batch's folder
    def run(command, **kwargs):
      return subprocess.CompletedProcess(command, 0, stdout='No unfinished job found' if 'bjobs' in command else '', stderr='')
    checks = self.doctor(run, test_job=True)
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn('same path', checks[-1].message)
    self.assertEqual(list(self.tmp.iterdir()), [])


class TestCeleryRunner(unittest.TestCase):
  def test_not_installed(self):
    from qaboard.runners.celery import CeleryRunner
    with mock.patch.dict(sys.modules, {'celery': None}):
      checks = list(CeleryRunner.doctor({}))
    self.assertEqual(statuses(checks), [ERROR])
    self.assertIn('pip install celery', checks[0].fix)

  def test_broker_password_not_set(self):
    from qaboard.runners.celery import check_broker
    check = check_broker('pyamqp://camera:${QA_CELERY_PASSWORD}@qaboard:5672/camera', 'runners.celery.broker_url in qaboard.yaml', 'docs')
    self.assertEqual(check.status, ERROR)
    self.assertIn('export QA_CELERY_PASSWORD=', check.fix)

  def test_queue(self):
    from qaboard.runners.celery import runs_queue
    self.assertEqual(runs_queue({}), 'celery')
    self.assertEqual(runs_queue({'task_default_queue': 'q'}), 'q')
    self.assertEqual(runs_queue({'task_routes': {'qaboard': 'gpu'}}), 'gpu')
    self.assertEqual(runs_queue({'task_routes': {'qa*': {'queue': 'gpu'}}}), 'gpu')
    self.assertEqual(runs_queue({'qaboard_task_name': 'mine', 'task_routes': [{'qaboard': 'gpu'}, {'mine': 'cpu'}]}), 'cpu')

  def test_mask_password(self):
    from qaboard.doctor import mask_url_password
    self.assertEqual(mask_url_password('pyamqp://camera:secret@qaboard:5672/camera'), 'pyamqp://camera:****@qaboard:5672/camera')
    self.assertEqual(mask_url_password('redis://qaboard:6379'), 'redis://qaboard:6379')
    # kombu's failover brokers
    masked = mask_url_password('pyamqp://a:secret1@h1//;pyamqp://b:secret2@h2//')
    self.assertEqual(masked, 'pyamqp://a:****@h1//;pyamqp://b:****@h2//')
    masked = mask_url_password('sqs://host/?password=secret&region=eu;redis://h/?token=secret2')
    self.assertNotIn('secret', masked)
    self.assertIn('region=eu', masked)
    self.assertEqual(mask_url_password('https://alice:11a2b3@jenkins.example/job/x'), 'https://alice:****@jenkins.example/job/x')


class TestJenkinsRunner(TempDirTestCase):
  def doctor(self, get=None, env=None, **job_options):
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner
    with mock.patch.dict(os.environ, env or {}), mock.patch('requests.get', get or FakeGet({})):
      for name in ('QA_RUNNERS_JENKINS_BUILD_URL', 'QA_RUNNERS_JENKINS_TOKEN'):
        if name not in (env or {}):
          os.environ.pop(name, None)
      return list(JenkinsWindowsRunner.doctor({'cwd': '/home/alice/project', **job_options}))

  def test_not_configured(self):
    checks = self.doctor()
    self.assertEqual(statuses(checks), [ERROR])
    self.assertIn('build_url:', checks[0].fix)
    self.assertIn('/docs/jenkins-integration', checks[0].fix)
    checks = self.doctor(env={'QA_RUNNERS_JENKINS_TOKEN': '1234'}, build_url='http://j/job/x')
    self.assertIn('ignores qaboard.yaml', checks[0].message)
    self.assertEqual(statuses(self.doctor(build_url='jenkins/job/x')), [ERROR])

  def test_configured(self):
    url = 'https://jenkins.example/job/team/job/WindowsExecutor'
    get = FakeGet({'/job/team/job/WindowsExecutor/api/json': response(403, {})})
    checks = self.doctor(get, build_url=url, token='1234')
    self.assertEqual([c.name for c in checks], ['Jenkins job', 'Jenkins', 'Windows paths'])
    self.assertEqual(statuses(checks)[:2], [OK, OK])
    self.assertNotIn('1234', ' '.join(f"{c.message} {c.fix}" for c in checks))
    # no mapping for /home/alice/project
    self.assertEqual(checks[2].status, WARNING)
    self.assertIn('QABOARD_PATH_MAPPINGS', checks[2].fix)
    checks = self.doctor(FakeGet({}), build_url=url)
    self.assertEqual(statuses(checks)[:3], [OK, WARNING, ERROR])
    self.assertIn('no such job', checks[2].message)
    checks = self.doctor(FakeGet({'/job/team/job/WindowsExecutor/api/json': requests.ConnectionError()}), build_url=url, token='1')
    self.assertEqual(checks[1].status, WARNING)

  def test_credentials_in_url(self):
    url = 'https://alice:jenkinsapitoken@jenkins.example/job/team/job/WindowsExecutor'
    for get in (FakeGet({}), FakeGet({'/job/team/job/WindowsExecutor/api/json': requests.ConnectionError()}), FakeGet({'/job/team/job/WindowsExecutor/api/json': response(500, {})})):
      checks = self.doctor(get, build_url=url, token='1')
      self.assertNotIn('jenkinsapitoken', ' '.join(f"{c.message} {c.fix}" for c in checks))
    checks = self.doctor(build_url='ftp://alice:jenkinsapitoken@x')
    self.assertNotIn('jenkinsapitoken', checks[0].message)

  def test_test_build_still_running(self):
    from qaboard.runners.jenkins_windows import JenkinsWindowsRunner
    options = {'command_id': 'abcdefgh-1', 'batch_dir': str(self.tmp / 'batch')}
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={'web_url': 'https://j/job/x/12/'}), \
         mock.patch('qaboard.runners.jenkins_windows._poll_jenkins_status', return_value='running'):
      checks = list(JenkinsWindowsRunner.doctor_test_job(options))
    self.assertEqual(checks[-1].status, WARNING)
    self.assertIn('still running', checks[-1].message)
    self.assertIn('https://j/job/x/12/', checks[-1].message)
    # the build may still write there
    self.assertTrue((self.tmp / 'batch' / 'doctor' / 'abcdefgh' / 'run.bat').exists())
    self.assertIn('rm -r', checks[-1].fix)
    with mock.patch('qaboard.runners.jenkins_windows.trigger_run', return_value={'web_url': 'https://j/job/x/12/'}), \
         mock.patch('qaboard.runners.jenkins_windows._poll_jenkins_status', return_value='failure'):
      checks = list(JenkinsWindowsRunner.doctor_test_job(options))
    self.assertIn('ended as failure', checks[-1].message)
    self.assertFalse((self.tmp / 'batch' / 'doctor' / 'abcdefgh').exists())


class TestConfigLoading(unittest.TestCase):
  """qaboard.config doesn't fail on a broken qaboard.yaml for `qa doctor`, and only for it"""
  def test_invoked_command(self):
    from qaboard.config import invoked_command
    self.assertEqual(invoked_command(['qa', 'doctor']), 'doctor')
    self.assertEqual(invoked_command(['qa', '--share', '--label', 'doctor', 'batch', 'doctor']), 'batch')
    self.assertEqual(invoked_command(['qa', '-c', 'base', '--offline', 'doctor', '--runner', 'lsf']), 'doctor')
    self.assertEqual(invoked_command(['qa', '--config=base', 'doctor']), 'doctor')
    self.assertIsNone(invoked_command(['qa', '--help']))

  def test_unloadable_config(self):
    from qaboard.config import unloadable_config
    path = Path('/x/qaboard.yaml')
    self.assertIsNone(unloadable_config([({'project': {'name': 'a/b', 'url': 'u'}}, path)]))
    self.assertIn('project.name', unloadable_config([({'project': {'name': 'a/b'}}, path)]))
    self.assertIn('not a mapping', unloadable_config([(['a'], path)]))  # type: ignore
    self.assertIn('not a mapping', unloadable_config([({'project': {'name': 'a/b', 'url': 'u'}}, path), ({'project': 'x'}, Path('/x/sub/qaboard.yaml'))]))

  def test_is_qa_program(self):
    from qaboard.config import is_qa_program
    self.assertTrue(is_qa_program(['qa', 'doctor']))
    self.assertTrue(is_qa_program(['/venv/bin/qa', 'doctor']))
    self.assertTrue(is_qa_program(['C:\\venv\\Scripts\\qa.exe' if os.name == 'nt' else '/venv/bin/qa-script.py', 'doctor']))
    self.assertTrue(is_qa_program([str(root_repo / 'qaboard' / '__main__.py'), 'doctor']))
    # other programs that import qaboard
    self.assertFalse(is_qa_program(['/usr/bin/my-tool', 'doctor']))
    self.assertFalse(is_qa_program(['/x/other/__main__.py', 'doctor']))
    self.assertFalse(is_qa_program([]))

  def test_invalid_settings(self):
    from qaboard.config import invalid_settings, drop_invalid_settings
    config = {
      'project': {'name': 'a/b'}, 'inputs': {'batches': 3, 'database': '/x', 'types': {'images': {}}}, 'storage': ['/a'],
      'runners': {'default': 'local', 'local': 'fast', 'lsf': {'queue': 'q'}}, 'outputs': None,
    }
    self.assertEqual(sorted('.'.join(k) for k, _, _ in invalid_settings(config)), ['inputs.batches', 'runners.local', 'storage'])
    self.assertEqual(invalid_settings({'runners': ['local', 'lsf']})[0][0], ('runners',))
    self.assertEqual(invalid_settings({'inputs': {'batches': ['a.yaml', 3]}})[0][0], ('inputs', 'batches'))
    drop_invalid_settings(config)
    self.assertEqual(config['inputs'], {'database': '/x', 'types': {'images': {}}})
    self.assertEqual(config['runners'], {'default': 'local', 'lsf': {'queue': 'q'}})
    self.assertNotIn('storage', config)

  def test_guarded(self):
    from qaboard.doctor import guarded
    def checks():
      yield Check("first", OK, "fine")
      raise TypeError("unhashable type: 'list'")
    result = list(guarded("Storage", checks))
    self.assertEqual(statuses(result), [OK, ERROR])
    self.assertIn("TypeError: unhashable type: 'list'", result[1].message)

  def test_unreadable_entrypoint(self):
    from qaboard.doctor import check_project
    with tempfile.TemporaryDirectory() as tmp:
      write(Path(tmp) / 'main.py', 'def run(context): pass\n')
      with mock.patch('pathlib.Path.read_text', side_effect=PermissionError(errno.EACCES, 'Permission denied')):
        checks = list(check_project(Path('a/b'), Path('a/b'), Path('.'), {'project': {'entrypoint': 'main.py'}}, Path(tmp)))
    self.assertEqual(checks[-1].status, ERROR)
    self.assertIn("can't read main.py", checks[-1].message)
    # check_config says that it must be a path
    self.assertEqual(len(list(check_project(Path('a/b'), Path('a/b'), Path('.'), {'project': {'entrypoint': ['a']}}, Path(tmp)))), 1)

  def test_config_types(self):
    from qaboard.doctor import check_config
    with tempfile.TemporaryDirectory() as tmp:
      write(Path(tmp) / 'qaboard.yaml', VALID_CONFIG.replace('entrypoint: main.py', 'entrypoint: [a]') + "runners: [local, lsf]\ninputs:\n  batches: 3\n")
      [check] = check_config(Path(tmp))
    self.assertEqual(check.status, ERROR)
    for setting in ('runners must be a mapping', 'inputs.batches must be a path or text or a list of paths', 'project.entrypoint must be a path'):
      self.assertIn(setting, check.message)


class TestCli(TempDirTestCase):
  """`qa doctor` on the sample project, and in a folder without project"""
  @classmethod
  def setUpClass(cls):
    cls.previous_cwd = os.getcwd()
    cls.previous_argv = sys.argv

  @classmethod
  def tearDownClass(cls):
    # the other tests expect qaboard.config as when they started
    os.chdir(cls.previous_cwd)
    sys.argv = cls.previous_argv
    reload(import_module('qaboard.config'))
    reload(import_module('qaboard.qa'))

  def doctor(self, cwd, *args, env=None):
    from qaboard.auth import Server
    os.chdir(cwd)
    # outside CI unless a test says otherwise (CI sets CI=true, which changes where results go)
    environ = {'QA_TESTING': 'true', 'QA_OFFLINE': '', 'QA_STORAGE': str(self.tmp / 'storage'), 'QA_DATABASE': '', 'CI': '', 'GIT_COMMIT': '', **(env or {})}
    with mock.patch.dict(os.environ, environ), mock.patch.object(sys, 'argv', ['qa', *args]):
      for name in [k for k, v in environ.items() if not v]:
        del os.environ[name]
      reload(import_module('qaboard.config'))
      reload(import_module('qaboard.qa'))
      import qaboard
      qaboard = reload(qaboard)
      # nothing listens on port 1
      unreachable = Server('http://127.0.0.1:1', 'http://127.0.0.1:1/api/v1', '$QABOARD_URL')
      with mock.patch('qaboard.auth.server_api', return_value=unreachable), mock.patch('qaboard.doctor.latest_version', return_value=None):
        result = CliRunner().invoke(qaboard.qa, list(args), obj={}, color=False)
    if result.exception and not isinstance(result.exception, SystemExit):
      raise result.exception
    # `qa` always asks for colors
    result.output_text = click.unstyle(result.output)
    return result

  def test_help(self):
    result = self.doctor(root_repo / 'qaboard' / 'sample_project', 'doctor', '--help')
    self.assertEqual(result.exit_code, 0)
    self.assertIn('--test-job', result.output_text)
    self.assertIn('--runner', result.output_text)

  def test_sample_project(self):
    result = self.doctor(root_repo / 'qaboard' / 'sample_project', 'doctor')
    self.assertEqual(result.exit_code, 1, result.output_text)
    self.assertIn('✔ qaboard.yaml', result.output_text)
    self.assertIn('✔ Project: user/sample_project', result.output_text)
    self.assertIn("✘ QA-Board server: Can't reach QA-Board at http://127.0.0.1:1", result.output_text)
    self.assertIn('curl http://127.0.0.1:1/api/v1/health', result.output_text)
    self.assertIn(f'Results storage: The storage folder {self.tmp / "storage"} doesn\'t exist: qa will create it', result.output_text)
    self.assertIn('Runner: local', result.output_text)
    self.assertIn('1 problem to fix', result.output_text)
    # it changes nothing: it doesn't even create the storage
    self.assertFalse((self.tmp / 'storage').exists())
    (self.tmp / 'storage').mkdir()
    result = self.doctor(root_repo / 'qaboard' / 'sample_project', 'doctor')
    self.assertIn(f'Results storage: {self.tmp / "storage"}', result.output_text)
    self.assertIn('writable', result.output_text)
    self.assertEqual(list((self.tmp / 'storage').iterdir()), [])

  def assert_reports(self, result, *texts):
    """`qa doctor` reports problems, and doesn't crash on them"""
    self.assertEqual(result.exit_code, 1, result.output_text)
    self.assertNotIn('qa doctor failed to check', result.output_text)
    for text in texts:
      self.assertIn(text, result.output_text)

  def project(self, config: str, folder='project') -> Path:
    write(self.tmp / folder / 'qaboard.yaml', config)
    write(self.tmp / folder / 'main.py', 'def run(context):\n  return {}\n')
    return self.tmp / folder

  @unittest.skipIf(os.name == 'nt', "linux paths")
  def test_storage_without_a_path_for_this_machine(self):
    project = self.project(VALID_CONFIG.replace('storage: /tmp\n', 'storage:\n  windows: //x/y\n'))
    result = self.doctor(project, 'doctor', env={'QA_STORAGE': ''})
    self.assert_reports(result, "The storage setting has no path for this machine (linux)")

  def test_wrong_settings(self):
    for name, config in [
      ('runners list', "runners: [local, lsf]\n"),
      ('runner settings', "runners:\n  local: fast\n"),
      ('batches', "inputs:\n  batches: 3\n"),
      ('storage list', "storage: ['/a']\n"),
    ]:
      with self.subTest(name):
        project = self.project(VALID_CONFIG.replace('storage: /tmp\n', '') + config, folder=name.replace(' ', '-'))
        self.assert_reports(self.doctor(project, 'doctor', env={'QA_STORAGE': ''}), "qa can't use these settings")
    project = self.project(VALID_CONFIG.replace('entrypoint: main.py', 'entrypoint: [a]'), folder='entrypoint')
    self.assert_reports(self.doctor(project, 'doctor'), "project.entrypoint must be a path")

  def test_wrong_environment(self):
    project = self.project(VALID_CONFIG + "runners:\n  local: {}\n")
    result = self.doctor(project, 'doctor', '--runner', 'local', env={'QA_BATCH_CONCURRENCY': 'abc', 'QA_BATCH_TIMEOUT': 'abc'})
    self.assert_reports(result, "concurrency: 'abc' isn't valid", "timeout: 'abc' isn't valid")
    result = self.doctor(project, '--type', 'nope', 'doctor')
    self.assert_reports(result, "There is no input type named 'nope'")

  def test_subproject_changes_the_project(self):
    self.project(VALID_CONFIG)
    write(self.tmp / 'project' / 'sub' / 'qaboard.yaml', "project:\n  url: https://git.example/other\n")
    result = self.doctor(self.tmp / 'project' / 'sub', 'doctor')
    self.assert_reports(result, "changes project.url", "Remove project.url from")

  def test_outside_git(self):
    (self.tmp / 'storage').mkdir()
    result = self.doctor(self.project(VALID_CONFIG), 'doctor')
    self.assertIn('Not in a git repository', result.output_text)
    self.assertIn(f"`qa --share` saves results in {self.tmp / 'project'}, not in the storage ({self.tmp / 'storage'})", result.output_text)
    self.assertIn(f"Results storage: {self.tmp / 'storage'}, writable", result.output_text)

  def test_offline(self):
    result = self.doctor(root_repo / 'qaboard' / 'sample_project', '--offline', 'doctor', '--runner', 'local')
    self.assertEqual(result.exit_code, 0, result.output_text)
    self.assertIn('--offline', result.output_text)
    self.assertIn('qa batch my-batch', result.output_text)

  def test_unknown_runner(self):
    result = self.doctor(root_repo / 'qaboard' / 'sample_project', '--offline', 'doctor', '--runner', 'nope')
    self.assertEqual(result.exit_code, 1)
    self.assertIn("There is no runner named 'nope'", result.output_text)

  def test_outside_a_project(self):
    result = self.doctor(self.tmp, 'doctor')
    self.assertEqual(result.exit_code, 1)
    self.assertIn('No qaboard.yaml', result.output_text)
    self.assertIn('qa init', result.output_text)

  def test_broken_config(self):
    write(self.tmp / 'qaboard.yaml', "project:\n  name: a/b\n url: x\n")
    result = self.doctor(self.tmp, 'doctor')
    self.assertEqual(result.exit_code, 1)
    self.assertIn('not valid YAML', result.output_text)
    write(self.tmp / 'qaboard.yaml', "project:\n  name: a/b\n")
    result = self.doctor(self.tmp, 'doctor')
    self.assertIn('needs project.url', result.output_text)


class TestDocsLinks(unittest.TestCase):
  def test_docs_pages_exist(self):
    """The docs pages the fixes link to exist"""
    import re
    docs_dir = root_repo / 'website' / 'docs'
    if not docs_dir.exists():
      self.skipTest("no website/ in this checkout")
    ids = set()
    for path in docs_dir.rglob('*.md*'):
      match = re.search(r'^id:\s*(\S+)', path.read_text(encoding='utf-8'), re.MULTILINE)
      folder = path.parent.relative_to(docs_dir).as_posix()
      page_id = match.group(1) if match else path.stem
      ids.add(page_id if folder == '.' else f"{folder}/{page_id}")
    sources = [root_repo / 'qaboard' / 'doctor.py', *[root_repo / 'qaboard' / 'runners' / f for f in ('local.py', 'lsf.py', 'celery.py', 'jenkins_windows.py')]]
    linked = set()
    for source in sources:
      text = source.read_text()
      linked.update(re.findall(r"docs\('([^'#]+)", text))
      linked.update(re.findall(r"samsung\.github\.io/qaboard/docs/([\w/-]+)", text))
    self.assertTrue(linked)
    self.assertEqual(sorted(linked - ids), [])


if __name__ == '__main__':
  unittest.main()
