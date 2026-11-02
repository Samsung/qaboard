"""
Tests for the regions where two images differ (backend/api/image_diff.py), and their endpoint.
"""
import json
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image

from backend.api.image_diff import block_reduce, difference_map, find_regions, value_scale, yiq_distance

# their files are in the temporary folder (see conftest.py)
pytestmark = pytest.mark.usefixtures('storage_in_tmp')



def gradient(height, width):
  y, x = np.mgrid[0:height, 0:width]
  return np.stack([x * 255 // width, y * 255 // height, np.full_like(x, 128)], axis=2).astype(np.uint8)


def with_square(image, x, y, size, color=(20, 20, 20)):
  changed = image.copy()
  changed[y:y + size, x:x + size] = color
  return changed


def regions_of(image_1, image_2, method='yiq', count=20):
  delta, factor = difference_map(image_1, image_2, method)
  return find_regions(delta, factor, image_1.shape, count)


def contains(region, x, y):
  return region['x'] <= x < region['x'] + region['w'] and region['y'] <= y < region['y'] + region['h']


def test_identical_images_have_no_regions():
  image = gradient(300, 400)
  assert regions_of(image, image) == []


@pytest.mark.parametrize('method', ['yiq', 'ssim', 'ciede2000'])
def test_finds_where_images_differ(method):
  image = gradient(600, 800)
  changed = with_square(image, 500, 100, 40)
  regions = regions_of(changed, image, method)
  assert regions
  first = regions[0]
  assert contains(first, 520, 120)
  assert first['diff'] == 1
  assert 0 <= first['x'] and first['x'] + first['w'] <= 800 and first['y'] + first['h'] <= 600
  # the region fits the difference, with some context, not the whole image
  assert first['w'] < 400 and first['h'] < 300
  assert all(r['value'] <= first['value'] for r in regions)


def test_values_are_comparable_across_images():
  image = gradient(400, 400)
  light = regions_of(with_square(image, 100, 100, 30, (60, 60, 60)), image)[0]['value']
  dark = regions_of(with_square(image, 100, 100, 30, (0, 0, 0)), image)[0]['value']
  assert 0 < light < 1 and 0 < dark < 1
  # the largest of the image viewer's perceptual difference, pixel by pixel
  square = image[100:130, 100:130].astype(np.float32)
  assert dark == pytest.approx(float(yiq_distance(np.zeros_like(square), square).max()), rel=1e-3)


def test_small_differences_in_large_images_are_found():
  # 4000x3000: a cell of the working grid is 4x4 pixels, but a 3x3 difference still shows
  image = gradient(3000, 4000)
  changed = with_square(image, 3210, 2470, 3, (255, 0, 0))
  regions = regions_of(changed, image)
  assert regions and contains(regions[0], 3211, 2471)
  assert regions[0]['w'] < 600


def test_several_regions_largest_first():
  image = gradient(800, 800)
  changed = with_square(with_square(image, 100, 100, 30, (120, 120, 120)), 600, 600, 30, (0, 0, 0))
  regions = regions_of(changed, image)
  assert len(regions) >= 2
  assert contains(regions[0], 615, 615)
  assert contains(regions[1], 115, 115)
  assert regions[1]['diff'] < 1


def test_regions_are_spread_out():
  # a large area that differs everywhere (e.g. leaves), and one smaller difference elsewhere
  image = gradient(800, 1200)
  changed = image.copy()
  noise = np.random.default_rng(0).integers(0, 256, (300, 400, 3), dtype=np.uint8)
  changed[0:300, 0:400] = noise
  changed = with_square(changed, 900, 600, 30, (60, 60, 60))
  regions = regions_of(changed, image)
  # not twenty views of the noise: the square is among the first
  assert any(contains(r, 915, 615) for r in regions[:5])
  # and they show some context
  assert all(r['w'] >= 150 and r['h'] >= 150 for r in regions)


def test_gray_16_bit_and_rgba_images():
  gray = (np.mgrid[0:300, 0:300][1] * 200).astype(np.uint16)
  changed = gray.copy()
  changed[50:70, 200:220] = 0
  assert contains(regions_of(changed, gray)[0], 210, 60)
  assert value_scale(gray) == pytest.approx(255 / 65535)

  rgba = np.dstack([gradient(200, 200), np.full((200, 200), 255, np.uint8)])
  changed = rgba.copy()
  changed[20:40, 20:40, :3] = 0
  assert contains(regions_of(changed, rgba)[0], 30, 30)


def test_value_scales():
  assert value_scale(np.zeros((4, 4), np.uint8)) == 1
  ten_bits = np.full((32, 32), 1000, np.uint16)
  assert value_scale(ten_bits) == pytest.approx(255 / 1023)
  assert value_scale(np.full((32, 32), 0.5, np.float32)) == 255
  assert value_scale(np.full((32, 32), 200.0, np.float32)) == 1


def test_block_reduce_pads_partial_blocks():
  array = np.arange(25, dtype=np.float32).reshape(5, 5)
  assert block_reduce(array, 2, np.max).tolist() == [[6, 8, 9], [16, 18, 19], [21, 23, 24]]
  assert block_reduce(array, 1, np.max) is array


# --- the endpoint ---

@pytest.fixture
def runs(tmp_path):
  """Two runs' output directories, with an image that differs"""
  image = gradient(300, 400)
  new, ref = tmp_path / 'new', tmp_path / 'ref'
  for directory, array in ((new, with_square(image, 300, 200, 20)), (ref, image)):
    directory.mkdir()
    Image.fromarray(array).save(directory / 'out.png')
  Image.fromarray(gradient(100, 100)).save(ref / 'small.png')
  Image.fromarray(gradient(300, 400)).save(ref / 'other.png')
  return {'/s/new': f'/s{new}', '/s/ref': f'/s{ref}'}


@pytest.fixture
def find(runs, tmp_path, dummy_app):
  import backend.api.image as image_api
  cache = tmp_path / 'cache'
  (cache / 'regions').mkdir(parents=True)

  def _find(**body):
    data = {'output_dir_url_new': runs['/s/new'], 'output_dir_url_ref': runs['/s/ref'], 'path': 'out.png', 'diff_type': 'yiq', **body}
    with patch.object(image_api, 'image_cache_dir', cache), \
         patch.object(image_api, 'regions_cache_dir', cache / 'regions'), \
         patch.object(image_api, 'read_image', wraps=image_api.read_image) as read_image:
      with dummy_app.test_request_context('/api/v1/output/image/diff', method='POST', json=data):
        response = image_api.get_rois()
        if isinstance(response, tuple):
          response, status = response
          response.status_code = status
        response.decodes = read_image.call_count
        return response
  return _find


def test_endpoint_finds_regions_and_keeps_them(find):
  response = find(count=5)
  assert response.status_code == 200
  assert response.headers['X-Regions-Cache'] == 'miss'
  regions = json.loads(response.get_data())
  assert contains(regions[0], 310, 210)
  assert len(regions) <= 5
  again = find(count=5)
  assert again.headers['X-Regions-Cache'] == 'hit'
  assert again.decodes == 0
  assert json.loads(again.get_data()) == regions


def test_endpoint_reads_each_image_once(find):
  find(diff_type='yiq')
  # another method on the same images: they're decoded already
  assert find(diff_type='ssim').decodes == 0


def test_endpoint_errors(find):
  missing = find(path='missing.png')
  assert missing.status_code == 404
  assert 'missing.png' in missing.get_json()['error']
  different = find(path_ref='small.png')
  assert different.status_code == 400
  assert 'different sizes' in different.get_json()['error']
  assert find(diff_type='psnr').status_code == 400


def test_endpoint_compares_with_another_file_of_the_reference(find):
  # same image as new except the square: path_ref names the reference's file
  regions = json.loads(find(path_ref='other.png').get_data())
  assert contains(regions[0], 310, 210)
