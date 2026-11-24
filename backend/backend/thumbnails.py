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

Thumbnails are JPEGs, made once: they're kept on the server's own volume (DiskCache: QABOARD_THUMBNAILS_DIR, by
default $QABOARD_DATA_DIR/thumbnails), keyed by (path, mtime, size, the decoders installed), every size. A hit is a
file read: no decode, no Redis. Files no decoder reads are kept too (empty files, for a day), so they're answered
quickly. The folder is capped (QABOARD_THUMBNAILS_MAX_GB, 20 by default): the least recently used go first. Never
next to the inputs (they're read-only and belong to others), nor on users' quotas.
Without a writable folder, the grid's sizes (up to CACHED_MAX_SIZE) are cached for a day in the hybrid cache (per
thread, then Redis: bound it with `maxmemory` and `maxmemory-policy allkeys-lru`), and the viewer's aren't.
At most MAX_DECODES thumbnails are made at a time per process (Busy after DECODE_WAIT_S seconds: the API answers 503),
plus one in the background for inputs just added (warm()).
Callers check that the user can read the file (api/inputs.py, with api/files.readable_file).
"""
import io
import os
import time
import hashlib
import threading
from pathlib import Path
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
  """Whether the server keeps thumbnails of this size: all of them with the disk cache"""
  return size <= CACHED_MAX_SIZE or disk_cache() is not None


class DiskCache:
  """
  Thumbnails as files: <root>/<2 hex>/<sha1>.jpg. Written atomically (a temporary file, then rename), so concurrent
  processes and readers never see half a file. An empty file: no decoder reads it, believed for NEGATIVE_TTL_S.
  Hits refresh the file's mtime at most once a day: pruning removes the least recently used first.
  """
  NEGATIVE_TTL_S = 24 * 3600
  TOUCH_EVERY_S = 24 * 3600
  PRUNE_EVERY_WRITES = 500
  PRUNE_EVERY_S = 3600

  def __init__(self, root: Path, max_bytes: int):
    self.root = root
    self.max_bytes = max_bytes
    self.writes = 0
    self.last_prune = 0.0
    self.lock = threading.Lock()

  def key(self, path: str, mtime_ns: int, size: int) -> Path:
    # a new decoder (a site's, installed later) may read what none did: it's another key
    decoders_installed = ",".join(name for name, _ in site_decoders())
    digest = hashlib.sha1(f"1|{decoders_installed}|{path}|{mtime_ns}|{size}".encode()).hexdigest()
    return self.root / digest[:2] / f"{digest}.jpg"

  def get(self, file: Path):
    """(True, bytes or None) on a hit, (False, None) on a miss"""
    try:
      stat = file.stat()
    except OSError:
      return False, None
    now = time.time()
    if stat.st_size == 0:
      return (True, None) if now - stat.st_mtime < self.NEGATIVE_TTL_S else (False, None)
    try:
      data = file.read_bytes()
    except OSError:
      return False, None
    if now - stat.st_mtime > self.TOUCH_EVERY_S:
      try:
        os.utime(file)
      except OSError:
        pass
    return True, data

  def put(self, file: Path, data: Optional[bytes]):
    try:
      file.parent.mkdir(parents=True, exist_ok=True)
      temporary = file.with_name(f"{file.name}.{os.getpid()}.{threading.get_ident()}.tmp")
      temporary.write_bytes(data or b'')
      os.replace(temporary, file)
    except OSError as e:
      print(f"WARNING: could not keep a thumbnail in {self.root}: {e}")
      return
    with self.lock:
      self.writes += 1
      due = self.writes >= self.PRUNE_EVERY_WRITES or time.time() - self.last_prune > self.PRUNE_EVERY_S
      if due:
        self.writes, self.last_prune = 0, time.time()
    if due:
      threading.Thread(target=self.prune, name="thumbnails-prune", daemon=True).start()

  def prune(self):
    """Over max_bytes: removes the least recently used, down to 80%. One process at a time (a lock file)."""
    try:
      import fcntl
      with open(self.root / '.prune.lock', 'w') as lock:
        try:
          fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
          return  # another process prunes
        files, total = [], 0
        for folder in self.root.iterdir():
          if not folder.is_dir():
            continue
          for entry in os.scandir(folder):
            try:
              stat = entry.stat()
            except OSError:
              continue
            if entry.name.endswith('.tmp') and time.time() - stat.st_mtime > 3600:
              os.unlink(entry.path)  # left by a crash
              continue
            files.append((stat.st_mtime, stat.st_size, entry.path))
            total += stat.st_size
        if total <= self.max_bytes:
          return
        files.sort()
        for _, size, file_path in files:
          if total <= self.max_bytes * 0.8:
            break
          try:
            os.unlink(file_path)
            total -= size
          except OSError:
            pass
    except Exception as e:
      print(f"WARNING: could not prune the thumbnails in {self.root}: {e}")


@lru_cache(maxsize=None)
def disk_cache() -> Optional[DiskCache]:
  """The thumbnails' folder, if the server can write in it, else None (the hybrid cache then)"""
  root = os.environ.get('QABOARD_THUMBNAILS_DIR') or str(Path(os.environ.get('QABOARD_DATA_DIR', '/var/qaboard')) / 'thumbnails')
  if root.lower() in ('off', 'none', 'false', '0'):
    return None
  try:
    max_bytes = int(float(os.environ.get('QABOARD_THUMBNAILS_MAX_GB', '20')) * 1024 ** 3)
    root_path = Path(root)
    root_path.mkdir(parents=True, exist_ok=True)
    probe = root_path / f".probe.{os.getpid()}"
    probe.write_bytes(b'')
    probe.unlink()
  except (OSError, ValueError) as e:
    print(f"WARNING: thumbnails aren't kept on disk ({root}: {e}): the grid's are cached in Redis for a day, the others made each time.")
    return None
  return DiskCache(root_path, max_bytes)


# Warming: inputs added before any run (POST /inputs) get their grid thumbnail made in the background, so that the
# first visit of their folder doesn't wait for decodes. One at a time per process, besides the requests' decodes
# (warming never makes the web app's requests wait), at most WARM_QUEUE waiting: more are made when they're shown.
WARM_SIZE = CACHED_MAX_SIZE
WARM_QUEUE = 20_000
_warming: dict = {"executor": None, "queued": 0}
_warming_lock = threading.Lock()


def warm(paths: List[str], size: int = WARM_SIZE) -> int:
  """Makes the thumbnails of these files (absolute paths the server reads) in the background: how many were queued"""
  if disk_cache() is None or not paths:
    return 0
  from concurrent.futures import ThreadPoolExecutor
  with _warming_lock:
    if _warming["executor"] is None:
      _warming["executor"] = ThreadPoolExecutor(max_workers=1, thread_name_prefix="thumbnails-warm")
    room = max(0, WARM_QUEUE - _warming["queued"])
    paths = paths[:room]
    _warming["queued"] += len(paths)
  for path in paths:
    _warming["executor"].submit(_warm_one, path, size)
  return len(paths)


def _warm_one(path: str, size: int):
  try:
    cache = disk_cache()
    stat = os.stat(path)
    file = cache.key(path, stat.st_mtime_ns, size)
    if not cache.get(file)[0]:
      cache.put(file, decode_thumbnail(path, size))
  except Exception:
    pass  # missing, unreadable: shown as a placeholder, tried again when asked
  finally:
    with _warming_lock:
      _warming["queued"] -= 1


def thumbnail_of(path: str, mtime_ns: int, size: int) -> Optional[bytes]:
  """A JPEG of the file at its version mtime_ns, or None: kept on disk, else cached up to CACHED_MAX_SIZE"""
  cache = disk_cache()
  if cache is None:
    if size <= CACHED_MAX_SIZE:
      return cached_thumbnail(path, mtime_ns, size)
    return make_thumbnail(path, size)
  file = cache.key(path, mtime_ns, size)
  hit, data = cache.get(file)
  if hit:
    return data
  data = make_thumbnail(path, size)
  cache.put(file, data)
  return data
