"""
Tests for the backend API image endpoints.

Uses Flask's test client for fast, isolated tests without requiring a running server.
Mocks the image cache directory to use a temp directory for clean test runs.
"""
import json
import shutil
import tempfile
import concurrent.futures
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

# their files are in the temporary folder (see conftest.py)
pytestmark = pytest.mark.usefixtures('storage_in_tmp')



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

@pytest.fixture
def get_pixel(cache_dir, dummy_app):
  """Factory fixture that returns configured get_pixel function."""

  def _pixel_fetcher(x, y, image_path):
    """Helper to make a pixel request via Flask test context."""
    import backend.api.image as image_api
    # Use patch.object() to safely mock the attributes on the imported module
    with patch.object(image_api, 'image_cache_dir', cache_dir):
      url = f'/api/v1/output/image/pixel?x={x}&y={y}&image_url=/s{image_path}'
      with dummy_app.test_request_context(url, method='GET'):
        return image_api.get_pixel()

  return _pixel_fetcher

def test_get_pixel_returns_200(test_image, get_pixel):
  """A valid pixel request returns 200."""
  response = get_pixel(1, 1, test_image)
  assert response.status_code == 200


def test_get_pixel_returns_correct_value(test_image, get_pixel):
  """The returned pixel value matches the image data."""
  response = get_pixel(5, 5, test_image)
  assert response.status_code == 200
  data = json.loads(response.data)
  # image[y, x] — at y=4, x=4: (4%256, 4%256, 8%256) = (4, 4, 8)
  assert data['value'] == [5, 5, 10]

def test_get_pixel_returns_404_for_missing_image(dummy_app):
  """Requesting a non-existent image returns 404."""
  url = '/api/v1/output/image/pixel?x=1&y=1&image_url=/s/tmp/nonexistent/image.png'  
  import backend.api.image as image_api  
  with dummy_app.test_request_context(url, method='GET'):
    response = image_api.get_pixel()
    assert response[1] == 404


def test_concurrent_pixel_requests(dummy_app, test_image, cache_dir):
  """
  100 concurrent pixel requests should all return 200 with no crashes.
  Verifies the fix for the race condition in the image cache layer.
  """
  import backend.api.image as image_api
  
  results = []
  errors = []

  def fetch_pixel(i):
    try:
      url = f'/api/v1/output/image/pixel?x={100 + i}&y={100 + i}&image_url=/s{test_image}'
      
      # Flask's request contexts are naturally thread-local. 
      # Opening this here safely isolates this request to this thread.
      with dummy_app.test_request_context(url, method='GET'):
          response = image_api.get_pixel() 
          return response.status_code
    except Exception as e:
      return e

  # Patch outside the thread pool so the mock state never changes
  with patch.object(image_api, 'image_cache_dir', cache_dir):
      with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
        # Submit all tasks
        futures = [executor.submit(fetch_pixel, i) for i in range(100)]
          
        # Process results as they complete safely
        for future in concurrent.futures.as_completed(futures):
          res = future.result()
          if isinstance(res, Exception):
            errors.append(str(res))
          else:
            results.append(res)

  assert len(errors) == 0, f"Errors: {errors[:5]}"
  failed = [s for s in results if s != 200]
  assert len(failed) == 0, f"Failed requests: {failed[:5]}"
  assert len(results) == 100


@pytest.fixture
def get_pixels(cache_dir, dummy_app):
  """Requests the values of a region of an image"""
  def _fetch(image_path, **params):
    import backend.api.image as image_api
    query = '&'.join(f'{k}={v}' for k, v in params.items())
    with patch.object(image_api, 'image_cache_dir', cache_dir):
      with dummy_app.test_request_context(f'/api/v1/output/image/pixels?image_url=/s{image_path}&{query}', method='GET'):
        response = image_api.get_pixels()
        if isinstance(response, tuple):
          return response[1], json.loads(response[0].data)
        return response.status_code, json.loads(response.data)
  return _fetch


def test_get_pixels_returns_the_region(test_image, get_pixels):
  """Rows, then pixels, then channels: like image[y:y+h, x:x+w]"""
  status, data = get_pixels(test_image, x=10, y=20, w=3, h=2)
  assert status == 200
  # pixels[i, j] = (i, j, i + j) with i the column
  assert data['values'] == [
    [[10, 20, 30], [11, 20, 31], [12, 20, 32]],
    [[10, 21, 31], [11, 21, 32], [12, 21, 33]],
  ]
  assert data['meta'] == {'mode': 'RGB'}
  assert (data['width'], data['height']) == (200, 200)


def test_get_pixels_cuts_the_region_at_the_edges(test_image, get_pixels):
  status, data = get_pixels(test_image, x=198, y=199, w=5, h=5)
  assert status == 200
  assert data['values'] == [[[198, 199, 141], [199, 199, 142]]]


def test_get_pixels_reads_gray_images(tmp_path, get_pixels):
  path = tmp_path / 'gray.png'
  image = Image.new('I;16', (4, 3))
  image.putdata([1000 * i for i in range(12)])
  image.save(path)
  status, data = get_pixels(path, x=1, y=1, w=2, h=1)
  assert status == 200
  assert data['values'] == [[5000, 6000]]


@pytest.mark.parametrize('params', [
  dict(x=-1, y=0, w=1, h=1),
  dict(x=0, y=0, w=0, h=1),
  dict(x=0, y=0, w=1000, h=1000),
  dict(x='a', y=0, w=1, h=1),
  dict(y=0, w=1, h=1),
])
def test_get_pixels_rejects_invalid_regions(test_image, get_pixels, params):
  status, data = get_pixels(test_image, **params)
  assert status == 400
  assert 'error' in data


def test_get_pixels_404_for_missing_images(get_pixels, tmp_path):
  status, data = get_pixels(tmp_path / 'nonexistent.png', x=0, y=0, w=1, h=1)
  assert status == 404


def test_get_pixels_only_reads_the_storage(get_pixels, test_image, monkeypatch):
  # outside the storage, also with ".." or in the server's own folders: refused before reading, or saying if it exists
  for path in [Path('/etc/passwd'), Path(f'{test_image.parent}/../../etc/hostname'), Path('/nonexistent/image.png')]:
    status, data = get_pixels(path, x=0, y=0, w=1, h=1)
    assert status == 403, path
    assert 'storage' in data['error']
  import backend.files as files
  monkeypatch.setattr(files, 'private_dirs', lambda: [test_image.parent])
  assert get_pixels(test_image, x=0, y=0, w=1, h=1)[0] == 403


def test_get_pixels_rejects_regions_outside_the_image(test_image, get_pixels):
  status, data = get_pixels(test_image, x=200, y=0, w=1, h=1)
  assert status == 400
  assert 'outside' in data['error']


def test_get_pixels_binary(test_image, cache_dir, dummy_app):
  """format=binary: the values, little-endian, with their type and shape in the headers"""
  import numpy as np
  import backend.api.image as image_api
  with patch.object(image_api, 'image_cache_dir', cache_dir):
    with dummy_app.test_request_context(f'/api/v1/output/image/pixels?image_url=/s{test_image}&x=10&y=20&w=3&h=2&format=binary'):
      response = image_api.get_pixels()
  assert response.status_code == 200
  assert response.headers['X-Pixels-Dtype'] == 'uint8'
  assert response.headers['X-Pixels-Shape'] == '2,3,3'
  assert response.headers['X-Pixels-Mode'] == 'RGB'
  assert (response.headers['X-Image-Width'], response.headers['X-Image-Height']) == ('200', '200')
  values = np.frombuffer(response.data, dtype='<u1').reshape(2, 3, 3)
  assert values[1, 2].tolist() == [12, 21, 33]


def test_javascript_types():
  """Types that JavaScript's typed arrays can't read are converted"""
  import numpy as np
  from backend.api.image import _for_javascript
  assert _for_javascript(np.zeros((2, 2), dtype='>u2')).dtype.str == '<u2'
  assert _for_javascript(np.zeros((2, 2), dtype=np.int64)).dtype.name == 'float64'
  assert _for_javascript(np.zeros((2, 2), dtype=np.float16)).dtype.name == 'float32'
  assert _for_javascript(np.zeros((2, 2), dtype=bool)).dtype.name == 'uint8'
  # a column of a bigger image is contiguous once converted
  assert _for_javascript(np.zeros((4, 4), dtype=np.uint8)[:, 1:3]).flags['C_CONTIGUOUS']


def test_decoded_images_are_cached(tmp_path, cache_dir):
  """Images are decoded once, then read from the cache, even by a new process"""
  import backend.api.image as image_api
  path = tmp_path / 'image.png'
  Image.new('L', (8, 4), color=7).save(path)
  with patch.object(image_api, 'image_cache_dir', cache_dir):
    with patch.object(image_api, 'read_image', wraps=image_api.read_image) as read_image:
      first, meta = image_api.decoded_image(path)
      image_api._opened.clear() # like another process
      second, _ = image_api.decoded_image(path)
      assert read_image.call_count == 1
  assert first.shape == second.shape == (4, 8)
  assert int(second[1, 1]) == 7
  assert meta == {'mode': 'L'}
  # no leftovers of the writes
  assert sorted(p.suffix for p in cache_dir.iterdir() if p.suffix != '.lock') == ['.dat', '.json']


def test_cache_removes_the_least_recently_used(tmp_path, cache_dir):
  import os
  import time
  import backend.api.image as image_api
  paths = []
  for i in range(3):
    path = tmp_path / f'{i}.png'
    Image.new('L', (100, 100), color=i).save(path)
    paths.append(path)
  # room for two 100x100 8-bit images
  with patch.object(image_api, 'image_cache_dir', cache_dir), patch.object(image_api, 'image_cache_bytes', 25_000):
    image_api.decoded_image(paths[0])
    image_api.decoded_image(paths[1])
    # the first is used again: the second is now the least recently used
    old = time.time() - 3600
    for data in cache_dir.glob('*.dat'):
      os.utime(data, (old, old))
    image_api._opened.clear()
    image_api.decoded_image(paths[0])
    image_api.decoded_image(paths[2])
    kept = {int(image_api.decoded_image(p)[0][0, 0]) for p in paths[::2]}
  assert kept == {0, 2}
  assert len(list(cache_dir.glob('*.dat'))) == 2


def test_different_images_decode_at_the_same_time(tmp_path, cache_dir):
  """A slow image doesn't hold the others"""
  import time
  import backend.api.image as image_api
  slow, fast = tmp_path / 'slow.png', tmp_path / 'fast.png'
  for path in (slow, fast):
    Image.new('L', (4, 4)).save(path)
  real_read = image_api.read_image
  def read_image(path):
    if path == slow:
      time.sleep(1)
    return real_read(path)
  with patch.object(image_api, 'image_cache_dir', cache_dir), patch.object(image_api, 'read_image', side_effect=read_image):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
      start = time.time()
      slow_future = executor.submit(image_api.decoded_image, slow)
      time.sleep(0.1)
      executor.submit(image_api.decoded_image, fast).result()
      fast_time = time.time() - start
      slow_future.result()
  assert fast_time < 0.8
