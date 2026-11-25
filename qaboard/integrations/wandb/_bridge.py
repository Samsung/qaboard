"""
One W&B run, as a QA-Board run: what both ways of using the shim share (the drop-in module, and the mirror of the
real `wandb`). It gets wandb's calls, with wandb's semantics (steps, commit=False, summaries), and makes them
`qaboard.start_run()` calls.

The QA-Board run starts lazily, at the first call that logs something (log, summary, artifact, finish, run.dir...):
code sets `wandb.config` right after `wandb.init()`, and the configuration identifies the run in QA-Board.
"""
import atexit
import glob as globbing
import os
import sys
import threading
from pathlib import Path
from typing import Any
from collections.abc import Callable, Mapping

from .._common import QUIET_VALUES, Unsupported, say

UNSUPPORTED = Unsupported('W&B')
# wandb.define_metric(summary=...) that QA-Board keeps as is
SUMMARIES = ('min', 'max', 'mean', 'last', 'none')
RESERVED = ('is_failed', 'compute_time')
MAX_NAME_LENGTH = 200

# process-wide: reset for tests by qaboard/_testing.py reset_process_state()
_said: set = set()
_said_lock = threading.Lock()


# what wandb does that QA-Board doesn't, by call: said once with Unsupported, the same in the docs' matrix
CALLS = {
  'watch': "gradients and parameters aren't logged: log their norms with wandb.log() to plot them",
  'alert': "runs started from code send no alerts",
  'use_artifact': "QA-Board has no artifact store to download from: read the files from where they are",
  'use_model': "QA-Board has no model registry to download from: read the files from where they are",
  'link_model': "QA-Board has no model registry: the files are in the run's folder",
  'log_code': "the code is identified by the commit, and a run whose files differ from it is marked as such",
  'mark_preempting': "start the run again with resume=True to continue it",
  'restore': "QA-Board has no file store to restore from: read the files from the previous run's folder",
  'sweep': "use `qa optimize`, or loop over configurations in your script",
  'agent': "use `qa optimize`, or loop over configurations in your script",
  'controller': "use `qa optimize`, or loop over configurations in your script",
  'Api': "read runs with qaboard.runs(url)",
}


def unsupported_call(name: str) -> None:
  UNSUPPORTED.warn(f"wandb.{name}()", CALLS.get(name, "does nothing in QA-Board"))


def say_once(kind: str, message: str) -> None:
  with _said_lock:
    if kind in _said:
      return
    _said.add(kind)
  say(message)


def quiet() -> bool:
  return os.environ.get('QA_QUIET', '').lower() in QUIET_VALUES


def env_flag(name: str) -> str | None:
  value = os.environ.get(name)
  return value.strip() if value and value.strip() else None


def rank() -> int | None:
  """The process's rank in a distributed training (torchrun, accelerate, deepspeed...), None outside one"""
  for name in ('RANK', 'LOCAL_RANK'):
    value = env_flag(name)
    if value is not None:
      try:
        return int(value)
      except ValueError:
        continue
  return None


def as_dict(config: Any, what: str = 'config') -> dict[str, Any]:
  """What wandb takes as a config: a mapping, an argparse Namespace, absl flags, a YAML file's path"""
  if config is None:
    return {}
  if isinstance(config, Mapping):
    return {str(k): v for k, v in config.items()}
  if isinstance(config, (str, os.PathLike)):
    try:
      import yaml
      loaded = yaml.safe_load(Path(config).read_text()) or {}
    except Exception as e:
      UNSUPPORTED.warn(f"{what} from a file that can't be read", f"{config}: {e}")
      return {}
    # wandb's config-defaults.yaml: {"lr": {"desc": ..., "value": 0.1}}
    return {str(k): (v['value'] if isinstance(v, Mapping) and 'value' in v else v) for k, v in loaded.items() if k != 'wandb_version'}
  if hasattr(config, 'flag_values_dict'):  # absl.flags.FLAGS
    try:
      return dict(config.flag_values_dict())
    except Exception:
      pass
  if hasattr(config, '__dict__') and not callable(config):  # argparse.Namespace, simple objects
    return {k: v for k, v in vars(config).items() if not k.startswith('_')}
  UNSUPPORTED.warn(f"{what} of type {type(config).__name__}", "QA-Board takes mappings, argparse namespaces and absl flags: this one is ignored")
  return {}


def public(config: Mapping[str, Any]) -> dict[str, Any]:
  """A config without wandb's own keys (_wandb)"""
  return {k: v for k, v in config.items() if not str(k).startswith('_')}


class InitArgs:
  """What wandb.init() was given that QA-Board uses, with wandb's environment variables as defaults"""
  def __init__(self, kwargs: Mapping[str, Any]):
    get = kwargs.get
    settings = get('settings')
    if isinstance(settings, Mapping):
      settings_mode = settings.get('mode')
    else:
      settings_mode = getattr(settings, 'mode', None) if settings is not None else None
    self.name: str | None = get('name') or env_flag('WANDB_NAME')
    self.group: str | None = get('group') or env_flag('WANDB_RUN_GROUP')
    self.project: str | None = get('project') or env_flag('WANDB_PROJECT')
    self.entity: str | None = get('entity') or env_flag('WANDB_ENTITY')
    self.job_type: str | None = get('job_type') or env_flag('WANDB_JOB_TYPE')
    self.notes: str | None = get('notes') or env_flag('WANDB_NOTES')
    tags = get('tags')
    if tags is None and env_flag('WANDB_TAGS'):
      tags = [t.strip() for t in str(env_flag('WANDB_TAGS')).split(',') if t.strip()]
    self.tags: list[str] | None = [str(t) for t in tags] if tags else None
    self.id: str | None = get('id') or env_flag('WANDB_RUN_ID')
    resume = get('resume')
    if resume is None:
      resume = env_flag('WANDB_RESUME')
    self.resume = resume in (True, 'allow', 'must', 'auto', 'true', 'True')
    mode = get('mode') or settings_mode or env_flag('WANDB_MODE')
    if str(os.environ.get('WANDB_DISABLED', '')).lower() in ('1', 'true', 'yes'):
      mode = 'disabled'
    self.mode: str | None = str(mode).lower() if mode else None
    self.reinit = get('reinit')
    self.include = get('config_include_keys')
    self.exclude = get('config_exclude_keys')
    for argument, hint in (
      ('fork_from', 'QA-Board runs aren\'t forked from a step of another: start a run with resume=True, or a new one'),
      ('resume_from', 'QA-Board runs aren\'t rewound to a step: resume=True continues from the last step'),
      ('save_code', 'the code is identified by the commit, and a run whose files differ from it is marked as such'),
      ('sync_tensorboard', 'TensorBoard event files are not read: log the values with wandb.log()'),
      ('tensorboard', 'TensorBoard event files are not read: log the values with wandb.log()'),
      ('monitor_gym', 'gym videos are not recorded'),
    ):
      if get(argument):
        UNSUPPORTED.warn(f"wandb.init({argument}=...)", hint)

  @property
  def disabled(self) -> bool:
    return self.mode == 'disabled'

  @property
  def offline(self) -> bool:
    return self.mode in ('offline', 'dryrun')

  def config(self, values: Mapping[str, Any]) -> dict[str, Any]:
    values = public(values)
    if self.include:
      values = {k: v for k, v in values.items() if k in self.include}
    if self.exclude:
      values = {k: v for k, v in values.items() if k not in self.exclude}
    return values

  def params(self) -> dict[str, Any]:
    params = {'wandb/project': self.project, 'wandb/entity': self.entity, 'wandb/job_type': self.job_type,
              'wandb/notes': self.notes, 'wandb/tags': self.tags, 'wandb/id': self.id, 'wandb/group': self.group}
    return {k: v for k, v in params.items() if v}


def input_name(name: str | None) -> str | None:
  """A W&B run name as a QA-Board input: a name, maybe with slashes, never outside its database"""
  if not name or not str(name).strip():
    return None
  parts = [p for p in str(name).strip().replace('\\', '/').split('/') if p not in ('', '.', '..')]
  return '/'.join(parts) or None


# --- process-wide: unfinished runs end with the process, failed if it dies from an exception -------------------------
_bridges: list['Bridge'] = []
_bridges_lock = threading.Lock()
# process-wide: reset for tests by qaboard/_testing.py reset_process_state()
_uncaught: BaseException | None = None
_hooks = False


def _install_hooks() -> None:
  global _hooks
  if _hooks:
    return
  _hooks = True
  # start_run()'s own hooks, now: a run that starts at exit (it never logged) can't register them then. Ours, registered
  # after, run before them: our runs log their last step before they are finished
  try:
    from ... import active_run
    with active_run._active_lock:
      if not active_run._hooks_installed:
        active_run._hooks_installed = True
        atexit.register(active_run._finish_at_exit)
        active_run._watch_uncaught_exceptions()
        active_run._watch_sigterm()
  except Exception:
    pass
  previous = sys.excepthook

  def hook(exc_type: Any, exc: Any, tb: Any) -> None:
    global _uncaught
    if not issubclass(exc_type, SystemExit):
      _uncaught = exc
    previous(exc_type, exc, tb)

  sys.excepthook = hook
  atexit.register(finish_all)


def finish_all(error: BaseException | None = None, exit_code: int | None = None) -> None:
  """Ends the runs nobody finished, failed if the process dies from an exception or exits with an error: what wandb does at exit"""
  with _bridges_lock:
    bridges = list(_bridges)
  failure = error if error is not None else _uncaught
  for bridge in reversed(bridges):
    bridge.finish(exit_code=exit_code or (1 if failure is not None else None), error=failure)


def active() -> list['Bridge']:
  with _bridges_lock:
    return [b for b in _bridges if not b.finished]


class Bridge:
  """
  A W&B run seen by QA-Board. Never raises for what QA-Board can't do: says it once (UNSUPPORTED), and goes on.
  - `config`: gives the run's config now (wandb's, or the drop-in's)
  - `mirror`: wandb also gets the calls, and prints its own warnings (e.g. for steps that go back)
  """
  def __init__(self, args: InitArgs, config: Callable[[], Mapping[str, Any]], mirror: bool = False):
    self.args = args
    self._config = config
    self.mirror = mirror
    self.run: Any = None             # the ActiveRun, once started
    self.started = False
    self.finished = False
    self.skipped = args.disabled     # no QA-Board run: disabled, or not rank 0
    self.step = 0
    self.summary: dict[str, Any] = {}  # what wandb's summary would show: the last values, and what was set
    self._pending: dict[str, Any] = {}
    self._summaries: dict[str, str] = {}
    self._directions: dict[str, bool] = {}
    self._identity: dict[str, Any] | None = None
    self._saved: list[tuple[str, str | None]] = []
    self._lock = threading.RLock()
    current = rank()
    if not self.skipped and current not in (None, 0):
      self.skipped = True
      say_once('rank', f"rank {current}: not logging to QA-Board, only rank 0 does (RANK/LOCAL_RANK)")
    _install_hooks()
    with _bridges_lock:
      _bridges.append(self)

  # --- the QA-Board run --------------------------------------------------------------------------------------------
  def ensure_started(self) -> Any:
    """The QA-Board run, started now if it wasn't: None when there is none (disabled, rank != 0, failed to start)"""
    with self._lock:
      if self.started or self.skipped:
        return self.run
      self.started = True
      from ...active_run import start_run
      configs = self.args.config(self._config())
      self._identity = dict(configs)
      try:
        self.run = start_run(
          input_name(self.args.name), configs=[configs] if configs else None,
          batch=input_name(self.args.group) or input_name(self.args.project),
          share=False if self.args.offline else None, resume=self.args.resume, summary=dict(self._summaries) or 'last',
        )
      except Exception as e:
        hint = " With W&B code, set QA_PROJECT=group/repo." if 'project' in str(e) else ''
        say(f"WARNING: couldn't start the QA-Board run{', only W&B gets this run' if self.mirror else ''}: {e}{hint}")
        self.skipped = True
        return None
      try:
        params = self.args.params()
        if params:
          self.run.log_params(params)
        if self.args.resume:
          series = getattr(self.run, '_series', None)
          self.step = max(self.step, getattr(series, 'last_step', -1) + 1)
      except Exception as e:
        self.error('start', e)
      return self.run

  def error(self, what: str, e: BaseException) -> None:
    """Our side failed: said once, the training goes on (and W&B still gets everything)"""
    say_once(f"error:{what}", f"WARNING: QA-Board didn't get wandb's {what}(): {type(e).__name__}: {e}. Said once.")

  def config_changed(self) -> None:
    """The config changed: after the run started, it doesn't change which run this is"""
    with self._lock:
      if not self.started or self.run is None or self.finished:
        return
      try:
        current = self.args.config(self._config())
        changed = {k: v for k, v in current.items() if k not in self._identity or self._identity[k] != v} if self._identity is not None else current
        if not changed:
          return
        UNSUPPORTED.warn("config changed after the first log", "kept as the run's parameters: the configuration that identifies the run is the one it had when it started logging. Set the config in wandb.init(config=...)")
        self._identity.update(changed)  # type: ignore
        self.run.log_params(changed)
      except Exception as e:
        self.error('config.update', e)

  # --- log: wandb's steps -------------------------------------------------------------------------------------------
  def log(self, data: Mapping[str, Any], step: int | None = None, commit: bool | None = None) -> None:
    with self._lock:
      if self.finished or self.ensure_started() is None:
        return
      if step is not None:
        step = int(step)
        if step < self.step:
          if not self.mirror:
            say(f"WARNING: wandb.log(step={step}) is before the current step, {self.step}: ignored, like W&B does. Steps only go up.")
          return
        if step > self.step:
          self._commit()
          self.step = step
      self._pending.update(data)
      if commit or (step is None and commit is None):
        self._commit()
        self.step += 1

  def _commit(self) -> None:
    """Logs the row of the current step"""
    row, self._pending = self._pending, {}
    if not row or self.run is None:
      return
    from ...series import as_number, flatten
    from . import _media
    numbers: dict[str, Any] = {}
    texts: dict[str, Any] = {}
    media: dict[str, Any] = {}
    for key, value in flatten(row).items():
      if not _usable_name(key):
        continue
      if value is None:
        continue
      try:
        numbers[key] = as_number(value)
        continue
      except TypeError:
        pass
      if isinstance(value, str):
        UNSUPPORTED.warn("texts in wandb.log()", "kept as the run's metric of that name, its last value: series are numbers")
        texts[key] = value[:500]
        continue
      if _media.is_media(value):
        media[key] = value
      else:
        UNSUPPORTED.warn(f"values of type {type(value).__name__} in wandb.log()", "not logged: series are numbers")
    # the numbers first: they are the step, whatever happens to its media
    if numbers:
      self.run.log(numbers, step=self.step)
      self.summary.update(numbers)
    if texts:
      self.run.log_metrics(texts)
      self.summary.update(texts)
    for key, value in media.items():
      _media.save(self.run, key, self.step, value)

  # --- summary, define_metric ---------------------------------------------------------------------------------------
  def summary_update(self, values: Mapping[str, Any]) -> None:
    with self._lock:
      if self.finished or self.ensure_started() is None:
        return
      from ...active_run import _metric_value
      from ...series import flatten
      metrics: dict[str, Any] = {}
      for key, value in flatten(dict(values)).items():
        if not _usable_name(key):
          continue
        try:
          metrics[key] = _metric_value(key, value)
        except TypeError:
          UNSUPPORTED.warn(f"summary values of type {type(value).__name__}", "not kept: metrics are numbers, booleans and short texts")
      if metrics:
        self.summary.update(metrics)
        self.run.log_metrics(metrics)

  def define_metric(self, name: str, step_metric: Any = None, summary: str | None = None, goal: str | None = None,
                    hidden: bool | None = None, **_: Any) -> None:
    if step_metric is not None:
      UNSUPPORTED.warn("define_metric(step_metric=...)", "series have one x axis, the step: log the x value as its own series to see it")
    if hidden:
      UNSUPPORTED.warn("define_metric(hidden=True)", "the series is shown like the others; summary=\"none\" keeps it out of the metrics")
    if goal in ('minimize', 'maximize') and '*' not in str(name):
      from ...metrics import define_metric
      define_metric(str(name), smaller_is_better=goal == 'minimize')
    if not summary:
      return
    kept: list[str] = []
    for part in [p.strip().lower() for p in str(summary).split(',') if p.strip()]:
      if part == 'best' and goal in ('minimize', 'maximize'):
        part = 'min' if goal == 'minimize' else 'max'
      if part in SUMMARIES:
        kept.append(part)
      else:
        UNSUPPORTED.warn(f"define_metric(summary=\"{part}\")", "QA-Board summarizes a series with its last, min, max or mean value"
                         + (", and \"best\" with goal=\"minimize\" or \"maximize\"" if part == 'best' else ''))
    if not kept:
      return
    if len(kept) > 1:
      UNSUPPORTED.warn("define_metric() with several summaries", f"a series has one summary in QA-Board: the first one, here {kept[0]}")
    with self._lock:
      self._summaries[str(name)] = kept[0]
      if self.run is not None:
        # the run started: its summaries are read when its metrics are computed
        self.run._summaries[str(name)] = kept[0]

  # --- files --------------------------------------------------------------------------------------------------------
  def log_artifact(self, artifact: Any, name: str | None = None, aliases: Any = None, what: str = 'log_artifact') -> None:
    with self._lock:
      if self.finished or self.ensure_started() is None:
        return
      from . import _media
      UNSUPPORTED.warn(f"wandb.{what}() versions, aliases and lineage", "the files are copied in the run's artifacts/ folder, listed in Output Files")
      for target, source in _media.artifact_files(artifact, name):
        self.run.log_artifact(target, source)

  def save(self, glob_str: Any, base_path: Any = None, policy: str = 'live') -> None:
    with self._lock:
      if self.finished or self.ensure_started() is None:
        return
      self._saved.append((str(glob_str), str(base_path) if base_path is not None else None))
      self._copy_saved(str(glob_str), str(base_path) if base_path is not None else None)

  def _copy_saved(self, pattern: str, base_path: str | None) -> None:
    if self.run is None:
      return
    output_dir = Path(self.run.output_dir).resolve()
    for path in sorted(globbing.glob(pattern, recursive=True)):
      source = Path(path)
      if not source.is_file():
        continue
      resolved = source.resolve()
      if output_dir in resolved.parents:
        continue  # already a file of the run
      if base_path is not None:
        try:
          name = str(resolved.relative_to(Path(base_path).resolve()))
        except ValueError:
          name = source.name
      else:
        name = source.name if source.is_absolute() or '..' in source.parts else str(source)
      self.run.log_artifact(name, source)

  @property
  def output_dir(self) -> Path | None:
    run = self.ensure_started()
    return Path(run.output_dir) if run is not None else None

  # --- the end ------------------------------------------------------------------------------------------------------
  def finish(self, exit_code: int | None = None, error: BaseException | None = None) -> None:
    with self._lock:
      if self.finished:
        return
      try:
        run = self.ensure_started()
        if run is not None:
          self._commit()
          for pattern, base_path in self._saved:  # policy "end"/"live": their content at the end
            try:
              self._copy_saved(pattern, base_path)
            except Exception as e:
              self.error('save', e)
      except Exception as e:
        self.error('finish', e)
      self.finished = True
      run = self.run
    try:
      if run is not None:
        if exit_code or error is not None:
          run.fail(error if error is not None else f"exit code {exit_code}")
        else:
          run.finish()
    finally:
      with _bridges_lock:
        if self in _bridges:
          _bridges.remove(self)
      if not self.skipped or run is not None:
        UNSUPPORTED.report()


def _usable_name(key: str) -> bool:
  if not key or key.startswith('_'):
    return False  # wandb's own: _step, _timestamp, _runtime...
  if key in RESERVED:
    UNSUPPORTED.warn(f"logging {key}", "QA-Board sets it for each run: not logged. Log it under another name")
    return False
  if len(key) > MAX_NAME_LENGTH:
    UNSUPPORTED.warn(f"names longer than {MAX_NAME_LENGTH} characters", "not logged")
    return False
  return True

