"""
Code written for Weights & Biases logs to QA-Board, without changes. Docs: website/docs/from-wandb.mdx.

Three ways:
- `python -m qaboard.integrations.wandb train.py --lr 1e-3`: runs the script. With `wandb` installed, its runs go to
  W&B and are mirrored to QA-Board; without it, `import wandb` gives this module, and they go to QA-Board only.
- `qaboard.integrations.wandb.mirror()`, at the top of a script or notebook: the same, from code.
- `import qaboard.integrations.wandb as wandb`: this module, with wandb's API, logging to QA-Board only.

Each W&B run is a `qaboard.start_run()` run (qaboard/active_run.py), started at the first call that logs something,
so that a config set after `wandb.init()` identifies it (_bridge.py). Media are saved as files (_media.py). What
QA-Board doesn't keep is said once, and listed when the run ends (`_common.Unsupported`).
"""
import os
import random
import string
import sys
import tempfile
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List, Mapping, Optional

from ._bridge import CALLS, UNSUPPORTED, Bridge, InitArgs, as_dict, unsupported_call
from ._media import Artifact, Audio, Graph, Histogram, Html, Image, Molecule, Object3D, Plotly, Table, Video, plot
from ._mirror import mirror

__all__ = [
  'init', 'log', 'finish', 'define_metric', 'log_artifact', 'log_model', 'save', 'mirror', 'run', 'config', 'summary',
  'Run', 'Config', 'Summary', 'Settings', 'Artifact', 'Image', 'Video', 'Audio', 'Html', 'Table', 'Histogram',
  'Object3D', 'Molecule', 'Plotly', 'Graph', 'plot', 'Error', 'UNSUPPORTED',
]
# a version that `packaging` parses, and that says what this is
__version__ = '0.0.0+qaboard'


class Error(Exception):
  pass


class UsageError(Error):
  pass


class CommError(Error):
  pass


errors = SimpleNamespace(Error=Error, UsageError=UsageError, CommError=CommError)


class Settings(SimpleNamespace):
  """wandb.Settings: QA-Board reads `mode`, and ignores the rest"""
  def __init__(self, **kwargs: Any):
    super().__init__(**{'mode': None, **kwargs})


class AlertLevel:
  INFO = 'INFO'
  WARN = 'WARN'
  ERROR = 'ERROR'


class _NoOp:
  """What QA-Board doesn't have: calling it does nothing, said once"""
  def __init__(self, feature: str):
    object.__setattr__(self, '_feature', feature)

  def __call__(self, *args: Any, **kwargs: Any) -> None:
    UNSUPPORTED.warn(f"{self._feature}()", "does nothing in QA-Board")

  def __getattr__(self, name: str) -> '_NoOp':
    if name.startswith('__'):
      raise AttributeError(name)
    return _NoOp(f"{self._feature}.{name}")

  def __bool__(self) -> bool:
    return False

  def __repr__(self) -> str:
    return f"<{self._feature}: not in QA-Board>"


class _Mapping:
  """What Config and Summary share: a dict with attributes"""
  _values: Dict[str, Any]

  def __getitem__(self, key: str) -> Any:
    return self._values[key]

  def __getattr__(self, key: str) -> Any:
    if key.startswith('__'):
      raise AttributeError(key)
    try:
      return self._values[key]
    except KeyError:
      raise AttributeError(key) from None

  def __setattr__(self, key: str, value: Any) -> None:
    if key.startswith('_'):
      object.__setattr__(self, key, value)
    else:
      self[key] = value

  def __contains__(self, key: object) -> bool:
    return key in self._values

  def __iter__(self) -> Iterator[str]:
    return iter(list(self._values))

  def __len__(self) -> int:
    return len(self._values)

  def keys(self) -> List[str]:
    return list(self._values)

  def values(self) -> List[Any]:
    return list(self._values.values())

  def items(self) -> List[Any]:
    return list(self._values.items())

  def get(self, key: str, default: Any = None) -> Any:
    return self._values.get(key, default)

  def as_dict(self) -> Dict[str, Any]:
    return dict(self._values)

  _as_dict = as_dict

  def __repr__(self) -> str:
    return repr(self._values)


class Config(_Mapping):
  """wandb.config: the run's configuration in QA-Board, set before the run logs anything (see the docs)"""
  def __init__(self, values: Optional[Mapping[str, Any]] = None):
    object.__setattr__(self, '_values', dict(values or {}))
    object.__setattr__(self, '_bridge', None)

  def __setitem__(self, key: str, value: Any) -> None:
    self._values[str(key)] = value
    self._changed()

  def update(self, values: Any = None, allow_val_change: Optional[bool] = None, **kwargs: Any) -> None:
    self._values.update({**as_dict(values, 'wandb.config.update()'), **kwargs})
    self._changed()

  def setdefaults(self, values: Any) -> None:
    for key, value in as_dict(values, 'wandb.config.setdefaults()').items():
      self._values.setdefault(key, value)
    self._changed()

  def persist(self) -> None:
    pass

  def _changed(self) -> None:
    if self._bridge is not None:
      try:
        self._bridge.config_changed()
      except Exception as e:
        self._bridge.error('config.update', e)


class Summary(_Mapping):
  """run.summary: the run's metrics. Each series' last value, and what you set"""
  def __init__(self, bridge: Optional[Bridge]):
    object.__setattr__(self, '_bridge', bridge)

  @property
  def _values(self) -> Dict[str, Any]:  # type: ignore[override]
    if self._bridge is None:
      raise Error("You must call wandb.init() before wandb.summary is used")
    return self._bridge.summary

  def __setitem__(self, key: str, value: Any) -> None:
    self.update({key: value})

  def __delitem__(self, key: str) -> None:
    self._values.pop(key, None)
    UNSUPPORTED.warn("deleting summary values", "the metric stays in QA-Board")

  def update(self, values: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> None:
    if self._bridge is None:
      raise Error("You must call wandb.init() before wandb.summary is used")
    try:
      self._bridge.summary_update({**dict(values or {}), **kwargs})
    except Exception as e:
      self._bridge.error('summary.update', e)


def _random_id() -> str:
  return ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))


class Run:
  """What wandb.init() returns. `run.qaboard` is the QA-Board run (`qaboard.start_run()`'s), started when needed"""
  def __init__(self, args: InitArgs, config: Config):
    self._args = args
    self._bridge = Bridge(args, config=config.as_dict)
    self._id = str(args.id) if args.id else _random_id()
    self._dir: Optional[str] = None
    self.config = config
    object.__setattr__(config, '_bridge', self._bridge)
    self.summary = Summary(self._bridge)

  def _safely(self, label: str, call: Any, /, *args: Any, **kwargs: Any) -> Any:
    try:
      return call(*args, **kwargs)
    except Exception as e:
      self._bridge.error(label, e)
      return None

  # --- what the run is ----------------------------------------------------------------------------------------------
  @property
  def qaboard(self) -> Any:
    """The QA-Board run (an ActiveRun), started now if it wasn't. None when disabled, or not on rank 0"""
    return self._safely('run', self._bridge.ensure_started)

  @property
  def id(self) -> str:
    return self._id

  @property
  def name(self) -> str:
    if self._args.name:
      return str(self._args.name)
    run = self._bridge.run
    if run is not None:
      return str(run.input)
    from ...active_run import _default_input
    return _default_input()

  @name.setter
  def name(self, value: str) -> None:
    if self._bridge.started:
      UNSUPPORTED.warn("renaming a run after it logged", "the name is the run's input in QA-Board, fixed when it starts logging: set name= in wandb.init()")
      return
    self._args.name = value

  def _set_param(self, key: str, value: Any) -> None:
    setattr(self._args, key, value)
    if self._bridge.run is not None and not self._bridge.finished:
      self._safely(key, self._bridge.run.log_params, {f"wandb/{key}": value})

  @property
  def tags(self) -> tuple:
    return tuple(self._args.tags or ())

  @tags.setter
  def tags(self, value: Any) -> None:
    self._set_param('tags', [str(t) for t in value] if value else None)

  @property
  def notes(self) -> Optional[str]:
    return self._args.notes

  @notes.setter
  def notes(self, value: Optional[str]) -> None:
    self._set_param('notes', value)

  project = property(lambda self: self._args.project or 'uncategorized')
  group = property(lambda self: self._args.group or '')
  entity = property(lambda self: self._args.entity or '')
  job_type = property(lambda self: self._args.job_type or '')
  resumed = property(lambda self: bool(self._args.resume))
  offline = property(lambda self: self._args.offline)
  disabled = property(lambda self: self._bridge.skipped)
  step = property(lambda self: self._bridge.step)
  settings = property(lambda self: Settings(mode=self._args.mode or ('disabled' if self._bridge.skipped else 'online'), run_id=self._id))
  path = property(lambda self: '/'.join(p for p in (self.entity, self.project, self.id) if p))

  @property
  def dir(self) -> str:
    """The run's folder in QA-Board: files written there are the run's"""
    output_dir = self._safely('run.dir', lambda: self._bridge.output_dir)
    if output_dir is not None:
      return str(output_dir)
    if self._dir is None:
      self._dir = tempfile.mkdtemp(prefix='qaboard-wandb-')
    return self._dir

  @property
  def url(self) -> Optional[str]:
    run = self.qaboard
    return run.url if run is not None else None

  def get_url(self) -> Optional[str]:
    return self.url

  def get_project_url(self) -> Optional[str]:
    return None

  def get_sweep_url(self) -> Optional[str]:
    return None

  # --- logging ------------------------------------------------------------------------------------------------------
  def log(self, data: Mapping[str, Any], step: Optional[int] = None, commit: Optional[bool] = None, sync: Optional[bool] = None) -> None:
    if not isinstance(data, Mapping):
      raise TypeError("wandb.log must be passed a dictionary")
    if any(not isinstance(key, str) for key in data):
      raise TypeError("Key values passed to `wandb.log` must be strings.")
    self._safely('log', self._bridge.log, data, step=step, commit=commit)

  def define_metric(self, name: str, step_metric: Any = None, step_sync: Optional[bool] = None, hidden: Optional[bool] = None,
                    summary: Optional[str] = None, goal: Optional[str] = None, overwrite: Optional[bool] = None) -> Any:
    self._safely('define_metric', self._bridge.define_metric, name, step_metric=step_metric, summary=summary, goal=goal, hidden=hidden)
    return SimpleNamespace(name=name, step_metric=step_metric, summary=summary, goal=goal, hidden=hidden)

  def log_artifact(self, artifact_or_path: Any, name: Optional[str] = None, type: Optional[str] = None,
                   aliases: Optional[List[str]] = None, tags: Optional[List[str]] = None) -> Any:
    self._safely('log_artifact', self._bridge.log_artifact, artifact_or_path, name=name, aliases=aliases)
    return artifact_or_path if isinstance(artifact_or_path, Artifact) else Artifact(name or os.path.basename(str(artifact_or_path)), type or 'artifact')

  def log_model(self, path: Any, name: Optional[str] = None, aliases: Optional[List[str]] = None) -> None:
    self._safely('log_model', self._bridge.log_artifact, path, name=name, aliases=aliases, what='log_model')

  def save(self, glob_str: Any = None, base_path: Any = None, policy: str = 'live') -> bool:
    if glob_str is None:
      return False
    self._safely('save', self._bridge.save, glob_str, base_path=base_path, policy=policy)
    return True

  def use_artifact(self, artifact_or_name: Any, type: Optional[str] = None, aliases: Any = None, use_as: Optional[str] = None) -> Artifact:
    unsupported_call('use_artifact')
    return artifact_or_name if isinstance(artifact_or_name, Artifact) else Artifact(str(artifact_or_name), type or 'artifact')

  def use_model(self, name: str) -> None:
    unsupported_call('use_model')

  def link_model(self, path: Any, registered_model_name: str = '', name: Optional[str] = None, aliases: Any = None) -> None:
    unsupported_call('link_model')

  def watch(self, *args: Any, **kwargs: Any) -> None:
    unsupported_call('watch')

  def unwatch(self, *args: Any, **kwargs: Any) -> None:
    pass

  def alert(self, title: str = '', text: str = '', level: Any = None, wait_duration: Any = None) -> None:
    unsupported_call('alert')

  def log_code(self, *args: Any, **kwargs: Any) -> None:
    unsupported_call('log_code')

  def mark_preempting(self) -> None:
    unsupported_call('mark_preempting')

  def restore(self, *args: Any, **kwargs: Any) -> None:
    unsupported_call('restore')

  # --- the end ------------------------------------------------------------------------------------------------------
  def finish(self, exit_code: Optional[int] = None, quiet: Optional[bool] = None) -> None:
    self._safely('finish', self._bridge.finish, exit_code=exit_code)
    module = sys.modules[__name__]
    if getattr(module, 'run', None) is self:
      _set_globals(None)

  def __enter__(self) -> 'Run':
    return self

  def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
    failed = exc_type is not None and not (exc_type is SystemExit and not getattr(exc, 'code', None))
    self._safely('finish', self._bridge.finish, exit_code=1 if failed else None, error=exc if failed else None)
    if getattr(sys.modules[__name__], 'run', None) is self:
      _set_globals(None)

  def __getattr__(self, name: str) -> Any:
    if name.startswith('_'):
      raise AttributeError(name)
    return _NoOp(f"wandb.run.{name}")

  def __repr__(self) -> str:
    return f"<wandb Run (qaboard) {self.name} {self.id}>"


# --- the module's globals, like wandb's ----------------------------------------------------------------------------
run: Optional[Run] = None
config: Config = Config()
summary: Summary = Summary(None)


def _set_globals(new: Optional[Run]) -> None:
  module = sys.modules[__name__]
  module.run = new  # type: ignore[attr-defined]
  module.config = new.config if new is not None else Config()  # type: ignore[attr-defined]
  module.summary = new.summary if new is not None else Summary(None)  # type: ignore[attr-defined]


def init(entity: Optional[str] = None, project: Optional[str] = None, dir: Any = None, id: Optional[str] = None,
         name: Optional[str] = None, notes: Optional[str] = None, tags: Any = None, config: Any = None,
         config_exclude_keys: Optional[List[str]] = None, config_include_keys: Optional[List[str]] = None,
         allow_val_change: Optional[bool] = None, group: Optional[str] = None, job_type: Optional[str] = None,
         mode: Optional[str] = None, force: Optional[bool] = None, anonymous: Any = None, reinit: Any = None,
         resume: Any = None, resume_from: Optional[str] = None, fork_from: Optional[str] = None,
         save_code: Optional[bool] = None, tensorboard: Optional[bool] = None, sync_tensorboard: Optional[bool] = None,
         monitor_gym: Optional[bool] = None, settings: Any = None, **kwargs: Any) -> Run:
  """Starts a run: a QA-Board run, created at its first log (see the module's docstring)"""
  arguments = {k: v for k, v in locals().items() if k != 'kwargs'}
  module = sys.modules[__name__]
  previous: Optional[Run] = getattr(module, 'run', None)
  if previous is not None and not previous._bridge.finished:
    in_notebook = 'ipykernel' in sys.modules
    if reinit in (True, 'finish_previous') or (reinit in (None, 'default') and in_notebook):
      previous.finish()
    elif reinit != 'create_new':
      return previous  # like wandb in a script: "return_previous"
  values = dict(getattr(module, 'config', Config()).as_dict()) if previous is None or previous._bridge.finished else {}
  values.update(as_dict(arguments.pop('config'), 'wandb.init(config=...)'))
  new = Run(InitArgs(arguments), Config(values))
  _set_globals(new)
  return new


def _current(what: str) -> Run:
  current = getattr(sys.modules[__name__], 'run', None)
  if current is None:
    raise Error(f"You must call wandb.init() before wandb.{what}()")
  return current


def log(data: Mapping[str, Any], step: Optional[int] = None, commit: Optional[bool] = None, sync: Optional[bool] = None) -> None:
  _current('log').log(data, step=step, commit=commit)


def finish(exit_code: Optional[int] = None, quiet: Optional[bool] = None) -> None:
  current = getattr(sys.modules[__name__], 'run', None)
  if current is not None:
    current.finish(exit_code=exit_code)


def define_metric(name: str, step_metric: Any = None, step_sync: Optional[bool] = None, hidden: Optional[bool] = None,
                  summary: Optional[str] = None, goal: Optional[str] = None, overwrite: Optional[bool] = None) -> Any:
  return _current('define_metric').define_metric(name, step_metric=step_metric, hidden=hidden, summary=summary, goal=goal)


def log_artifact(artifact_or_path: Any, name: Optional[str] = None, type: Optional[str] = None, aliases: Optional[List[str]] = None, tags: Optional[List[str]] = None) -> Any:
  return _current('log_artifact').log_artifact(artifact_or_path, name=name, type=type, aliases=aliases)


def log_model(path: Any, name: Optional[str] = None, aliases: Optional[List[str]] = None) -> None:
  _current('log_model').log_model(path, name=name, aliases=aliases)


def save(glob_str: Any = None, base_path: Any = None, policy: str = 'live') -> bool:
  return _current('save').save(glob_str, base_path=base_path, policy=policy)


def use_artifact(artifact_or_name: Any, type: Optional[str] = None, aliases: Any = None, use_as: Optional[str] = None) -> Artifact:
  unsupported_call('use_artifact')
  return artifact_or_name if isinstance(artifact_or_name, Artifact) else Artifact(str(artifact_or_name), type or 'artifact')


def watch(*args: Any, **kwargs: Any) -> None:
  unsupported_call('watch')


def unwatch(*args: Any, **kwargs: Any) -> None:
  pass


def alert(title: str = '', text: str = '', level: Any = None, wait_duration: Any = None) -> None:
  unsupported_call('alert')


def sweep(sweep: Any = None, entity: Optional[str] = None, project: Optional[str] = None, **kwargs: Any) -> str:
  unsupported_call('sweep')
  return 'qaboard-no-sweep'


def agent(sweep_id: Any = None, function: Any = None, entity: Optional[str] = None, project: Optional[str] = None, count: Optional[int] = None, **kwargs: Any) -> None:
  unsupported_call('agent')


def login(*args: Any, **kwargs: Any) -> bool:
  return True


def setup(*args: Any, **kwargs: Any) -> None:
  pass


def teardown(exit_code: Optional[int] = None) -> None:
  finish(exit_code=exit_code)


def require(*args: Any, **kwargs: Any) -> None:
  pass


def restore(*args: Any, **kwargs: Any) -> None:
  unsupported_call('restore')


def mark_preempting() -> None:
  unsupported_call('mark_preempting')


def Api(*args: Any, **kwargs: Any) -> _NoOp:
  unsupported_call('Api')
  return _NoOp('wandb.Api()')


def termlog(message: str = '', *args: Any, **kwargs: Any) -> None:
  print(f"wandb: {message}", file=sys.stderr)


def termwarn(message: str = '', *args: Any, **kwargs: Any) -> None:
  print(f"wandb: WARNING {message}", file=sys.stderr)


def termerror(message: str = '', *args: Any, **kwargs: Any) -> None:
  print(f"wandb: ERROR {message}", file=sys.stderr)


def __getattr__(name: str) -> Any:
  """What wandb has and this module doesn't: a no-op that says so once, rather than an AttributeError mid-training"""
  if name.startswith('_'):
    raise AttributeError(name)
  if name in CALLS:
    return lambda *args, **kwargs: unsupported_call(name)
  return _NoOp(f"wandb.{name}")

