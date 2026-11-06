"""The API's description and docs page, on the real app"""
import pytest
from werkzeug.exceptions import NotFound, MethodNotAllowed

from .test_jobs import storage  # noqa: F401 (fixture)


HTTP_METHODS = {'get', 'post', 'put', 'patch', 'delete'}


def test_documented_operations_reach_their_endpoint(app):
  """Each path of openapi.yaml, with placeholder values, is routed for its methods (not to another endpoint's catch-all)"""
  from backend.api.openapi import load_spec
  adapter = app.url_map.bind('localhost')
  spec = load_spec()
  wrong = []
  for path, operations in spec['paths'].items():
    url = '/api/v1' + path.replace('{branch}', 'main').replace('{commit}', '7622c337').replace('{output_id}', '1')
    for method in set(operations) & HTTP_METHODS:
      try:
        endpoint, _ = adapter.match(url, method=method.upper())
      except (NotFound, MethodNotAllowed) as e:
        wrong.append(f"{method.upper()} {url}: {type(e).__name__}")
        continue
      if endpoint in ('api_docs', 'openapi_json'):
        wrong.append(f"{method.upper()} {url}: {endpoint}")
  assert not wrong, wrong


@pytest.mark.parametrize('url', ['/api/v1/openapi.json', '/api/v1/docs/', '/api/v1/docs/swagger-ui.css'])
def test_public_when_sign_in_is_required(client, monkeypatch, url):
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  response = client.get(url)
  assert response.status_code == 200, response.get_data(as_text=True)[:200]


def test_docs_redirects_to_the_page(client):
  response = client.get('/api/v1/docs')
  assert response.status_code == 301
  assert response.headers['Location'].endswith('docs/')


def test_the_document_describes_this_server(client):
  spec = client.get('/api/v1/openapi.json').get_json()
  assert spec['openapi'].startswith('3.1')
  assert spec['servers'][0]['url'] == '/api/v1'
  assert spec['components']['securitySchemes']['bearerAuth']['scheme'] == 'bearer'


def test_documented_shapes_match_the_answers(client, storage):
  """The documented fields of a commit, its batches and runs, a run's files and a comparison are in the API's answers"""
  from backend.api.openapi import load_spec
  from .test_jobs import World
  schemas = load_spec()['components']['schemas']
  world = World(storage)
  reference = world.batch('group/repo', hexsha='b' * 40, branch='main')
  world.run(reference, deleted=False, files=True, size=10)
  new = world.batch('group/repo', hexsha='a' * 40, branch='feature')
  run = world.run(new, deleted=False, files=True, size=10)
  world.commit()

  def documented(schema):
    return set(schemas[schema]['properties'])

  commits = client.get('/api/v1/commits?project=group/repo&with_outputs=true&limit=10')
  assert commits.headers['X-Has-More'] == 'false'
  commit = next(c for c in commits.get_json() if c['id'] == 'a' * 40)
  assert documented('Commit') <= set(commit)
  batch = commit['batches']['default']
  assert documented('Batch') <= set(batch)
  assert documented('Run') <= set(batch['outputs'][str(run.id)])

  commit = client.get(f'/api/v1/commit/{"a" * 8}?project=group/repo').get_json()
  assert documented('Commit') <= set(commit) and 'artifacts' in commit
  assert documented('Run') <= set(client.get(f'/api/v1/output/{run.id}').get_json())
  assert client.get(f'/api/v1/output/{run.id}/manifest').get_json() == {"image.png": {"st_size": 10}}

  comparison = client.get(f'/api/v1/commit/{"a" * 8}/compare?project=group/repo&reference=main').get_json()
  assert documented('Comparison') <= set(comparison)
  assert documented('ComparedCommit') <= set(comparison['commit'])
  assert comparison['reference']['id'] == 'b' * 40 and comparison['reference']['type'] == 'branch'
  assert comparison['status'] == 'complete', comparison['messages']
