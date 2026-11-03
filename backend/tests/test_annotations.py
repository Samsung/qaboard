"""
The annotations of images, from the site's sources (backend/annotations.py)
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.usefixtures('storage_in_tmp')


class Source:
  label = 'Defects'
  description = 'From our app'

  def __init__(self):
    self.calls = []

  def annotations(self, path, md5):
    self.calls.append((path, md5))
    if md5 == 'broken':
      raise ConnectionError('timeout')
    return {
      'groups': [{'id': 12, 'label': 'Night scenes'}],
      'annotations': [{'x': 1, 'y': 2, 'w': 3, 'h': 4, 'group': 12, 'label': 'Noise'}],
    }


@pytest.fixture
def get(tmp_path, dummy_app):
  import backend.annotations as annotations
  import backend.api.annotations as api
  (tmp_path / 'out.png').write_bytes(b'image')
  source = Source()
  annotations.annotation_sources.cache_clear()
  entry_point = SimpleNamespace(name='defects', load=lambda: source)

  def _get(source_id='defects', path='out.png', **args):
    with patch.object(annotations, 'site_entry_points', lambda group: [entry_point]), \
         patch('backend.hybrid_cache.redis_client') as redis:
      redis.get.return_value = None
      annotations.annotation_sources.cache_clear()
      query = {'output_dir_url': f'/s{tmp_path}', 'path': path, **args}
      with dummy_app.test_request_context('/api/v1/output/image/annotations', query_string=query):
        response = api.get_annotations(source_id)
        if isinstance(response, tuple):
          response, status = response
          response.status_code = status
        return response
  _get.source = source
  return _get


def test_annotations_of_an_image(get):
  response = get(md5='abc')
  assert response.status_code == 200
  assert response.get_json() == {
    'groups': [{'id': '12', 'label': 'Night scenes'}],
    'annotations': [{'id': '0', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'group': '12', 'label': 'Noise'}],
  }
  path, md5 = get.source.calls[0]
  assert path.endswith('/out.png') and md5 == 'abc'


def test_errors(get):
  assert get(source_id='unknown').status_code == 404
  assert get(path='missing.png').status_code == 404
  broken = get(md5='broken')
  assert broken.status_code == 502
  assert 'Defects' in broken.get_json()['error'] and 'timeout' in broken.get_json()['error']


def test_sources_for_the_web_app():
  import backend.annotations as annotations
  entry_point = SimpleNamespace(name='defects', load=Source)
  with patch.object(annotations, 'site_entry_points', lambda group: [entry_point]):
    annotations.annotation_sources.cache_clear()
    assert annotations.describe_sources() == [{'id': 'defects', 'label': 'Defects', 'description': 'From our app', 'group_noun': None}]
  annotations.annotation_sources.cache_clear()
