"""
Tests for qaboard/input_collections.py (`qaboard.collections`) and the `collections: [name@2]` of batches (qaboard/iterators.py),
with the server faked: requests get the answers of GET /api/v1/collections/resolve (docs/design/inputs-and-collections.md).
"""
import json
import os
import tempfile
import unittest
from importlib import import_module, reload
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

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
  r.url = f"{SERVER}/api/v1/collections/resolve"
  return r


def resolved(name='night/hard-cases', version=2, project='group/repo', inputs=(('/data', 'a.txt'), ('/data', 'b.txt'))):
  """What GET /collections/resolve answers"""
  return {
    "collection": {"id": 7, "project": project, "name": name, "ref": name, "latest_version": 3},
    "version": version,
    "project": project,
    "inputs": [{"id": index + 1, "database": database, "path": path} for index, (database, path) in enumerate(inputs)],
  }


class FakeServer:
  """Answers GET /collections/resolve: `collections` is {(project, ref): (status, body)}. Keeps the requests."""
  def __init__(self, collections=None):
    self.collections = collections or {}
    self.requests = []

  def __call__(self, method, url, params=None, headers=None, **kwargs):
    self.requests.append({"method": method, "url": url, "params": dict(params or {}), "headers": dict(headers or {})})
    if not url.endswith('/api/v1/collections/resolve'):
      return response(404, {"error": "not found"})
    key = (params['project'], params['ref'])
    if key not in self.collections:
      return response(404, {"error": f"Unknown collection {params['ref']}"})
    return response(*self.collections[key])

  def patch(self):
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_'))}
    environ.update({'QABOARD_URL': SERVER, 'QABOARD_TOKEN': 'qab_secret'})
    patches = [mock.patch('requests.Session.request', side_effect=self), mock.patch.dict(os.environ, environ, clear=True)]
    for p in patches:
      p.start()
    return patches


class FakeServerTestCase(unittest.TestCase):
  def serve(self, collections):
    server = FakeServer(collections)
    for p in server.patch():
      self.addCleanup(p.stop)
    return server


class TestGet(FakeServerTestCase):
  def test_resolves_with_the_server_and_token_qa_uses(self):
    from qaboard.input_collections import get, CollectionInput
    server = self.serve({('group/repo', 'night/hard-cases'): (200, resolved())})
    collection = get('night/hard-cases', project='group/repo')
    request, = server.requests
    self.assertEqual(request['url'], f"{SERVER}/api/v1/collections/resolve")
    self.assertEqual(request['params'], {"project": "group/repo", "ref": "night/hard-cases"})
    self.assertEqual(request['headers'].get('Authorization'), 'Bearer qab_secret')
    self.assertEqual((collection.name, collection.version, collection.project, collection.id), ('night/hard-cases', 2, 'group/repo', 7))
    self.assertEqual(collection.ref, 'night/hard-cases')
    self.assertEqual(collection.pinned_ref, 'night/hard-cases@2')
    self.assertEqual(collection.inputs, [CollectionInput(1, '/data', 'a.txt'), CollectionInput(2, '/data', 'b.txt')])
    # iterating a collection gives objects, not tuples: they will say more about inputs (options, regions)
    self.assertEqual([item.path for item in collection], ['a.txt', 'b.txt'])
    item = next(iter(collection))
    self.assertEqual((item.id, item.database, item.path, item.data, item.region), (1, '/data', 'a.txt', {}, None))
    self.assertEqual(item.absolute_path, Path('/data/a.txt'))
    with self.assertRaises(TypeError):
      database, path = item
    self.assertEqual(len(collection), 2)
    self.assertEqual(collection.to_dict()['inputs'][0], {"id": 1, "database": "/data", "path": "a.txt"})

  def test_data_and_region_of_inputs(self):
    """Optional in the server's answer: {} and None without them"""
    from qaboard.input_collections import from_api, resolver_from_file
    answer = resolved()
    answer['inputs'][0].update({"data": {"exposure": 2}, "region": {"x": 1, "y": 2, "width": 3, "height": 4}})
    answer['inputs'][1]['data'] = None
    collection = from_api(answer, ref='night/hard-cases', project='group/repo')
    first, second = collection
    self.assertEqual((first.data, first.region), ({"exposure": 2}, {"x": 1, "y": 2, "width": 3, "height": 4}))
    self.assertEqual((second.data, second.region), ({}, None))
    # kept when the server writes them for `qa batch --list`
    self.assertEqual(collection.to_dict()['inputs'][0]['data'], {"exposure": 2})
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'resolved.json'
      path.write_text(json.dumps({"collections": {"night/hard-cases": collection.to_dict()}}))
      again = resolver_from_file(str(path))('night/hard-cases')
    self.assertEqual([(i.data, i.region) for i in again], [(first.data, first.region), ({}, None)])

  def test_lazy_attribute_of_the_package(self):
    import qaboard
    from qaboard import input_collections
    self.assertTrue(callable(qaboard.collections.get))
    self.assertIs(qaboard.collections, input_collections)
    from qaboard import collections # what the web app's snippet writes
    self.assertIs(collections, input_collections)
    self.assertIn('collections', dir(qaboard))
    # `from qaboard import *` doesn't replace the standard library's collections
    self.assertNotIn('collections', qaboard.__all__)
    namespace = {}
    exec('import collections\nfrom qaboard import *', namespace)
    self.assertTrue(hasattr(namespace['collections'], 'OrderedDict'))

  def test_does_not_shadow_the_standard_library(self):
    """Scripts run from the qaboard/ folder (it's first in sys.path) import the standard library's collections"""
    import subprocess
    import sys
    package = Path(__file__).resolve().parent.parent / 'qaboard'
    self.assertFalse((package / 'collections.py').exists())
    result = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import collections; print(collections.OrderedDict.__name__)', str(package)],
                            capture_output=True, text=True, cwd=package)
    self.assertEqual(result.stdout.strip(), 'OrderedDict', result.stderr)

  def test_collection_of_an_ancestor_project(self):
    """The server says which project owns it"""
    from qaboard.input_collections import get
    self.serve({('group/repo/sub', 'night/hard-cases'): (200, resolved(project='group/repo'))})
    self.assertEqual(get('night/hard-cases', project='group/repo/sub').project, 'group/repo')

  def test_version_objects_and_names(self):
    """Tolerates `version` as an object, `collection` as a name"""
    from qaboard.input_collections import from_api
    collection = from_api({"collection": "a/b", "version": {"version": 4, "notes": ""}, "inputs": [{"id": 1, "database": "d", "path": "p"}]}, ref='a/b', project='g/r')
    self.assertEqual((collection.name, collection.version, collection.project, len(collection)), ('a/b', 4, 'g/r', 1))

  def test_not_found(self):
    from qaboard.input_collections import get, CollectionNotFound
    self.serve({})
    with self.assertRaises(CollectionNotFound) as error:
      get('night/missing@2', project='group/repo')
    self.assertIn("'night/missing@2'", error.exception.message)
    self.assertIn("group/repo", error.exception.message)
    self.assertEqual(error.exception.status, 404)

  def test_server_unreachable(self):
    from qaboard.input_collections import get, CollectionError, CollectionNotFound
    self.serve({})
    with mock.patch('requests.Session.request', side_effect=requests.ConnectionError('Connection refused')):
      with self.assertRaises(CollectionError) as error:
        get('night/hard-cases', project='group/repo')
    self.assertNotIsInstance(error.exception, CollectionNotFound)
    self.assertIn(f"Could not reach QA-Board at {SERVER}", error.exception.message)
    self.assertIn("connection refused", error.exception.message)
    self.assertIn("QABOARD_URL", error.exception.message)

  def test_refused(self):
    from qaboard.input_collections import get, CollectionError
    self.serve({('group/repo', 'night'): (403, {"error": "You can't read this project.", "reason": "missing_role"})})
    with self.assertRaises(CollectionError) as error:
      get('night', project='group/repo')
    self.assertEqual(error.exception.status, 403)
    self.assertIn("You can't read this project.", error.exception.message)

  def test_version_pinning(self):
    from qaboard.input_collections import get, CollectionError
    server = self.serve({
      ('group/repo', 'night/hard-cases@2'): (200, resolved(version=2)),
      ('group/repo', 'night/hard-cases@latest'): (200, resolved(version=3)),
      ('group/repo', 'other@2'): (200, resolved(name='other', version=3)),
    })
    self.assertEqual(get('night/hard-cases@2', project='group/repo').version, 2)
    self.assertEqual(get('night/hard-cases@latest', project='group/repo').version, 3)
    self.assertEqual([r['params']['ref'] for r in server.requests], ['night/hard-cases@2', 'night/hard-cases@latest'])
    # we don't run on another version than the one asked for
    with self.assertRaises(CollectionError):
      get('other@2', project='group/repo')

  def test_parse_ref(self):
    from qaboard.input_collections import parse_ref, CollectionError
    self.assertEqual(parse_ref('night/hard'), (None, 'night/hard', None))
    self.assertEqual(parse_ref('night/hard@3'), (None, 'night/hard', 3))
    self.assertEqual(parse_ref('night/hard@latest'), (None, 'night/hard', None))
    self.assertEqual(parse_ref('a/b:night/hard@2'), ('a/b', 'night/hard', 2))
    for invalid in ['', 'a@b', 'a@0', 'a@-1', 'a:b:c', '@2']:
      with self.assertRaises(CollectionError, msg=invalid):
        parse_ref(invalid)

  def test_invalid_refs_are_not_sent(self):
    from qaboard.input_collections import get, CollectionError
    server = self.serve({})
    with self.assertRaises(CollectionError):
      get('night@two', project='group/repo')
    self.assertEqual(server.requests, [])

  def test_default_project_is_the_current_one(self):
    from qaboard import collections
    server = self.serve({('group/repo/sub', 'night'): (200, resolved(name='night'))})
    with mock.patch.object(collections, 'current_project', return_value='group/repo/sub'):
      self.assertEqual(collections.get('night').name, 'night')
    self.assertEqual(server.requests[0]['params']['project'], 'group/repo/sub')
    with mock.patch.object(collections, 'current_project', return_value=None):
      with self.assertRaises(collections.CollectionError) as error:
        collections.get('night')
    self.assertIn("project=", error.exception.message)

  def test_default_project_is_the_one_the_reference_names(self):
    """`a/b:name` says where it is: outside a project too"""
    from qaboard import collections
    server = self.serve({('group/repo', 'group/repo:night@2'): (200, resolved(name='night', version=2, project='group/repo'))})
    with mock.patch.object(collections, 'current_project', side_effect=AssertionError("reads qaboard.yaml")):
      collection = collections.get('group/repo:night@2')
    self.assertEqual((collection.name, collection.version, collection.project), ('night', 2, 'group/repo'))
    self.assertEqual(server.requests[0]['params'], {'project': 'group/repo', 'ref': 'group/repo:night@2'})
    # an explicit project wins: names resolve from where users look
    server.collections[('group/repo/sub', 'group/repo:night@2')] = (200, resolved(name='night', version=2, project='group/repo'))
    collections.get('group/repo:night@2', project='group/repo/sub')
    self.assertEqual(server.requests[1]['params']['project'], 'group/repo/sub')


class TestBatches(FakeServerTestCase):
  """`collections: [name@2]` in batches, next to their inputs"""
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.database = Path(tmp.name).resolve()
    for name in ['a.txt', 'b.txt', 'c.txt']:
      (self.database / name).write_text('')
    self.batches_file = self.database / 'batches.yaml'
    (self.database / 'entrypoint.py').write_text('def metadata(context):\n  return {"name": context.input_path.stem, "collection": context.collection}\n')
    self.config = {"project": {"name": "group/repo/sub", "entrypoint": str(self.database / 'entrypoint.py')}}

  def runs(self, batches_yaml, batch='my-batch'):
    from qaboard.iterators import iter_inputs
    self.batches_file.write_text(batches_yaml)
    return list(iter_inputs([batch], [self.batches_file], self.database, [], 'linux', {"type": "local"}, self.config, {"type": "default"}))

  def inputs(self, *names, database=None):
    return [(str(database or self.database), name) for name in names]

  def test_expands_collections(self):
    server = self.serve({('group/repo/sub', 'night/hard@2'): (200, resolved(version=2, inputs=self.inputs('a.txt', 'b.txt')))})
    runs = self.runs('\n'.join([
      'my-batch:',
      '  configurations: [base]',
      '  inputs:',
      '    - c.txt',
      '  collections:',
      '    - night/hard@2',
    ]))
    # the collections' runs first
    self.assertEqual([(r.rel_input_path.as_posix(), r.database, r.configurations) for r in runs], [
      ('a.txt', self.database, ['base']),
      ('b.txt', self.database, ['base']),
      ('c.txt', self.database, ['base']),
    ])
    self.assertEqual([(r.collection, r.collection_version) for r in runs], [('night/hard@2', 2), ('night/hard@2', 2), (None, None)])
    # and the collection's id: its name may be reused after a rename
    self.assertEqual([r.collection_id for r in runs], [7, 7, None])
    self.assertEqual(runs[0].input_path, self.database / 'a.txt')
    # the project of the qaboard.yaml
    self.assertEqual(server.requests[0]['params'], {"project": "group/repo/sub", "ref": "night/hard@2"})

  def test_only_collections(self):
    """Without inputs, a batch runs on its collections only, not on every input of the database"""
    self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('b.txt')))})
    runs = self.runs('my-batch:\n  collections: night\n')
    self.assertEqual([(r.rel_input_path.as_posix(), r.collection) for r in runs], [('b.txt', 'night')])
    self.assertEqual(self.runs('my-batch:\n  collections: [night]\n  inputs: []\n'), runs)

  def test_several_collections_in_order(self):
    self.serve({
      ('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('b.txt'))),
      ('group/repo/sub', 'day@1'): (200, resolved(name='day', version=1, inputs=self.inputs('a.txt', 'c.txt'))),
    })
    runs = self.runs('my-batch:\n  collections: [day@1, night]\n')
    self.assertEqual([(r.rel_input_path.as_posix(), r.collection) for r in runs], [('a.txt', 'day@1'), ('c.txt', 'day@1'), ('b.txt', 'night')])

  def test_settings_of_collections(self):
    self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', version=5, inputs=self.inputs('a.txt')))})
    run, = self.runs('\n'.join([
      'my-batch:',
      '  configurations: [base]',
      '  collections:',
      '    - name: night',
      '      configurations: [{gain: 2}]',
      '      platform: windows',
      '      type: default',
      '      local: {concurrency: 3}',
      '      lsf: {memory: 16000}',
    ]))
    self.assertEqual((run.configurations, run.platform, run.collection, run.collection_version), (['base', {"gain": 2}], 'windows', 'night', 5))
    # the options of the runner that runs, and only those: they aren't configurations
    self.assertEqual(run.job_options.get('concurrency'), 3)
    self.assertNotIn('memory', run.job_options)
    # a single configuration
    run, = self.runs('my-batch:\n  collections:\n    - name: night\n      configuration: fast\n')
    self.assertEqual(run.configurations, ['fast'])

  def test_debug_output(self):
    """`QA_DEBUG_ITER_INPUTS=1 qa batch --list` says which collection, version and how many inputs"""
    from qaboard.iterators import iter_inputs
    self.serve({('group/repo/sub', 'night@2'): (200, resolved(name='night', version=2, project='group/repo', inputs=self.inputs('a.txt', 'b.txt')))})
    self.batches_file.write_text('my-batch:\n  collections: [night@2]\n')
    with mock.patch('qaboard.iterators.click.secho') as secho:
      runs = list(iter_inputs(['my-batch'], [self.batches_file], self.database, [], 'linux', {"type": "local"}, self.config, {"type": "default"}, debug=True))
    self.assertEqual(len(runs), 2)
    printed = [c.args[0] for c in secho.call_args_list]
    self.assertIn('collection night@2', printed)
    self.assertIn('collection night@2 => group/repo:night@2 (2 inputs)', printed)

  def test_inputs_named_collection(self):
    """In `inputs`, a mapping is always an input with its settings: a folder can be named "collection" """
    (self.database / 'collection').mkdir()
    server = self.serve({})
    run, = self.runs('my-batch:\n  inputs:\n    - collection: {gain: 2}\n')
    self.assertEqual((run.rel_input_path.as_posix(), run.configurations, run.collection), ('collection', [{"gain": 2}], None))
    self.assertEqual(server.requests, [])

  def test_only_and_exclude(self):
    self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('a.txt', 'b.txt', 'c.txt')))})
    only = self.runs('my-batch:\n  collections: [night]\n  only: {name: "[ab]"}\n')
    self.assertEqual([r.rel_input_path.as_posix() for r in only], ['a.txt', 'b.txt'])
    excluded = self.runs('my-batch:\n  collections: [night]\n  exclude: {name: b}\n')
    self.assertEqual([r.rel_input_path.as_posix() for r in excluded], ['a.txt', 'c.txt'])
    # metadata() sees the collection
    from_collection = self.runs('my-batch:\n  collections: [night]\n  only: {collection: night, name: c}\n')
    self.assertEqual([r.rel_input_path.as_posix() for r in from_collection], ['c.txt'])

  def test_missing_inputs_are_recorded(self):
    from qaboard.iterators import recording_missing_inputs
    self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('a.txt', 'gone.txt')))})
    with recording_missing_inputs() as missing:
      runs = self.runs('my-batch:\n  collections: [night]\n')
    self.assertEqual([r.rel_input_path.as_posix() for r in runs], ['a.txt'])
    self.assertEqual(missing, [{"input": "gone.txt", "database": str(self.database)}])

  def test_missing_collection_is_an_error_where_it_is_used(self):
    from qaboard.iterators import BatchError
    self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('a.txt')))})
    with self.assertRaises(BatchError) as error:
      self.runs('my-batch:\n  inputs:\n    - a.txt\n  collections:\n    - night\n    - night/typo@2\n')
    message = error.exception.message
    self.assertTrue(message.startswith(f"{self.batches_file}:6: "), message)
    self.assertIn('"night/typo@2"', message)
    self.assertIn('group/repo/sub', message)

  def test_invalid_collections(self):
    from qaboard.iterators import BatchError
    server = self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('a.txt')))})
    def error(batches_yaml):
      with self.assertRaises(BatchError) as raised:
        self.runs(batches_yaml)
      return raised.exception.message
    # no name
    message = error('my-batch:\n  collections:\n    - night\n    - configurations: [x]\n')
    self.assertTrue(message.startswith(f"{self.batches_file}:4: "), message)
    self.assertIn('a collection without a `name`', message)
    # written like an input: says how to write it
    self.assertIn('Did you mean `- name: night@2`?', error('my-batch:\n  collections:\n    - night@2: {configurations: [x]}\n'))
    self.assertIn('without a name', error('my-batch:\n  collections:\n    - name: " "\n'))
    self.assertIn('without a name', error('my-batch:\n  collections:\n    - name: 3\n'))
    # unknown settings
    message = error('my-batch:\n  collections:\n    - name: night\n      database: /data\n      globs: ["*.png"]\n')
    self.assertIn('unknown settings for the collection "night": database, globs (a collection knows the database of each of its inputs)', message)
    self.assertIn('lsf', message)
    # neither a name nor a mapping, empty
    self.assertIn('not a name nor a mapping', error('my-batch:\n  collections:\n    - [night]\n'))
    self.assertIn('an empty `collections`', error('my-batch:\n  collections:\n'))
    self.assertIn('an empty `collections`', error('my-batch:\n  collections: []\n  inputs: [a.txt]\n'))
    self.assertIn('`collections: 3`', error('my-batch:\n  collections: 3\n'))
    self.assertEqual(server.requests, [])

  def test_resolved_once_per_batch_command(self):
    """All the runs use the same version, even if the collection changes meanwhile"""
    server = self.serve({('group/repo/sub', 'night'): (200, resolved(name='night', inputs=self.inputs('a.txt')))})
    runs = self.runs('\n'.join([
      'my-batch:',
      '  collections: [night]',
      '  matrix: {configurations: [x, y, z]}',
    ]))
    self.assertEqual(len(runs), 3)
    self.assertEqual(len(server.requests), 1)

  def test_custom_resolver(self):
    """The server can resolve collections without a request to itself"""
    from qaboard.input_collections import from_api
    from qaboard.iterators import resolving_collections_with
    server = self.serve({})
    calls = []
    def resolve(ref, project):
      calls.append((ref, project))
      return from_api(resolved(name='night', inputs=self.inputs('b.txt')), ref=ref, project=project)
    with resolving_collections_with(resolve):
      runs = self.runs('my-batch:\n  collections: [night]\n')
    self.assertEqual([r.rel_input_path.as_posix() for r in runs], ['b.txt'])
    self.assertEqual(calls, [('night', 'group/repo/sub')])
    self.assertEqual(server.requests, [])


  def test_collections_the_server_resolved(self):
    """`qa batch --list` started by the server reads the collections it resolved, never asks it (no token)"""
    from qaboard.iterators import BatchError
    from qaboard.input_collections import RESOLVED_COLLECTIONS_ENV
    server = self.serve({})
    resolved_file = self.database / 'resolved.json'
    resolved_file.write_text(json.dumps({"collections": {
      "night": {"ref": "night", "project": "group/repo", "name": "night", "version": 3, "id": 7,
                "inputs": [{"id": 1, "database": str(self.database), "path": "b.txt"}]},
      "gone": {"error": "No collection named gone in group/repo/sub, group/repo, group.", "status": 404},
    }}))
    with mock.patch.dict(os.environ, {RESOLVED_COLLECTIONS_ENV: str(resolved_file)}):
      runs = self.runs('my-batch:\n  collections: [night]\n')
      self.assertEqual([(r.rel_input_path.as_posix(), r.collection, r.collection_version) for r in runs], [('b.txt', 'night', 3)])
      with self.assertRaises(BatchError) as error:
        self.runs('my-batch:\n  collections: [gone]\n')
      self.assertIn('No collection named gone', error.exception.message)
      # not in the file: says why
      with self.assertRaises(BatchError) as error:
        self.runs('my-batch:\n  collections: [other]\n')
      self.assertIn("only resolves the `collections` written in the batch files", error.exception.message)
    self.assertEqual(server.requests, [])


class TestShow(FakeServerTestCase):
  def setUp(self):
    self.serve({
      ('group/repo', 'night/hard-cases@2'): (200, resolved()),
      ('user/sample_project', 'night'): (200, resolved(name='night', project='user/sample_project', version=1)),
    })

  def test_prints_the_inputs(self):
    from qaboard.input_collections import collections
    result = CliRunner().invoke(collections, ['show', 'night/hard-cases@2', '--project', 'group/repo'])
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(result.stdout, "/data\ta.txt\n/data\tb.txt\n")
    self.assertIn("night/hard-cases@2: 2 inputs", result.stderr)

  def test_json(self):
    from qaboard.input_collections import collections
    result = CliRunner().invoke(collections, ['show', 'night/hard-cases@2', '--project', 'group/repo', '--json'])
    self.assertEqual(result.exit_code, 0, result.output)
    data = json.loads(result.stdout)
    self.assertEqual((data['name'], data['version'], data['project']), ('night/hard-cases', 2, 'group/repo'))
    self.assertEqual(data['inputs'], [{"id": 1, "database": "/data", "path": "a.txt"}, {"id": 2, "database": "/data", "path": "b.txt"}])

  def test_not_found(self):
    from qaboard.input_collections import collections
    result = CliRunner().invoke(collections, ['show', 'nope@2', '--project', 'group/repo'])
    self.assertEqual(result.exit_code, 1)
    self.assertIn("Error: No collection 'nope@2' for the project group/repo", click.unstyle(result.output))

  def test_qa_collections_show_in_a_project(self):
    """`qa collections show` resolves from the project of the current qaboard.yaml"""
    previous_cwd = os.getcwd()
    os.chdir(ROOT / 'qaboard/sample_project')
    self.addCleanup(os.chdir, previous_cwd)
    storage = tempfile.TemporaryDirectory()
    self.addCleanup(storage.cleanup)
    with mock.patch.dict(os.environ, {'QA_STORAGE': storage.name, 'QA_TESTING': '1'}):
      # they read the server and the project when imported
      for module in ('qaboard.api', 'qaboard.config', 'qaboard.qa'):
        reload(import_module(module))
      import qaboard
      result = CliRunner().invoke(qaboard.qa, ['collections', 'show', 'night'], obj={}, auto_envvar_prefix='QA', color=False)
    self.assertEqual(result.exit_code, 0, result.output)
    self.assertEqual(result.stdout, "/data\ta.txt\n/data\tb.txt\n")


if __name__ == '__main__':
  unittest.main()
