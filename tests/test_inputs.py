"""
Tests for qaboard/inputs.py (`qaboard.inputs.add`, `qa inputs add`), with the server faked: requests get the answers
of POST /api/v1/inputs (docs/design/inputs-and-collections.md).
"""
import json
import os
import tempfile
import unittest
from importlib import import_module, reload
from pathlib import Path
from unittest import mock

import click
import requests
from click.testing import CliRunner

ROOT = Path(__file__).resolve().parent.parent
SERVER = 'http://qaboard.example.com'


def response(status, body):
  r = requests.Response()
  r.status_code = status
  r._content = json.dumps(body).encode()
  r.headers['Content-Type'] = 'application/json'
  r.url = f"{SERVER}/api/v1/inputs"
  return r


class FakeServer:
  """Answers POST /inputs like the real endpoint: ids by (database, path), `new` the first time. Keeps the requests."""
  def __init__(self, status=200):
    self.status = status
    self.requests = []
    self.ids = {}

  def __call__(self, method, url, params=None, headers=None, json=None, **kwargs):
    self.requests.append({"method": method, "url": url, "json": json, "headers": dict(headers or {})})
    if self.status != 200:
      return response(self.status, {"error": "Forbidden", "reason": "missing_role"})
    answer = []
    for item in json['inputs']:
      key = (item['database'], item['path'])
      new = key not in self.ids
      self.ids.setdefault(key, len(self.ids) + 1)
      answer.append({"id": self.ids[key], "database": key[0], "path": key[1], "new": new})
    added = sum(1 for i in answer if i['new'])
    return response(200, {"inputs": answer, "added": added, "known": len(answer) - added})

  def patch(self):
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_'))}
    environ.update({'QABOARD_URL': SERVER, 'QABOARD_TOKEN': 'qab_secret'})
    patches = [mock.patch('requests.Session.request', side_effect=self), mock.patch.dict(os.environ, environ, clear=True)]
    for p in patches:
      p.start()
    return patches


class FakeServerTestCase(unittest.TestCase):
  def serve(self, status=200):
    server = FakeServer(status)
    for p in server.patch():
      self.addCleanup(p.stop)
    return server


class TestAdd(FakeServerTestCase):
  def test_adds_paths_of_a_database(self):
    import qaboard
    server = self.serve()
    added = qaboard.inputs.add(['night/1.raw', Path('night/2.raw')], database='/mnt/data', project='group/repo', metadata={"sensor": "imx766"})
    request, = server.requests
    self.assertEqual((request['method'], request['url']), ('POST', f"{SERVER}/api/v1/inputs"))
    self.assertEqual(request['json'], {"project": "group/repo", "inputs": [
      {"database": "/mnt/data", "path": "night/1.raw", "metadata": {"sensor": "imx766"}},
      {"database": "/mnt/data", "path": "night/2.raw", "metadata": {"sensor": "imx766"}},
    ]})
    self.assertIn('qab_secret', request['headers'].get('Authorization', ''))
    self.assertEqual((len(added), added.added, added.known), (2, 2, 0))
    self.assertEqual([(i.id, i.database, i.path) for i in added], [(1, '/mnt/data', 'night/1.raw'), (2, '/mnt/data', 'night/2.raw')])
    # again: known
    again = qaboard.inputs.add(['night/1.raw'], database='/mnt/data', project='group/repo')
    self.assertEqual((again.added, again.known), (0, 1))

  def test_kinds_of_inputs(self):
    from qaboard.inputs import as_input
    self.assertEqual(as_input('/mnt/data/night/1.raw', '/mnt/data'), {"database": "/mnt/data", "path": "night/1.raw", "metadata": None})
    # outside the database, or without one: under /, like `qa batch` finds absolute paths
    self.assertEqual(as_input('/other/1.raw', '/mnt/data'), {"database": "/", "path": "other/1.raw", "metadata": None})
    self.assertEqual(as_input('/other/1.raw'), {"database": "/", "path": "other/1.raw", "metadata": None})
    self.assertEqual(as_input(('/mnt/data', 'a.raw')), {"database": "/mnt/data", "path": "a.raw", "metadata": None})
    self.assertEqual(as_input({"path": "a.raw", "metadata": {"lux": 3}}, '/d', {"sensor": "x"}),
                     {"database": "/d", "path": "a.raw", "metadata": {"sensor": "x", "lux": 3}})
    from qaboard.input_collections import CollectionError
    with self.assertRaises(CollectionError):
      as_input('relative/without/database.raw')
    with self.assertRaises(CollectionError):
      as_input(42)

  def test_chunks(self):
    import qaboard
    server = self.serve()
    with mock.patch('qaboard.inputs.CHUNK', 2):
      added = qaboard.inputs.add([f'{i}.raw' for i in range(5)], database='/d', project='group/repo')
    self.assertEqual([len(r['json']['inputs']) for r in server.requests], [2, 2, 1])
    self.assertEqual(added.added, 5)

  def test_refused(self):
    import qaboard
    from qaboard.input_collections import CollectionError
    self.serve(status=403)
    with self.assertRaises(CollectionError) as e:
      qaboard.inputs.add(['a.raw'], database='/d', project='group/repo')
    self.assertEqual(e.exception.status, 403)
    self.assertIn('could not add inputs to group/repo', str(e.exception))

  def test_nothing_to_add(self):
    import qaboard
    server = self.serve()
    self.assertEqual(len(qaboard.inputs.add([], project='group/repo')), 0)
    self.assertEqual(server.requests, [])


class TestCommand(FakeServerTestCase):
  """`qa inputs add` adds the inputs `qa batch` would run on, in the sample project"""
  def setUp(self):
    previous_cwd = os.getcwd()
    os.chdir(ROOT / 'qaboard/sample_project')
    self.addCleanup(os.chdir, previous_cwd)
    storage = tempfile.TemporaryDirectory()
    self.addCleanup(storage.cleanup)
    database = tempfile.TemporaryDirectory()
    self.addCleanup(database.cleanup)
    self.database = Path(database.name).resolve()
    for name in ('night/1.raw', 'night/1.imgprops', 'night/2.raw', 'day/3.raw'):
      (self.database / name).parent.mkdir(parents=True, exist_ok=True)
      (self.database / name).write_text('')
    self.server = self.serve()
    patch = mock.patch.dict(os.environ, {'QA_STORAGE': storage.name, 'QA_TESTING': '1'})
    patch.start()
    self.addCleanup(patch.stop)
    # they read the server and the project when imported
    for module in ('qaboard.api', 'qaboard.config', 'qaboard.qa'):
      reload(import_module(module))

  def qa(self, *args):
    import qaboard
    return CliRunner().invoke(qaboard.qa, ['--database', str(self.database), *args], obj={}, auto_envvar_prefix='QA', color=False)

  def test_adds_the_inputs_of_paths(self):
    result = self.qa('inputs', 'add', 'night/*.raw', '*/*.raw')
    self.assertEqual(result.exit_code, 0, result.output)
    request, = self.server.requests
    self.assertEqual(request['json']['project'], 'user/sample_project')
    # relative to the database like runs', once each
    self.assertEqual(request['json']['inputs'], [
      {"database": str(self.database), "path": path, "metadata": None} for path in ('night/1.raw', 'night/2.raw', 'day/3.raw')
    ])
    self.assertIn("user/sample_project: 3 inputs added, 0 it already had.", click.unstyle(result.stderr))

  def test_dryrun_only_prints(self):
    import qaboard
    result = CliRunner().invoke(qaboard.qa, ['--dryrun', '--database', str(self.database), 'inputs', 'add', 'night/*.raw'], obj={}, auto_envvar_prefix='QA', color=False)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(self.server.requests, [])
    self.assertIn('2 inputs would be added', result.stderr)
    self.assertEqual(result.stdout, f"{self.database}\tnight/1.raw\n{self.database}\tnight/2.raw\n")

  def test_needs_inputs(self):
    result = self.qa('inputs', 'add')
    self.assertEqual(result.exit_code, 2)
    self.assertIn('Which inputs?', result.output)


if __name__ == '__main__':
  unittest.main()
