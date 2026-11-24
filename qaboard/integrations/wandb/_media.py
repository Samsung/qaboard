"""
wandb's media and data types: the drop-in's minimal classes, and logging them, ours or the real wandb's, as
QA-Board's media (qaboard/media.py, `run.log_media()`): the run's card shows them at their step, next to the
reference run's.

Images (with their boxes, not their masks), audio, video, tables (with media in their cells), histograms, HTML and
Plotly figures; 3D objects and molecules given by path are files at their step. wandb.plot.* charts are their tables.
"""
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from collections.abc import Sequence

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
  def __init__(self, data_or_path: Any = None, caption: str | None = None, **kwargs: Any):
    self._path: str | None = str(data_or_path) if isinstance(data_or_path, (str, os.PathLike)) else None
    self._data = None if self._path else data_or_path
    self.caption = caption
    self._kwargs = kwargs

  def __repr__(self) -> str:
    return f"<wandb.{type(self).__name__} (qaboard) {self._path or type(self._data).__name__}>"


class Image(Media):
  def __init__(self, data_or_path: Any, mode: str | None = None, caption: str | None = None, **kwargs: Any):
    super().__init__(data_or_path, caption=caption, **kwargs)
    self.mode = mode


class Video(Media):
  def __init__(self, data_or_path: Any, caption: str | None = None, fps: int | None = None, format: str | None = None, **kwargs: Any):
    super().__init__(data_or_path, caption=caption, **kwargs)
    self.fps, self.format = fps, format


class Audio(Media):
  def __init__(self, data_or_path: Any, sample_rate: int | None = None, caption: str | None = None, **kwargs: Any):
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
  def __init__(self, sequence: Sequence[Any] | None = None, np_histogram: tuple[Any, Any] | None = None, num_bins: int = 64):
    if np_histogram is not None:
      self.histogram, self.bins = [_jsonable(v) for v in np_histogram]
      return
    from ...media import histogram
    # lists, arrays and tensors of any shape; NaN left out
    self.histogram, self.bins = histogram(sequence if sequence is not None else [], num_bins)


class Table:
  def __init__(self, columns: list[str] | None = None, data: list[Any] | None = None, rows: list[Any] | None = None,
               dataframe: Any = None, **kwargs: Any):
    if dataframe is not None:
      columns, data = [str(c) for c in dataframe.columns], dataframe.values.tolist()
    data = data if data is not None else rows
    self.data: list[Any] = [list(r) for r in (data or [])]
    self.columns: list[str] = list(columns) if columns else ([f"c{i}" for i in range(len(self.data[0]))] if self.data else [])

  def add_data(self, *values: Any) -> None:
    self.data.append(list(values))

  def add_column(self, name: str, data: Sequence[Any]) -> None:
    self.columns.append(name)
    for row, value in zip(self.data, data):
      row.append(value)

  def get_column(self, name: str) -> list[Any]:
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
  def line(self, table: Table, x: str, y: str, title: str | None = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'line')

  def scatter(self, table: Table, x: str, y: str, title: str | None = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'scatter')

  def bar(self, table: Table, label: str, value: str, title: str | None = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'bar')

  def histogram(self, table: Table, value: str, title: str | None = None, **_: Any) -> CustomChart:
    return CustomChart(table, 'histogram')

  def line_series(self, xs: Any, ys: Any, keys: list[str] | None = None, title: str | None = None, xname: str = 'x', **_: Any) -> CustomChart:
    xs_list = list(xs)
    if xs_list and not isinstance(xs_list[0], (list, tuple)) and not hasattr(xs_list[0], '__len__'):
      xs_list = [xs_list] * len(list(ys))
    rows = [[key, x, y] for i, (xx, yy) in enumerate(zip(xs_list, ys)) for key in [(keys or [])[i] if keys and i < len(keys) else f"key_{i}"] for x, y in zip(xx, yy)]
    return CustomChart(Table(columns=['lineKey', xname, 'y'], data=rows), 'line_series')

  def confusion_matrix(self, probs: Any = None, y_true: Any = None, preds: Any = None, class_names: list[str] | None = None, title: str | None = None, **_: Any) -> CustomChart:
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
  def __init__(self, name: str, type: str = 'artifact', description: str | None = None, metadata: dict | None = None, **_: Any):
    self.name, self.type, self.description = name, type, description
    self.metadata = dict(metadata or {})
    self.version = 'v0'
    self.aliases: list[str] = []
    self._files: list[tuple[str, Path]] = []
    self._temporary: str | None = None

  def add_file(self, local_path: str | os.PathLike, name: str | None = None, **_: Any) -> None:
    self._files.append((name or Path(local_path).name, Path(local_path)))

  def add_dir(self, local_path: str | os.PathLike, name: str | None = None, **_: Any) -> None:
    root = Path(local_path)
    for path in sorted(root.rglob('*')):
      if path.is_file():
        relative = path.relative_to(root).as_posix()
        self._files.append((f"{name}/{relative}" if name else relative, path))

  def add_reference(self, uri: Any, name: str | None = None, **_: Any) -> None:
    UNSUPPORTED.warn("Artifact.add_reference()", "references aren't copied: the run's files are those you give it")

  def add(self, obj: Any, name: str) -> None:
    UNSUPPORTED.warn("Artifact.add() of media and tables", "add files with add_file()")

  def new_file(self, name: str, mode: str = 'x', encoding: str | None = None) -> Any:
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

  def download(self, *args: Any, **kwargs: Any) -> str | None:
    UNSUPPORTED.warn("downloading artifacts", "QA-Board has no artifact store: read the files from where they are")
    return None


def artifact_files(artifact: Any, name: str | None = None) -> list[tuple[str, Path]]:
  """The files of an artifact (ours, or wandb's: its manifest), or of a path, as (name in the run, local file)"""
  if isinstance(artifact, (str, os.PathLike)):
    path = Path(artifact)
    label = _safe(name or path.name)
    if path.is_dir():
      return [(f"artifacts/{label}/{p.relative_to(path).as_posix()}", p) for p in sorted(path.rglob('*')) if p.is_file()]
    return [(f"artifacts/{label}/{path.name}" if name else f"artifacts/{path.name}", path)] if path.is_file() else []
  label = _safe(name or str(getattr(artifact, 'name', '') or 'artifact').split(':')[0])
  files: list[tuple[str, Path]] = []
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


def _kind(value: Any) -> str | None:
  for name in MEDIA:
    if _is(value, name):
      return name
  if _is(value, 'CustomChart') or _is(value, 'Visualize') or type(value).__module__.startswith('wandb.plot'):
    return 'plot'
  if hasattr(value, 'savefig') and type(value).__module__.startswith('matplotlib'):
    return 'figure'
  return None


def is_media(value: Any) -> bool:
  """A wandb media value, or a non-empty list of them"""
  values = list(value) if isinstance(value, (list, tuple)) else [value]
  return bool(values) and all(_kind(v) for v in values)


def save(run: Any, key: str, step: int, value: Any) -> None:
  """Logs a media value (or a list of them) with the run's log_media(), at the step"""
  values = list(value) if isinstance(value, (list, tuple)) else [value]
  converted = []
  for v in values:
    try:
      m = to_media(v)
    except Exception as e:  # what wandb's objects hold is theirs: a value we can't read never fails wandb.log()
      UNSUPPORTED.warn(f"{key} in wandb.log()", f"not logged: {e}")
      m = None
    if m is None:
      # the whole list or nothing: items match the reference's and other steps' by their position
      return
    converted.append(m)
  run.log_media(key, converted if isinstance(value, (list, tuple)) else converted[0], step=step)


def to_media(value: Any) -> Any:
  """A wandb media value (ours, or the real wandb's) as QA-Board's (qaboard/media.py), None when we can't keep it"""
  from ... import media
  kind = _kind(value)
  path = getattr(value, '_path', None)
  path = path if path and Path(str(path)).is_file() else None
  caption = getattr(value, '_caption', None) or getattr(value, 'caption', None)
  if kind == 'plot':
    table = getattr(value, 'table', None)
    if table is None:
      table = getattr(value, '_data', None)
    if table is None or not _is(table, 'Table'):
      UNSUPPORTED.warn("wandb.plot.* without a table", "not logged")
      return None
    UNSUPPORTED.warn("wandb.plot.*", "the chart's table is logged, not the chart: shown as a table at its step")
    return to_media(table)
  if kind == 'figure':
    return media.Image(value)
  if kind == 'Image':
    if _masks(value):
      UNSUPPORTED.warn("wandb.Image(masks=...)", "the image is logged without its masks")
    data = path if path else _image_data(value)
    if data is None:
      UNSUPPORTED.warn("wandb.Image from this data", "not logged: give a path, an array, a Pillow image or a figure")
      return None
    return media.Image(data, caption=caption, boxes=_boxes(value))
  if kind == 'Audio':
    rate = getattr(value, '_sample_rate', None) or getattr(value, 'sample_rate', None)
    return media.Audio(path or getattr(value, '_data', None), sample_rate=rate, caption=caption)
  if kind == 'Video':
    return media.Video(path or getattr(value, '_data', None), fps=getattr(value, '_fps', None) or getattr(value, 'fps', None), caption=caption)
  if kind == 'Table':
    columns = list(getattr(value, 'columns', []) or [])
    rows = [[(to_media(cell) or repr(cell)) if _kind(cell) else cell for cell in row] for row in (getattr(value, 'data', None) or [])]
    return media.Table(columns=columns, data=rows)
  if kind == 'Histogram':
    counts, bins = getattr(value, 'histogram', None), getattr(value, 'bins', None)
    if counts is None or bins is None:
      return None
    return media.Histogram(np_histogram=(counts, bins))
  if kind == 'Html':
    html = getattr(value, 'html', None)
    return media.Html(html if html is not None else Path(str(path)).read_text(encoding='utf-8', errors='replace')) if (html or path) else None
  if kind == 'Plotly':
    figure = getattr(value, '_data', None)
    if figure is None:
      figure = getattr(value, '_val', None)
    if figure is None and path:  # the real wandb keeps only its .plotly.json
      import json
      figure = json.loads(Path(str(path)).read_text(encoding='utf-8'))
    if figure is None:
      UNSUPPORTED.warn("wandb.Plotly without its figure", "not logged")
      return None
    return media.Plotly(figure)
  # Object3D, Molecule, Graph: the file, at its step
  if path:
    UNSUPPORTED.warn(f"wandb.{kind}", "logged as a file at its step: open it from the run's media")
    return media.File(path, caption=caption)
  UNSUPPORTED.warn(f"wandb.{kind} from in-memory data", "not logged: give a file's path")
  return None


def _image_data(value: Any) -> Any:
  for name in ('_image', '_data'):
    data = getattr(value, name, None)
    if data is not None:
      return data
  return None


def _masks(value: Any) -> Any:
  return getattr(value, '_masks', None) or (getattr(value, '_kwargs', None) or {}).get('masks')


def _boxes(value: Any) -> list[dict[str, Any]]:
  """wandb's boxes, {group: {"box_data": [...], "class_labels": {id: name}}}, as QA-Board's: pixels, or fractions"""
  groups = (getattr(value, '_kwargs', None) or {}).get('boxes') or getattr(value, '_boxes', None) or {}
  boxes: list[dict[str, Any]] = []
  if not isinstance(groups, dict):
    return boxes
  for group, spec in groups.items():
    if not isinstance(spec, dict):
      # the real wandb's BoundingBoxes2D: the boxes in _val, the labels in _class_labels
      boxes_val = getattr(spec, '_val', None)
      spec = boxes_val if isinstance(boxes_val, dict) else {'box_data': boxes_val, 'class_labels': getattr(spec, '_class_labels', None)}
    if not isinstance(spec.get('box_data'), list):
      continue
    class_labels = spec.get('class_labels')
    labels = {str(k): str(v) for k, v in class_labels.items()} if isinstance(class_labels, dict) else {}
    for box in spec['box_data']:
      if not isinstance(box, dict):
        continue
      position = box.get('position') or {}
      try:
        if 'middle' in position:
          (mx, my), w, h = position['middle'], float(position['width']), float(position['height'])
          x, y = float(mx) - w / 2, float(my) - h / 2
        else:
          x, y = float(position['minX']), float(position['minY'])
          w, h = float(position['maxX']) - x, float(position['maxY']) - y
      except (KeyError, TypeError, ValueError):
        UNSUPPORTED.warn("wandb.Image(boxes=...) without a position", "those boxes aren't logged")
        continue
      region: dict[str, Any] = {'x': x, 'y': y, 'w': w, 'h': h, 'group': str(group)}
      label = box.get('box_caption') or labels.get(str(box.get('class_id')))
      if label:
        region['label'] = str(label)
      scores = box.get('scores') or {}
      if isinstance(scores, dict) and scores:
        try:
          region['score'] = float(next(iter(scores.values())))
        except (TypeError, ValueError):
          pass
      if box.get('domain') != 'pixel':
        region['units'] = 'fraction'
      boxes.append(region)
  return boxes
