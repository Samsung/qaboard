"""Thumbnails of inputs (backend/thumbnails.py): the decoders' order, formats, and what they answer"""
import io

import pytest

from backend import thumbnails


def decoded(data):
  from PIL import Image
  image = Image.open(io.BytesIO(data))
  image.load()
  return image


@pytest.fixture(autouse=True)
def no_site_decoders(monkeypatch):
  monkeypatch.setattr(thumbnails, 'site_decoders', lambda: ())


def test_images_are_downscaled_to_jpegs(tmp_path):
  from PIL import Image
  Image.new('RGB', (1000, 500), (10, 200, 30)).save(tmp_path / 'a.png')
  image = decoded(thumbnails.make_thumbnail(str(tmp_path / 'a.png'), 256))
  assert (image.format, image.mode, image.size) == ('JPEG', 'RGB', (256, 128))
  r, g, b = image.getpixel((10, 10))
  assert g > 150 and r < 60
  # small images aren't enlarged
  Image.new('L', (40, 30), 128).save(tmp_path / 'small.jpg')
  assert decoded(thumbnails.make_thumbnail(str(tmp_path / 'small.jpg'), 256)).size == (40, 30)


def test_16_bit_images_are_stretched(tmp_path):
  from PIL import Image
  import numpy as np
  pixels = np.zeros((20, 20), dtype=np.uint16)
  pixels[:, 10:] = 1000  # dark in 16 bits: white once stretched
  Image.fromarray(pixels).save(tmp_path / 'a.tif')
  image = decoded(thumbnails.make_thumbnail(str(tmp_path / 'a.tif'), 64))
  assert image.getpixel((2, 2))[0] < 20 and image.getpixel((17, 2))[0] > 235


def test_transparency_is_on_white(tmp_path):
  from PIL import Image
  Image.new('RGBA', (20, 20), (0, 0, 0, 0)).save(tmp_path / 'a.png')
  assert min(decoded(thumbnails.make_thumbnail(str(tmp_path / 'a.png'), 64)).getpixel((5, 5))) > 245


def test_unreadable_files(tmp_path):
  (tmp_path / 'a.raw').write_bytes(b'\x01' * 1000)
  assert thumbnails.make_thumbnail(str(tmp_path / 'a.raw'), 64) is None
  assert thumbnails.make_thumbnail(str(tmp_path / 'missing.png'), 64) is None
  (tmp_path / 'broken.mp4').write_bytes(b'not a video')
  assert thumbnails.make_thumbnail(str(tmp_path / 'broken.mp4'), 64) is None


def test_site_decoders_come_first(tmp_path, monkeypatch):
  from PIL import Image
  Image.new('RGB', (10, 10), (255, 0, 0)).save(tmp_path / 'a.png')
  (tmp_path / 'a.raw').write_bytes(b'\x01' * 100)
  calls = []
  def failing(path, size):
    calls.append('failing')
    raise RuntimeError("can't")
  def raw_only(path, size):
    calls.append('raw')
    return Image.new('RGB', (size * 2, size), (0, 0, 255)) if path.endswith('.raw') else None
  monkeypatch.setattr(thumbnails, 'site_decoders', lambda: (('failing', failing), ('raw', raw_only)))
  image = decoded(thumbnails.make_thumbnail(str(tmp_path / 'a.raw'), 64))
  assert image.size == (64, 32) and image.getpixel((5, 5))[2] > 200
  assert calls == ['failing', 'raw']
  # then Pillow
  assert decoded(thumbnails.make_thumbnail(str(tmp_path / 'a.png'), 64)).getpixel((5, 5))[0] > 200


def test_site_decoders_from_entry_points(monkeypatch):
  class EntryPoint:
    def __init__(self, name, value):
      self.name, self.value = name, value
    def load(self):
      if self.value is None:
        raise ImportError("not installed")
      return self.value
  decoder = lambda path, size: None
  monkeypatch.undo()
  monkeypatch.setattr(thumbnails, 'site_entry_points', lambda group: [EntryPoint('raw', decoder), EntryPoint('broken', None)] if group == 'qaboard.thumbnails' else [])
  thumbnails.site_decoders.cache_clear()
  try:
    assert thumbnails.site_decoders() == (('raw', decoder),)
    assert [name for name, _ in thumbnails.decoders()] == ['raw', 'pillow', 'av']
  finally:
    thumbnails.site_decoders.cache_clear()


def test_first_frame_of_videos(tmp_path):
  av = pytest.importorskip('av')
  import numpy as np
  path = str(tmp_path / 'a.mp4')
  try:
    with av.open(path, mode='w') as container:
      stream = container.add_stream('mpeg4', rate=5)
      stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
      for i in range(3):
        frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), (250, 250, 250) if i == 0 else (0, 0, 0), dtype=np.uint8), format='rgb24')
        for packet in stream.encode(frame):
          container.mux(packet)
      for packet in stream.encode():
        container.mux(packet)
  except Exception as e:
    pytest.skip(f"PyAV can't encode a test video here: {e}")
  image = decoded(thumbnails.make_thumbnail(path, 32))
  assert image.size == (32, 24) and image.getpixel((10, 10))[0] > 200


def test_extensions():
  assert thumbnails.extension('/a/b.MP4') == '.mp4'
  assert thumbnails.extension('/a.b/c') == ''


def test_only_small_thumbnails_are_cached(tmp_path, monkeypatch):
  """The grid's sizes go in the hybrid cache (Redis), the viewer's bigger ones don't: they're made each time"""
  made = []
  monkeypatch.setattr(thumbnails, 'make_thumbnail', lambda path, size: made.append(size) or b'jpeg')
  cached = []
  monkeypatch.setattr(thumbnails, 'cached_thumbnail', lambda path, mtime_ns, size: cached.append(size) or b'cached')
  assert thumbnails.thumbnail_of('/a.png', 1, 256) == b'cached'
  assert thumbnails.thumbnail_of('/a.png', 1, 64) == b'cached'
  assert thumbnails.thumbnail_of('/a.png', 1, 512) == b'jpeg'
  assert thumbnails.thumbnail_of('/a.png', 1, 1024) == b'jpeg'
  assert (cached, made) == ([256, 64], [512, 1024])
  assert thumbnails.is_cached(256) and not thumbnails.is_cached(512)


def test_concurrent_decodes_are_capped(tmp_path, monkeypatch):
  import threading
  from PIL import Image
  Image.new('RGB', (10, 10)).save(tmp_path / 'a.png')
  monkeypatch.setattr(thumbnails, 'decodes', threading.BoundedSemaphore(2))
  started, release = threading.Barrier(3), threading.Event()
  def slow(path, size):
    started.wait()
    release.wait(5)
    return None
  monkeypatch.setattr(thumbnails, 'decode_thumbnail', slow)
  threads = [threading.Thread(target=thumbnails.make_thumbnail, args=(str(tmp_path / 'a.png'), 64)) for _ in range(2)]
  for thread in threads:
    thread.start()
  started.wait(5)
  # both slots are taken: the third gives up
  with pytest.raises(thumbnails.Busy):
    thumbnails.make_thumbnail(str(tmp_path / 'a.png'), 64, wait_s=0.05)
  release.set()
  for thread in threads:
    thread.join(5)
  # the slots are free again
  monkeypatch.setattr(thumbnails, 'decode_thumbnail', lambda path, size: b'ok')
  assert thumbnails.make_thumbnail(str(tmp_path / 'a.png'), 64, wait_s=0.05) == b'ok'
