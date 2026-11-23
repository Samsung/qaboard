"""
Thumbnails of inputs, for the Inputs tab and collections (docs/design/inputs-and-collections.md).

Decoders are tried in order, the first that returns an image wins:
1. the site's, from installed packages: an entry point in the group "qaboard.thumbnails", a callable

       def thumbnail(abs_path: str, size: int) -> Optional[PIL.Image.Image]:
           # None (or raising) when it doesn't read this file: the next decoder tries.
           # The image can be bigger than `size`: we downscale it.

       [project.entry-points."qaboard.thumbnails"]
       raw = "my_site_package.thumbnails:thumbnail"

   e.g. for raw formats only the site knows how to read;
2. Pillow, for the image formats it opens;
3. the first frame of videos, with PyAV.

Thumbnails are JPEGs. Those of the grid (sizes up to CACHED_MAX_SIZE, a few KB) are cached for a day (hybrid cache:
per thread, then Redis) keyed by (path, mtime, size); files no decoder reads are cached too (None), so they're answered
quickly. Bigger ones (the viewer's 512, 1024: up to a few hundred KB) aren't: they'd fill Redis. Browsers cache them
(api/inputs.py answers them with an ETag and a long Cache-Control).
Redis: the hybrid cache shares it with the rest of the app, with TTLs only. Admins should bound it, e.g.
`maxmemory 2gb` and `maxmemory-policy allkeys-lru` in redis.conf, so that it evicts the least recently used thumbnails
instead of refusing writes (the cache then answers misses, never errors).
At most MAX_DECODES thumbnails are made at a time per process (Busy after DECODE_WAIT_S seconds: the API answers 503).
Callers check that the user can read the file (api/inputs.py, with api/files.readable_file).
"""
import io
import os
import threading
from functools import lru_cache
from typing import Callable, List, Optional, Tuple

from qaboard.site_config import site_entry_points

from .hybrid_cache import hybrid_cache


JPEG_QUALITY = 85
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp', '.ogv'}

# Pillow refuses images above twice Image.MAX_IMAGE_PIXELS (decompression bombs): we allow our users' big images
MAX_PIXELS = 400_000_000


# Decoding big images takes memory and CPU (a 100 MP raw: ~1 GB, seconds): at most that many decodes at a time per
# process (cache hits don't count). The others wait a little for their turn, then give up (Busy: the API answers 503).
MAX_DECODES = int(os.environ.get('QABOARD_THUMBNAIL_DECODES', '4'))
DECODE_WAIT_S = 5.0
decodes = threading.BoundedSemaphore(MAX_DECODES)


class Busy(Exception):
  """Too many thumbnails are being made: try again later"""


@lru_cache(maxsize=None)
def site_decoders() -> Tuple[Tuple[str, Callable], ...]:
  """The decoders installed: ((name, callable), ...)"""
  decoders = []
  for entry_point in site_entry_points("qaboard.thumbnails"):
    try:
      decoders.append((entry_point.name, entry_point.load()))
    except Exception as e:
      print(f"WARNING: could not load the thumbnail decoder {entry_point.name}: {e}")
  return tuple(decoders)


def extension(path: str) -> str:
  name = path.rsplit('/', 1)[-1]
  return ('.' + name.rsplit('.', 1)[-1].lower()) if '.' in name else ''


def with_pillow(path: str, size: int):
  if extension(path) in VIDEO_EXTENSIONS:
    return None
  from PIL import Image
  Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, MAX_PIXELS // 2)
  image = Image.open(path)
  # JPEGs decode at 1/2, 1/4 or 1/8 of their size, much faster
  image.draft('RGB', (size, size))
  image.load()
  return image


def with_av(path: str, size: int):
  if extension(path) not in VIDEO_EXTENSIONS:
    return None
  import av
  with av.open(path) as container:
    for frame in container.decode(video=0):
      return frame.to_image()
  return None


def decoders() -> List[Tuple[str, Callable]]:
  return [*site_decoders(), ('pillow', with_pillow), ('av', with_av)]


def to_8bit_rgb(image):
  """RGB for JPEG: 16-bit and float images are stretched to their range, transparency goes on white"""
  from PIL import Image
  if image.mode in ('I;16', 'I;16B', 'I;16L', 'I', 'F'):
    import numpy as np
    pixels = np.asarray(image, dtype=np.float32)
    finite = pixels[np.isfinite(pixels)]
    low, high = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)
    scaled = (np.clip((np.nan_to_num(pixels, nan=low) - low) / ((high - low) or 1.0), 0, 1) * 255).astype(np.uint8)
    image = Image.fromarray(scaled, mode='L')
  if image.mode in ('RGBA', 'LA', 'PA') or (image.mode == 'P' and 'transparency' in image.info):
    image = image.convert('RGBA')
    background = Image.new('RGB', image.size, (255, 255, 255))
    background.paste(image, mask=image.getchannel('A'))
    return background
  return image.convert('RGB') if image.mode != 'RGB' else image


def make_thumbnail(path: str, size: int, wait_s: Optional[float] = None) -> Optional[bytes]:
  """A JPEG at most size x size, or None if no decoder reads the file. Raises Busy if it can't start within wait_s seconds."""
  if not decodes.acquire(timeout=DECODE_WAIT_S if wait_s is None else wait_s):
    raise Busy()
  try:
    return decode_thumbnail(path, size)
  finally:
    decodes.release()


def decode_thumbnail(path: str, size: int) -> Optional[bytes]:
  for name, decode in decoders():
    try:
      image = decode(path, size)
    except Exception as e:
      if name not in ('pillow', 'av'):
        print(f"WARNING: the thumbnail decoder {name} failed on {path}: {e}")
      continue
    if image is None:
      continue
    try:
      image = to_8bit_rgb(image)
      image.thumbnail((size, size))
      buffer = io.BytesIO()
      image.save(buffer, format='JPEG', quality=JPEG_QUALITY, optimize=True)
      return buffer.getvalue()
    except Exception as e:
      print(f"WARNING: could not make a thumbnail of {path} with {name}: {e}")
      continue
  return None


# The grid's thumbnails are cached, not the viewer's bigger ones
CACHED_MAX_SIZE = 256


@hybrid_cache(ttl=24 * 3600, maxsize=256)
def cached_thumbnail(path: str, mtime_ns: int, size: int) -> Optional[bytes]:
  """Cached by the file's version (mtime_ns): None (no decoder reads it) is cached too"""
  return make_thumbnail(path, size)


def is_cached(size: int) -> bool:
  return size <= CACHED_MAX_SIZE


def thumbnail_of(path: str, mtime_ns: int, size: int) -> Optional[bytes]:
  """A JPEG of the file at its version mtime_ns, or None: cached up to CACHED_MAX_SIZE, made each time above"""
  if is_cached(size):
    return cached_thumbnail(path, mtime_ns, size)
  return make_thumbnail(path, size)
