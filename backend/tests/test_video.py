"""
Tests for the videos of the video viewer: what's in them, their decoded pixels, and where two differ
(backend/videos.py, backend/api/video.py). The videos are made by the tests, with PyAV.
"""
import json
from fractions import Fraction
from unittest.mock import patch

import numpy as np
import pytest

av = pytest.importorskip('av')

from backend import videos

# their files are in the temporary folder (see conftest.py)
pytestmark = pytest.mark.usefixtures('storage_in_tmp')



WIDTH, HEIGHT = 64, 48


def frame_values(index):
  """A frame's Y, Cb, Cr planes (4:2:0): Y is a gradient that moves with the frame, chroma is flat"""
  y = ((np.arange(WIDTH)[None, :] + 3 * index + np.arange(HEIGHT)[:, None]) % 200 + 16).astype(np.uint8)
  u = np.full((HEIGHT // 2, WIDTH // 2), 100 + index % 50, dtype=np.uint8)
  v = np.full((HEIGHT // 2, WIDTH // 2), 140, dtype=np.uint8)
  return y, u, v


def write_video(path, frames=30, fps=25, codec='ffv1', change=None, pix_fmt='yuv420p'):
  """change(index, y, u, v): edits the planes of a frame"""
  with av.open(str(path), 'w') as container:
    stream = container.add_stream(codec, rate=fps)
    stream.width, stream.height, stream.pix_fmt = WIDTH, HEIGHT, pix_fmt
    if codec == 'libx264':
      stream.options = {'g': '10', 'bf': '2'}
    for index in range(frames):
      y, u, v = frame_values(index)
      if change:
        change(index, y, u, v)
      frame = av.VideoFrame.from_ndarray(np.concatenate([y, u.reshape(-1, WIDTH), v.reshape(-1, WIDTH)]), format='yuv420p')
      frame.pts = index
      frame.time_base = 1 / Fraction(fps)
      for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode():
      container.mux(packet)
  return path


def with_square(index, y, u, v):
  if 10 <= index <= 14:
    y[20:28, 40:48] = 255


@pytest.fixture(scope='module')
def clips(tmp_path_factory):
  directory = tmp_path_factory.mktemp('videos')
  return {
    'new': write_video(directory / 'new.mkv'),
    'same': write_video(directory / 'same.mkv'),
    'changed': write_video(directory / 'changed.mkv', change=with_square),
    'h264': write_video(directory / 'h264.mp4', codec='libx264'),
  }


def test_probe(clips):
  info = videos.probe(clips['new'])
  assert info['codec'] == 'ffv1'
  assert info['lossless'] is True
  assert info['pix_fmt'] == 'yuv420p'
  assert info['chroma_subsampling'] == '4:2:0'
  assert info['channels'] == ['Y', 'Cb', 'Cr']
  assert info['bit_depth'] == 8
  assert (info['width'], info['height']) == (WIDTH, HEIGHT)
  assert info['frame_count'] == 30
  assert info['fps'] == pytest.approx(25)
  assert info['times'][:3] == pytest.approx([0, 0.04, 0.08])
  assert info['duration'] == pytest.approx(1.2)
  assert not info['variable_frame_rate']
  json.dumps(info)


def test_probe_lossy_with_b_frames(clips):
  info = videos.probe(clips['h264'])
  assert info['codec'] == 'h264'
  assert info['lossless'] is None
  # in presentation order, whatever the order they're stored in
  assert info['times'] == sorted(info['times'])
  assert info['frame_count'] == 30
  assert info['keyframes'][0] == 0


@pytest.mark.parametrize('order', [[0, 1, 2, 29], [17, 3, 25, 4, 4]])
def test_frames_by_index(clips, order):
  reader = videos.FrameReader(clips['new'])
  for index in order:
    planes, names, bits = videos.frame_planes(reader.frame(index))
    assert names == ['Y', 'Cb', 'Cr'] and bits == 8
    for plane, expected in zip(planes, frame_values(index)):
      np.testing.assert_array_equal(plane, expected)
  with pytest.raises(IndexError):
    reader.frame(30)
  reader.close()


def test_frames_of_a_lossy_video(clips):
  """Frames are decoded in presentation order, after seeking or not"""
  reader = videos.FrameReader(clips['h264'])
  for index in [12, 13, 0, 29]:
    y, _, _ = videos.frame_planes(reader.frame(index))[0]
    # lossy: close to the frame encoded
    assert np.abs(y.astype(int) - frame_values(index)[0]).mean() < 3
  reader.close()


def test_upsampled_values():
  y = np.arange(16, dtype=np.uint8).reshape(4, 4)
  u = np.array([[100, 101], [102, 103]], dtype=np.uint8)
  v = u + 50
  region = videos.upsampled([y, u, v], 1, 2, 3, 2)
  assert region.shape == (2, 3, 3)
  assert region[0, 0].tolist() == [9, 102, 152]
  assert region[1, 2].tolist() == [15, 103, 153]


def test_same_videos(clips):
  result = videos.compare(clips['new'], clips['same'])
  assert result['complete'] and result['compared'] == 30
  assert result['regions'] == []
  assert all(f['max'] == 0 and f['psnr'] is None and f['changed'] == 0 for f in result['frames'])
  assert [f['ref'] for f in result['frames']] == list(range(30))
  json.dumps(result)


def test_where_videos_differ(clips):
  result = videos.compare(clips['new'], clips['changed'])
  frames = result['frames']
  differing = [i for i, f in enumerate(frames) if f['max'] > 0]
  assert differing == [10, 11, 12, 13, 14]
  assert frames[12]['psnr'] > 20
  assert frames[12]['changed'] == pytest.approx(64 / (WIDTH * HEIGHT), abs=0.01)
  assert frames[12]['value'] == pytest.approx(frames[12]['max'] / 255)
  # where, in the frame
  region = frames[12]['regions'][0]
  assert region['x'] <= 40 and region['x'] + region['w'] >= 48 and region['y'] <= 20 and region['y'] + region['h'] >= 28
  # where and when, over the videos
  best = result['regions'][0]
  assert (best['start'], best['end']) == (10, 14)
  assert 10 <= best['frame'] <= 14
  assert best['x'] <= 40 and best['x'] + best['w'] >= 48


def test_compares_at_the_same_time(tmp_path, clips):
  """A reference at another frame rate: each frame is compared with the reference's frame shown at its time"""
  slow = write_video(tmp_path / 'slow.mkv', frames=15, fps=Fraction(25, 2))
  result = videos.compare(clips['new'], slow)
  assert [f['ref'] for f in result['frames'][:6]] == [0, 0, 1, 1, 2, 2]


def test_different_sizes(tmp_path, clips):
  other = tmp_path / 'other.mkv'
  with av.open(str(other), 'w') as container:
    stream = container.add_stream('ffv1', rate=25)
    stream.width, stream.height, stream.pix_fmt = 32, 32, 'yuv420p'
    frame = av.VideoFrame.from_ndarray(np.zeros((48, 32), dtype=np.uint8), format='yuv420p')
    for packet in [*stream.encode(frame), *stream.encode()]:
      container.mux(packet)
  with pytest.raises(ValueError, match='different sizes'):
    videos.compare(clips['new'], other)


def test_ten_bit_values(tmp_path):
  path = tmp_path / 'ten.mkv'
  with av.open(str(path), 'w') as container:
    stream = container.add_stream('ffv1', rate=25)
    stream.width, stream.height, stream.pix_fmt = WIDTH, HEIGHT, 'yuv420p10le'
    planes = np.full((HEIGHT * 3 // 2, WIDTH), 700, dtype=np.uint16)
    frame = av.VideoFrame.from_ndarray(planes, format='yuv420p10le')
    for packet in [*stream.encode(frame), *stream.encode()]:
      container.mux(packet)
  info = videos.probe(path)
  assert info['bit_depth'] == 10
  planes, names, bits = videos.frame_planes(videos.FrameReader(path).frame(0))
  assert bits == 10 and planes[0].dtype == np.uint16 and int(planes[0][0, 0]) == 700


# --- The endpoints ---

@pytest.fixture
def api(tmp_path):
  import backend.api.video as video_api
  with patch.object(video_api, 'videos_cache_dir', tmp_path):
    yield video_api


def test_info_endpoint(api, clips, dummy_app):
  with dummy_app.test_request_context(f'/api/v1/output/video/info?video_url=/s{clips["new"]}'):
    response = api.get_video_info()
    assert response.headers['X-Video-Cache'] == 'miss'
    assert json.loads(response.get_data())['frame_count'] == 30
  with dummy_app.test_request_context(f'/api/v1/output/video/info?video_url=/s{clips["new"]}'):
    assert api.get_video_info().headers['X-Video-Cache'] == 'hit'
  with dummy_app.test_request_context('/api/v1/output/video/info?video_url=/s/tmp/missing.mp4'):
    _, status = api.get_video_info()
    assert status == 404


def test_pixels_endpoint(api, clips, dummy_app):
  url = f'/api/v1/output/video/pixels?video_url=/s{clips["new"]}&frame=5&x=2&y=3&w=4&h=2'
  with dummy_app.test_request_context(f'{url}&format=binary'):
    response = api.get_video_pixels()
    assert response.headers['X-Pixels-Shape'] == '2,4,3'
    assert response.headers['X-Pixels-Mode'] == 'Y Cb Cr, 8-bit'
    values = np.frombuffer(response.get_data(), dtype=response.headers['X-Pixels-Dtype']).reshape(2, 4, 3)
    y, u, _ = frame_values(5)
    np.testing.assert_array_equal(values[:, :, 0], y[3:5, 2:6])
    assert values[0, 0, 1] == u[0, 0]
  with dummy_app.test_request_context(url.replace('frame=5', 'frame=99')):
    _, status = api.get_video_pixels()
    assert status == 400


def test_diff_endpoint(api, clips, dummy_app):
  body = {'output_dir_url_new': f"/s{clips['new'].parent}", 'output_dir_url_ref': f"/s{clips['changed'].parent}", 'path': 'new.mkv', 'path_ref': 'changed.mkv'}
  with dummy_app.test_request_context('/api/v1/output/video/diff', method='POST', json=body):
    response = api.get_video_diff()
    result = json.loads(response.get_data())
    assert result['regions'][0]['start'] == 10
  with dummy_app.test_request_context('/api/v1/output/video/diff', method='POST', json={**body, 'path_ref': 'nope.mkv'}):
    _, status = api.get_video_diff()
    assert status == 404
