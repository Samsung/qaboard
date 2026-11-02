"""
Videos as their codecs store them, for the video viewer: what's in the file (codec, pixel format, color range...),
the timestamp of every frame, the decoded values of a frame's pixels, and where two videos differ, frame by frame.

Browsers show 8-bit RGB: they convert the decoded YUV with the color matrix they guess, and while they play they may
skip frames. Here we decode the frames ourselves (FFmpeg, through PyAV): the values are the decoded planes (e.g. Y, Cb
and Cr in 10 bits), and frames are numbered in presentation order, like `ffmpeg -i video -vsync passthrough %d.png`.
"""
import math
import queue
import threading
import time
from collections import OrderedDict

import numpy as np

from .api.image_diff import find_regions

try:
  import av
except ImportError: # the viewer still plays videos, without what needs decoding them
  av = None


# FFmpeg's AVColorRange, AVColorSpace, AVColorPrimaries, AVColorTransferCharacteristic
COLOR_RANGES = {1: 'limited', 2: 'full'}
COLOR_MATRICES = {0: 'RGB', 1: 'BT.709', 4: 'FCC', 5: 'BT.601', 6: 'BT.601', 7: 'SMPTE 240M', 8: 'YCgCo', 9: 'BT.2020', 10: 'BT.2020 CL', 14: 'ICtCp'}
COLOR_PRIMARIES = {1: 'BT.709', 4: 'BT.470M', 5: 'BT.601 PAL', 6: 'BT.601 NTSC', 7: 'SMPTE 240M', 9: 'BT.2020', 11: 'DCI-P3', 12: 'Display P3'}
COLOR_TRANSFERS = {1: 'BT.709', 4: 'gamma 2.2', 5: 'gamma 2.8', 6: 'BT.601', 8: 'linear', 13: 'sRGB', 14: 'BT.2020', 15: 'BT.2020', 16: 'PQ (HDR)', 18: 'HLG (HDR)'}
# AVPictureType
PICTURE_TYPES = {1: 'I', 2: 'P', 3: 'B', 4: 'S', 5: 'i', 6: 'p', 7: 'b'}
# Codecs that keep the values as they are
LOSSLESS_CODECS = {'ffv1', 'huffyuv', 'ffvhuff', 'utvideo', 'magicyuv', 'png', 'apng', 'qtrle', 'rawvideo', 'r210', 'v210', 'v410', 'zlib', 'zmbv', 'lagarith', 'flashsv'}

PACKED_RGB = {'rgb24', 'bgr24', 'rgba', 'bgra', 'argb', 'abgr', 'rgb0', 'bgr0', '0rgb', '0bgr'}
# Semi-planar formats (chroma interleaved): the same values, planar
PLANAR_EQUIVALENTS = {'nv12': 'yuv420p', 'nv21': 'yuv420p', 'nv16': 'yuv422p', 'nv24': 'yuv444p', 'p010le': 'yuv420p10le', 'p016le': 'yuv420p16le', 'yuyv422': 'yuv422p', 'uyvy422': 'yuv422p'}


def require_av():
  if av is None:
    raise RuntimeError("The server can't decode videos: install PyAV (pip install av)")


def _name(names, value):
  return names.get(int(value)) if value is not None else None


def _rational(value):
  return float(value) if value else None


def chroma_subsampling(pix_fmt):
  if pix_fmt.startswith(('yuv420', 'yuvj420', 'nv12', 'nv21', 'p010', 'p016')):
    return '4:2:0'
  if pix_fmt.startswith(('yuv422', 'yuvj422', 'nv16', 'yuyv', 'uyvy', 'y210')):
    return '4:2:2'
  if pix_fmt.startswith(('yuv411', 'yuvj411')):
    return '4:1:1'
  if pix_fmt.startswith(('yuv444', 'yuvj444', 'nv24', 'gbr', 'rgb', 'bgr', 'argb', 'abgr', '0rgb', '0bgr')):
    return '4:4:4'
  if pix_fmt.startswith(('gray', 'y8', 'y16')):
    return None
  return None


def channel_names(pix_fmt):
  if pix_fmt in PACKED_RGB:
    return ['R', 'G', 'B']
  if pix_fmt.startswith('gbr'):
    return ['G', 'B', 'R']
  if pix_fmt.startswith(('gray', 'y8', 'y16')):
    return ['Y']
  return ['Y', 'Cb', 'Cr']


def probe(path):
  """What's in a video file, and the timestamp, size and kind of each of its frames (in presentation order)"""
  require_av()
  with av.open(str(path)) as container:
    stream = container.streams.video[0]
    codec = stream.codec_context
    pix_fmt = codec.format.name if codec.format else None
    packets = []
    for packet in container.demux(stream):
      if packet.pts is None or getattr(packet, 'is_discard', False):
        continue
      packets.append((packet.pts, bool(packet.is_keyframe), packet.size))
    packets.sort()
    time_base = float(stream.time_base) if stream.time_base else 1 / 90000
    # presentation timestamps, like browsers' currentTime: a stream can start after 0 (e.g. delayed by B-frames)
    times = [round(pts * time_base, 6) for pts, _, _ in packets]
    deltas = np.diff(times) if len(times) > 1 else np.array([])
    keyframes = [i for i, (_, key, _) in enumerate(packets) if key]
    size = sum(s for _, _, s in packets)
    # the last frame lasts as long as the others
    duration = times[-1] + float(np.median(deltas)) if len(deltas) else (_rational(stream.duration * stream.time_base) if stream.duration else None)
    bits = max((c.bits for c in codec.format.components), default=8) if codec.format else 8
    variable = bool(len(deltas) > 2 and (deltas.max() - deltas.min()) > 0.25 * float(np.median(deltas)))
    audio = [{'codec': s.codec_context.name, 'channels': s.codec_context.channels, 'sample_rate': s.codec_context.sample_rate} for s in container.streams.audio]
    return {
      'container': container.format.name,
      # the format's name (av1), not its decoder's (libdav1d)
      'codec': getattr(codec.codec, 'canonical_name', None) or codec.name,
      'decoder': codec.name,
      'codec_long_name': codec.codec.long_name,
      'profile': codec.profile,
      'pix_fmt': pix_fmt,
      'bit_depth': bits,
      'chroma_subsampling': chroma_subsampling(pix_fmt or ''),
      'channels': channel_names(pix_fmt or ''),
      'color_range': _name(COLOR_RANGES, codec.color_range),
      'color_matrix': _name(COLOR_MATRICES, codec.colorspace),
      'color_primaries': _name(COLOR_PRIMARIES, codec.color_primaries),
      'color_transfer': _name(COLOR_TRANSFERS, codec.color_trc),
      'width': codec.width,
      'height': codec.height,
      'sample_aspect_ratio': str(stream.sample_aspect_ratio) if stream.sample_aspect_ratio else None,
      'fps': _rational(stream.average_rate) or (1 / float(np.median(deltas)) if len(deltas) else None),
      'variable_frame_rate': variable,
      'start_time': _rational(stream.start_time * stream.time_base) if stream.start_time is not None else None,
      'duration': duration,
      'frame_count': len(packets),
      'bit_rate': (8 * size / duration) if duration else container.bit_rate,
      'keyframes': keyframes,
      'lossless': True if (getattr(codec.codec, 'canonical_name', None) or codec.name) in LOSSLESS_CODECS else None,
      'audio': audio,
      # per frame: when it shows (its timestamp, in seconds), and its size in the file (bytes)
      'times': times,
      'sizes': [s for _, _, s in packets],
    }


# --- Decoded frames ---

def _plane(plane, dtype):
  """A plane of a frame, without the padding at the end of its lines"""
  itemsize = np.dtype(dtype).itemsize
  data = np.frombuffer(plane, dtype=dtype).reshape(-1, plane.line_size // itemsize)
  return data[:plane.height, :plane.width]


def frame_planes(frame):
  """
  The decoded values of a frame: a list of 2D arrays (chroma planes are smaller for 4:2:0...), their names, and how
  many bits they have (10-bit values are stored in 16 bits)
  """
  name = frame.format.name
  if name in PACKED_RGB:
    rgb = frame.to_ndarray(format='rgb24')
    return [rgb[:, :, c].copy() for c in range(3)], ['R', 'G', 'B'], 8
  if name in PLANAR_EQUIVALENTS:
    frame = frame.reformat(format=PLANAR_EQUIVALENTS[name])
    name = frame.format.name
  bits = max(c.bits for c in frame.format.components)
  dtype = np.uint8 if bits <= 8 else np.dtype('<u2')
  if name.endswith('be'):
    dtype = np.dtype('>u2')
  planes = [_plane(p, dtype).copy() for p in frame.planes]
  names = channel_names(name)
  # alpha
  names += ['A'] * (len(planes) - len(names))
  return planes, names, bits


def upsampled(planes, x, y, w, h):
  """The values of the region's pixels: (h, w, channels), each pixel with the chroma sample it uses"""
  height, width = planes[0].shape
  channels = []
  for plane in planes:
    sy, sx = height / plane.shape[0], width / plane.shape[1]
    rows = np.minimum((np.arange(y, y + h) / sy).astype(int), plane.shape[0] - 1)
    columns = np.minimum((np.arange(x, x + w) / sx).astype(int), plane.shape[1] - 1)
    channels.append(plane[np.ix_(rows, columns)])
  return np.stack(channels, axis=2)


class FrameReader:
  """Decodes the frames of a video by index, in presentation order. Reading the next frames doesn't seek."""

  def __init__(self, path):
    require_av()
    self.container = av.open(str(path))
    self.stream = self.container.streams.video[0]
    self.stream.thread_type = 'AUTO'
    self.time_base = self.stream.time_base
    self.lock = threading.Lock()
    self.frames = None
    self.position = -1
    self.pts = None

  def _index_pts(self):
    if self.pts is not None:
      return
    pts = []
    keys = []
    for packet in self.container.demux(self.stream):
      if packet.pts is None or getattr(packet, 'is_discard', False):
        continue
      pts.append(packet.pts)
      if packet.is_keyframe:
        keys.append(packet.pts)
    self.pts = sorted(pts)
    self.index_of = {p: i for i, p in enumerate(self.pts)}
    self.keyframes = sorted(keys)
    self._rewind()

  def _rewind(self, pts=None):
    if pts is None:
      self.container.seek(0, stream=self.stream, backward=True)
    else:
      self.container.seek(pts, stream=self.stream, backward=True, any_frame=False)
    self.frames = self.container.decode(self.stream)
    self.position = -1

  def count(self):
    self._index_pts()
    return len(self.pts)

  def frame(self, index):
    """The decoded frame `index`"""
    self._index_pts()
    if not 0 <= index < len(self.pts):
      raise IndexError(f"The video has {len(self.pts)} frames, there's no frame {index}")
    target = self.pts[index]
    # close ahead: we decode until there, else we seek to the keyframe before
    if not (self.position < index <= self.position + 48):
      keyframe = max((k for k in self.keyframes if k <= target), default=self.pts[0])
      self._rewind(keyframe)
    for frame in self.frames:
      if frame.pts is None:
        continue
      self.position = self.index_of.get(frame.pts, self.position + 1)
      if frame.pts == target:
        return frame
      if frame.pts > target:
        break
    # timestamps that don't match the packets' (rare): from the start, by count
    self._rewind()
    for i, frame in enumerate(self.frames):
      self.position = i
      if i == index:
        return frame
    raise IndexError(f"Can't decode frame {index}")

  def close(self):
    self.container.close()


class Readers:
  """Open videos, the last used kept: users step through frames, and the viewer asks for tiles of the same frame"""

  def __init__(self, size=4, frames=6):
    self.readers = OrderedDict()
    self.decoded = OrderedDict()
    self.size = size
    self.frames = frames
    self.lock = threading.Lock()

  def planes(self, path, index):
    """(planes, channel names, bits) of a frame"""
    key = (str(path), path.stat().st_mtime_ns)
    with self.lock:
      if (key, index) in self.decoded:
        self.decoded.move_to_end((key, index))
        return self.decoded[(key, index)]
      reader = self.readers.get(key)
      if reader is None:
        reader = self.readers[key] = FrameReader(path)
        while len(self.readers) > self.size:
          _, old = self.readers.popitem(last=False)
          with old.lock:
            old.close()
      self.readers.move_to_end(key)
    with reader.lock:
      frame = reader.frame(index)
      planes, names, bits = frame_planes(frame)
      decoded = (planes, names, bits)
    with self.lock:
      self.decoded[(key, index)] = decoded
      while len(self.decoded) > self.frames:
        self.decoded.popitem(last=False)
    return decoded


readers = Readers()


# --- Where two videos differ ---

# the working grid's cells along the longest side, and for the search over time (cells of 4x4 of the grid)
GRID = 256
COARSE = 4
REGIONS_PER_FRAME = 3


def _decoded(path, stop):
  """(time from the first frame, planes, bits, picture type, timestamp) of a video's frames, in presentation order, decoded in another thread"""
  frames = queue.Queue(maxsize=8)
  done = object()

  def put(item):
    while not stop.is_set():
      try:
        frames.put(item, timeout=0.1)
        return True
      except queue.Full:
        pass
    return False

  def decode():
    try:
      with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = 'AUTO'
        first = None
        for frame in container.decode(stream):
          if frame.pts is None:
            continue
          first = frame.pts if first is None else first
          planes, _, bits = frame_planes(frame)
          # from the first frame, to compare videos that start at other times
          since_first = float((frame.pts - first) * stream.time_base)
          if not put((since_first, planes, bits, PICTURE_TYPES.get(int(frame.pict_type), '?'), float(frame.pts * stream.time_base))):
            return
    except Exception as e:
      put(e)
    put(done)

  threading.Thread(target=decode, daemon=True).start()
  while True:
    item = frames.get()
    if item is done:
      return
    if isinstance(item, Exception):
      raise item
    yield item


def block_max(array, factor):
  """The largest value of each factor x factor block of a 2D array: like image_diff.block_reduce, 4 times faster"""
  if factor == 1:
    return array
  height, width = -(-array.shape[0] // factor) * factor, -(-array.shape[1] // factor) * factor
  if array.shape != (height, width):
    array = np.pad(array, ((0, height - array.shape[0]), (0, width - array.shape[1])))
  rows = array[0::factor].copy()
  for k in range(1, factor):
    np.maximum(rows, array[k::factor], out=rows)
  cells = rows[:, 0::factor].copy()
  for k in range(1, factor):
    np.maximum(cells, rows[:, k::factor], out=cells)
  return cells


def frame_difference(planes_1, planes_2, factor, top):
  """
  The difference of two decoded frames: (cells, stats). cells: the largest |difference| in each cell of the grid,
  over all the planes, relative to the largest value (top). stats: PSNR of the first plane (luma), its mean absolute
  difference, the largest difference of all the planes, and the fraction of pixels that differ at all.
  """
  height, width = planes_1[0].shape
  # the planes of the frame's size (luma, or the three of 4:4:4 and RGB) together: one pass to find their cells
  full = None
  small = []
  for i, (a, b) in enumerate(zip(planes_1, planes_2)):
    # |a - b| without a signed copy
    d = np.maximum(a, b)
    d -= np.minimum(a, b)
    if i == 0:
      values = d.ravel().astype(np.float32)
      mse = float(values @ values) / d.size
      mad = float(values.sum(dtype=np.float64)) / d.size
    if d.shape == (height, width):
      full = d if full is None else np.maximum(full, d, out=full)
    else:
      small.append(d)
  cells = block_max(full, factor).astype(np.float32)
  peak = int(cells.max())
  for d in small:
    # chroma planes are smaller (the factor is a multiple of 4): their cells are too
    subsampling = max(round(height / d.shape[0]), round(width / d.shape[1]))
    reduced = block_max(d, max(1, factor // subsampling))
    h, w = min(cells.shape[0], reduced.shape[0]), min(cells.shape[1], reduced.shape[1])
    np.maximum(cells[:h, :w], reduced[:h, :w], out=cells[:h, :w])
    peak = max(peak, int(reduced.max()))
  psnr = None if mse == 0 else 10 * math.log10(top * top / mse)
  return cells / top, {
    'psnr': round(psnr, 3) if psnr is not None else None,
    'mad': round(mad, 4),
    'max': peak,
    'changed': round(np.count_nonzero(full) / full.size, 6),
  }


def compare(path_new, path_ref, count=20, max_frames=20000, time_budget=120):
  """
  Where two videos differ, by comparing their decoded frames: each frame of the new video with the frame of the
  reference shown at the same time.
  {
    frames: [{time (its timestamp), ref (the reference's frame, by index), type, ref_type, psnr, mad, max, changed, value, regions}],
    regions: [{x, y, w, h, value, diff, frame, start, end}]: where they differ most, over the whole videos,
    compared: how many frames were compared, complete: all of them (else `reason` says why not),
    width, height, max_value: the largest value (e.g. 255, 1023),
  }
  value: the largest |difference| of the frame, relative to the largest possible value (e.g. 255).
  """
  require_av()
  stop = threading.Event()
  new = _decoded(path_new, stop)
  ref = _decoded(path_ref, stop)
  start = time.time()
  frames = []
  coarse = []
  projection = None
  reason = None
  shape = None
  factor = 1
  top = None
  try:
    ref_index = -1
    ref_frame = None
    upcoming = next(ref, None)
    for t, planes, bits, picture, timestamp in new:
      if shape is None:
        shape = planes[0].shape
        # a multiple of 4: the cells of chroma planes (4:2:0, 4:1:1) cover the same pixels
        factor = 4 * math.ceil(max(shape) / (4 * GRID))
        top = 2 ** bits - 1
      # the reference's frame shown at t: the last one that starts before (half a millisecond of rounding)
      while upcoming is not None and upcoming[0] <= t + 5e-4:
        ref_frame, ref_index = upcoming, ref_index + 1
        upcoming = next(ref, None)
      if ref_frame is None:
        ref_frame, ref_index = upcoming, 0
        upcoming = next(ref, None)
      if ref_frame is None:
        reason = 'The reference has no frames'
        break
      if ref_frame[1][0].shape != shape:
        (h1, w1), (h2, w2) = shape, ref_frame[1][0].shape
        raise ValueError(f"The videos have different sizes: {w1}x{h1} and {w2}x{h2}")
      cells, stats = frame_difference(planes, ref_frame[1], factor, top)
      frames.append({
        'time': round(timestamp, 6),
        'ref': ref_index,
        'type': picture,
        'ref_type': ref_frame[3],
        **stats,
        'value': round(stats['max'] / top, 6),
        'regions': find_regions(cells, factor, shape, REGIONS_PER_FRAME) if stats['max'] > 0 else [],
      })
      projection = cells if projection is None else np.maximum(projection, cells)
      coarse.append(block_max(cells, COARSE).astype(np.float16))
      if len(frames) >= max_frames:
        reason = f'Compared the first {max_frames} frames'
        break
      if time.time() - start > time_budget:
        reason = f'Compared the first {len(frames)} frames, in {time_budget} s'
        break
  finally:
    stop.set()
    # unblock the decoders
    for generator in (new, ref):
      generator.close()

  regions = []
  if projection is not None:
    series = np.stack(coarse).astype(np.float32) if coarse else None
    cell = factor * COARSE
    for region in find_regions(projection, factor, shape, count):
      # when it differs: around the frame where it differs most, while it's at least half as much
      x0, y0 = region['x'] // cell, region['y'] // cell
      x1, y1 = math.ceil((region['x'] + region['w']) / cell), math.ceil((region['y'] + region['h']) / cell)
      values = series[:, y0:y1, x0:x1].reshape(len(series), -1).max(axis=1)
      peak = int(np.argmax(values))
      above = values >= values[peak] / 2
      first, last = peak, peak
      while first > 0 and above[first - 1]:
        first -= 1
      while last < len(values) - 1 and above[last + 1]:
        last += 1
      regions.append({**region, 'frame': peak, 'start': first, 'end': last})
  return {
    'frames': frames,
    'regions': regions,
    'compared': len(frames),
    'complete': reason is None,
    'reason': reason,
    'width': int(shape[1]) if shape else None,
    'height': int(shape[0]) if shape else None,
    'max_value': top,
  }
