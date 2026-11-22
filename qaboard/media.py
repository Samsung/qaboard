"""
What a run logs at a step besides numbers: images, audio, video, tables, histograms, texts, HTML, Plotly figures.
The web app shows them on the run's card with a step slider, next to the reference run's at the same step.

    run.log({"val/samples": [qaboard.Image(img, caption=name) for img, name in batch]}, step=step)
    run.log_audio("tts/sample", waveform, sample_rate=22050, step=step)

A run saves them in its output directory:

    media/<key>/<step>_<index>.<ext>   the files, e.g. media/val/samples/1200_0.png
    media.jsonl                        an index: one line per logged item, appended as the run goes:
      {"_step": 1200, "_time": 1731500000.5, "key": "val/samples", "kind": "image", "index": 0,
       "path": "media/val/samples/1200_0.png", "caption": "cat", "width": 64, "height": 48,
       "boxes": [{"x": 3, "y": 4, "w": 20, "h": 10, "label": "cat", "score": 0.9}]}

Fields, besides `_step` (an integer), `_time` (seconds since the epoch), `key`, `kind` and `index` (the position in
a list logged at that step, 0 for a single value):
- `path`: the file, relative to the run's folder, with "/". Histograms have none: their values are in the line.
- `caption`: optional, a short text
- `id`: optional, the sample's name, e.g. "img_0042": the web app matches items across steps and runs by it, else by
  caption, else by index. Give it when the samples aren't logged in the same order at each step (shuffled loaders).
- image: `width` and `height` when known; `boxes`, regions in pixels from the top left, with an optional `label`,
  `score` and `group` (e.g. "predictions", "ground_truth"). Boxes given as fractions of the image's size, when its
  size isn't known, have `"units": "fraction"`.
- audio: `sample_rate`, `channels` and `duration` (seconds) when known
- video: `fps` when known
- table: `columns`, and `rows` (how many). The file, .table.json, is {"columns": [...], "data": [[...], ...]}; cells
  that are media are files too, and in the table {"kind": "image", "path": "media/..."}.
- histogram: `bins`, the n+1 edges, and `counts`, the n counts
- text (.txt), html (.html), plotly (.plotly.json), file (anything else): only `path`

The same key, step and index logged again replaces the item: readers keep the last line. Readers skip lines that
don't parse (a run killed while it wrote one), and the kinds and fields they don't know.
The web app reads the index into the same model (webapp/src/viewers/media/media.js): both are tested on
tests/fixtures/media/. Change one, change the other.

This module needs only the standard library; numpy, Pillow and matplotlib are used when the values are theirs.
It imports nothing from qaboard.
"""
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import threading
import time as time_module
import uuid
import wave
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

INDEX = 'media.jsonl'
FOLDER = 'media'
KINDS = ('image', 'video', 'audio', 'table', 'histogram', 'text', 'html', 'plotly', 'file')
STEP = '_step'
TIME = '_time'
# like W&B: more bins are cut
MAX_BINS = 512
DEFAULT_BINS = 64
# tables are loaded whole in the browser
MAX_TABLE_ROWS = 100_000
MAX_CAPTION_LENGTH = 1000
# what viewers recognize files by, before their extension
DOUBLE_SUFFIXES = ('table', 'plotly', 'tar', 'series', 'flame', 'speedscope', 'junit', 'benchmarks')

Source = Union[bytes, Path]


class MediaError(ValueError):
  """A value we can't save as media: said to the user, the run goes on"""


def safe_key(key: str) -> str:
  """A key as a path: "val/samples" stays, characters other than letters, digits, ".", "_" and "-" become "_"."""
  parts = [re.sub(r'[^A-Za-z0-9._-]+', '_', p) for p in str(key).split('/')]
  return '/'.join(p for p in parts if p not in ('', '.', '..')) or 'media'


def _array(value: Any) -> Any:
  """numpy arrays, PyTorch/TensorFlow/JAX tensors as numpy arrays; None for other values"""
  if hasattr(value, 'detach'):  # torch
    value = value.detach().cpu().numpy()
  elif hasattr(value, 'numpy') and not hasattr(value, '__array_interface__') and callable(value.numpy):  # tensorflow
    try:
      value = value.numpy()
    except Exception:
      return None
  if hasattr(value, '__array_interface__') or hasattr(value, '__array__'):
    import numpy
    return numpy.asarray(value)
  if isinstance(value, (list, tuple)) and value:
    try:
      import numpy
    except ImportError:
      return None
    return numpy.asarray(value)
  return None


def _cell(value: Any) -> Any:
  """A value as JSON: numpy scalars as numbers, NaN as None"""
  if hasattr(value, 'item') and callable(value.item) and getattr(value, 'ndim', 0) == 0:
    value = value.item()
  if isinstance(value, float) and not math.isfinite(value):
    return None
  if isinstance(value, (str, int, float, bool)) or value is None:
    return value
  if isinstance(value, Mapping):
    return {str(k): _cell(v) for k, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [_cell(v) for v in value]
  array = _array(value)
  if array is not None:
    return _cell(array.tolist())
  return str(value)


# --- what code logs -------------------------------------------------------------------------------------------------
class Media:
  """What logged media share: their data (a file's path, bytes, arrays...) and a caption"""
  kind = 'file'

  def __init__(self, data: Any = None, caption: Optional[str] = None, id: Optional[str] = None):
    self.data = data
    self.caption = None if caption is None else str(caption)[:MAX_CAPTION_LENGTH]
    self.id = None if id is None else str(id)[:MAX_CAPTION_LENGTH]

  def __repr__(self) -> str:
    what = str(self.data) if isinstance(self.data, (str, os.PathLike)) else type(self.data).__name__
    return f"<qaboard.{type(self).__name__} {what}>"

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    """(the file's content or a file to copy, its extension, the index's fields). Raises MediaError"""
    path = _existing_path(self.data)
    if path is not None:
      return path, _suffix(path), {}
    if isinstance(self.data, bytes):
      return self.data, _sniff(self.data) or '.bin', {}
    raise MediaError(f"{type(self).__name__}() takes a file's path or bytes, not {type(self.data).__name__}")


def _existing_path(data: Any) -> Optional[Path]:
  if isinstance(data, os.PathLike) or (isinstance(data, str) and len(data) < 4096 and '\n' not in data):
    path = Path(data)
    try:
      if path.is_file():
        return path
    except OSError:
      return None
    if isinstance(data, os.PathLike):
      raise MediaError(f"{data} is not a file")
  return None


def _suffix(path: Path) -> str:
  """.png, .table.json, .tar.gz: what viewers recognize files by"""
  parts = path.name.lower().split('.')
  if len(parts) > 2 and parts[-2] in DOUBLE_SUFFIXES:
    return f".{parts[-2]}.{parts[-1]}"
  return path.suffix.lower()


def _sniff(data: bytes) -> Optional[str]:
  if data.startswith(b'\x89PNG'):
    return '.png'
  if data.startswith(b'\xff\xd8'):
    return '.jpg'
  if data[:6] in (b'GIF87a', b'GIF89a'):
    return '.gif'
  if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
    return '.webp'
  if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
    return '.wav'
  if data[:4] == b'fLaC':
    return '.flac'
  if data[:4] == b'OggS':
    return '.ogg'
  if data[:3] == b'ID3' or data[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2'):
    return '.mp3'
  if data[4:8] == b'ftyp':
    return '.mp4'
  if data[:4] == b'\x1aE\xdf\xa3':
    return '.webm'
  return None


class Image(Media):
  """
  An image: a file's path, bytes (PNG, JPEG...), a Pillow image, a matplotlib figure, or an array: HxW, HxWxC or
  CxHxW (like PyTorch), uint8 or floats in [0, 1].
  `boxes`: regions to outline, [{"x", "y", "w", "h", "label"?, "score"?, "group"?}] in pixels from the top left.
  """
  kind = 'image'

  def __init__(self, data: Any, caption: Optional[str] = None, boxes: Optional[Sequence[Mapping[str, Any]]] = None,
               id: Optional[str] = None):
    super().__init__(data, caption, id)
    self.boxes = _boxes(boxes)

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    fields: Dict[str, Any] = {}
    data = self.data
    content: Optional[Source] = None
    suffix = '.png'
    if hasattr(data, 'savefig') and type(data).__module__.startswith('matplotlib'):
      buffer = io.BytesIO()
      data.savefig(buffer, format='png')
      content = buffer.getvalue()
    elif hasattr(data, 'save') and hasattr(data, 'size') and type(data).__module__.startswith('PIL'):
      buffer = io.BytesIO()
      data.save(buffer, format='PNG')
      content = buffer.getvalue()
    else:
      path = _existing_path(data)
      if path is not None:
        content, suffix = path, _suffix(path)
      elif isinstance(data, bytes):
        content, suffix = data, _sniff(data) or '.png'
      else:
        array = _array(data)
        if array is None:
          raise MediaError(f"Image() takes a file's path, bytes, a Pillow image, a matplotlib figure or an array, not {type(data).__name__}")
        content = png(image_array(array))
    size = image_size(content if isinstance(content, bytes) else _head(content))
    if size:
      fields['width'], fields['height'] = size
    if self.boxes:
      fields['boxes'] = self.boxes
    return content, suffix, fields


def _boxes(boxes: Optional[Sequence[Mapping[str, Any]]]) -> List[Dict[str, Any]]:
  cleaned: List[Dict[str, Any]] = []
  for box in boxes or []:
    if not isinstance(box, Mapping):
      raise MediaError(f"Image(boxes=...) is a list of {{'x', 'y', 'w', 'h', 'label'}}, not {box!r}")
    try:
      region: Dict[str, Any] = {k: float(box[k]) for k in ('x', 'y', 'w', 'h')}
      score = None if box.get('score') is None else float(box['score'])
    except (KeyError, TypeError, ValueError):
      raise MediaError(f"Image(boxes=...): each box has numbers x, y, w and h, and a number as score, not {dict(box)!r}") from None
    if not all(math.isfinite(v) for v in region.values()) or (score is not None and not math.isfinite(score)):
      raise MediaError(f"Image(boxes=...): NaN or infinite numbers in {dict(box)!r}")
    for name in ('label', 'group', 'units'):
      if box.get(name) is not None:
        region[name] = str(box[name])
    if score is not None:
      region['score'] = score
    cleaned.append({k: ((int(v) if v.is_integer() else round(v, 6)) if k in ('x', 'y', 'w', 'h') else v) for k, v in region.items()})
  return cleaned


def _head(path: Optional[Source]) -> bytes:
  if not isinstance(path, Path):
    return b''
  try:
    with open(path, 'rb') as f:
      return f.read(64 * 1024)
  except OSError:
    return b''


def image_size(data: bytes) -> Optional[Tuple[int, int]]:
  """(width, height) of a PNG, GIF or JPEG from its first bytes"""
  if data.startswith(b'\x89PNG') and len(data) >= 24:
    return struct.unpack('>II', data[16:24])
  if data[:6] in (b'GIF87a', b'GIF89a') and len(data) >= 10:
    return struct.unpack('<HH', data[6:10])
  if data.startswith(b'\xff\xd8'):
    i = 2
    while i + 9 < len(data):
      if data[i] != 0xFF:
        i += 1
        continue
      marker = data[i + 1]
      if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
        height, width = struct.unpack('>HH', data[i + 5:i + 9])
        return width, height
      if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
        i += 2
        continue
      i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
  return None


def image_array(array: Any) -> Any:
  """An array as uint8 HxW, HxWx3 or HxWx4, like W&B reads them"""
  import numpy
  array = numpy.asarray(array)
  if array.ndim == 3 and array.shape[0] in (1, 3, 4) and array.shape[-1] not in (1, 3, 4):
    array = numpy.moveaxis(array, 0, -1)  # CHW
  if array.ndim == 3 and array.shape[-1] == 1:
    array = array[..., 0]
  if array.size == 0:
    raise MediaError("Image(): the array is empty")
  if array.ndim not in (2, 3) or (array.ndim == 3 and array.shape[-1] not in (3, 4)):
    raise MediaError(f"Image(): an array of shape {tuple(array.shape)} isn't an image: HxW, HxWxC or CxHxW, with 1, 3 or 4 channels")
  if array.dtype == numpy.bool_:
    array = array.astype(numpy.uint8) * 255
  elif array.dtype.kind == 'f':
    finite = array[numpy.isfinite(array)]
    scale = 255.0 if finite.size == 0 or finite.max() <= 1.0 else 1.0
    array = numpy.clip(numpy.nan_to_num(array) * scale, 0, 255)
  elif array.dtype.kind == 'u' and array.dtype.itemsize > 1:
    array = array >> (8 * array.dtype.itemsize - 8)  # 16-bit images, scaled down
  elif array.dtype != numpy.uint8:
    array = numpy.clip(array, 0, 255)
  return numpy.ascontiguousarray(array.astype(numpy.uint8))


def png(array: Any) -> bytes:
  """An uint8 HxW, HxWx3 or HxWx4 array as a PNG, without Pillow"""
  height, width = array.shape[:2]
  color = {2: 0, 3: 2}[array.ndim] if array.ndim == 2 or array.shape[-1] == 3 else 6
  rows = array.reshape(height, -1)
  raw = b''.join(b'\x00' + rows[y].tobytes() for y in range(height))

  def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
  return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')


class Audio(Media):
  """
  A sound: a file's path, bytes (WAV, MP3, FLAC, OGG...), or samples, an array of N or NxC values, floats in [-1, 1]
  or int16, with their `sample_rate`. Arrays are saved as 16-bit WAV.
  """
  kind = 'audio'

  def __init__(self, data: Any, sample_rate: Optional[int] = None, caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(data, caption, id)
    try:
      self.sample_rate = None if sample_rate is None else int(sample_rate)
    except (TypeError, ValueError):
      raise MediaError(f"Audio(sample_rate=...) is a number of samples per second, not {sample_rate!r}") from None
    if self.sample_rate is not None and self.sample_rate <= 0:
      raise MediaError(f"Audio(sample_rate=...) is positive, not {sample_rate}")

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    path = _existing_path(self.data)
    content: Source
    if path is not None:
      content, suffix = path, _suffix(path)
    elif isinstance(self.data, bytes):
      content, suffix = self.data, _sniff(self.data) or '.wav'
    else:
      array = _array(self.data)
      if array is None:
        raise MediaError(f"Audio() takes a file's path, bytes or samples (an array), not {type(self.data).__name__}")
      if not self.sample_rate:
        raise MediaError("Audio(samples) needs their sample_rate, e.g. Audio(samples, sample_rate=16000)")
      content, suffix = wav(array, self.sample_rate), '.wav'
    fields: Dict[str, Any] = {}
    if suffix == '.wav':
      fields.update(wav_info(content))
    if self.sample_rate and 'sample_rate' not in fields:
      fields['sample_rate'] = self.sample_rate
    return content, suffix, fields


def wav(array: Any, sample_rate: int) -> bytes:
  """N or NxC samples as a 16-bit PCM WAV. Arrays of C x N, with C < N and C <= 8, are transposed."""
  import numpy
  samples = numpy.asarray(array)
  if samples.ndim == 0:
    raise MediaError("Audio(): samples are N or NxC values, not a single number")
  if samples.ndim == 2 and samples.shape[0] <= 8 and samples.shape[0] < samples.shape[1]:
    samples = samples.T
  if samples.ndim == 1:
    samples = samples[:, None]
  if samples.ndim != 2:
    raise MediaError(f"Audio(): samples are N or NxC values, not an array of shape {tuple(samples.shape)}")
  if samples.dtype.kind == 'f':
    samples = numpy.clip(numpy.nan_to_num(samples), -1.0, 1.0) * 32767
  elif samples.dtype.kind == 'u':
    # centered, then like the signed integers of the same width
    bits = 8 * samples.dtype.itemsize
    samples = (samples.astype(numpy.int64) - (1 << (bits - 1))) * (2.0 ** (16 - bits))
  elif samples.dtype.kind == 'i':
    # int16 values in a wider type are common (lists of ints are int64): kept as they are; else scaled from the type's range
    peak = int(numpy.abs(samples.astype(numpy.int64)).max()) if samples.size else 0
    if samples.dtype.itemsize == 1:
      samples = samples.astype(numpy.int16) * 256
    elif samples.dtype.itemsize > 2 and peak > 32767:
      samples = samples / (2.0 ** (8 * samples.dtype.itemsize - 16))
  elif samples.dtype.kind == 'b':
    raise MediaError("Audio(): samples are numbers, not booleans")
  samples = numpy.clip(numpy.rint(samples) if samples.dtype.kind == 'f' else samples, -32768, 32767)
  buffer = io.BytesIO()
  with wave.open(buffer, 'wb') as f:
    f.setnchannels(samples.shape[1])
    f.setsampwidth(2)
    f.setframerate(int(sample_rate))
    f.writeframes(samples.astype('<i2').tobytes())
  return buffer.getvalue()


def wav_info(content: Source) -> Dict[str, Any]:
  try:
    with wave.open(io.BytesIO(content) if isinstance(content, bytes) else str(content), 'rb') as f:
      rate, frames = f.getframerate(), f.getnframes()
      return {'sample_rate': rate, 'channels': f.getnchannels(), 'duration': round(frames / rate, 3) if rate else None}
  except (wave.Error, EOFError, OSError):
    return {}


class Video(Media):
  """
  A video: a file's path or bytes (MP4, WebM, GIF...), or frames, an array of TxHxWxC or TxCxHxW (like W&B), saved as
  an animated GIF (needs Pillow). `fps` defaults to 4, like W&B.
  """
  kind = 'video'

  def __init__(self, data: Any, fps: Optional[float] = None, caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(data, caption, id)
    if fps is not None:
      try:
        fps = float(fps)
      except (TypeError, ValueError):
        raise MediaError(f"Video(fps=...) is a number, not {fps!r}") from None
      if not 0 < fps <= 1000:
        raise MediaError(f"Video(fps=...) is between 0 and 1000, not {fps}")
    self.fps = fps

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    fields: Dict[str, Any] = {} if self.fps is None else {'fps': self.fps}
    path = _existing_path(self.data)
    if path is not None:
      return path, _suffix(path), fields
    if isinstance(self.data, bytes):
      return self.data, _sniff(self.data) or '.mp4', fields
    array = _array(self.data)
    if array is None or array.ndim not in (3, 4):
      raise MediaError(f"Video() takes a file's path, bytes, or frames (an array TxHxWxC), not {type(self.data).__name__}")
    try:
      from PIL import Image as PILImage  # type: ignore[import-not-found,unused-ignore]
    except ImportError:
      raise MediaError("Video(frames) needs Pillow to save them (pip install pillow), or save the video yourself and give its path") from None
    if array.ndim == 4 and array.shape[1] in (1, 3, 4) and array.shape[-1] not in (1, 3, 4):
      import numpy
      array = numpy.moveaxis(array, 1, -1)
    frames = [PILImage.fromarray(image_array(frame)) for frame in array]
    if not frames:
      raise MediaError("Video(): no frames")
    fps = float(self.fps or 4)
    buffer = io.BytesIO()
    frames[0].save(buffer, format='GIF', save_all=True, append_images=frames[1:], duration=int(1000 / fps), loop=0)
    fields['fps'] = fps
    return buffer.getvalue(), '.gif', fields


class Table(Media):
  """
  Rows and columns: `Table(columns=["image", "label", "score"], data=[[qaboard.Image(x), "cat", 0.9], ...])`, or
  `Table(dataframe=df)`. Cells are numbers, texts, booleans, or media (saved as files).
  """
  kind = 'table'

  def __init__(self, columns: Optional[Sequence[Any]] = None, data: Optional[Sequence[Sequence[Any]]] = None,
               dataframe: Any = None, caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(None, caption, id)
    if dataframe is not None:
      columns, data = [str(c) for c in dataframe.columns], dataframe.values.tolist()
    if isinstance(data, Mapping):
      # {"label": [...], "score": [...]}, like MLflow's log_table
      columns = [str(c) for c in data]
      values = [list(v) if isinstance(v, (list, tuple)) or hasattr(v, '__len__') and not isinstance(v, str) else [v] for v in data.values()]
      length = max((len(v) for v in values), default=0)
      data = [[v[i] if i < len(v) else None for v in values] for i in range(length)]
    if data is not None and (isinstance(data, (str, bytes)) or not all(isinstance(row, (list, tuple)) or (hasattr(row, '__len__') and not isinstance(row, (str, bytes, Mapping))) for row in data)):
      raise MediaError("Table(data=...) is a list of rows, e.g. [[\"cat\", 0.9], [\"dog\", 0.4]], or a mapping of columns")
    self.rows: List[List[Any]] = [list(row) for row in (data or [])]
    self.columns: List[str] = [str(c) for c in columns] if columns else [f"c{i}" for i in range(len(self.rows[0]) if self.rows else 0)]

  def add_data(self, *values: Any) -> None:
    self.rows.append(list(values))

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    raise MediaError("tables are saved by MediaLog.add()")


class Histogram(Media):
  """A distribution: `Histogram(values, bins=64)`, or `Histogram(np_histogram=numpy.histogram(values))`"""
  kind = 'histogram'

  def __init__(self, values: Any = None, bins: int = DEFAULT_BINS, np_histogram: Optional[Tuple[Any, Any]] = None,
               caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(None, caption, id)
    try:
      if np_histogram is not None:
        counts, edges = (_cell(v) for v in np_histogram)
      else:
        counts, edges = histogram(values, bins)
      if len(edges) != len(counts) + 1:
        raise MediaError(f"Histogram(): {len(counts)} counts need {len(counts) + 1} bin edges, not {len(edges)}")
      if len(counts) > MAX_BINS:
        raise MediaError(f"Histogram(): at most {MAX_BINS} bins, not {len(counts)}")
      self.counts: List[float] = [float(c or 0) for c in counts]
      self.bins: List[float] = [float(e) for e in edges]
    except MediaError:
      raise
    except (TypeError, ValueError, OverflowError) as e:
      raise MediaError(f"Histogram() takes numbers: {e}") from None
    if not all(math.isfinite(v) for v in self.bins + self.counts):
      raise MediaError("Histogram(): NaN or infinite bin edges or counts")

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    return None, '', {'bins': [_number(e) for e in self.bins], 'counts': [_number(c) for c in self.counts]}


def _number(value: float) -> Union[int, float]:
  return int(value) if value.is_integer() else round(value, 9)


def histogram(values: Any, bins: int = DEFAULT_BINS) -> Tuple[List[float], List[float]]:
  """(counts, edges) of the finite values"""
  bins = max(1, min(int(bins), MAX_BINS))
  array = _array(values)
  if array is not None:
    import numpy
    finite = array[numpy.isfinite(array)] if array.dtype.kind in 'fc' else array.ravel()
    if finite.size == 0:
      return [0.0] * bins, [float(i) / bins for i in range(bins + 1)]
    counts, edges = numpy.histogram(finite, bins=bins)
    return counts.tolist(), edges.tolist()
  numbers = [float(v) for v in (values or []) if v is not None and math.isfinite(float(v))]
  low, high = (min(numbers), max(numbers)) if numbers else (0.0, 1.0)
  if low == high:
    low, high = low - 0.5, high + 0.5
  width = (high - low) / bins
  result = [0.0] * bins
  for v in numbers:
    result[min(int((v - low) / width), bins - 1)] += 1
  return result, [low + i * width for i in range(bins + 1)]


def _text(value: Any) -> str:
  return value.decode('utf-8', errors='replace') if isinstance(value, (bytes, bytearray)) else str(value)


class Text(Media):
  """A text, e.g. a model's answer at this step"""
  kind = 'text'

  def __init__(self, text: Any, caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(_text(text), caption, id)

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    return str(self.data).encode('utf-8'), '.txt', {}


class Html(Media):
  """An HTML page, or a file's path"""
  kind = 'html'

  def __init__(self, html: Any, caption: Optional[str] = None, id: Optional[str] = None):
    if hasattr(html, 'read'):
      html = html.read()
    super().__init__(html if isinstance(html, os.PathLike) else _text(html), caption, id)

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    if isinstance(self.data, os.PathLike) or (isinstance(self.data, str) and '<' not in self.data and len(self.data) < 4096 and self.data.lower().endswith(('.html', '.htm'))):
      path = _existing_path(self.data)
      if path is None:
        raise MediaError(f"Html(): {self.data} is not a file")
      return path, '.html', {}
    return str(self.data).encode('utf-8'), '.html', {}


class Plotly(Media):
  """A Plotly figure"""
  kind = 'plotly'

  def __init__(self, figure: Any, caption: Optional[str] = None, id: Optional[str] = None):
    super().__init__(figure, caption, id)

  def encode(self) -> Tuple[Optional[Source], str, Dict[str, Any]]:
    if hasattr(self.data, 'to_json'):
      return self.data.to_json().encode('utf-8'), '.plotly.json', {}
    if isinstance(self.data, Mapping):
      return json.dumps(_cell(self.data)).encode('utf-8'), '.plotly.json', {}
    raise MediaError(f"Plotly() takes a Plotly figure, not {type(self.data).__name__}")


class File(Media):
  """Any file, at this step: a checkpoint's report, a point cloud..."""
  kind = 'file'


def as_media(value: Any) -> Optional[Media]:
  """Our media, and what code logs as is: Pillow images, matplotlib and Plotly figures. None for other values"""
  if isinstance(value, Media):
    return value
  module = type(value).__module__ or ''
  if module.startswith('PIL') and hasattr(value, 'save'):
    return Image(value)
  if module.startswith('matplotlib') and hasattr(value, 'savefig'):
    return Image(value)
  if module.startswith('plotly') and hasattr(value, 'to_json'):
    return Plotly(value)
  return None


def is_media(value: Any) -> bool:
  """A media value, or a non-empty list of them"""
  if isinstance(value, (list, tuple)):
    return bool(value) and all(as_media(v) is not None for v in value)
  return as_media(value) is not None


# --- saving ---------------------------------------------------------------------------------------------------------
def _write(target: Path, source: Source) -> None:
  target.parent.mkdir(parents=True, exist_ok=True)
  # atomic: the web app may read the previous file
  # unique per call, and short: the file's own name can be near the system's limit
  temporary = target.with_name(f".{uuid.uuid4().hex[:16]}.tmp")
  try:
    if isinstance(source, bytes):
      temporary.write_bytes(source)
    else:
      shutil.copyfile(source, temporary)
    os.replace(temporary, target)
  finally:
    if temporary.exists():
      temporary.unlink()


class MediaLog:
  """
  Saves logged media in a run's folder and appends them to its index. Thread-safe.
  - save: how files are written, `save(relative path, bytes or a file to copy)`; by default atomically
  """
  def __init__(self, output_dir: Union[str, Path], resume: bool = False, save: Optional[Callable[[str, Source], Any]] = None):
    self.output_dir = Path(output_dir)
    self._save = save or (lambda relative, source: _write(self.output_dir / relative, source))
    self._lock = threading.Lock()
    self.count = 0
    # each key's folder: keys that are the same once made safe for paths, or but for their case, get folders of their own
    self._folders: Dict[str, str] = {}
    if resume:
      for line in read_media(self.output_dir):
        path = line.get('path')
        if isinstance(path, str) and path.startswith(f"{FOLDER}/") and path.count('/') >= 2:
          self._folders.setdefault(line['key'], path[len(FOLDER) + 1:path.rindex('/')])
    else:
      try:
        (self.output_dir / INDEX).unlink()
      except OSError:
        pass

  def folder(self, key: str) -> str:
    """Where a key's files go, under media/"""
    with self._lock:
      folder = self._folders.get(key)
      if folder is None:
        folder = safe_key(key)
        taken = {f.lower() for k, f in self._folders.items() if k != key}
        if folder.lower() in taken:
          folder = f"{folder}-{hashlib.sha1(key.encode('utf-8')).hexdigest()[:8]}"
        self._folders[key] = folder
      return folder

  def add(self, key: str, step: int, value: Any, time: Optional[float] = None) -> List[Dict[str, Any]]:
    """
    Saves a media value, or a list of them, at a step. Returns the index's lines. Raises MediaError, and then saves
    nothing: the values are all encoded and checked before any file is written.
    """
    values = list(value) if isinstance(value, (list, tuple)) else [value]
    media = [as_media(v) for v in values]
    if not media or any(m is None for m in media):
      raise MediaError(f"{key}: not a media value: {type(value).__name__}")
    when = time_module.time() if time is None else time
    stem = f"{FOLDER}/{self.folder(key)}/{int(step)}"
    prepared = [self._prepare(key, f"{stem}_{index}", int(step), m, index, when) for index, m in enumerate(media) if m is not None]
    for line, _ in prepared:
      try:
        json.dumps(line, allow_nan=False)
      except (TypeError, ValueError) as e:
        raise MediaError(f"{key}: {e}") from None
    for _, writes in prepared:
      for path, content in writes:
        self._save(path, content)
    lines = [line for line, _ in prepared]
    self._append(lines)
    return lines

  def _prepare(self, key: str, stem: str, step: int, media: Media, index: int, when: float) -> Tuple[Dict[str, Any], List[Tuple[str, Source]]]:
    """An item's line in the index, and the files to write for it"""
    line: Dict[str, Any] = {STEP: step, TIME: round(when, 3), 'key': key, 'kind': media.kind, 'index': index}
    writes: List[Tuple[str, Source]] = []
    if isinstance(media, Table):
      columns, rows = self._table(stem, media, writes)
      path = f"{stem}.table.json"
      writes.append((path, json.dumps({'columns': columns, 'data': rows}, separators=(',', ':'), allow_nan=False).encode('utf-8')))
      line.update(path=path, columns=columns, rows=len(rows))
    else:
      content, suffix, fields = media.encode()
      if content is not None:
        line['path'] = f"{stem}{suffix}"
        writes.append((line['path'], content))
      line.update({k: _cell(v) for k, v in fields.items() if v is not None})
    if media.caption:
      line['caption'] = media.caption
    if media.id:
      line['id'] = media.id
    return line, writes

  def _table(self, stem: str, table: Table, writes: List[Tuple[str, Source]]) -> Tuple[List[str], List[List[Any]]]:
    rows = table.rows
    if len(rows) > MAX_TABLE_ROWS:
      raise MediaError(f"Table(): at most {MAX_TABLE_ROWS} rows, not {len(rows)}: save bigger tables as files")
    cleaned: List[List[Any]] = []
    for r, row in enumerate(rows):
      cells: List[Any] = []
      for c, value in enumerate(row):
        media = as_media(value)
        if media is None or isinstance(media, (Table, Histogram)):
          cells.append(_cell(value) if media is None else repr(value))
          continue
        content, suffix, fields = media.encode()
        cell: Dict[str, Any] = {'kind': media.kind}
        if content is not None:
          cell['path'] = f"{stem}/{r}_{c}{suffix}"
          writes.append((cell['path'], content))
        cell.update({k: _cell(v) for k, v in fields.items() if v is not None})
        if media.caption:
          cell['caption'] = media.caption
        cells.append(cell)
      cleaned.append(cells)
    return list(table.columns), cleaned

  def _append(self, lines: List[Dict[str, Any]]) -> None:
    text = ''.join(json.dumps(line, separators=(',', ':'), allow_nan=False) + '\n' for line in lines)
    with self._lock:
      self.output_dir.mkdir(parents=True, exist_ok=True)
      path = self.output_dir / INDEX
      with open(path, 'a+b') as f:
        # a run that was killed can leave a line cut short: we don't write ours at its end
        f.seek(0, os.SEEK_END)
        if f.tell() > 0:
          f.seek(-1, os.SEEK_END)
          if f.read(1) != b'\n':
            f.write(b'\n')
        f.write(text.encode('utf-8'))
      self.count += len(lines)


# --- reading --------------------------------------------------------------------------------------------------------
def read_media(output_dir: Union[str, Path], key: Optional[str] = None) -> List[Dict[str, Any]]:
  """The items a run logged (of a key), as the index has them, sorted by key, step and index; the last of duplicates"""
  path = Path(output_dir) / INDEX
  items: Dict[Tuple[str, int, int], Dict[str, Any]] = {}
  try:
    f = open(path, encoding='utf-8')
  except OSError:
    return []
  with f:
    for text in f:
      try:
        line = json.loads(text)
      except ValueError:
        continue
      if not isinstance(line, dict) or line.get('kind') not in KINDS or not isinstance(line.get('key'), str):
        continue
      step, index = line.get(STEP), line.get('index', 0)
      if not isinstance(step, int) or isinstance(step, bool) or not isinstance(index, int) or isinstance(index, bool):
        continue
      if key is not None and line['key'] != key:
        continue
      items[(line['key'], step, index)] = line
  return [items[k] for k in sorted(items)]
