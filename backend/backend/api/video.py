"""
Videos for the video viewer: what's in the file, the decoded values of a frame's pixels, and where two videos differ.
See backend/videos.py. They need a logged-in user who can read the videos (see files.readable_file).
"""
import os
import json
import time
import hashlib
import threading

from flask import request, jsonify, Response

from backend import app
from .auth import login_required
from .files import readable_file
from .image import image_cache_dir, MAX_REGION_PIXELS, _for_javascript
from .. import videos

# Once read, keyed by the files and when they changed. Removed after a month.
videos_cache_dir = image_cache_dir / 'videos'
videos_cache_dir.mkdir(exist_ok=True, parents=True)
VIDEOS_VERSION = 1


def _clean():
  """What interrupted processes left, and the results nobody asked for in a month"""
  now = time.time()
  for pattern, age in (('*.tmp', 3600), ('*.json', 30 * 24 * 3600)):
    for path in videos_cache_dir.glob(pattern):
      try:
        if now - path.stat().st_mtime > age:
          path.unlink(missing_ok=True)
      except FileNotFoundError:
        pass


def _cached(key, compute):
  """compute()'s JSON, kept on disk: (body, hit)"""
  path = videos_cache_dir / f"{hashlib.sha1(json.dumps([VIDEOS_VERSION, *key]).encode()).hexdigest()}.json"
  try:
    return path.read_bytes(), True
  except FileNotFoundError:
    pass
  body = json.dumps(compute()).encode()
  tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
  tmp.write_bytes(body)
  tmp.rename(path)
  _clean()
  return body, False


def _file_key(path):
  stat = path.stat()
  return [str(path), stat.st_size, stat.st_mtime_ns]


def _video_path(url):
  path, denied = readable_file(url)
  if denied:
    return None, denied
  if not path.is_file():
    return None, (jsonify({"error": f"Cannot find {path.name}"}), 404)
  return path, None


@app.route("/api/v1/output/video/info", methods=['GET'])
@login_required
def get_video_info():
  """What's in a video: codec, pixel format, color range... and the timestamps and sizes of its frames"""
  path, error = _video_path(request.args.get('video_url'))
  if error:
    return error
  if videos.av is None:
    return jsonify({"error": "The server can't read videos: it needs PyAV"}), 501
  try:
    body, hit = _cached(['info', *_file_key(path)], lambda: videos.probe(path))
  except Exception as e:
    return jsonify({"error": f"Can't read the video: {e}"}), 400
  return Response(body, mimetype='application/json', headers={'X-Video-Cache': 'hit' if hit else 'miss'})


@app.route("/api/v1/output/video/pixels", methods=['GET'])
@login_required
def get_video_pixels():
  """
  The decoded values of a region of a frame: frame[y:y+h, x:x+w], each pixel with its chroma sample (e.g. Y, Cb, Cr),
  frames numbered from 0 in presentation order. Like /api/v1/output/image/pixels: as JSON, or format=binary.
  """
  try:
    frame, x, y, w, h = (int(request.args[k]) for k in ('frame', 'x', 'y', 'w', 'h'))
  except (KeyError, ValueError):
    return jsonify({"error": "frame, x, y, w and h must be integers"}), 400
  if frame < 0 or x < 0 or y < 0 or w <= 0 or h <= 0 or w * h > MAX_REGION_PIXELS:
    return jsonify({"error": f"The region must be in the frame, with 1 to {MAX_REGION_PIXELS} pixels"}), 400
  path, error = _video_path(request.args.get('video_url'))
  if error:
    return error
  if videos.av is None:
    return jsonify({"error": "The server can't decode videos: it needs PyAV"}), 501
  try:
    planes, names, bits = videos.readers.planes(path, frame)
  except IndexError as e:
    return jsonify({"error": str(e)}), 400
  except Exception as e:
    return jsonify({"error": f"Can't decode the frame: {e}"}), 400
  height, width = planes[0].shape
  if x >= width or y >= height:
    return jsonify({"error": f"The region starts outside the {width}x{height} frame"}), 400
  region = videos.upsampled(planes, x, y, min(w, width - x), min(h, height - y))
  mode = f"{' '.join(names)}, {bits}-bit"
  if request.args.get('format') == 'binary':
    region = _for_javascript(region)
    return Response(region.tobytes(), mimetype='application/octet-stream', headers={
      'X-Pixels-Dtype': region.dtype.name,
      'X-Pixels-Shape': ','.join(str(n) for n in region.shape),
      'X-Pixels-Mode': mode,
      'X-Image-Width': str(width),
      'X-Image-Height': str(height),
    })
  return jsonify({"values": region.tolist(), "mode": mode, "channels": names, "bits": bits, "width": int(width), "height": int(height)})


@app.route("/api/v1/output/video/diff", methods=['POST'])
@login_required
def get_video_diff():
  """
  Where two videos differ, frame by frame, on their decoded values. JSON body: output_dir_url_new, output_dir_url_ref,
  path, path_ref (default: path), count (regions, default 20). See videos.compare().
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
  for label, path in (('new', path_new), ('reference', path_ref)):
    if not path.is_file():
      return jsonify({"error": f"The {label} run has no {path.name}"}), 404
  if videos.av is None:
    return jsonify({"error": "The server can't decode videos: it needs PyAV"}), 501
  count = min(100, max(1, int(data.get('count') or 20)))
  start = time.time()
  try:
    body, hit = _cached(['diff', *_file_key(path_new), *_file_key(path_ref), count], lambda: videos.compare(path_new, path_ref, count=count))
  except ValueError as e:
    return jsonify({"error": str(e)}), 400
  except Exception as e:
    return jsonify({"error": f"Can't compare the videos: {e}"}), 400
  return Response(body, mimetype='application/json', headers={
    'X-Video-Cache': 'hit' if hit else 'miss',
    'Server-Timing': f"compare;dur={1000 * (time.time() - start):.0f}",
  })
