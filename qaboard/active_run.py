"""
Runs created from your own code, without `qa run`: training loops, notebooks, evaluation scripts, test suites.

    import qaboard as qb

    with qb.start_run(input="train/coco-mini", configs=["resnet50", {"lr": 1e-3}], batch="lr-sweep") as run:
      for step, batch in enumerate(loader):
        run.log({"train/loss": train_step(batch)}, step=step)     # a point of a series, at each step
      run.log_metrics({"mAP": evaluate(model)})                  # the run's metrics
      torch.save(model.state_dict(), run.output_dir / "model.pt")  # its files

The run shows in the web app like a `qa run`: same identity (project, commit, batch, input, configurations), same
folder conventions (qaboard/conventions.py, qaboard/attempts.py), same files (run.json, metrics.json, log.txt,
manifest.outputs.json), plus its series (qaboard/series.py). Design: docs/rfcs/python-sdk-runs.md.

How it talks to the server: logging only changes memory and files. A background thread tells the server what the
run looks like *now* (its metrics and parameters so far) every few seconds, and `finish()` what it looks like in the
end. There is no queue of events to replay: when the server is away, the next message that gets through says
everything, and the last one alone creates the run. So logging never waits for the network, and never fails
because of it. Series never go through the server: the web app reads them from the run's folder.
"""
import atexit
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from importlib import import_module
from pathlib import Path
from types import MappingProxyType
from fnmatch import fnmatchcase
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple, Union

from . import attempts
from .conventions import run_dir_in_commit, slugify, get_settings
from .credentials import default_server
from .metrics import DEFINITIONS_FILE, clean_definition, declared_metrics, read_definitions_file, split_metrics, with_default_direction
from .payloads import results_payload, serialize_path
from .results import ResultsError, Run, _request, _script_source
from .series import Point, SeriesWriter, as_number, flatten, read_series

# How often the series' files are written and the server told about the run, in seconds, at least
FLUSH_INTERVAL = 2.0
SYNC_INTERVAL = 10.0
# When the server doesn't answer, we ask less and less often, up to this
MAX_SYNC_INTERVAL = 120.0
# (connect, read) timeouts: a training doesn't start, or end, minutes late because the server is away
TIMEOUT = (5.0, 30.0)
SUMMARIES = ('last', 'min', 'max', 'mean', 'none')
# Only the run sets them, like for `qa run`
RESERVED_METRICS = ('is_failed', 'compute_time')
# What the server accepts (backend/api/outputs.py): longer names and texts would be refused with everything sent with them
MAX_NAME_LENGTH = 200
MAX_TEXT_LENGTH = 500
OFFLINE_VALUES = ('1', 'true', 'yes', 'on')

# The runs started and not finished, the latest last
_active: List['ActiveRun'] = []
_active_lock = threading.Lock()
_hooks_installed = False


def _say(message: str) -> None:
  print(f"qaboard: {message}", file=sys.stderr)


def current_run() -> Optional['ActiveRun']:
  """The run started last with `start_run()` and not finished, for code that logs from deep inside a library. None without one."""
  with _active_lock:
    return _active[-1] if _active else None


def _jsonable(value: Any) -> Any:
  """What we send or save as JSON: plain data, paths as texts, numpy scalars as numbers, no NaN"""
  if isinstance(value, Mapping):
    return {str(k): _jsonable(v) for k, v in value.items()}
  if isinstance(value, (set, frozenset)):
    # in a stable order: configurations make the run's identity and its folder
    return sorted((_jsonable(v) for v in value), key=lambda v: json.dumps(v, sort_keys=True))
  if isinstance(value, (list, tuple)):
    return [_jsonable(v) for v in value]
  if isinstance(value, Path):
    return serialize_path(value)
  if isinstance(value, float):
    return value if math.isfinite(value) else None
  if value is None or isinstance(value, (str, bool, int)):
    return value
  if hasattr(value, 'tolist'): # numpy arrays and scalars
    try:
      return _jsonable(value.tolist())
    except Exception:
      pass
  if hasattr(value, 'item'):
    try:
      return _jsonable(value.item())
    except Exception:
      pass
  return str(value)


def _metric_value(key: str, value: Any) -> Any:
  """A metric as the server saves it: a finite number, a boolean, a short text or None"""
  if value is None or isinstance(value, (str, bool)):
    return value
  try:
    number = as_number(value)
  except TypeError:
    raise TypeError(f"{key}: metrics are numbers, booleans, texts or None, not {type(value).__name__}") from None
  return number


def _open(path: Path, mode: int) -> None:
  if os.name == 'nt':
    return
  try:
    current = os.stat(path).st_mode
    if current & mode != mode:
      os.chmod(path, current | mode)
  except OSError:
    pass


def _mkdir_shared(directory: Path) -> None:
  """
  Creates a folder of the run, and its missing parents, open to others: the server lists the run's files, and people
  delete runs from the web app. `qa` sets the process's umask to 0 for that; a library doesn't change the umask of
  the program that imports it, where other threads create files too.
  """
  missing = []
  for parent in (directory, *directory.parents):
    if parent.exists():
      break
    missing.append(parent)
  directory.mkdir(parents=True, exist_ok=True)
  for created in missing:
    _open(created, 0o777)


def _share_permissions(directory: Path) -> None:
  """Lets others read, write and delete what the run wrote in its folder, like `qa run` does. Best effort."""
  if os.name == 'nt':
    return
  for root, dirs, files in os.walk(directory):
    for name, bits in [(d, 0o777) for d in dirs] + [(f, 0o666) for f in files]:
      path = os.path.join(root, name)
      try:
        mode = os.stat(path).st_mode
        if mode & bits != bits and not os.path.islink(path):
          os.chmod(path, mode | bits)
      except OSError:
        pass


def _same_run(run_dir: Path) -> List['ActiveRun']:
  """The active runs of this process whose folder is `run_dir`, or another attempt of the same run"""
  first_dir, _ = attempts.split(run_dir)
  with _active_lock:
    return [run for run in _active if attempts.split(run.output_dir)[0] == first_dir and run._pid == os.getpid()]


def _git(repo_root: Path, *args: str) -> Optional[str]:
  try:
    p = subprocess.run(['git', *args], cwd=repo_root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
  except (OSError, subprocess.SubprocessError):
    return None
  return p.stdout.decode('utf-8', errors='replace') if p.returncode == 0 else None


def _dirty(repo_root: Path) -> Optional[Dict[str, Any]]:
  """When tracked files differ from the commit: {"dirty": True, "diff_sha256": ...}. The run is not the commit's code."""
  status = _git(repo_root, 'status', '--porcelain', '--untracked-files=no')
  if not status or not status.strip():
    return None
  diff = _git(repo_root, 'diff', 'HEAD')
  dirty: Dict[str, Any] = {'dirty': True}
  if diff:
    dirty['diff_sha256'] = hashlib.sha256(diff.encode('utf-8', errors='replace')).hexdigest()[:16]
  return dirty


def _default_input() -> str:
  """Runs without an input are named after their script: stable from a commit to the next, so they compare"""
  script = _script_source().get('script') or ''
  if script == '<notebook>':
    return 'notebook'
  stem = Path(script).stem if not script.startswith('<') else ''
  return stem or 'run'


class _Setup:
  """Where a run goes: the project, its commit, its folders, read like `qa` does (qaboard/config.py)."""
  def __init__(self, project: Optional[str], commit: Optional[str]):
    # reads the qaboard.yaml above the current directory, git and the CI's environment
    c = import_module('qaboard.config')
    self.is_ci: bool = c.is_ci
    self.user: str = c.user
    self.platform: str = c.platform
    self.run_context: Dict[str, Any] = c.run_context()
    self.has_qaboard_yaml = c.project is not None
    self.repo_root: Optional[Path] = c.repo_root if c.is_in_git_repo else None
    if self.has_qaboard_yaml:
      self.project = c.project.as_posix()
      if project and Path(project).as_posix().strip('/') != self.project:
        raise ValueError(f"start_run(project={project!r}), but the qaboard.yaml here ({c.qatools_config_paths[-1]}) is the project {self.project!r}. Leave project= out, or run from outside this project.")
      self.project_root = c.project_root.as_posix()
      self.subproject = c.subproject
      self.config: Dict[str, Any] = c.config
      self.metrics_file: Dict[str, Any] = c._metrics or {}
      self.available_metrics: Dict[str, Any] = c.available_metrics or {}
      self.local_dir: Path = c.project_dir
      outputs_project_root, artifacts_commit = c.outputs_project_root, c.artifacts_commit
      self.input_type = c.default_input_type
      self.database: Path = c.get_default_database(get_settings(self.input_type, self.config))
    else:
      if not project:
        raise ValueError("start_run() needs to know the project: run it from a project (a folder with a qaboard.yaml, see `qa init`), or pass project='group/repo'.")
      from .site_config import site_qaboard_config
      self.project = Path(project).as_posix().strip('/')
      self.project_root = self.project
      self.subproject = Path('.')
      site = site_qaboard_config()
      # we don't send a configuration: the project keeps the one its qaboard.yaml gave it
      self.config = {}
      self.metrics_file, self.available_metrics = {}, {}
      self.local_dir = Path.cwd()
      self.input_type = 'default'
      self.database = Path('.')
      outputs_project_root, artifacts_commit = None, None
      if site.get('storage') or site.get('ci_root') or os.environ.get('QA_STORAGE'):
        try:
          outputs_root, _, _ = c.storage_roots(dict(site), Path(self.project), self.subproject, raise_errors=True)
          outputs_project_root = outputs_root / self.project
        except (KeyError, ValueError, TypeError):
          pass

    self._config = c
    self.commit: str = c.commit_id
    self.commit_data: Dict[str, Any] = c.commit_data()
    self.artifacts_commit: Optional[Path] = artifacts_commit
    self.outputs_commit: Optional[Path] = c.outputs_commit if self.has_qaboard_yaml and outputs_project_root else None
    # qaboard.config read the HEAD when it was imported: a notebook, or any process that lives long, has moved since
    head = self._head() if not commit else None
    if head and head[1] != self.commit:
      self._use_commit(head[1], outputs_project_root)
      self.commit_data['commit_branch'] = head[0]
    elif commit and commit != self.commit:
      self._use_commit(commit, outputs_project_root)
    elif not self.has_qaboard_yaml and outputs_project_root:
      self.outputs_commit = self._outputs_dir(self.commit, outputs_project_root)
    self.is_default_commit = not commit or commit == c.commit_id

  def _head(self) -> Optional[Tuple[str, str]]:
    """The repository's (branch, commit) now, outside the CI, which says which commit it tests"""
    if self.is_ci or self.repo_root is None:
      return None
    from .git import git_head
    try:
      branch, head = git_head(self.repo_root)
    except (OSError, ValueError):
      return None
    return (branch, head) if re.fullmatch(r'[0-9a-f]{40}', head) else None

  def _outputs_dir(self, commit: str, outputs_project_root: Path) -> Path:
    """Where the commit's runs are saved, like `qa` (config.commit_outputs_dir)"""
    if re.fullmatch(r'[0-9a-f]{40}', commit):
      return self._config.commit_outputs_dir(commit, outputs_project_root, self.subproject)
    # no git: `qa` saves in the working directory, which the server may not read. Here, in the storage, per user
    return outputs_project_root / 'local' / (slugify(self.user) or 'user') / self.subproject

  def _use_commit(self, commit: str, outputs_project_root: Optional[Path]) -> None:
    """The run is attached to another commit than the code's, e.g. the commit that trained a model"""
    resolved = commit
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
      found = _git(self.repo_root, 'rev-parse', '--verify', '--quiet', f"{commit}^{{commit}}") if self.repo_root else None
      if not found or not found.strip():
        raise ValueError(f"start_run(commit={commit!r}): give the commit's full id (40 hexadecimal digits), or a branch, tag or short id of this folder's git repository.")
      resolved = found.strip()
    self.commit = resolved
    # only the date is required: the server knows the rest if it knows the commit
    self.commit_data = {'commit_authored_datetime': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if self.repo_root:
      try:
        self.commit_data = {f"commit_{key}": value for key, value in self._config.read_commit(resolved).items()}
        self.commit_data['commit_message'] = self.commit_data['commit_message'].strip()
      except Exception: # the repository doesn't have the commit
        pass
    self.artifacts_commit = None
    self.outputs_commit = self._outputs_dir(resolved, outputs_project_root) if outputs_project_root else None


def start_run(input: Optional[str] = None, *, configs: Optional[Sequence[Any]] = None, batch: Optional[str] = None,
              project: Optional[str] = None, commit: Optional[str] = None, output_dir: Union[str, Path, None] = None,
              share: Optional[bool] = None, resume: bool = False, summary: Union[str, Mapping[str, str]] = 'last',
              database: Union[str, Path, None] = None, platform: Optional[str] = None, capture_output: bool = True,
              server: Optional[str] = None, token: Optional[str] = None) -> 'ActiveRun':
  """
  Starts a run from your code, and returns it: log to it, then `finish()` it, or use it as a context manager.

  A run is identified like `qa run`'s: the project, the commit, a batch, an input, and configurations.
  - `input`: what the run works on, e.g. a dataset, as a path relative to the inputs' database, or any name. Runs with
    the same input and configurations are compared from a commit to the next. Default: the script's name.
  - `configs`: the configurations, texts and mappings like `qa --config`: `["resnet50", {"lr": 1e-3}]`. They make the
    run: other configurations are another run. `run.params` merges the mappings.
  - `batch`: the experiment the run belongs to, a batch in the web app. Default: "default". Like with `qa --share`,
    runs you start outside the CI go to your own batch, "@you| <batch>".
  - `project`, `commit`: by default the project of the qaboard.yaml above the current directory, and the git HEAD.
    Without a qaboard.yaml, give `project="group/repo"`. `commit` attaches the run to another commit.
  - `share`: save the files in the shared storage and show the run in the web app. Default: in the CI, and when a
    server and the storage are configured. `share=False`, or `QA_OFFLINE=1`, keeps everything in `output/`.
  - `output_dir`: your own folder for the run's files, instead of the one QA-Board's conventions give.
  - `resume=True`: continue the previous run of the same identity: its files, metrics and parameters are kept, and
    steps go on from its last. Without a previous run, it starts one.
    Otherwise, starting a run again is a new attempt: the web app shows the latest, and remembers the earlier ones.
  - `summary`: which value of each logged series is the run's metric: "last" (default), "min", "max", "mean", or
    "none"; or a mapping by series, with `*` patterns: `{"val/loss": "min", "system/*": "none", "*": "last"}`.
  - `capture_output`: also save what the process prints in the run's log.txt, shown in the web app's Logs.
  - `server`, `token`: by default those `qa` uses (QABOARD_URL..., `qa auth login`).
  """
  if input is not None and (not isinstance(input, (str, os.PathLike)) or not str(input).strip()):
    raise TypeError(f"start_run(input=...) is a name or a path, like 'train/coco-mini', not {input!r}")
  configurations = list(configs) if configs is not None and not isinstance(configs, (str, Mapping)) else ([configs] if configs is not None else [])
  for c in configurations:
    if not isinstance(c, (str, Mapping)):
      raise TypeError(f"start_run(configs=...) is a list of texts and mappings, like ['resnet50', {{'lr': 1e-3}}], not {c!r}")
  configurations = [c if isinstance(c, str) else _jsonable(c) for c in configurations]
  if isinstance(summary, str):
    summaries: Dict[str, str] = {'*': summary}
  else:
    summaries = {'*': 'last', **{str(k): v for k, v in summary.items()}}
  for how in summaries.values():
    if how not in SUMMARIES:
      raise ValueError(f"start_run(summary={summary!r}): expected one of {', '.join(SUMMARIES)}")

  setup = _Setup(project, commit)
  offline = os.environ.get('QA_OFFLINE', '').lower() in OFFLINE_VALUES
  server_url, server_source = (server.rstrip('/'), 'server=') if server else default_server()
  can_share = setup.outputs_commit is not None or output_dir is not None
  if share is None:
    share = not offline and can_share and (setup.is_ci or server_source is not None)
  elif share and not can_share:
    raise ValueError("start_run(share=True) needs the shared storage: set `storage` in qaboard.yaml or QA_STORAGE, or pass output_dir= with a folder the server reads.")
  in_storage = bool(share or setup.is_ci) and setup.outputs_commit is not None

  # the input: relative to its database, like `qa run --input`
  input_path = Path(input) if input is not None else Path(_default_input())
  database_path = Path(database) if database is not None else setup.database
  if input_path.is_absolute():
    database_path = Path(input_path.anchor)
    input_path = input_path.relative_to(input_path.anchor)
  if '..' in input_path.parts:
    raise ValueError(f"start_run(input={input!r}): the input is a name or a path under its database, without '..'")
  input_name = input_path.as_posix()

  raw_batch = batch or 'default'
  batch_label = raw_batch if (not share or setup.is_ci) else f"@{setup.user}| {raw_batch}"
  platform = platform or setup.platform

  custom_output = output_dir is not None
  new_attempt = False
  if custom_output:
    run_dir = Path(output_dir).expanduser().resolve() # type: ignore[arg-type]
  else:
    base = setup.outputs_commit if in_storage else setup.local_dir
    assert base is not None
    run_dir = base / run_dir_in_commit(batch_label, platform, configurations, {}, input_path, database_path, setup.config)
    if in_storage and attempts.reruns_mode(setup.config) != attempts.IN_PLACE:
      # like `qa run`: a run done again gets its own directory, and the previous attempt's log is kept
      run_dir = attempts.latest_dir(run_dir)
      if not resume:
        new_attempt = True
  # Starting the same run again while it goes on, e.g. a notebook's cell run twice: the first ends here. Else both
  # would write in the same folder, or the new attempt would remove the files of a run that still logs
  for active in _same_run(run_dir):
    _say(f"the run in {active.output_dir} was not finished: finishing it before starting it again")
    active.finish()
  if new_attempt:
    run_dir = attempts.reserve_or_keep(run_dir)
  if not resume and not custom_output and run_dir.exists():
    from .utils import clean_output_dir
    clean_output_dir(run_dir)
  _mkdir_shared(run_dir)
  if new_attempt:
    attempts.remove_previous(run_dir)
    _open(run_dir, 0o777)

  run = ActiveRun(
    setup=setup, input=input_name, database=database_path, configurations=configurations, batch=batch_label,
    raw_batch=raw_batch, platform=platform, output_dir=run_dir, share=bool(share), offline=offline or not share,
    resume=resume, summaries=summaries, server=server_url, token=token, capture_output=capture_output,
  )
  run._start()
  return run


class ActiveRun:
  """
  A run your code is doing: what `start_run()` returns. `log()` its series, `log_metrics()`, `log_params()`,
  `log_artifact()`, write files in `output_dir`, then `finish()`, or leave the `with` block.

  It has the attributes of the `Run` objects `qaboard.runs(url)` gives (`input`, `configs`, `params`, `metrics`,
  `output_dir`, `id`, `url`...), and `run.run` is such a `Run`, as it is now.
  """
  def __init__(self, *, setup: _Setup, input: str, database: Path, configurations: List[Any], batch: str, raw_batch: str,
               platform: str, output_dir: Path, share: bool, offline: bool, resume: bool, summaries: Dict[str, str],
               server: str, token: Optional[str], capture_output: bool):
    self._setup = setup
    self.project = setup.project
    self.commit = setup.commit
    self.batch = batch
    self.input = input
    self.database = database
    self.platform = platform
    self.configs: Tuple[Any, ...] = tuple(configurations)
    self.output_dir = output_dir
    self.share = share
    self.server: Optional[str] = server if share else None
    self.id: Optional[int] = None
    self.is_failed = False
    self.error: Optional[str] = None

    self._raw_batch = raw_batch
    self._offline = offline
    self._resume = resume
    self._summaries = summaries
    self._token = token
    # how often the server is told about the run: not an argument, the default suits servers with thousands of runs
    try:
      self._sync_interval = max(0.1, float(os.environ.get('QA_SYNC_INTERVAL') or SYNC_INTERVAL))
    except ValueError:
      self._sync_interval = SYNC_INTERVAL
    self._capture_output = capture_output and not os.environ.get('QA_NO_STREAM_REDIRECT')

    # what the run logged: guarded by _lock, written and sent by the background thread
    self._lock = threading.RLock()
    self._series: Optional[SeriesWriter] = None
    self._metrics: Dict[str, Any] = {}             # log_metrics()
    self._params: Dict[str, Any] = {}              # log_params()
    self._definitions: Dict[str, Dict[str, Any]] = {}
    self._data: Dict[str, Any] = {}
    self._changed = False                          # since the server was told
    self._finished = False
    self._started_at = time.time()
    self._ended_at: Optional[float] = None
    self._previous_time = 0.0                      # resume=True: how long the run ran before
    self._saved_logged: Any = None                 # what run.json has of the metrics and parameters logged
    self._warned: Set[str] = set()
    self._pid = os.getpid()

    self._thread: Optional[threading.Thread] = None
    self._stop = threading.Event()
    self._send_lock = threading.Lock()
    self._refused: Optional[str] = None            # the server refused the run: we stop asking until the end
    self._failures = 0
    self._next_sync = 0.0
    self._live_updates = True                      # False for servers that only take a run's metrics at its end
    self._sent_definitions: Dict[str, Dict[str, Any]] = {}
    self._log_file: Any = None
    self._tees: List[Tuple[str, Any, Any]] = []
    self._entered_sigterm: Any = None

  # --- what the run is ---------------------------------------------------------------------------------------------
  @property
  def params(self) -> Mapping[str, Any]:
    """The mappings of `configs` merged, then what `log_params()` reported: like `context.params` in `run()`"""
    from .filters import run_params
    with self._lock:
      return MappingProxyType(run_params(list(self.configs), dict(self._params)))

  @property
  def metrics(self) -> Mapping[str, Any]:
    """The run's metrics so far: `log_metrics()`'s, and each series' summary (by default its last value)"""
    with self._lock:
      return MappingProxyType(self._current_metrics())

  @property
  def state(self) -> str:
    return 'finished' if self._finished else 'running'

  @property
  def url(self) -> Optional[str]:
    """The run in the web app, when it is shared"""
    return self.run.url if self.share else None

  @property
  def run(self) -> Run:
    """The run as a `Run`, like those of `qaboard.runs(url)`: a read-only picture of it now"""
    with self._lock:
      data = {**self._data, **({'params': dict(self._params)} if self._params else {})}
      run = Run(
        project=self.project, commit=self.commit, batch=self.batch, input=self.input, database=str(self.database),
        platform=self.platform, configs=self.configs, params=self.params, metrics=self._current_metrics(final=self._finished),
        type=self._setup.input_type, id=self.id, output_dir=self.output_dir,
        is_pending=not self._finished, is_running=not self._finished, is_failed=self.is_failed, data=_jsonable(data),
        created_at=datetime.datetime.fromtimestamp(self._started_at, datetime.timezone.utc).isoformat(timespec='seconds'),
        server=self.server,
      )
    run._token = self._token
    return run

  def __repr__(self) -> str:
    where = f" id={self.id}" if self.id is not None else ''
    return f"<ActiveRun{where} {self.input} {list(self.configs)} {self.state}{' failed' if self.is_failed else ''}>"

  # --- logging -----------------------------------------------------------------------------------------------------
  def log(self, values: Mapping[str, Any], step: Optional[int] = None) -> int:
    """
    Adds a point to series, e.g. at each training step: `run.log({"train/loss": loss, "lr": lr}, step=step)`.

    Values are numbers (also numpy and PyTorch scalars); nested mappings are flattened, {"train": {"loss": 1}} is
    "train/loss". Without `step`, steps count the calls. The series are saved in the run's folder, where the web app
    plots them next to the reference run's; each series' last value is also a metric of the run (see `summary=` in
    `start_run`). Wrap a value in `Metric(...)` to say how to show that metric. Returns the step.

    Never waits for the server. NaN and infinities are kept in the series, not in the metric.
    """
    if not isinstance(values, Mapping):
      raise TypeError("run.log() takes a mapping, e.g. run.log({'loss': 0.3}, step=10)")
    if step is not None and (isinstance(step, bool) or not isinstance(step, int)):
      try:
        number = as_number(step)
      except TypeError:
        raise TypeError(f"run.log(step=...) is an integer, not {step!r}") from None
      if number != int(number):
        raise TypeError(f"run.log(step=...) is an integer, not {step!r}")
      step = int(number)
    flat, definitions = split_metrics(flatten(values))
    numbers: Dict[str, float] = {}
    for key, value in flat.items():
      if not key or key.startswith('_') or len(key) > MAX_NAME_LENGTH or key in RESERVED_METRICS:
        raise ValueError(f"run.log(): {key!r} can't name a series: names are 1 to {MAX_NAME_LENGTH} characters, don't start with '_', and {' and '.join(RESERVED_METRICS)} are the run's own")
      if value is None:
        continue  # e.g. a scheduler without a learning rate yet
      try:
        numbers[key] = as_number(value)
      except TypeError as e:
        # hours into a training, a value of the wrong type is not worth the run: said once, skipped
        self._warn_once(f"value:{key}", f"WARNING: run.log(): not logging {key}: {e}. Series are numbers; use log_metrics() for texts, log_artifact() for files.")
    if not self._can_log('log'):
      return -1
    with self._lock:
      assert self._series is not None
      logged_step = self._series.append(numbers, step=step)
      for key, definition in definitions.items():
        self._definitions[key] = {**self._definitions.get(key, {}), **definition}
      self._changed = True
    return logged_step

  def log_metrics(self, metrics: Mapping[str, Any]) -> None:
    """
    Sets metrics of the run, e.g. its evaluation at the end: `run.log_metrics({"mAP": 0.41})`. Values are numbers,
    booleans, short texts or None; wrap them in `Metric(...)` to say their unit, target and which way is better.
    They replace a series' summary of the same name.
    """
    if not isinstance(metrics, Mapping) or not metrics:
      raise TypeError("run.log_metrics() takes a mapping of metrics, e.g. run.log_metrics({'mAP': 0.41})")
    values, definitions = split_metrics(flatten(metrics))
    cleaned: Dict[str, Any] = {}
    for key, value in values.items():
      if not key:
        raise ValueError("run.log_metrics(): metrics' names are not empty")
      if key in RESERVED_METRICS:
        raise ValueError(f"run.log_metrics(): the run sets {key} itself: use run.fail() to say it failed")
      if len(key) > MAX_NAME_LENGTH:
        raise ValueError(f"run.log_metrics(): metrics' names have at most {MAX_NAME_LENGTH} characters: {key[:40]!r}...")
      value = _metric_value(key, value)
      if isinstance(value, str) and len(value) > MAX_TEXT_LENGTH:
        self._warn_once(f"text:{key}", f"WARNING: the metric {key} is cut to {MAX_TEXT_LENGTH} characters: save long texts as files, with log_artifact()")
        value = value[:MAX_TEXT_LENGTH]
      if isinstance(value, float) and not math.isfinite(value):
        _say(f"WARNING: not saving the metric {key}: NaN and infinity can't be saved")
        continue
      cleaned[key] = value
    if not self._can_log('log_metrics'):
      return
    with self._lock:
      self._metrics.update(cleaned)
      for key, definition in definitions.items():
        self._definitions[key] = {**self._definitions.get(key, {}), **definition}
      self._changed = True

  def log_params(self, params: Mapping[str, Any]) -> None:
    """
    Reports parameters of the run, shown with its configuration in the web app: `run.log_params({"optimizer": "adamw"})`.
    Unlike `configs`, they don't identify the run: use them for what the run found out (the device, the number of
    weights, a resolved default), and `configs` for what you chose.
    """
    if not isinstance(params, Mapping):
      raise TypeError("run.log_params() takes a mapping, e.g. run.log_params({'optimizer': 'adamw'})")
    cleaned = _jsonable(params)
    if not self._can_log('log_params'):
      return
    with self._lock:
      from .utils import merge
      self._params = merge(cleaned, self._params)
      self._changed = True

  def log_artifact(self, name: Union[str, Path], source: Union[str, Path, bytes, None] = None) -> Optional[Path]:
    """
    Saves a file of the run: `run.log_artifact("checkpoints/last.pt", path)`. `name` is its path in the run's folder,
    `source` a file to copy, or `bytes` to write. `run.log_artifact(path)` alone copies the file under its own name.
    Saving the same name again replaces the file: they are the run's own.
    For big files, write in `run.output_dir` directly instead of copying. Returns the file's path.
    """
    if source is None:
      name, source = Path(name).name, name
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.name:
      raise ValueError(f"log_artifact() takes a path inside the run's folder, like 'checkpoints/last.pt', not {str(name)!r}")
    if not isinstance(source, bytes) and not Path(source).is_file():
      raise ValueError(f"{source!r} is not a file to copy. To write text, pass bytes: log_artifact(name, text.encode())")
    if not self._can_log('log_artifact'):
      return None
    target = self.output_dir / relative
    _mkdir_shared(target.parent)
    # atomic: the web app may read the previous file
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
      if isinstance(source, bytes):
        temporary.write_bytes(source)
      else:
        shutil.copyfile(source, temporary)
      os.replace(temporary, target)
    finally:
      if temporary.exists():
        temporary.unlink()
    return target

  def series(self, key: str) -> List[Point]:
    """What the run logged for `key`: (step, value, time) rows"""
    with self._lock:
      if self._series is not None:
        self._series.flush()
    return read_series(self.output_dir, key)

  # --- lifecycle ---------------------------------------------------------------------------------------------------
  def finish(self) -> None:
    """Ends the run: saves its metrics and the list of its files, and tells the server. Leaving the `with` block does it."""
    self._finish(failed=False)

  def fail(self, error: Union[BaseException, str, None] = None) -> None:
    """Ends the run as failed, with the error in its log. An exception in the `with` block does it."""
    self._finish(failed=True, error=error)

  def __enter__(self) -> 'ActiveRun':
    # SIGTERM (a job that is killed, a preempted node) ends the block like Ctrl+C: the run is marked as failed
    if threading.current_thread() is threading.main_thread() and self._entered_sigterm is None:
      from .utils import interrupted_by_sigterm
      self._entered_sigterm = interrupted_by_sigterm()
      self._entered_sigterm.__enter__()
    return self

  def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
    try:
      if exc_type is None or (exc_type is SystemExit and not getattr(exc, 'code', None)):
        self._finish(failed=False)
      else:
        self._finish(failed=True, error=exc)
    finally:
      if self._entered_sigterm is not None:
        self._entered_sigterm.__exit__(None, None, None)
        self._entered_sigterm = None

  # --- internals ---------------------------------------------------------------------------------------------------
  def _can_log(self, method: str) -> bool:
    """
    False, with a warning the first time, when what is logged can't be kept: the run is finished (callbacks that
    fire while a framework shuts down), or we are in a process forked from the run's (a data loader's worker), whose
    copy of the run the parent never sees. Not an error: logging doesn't end trainings.
    """
    if os.getpid() != self._pid:
      self._warn_once(f"fork:{os.getpid()}", f"WARNING: run.{method}() in another process than the run's ({os.getpid()}): not logged. Log from the process that called start_run().")
      return False
    if self._finished:
      self._warn_once('finished', f"WARNING: run.{method}(): the run is finished, not logged. Start another with start_run(), or continue this one with start_run(..., resume=True).")
      return False
    return True

  def _summary_of(self, key: str) -> str:
    """The summary of a series: its own, else the first pattern that matches its name ("val/*"), else "*"'s"""
    if key in self._summaries:
      return self._summaries[key]
    for pattern, how in self._summaries.items():
      if pattern != '*' and fnmatchcase(key, pattern):
        return how
    return self._summaries.get('*', 'last')

  def _current_metrics(self, final: bool = False) -> Dict[str, Any]:
    metrics: Dict[str, Any] = {}
    if self._series is not None:
      for key in self._series.series:
        how = self._summary_of(key)
        if how == 'none':
          continue
        value = self._series.aggregate(key, how)
        if value is not None:
          metrics[key] = value
    metrics.update(self._metrics)
    if final:
      metrics['is_failed'] = self.is_failed
      metrics['compute_time'] = round(self._elapsed(), 3)
    return metrics

  def _metrics_definitions(self, metrics: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Like at the end of a `qa run`: metrics_definitions.json < define_metric < Metric(...), for the run's metrics only"""
    from_file = read_definitions_file(self.output_dir)
    declared = declared_metrics()
    definitions = {}
    for key in metrics:
      definition, _ = clean_definition({**from_file.get(key, {}), **declared.get(key, {}), **self._definitions.get(key, {})})
      if definition:
        definitions[key] = definition
    return definitions

  def _start(self) -> None:
    global _hooks_installed
    setup = self._setup
    with self._lock:
      self._series = SeriesWriter(self.output_dir, resume=self._resume)
    if not setup.is_ci and setup.repo_root is not None and setup.is_default_commit:
      self._data.update(_dirty(setup.repo_root) or {})
    self._data['sdk'] = {k: v for k, v in _script_source().items() if k in ('script', 'script_sha256', 'qaboard_version')}
    if self._resume:
      self._restore()
    self._write_run_json()
    if self._capture_output:
      self._capture()
    with _active_lock:
      _active.append(self)
      if not _hooks_installed:
        _hooks_installed = True
        atexit.register(_finish_at_exit)
        _watch_uncaught_exceptions()
        _watch_sigterm()
    _say(f"run files: {self.output_dir}")
    if self._offline:
      if self.share:
        _say("QA_OFFLINE: the server isn't told about the run")
    else:
      # now, so that the run shows as running, and problems (no token, no access) show before hours of training
      self._sync(first=True)
      if self.id is not None:
        _say(f"results: {self.url}")
    self._thread = threading.Thread(target=self._loop, name='qaboard-run', daemon=True)
    self._thread.start()

  def _write_run_json(self) -> None:
    """
    What `qa run` writes when it starts, then what it doesn't: enough to know the run without the server, and what it
    logged that isn't in its series, so that `resume=True` finds it after the process was killed.
    """
    with self._lock:
      content = {
        'database': str(self.database),
        'input_path': self.input,
        'input_type': self._setup.input_type,
        'configurations': list(self.configs),
        'extra_parameters': {},
        'platform': self.platform,
        'project': self.project,
        'commit': self.commit,
        'batch': self.batch,
        'started_with': 'qaboard.start_run',
        'logged': {'metrics': _jsonable(self._metrics), 'params': _jsonable(self._params), 'compute_time': round(self._elapsed(), 3)},
      }
      self._saved_logged = (dict(self._metrics), json.dumps(_jsonable(self._params), sort_keys=True))
    path = self.output_dir / 'run.json'
    temporary = path.with_name(f".run.json.{os.getpid()}.tmp")
    try:
      temporary.write_text(json.dumps(content, sort_keys=True, indent=2, separators=(',', ': ')))
      os.replace(temporary, path)
    except OSError:
      try:
        temporary.unlink()
      except OSError:
        pass
      raise

  def _restore(self) -> None:
    """resume=True: the metrics and parameters the run logged before, and how long it ran"""
    try:
      logged = json.loads((self.output_dir / 'run.json').read_text()).get('logged') or {}
    except (OSError, ValueError, AttributeError):
      return
    if isinstance(logged.get('metrics'), dict):
      self._metrics.update(logged['metrics'])
    if isinstance(logged.get('params'), dict):
      self._params.update(logged['params'])
    if isinstance(logged.get('compute_time'), (int, float)):
      self._previous_time = float(logged['compute_time'])

  def _elapsed(self) -> float:
    """How long the run ran, with what it ran before it was resumed"""
    return self._previous_time + (self._ended_at or time.time()) - self._started_at

  def _capture(self) -> None:
    from .utils import TeeStream
    try:
      self._log_file = open(self.output_dir / 'log.txt', 'a', encoding='utf-8', errors='replace')
    except OSError as e:
      _say(f"WARNING: could not save the run's log: {e}")
      return
    for name in ('stdout', 'stderr'):
      stream = getattr(sys, name)
      tee = TeeStream(stream, self._log_file)
      setattr(sys, name, tee)
      self._tees.append((name, tee, stream))

  def _release_output(self) -> None:
    from .utils import TeeStream
    for name, tee, stream in reversed(self._tees):
      current = getattr(sys, name)
      if current is tee:
        # tee.stream, not `stream`: a run we wrapped may have stepped out since
        setattr(sys, name, tee.stream)
        continue
      # another run started after us wraps our stream: we step out of the chain. What else replaced the streams stays
      while isinstance(current, TeeStream):
        if current.stream is tee:
          current.stream = tee.stream
          break
        current = current.stream
    self._tees = []
    if self._log_file is not None:
      try:
        self._log_file.close()
      except OSError:
        pass
      self._log_file = None

  def _loop(self) -> None:
    last_flush = 0.0
    last_saved = time.time()
    while not self._stop.wait(min(FLUSH_INTERVAL, self._sync_interval)):
      now = time.time()
      try:
        if now - last_flush >= FLUSH_INTERVAL:
          last_flush = now
          with self._lock:
            if self._series is not None:
              self._series.flush()
            unsaved = self._saved_logged != (self._metrics, json.dumps(_jsonable(self._params), sort_keys=True))
          # also now and then for how long the run ran, that a resumed run adds to
          if unsaved or now - last_saved >= 15 * FLUSH_INTERVAL:
            last_saved = now
            self._write_run_json()
      except OSError as e:
        self._warn_once('files', f"WARNING: could not write the run's series: {e}")
      if not self._offline and now >= self._next_sync:
        self._sync()

  def _warn_once(self, kind: str, message: str) -> None:
    if kind not in self._warned:
      self._warned.add(kind)
      _say(message)

  def _payload(self, final: bool) -> Dict[str, Any]:
    """What `qa run` sends to POST /api/v1/output/ (qaboard/api.py:notify_qa_database)"""
    setup = self._setup
    with self._lock:
      metrics = self._current_metrics(final=final)
      data = {**self._data, 'params': dict(self._params), 'attempt_logs': attempts.kept_logs(self.output_dir)}
      definitions = with_default_direction(self._metrics_definitions(metrics), setup.available_metrics)
      if final:
        self._changed = False
      # else: the server doesn't save the metrics sent with a run that starts. What was logged before it knew the run
      # (it was away) goes with the next progress report
    payload = results_payload({
      'project': self.project,
      'project_root': setup.project_root,
      'subproject': setup.subproject,
      'user': setup.user,
      'share': True,
      'batch_label': self.batch,
      'raw_batch_label': self._raw_batch,
      'platform': self.platform,
      'input_type': setup.input_type,
      'database': self.database,
      'input_path': self.input,
      'rel_input_path': self.input,
      # not `configuration`, their legacy text: the server would parse it instead of the list
      'configurations': list(self.configs),
      'extra_parameters': {},
      'output_directory': self.output_dir,
      'is_pending': not final,
      'is_running': not final,
      'metrics': _jsonable(metrics),
      'data': _jsonable(data),
    }, is_ci=setup.is_ci, run_context=setup.run_context, commit_id=self.commit, commit=_jsonable(setup.commit_data),
       # without a qaboard.yaml we send no configuration: the project keeps the one it has
       config=setup.config if setup.has_qaboard_yaml else None, metrics_file=_jsonable(setup.metrics_file))
    if setup.artifacts_commit is not None:
      payload['artifacts_commit'] = serialize_path(setup.artifacts_commit)
    if definitions:
      payload['metrics_definitions'] = definitions
    if final:
      payload['is_failed'] = self.is_failed
    return payload

  def _sync(self, first: bool = False, final: bool = False) -> bool:
    """Tells the server what the run looks like now. Returns whether it knows."""
    if self._offline or not self.server:
      return False
    if self._refused and not final:
      return False
    with self._send_lock:
      with self._lock:
        changed = self._changed
      try:
        if self.id is None or final:
          # creates the run, or says how it ended: everything, like `qa run` does
          answer = _request(self.server, 'output/', method='POST', json=self._payload(final), token=self._token, timeout=TIMEOUT)
          if isinstance(answer.get('id'), int):
            self.id = answer['id']
        elif changed and self._live_updates:
          with self._lock:
            metrics = self._current_metrics()
            body: Dict[str, Any] = {'metrics': _jsonable(metrics), 'params': _jsonable(self._params)}
            definitions = with_default_direction(self._metrics_definitions(metrics), self._setup.available_metrics)
            self._changed = False
          if definitions != self._sent_definitions:
            body['metrics_definitions'] = definitions
          try:
            _request(self.server, f"output/{self.id}/progress", method='PATCH', json=body, token=self._token, timeout=TIMEOUT)
            self._sent_definitions = definitions
          except ResultsError as e:
            if e.status is None or e.status >= 500 or e.status in (401, 403, 408, 429):
              raise
            # a server from before runs reported their progress (404), or one that doesn't take this run's:
            # it gets the metrics when the run ends
            self._live_updates = False
            if e.status not in (404, 405):
              self._warn_once('progress', f"WARNING: the web app will show the run's metrics when it ends, not before: {e}")
      except ResultsError as e:
        with self._lock:
          self._changed = True
        if e.reason or (e.status is not None and 400 <= e.status < 500 and e.status not in (408, 429)):
          self._refused = str(e)
          _say(f"WARNING: the server refused the run: {e}")
          _say(f"         Logging goes on in {self.output_dir}; finish() will try once more.")
        else:
          self._failures += 1
          self._next_sync = time.time() + min(MAX_SYNC_INTERVAL, self._sync_interval * 2 ** min(self._failures, 6))
          if first or final:
            _say(f"WARNING: {e}")
          if first:
            _say(f"         Logging goes on in {self.output_dir}; the run will show in the web app when the server answers.")
        return False
      except Exception as e: # logging must never end a training
        self._warn_once('sync', f"WARNING: could not tell the server about the run: {e!r}")
        return False
      self._failures = 0
      self._refused = None
      self._next_sync = time.time() + self._sync_interval
      return True

  def _finish(self, failed: bool, error: Union[BaseException, str, None] = None) -> None:
    with self._lock:
      if self._finished:
        return
      self._finished = True
      self._ended_at = time.time()
      self.is_failed = bool(failed)
      if error is not None:
        self.error = f"{type(error).__name__}: {error}" if isinstance(error, BaseException) else str(error)
    self._stop.set()
    if self._thread is not None and self._thread is not threading.current_thread():
      self._thread.join(timeout=TIMEOUT[1] + TIMEOUT[0] + 5)
    with _active_lock:
      if self in _active:
        _active.remove(self)

    if error is not None:
      text = ''.join(traceback.format_exception(type(error), error, error.__traceback__)) if isinstance(error, BaseException) else f"{error}\n"
      try:
        if self._log_file is not None:
          self._log_file.write(f"\n[ERROR] The run failed.\n{text}")
        else:
          with open(self.output_dir / 'log.txt', 'a', encoding='utf-8', errors='replace') as f:
            f.write(f"\n[ERROR] The run failed.\n{text}")
      except (OSError, ValueError):
        pass
    self._release_output()

    metrics: Dict[str, Any] = {}
    try:
      with self._lock:
        if self._series is not None:
          self._series.close()
        metrics = self._current_metrics(final=True)
        definitions = self._metrics_definitions(metrics)
      self._write_run_json()
      (self.output_dir / 'metrics.json').write_text(json.dumps(_jsonable(metrics), sort_keys=True, indent=2, separators=(',', ': ')))
      if definitions or (self.output_dir / DEFINITIONS_FILE).exists():
        (self.output_dir / DEFINITIONS_FILE).write_text(json.dumps(definitions, sort_keys=True, indent=2, separators=(',', ': ')))
      from .utils import save_outputs_manifest, total_storage
      manifest = save_outputs_manifest(self.output_dir, config=self._setup.config)
      self._data['storage'] = total_storage(manifest)
      if self.share:
        _share_permissions(self.output_dir)
    except Exception as e:
      _say(f"WARNING: could not save the run's files: {e!r}")

    if not self._offline:
      if self._sync(final=True):
        _say(f"{'failed' if self.is_failed else 'finished'}: {self.url}")
      else:
        _say(f"WARNING: the server doesn't know how the run ended. Its files are in {self.output_dir}")
    elif self._pid == os.getpid():
      _say(f"{'failed' if self.is_failed else 'finished'}: {self.output_dir}")


def _finish_at_exit() -> None:
  """Runs nobody finished end with the process: failed if it dies from an exception."""
  with _active_lock:
    runs = list(_active)
  for run in reversed(runs):
    if run._pid != os.getpid(): # a forked worker: the run is its parent's
      continue
    if _uncaught is not None:
      run.fail(_uncaught)
    else:
      run.finish()


_uncaught: Optional[BaseException] = None


def _watch_uncaught_exceptions() -> None:
  previous = sys.excepthook

  def hook(exc_type: Any, exc: Any, tb: Any) -> None:
    global _uncaught
    if _active and not issubclass(exc_type, SystemExit):
      _uncaught = exc
    previous(exc_type, exc, tb)

  sys.excepthook = hook


def _watch_sigterm() -> None:
  """
  A job that is killed politely (a scheduler's time limit, a preempted node, `kill`) gets SIGTERM, which ends Python
  without running what we registered: its runs would stay "running" in the web app. While runs are active, SIGTERM
  raises KeyboardInterrupt like Ctrl+C does, so that they end as failed. Only when the program handles SIGTERM the
  default way, and from the main thread, where Python lets us.
  """
  import signal
  if threading.current_thread() is not threading.main_thread():
    return
  try:
    if signal.getsignal(signal.SIGTERM) is not signal.SIG_DFL:
      return

    def on_sigterm(signo: int, frame: Any) -> None:
      if _active:
        raise KeyboardInterrupt
      signal.signal(signal.SIGTERM, signal.SIG_DFL)
      os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGTERM, on_sigterm)
  except (ValueError, OSError):
    pass
