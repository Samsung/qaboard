"""
The API of inputs and collections (api/inputs.py, api/collections.py) with the SQL mocked (backend/input_catalog.py):
permissions, validation, the answers. The SQL itself is tested in test_input_catalog.py. See tests/TESTING.md.
"""
import datetime
from urllib.parse import quote
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from flask import jsonify

DATE = datetime.datetime(2026, 11, 20, 10, 30)


def collection_row(**kwargs):
  return {
    'id': 3, 'project_id': 'a', 'name': 'night/hard', 'description': '', 'created_at': DATE, 'updated_at': DATE,
    'archived_at': None, 'latest_version': 2, 'size': 2,
    'created_by_id': 1, 'created_by_user_name': 'alice', 'created_by_full_name': 'Alice A', **kwargs,
  }


def version_row(version=2, **kwargs):
  return {'id': 10 + version, 'version': version, 'created_at': DATE, 'notes': '', 'size': 2, 'created_by_id': 2,
          'created_by_user_name': 'bob', 'created_by_full_name': 'Bob B', **kwargs}


class Permissions:
  """Who can do what in the tests: {(project, permission)}. Like the real require_project_access, answers 401/403."""
  def __init__(self, *allowed):
    self.allowed = set(allowed)
    self.checked = []

  def grant(self, project, *permissions):
    for permission in permissions:
      self.allowed.add((project, permission))

  def require(self, user_info, project_id, permission='runs.act'):
    self.checked.append((project_id, permission))
    if (project_id, permission) in self.allowed:
      return None
    return jsonify({"error": "Forbidden", "reason": "missing_role"}), 403

  def can(self, permission, project_id, actor=None):
    return (project_id, permission) in self.allowed


@pytest.fixture
def apis(monkeypatch):
  from backend import input_catalog as catalog
  from backend.api import inputs, collections
  permissions = Permissions()
  # bob reads a and its subprojects, develops in a
  permissions.grant('a', 'project.read', 'collections.write')
  permissions.grant('a/b', 'project.read')
  user = {'is_authenticated': True, 'user_id': 2, 'user_name': 'bob'}
  for module in (inputs, collections):
    monkeypatch.setattr(module, 'require_project_access', permissions.require)
    monkeypatch.setattr(module, 'can', permissions.can)
    monkeypatch.setattr(module, 'get_current_user', lambda to_jsonify=True: user, raising=False)
  db_session = MagicMock()
  monkeypatch.setattr(collections, 'db_session', db_session)
  monkeypatch.setattr(inputs, 'db_session', db_session)
  audited = []
  for module in (inputs, collections):
    monkeypatch.setattr(module, 'audit', lambda *args, **kwargs: audited.append((args, kwargs)))
  # every SQL function is a mock, configured by the tests
  fake = SimpleNamespace()
  for name in ('scope_projects', 'project_exists', 'list_inputs', 'list_input_ids', 'input_by_id', 'input_in_scope', 'input_stats', 'in_collections_of',
               'input_runs', 'inputs_outside', 'collections_of', 'collection_by_id', 'find_collection', 'name_taken',
               'create_collection', 'add_version', 'update_collection', 'versions_of', 'version_of', 'members', 'member_ids',
               'member_refs', 'favorite_ids', 'set_favorite', 'pins_of', 'set_pin', 'group_ids_of', 'groups_of', 'group_exists', 'add_inputs', 'clear_pins', 'archived_count', 'metadata_values'):
    mock = MagicMock(name=name)
    monkeypatch.setattr(catalog, name, mock)
    setattr(fake, name, mock)
  fake.scope_projects.side_effect = lambda project: [project, f"{project}/b", f"{project}/secret"]
  fake.favorite_ids.return_value = set()
  fake.pins_of.return_value = {}
  fake.group_ids_of.return_value = []
  fake.groups_of.return_value = []
  fake.archived_count.return_value = 0
  fake.inputs_outside.return_value = []
  fake.name_taken.return_value = None
  fake.collection_by_id.return_value = collection_row()
  fake.version_of.side_effect = lambda collection_id, version: version_row(version) if version <= 2 else None
  fake.project_exists.return_value = True
  yield SimpleNamespace(inputs=inputs, collections=collections, sql=fake, permissions=permissions, user=user, db=db_session, audited=audited)


def call(dummy_app, handler, *args, url='/api/v1/x', method='GET', json=None):
  with dummy_app.test_request_context(url, method=method, json=json):
    response = handler(*args)
    if isinstance(response, tuple):
      response, status = response
      response.status_code = status
    return response


# ==========================================
# Inputs
# ==========================================

def test_inputs_of_the_subprojects_the_user_can_read(apis, dummy_app):
  apis.sql.list_inputs.return_value = {"inputs": [{'id': 1, 'database': '/d', 'path': 'n/a.png', 'data': {}, 'runs': 2, 'first_run_at': DATE, 'last_run_at': DATE}],
                                       "total": 1, "databases": [{"database": "/d", "count": 1}], "folders": []}
  response = call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&q=night&folder=/n/&live=0&sort=path&limit=10&offset=20')
  assert response.status_code == 200
  data = response.get_json()
  assert data['inputs'][0]['name'] == 'a.png' and data['inputs'][0]['thumbnail_url'] == '/api/v1/inputs/1/thumbnail?project=a'
  assert (data['total'], data['limit'], data['offset']) == (1, 10, 20)
  projects, filters, sort, limit, offset = apis.sql.list_inputs.call_args[0]
  # a/secret is a subproject bob can't read
  assert projects == ['a', 'a/b']
  assert (filters.tokens, filters.folder, filters.live, filters.database, sort, limit, offset) == (['night'], '/n', False, None, 'path', 10, 20)
  # not the first page: no facets
  assert apis.sql.list_inputs.call_args.kwargs == {'with_facets': False}
  assert data['inputs'][0]['full_path'] == '/d/n/a.png' and filters.metadata == {}
  call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&meta=%7B%22weather%22%3A%5B%22rain%22%5D%7D')
  assert apis.sql.list_inputs.call_args[0][1].metadata == {'weather': ['rain']}
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&meta=rain').status_code == 400
  call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&meta=' + quote('{"iso": {"min": 200, "max": 800}, "lux": {"min": 1.5}}'))
  assert apis.sql.list_inputs.call_args[0][1].metadata == {'iso': {'min': 200, 'max': 800}, 'lux': {'min': 1.5, 'max': None}}
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&meta=' + quote('{"iso": {"min": "a"}}')).status_code == 400


def test_metadata_values_with_the_filters(apis, dummy_app):
  apis.sql.metadata_values.return_value = {"key": "city", "count": 1, "distinct": 1, "type": "string", "values": [{"value": "Paris", "count": 1}]}
  meta = quote('{"weather": ["rain"]}')
  response = call(dummy_app, apis.inputs.list_metadata_values, url=f'/api/v1/inputs/metadata-values?project=a&q=night&folder=/n&meta={meta}&key=city&search=par')
  assert response.status_code == 200 and response.get_json()['values'] == [{"value": "Paris", "count": 1}]
  projects, filters, key, search = apis.sql.metadata_values.call_args[0]
  assert (projects, filters.tokens, filters.folder, filters.metadata, key, search) == (['a', 'a/b'], ['night'], '/n', {'weather': ['rain']}, 'city', 'par')
  assert call(dummy_app, apis.inputs.list_metadata_values, url='/api/v1/inputs/metadata-values?project=a').status_code == 400
  assert call(dummy_app, apis.inputs.list_metadata_values, url='/api/v1/inputs/metadata-values?project=other&key=city').status_code == 403


def test_inputs_facets_on_the_first_page_only(apis, dummy_app):
  apis.sql.list_inputs.return_value = {"inputs": [], "total": None, "databases": None, "folders": None}
  call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a')
  assert apis.sql.list_inputs.call_args.kwargs == {'with_facets': True}
  data = call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&offset=200').get_json()
  assert apis.sql.list_inputs.call_args.kwargs == {'with_facets': False}
  assert (data['total'], data['databases'], data['folders']) == (None, None, None)
  # asked for
  call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&offset=200&facets=1')
  assert apis.sql.list_inputs.call_args.kwargs == {'with_facets': True}
  call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&facets=0')
  assert apis.sql.list_inputs.call_args.kwargs == {'with_facets': False}


def test_ids_of_every_matching_input(apis, dummy_app):
  apis.sql.list_input_ids.return_value = {"ids": [3, 1, 2], "total": 3, "too_many": False}
  response = call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&q=night&folder=n&sort=path&fields=id&limit=10&offset=20')
  assert response.status_code == 200
  assert response.get_json() == {"ids": [3, 1, 2], "total": 3, "too_many": False, "max": 50_000}
  projects, filters, sort = apis.sql.list_input_ids.call_args[0]
  assert projects == ['a', 'a/b'] and (filters.tokens, filters.folder, filters.live, sort) == (['night'], 'n', True, 'path')
  # as many as a version holds, whatever the page asked
  assert apis.sql.list_input_ids.call_args.kwargs == {'cap': 50_000}
  apis.sql.list_inputs.assert_not_called()
  # too many: the web app asks to narrow the filters
  apis.sql.list_input_ids.return_value = {"ids": [], "total": None, "too_many": True}
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&fields=id').get_json()['too_many'] is True
  # only ids, and readers only
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&fields=path').status_code == 400
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=other&fields=id').status_code == 403


def test_inputs_need_a_readable_project(apis, dummy_app):
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs').status_code == 400
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a/../x').status_code == 400
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=other').status_code == 403
  assert call(dummy_app, apis.inputs.list_inputs, url='/api/v1/inputs?project=a&sort=id').status_code == 400
  apis.sql.list_inputs.assert_not_called()


def add(dummy_app, apis, body):
  return call(dummy_app, apis.inputs.add_inputs, url='/api/v1/inputs', method='POST', json=body)


def test_add_inputs_before_any_run(apis, dummy_app):
  apis.sql.add_inputs.return_value = [{'id': 7, 'database': '/d', 'path': 'n/a.raw', 'new': True}, {'id': 8, 'database': '/d', 'path': 'n/b.raw', 'new': False}]
  body = {'project': 'a', 'inputs': [
    {'database': '/d', 'path': '/n/a.raw', 'metadata': {'sensor': 'imx766'}}, {'database': '/d', 'path': 'n\\b.raw'}, {'database': '/d', 'path': 'n/a.raw'},
  ]}
  response = add(dummy_app, apis, body)
  assert response.status_code == 200, response.get_json()
  assert response.get_json() == {'inputs': [{'id': 7, 'database': '/d', 'path': 'n/a.raw', 'new': True}, {'id': 8, 'database': '/d', 'path': 'n/b.raw', 'new': False}], 'added': 1, 'known': 1}
  # databases like runs send them: /d/ and /d are one
  body = {'project': 'a', 'inputs': [{'database': d, 'path': 'x'} for d in ('/d/', '/d', '//d', '//srv/share/', 'C:\\data\\')]}
  add(dummy_app, apis, body)
  assert [i['database'] for i in apis.sql.add_inputs.call_args[0][1]] == ['/d', '//d', '//srv/share', 'C:/data']
  add(dummy_app, apis, {'project': 'a', 'inputs': [{'database': '/d', 'path': '/n/a.raw', 'metadata': {'sensor': 'imx766'}}, {'database': '/d', 'path': 'n\\b.raw'}, {'database': '/d', 'path': 'n/a.raw'}]})
  # paths relative to their database, once each
  assert apis.sql.add_inputs.call_args[0] == ('a', [{'database': '/d', 'path': 'n/a.raw', 'metadata': {'sensor': 'imx766'}}, {'database': '/d', 'path': 'n/b.raw', 'metadata': None}])
  assert ('a', 'collections.write') in apis.permissions.checked
  assert apis.db.commit.call_count == 3
  (action, *_), kwargs = apis.audited[-1]
  # audited when metadata changes, even without new inputs
  assert len(apis.audited) == 3
  assert action == 'input.add' and kwargs['meta']['added'] == 1 and kwargs['meta']['with_metadata'] == 1 and kwargs['project_id'] == 'a'


def test_add_inputs_checks(apis, dummy_app):
  assert add(dummy_app, apis, {'project': 'a/b', 'inputs': [{'database': '/d', 'path': 'x'}]}).status_code == 403  # a viewer of a/b
  for inputs in ([], None, [{'database': '/d'}], [{'path': 'x'}], [{'database': '/d', 'path': '../x'}], [{'database': '/d', 'path': 'x', 'metadata': [1]}]):
    response = add(dummy_app, apis, {'project': 'a', 'inputs': inputs})
    assert (response.status_code, response.get_json()['reason']) == (400, 'invalid_inputs'), inputs
  assert add(dummy_app, apis, {'project': 'a', 'inputs': [{'database': '/d', 'path': f'{i}'} for i in range(10_001)]}).status_code == 413
  assert add(dummy_app, apis, ['not', 'an', 'object']).status_code == 400
  apis.sql.project_exists.return_value = False
  assert add(dummy_app, apis, {'project': 'a', 'inputs': [{'database': '/d', 'path': 'x'}]}).status_code == 404
  apis.sql.add_inputs.assert_not_called()
  assert not apis.audited


def test_an_input_with_its_runs(apis, dummy_app):
  apis.sql.input_in_scope.return_value = {'id': 1, 'database': '/d', 'path': 'a.png', 'data': {}, 'runs': 1, 'first_run_at': DATE, 'last_run_at': DATE}
  apis.sql.input_runs.return_value = [{
    'id': 9, 'project': 'a/b', 'batch': 'default', 'commit': 'abc', 'branch': 'main', 'user': 'bob', 'origin': 'ci', 'platform': 'linux',
    'configurations': ['base'], 'created_date': DATE, 'deleted': False, 'is_failed': True, 'is_pending': False, 'is_running': False,
    'output_dir_override': '/storage/run',
  }]
  data = call(dummy_app, apis.inputs.get_input, 1, url='/api/v1/inputs/1?project=a').get_json()
  assert data['id'] == 1 and data['runs'] == [{
    'id': 9, 'project': 'a/b', 'batch': 'default', 'commit': 'abc', 'branch': 'main', 'user': 'bob', 'origin': 'ci', 'platform': 'linux',
    'configurations': ['base'], 'created_date': "2026-11-20T10:30:00Z", 'deleted': False, 'is_failed': True, 'is_pending': False,
    'is_running': False, 'output_dir_url': '/s/storage/run',
  }]
  assert apis.sql.input_runs.call_args[0] == (1, ['a', 'a/b'])


def test_inputs_of_other_projects_are_not_found(apis, dummy_app):
  apis.sql.input_in_scope.return_value = None
  apis.sql.in_collections_of.return_value = False
  response = call(dummy_app, apis.inputs.get_input, 1, url='/api/v1/inputs/1?project=a/b')
  assert response.status_code == 404
  apis.sql.input_by_id.assert_not_called()
  # ...unless a collection the project sees has it: a/b sees a's collections
  apis.sql.in_collections_of.return_value = True
  apis.sql.input_by_id.return_value = {'id': 1, 'database': '/d', 'path': 'a.png', 'data': {}}
  apis.sql.input_stats.return_value = {'runs': 0, 'first_run_at': None, 'last_run_at': None}
  apis.sql.input_runs.return_value = []
  response = call(dummy_app, apis.inputs.get_input, 1, url='/api/v1/inputs/1?project=a/b')
  assert response.status_code == 200 and response.get_json()['runs'] == []
  # bob's personal collections count, not others'
  assert apis.sql.in_collections_of.call_args[0] == (1, ['a/b', 'a'], 2)


# ==========================================
# Thumbnails and files
# ==========================================

@pytest.fixture
def image(apis, storage_in_tmp, tmp_path, monkeypatch):
  from PIL import Image
  Image.new('RGB', (600, 300), (200, 20, 20)).save(tmp_path / 'red.png')
  (tmp_path / 'raw.bin').write_bytes(b'\x00' * 64)
  rows = {
    1: {'id': 1, 'database': str(tmp_path), 'path': 'red.png', 'data': {}},
    2: {'id': 2, 'database': str(tmp_path), 'path': 'raw.bin', 'data': {}},
    3: {'id': 3, 'database': str(tmp_path), 'path': 'gone.png', 'data': {}},
    4: {'id': 4, 'database': 'relative', 'path': 'a.png', 'data': {}},
    5: {'id': 5, 'database': '/etc', 'path': 'passwd', 'data': {}},
  }
  apis.sql.input_by_id.side_effect = rows.get
  # runs of the project used them all
  apis.sql.input_in_scope.side_effect = lambda input_id, scope: rows.get(input_id)
  apis.sql.in_collections_of.return_value = False
  from backend import thumbnails, files
  from backend.api import files as files_api
  monkeypatch.setattr(thumbnails, 'site_decoders', lambda: ())
  # no Redis in tests: compute
  monkeypatch.setattr(thumbnails, 'cached_thumbnail', lambda path, mtime_ns, size: thumbnails.make_thumbnail(path, size))
  monkeypatch.setattr(files_api, 'check_read_access', lambda path: None)
  return tmp_path


def test_an_input_lists_its_sidecars(apis, image, dummy_app, monkeypatch):
  for name in ('red.metadata.yaml', 'red.imgprops', 'red/red.cde', 'redder.metadata.yaml'):
    (image / name).parent.mkdir(exist_ok=True)
    (image / name).write_text('{}')
  monkeypatch.setenv('QABOARD_INPUT_SIDECARS', '{".png": ["{stem}.imgprops", "{stem}/{stem}.cde"]}')
  apis.sql.input_in_scope.return_value = {'id': 1, 'database': str(image), 'path': 'red.png', 'data': {}, 'runs': 0, 'first_run_at': DATE, 'last_run_at': DATE}
  apis.sql.input_runs.return_value = []
  data = call(dummy_app, apis.inputs.get_input, 1, url='/api/v1/inputs/1?project=a').get_json()
  assert [(f['name'], f['size']) for f in data['sidecars']] == [('red.metadata.yaml', 2), ('red.imgprops', 2), ('red/red.cde', 2)]
  assert data['sidecars'][2]['url'] == f"/s{image}/red/red.cde"
  # outside the storage: the server doesn't say
  apis.sql.input_in_scope.return_value = {'id': 5, 'database': '/etc', 'path': 'passwd', 'data': {}, 'runs': 1, 'first_run_at': DATE, 'last_run_at': DATE}
  assert call(dummy_app, apis.inputs.get_input, 5, url='/api/v1/inputs/5?project=a').get_json()['sidecars'] is None


def test_thumbnails(apis, image, dummy_app):
  from PIL import Image
  import io
  response = call(dummy_app, apis.inputs.input_thumbnail, 1, url='/api/v1/inputs/1/thumbnail?project=a&size=100')
  assert response.status_code == 200 and response.mimetype == 'image/jpeg'
  assert response.headers['Cache-Control'] == 'private, max-age=86400' and response.headers['ETag']
  thumbnail = Image.open(io.BytesIO(response.get_data()))
  assert thumbnail.size == (128, 64) and thumbnail.format == 'JPEG'
  etag = response.headers['ETag']
  with dummy_app.test_request_context('/api/v1/inputs/1/thumbnail?project=a&size=100', headers={'If-None-Match': etag}):
    assert apis.inputs.input_thumbnail(1).status_code == 304


def test_big_thumbnails_stay_longer_in_browsers(apis, image, dummy_app):
  response = call(dummy_app, apis.inputs.input_thumbnail, 1, url='/api/v1/inputs/1/thumbnail?project=a&size=1024')
  assert response.status_code == 200 and response.headers['ETag']
  assert response.headers['Cache-Control'] == 'private, max-age=604800'


def test_thumbnails_when_busy(apis, image, dummy_app, monkeypatch):
  from backend import thumbnails
  def busy(path, size):
    raise thumbnails.Busy()
  monkeypatch.setattr(thumbnails, 'make_thumbnail', busy)
  response = call(dummy_app, apis.inputs.input_thumbnail, 1, url='/api/v1/inputs/1/thumbnail?project=a&size=1024')
  assert (response.status_code, response.get_json()['reason']) == (503, 'busy')
  assert response.headers['Retry-After'] == '2' and response.headers['Cache-Control'] == 'no-store'
  assert 'ETag' not in response.headers


def test_no_thumbnails(apis, image, dummy_app):
  response = call(dummy_app, apis.inputs.input_thumbnail, 2, url='/api/v1/inputs/2/thumbnail?project=a')
  assert (response.status_code, response.get_json()['reason']) == (404, 'no_thumbnail')
  response = call(dummy_app, apis.inputs.input_thumbnail, 3, url='/api/v1/inputs/3/thumbnail?project=a')
  assert (response.status_code, response.get_json()['reason']) == (404, 'missing_file')
  response = call(dummy_app, apis.inputs.input_thumbnail, 4, url='/api/v1/inputs/4/thumbnail?project=a')
  assert (response.status_code, response.get_json()['reason']) == (404, 'not_a_file')
  response = call(dummy_app, apis.inputs.input_thumbnail, 99, url='/api/v1/inputs/99/thumbnail?project=a')
  assert response.status_code == 404


def test_thumbnails_only_of_files_in_the_storage(apis, image, dummy_app):
  response = call(dummy_app, apis.inputs.input_thumbnail, 5, url='/api/v1/inputs/5/thumbnail?project=a')
  assert (response.status_code, response.get_json()['reason']) == (403, 'not-listable')
  response = call(dummy_app, apis.inputs.input_file_content, 5, url='/api/v1/inputs/5/file?project=a')
  assert response.status_code == 403


def test_thumbnails_follow_the_file_rules(apis, image, dummy_app, monkeypatch):
  from backend.api import files as files_api
  monkeypatch.setattr(files_api, 'check_read_access', lambda path: (jsonify({"error": "no", "reason": "forbidden"}), 403))
  assert call(dummy_app, apis.inputs.input_thumbnail, 1, url='/api/v1/inputs/1/thumbnail?project=a').status_code == 403
  assert call(dummy_app, apis.inputs.input_file_content, 1, url='/api/v1/inputs/1/file?project=a').status_code == 403
  # and the project
  assert call(dummy_app, apis.inputs.input_thumbnail, 1, url='/api/v1/inputs/1/thumbnail?project=other').status_code == 403


@pytest.mark.parametrize('endpoint', ['thumbnail', 'file'])
def test_thumbnails_and_files_need_the_project(apis, image, dummy_app, endpoint):
  handler = apis.inputs.input_thumbnail if endpoint == 'thumbnail' else apis.inputs.input_file_content
  # ids are sequential: without the project, the file rules alone would show any project's inputs
  response = call(dummy_app, handler, 1, url=f'/api/v1/inputs/1/{endpoint}')
  assert (response.status_code, response.get_json()['reason']) == (400, 'invalid_project')
  apis.sql.input_by_id.assert_not_called()
  apis.sql.input_in_scope.assert_not_called()
  # a project the user can't read
  response = call(dummy_app, handler, 1, url=f'/api/v1/inputs/1/{endpoint}?project=other')
  assert response.status_code == 403
  apis.sql.input_in_scope.assert_not_called()
  # no run of the project (or of the subprojects bob reads) used it, and no collection it sees has it: as if it didn't exist
  apis.sql.input_in_scope.side_effect = None
  apis.sql.input_in_scope.return_value = None
  response = call(dummy_app, handler, 1, url=f'/api/v1/inputs/1/{endpoint}?project=a/b')
  assert (response.status_code, response.get_json()['reason']) == (404, 'input_not_found')
  assert apis.sql.input_in_scope.call_args[0] == (1, ['a/b'])
  assert apis.sql.in_collections_of.call_args[0] == (1, ['a/b', 'a'], 2)
  apis.sql.input_by_id.assert_not_called()
  # an input that doesn't exist answers the same
  response = call(dummy_app, handler, 99, url=f'/api/v1/inputs/99/{endpoint}?project=a')
  assert (response.status_code, response.get_json()['reason']) == (404, 'input_not_found')
  # a collection the project sees has it (a/b sees a's): the image
  apis.sql.in_collections_of.return_value = True
  response = call(dummy_app, handler, 1, url=f'/api/v1/inputs/1/{endpoint}?project=a/b')
  response.direct_passthrough = False
  assert response.status_code == 200 and response.mimetype == ('image/jpeg' if endpoint == 'thumbnail' else 'image/png')
  response.close()


def test_files(apis, image, dummy_app):
  response = call(dummy_app, apis.inputs.input_file_content, 1, url='/api/v1/inputs/1/file?project=a')
  response.direct_passthrough = False
  assert response.status_code == 200 and response.mimetype == 'image/png'
  assert response.get_data() == (image / 'red.png').read_bytes()
  response.close()
  response = call(dummy_app, apis.inputs.input_file_content, 2, url='/api/v1/inputs/2/file?project=a')
  assert (response.status_code, response.get_json()['reason']) == (415, 'unsupported_format')
  assert response.get_json()['thumbnail_url'] == '/api/v1/inputs/2/thumbnail?project=a&size=1024'


# ==========================================
# Collections
# ==========================================

def test_list_the_projects_and_its_ancestors_collections(apis, dummy_app):
  apis.sql.collections_of.return_value = [collection_row(), collection_row(id=4, project_id='a/b', name='mine')]
  apis.sql.favorite_ids.return_value = {4}
  apis.sql.pins_of.return_value = {3: [{'id': None, 'name': None}]}
  data = call(dummy_app, apis.collections.list_collections, url='/api/v1/collections?project=a/b').get_json()
  assert apis.sql.collections_of.call_args == ((['a/b', 'a'],), {'archived': False, 'user_id': 2})
  first, second = data['collections']
  assert (first['ref'], first['inherited'], first['pinned'], first['favorite'], first['can_edit']) == ('a:night/hard', True, True, False, True)
  assert (second['ref'], second['favorite'], second['can_edit']) == ('mine', True, False)
  # bob reads a/b: he makes personal collections there, not shared ones
  assert (data['my_groups'], data['can_pin_everyone'], data['can_create'], data['can_share'], first['can_pin_everyone']) == ([], False, True, False, False)
  # bob's groups, for the pin menu; owners of a pin for everyone
  apis.sql.groups_of.return_value = [{'id': 5, 'name': 'night-team'}]
  apis.permissions.grant('a', 'project.access')
  data = call(dummy_app, apis.collections.list_collections, url='/api/v1/collections?project=a').get_json()
  assert (data['my_groups'], data['can_pin_everyone'], data['can_create'], data['can_share']) == ([{'id': 5, 'name': 'night-team'}], True, True, True)
  assert data['collections'][0]['can_pin_everyone'] is True
  apis.sql.pins_of.return_value = {3: [{'id': 5, 'name': 'night-team'}]}
  assert call(dummy_app, apis.collections.list_collections, url='/api/v1/collections?project=a').get_json()['collections'][0]['pinned'] is True
  call(dummy_app, apis.collections.list_collections, url='/api/v1/collections?project=a&archived=1')
  assert apis.sql.collections_of.call_args == ((['a'],), {'archived': True, 'user_id': 2})
  assert call(dummy_app, apis.collections.list_collections, url='/api/v1/collections?project=other').status_code == 403


def test_create(apis, dummy_app):
  apis.sql.create_collection.return_value = 3
  body = {'project': 'a', 'name': ' night / hard ', 'description': 'Hard', 'inputs': [5, 6, 5], 'notes': 'first'}
  response = call(dummy_app, apis.collections.create_collection, url='/api/v1/collections', method='POST', json=body)
  assert response.status_code == 201
  assert apis.sql.create_collection.call_args[0] == ('a', 'night/hard', 'Hard', [5, 6], 'first', 2)
  assert apis.sql.inputs_outside.call_args[0] == ([5, 6], ['a', 'a/b'])
  apis.db.commit.assert_called_once()
  assert response.get_json()['id'] == 3


def test_personal_collections(apis, dummy_app):
  """Anyone who reads the project makes personal collections: only their creator sees and edits them"""
  def create(body):
    return call(dummy_app, apis.collections.create_collection, url='/api/v1/collections', method='POST', json=body)
  apis.sql.create_collection.return_value = 4
  apis.sql.collection_by_id.return_value = collection_row(id=4, project_id='a/b', shared=False, created_by_id=2)
  # bob only reads a/b
  assert create({'project': 'a/b', 'name': 'x', 'inputs': []}).status_code == 403
  response = create({'project': 'a/b', 'name': 'x', 'inputs': [], 'shared': False})
  assert response.status_code == 201, response.get_json()
  assert apis.sql.create_collection.call_args[1] == {'shared': False}
  assert (response.get_json()['shared'], response.get_json()['mine'], response.get_json()['can_edit']) == (False, True, True)
  assert create({'project': 'a/b', 'name': 'x', 'inputs': [], 'shared': 'no'}).status_code == 400
  # he edits it without collections.write, and can't share it there
  edit = lambda body: call(dummy_app, apis.collections.edit_collection, 4, url='/api/v1/collections/4', method='PATCH', json=body)
  assert edit({'description': 'mine'}).status_code == 200
  assert edit({'shared': True}).status_code == 403
  apis.sql.update_collection.assert_called_once_with(4, {'description': 'mine'})
  # no pins on personal collections
  response = call(dummy_app, apis.collections.pin_collection, 4, url='/api/v1/collections/4/pins', method='PUT', json={'group': None})
  assert (response.status_code, response.get_json()['reason']) == (400, 'personal_collection')
  # someone else's: as if it didn't exist
  apis.sql.collection_by_id.return_value = collection_row(id=4, project_id='a/b', shared=False, created_by_id=1)
  assert call(dummy_app, apis.collections.read_collection, 4, url='/api/v1/collections/4').status_code == 404
  assert edit({'description': 'theirs'}).status_code == 404
  # resolved for their creator only
  apis.sql.find_collection.return_value = None
  call(dummy_app, apis.collections.resolve_collection, url='/api/v1/collections/resolve?project=a&ref=x')
  assert apis.sql.find_collection.call_args[1] == {'user_id': 2}


def test_names_taken_by_someone_elses_personal_collection(apis, dummy_app):
  apis.sql.name_taken.return_value = 4
  apis.sql.collection_by_id.return_value = collection_row(id=4, shared=False, created_by_id=1)
  response = call(dummy_app, apis.collections.create_collection, url='/api/v1/collections', method='POST', json={'project': 'a', 'name': 'x', 'inputs': [], 'shared': False})
  assert response.status_code == 409 and 'id' not in response.get_json()
  # yours: its id, to open it
  apis.sql.collection_by_id.return_value = collection_row(id=4, shared=False, created_by_id=2)
  response = call(dummy_app, apis.collections.create_collection, url='/api/v1/collections', method='POST', json={'project': 'a', 'name': 'x', 'inputs': [], 'shared': False})
  assert response.get_json()['id'] == 4


def test_share_a_personal_collection(apis, dummy_app):
  edit = lambda body: call(dummy_app, apis.collections.edit_collection, 3, url='/api/v1/collections/3', method='PATCH', json=body)
  apis.sql.collection_by_id.return_value = collection_row(shared=False, created_by_id=2)
  assert edit({'shared': True}).status_code == 200
  assert apis.sql.update_collection.call_args[0] == (3, {'shared': True})
  apis.sql.clear_pins.assert_not_called()
  # personal again: its pins go
  apis.sql.collection_by_id.return_value = collection_row(shared=True, created_by_id=2)
  assert edit({'shared': False}).status_code == 200
  apis.sql.clear_pins.assert_called_once_with(3)
  # a developer can't make someone else's shared collection personal
  apis.sql.collection_by_id.return_value = collection_row(shared=True, created_by_id=1)
  response = edit({'shared': False})
  assert (response.status_code, response.get_json()['reason']) == (403, 'not_the_owner')


def test_create_checks(apis, dummy_app):
  def create(body):
    return call(dummy_app, apis.collections.create_collection, url='/api/v1/collections', method='POST', json=body)
  assert create({'project': 'a/b', 'name': 'x', 'inputs': []}).status_code == 403  # a viewer of a/b
  assert create({'project': 'a', 'name': 'a:b', 'inputs': []}).get_json()['reason'] == 'invalid_name'
  assert create({'project': 'a', 'name': 'x', 'inputs': list(range(1, 50_002))}).status_code == 413
  assert create({'project': 'a', 'name': 'x', 'inputs': [1], 'description': 'd' * 20_001}).status_code == 413
  apis.sql.inputs_outside.return_value = [7]
  response = create({'project': 'a', 'name': 'x', 'inputs': [1, 7]})
  assert (response.status_code, response.get_json()['reason']) == (400, 'unknown_inputs')
  apis.sql.name_taken.return_value = 3
  response = create({'project': 'a', 'name': 'x', 'inputs': [1]})
  assert (response.status_code, response.get_json()) == (409, {'error': 'a already has a collection named x.', 'reason': 'name_taken', 'id': 3})
  apis.sql.project_exists.return_value = False
  assert create({'project': 'a', 'name': 'x', 'inputs': []}).status_code == 404
  apis.sql.create_collection.assert_not_called()
  apis.user['is_authenticated'] = False
  assert create({'project': 'a', 'name': 'x', 'inputs': []}).status_code == 401


def test_read_with_a_version(apis, dummy_app):
  apis.sql.versions_of.return_value = [version_row(2), version_row(1)]
  data = call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?version=1').get_json()
  assert data['version']['version'] == 1 and [v['version'] for v in data['versions']] == [2, 1]
  assert data['version']['created_by'] == {'id': 2, 'user_name': 'bob', 'full_name': 'Bob B'}
  response = call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?version=9')
  assert (response.status_code, response.get_json()['reason']) == (404, 'version_not_found')
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?version=x').status_code == 400


def test_collections_are_seen_from_their_project_and_subprojects(apis, dummy_app):
  apis.sql.versions_of.return_value = []
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?project=a/b').get_json()['ref'] == 'a:night/hard'
  # a/b's collection, from a: not found
  apis.sql.collection_by_id.return_value = collection_row(project_id='a/b')
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?project=a').status_code == 404
  # a subproject bob can't read, an ancestor's collection: 403 before anything
  apis.sql.collection_by_id.return_value = collection_row()
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3?project=a/secret').status_code == 403
  # without ?project=, the collection's project
  apis.sql.collection_by_id.return_value = collection_row(project_id='other')
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3').status_code == 403
  apis.sql.collection_by_id.return_value = None
  assert call(dummy_app, apis.collections.read_collection, 3, url='/api/v1/collections/3').status_code == 404


def test_collection_inputs(apis, dummy_app):
  apis.sql.members.return_value = {'inputs': [{'id': 5, 'database': '/d', 'path': 'x.png', 'data': {}, 'runs': 0, 'position': 0}], 'total': 1}
  data = call(dummy_app, apis.collections.collection_inputs, 3, url='/api/v1/collections/3/inputs?project=a/b&q=x&limit=5').get_json()
  assert (data['total'], data['version'], data['limit'], data['inputs'][0]['position']) == (1, 2, 5, 0)
  assert apis.sql.members.call_args[0] == (12, ['a/b'], ['x'], 5, 0)
  # their thumbnails, seen from the project asked about
  assert data['inputs'][0]['thumbnail_url'] == '/api/v1/inputs/5/thumbnail?project=a%2Fb'


def test_save_a_version(apis, dummy_app):
  apis.sql.add_version.return_value = 3
  apis.sql.member_ids.return_value = {9}
  apis.sql.version_of.side_effect = lambda collection_id, version: version_row(version)
  apis.sql.inputs_outside.return_value = [9]
  body = {'inputs': [9, 5], 'base_version': 2, 'notes': 'more'}
  response = call(dummy_app, apis.collections.save_version, 3, url='/api/v1/collections/3/versions', method='POST', json=body)
  assert response.status_code == 201
  # 9 was already in the collection
  assert apis.sql.add_version.call_args[0] == (3, 2, [9, 5], 'more', 2)
  assert response.get_json()['version']['version'] == 3


def test_stale_versions(apis, dummy_app):
  def save(body):
    return call(dummy_app, apis.collections.save_version, 3, url='/api/v1/collections/3/versions', method='POST', json=body)
  response = save({'inputs': [1], 'base_version': 1})
  assert (response.status_code, response.get_json()['reason'], response.get_json()['latest_version']) == (409, 'stale_version', 2)
  from backend.input_catalog import StaleVersion
  apis.sql.add_version.side_effect = StaleVersion(3)
  response = save({'inputs': [1], 'base_version': 2})
  assert (response.status_code, response.get_json()['latest_version']) == (409, 3)
  apis.db.rollback.assert_called_once()
  assert save({'inputs': [1]}).status_code == 400


def test_only_developers_save_versions(apis, dummy_app):
  apis.sql.collection_by_id.return_value = collection_row(project_id='a/b')
  response = call(dummy_app, apis.collections.save_version, 3, url='/api/v1/collections/3/versions', method='POST', json={'inputs': [1], 'base_version': 2})
  assert response.status_code == 403
  assert ('a/b', 'collections.write') in apis.permissions.checked
  apis.sql.add_version.assert_not_called()


def test_edit(apis, dummy_app):
  def edit(body):
    return call(dummy_app, apis.collections.edit_collection, 3, url='/api/v1/collections/3', method='PATCH', json=body)
  assert edit({'name': 'night/harder', 'description': 'x', 'archived': True}).status_code == 200
  assert apis.sql.update_collection.call_args[0] == (3, {'name': 'night/harder', 'description': 'x', 'archived': True})
  assert edit({'archived': 'yes'}).status_code == 400
  apis.sql.name_taken.return_value = 4
  assert edit({'name': 'taken'}).status_code == 409
  # renaming to its own name
  assert edit({'name': 'night/hard'}).status_code == 200


def test_favorites(apis, dummy_app):
  response = call(dummy_app, apis.collections.favorite_collection, 3, url='/api/v1/collections/3/favorite?project=a/b', method='PUT')
  assert response.get_json() == {'id': 3, 'favorite': True}
  assert apis.sql.set_favorite.call_args[0] == (2, 3, True)
  response = call(dummy_app, apis.collections.favorite_collection, 3, url='/api/v1/collections/3/favorite', method='DELETE')
  assert apis.sql.set_favorite.call_args[0] == (2, 3, False)


def test_pins_for_a_group(apis, dummy_app, monkeypatch):
  def pin(group, method='PUT', url='/api/v1/collections/3/pins'):
    return call(dummy_app, apis.collections.pin_collection, 3, url=url, method=method, json={'group': group} if group != 'none' else None)
  apis.sql.group_exists.return_value = True
  # bob isn't in group 5
  assert pin(5).status_code == 403
  apis.sql.group_ids_of.return_value = [5]
  events = []
  monkeypatch.setattr(apis.collections, 'audit', lambda action, *args, **kwargs: events.append(action))
  apis.sql.set_pin.return_value = True
  assert pin(5).status_code == 200
  assert apis.sql.set_pin.call_args[0] == (3, 5, True, 2)
  assert events == ['collection.pin']
  # already pinned: nothing changed, no event
  apis.sql.set_pin.return_value = False
  assert pin(5).status_code == 200 and events == ['collection.pin']
  apis.sql.set_pin.return_value = True
  # the group in the query string, for DELETE
  assert pin('none', 'DELETE', '/api/v1/collections/3/pins?group=5').status_code == 200
  assert apis.sql.set_pin.call_args[0] == (3, 5, False, 2)
  assert pin('none').status_code == 400
  apis.sql.group_exists.return_value = False
  assert pin(5).status_code == 404


def test_pins_for_everyone_are_for_owners(apis, dummy_app):
  response = call(dummy_app, apis.collections.pin_collection, 3, url='/api/v1/collections/3/pins', method='PUT', json={'group': None})
  assert response.status_code == 403
  assert ('a', 'project.access') in apis.permissions.checked
  apis.permissions.grant('a', 'project.access')
  response = call(dummy_app, apis.collections.pin_collection, 3, url='/api/v1/collections/3/pins?group=', method='DELETE')
  assert response.status_code == 200
  assert apis.sql.set_pin.call_args[0] == (3, None, False, 2)


def test_resolve(apis, dummy_app):
  apis.sql.find_collection.return_value = collection_row()
  apis.sql.member_refs.return_value = [{'id': 5, 'database': '/d', 'path': 'x.png'}]
  data = call(dummy_app, apis.collections.resolve_collection, url='/api/v1/collections/resolve?project=a/b&ref=night/hard@1').get_json()
  assert apis.sql.find_collection.call_args[0] == (['a/b', 'a'], 'night/hard')
  assert (data['version'], data['project'], data['ref'], data['name']) == (1, 'a', 'a:night/hard@1', 'night/hard')
  assert data['inputs'] == [{'id': 5, 'database': '/d', 'path': 'x.png'}]
  assert data['collection']['id'] == 3
  assert apis.sql.member_refs.call_args[0] == (11,)
  # latest
  assert call(dummy_app, apis.collections.resolve_collection, url='/api/v1/collections/resolve?project=a&ref=night/hard').get_json()['version'] == 2


def test_resolve_errors(apis, dummy_app):
  def resolve(query):
    return call(dummy_app, apis.collections.resolve_collection, url=f'/api/v1/collections/resolve?{query}')
  apis.sql.find_collection.return_value = None
  response = resolve('project=a/b&ref=nope')
  assert (response.status_code, response.get_json()['error']) == (404, 'No collection named nope in a/b, a.')
  assert resolve('project=a&ref=bad:name:x').status_code == 400
  assert resolve('ref=nope').status_code == 400
  assert resolve('project=other&ref=nope').status_code == 403
  # a project named explicitly, that isn't an ancestor: its own readers only
  assert resolve('project=a&ref=other:nope').status_code == 403
  assert resolve('ref=a:nope').status_code == 404
  apis.sql.find_collection.return_value = collection_row()
  assert resolve('project=a&ref=night/hard@7').get_json()['reason'] == 'version_not_found'


def test_export(apis, dummy_app):
  response = call(dummy_app, apis.collections.export_collection, 3, url='/api/v1/collections/3/export.yaml?project=a/b&version=2')
  assert response.mimetype == 'text/yaml'
  assert 'collections:\n  - a:night/hard@2\n' in response.get_data(as_text=True)
  response = call(dummy_app, apis.collections.export_collection, 3, url='/api/v1/collections/3/export.yaml')
  assert 'collections:\n  - night/hard\n' in response.get_data(as_text=True)


def test_the_server_resolves_collections_in_process(apis, dummy_app):
  # api/tuning.py lists batches with qaboard.iterators: their `collections` resolve without a request to ourselves
  pytest.importorskip('qaboard.input_collections')
  from qaboard.input_collections import CollectionNotFound, CollectionError
  apis.sql.find_collection.return_value = collection_row()
  apis.sql.member_refs.return_value = [{'id': 5, 'database': '/d', 'path': 'x.png'}]
  resolve = apis.collections.in_process_resolver('a/b')
  with dummy_app.test_request_context('/api/v1/tests/group?project=a/b', method='POST'):
    # the project of the batch's listing wins over what qaboard.yaml says
    collection = resolve('night/hard@1', 'elsewhere')
    assert (collection.version, collection.project, collection.name, collection.id) == (1, 'a', 'night/hard', 3)
    assert [(i.database, i.path) for i in collection.inputs] == [('/d', 'x.png')]
    assert apis.sql.find_collection.call_args[0] == (['a/b', 'a'], 'night/hard')
    apis.sql.find_collection.return_value = None
    with pytest.raises(CollectionNotFound, match='No collection named nope'):
      resolve('nope', None)
    with pytest.raises(CollectionError, match='Forbidden'):
      apis.collections.in_process_resolver('other')('night/hard', None)
