"""
The values a run logs while it runs, e.g. a training's loss at each step: its series.

A run saves two files in its output directory:

    series.jsonl   everything logged, one line per call, appended as the run goes:
                     {"_step": 120, "_time": 1731500000.5, "train/loss": 0.31, "lr": 0.001}
    series.json    the same, with at most ~1000 points per series: what the web app plots. It is small whatever
                   the length of the run, and replaced atomically, so it can be read while the run writes.

`series.jsonl` is the record: `read_series()` (and `run.series(key)`) read it. Programs in any language can write it,
the web app reads it too when there is no series.json. Values are numbers; NaN and infinities are the texts "NaN",
"Infinity" and "-Infinity", since JSON has no numbers for them.

`series.json` keeps, for each series, buckets of consecutive points: their last step and time, the mean of their
values, and their minimum and maximum, so that a spike between two plotted points still shows. When a series has
twice the points we keep, neighbor buckets are merged: memory and the file stay bounded, and old and recent values
have the same resolution.

    {"format": "qaboard-series", "version": 1, "started_at": 1731500000.5, "updated_at": 1731503600.1,
     "series": {"train/loss": {"points": 120000, "step": [...], "time": [...], "value": [...], "min": [...], "max": [...]}}}

`time` is in seconds since `started_at`. `min` and `max` are there once buckets hold several points.
The web app reads both files into the same model (webapp/src/viewers/series/series.js): both are tested on
tests/fixtures/series/. Change one, change the other.

This module only needs the standard library, and imports nothing from qaboard.
"""
import json
import math
import os
import time as time_module
import uuid
from pathlib import Path
from typing import Any, Dict, IO, Iterator, List, Mapping, NamedTuple, Optional, Tuple, Union

HISTORY = 'series.jsonl'
SUMMARY = 'series.json'
FORMAT = 'qaboard-series'
VERSION = 1
# In each line of series.jsonl
STEP = '_step'
TIME = '_time'
# Series keep between MAX_POINTS and 2 x MAX_POINTS buckets in series.json
MAX_POINTS = 500
NON_FINITE = {'NaN': math.nan, 'Infinity': math.inf, '-Infinity': -math.inf}


class Point(NamedTuple):
  step: int
  value: float
  time: float   # seconds since the epoch


def flatten(values: Mapping[str, Any], prefix: str = '') -> Dict[str, Any]:
  """{"train": {"loss": 1}} -> {"train/loss": 1}"""
  flat: Dict[str, Any] = {}
  for key, value in values.items():
    name = f"{prefix}{key}"
    if isinstance(value, Mapping):
      flat.update(flatten(value, f"{name}/"))
    else:
      flat[name] = value
  return flat


def as_number(value: Any) -> float:
  """
  A logged value as a Python number: numbers, booleans, and what has an `.item()` that gives one (numpy scalars,
  0-d arrays, PyTorch and TensorFlow scalars). Raises TypeError for anything else.
  """
  if isinstance(value, bool):
    return int(value)
  if isinstance(value, (int, float)):
    return value
  if not isinstance(value, (str, bytes)) and hasattr(value, 'item'):
    try:
      item = value.item()
    except Exception as e:
      raise TypeError(f"expected a number, got {type(value).__name__} ({e})") from e
    if isinstance(item, bool):
      return int(item)
    if isinstance(item, (int, float)):
      return item
  raise TypeError(f"expected a number, got {type(value).__name__}")


def _encode(value: float) -> Union[int, float, str]:
  if isinstance(value, float) and not math.isfinite(value):
    return 'NaN' if math.isnan(value) else ('Infinity' if value > 0 else '-Infinity')
  return value


def _decode(value: Any) -> Optional[float]:
  """A value of series.jsonl as a number, None if it isn't one"""
  if isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    return value
  if isinstance(value, str):
    return NON_FINITE.get(value)
  return None


def _round(value: float) -> float:
  """6 significant digits: plenty for a plot, and series.json stays small"""
  return float(f"{value:.6g}")


class Downsampled:
  """A series with a bounded number of points: buckets of `stride` consecutive values."""
  __slots__ = ('max_points', 'stride', 'points', 'buckets')

  def __init__(self, max_points: int = MAX_POINTS):
    self.max_points = max(2, max_points)
    self.stride = 1
    self.points = 0
    # [last step, last time, sum of the finite values, how many are finite, min, max, how many values]
    self.buckets: List[List[Any]] = []

  def add(self, step: int, value: float, time: float) -> None:
    self.points += 1
    finite = math.isfinite(value)
    bucket = self.buckets[-1] if self.buckets else None
    if bucket is None or bucket[6] >= self.stride:
      self.buckets.append([step, time, value if finite else 0.0, int(finite), value if finite else None, value if finite else None, 1])
      if len(self.buckets) > 2 * self.max_points:
        self._halve()
      return
    bucket[0], bucket[1] = step, time
    bucket[6] += 1
    if finite:
      bucket[2] += value
      bucket[3] += 1
      bucket[4] = value if bucket[4] is None else min(bucket[4], value)
      bucket[5] = value if bucket[5] is None else max(bucket[5], value)

  def _halve(self) -> None:
    merged = []
    for i in range(0, len(self.buckets) - 1, 2):
      a, b = self.buckets[i], self.buckets[i + 1]
      lows = [v for v in (a[4], b[4]) if v is not None]
      highs = [v for v in (a[5], b[5]) if v is not None]
      merged.append([b[0], b[1], a[2] + b[2], a[3] + b[3], min(lows) if lows else None, max(highs) if highs else None, a[6] + b[6]])
    if len(self.buckets) % 2:
      merged.append(self.buckets[-1])
    self.buckets = merged
    self.stride *= 2

  def to_dict(self, started_at: float = 0.0) -> Dict[str, Any]:
    series: Dict[str, Any] = {
      'points': self.points,
      'step': [b[0] for b in self.buckets],
      'time': [round(b[1] - started_at, 3) for b in self.buckets],
      # buckets without a finite value (NaN, infinities) are null: a gap in the plot
      'value': [_round(b[2] / b[3]) if b[3] else None for b in self.buckets],
    }
    if self.stride > 1:
      series['min'] = [_round(b[4]) if b[4] is not None else None for b in self.buckets]
      series['max'] = [_round(b[5]) if b[5] is not None else None for b in self.buckets]
    return series


def _not_json(constant: str) -> float:
  raise ValueError(f"{constant} is not JSON")


def read_history(path: Union[str, Path]) -> Iterator[Tuple[int, float, Dict[str, float]]]:
  """
  The lines of a series.jsonl: (step, time, {key: value}). Lines that aren't objects are skipped, like a last line
  cut by a run that was killed, and values that aren't numbers. Lines without "_step" count from the previous one.
  """
  step = -1
  try:
    file = open(path, encoding='utf-8')
  except OSError:
    return
  with file:
    for line in file:
      line = line.strip()
      if not line:
        continue
      try:
        # NaN and Infinity as bare words are not JSON: browsers refuse the line, so do we
        row = json.loads(line, parse_constant=_not_json)
      except ValueError:
        continue
      if not isinstance(row, dict):
        continue
      row_step = row.get(STEP)
      # 5 or 5.0, like JavaScript, where they are the same number
      if isinstance(row_step, (int, float)) and not isinstance(row_step, bool) and row_step == int(row_step):
        step = int(row_step)
      else:
        step += 1
      row_time = row.get(TIME)
      values = {}
      for key, value in row.items():
        if key in (STEP, TIME):
          continue
        number = _decode(value)
        if number is not None:
          values[key] = number
      yield step, float(row_time) if isinstance(row_time, (int, float)) and not isinstance(row_time, bool) else 0.0, values


def read_series(output_dir: Union[str, Path], key: str) -> List[Point]:
  """Everything a run logged for `key`, in the order it was logged"""
  return [Point(step, values[key], time) for step, time, values in read_history(Path(output_dir) / HISTORY) if key in values]


def series_keys(output_dir: Union[str, Path]) -> List[str]:
  """The names of the series a run logged, in the order they first appear"""
  keys: Dict[str, None] = {}
  for _, _, values in read_history(Path(output_dir) / HISTORY):
    for key in values:
      keys.setdefault(key)
  return list(keys)


class SeriesWriter:
  """
  Appends to a run's series.jsonl, and keeps its series.json up to date: `append()` buffers, `flush()` writes.
  With `resume`, continues the files that are there: steps go on from the last one.
  Not thread-safe: callers hold a lock.
  """
  def __init__(self, output_dir: Union[str, Path], resume: bool = False, max_points: int = MAX_POINTS):
    self.output_dir = Path(output_dir)
    self.max_points = max_points
    self.series: Dict[str, Downsampled] = {}
    self.last: Dict[str, float] = {}       # the last finite value of each series
    self.stats: Dict[str, List[float]] = {}  # of its finite values: [min, max, sum, how many]
    self.last_step = -1
    self.started_at: Optional[float] = None
    self.rows = 0
    self._dirty = False
    self._file: Optional[IO[str]] = None
    if resume:
      for step, time, values in read_history(self.output_dir / HISTORY):
        self._add(step, time, values)
    else:
      for name in (HISTORY, SUMMARY):
        try:
          (self.output_dir / name).unlink()
        except OSError:
          pass

  def _add(self, step: int, time: float, values: Mapping[str, float]) -> None:
    if self.started_at is None:
      self.started_at = time
    self.last_step = max(self.last_step, step)
    self.rows += 1
    for key, value in values.items():
      series = self.series.get(key)
      if series is None:
        series = self.series[key] = Downsampled(self.max_points)
      series.add(step, value, time)
      if math.isfinite(value):
        self.last[key] = value
        stats = self.stats.get(key)
        if stats is None:
          self.stats[key] = [value, value, value, 1]
        else:
          stats[0], stats[1], stats[2], stats[3] = min(stats[0], value), max(stats[1], value), stats[2] + value, stats[3] + 1

  def aggregate(self, key: str, how: str = 'last') -> Optional[float]:
    """A series as one number: its last finite value, or their `min`, `max` or `mean`. None before it has one."""
    stats = self.stats.get(key)
    if stats is None:
      return None
    if how == 'min':
      return stats[0]
    if how == 'max':
      return stats[1]
    if how == 'mean':
      return stats[2] / stats[3]
    return self.last[key]

  def append(self, values: Mapping[str, float], step: Optional[int] = None, time: Optional[float] = None) -> int:
    """Adds a point to each series. Without `step`, the step after the last one. Returns the step."""
    if step is None:
      step = self.last_step + 1
    if time is None:
      time = time_module.time()
    if self._file is None:
      self.output_dir.mkdir(parents=True, exist_ok=True)
      path = self.output_dir / HISTORY
      # a run that was killed can leave a line cut short: we don't write ours at its end
      cut = False
      try:
        with open(path, 'rb') as existing:
          existing.seek(-1, os.SEEK_END)
          cut = existing.read(1) != b'\n'
      except OSError: # no file, or empty
        pass
      self._file = open(path, 'a', encoding='utf-8')
      if cut:
        self._file.write('\n')
    row = {STEP: step, TIME: round(time, 3), **{key: _encode(value) for key, value in values.items()}}
    self._file.write(json.dumps(row, separators=(',', ':')) + '\n')
    self._add(step, time, values)
    self._dirty = True
    return step

  def summary(self) -> Dict[str, Any]:
    started_at = self.started_at or 0.0
    return {
      'format': FORMAT,
      'version': VERSION,
      'started_at': round(started_at, 3),
      'updated_at': round(time_module.time(), 3),
      'series': {key: series.to_dict(started_at) for key, series in self.series.items()},
    }

  def flush(self) -> bool:
    """Writes what was appended since the last flush. Returns whether there was anything to write."""
    if not self._dirty:
      return False
    if self._file is not None:
      self._file.flush()
    # atomic: the web app reads the file while the run goes on
    temporary = self.output_dir / f".{SUMMARY}.{uuid.uuid4().hex}.tmp"
    try:
      temporary.write_text(json.dumps(self.summary(), separators=(',', ':')), encoding='utf-8')
      os.replace(temporary, self.output_dir / SUMMARY)
    except OSError:
      try:
        temporary.unlink()
      except OSError:
        pass
      raise
    self._dirty = False
    return True

  def close(self) -> None:
    try:
      self.flush()
    finally:
      if self._file is not None:
        self._file.close()
        self._file = None
