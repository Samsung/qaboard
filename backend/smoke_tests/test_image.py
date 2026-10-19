"""
Tests for the backend API image endpoints.

Uses Flask's test client for fast, isolated tests without requiring a running server.
Mocks the image cache directory to use a temp directory for clean test runs.
The endpoints need a signed-in user, and only read the files in the storage: the requests are made as a
signed-in user, and the temporary folder is the storage (see storage_in_tmp in conftest.py).
"""
import json
import shutil
import tempfile
import concurrent.futures
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from backend import app

pytestmark = pytest.mark.usefixtures('storage_in_tmp', 'signed_in')


@pytest.fixture
def signed_in():
  """The requests are made by a signed-in user, who may access all the projects."""
  user = {"is_authenticated": True, "user_name": "smoke-tests", "user_id": None}
  with patch('backend.api.auth.get_current_user', return_value=user), \
       patch('backend.api.files.get_current_user', return_value=user), \
       patch('backend.api.auth.is_login_restricted', False):
    yield


@pytest.fixture(scope='module')
def test_image():
  """Create a small test PNG image once for all tests."""
  temp_dir = tempfile.mkdtemp()
  image = Image.new('RGB', (200, 200))
  pixels = image.load()
  for i in range(200):
    for j in range(200):
      pixels[i, j] = (i % 256, j % 256, (i + j) % 256)
  path = Path(temp_dir) / 'test_image.png'
  image.save(path)
  yield path
  shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def cache_dir(tmp_path):
  """Fresh empty cache directory for each test."""
  d = tmp_path / 'cache'
  d.mkdir()
  return d


def get_pixel(x, y, image_path, cache_dir):
  """Helper to make a pixel request via Flask test client."""
  with patch('backend.api.image.image_cache_dir', cache_dir):
    with app.test_client() as client:
      return client.get(
        f'/api/v1/output/image/pixel?x={x}&y={y}&image_url=/s{image_path}'
      )


def test_get_pixel_returns_200(test_image, cache_dir):
  """A valid pixel request returns 200."""
  response = get_pixel(1, 1, test_image, cache_dir)
  assert response.status_code == 200


def test_get_pixel_returns_correct_value(test_image, cache_dir):
  """The returned pixel value matches the image data."""
  response = get_pixel(5, 5, test_image, cache_dir)
  assert response.status_code == 200
  data = json.loads(response.data)
  # image[y, x] — at y=4, x=4: (4%256, 4%256, 8%256) = (4, 4, 8)
  assert data['value'] == [5, 5, 10]

def test_get_pixel_returns_404_for_missing_image(test_image, cache_dir):
  """Requesting a non-existent image returns 404."""
  response = get_pixel(1, 1, test_image.parent / 'nonexistent.png', cache_dir)
  assert response.status_code == 404


def test_concurrent_pixel_requests(test_image, cache_dir):
  """
  100 concurrent pixel requests should all return 200 with no crashes.
  Verifies the fix for the race condition in the image cache layer.
  """
  results = []
  errors = []

  def fetch_pixel(i):
    try:
      # each thread gets its own test client — Flask test client is not thread-safe
      with app.test_client() as client:
        response = client.get(
          f'/api/v1/output/image/pixel?x={100 + i}&y={100 + i}&image_url=/s{test_image}'
        )
        results.append(response.status_code)
    except Exception as e:
      errors.append(str(e))

  # patched once for all the threads: patches entered and exited by each thread would undo each other
  with patch('backend.api.image.image_cache_dir', cache_dir):
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
      futures = [executor.submit(fetch_pixel, i) for i in range(100)]
      concurrent.futures.wait(futures)

  assert len(errors) == 0, f"Errors: {errors[:5]}"
  failed = [s for s in results if s != 200]
  assert len(failed) == 0, f"Failed requests: {failed[:5]}"
  assert len(results) == 100
