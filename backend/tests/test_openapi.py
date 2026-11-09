"""The OpenAPI document (backend/openapi.yaml) is valid, and describes routes that exist"""
import re
from pathlib import Path

import pytest
import yaml

BACKEND = Path(__file__).resolve().parent.parent / 'backend'
HTTP_METHODS = {'get', 'post', 'put', 'patch', 'delete'}


def load():
  with (BACKEND / 'openapi.yaml').open(encoding='utf-8') as f:
    return yaml.safe_load(f)


def source_routes():
  """{(path with {} for parameters, method)} for the @app.route of the API's modules"""
  routes = set()
  decorator = re.compile(r"""@app\.route\(\s*["']([^"']+)["']\s*(?:,\s*methods\s*=\s*\[([^\]]*)\])?""")
  for module in (BACKEND / 'api').glob('*.py'):
    for path, methods in decorator.findall(module.read_text(encoding='utf-8')):
      methods = re.findall(r"""["'](\w+)["']""", methods) or ['GET']
      for method in methods:
        routes.add((re.sub(r'<(?:[^:<>]+:)?[^<>]+>', '{}', path), method.lower()))
  return routes


def test_the_document_is_valid_openapi():
  validator = pytest.importorskip('openapi_spec_validator')
  validator.validate(load())


def test_documented_paths_are_routes():
  spec = load()
  routes = source_routes()
  base = spec['servers'][0]['url']
  missing = []
  for path, operations in spec['paths'].items():
    for method in set(operations) & HTTP_METHODS:
      route = (re.sub(r'\{[^}]+\}', '{}', base + path), method)
      if route not in routes:
        missing.append(f"{method.upper()} {base}{path}")
  assert not missing, f"Documented, but not routes of backend/api/: {missing}"


def test_operations_have_ids_summaries_and_tags():
  spec = load()
  tags = {t['name'] for t in spec['tags']}
  ids = []
  for path, operations in spec['paths'].items():
    for method in set(operations) & HTTP_METHODS:
      operation = operations[method]
      assert operation.get('summary'), f"{method} {path}"
      assert set(operation.get('tags', [])) <= tags and operation.get('tags'), f"{method} {path}"
      ids.append(operation['operationId'])
  assert len(ids) == len(set(ids))


def test_served_with_this_servers_address(dummy_app):
  from backend.api.openapi import openapi_json
  with dummy_app.test_request_context('/api/v1/openapi.json', headers={'X-Forwarded-Prefix': '/qaboard/'}):
    response = openapi_json()
  spec = response.get_json()
  assert spec['servers'][0]['url'] == '/qaboard/api/v1'
  assert spec['info']['title'] == 'QA-Board API'
  assert '/commit/{commit}/compare' in spec['paths']


def test_docs_page(dummy_app):
  from backend.api.openapi import api_docs, swagger_ui_dist
  with dummy_app.test_request_context('/api/v1/docs/'):
    response = api_docs()
  page = response.get_data(as_text=True)
  assert response.mimetype == 'text/html'
  # relative: works behind a path prefix
  assert 'url: "../openapi.json"' in page
  if swagger_ui_dist() is not None:
    assert 'src="./swagger-ui-bundle.js"' in page
    with dummy_app.test_request_context('/api/v1/docs/swagger-ui-bundle.js'):
      asset = api_docs('swagger-ui-bundle.js')
      asset.direct_passthrough = False
      assert asset.status_code == 200 and 'javascript' in asset.mimetype
      asset.close()
  else:
    assert 'cdn.jsdelivr.net' in page
