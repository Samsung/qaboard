"""
The pixel values of images, and the regions where two images differ most, for the image viewer.
They need a logged-in user who can read the images (see files.readable_file).
"""
import time
from pathlib import Path

import numpy as np
from flask import request, jsonify, Response

from backend import app
from .image_diff import METHODS, difference_map, find_regions
from ..images import read_image, ImageType
from .auth import login_required
from .files import readable_file

import os
import json
import hashlib
import threading
import contextlib
from collections import OrderedDict

try:
  import fcntl
except ImportError: # not on Linux
  fcntl = None

from backend.config import qaboard_data_dir

# The pixel values of images, decoded once and kept on disk, memory-mapped.
# We work with huge images (100-200MP). Decoding them can take seconds (e.g. raw formats), but the image viewer asks for
# their values as users hover them, and for the regions they zoom on. Once decoded, reading a region only reads it.
# An in-memory LRU cache would use too much memory: images can be 300MB, and each worker would keep its own copies.
image_cache_dir = Path(os.environ.get('QABOARD_IMAGE_CACHE_DIR', qaboard_data_dir / 'cache' / 'images'))
image_cache_dir.mkdir(exist_ok=True, parents=True)
# The disk space they can use: we remove the least recently used
image_cache_bytes = float(os.environ.get('QABOARD_IMAGE_CACHE_GB', '20')) * 1e9
# The regions where two images differ, once found: keyed by the files (and when they changed) and how they're compared
regions_cache_dir = image_cache_dir / 'regions'
regions_cache_dir.mkdir(exist_ok=True)


_thread_locks = {}
_thread_locks_guard = threading.Lock()

@contextlib.contextmanager
def _image_lock(hash):
  """One process at a time decodes an image, and other images are decoded at the same time"""
  if fcntl is None:
    with _thread_locks_guard:
      lock = _thread_locks.setdefault(hash, threading.Lock())
    with lock:
      yield
    return
  with open(image_cache_dir / f"{hash}.lock", 'a') as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
      yield
    finally:
      fcntl.flock(f, fcntl.LOCK_UN)


def clear_memmapped_cache_dir(keep=None):
  """Removes the least recently used images until the cache fits in image_cache_bytes"""
  entries = []
  for data in image_cache_dir.glob('*.dat'):
    try: # other processes may have deleted it
      stat = data.stat()
    except FileNotFoundError:
      continue
    entries.append((stat.st_mtime, stat.st_size, data))
  total = sum(size for _, size, _ in entries)
  for _, size, data in sorted(entries): # least recently used first
    if total <= image_cache_bytes:
      break
    if data.stem == keep:
      continue
    print(f"RM {data}")
    data.unlink(missing_ok=True)
    data.with_suffix('.json').unlink(missing_ok=True)
    total -= size
  # what interrupted processes left, old locks, and the regions where images differ that nobody asked for in a month
  now = time.time()
  for path, age in [
    *((path, 3600) for path in image_cache_dir.glob('*.tmp')),
    *((path, 3600) for path in image_cache_dir.glob('*.lock')),
    *((path, 30 * 24 * 3600) for path in regions_cache_dir.glob('*.json')),
  ]:
    try:
      if now - path.stat().st_mtime > age:
        path.unlink(missing_ok=True)
    except FileNotFoundError:
      pass


# The images this process opened recently: hash => [array, meta, when we last marked it as used]
_opened = OrderedDict()
_opened_lock = threading.Lock()
_opened_max = 32

def _open_cached(hash, data_path, info_path):
  with _opened_lock:
    entry = _opened.get(hash)
    if entry is not None:
      _opened.move_to_end(hash)
  if entry is None:
    info = json.loads(info_path.read_text())
    entry = [np.memmap(data_path, dtype=info['dtype'], mode='r', shape=tuple(info['shape'])), info['meta'], 0]
    with _opened_lock:
      _opened[hash] = entry
      while len(_opened) > _opened_max:
        _opened.popitem(last=False)
  # Recently used images stay in the cache. Once a minute is enough.
  now = time.time()
  if now - entry[2] > 60:
    entry[2] = now
    try:
      os.utime(data_path)
    except FileNotFoundError: # another process removed it: we still have it open
      pass
  return entry[0], entry[1]


def decoded_image(image_path):
  """The image's pixel values as a (memory-mapped) numpy array, and what they are. Raises if it can't be read."""
  key = f"{image_path}-{image_path.stat().st_mtime}"
  hash = hashlib.sha1(key.encode()).hexdigest()
  data_path = image_cache_dir / f"{hash}.dat"
  info_path = image_cache_dir / f"{hash}.json"
  # Hot path: no lock needed, just read
  with _opened_lock:
    opened = hash in _opened
  if opened or (data_path.exists() and info_path.exists()):
    try:
      return _open_cached(hash, data_path, info_path)
    except (FileNotFoundError, json.JSONDecodeError):
      pass # removed meanwhile, or written by a process that died
  with _image_lock(hash):
    if data_path.exists() and info_path.exists():
      return _open_cached(hash, data_path, info_path)
    print(f'MISS {image_path}')
    image, meta = read_image(image_path)
    image = np.asarray(image)
    # unique names: on shared storage, processes on other hosts may write it too
    tmp = f"{hash}.{os.getpid()}.{threading.get_ident()}"
    tmp_data = image_cache_dir / f"{tmp}.dat.tmp"
    tmp_info = image_cache_dir / f"{tmp}.json.tmp"
    try:
      fp = np.memmap(tmp_data, dtype=image.dtype, mode='w+', shape=image.shape)
      fp[:] = image[:]
      fp.flush()
      del fp
      tmp_info.write_text(json.dumps({"meta": meta, "shape": image.shape, "dtype": str(image.dtype)}))
      tmp_data.rename(data_path)
      tmp_info.rename(info_path)
    finally:
      tmp_data.unlink(missing_ok=True)
      tmp_info.unlink(missing_ok=True)
    clear_memmapped_cache_dir(keep=hash)
    return _open_cached(hash, data_path, info_path)


def maybe_memmapped_read_image(image_path):
  """Like decoded_image, but returns (image, meta, error)"""
  try:
    image, meta = decoded_image(image_path)
    return image, meta, None
  except Exception as e:
    return None, None, e


def _image_meta(meta):
  """What the image's values are, e.g. {"mode": "I;16"}"""
  if ImageType is not None:
    try:
      meta = ImageType(*meta)
    except:
      pass
    if isinstance(meta, ImageType):
      meta = {"mode": meta.id}
  return meta


@app.route("/api/v1/output/image/pixel", methods=['GET'])
@login_required
def get_pixel():
  try:
    x = int(request.args['x'])
    y = int(request.args['y'])
  except (KeyError, ValueError):
    return jsonify({"error": "x and y must be integers"}), 400
  image_path, denied = readable_file(request.args.get('image_url'))
  if denied:
    return denied
  if not image_path.is_file():
    return jsonify({"error": f"Cannot find {image_path.name}"}), 404
  # We work with huge images (100-200MP). Loading them each request can be very slow (~seconds).
  # Since the frontend may request 5-10 pixel values per second, we need some form of caching.
  # An in-memory LRU cache would use too much memory: images can be 300MB, and each worker would keep its own copies.
  image, meta, error = maybe_memmapped_read_image(image_path)
  if error:
    return jsonify({"error": str(error)}), 400
  return jsonify({
    "value": image[y,x].tolist(),
    "meta": _image_meta(meta),
  })


# The image viewer asks for the values of the regions users hover or zoom on, by tiles of 64x64 pixels
MAX_REGION_PIXELS = 256 * 256

# The types of JavaScript's typed arrays
JAVASCRIPT_DTYPES = {'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'}

def _for_javascript(region):
  """The region as a C-ordered, little-endian array of a type JavaScript reads"""
  if region.dtype == np.bool_:
    region = region.astype(np.uint8)
  elif region.dtype == np.float16:
    region = region.astype(np.float32)
  elif region.dtype.name not in JAVASCRIPT_DTYPES: # e.g. 64-bit integers
    region = region.astype(np.float64)
  return np.ascontiguousarray(region, dtype=region.dtype.newbyteorder('<'))


@app.route("/api/v1/output/image/pixels", methods=['GET'])
@login_required
def get_pixels():
  """
  The values of the pixels of a region of an image: image[y:y+h, x:x+w]. The region is cut at the image's right and
  bottom edges. As JSON: nested lists (rows, then pixels, then channels for color images). With format=binary: the
  values, little-endian, with their type and shape in the headers X-Pixels-Dtype (e.g. uint16) and X-Pixels-Shape
  (height,width[,channels]): smaller and faster to read.
  """
  try:
    x, y, w, h = (int(request.args[k]) for k in ('x', 'y', 'w', 'h'))
  except (KeyError, ValueError):
    return jsonify({"error": "x, y, w and h must be integers"}), 400
  if x < 0 or y < 0 or w <= 0 or h <= 0 or w * h > MAX_REGION_PIXELS:
    return jsonify({"error": f"The region must be in the image, with 1 to {MAX_REGION_PIXELS} pixels"}), 400
  image_path, denied = readable_file(request.args.get('image_url'))
  if denied:
    return denied
  if not image_path.is_file():
    return jsonify({"error": f"Cannot find {image_path.name}"}), 404
  image, meta, error = maybe_memmapped_read_image(image_path)
  if error:
    return jsonify({"error": str(error)}), 400
  height, width = image.shape[:2]
  if x >= width or y >= height:
    return jsonify({"error": f"The region starts outside the {width}x{height} image"}), 400
  meta = _image_meta(meta)
  region = np.asarray(image[y:y+h, x:x+w])

  if request.args.get('format') == 'binary':
    region = _for_javascript(region)
    mode = meta.get('mode') if isinstance(meta, dict) else None
    headers = {
      'X-Pixels-Dtype': region.dtype.name,
      'X-Pixels-Shape': ','.join(str(n) for n in region.shape),
      'X-Image-Width': str(width),
      'X-Image-Height': str(height),
    }
    if mode:
      headers['X-Pixels-Mode'] = str(mode)
    return Response(region.tobytes(), mimetype='application/octet-stream', headers=headers)

  # NaN and infinity are not JSON
  if region.dtype.kind == 'f' and not np.isfinite(region).all():
    region = np.where(np.isfinite(region), region, None)
  return jsonify({
    "values": region.tolist(),
    "meta": meta,
    "width": int(width),
    "height": int(height),
  })


REGIONS_VERSION = 2

@app.route("/api/v1/output/image/diff", methods=['POST'])
@login_required
def get_rois():
  """
  The regions where two images differ most, the largest difference first: [{x, y, w, h, peak_x, peak_y, value, diff}]
  JSON body: output_dir_url_new, output_dir_url_ref, path, path_ref (default: path), diff_type (yiq, ssim, ciede2000),
  count (default 20). See image_diff.py.
  """
  data = request.get_json(silent=True) or {}
  if not data.get('path'):
    return jsonify({"error": "Missing 'path'"}), 400
  path_new, denied = readable_file(data.get('output_dir_url_new'), data['path'])
  if denied:
    return denied
  path_ref, denied = readable_file(data.get('output_dir_url_ref'), data.get('path_ref') or data['path'])
  if denied:
    return denied
  method = data.get('diff_type', 'yiq')
  if method not in METHODS:
    return jsonify({"error": f"Unknown diff_type {method}, use one of {', '.join(METHODS)}"}), 400
  count = min(100, max(1, int(data.get('count') or 20)))
  for label, path in (('new', path_new), ('reference', path_ref)):
    if not path.is_file():
      return jsonify({"error": f"The {label} run has no {path.name}"}), 404

  stats = [path_new.stat(), path_ref.stat()]
  key = json.dumps([REGIONS_VERSION, str(path_new), str(path_ref), [(s.st_size, s.st_mtime_ns) for s in stats], method, count])
  cached = regions_cache_dir / f"{hashlib.sha1(key.encode()).hexdigest()}.json"
  try:
    return Response(cached.read_bytes(), mimetype='application/json', headers={'X-Regions-Cache': 'hit'})
  except FileNotFoundError:
    pass

  start = time.time()
  images = []
  for label, path in (('new', path_new), ('reference', path_ref)):
    image, _, error = maybe_memmapped_read_image(path)
    if error:
      return jsonify({"error": f"Can't read the {label} image: {error}"}), 400
    images.append(image)
  image_new, image_ref = images
  if image_new.shape[:2] != image_ref.shape[:2]:
    (h1, w1), (h2, w2) = image_new.shape[:2], image_ref.shape[:2]
    return jsonify({"error": f"The images have different sizes: {w1}x{h1} and {w2}x{h2}"}), 400
  decoded = time.time()
  delta, factor = difference_map(image_new, image_ref, method)
  body = json.dumps(find_regions(delta, factor, image_new.shape, count)).encode()
  tmp = cached.with_name(f"{cached.name}.{os.getpid()}.{threading.get_ident()}.tmp")
  tmp.write_bytes(body)
  tmp.rename(cached)
  timing = f"decode;dur={1000 * (decoded - start):.0f}, compare;dur={1000 * (time.time() - decoded):.0f}"
  return Response(body, mimetype='application/json', headers={'X-Regions-Cache': 'miss', 'Server-Timing': timing})
