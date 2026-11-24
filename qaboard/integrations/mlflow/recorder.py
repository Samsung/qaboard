"""
An MLflow run as a QA-Board run: what the stores (store.py) and the artifact repository (artifacts.py) tell it, with
plain values, mapped to `qaboard.start_run()`. Nothing here imports MLflow.

- Identity: the experiment is the batch ("Default" is start_run's default batch), the run's name is the input when
  the code gave one (MLflow's random names aren't: they change at each run, and runs are compared by input), the
  parameters logged before the run's first metric, file or end are its configurations (one mapping), and the
  `mlflow.source.git.commit` tag its commit.
- The QA-Board run starts lazily, at the first metric, file or the end, so that the parameters logged first make its
  identity: QA-Board compares the runs with the same configurations from a commit to the next. Parameters logged
  after are parameters, which don't identify it (said once). `QABOARD_MLFLOW_CONFIGS` chooses which parameters
  identify runs: patterns, `*` by default, `!pattern` leaves out, `none` for none.
- Metrics are series: `log_metric(key, value, step)` is `run.log({key: value}, step=step)`, and each series' last
  value is a metric of the run, like MLflow's latest value. MLflow's step is 0 when code gives none: a metric logged
  at step 0 again, without ever another step, gets the next steps (0, 1, 2...), so that it stays a curve.
- Tags are parameters, under `tags/` (`tags/team`), and MLflow's useful system tags under `mlflow/`.
- With RANK (else LOCAL_RANK) set to another process than 0, there is no QA-Board run: rank 0 makes it.
"""
import json
import math
import os
import re
import threading
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any
from collections.abc import Iterable, Mapping

from .._common import say
from . import unsupported

DOCS = 'https://samsung.github.io/qaboard/docs/from-mlflow'

# MLflow's system tags we keep, as parameters. Not mlflow.source.git.commit: it is the run's commit
SYSTEM_TAGS = {
  'mlflow.runName': 'mlflow/run_name',
  'mlflow.parentRunId': 'mlflow/parent_run_id',
  'mlflow.user': 'mlflow/user',
  'mlflow.source.name': 'mlflow/source',
  'mlflow.note.content': 'mlflow/note',
}
# QA-Board's own files in the run's folder: artifacts of these names go under mlflow/ instead
QABOARD_FILES = re.compile(r'(run\.json|metrics\.json|metrics_definitions\.json|log\.txt|manifest\..*\.json|(.*\.)?series\.jsonl?|media\.jsonl)')
# What mlflow.log_image(image, key=..., step=...) names its files: "/" in the key are "~" ("#" and "%" before MLflow 3)
STEPPED_IMAGE = re.compile(r'images/(?P<key>[^/]+?)[+%]step[+%](?P<step>\d+)[+%]timestamp[+%]\d+[+%][^/+%]+(?P<compressed>[+%]compressed)?\.(png|webp|jpe?g)')
CONFIGS_VARIABLE = 'QABOARD_MLFLOW_CONFIGS'

_INT = re.compile(r'[-+]?(0|[1-9][0-9]*)')
_FLOAT = re.compile(r'[-+]?([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)([eE][-+]?[0-9]+)?')


def param_value(text: Any) -> Any:
  """MLflow saves parameters as texts: numbers and booleans become what they were, so that the web app compares and plots them"""
  if not isinstance(text, str):
    return text
  if _INT.fullmatch(text):
    return int(text)
  if _FLOAT.fullmatch(text) and ('.' in text or 'e' in text.lower()):
    number = float(text)
    return number if math.isfinite(number) else text
  if text in ('True', 'False'):
    return text == 'True'
  return None if text == 'None' else text


def identity_patterns() -> tuple[list[str], list[str]]:
  """QABOARD_MLFLOW_CONFIGS: which parameters logged first identify the run, (included, excluded) patterns"""
  raw = os.environ.get(CONFIGS_VARIABLE, '*').strip()
  if raw.lower() in ('', 'none', '0', 'false', 'no'):
    return [], []
  patterns = [p.strip() for p in raw.split(',') if p.strip()]
  included = [p for p in patterns if not p.startswith('!')] or ['*']
  return included, [p[1:] for p in patterns if p.startswith('!')]


def identifies(key: str, patterns: tuple[list[str], list[str]]) -> bool:
  included, excluded = patterns
  return any(fnmatchcase(key, p) for p in included) and not any(fnmatchcase(key, p) for p in excluded)


def rank() -> int:
  """The process's rank in a distributed training (torchrun, Lightning, accelerate, Horovod...), 0 when there is none"""
  for variable in ('RANK', 'LOCAL_RANK'):
    value = os.environ.get(variable)
    if value is not None and value.strip():
      try:
        return int(value)
      except ValueError:
        return 0
  return 0


_said: set[str] = set()
_said_lock = threading.Lock()


def say_once(key: str, message: str) -> None:
  with _said_lock:
    if key in _said:
      return
    _said.add(key)
  say(message)


class RecordedRun:
  """One MLflow run, and the QA-Board run it becomes"""
  def __init__(self, recorder: 'Recorder', run_id: str, *, experiment: str | None, name: str, named: bool,
               tags: Mapping[str, str], mirror: str | None):
    self.recorder = recorder
    self.run_id = run_id
    # None: the default batch
    self.experiment = experiment
    self.name = name
    # the code gave the name (else MLflow made it up)
    self.named = named
    self.mirror = mirror
    self.tags: dict[str, str] = {}
    self.params: dict[str, str] = {}
    self.qb: Any = None
    self.started = False
    self.ended = False
    self.status: str | None = None
    self.logged = False
    self.resume = False
    self.skip = rank() != 0
    self.lock = threading.RLock()
    self._steps: dict[str, tuple[int, bool]] = {}
    # mlflow.log_table()'s files, in the run's folder: logged as tables each time they are written
    self._tables: set[str] = set()
    # what start_run() would choose, checked when the run is created
    self.default_commit: str | None = None
    self.set_tags(tags, at_creation=True)

  # --- what MLflow logs --------------------------------------------------------------------------------------------
  def set_tags(self, tags: Mapping[str, str], at_creation: bool = False) -> None:
    with self.lock:
      tags = {str(k): ('' if v is None else str(v)) for k, v in tags.items()}
      if 'mlflow.loggedArtifacts' in tags:
        self._new_tables(tags['mlflow.loggedArtifacts'])
      if 'mlflow.runName' in tags and not at_creation and not self.started:
        # mlflow.set_tag("mlflow.runName", ...): a name the code gives
        self.name, self.named = tags['mlflow.runName'], True
      self.tags.update(tags)
      if any(not k.startswith('mlflow.') for k in tags):
        self.logged = True
      if self.qb is not None:
        self._send_params(self._tag_params(tags))

  def set_name(self, name: str | None) -> None:
    if name and name != self.name:
      with self.lock:
        if not self.started:
          self.name, self.named = name, True
        self.tags['mlflow.runName'] = name
        if self.qb is not None:
          self._send_params({'mlflow/run_name': name})

  def delete_tag(self, key: str) -> None:
    with self.lock:
      self.tags.pop(key, None)
      if self.qb is not None:
        unsupported.warn("MlflowClient.delete_tag", "the tag stays a parameter of the QA-Board run")

  def log_params(self, params: Mapping[str, Any]) -> None:
    with self.lock:
      self.params.update({str(k): '' if v is None else str(v) for k, v in params.items()})
      if params:
        self.logged = True
      if self.qb is not None:
        patterns = identity_patterns()
        if any(identifies(k, patterns) for k in params):
          unsupported.warn("mlflow.log_param after the run's first metric, file or end",
                           "kept as a parameter, which doesn't identify the run: log parameters before metrics, so that they are its configurations")
        self._send_params({str(k): param_value(str(v)) for k, v in params.items()})

  def log_metrics(self, metrics: Iterable[tuple[str, Any, int | None]]) -> None:
    """(key, value, step) of MLflow metrics"""
    with self.lock:
      metrics = list(metrics)
      if not metrics:
        return
      self.logged = True
      run = self._start()
      if run is None:
        return
      for key, value, step in metrics:
        logged_step = self._step(key, step)
        try:
          run.log({key: value}, step=logged_step)
        except (TypeError, ValueError) as e:
          say_once(f"metric:{key}", f"WARNING: not logging the MLflow metric {key!r} to QA-Board: {e}")

  def _step(self, key: str, step: int | None) -> int:
    count, explicit = self._steps.get(key, (0, False))
    step = int(step or 0)
    if step != 0:
      explicit = True
    elif count and not explicit:
      # logged again at step 0, the step MLflow gives without one: steps count the calls
      step = count
    self._steps[key] = (count + 1, explicit)
    return step

  def output_dir(self, start: bool = True) -> Path | None:
    """The QA-Board run's folder, None without one (another rank)"""
    with self.lock:
      run = self._start() if start else self.qb
      return Path(run.output_dir) if run is not None else None

  def save_artifact(self, local: str, relative: str) -> None:
    """Copies a file or a folder's files to `relative` in the QA-Board run's folder (log_artifact(s), models...)"""
    with self.lock:
      self.logged = True
      run = self._start()
      if run is None:
        return
      source = Path(local)
      files = [(source, Path(relative))] if source.is_file() else [
        (path, Path(relative) / path.relative_to(source)) for path in sorted(source.rglob('*')) if path.is_file()]
      for path, target in files:
        target = Path(*[part for part in target.parts if part not in ('', '.', '/')])
        image = STEPPED_IMAGE.fullmatch(target.as_posix())
        if image:
          # mlflow.log_image(key=..., step=...): media at their step, shown with a slider. Not its smaller copy
          if not image['compressed']:
            from ... import media
            key = image['key'].replace('~', '/').replace('#', '/')
            try:
              run.log_media(key.lstrip('_') or 'image', media.Image(path), step=int(image['step']))
            except (ValueError, TypeError) as e:  # a key QA-Board can't take: the image is still a file of the run
              say_once(f"image:{key}", f"WARNING: mlflow.log_image(key={key!r}): {e}: saved as a file instead")
              run.log_artifact(target.as_posix(), str(path))
          continue
        if len(target.parts) == 1 and QABOARD_FILES.fullmatch(target.name):
          say_once(f"reserved:{target.name}", f"WARNING: QA-Board writes its own {target.name} in the run's folder: the MLflow artifact is saved as mlflow/{target.name}")
          target = Path('mlflow') / target
        if not target.parts:
          continue
        run.log_artifact(target.as_posix(), str(path))
        if target.as_posix() in self._tables:
          self._log_table(target.as_posix())

  def _new_tables(self, tag: str) -> None:
    """The mlflow.loggedArtifacts tag lists the files of mlflow.log_table(), once they are written"""
    try:
      entries = json.loads(tag)
    except ValueError:
      return
    for entry in entries if isinstance(entries, list) else []:
      path = entry.get('path') if isinstance(entry, dict) and entry.get('type') == 'table' else None
      if isinstance(path, str) and QABOARD_FILES.fullmatch(path):
        path = f"mlflow/{path}"  # where save_artifact() put it
      if isinstance(path, str) and path not in self._tables:
        self._tables.add(path)
        if self.qb is not None:
          self._log_table(path)

  def _log_table(self, path: str) -> None:
    """A table file as a table at the run's last step: MLflow's tables have no step"""
    from ... import media
    root = Path(self.qb.output_dir)
    file = root / path
    if not path.endswith('.json'):
      unsupported.warn("mlflow.log_table to a .parquet file", "kept as a file, not shown as a table: log tables as .json")
      return
    try:
      table = json.loads(file.read_text(encoding='utf-8'))
      # MLflow's image cells: {"type": "image", "filepath": "table_images/...png", ...}, files next to the table
      def cell(value: Any) -> Any:
        if isinstance(value, dict) and value.get('type') == 'image' and isinstance(value.get('filepath'), str):
          images = [root / value['filepath'], root / Path(path).parent / value['filepath'], root / 'mlflow' / value['filepath']]
          image = next((i for i in images if i.is_file()), None)
          return media.Image(image) if image is not None else value['filepath']
        return value
      name = path[len('mlflow/'):] if path.startswith('mlflow/') else path
      self.qb.log_media(name[:-len('.json')].lstrip('_') or 'table', media.Table(columns=table['columns'], data=[[cell(v) for v in row] for row in table['data']]))
    except (OSError, ValueError, KeyError, TypeError) as e:
      say_once(f"table:{path}", f"WARNING: mlflow.log_table: can't read {path} as a table: {e}")

  # --- lifecycle ---------------------------------------------------------------------------------------------------
  def end(self, status: str) -> None:
    """FINISHED, FAILED, KILLED"""
    with self.lock:
      if self.ended:
        return
      self.ended, self.status = True, status
      run = self.qb
      if run is None and self.logged and not self.started:
        run = self._start()
      # (a run that dies from an exception was already failed by start_run()'s own exit hook)
      if run is not None and run.state != 'finished':
        if status != 'FINISHED':
          run.fail(f"MLflow run {status.lower()}")
        else:
          run.finish()
    unsupported.report()

  def reopen(self) -> None:
    """mlflow.start_run(run_id=...) of a run that ended: it goes on, in the same QA-Board run"""
    with self.lock:
      if not self.ended:
        return
      self.ended, self.status = False, None
      if self.qb is not None and self.qb.state == 'finished':
        self.qb, self.started, self.resume = None, False, True

  # --- the QA-Board run --------------------------------------------------------------------------------------------
  def input(self) -> str | None:
    """The run's name as QA-Board's input, when the code gave one. None: start_run's default, the script's name"""
    if not self.named or not self.name.strip():
      return None
    name = self.name.strip().lstrip('/\\')
    if not name or '..' in Path(name).parts:
      say_once(f"name:{name}", f"WARNING: the MLflow run name {self.name!r} can't name a QA-Board run (no '..'): the run is named after the script")
      return None
    return name

  def check(self) -> None:
    """Raises when start_run() would: no project, a bad name... Said when MLflow creates the run, not at its first metric"""
    if self.skip:
      return
    from ...active_run import plan_run
    plan = plan_run(self.input(), batch=self.experiment)
    self.default_commit = plan.commit

  def _start(self) -> Any:
    if self.started:
      return self.qb
    self.started = True
    if self.skip:
      say_once('rank', f"rank {rank()} of a distributed training: no QA-Board run here, rank 0 makes it")
      return None
    from ...active_run import start_run
    patterns = identity_patterns()
    params = {key: param_value(value) for key, value in self.params.items()}
    configs = {key: value for key, value in params.items() if identifies(key, patterns)}
    input = self.input()
    identity = (self.experiment, input, json.dumps(configs, sort_keys=True))
    if 'mlflow.parentRunId' in self.tags and identity in self.recorder.identities:
      # a nested run like its parent or another child: named after MLflow's name of it, else they'd be one run
      input = f"{input or self.recorder.default_input()}/{self.name}"
      identity = (self.experiment, input, identity[2])
    self.recorder.identities.add(identity)
    options: dict[str, Any] = {'input': input, 'configs': [configs] if configs else None, 'batch': self.experiment, 'resume': self.resume}
    commit = self.tags.get('mlflow.source.git.commit')
    if commit and commit != self.default_commit:
      options['commit'] = commit
    try:
      self.qb = start_run(**options)
    except ValueError as e:
      if 'commit' not in options:
        raise
      say_once(f"commit:{commit}", f"WARNING: the run's mlflow.source.git.commit tag, {commit}, isn't a commit of this repository ({e}): the run is attached to the current commit")
      del options['commit']
      self.qb = start_run(**options)
    self._send_params({**{k: v for k, v in params.items() if k not in configs}, **self._tag_params(self.tags),
                       # the run id only where it names a run you can open: with an MLflow server. It differs in every
                       # run, and would show as a changed setting next to the reference
                       **({'mlflow/run_id': self.run_id, 'mlflow/url': self.mirror} if self.mirror else {})})
    return self.qb

  def _tag_params(self, tags: Mapping[str, str]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for key, value in tags.items():
      if key in SYSTEM_TAGS:
        params[SYSTEM_TAGS[key]] = value
      elif not key.startswith('mlflow.'):
        params[f'tags/{key}'] = value
    return params

  def _send_params(self, params: Mapping[str, Any]) -> None:
    if params and self.qb is not None and self.qb.state != 'finished':
      self.qb.log_params(dict(params))


class Recorder:
  """The MLflow runs of this process, by MLflow run id"""
  def __init__(self) -> None:
    self.runs: dict[str, RecordedRun] = {}
    self.identities: set[tuple[str | None, str | None, str]] = set()
    self.lock = threading.Lock()
    self._default_input: str | None = None

  def create(self, run_id: str, *, experiment: str | None, name: str, named: bool, tags: Mapping[str, str],
             mirror: str | None = None) -> RecordedRun:
    run = RecordedRun(self, run_id, experiment=experiment, name=name, named=named, tags=tags, mirror=mirror)
    run.check()
    with self.lock:
      self.runs[run_id] = run
    return run

  def get(self, run_id: str) -> RecordedRun | None:
    with self.lock:
      return self.runs.get(run_id)

  def default_input(self) -> str:
    if self._default_input is None:
      from ...active_run import _default_input
      self._default_input = _default_input()
    return self._default_input


recorder = Recorder()
