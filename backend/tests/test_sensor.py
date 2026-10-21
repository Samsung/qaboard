"""What image readers say about the sensor of raw images (backend/sensor.py), and the pixels API that passes it on"""
import json
from unittest.mock import patch

import numpy as np
import pytest

from backend.sensor import sensor_info

pytestmark = pytest.mark.usefixtures('storage_in_tmp')

# cde's read_image metadata for a crop of a 16-cell raw image
CDE_META = {
  "fullWidth": 7296, "fullHeight": 5472, "width": 192, "height": 192, "imageType": "UI10", "channels": "",
  "floatingpoint": "", "precision": 0, "offsetX": 600, "offsetY": 3264, "headerSize": 0, "bits": 0, "pedestal": 0,
  "mask": -1, "pattern": "GBRG", "samplePerPixel": "4x4", "packingCount": 0, "isBW": False, "isYUV": False,
  "isFloat": False, "exposureOrderRed": False, "MinValue": 0.0, "MaxValue": 0.0, "scale": 0, "notes": "",
}


def test_cde_metadata():
  info = sensor_info(CDE_META)
  assert info['cfa'] == {'pattern': 'GBRG', 'block': 4}
  assert info['bit_depth'] == 10
  assert info['white_level'] == 1023
  # a pedestal of 0 is "not set"
  assert 'black_level' not in info
  assert info['crop'] == {'x': 600, 'y': 3264, 'full_width': 7296, 'full_height': 5472}
  assert info['fields']['pattern'] == 'GBRG'
  assert info['fields']['samplePerPixel'] == '4x4'
  assert info['fields']['imageType'] == 'UI10'
  assert 'mono' not in info


def test_black_level_and_other_names():
  info = sensor_info({"bayer_pattern": "rggb", "cfa_block": 2, "bit_depth": 12, "black_level": 256})
  assert info['cfa'] == {'pattern': 'RGGB', 'block': 2}
  assert (info['bit_depth'], info['white_level'], info['black_level']) == (12, 4095, 256)
  assert sensor_info({**CDE_META, "pedestal": 64})['black_level'] == 64


def test_nothing_known():
  assert sensor_info({"mode": "RGB"}) is None
  assert sensor_info(None) is None
  assert sensor_info({"pattern": "XYZW"}) is None
  # rectangular cells aren't supported: Bayer cells, as the pattern says
  assert sensor_info({"pattern": "GRBG", "samplePerPixel": "2x1"})['cfa'] == {'pattern': 'GRBG', 'block': 1}
  assert sensor_info({"isBW": True, "imageType": "UI12"}) == {'bit_depth': 12, 'white_level': 4095, 'mono': True, 'fields': {'imageType': 'UI12', 'isBW': True}}


def test_get_pixels_passes_the_sensor_on(tmp_path, dummy_app):
  """The pixels API says what the reader knows about the sensor, in a header for binary values"""
  import backend.api.image as image_api
  path = tmp_path / 'raw.png'
  path.write_bytes(b'not read')
  raw = (np.arange(64 * 64, dtype=np.uint16) % 1024).reshape(64, 64)
  cache = tmp_path / 'cache'
  cache.mkdir()
  with patch.object(image_api, 'image_cache_dir', cache), patch.object(image_api, 'read_image', return_value=(raw, dict(CDE_META, pedestal=64))):
    with dummy_app.test_request_context(f'/api/v1/output/image/pixels?image_url=/s{path}&x=0&y=0&w=4&h=4&format=binary'):
      response = image_api.get_pixels()
    assert response.status_code == 200
    sensor = json.loads(response.headers['X-Pixels-Sensor'])
    assert sensor['cfa'] == {'pattern': 'GBRG', 'block': 4}
    assert sensor['black_level'] == 64
    with dummy_app.test_request_context(f'/api/v1/output/image/pixels?image_url=/s{path}&x=0&y=0&w=2&h=2'):
      response = image_api.get_pixels()
    assert response.get_json()['sensor']['bit_depth'] == 10
