"""
wandb's media and data types: the drop-in's minimal classes, and saving them, ours or the real wandb's, as files of
the run (`media/<key>/<step>.<ext>`). QA-Board lists them in Output Files and opens them with the viewer their name
picks; it doesn't show media per step next to the series: each type says so once (UNSUPPORTED).

Only what is cheap: images (with Pillow, or from a file), files given by path (video, audio, 3D, molecules), HTML,
Plotly figures, tables and histograms as JSON.
"""
import io
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple, Union

from ._bridge import UNSUPPORTED

MEDIA = ('Image', 'Video', 'Audio', 'Object3D', 'Molecule', 'Html', 'Plotly', 'Table', 'Histogram', 'Graph')


def _safe(key: str) -> str:
  parts = [re.sub(r'[^A-Za-z0-9._-]+', '_', p) for p in key.split('/')]
  return '/'.join(p for p in parts if p not in ('', '.', '..')) or 'media'


def _jsonable(value: Any) -> Any:
  from ...active_run import _jsonable as jsonable
  return jsonable(value)


# --- the drop-in's classes: what code builds, and what we save ------------------------------------------------------
class Media:
  """What wandb's media classes share: a file (`_path`), or data we save when the value is logged"""
  def __init__(self, data_or_path: Any = None, caption: Optional[str] = None, **kwargs: Any):
    self._path: Optional[str] = str(data_or_path) if isinstance(data_or_path, (str, os.PathLike)) else None
    self._data = None if self._path else data_or_path
    self.caption = caption
    self._kwargs = kwargs

  def __repr__(self) -> str:
    return f"<wandb.{type(self).__name__} (qaboard) {self._path or type(self._data).__name__}>"


class Image(Media):
  def __init__(self, data_or_path: Any, mode: Optional[str] = None, caption: Optional[str] = None, **kwargs: Any):
    super().__init__(data_or_path, caption=caption, **kwargs)
    self.mode = mode
    if kwargs.get('boxes') or kwargs.get('masks'):
      UNSUPPORTED.warn("wandb.Image(boxes=..., masks=...)", "the image is saved without its boxes and masks")


class Video(Media):
  def __init__(self, data_or_path: Any, caption: Optional[str] = None, fps: Optional[int] = None, format: Optional[str] = None, **kwargs: Any):
    super().__init__(data_or_path, caption=caption, **kwargs)
    self.fps, self.format = fps, format


class Audio(Media):
  def __init__(self, data_or_path: Any, sample_rate: Optional[int] = None, caption: Optional[str] = None, **kwargs: Any):
    super().__init__(data_or_path, caption=caption, **kwargs)
    self.sample_rate = sample_rate


class Object3D(Media):
  pass


class Molecule(Media):
  pass


class Html(Media):
  def __init__(self, data: Any, inject: bool = True, **kwargs: Any):
    if hasattr(data, 'read'):
      data = data.read()
    is_file = isinstance(data, os.PathLike) or (isinstance(data, str) and '<' not in data and Path(data).is_file())
    super().__init__(data if is_file else None)
    self.html = None if is_file else str(data)


class Plotly(Media):
  def __init__(self, val: Any):
    super().__init__(None)
    self._data = val


class Graph(Media):
  pass


class Histogram:
  def __init__(self, sequence: Optional[Sequence[Any]] = None, np_histogram: Optional[Tuple[Any, Any]] = None, num_bins: int = 64):
    if np_histogram is not None:
      self.histogram, self.bins = [_jsonable(v) for v in np_histogram]
      return
    values = [float(v) for v in _jsonable(list(sequence or []))]
    try:
      import numpy
      histogram, bins = numpy.histogram(values, bins=num_bins)
      self.histogram, self.bins = histogram.tolist(), bins.tolist()
    except ImportError:
      low, high = (min(values), max(values)) if values else (0.0, 1.0)
      width = (high - low) / num_bins or 1.0
      self.bins = [low + i * width for i in range(num_bins + 1)]
      self.histogram = [0] * num_bins
      for v in values:
        self.histogram[min(int((v - low) / width), num_bins - 1)] += 1


class Table:
  def __init__(self, columns: Optional[List[str]] = None, data: Optional[List[Any]] = None, rows: Optional[List[Any]] = None,
               dataframe: Any = None, **kwargs: Any):
    if dataframe is not None:
      columns, data = [str(c) for c in dataframe.columns], dataframe.values.tolist()
    data = data if data is not None else rows
    self.data: List[Any] = [list(r) for r in (data or [])]
    self.columns: List[str] = list(columns) if columns else ([f"c{i}" for i in range(len(self.data[0]))] if self.data else [])

  def add_data(self, *values: Any) -> None:
    self.data.append(list(values))

  def add_column(self, name: str, data: Sequence[Any]) -> None:
    self.columns.append(name)
    for row, value in zip(self.data, data):
      row.append(value)

  def get_column(self, name: str) -> List[Any]:
    index = self.columns.index(name)
    return [row[index] for row in self.data]

  def get_dataframe(self) -> Any:
    import pandas  # type: ignore[import-untyped,import-not-found,unused-ignore]
    return pandas.DataFrame(self.data, columns=self.columns)


class CustomChart:
  """What wandb.plot.* give: a table, and a chart W&B draws from it"""
  def __init__(self, table: Table, kind: str):
    self.table, self.kind = table, kind


class _Plot:
  """wandb.plot: the charts' data, saved as a table"""
  def line(self, table: Table, x: str, y: str, title: Optional[str] = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'line')

  def scatter(self, table: Table, x: str, y: str, title: Optional[str] = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'scatter')

  def bar(self, table: Table, label: str, value: str, title: Optional[str] = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'bar')

  def histogram(self, table: Table, value: str, title: Optional[str] = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'histogram')

  def line_series(self, xs: Any, ys: Any, keys: Optional[List[str]] = None, title: Optional[str] = None, xname: str = 'x', **_: Any) -> CustomChart:
    xs_list = list(xs)
    if xs_list and not isinstance(xs_list[0], (list, tuple)) and not hasattr(xs_list[0], '__len__'):
      xs_list = [xs_list] * len(list(ys))
    rows = [[key, x, y] for i, (xx, yy) in enumerate(zip(xs_list, ys)) for key in [(keys or [])[i] if keys and i < len(keys) else f"key_{i}"] for x, y in zip(xx, yy)]
    return CustomChart(Table(columns=['lineKey', xname, 'y'], data=rows), 'line_series')

  def confusion_matrix(self, probs: Any = None, y_true: Any = None, preds: Any = None, class_names: Optional[List[str]] = None, title: Optional[str] = None, **_: Any) -> CustomChart:
    y_true = list(_jsonable(y_true) or [])
    if preds is None and probs is not None:
      preds = [max(range(len(p)), key=lambda i: p[i]) for p in _jsonable(probs)]
    preds = list(_jsonable(preds) or [])
    classes = class_names or [str(i) for i in range(max(y_true + preds + [-1]) + 1)]
    counts: dict = {}
    for t, p in zip(y_true, preds):
      counts[(t, p)] = counts.get((t, p), 0) + 1
    rows = [[classes[t], classes[p], n] for (t, p), n in sorted(counts.items())]
    return CustomChart(Table(columns=['Actual', 'Predicted', 'nPredictions'], data=rows), 'confusion_matrix')

  def pr_curve(self, y_true: Any = None, y_probas: Any = None, labels: Any = None, **_: Any) -> CustomChart:
    return CustomChart(Table(columns=['y_true', 'y_probas'], data=[[t, p] for t, p in zip(_jsonable(y_true) or [], _jsonable(y_probas) or [])]), 'pr_curve')

  def roc_curve(self, y_true: Any = None, y_probas: Any = None, labels: Any = None, **_: Any) -> CustomChart:
    return CustomChart(Table(columns=['y_true', 'y_probas'], data=[[t, p] for t, p in zip(_jsonable(y_true) or [], _jsonable(y_probas) or [])]), 'roc_curve')

  def __getattr__(self, name: str) -> Any:
    if name.startswith('_'):
      raise AttributeError(name)

    def chart(*args: Any, **kwargs: Any) -> CustomChart:
      table = next((a for a in list(args) + list(kwargs.values()) if _is(a, 'Table')), None)
      return CustomChart(table if table is not None else Table(), name)
    return chart


plot = _Plot()


class Artifact:
  """wandb.Artifact: files to copy in the run (`artifacts/<name>/`). No versions, aliases, lineage"""
  def __init__(self, name: str, type: str = 'artifact', description: Optional[str] = None, metadata: Optional[dict] = None, **_: Any):
    self.name, self.type, self.description = name, type, description
    self.metadata = dict(metadata or {})
    self.version = 'v0'
    self.aliases: List[str] = []
    self._files: List[Tuple[str, Path]] = []
    self._temporary: Optional[str] = None

  def add_file(self, local_path: Union[str, os.PathLike], name: Optional[str] = None, **_: Any) -> None:
    self._files.append((name or Path(local_path).name, Path(local_path)))

  def add_dir(self, local_path: Union[str, os.PathLike], name: Optional[str] = None, **_: Any) -> None:
    root = Path(local_path)
    for path in sorted(root.rglob('*')):
      if path.is_file():
        relative = path.relative_to(root).as_posix()
        self._files.append((f"{name}/{relative}" if name else relative, path))

  def add_reference(self, uri: Any, name: Optional[str] = None, **_: Any) -> None:
    UNSUPPORTED.warn("Artifact.add_reference()", "references aren't copied: the run's files are those you give it")

  def add(self, obj: Any, name: str) -> None:
    UNSUPPORTED.warn("Artifact.add() of media and tables", "add files with add_file()")

  def new_file(self, name: str, mode: str = 'x', encoding: Optional[str] = None) -> Any:
    if self._temporary is None:
      self._temporary = tempfile.mkdtemp(prefix='qaboard-artifact-')
    path = Path(self._temporary) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    self._files.append((name, path))
    return open(path, mode.replace('x', 'w'), encoding=encoding)

  def save(self, *args: Any, **kwargs: Any) -> None:
    pass

  def wait(self, *args: Any, **kwargs: Any) -> 'Artifact':
    return self

  def download(self, *args: Any, **kwargs: Any) -> Optional[str]:
    UNSUPPORTED.warn("downloading artifacts", "QA-Board has no artifact store: read the files from where they are")
    return None


def artifact_files(artifact: Any, name: Optional[str] = None) -> List[Tuple[str, Path]]:
  """The files of an artifact (ours, or wandb's: its manifest), or of a path, as (name in the run, local file)"""
  if isinstance(artifact, (str, os.PathLike)):
    path = Path(artifact)
    label = _safe(name or path.name)
    if path.is_dir():
      return [(f"artifacts/{label}/{p.relative_to(path).as_posix()}", p) for p in sorted(path.rglob('*')) if p.is_file()]
    return [(f"artifacts/{label}/{path.name}" if name else f"artifacts/{path.name}", path)] if path.is_file() else []
  label = _safe(name or str(getattr(artifact, 'name', '') or 'artifact').split(':')[0])
  files: List[Tuple[str, Path]] = []
  own = getattr(artifact, '_files', None)
  if isinstance(own, list):
    files = list(own)
  else:
    try:
      for entry_name, entry in artifact.manifest.entries.items():
        local = getattr(entry, 'local_path', None)
        if local:
          files.append((str(entry_name), Path(local)))
        else:
          UNSUPPORTED.warn("Artifact.add_reference()", "references aren't copied: the run's files are those you give it")
    except AttributeError:
      UNSUPPORTED.warn(f"artifacts of type {type(artifact).__name__}", "not copied")
  return [(f"artifacts/{label}/{n}", p) for n, p in files if p.is_file()]


# --- saving logged values -------------------------------------------------------------------------------------------
def _is(value: Any, name: str) -> bool:
  return any(c.__name__ == name and (c.__module__.startswith('wandb') or c.__module__.startswith('qaboard')) for c in type(value).__mro__)


def _kind(value: Any) -> Optional[str]:
  for name in MEDIA:
    if _is(value, name):
      return name
  if _is(value, 'CustomChart') or _is(value, 'Visualize') or type(value).__module__.startswith('wandb.plot'):
    return 'plot'
  if hasattr(value, 'savefig') and type(value).__module__.startswith('matplotlib'):
    return 'figure'
  return None


def save(run: Any, key: str, step: int, value: Any) -> bool:
  """Saves a logged media value (or a list of them) as files of the run. False when it isn't one"""
  if isinstance(value, (list, tuple)) and value and all(_kind(v) for v in value):
    for index, item in enumerate(value):
      _save_one(run, key, step, item, index)
    return True
  if _kind(value) is None:
    return False
  _save_one(run, key, step, value, None)
  return True


def _save_one(run: Any, key: str, step: int, value: Any, index: Optional[int]) -> None:
  kind = _kind(value)
  feature = 'wandb.plot.*' if kind == 'plot' else ('matplotlib figures' if kind == 'figure' else f"wandb.{kind}")
  UNSUPPORTED.warn(f"{feature} in wandb.log()", f"saved as files, media/<key>/<step>.<ext>, listed in Output Files: the web app doesn't show {'tables' if kind in ('Table', 'plot') else 'media'} per step")
  stem = f"media/{_safe(key)}/{step}{'' if index is None else f'_{index}'}"
  content: Optional[bytes] = None
  suffix = ''
  path = getattr(value, '_path', None)
  if kind == 'plot':
    table = getattr(value, 'table', None)
    value = table if table is not None else getattr(value, '_data', None)
    kind = 'Table' if value is not None and _is(value, 'Table') else None
    if kind is None:
      return
  if kind == 'Table':
    columns = list(getattr(value, 'columns', []) or [])
    content, suffix = json.dumps({'columns': _jsonable(columns), 'data': _jsonable(_table_rows(value))}).encode(), '.table.json'
  elif kind == 'Histogram':
    content, suffix = json.dumps({'histogram': _jsonable(getattr(value, 'histogram', None)), 'bins': _jsonable(getattr(value, 'bins', None))}).encode(), '.histogram.json'
  elif kind == 'Html' and getattr(value, 'html', None) is not None:
    content, suffix = str(value.html).encode(), '.html'
  elif kind == 'Plotly':
    data = getattr(value, '_data', None)
    if data is not None and hasattr(data, 'to_json'):
      content, suffix = data.to_json().encode(), '.plotly.json'
  elif kind == 'figure':
    content, suffix = _figure_png(value), '.png'
  elif kind == 'Image' and not (path and Path(path).is_file()):
    image = getattr(value, '_image', None)
    content, suffix = _image_png(image if image is not None else getattr(value, '_data', None)), '.png'
  if content is None and path and Path(str(path)).is_file():
    source = Path(str(path))
    name = source.name
    suffix = name[name.index('.'):] if '.' in name else ''
    run.log_artifact(f"{stem}{suffix}", source)
    return
  if content is None:
    UNSUPPORTED.warn(f"wandb.{kind} from in-memory data", "saved only from a file path (or, for images, with Pillow installed)")
    return
  run.log_artifact(f"{stem}{suffix}", content)


def _table_rows(table: Any) -> List[Any]:
  data = getattr(table, 'data', None)
  if data is None:
    return []
  return [[v if not _kind(v) else repr(v) for v in row] for row in data]


def _figure_png(figure: Any) -> Optional[bytes]:
  try:
    buffer = io.BytesIO()
    figure.savefig(buffer, format='png')
    return buffer.getvalue()
  except Exception:
    return None


def _image_png(data: Any) -> Optional[bytes]:
  if data is None:
    return None
  if hasattr(data, 'savefig'):
    return _figure_png(data)
  try:
    from PIL import Image as PILImage  # type: ignore[import-not-found,unused-ignore]
  except ImportError:
    return None
  try:
    if not hasattr(data, 'save'):  # numpy arrays, tensors
      if hasattr(data, 'detach'):
        data = data.detach().cpu().numpy()
      import numpy
      array = numpy.asarray(data)
      if array.ndim == 3 and array.shape[0] in (1, 3, 4) and array.shape[-1] not in (1, 3, 4):
        array = numpy.moveaxis(array, 0, -1)  # CHW, like wandb
      if array.ndim == 3 and array.shape[-1] == 1:
        array = array[..., 0]
      if array.dtype.kind == 'f':
        array = (numpy.clip(array, 0, 1) * 255) if array.max() <= 1.0 else numpy.clip(array, 0, 255)
      data = PILImage.fromarray(array.astype(numpy.uint8))
    buffer = io.BytesIO()
    data.save(buffer, format='PNG')
    return buffer.getvalue()
  except Exception:
    return None

