"""
QA-Board's runs from Python: the runs a web app page shows, as `Run` objects.

    import qaboard as qb
    for run in qb.runs("https://qaboard/my/project/commit/abc123?batch=ci&filter=night"):
        print(run.input, run.metrics.get("psnr"), run.output_dir / "output.png")

The URL is the one in the browser: `runs()` reads the project, commit, batch and filter from it like the web app
(webapp/src/selection.js) and asks the server for the runs, filtered like the web app does (qaboard/filters.py).
`qa runs <url>` does the same from the shell.

`run.log_metrics({...})` adds metrics to a run: the server merges them and remembers who added them, with which
script. `run.log_artifact(name, file)` adds a file to the run's folder, without overwriting anything.
`run.series(key)` reads what it logged while it ran. Runs created without `qa` as the entrypoint (training loops,
evals: `qaboard.start_run()`, qaboard/active_run.py) give the same `Run`. Its attributes are named like the
`context` your `run()` function gets (qaboard/run.py): `configs`, `params`, `output_dir`, `input_path`...

This module doesn't need a qaboard.yaml: it only talks to the server, found in the URL. It reads the token to send
like the rest of qa (qaboard/credentials.py).
"""
import hashlib
import math
import os
import shutil
import sys
from dataclasses import dataclass, field, fields
from pathlib import Path
from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

from .compat import url_to_dir
from .credentials import resolve_token, refusal, default_server, same_server, read_hosts, find_login, ENV_TOKENS
from .filters import filter_runs, run_params
from .metrics import split_metrics, declared_metrics
from .series import Point
from .site_config import site_config, as_requests_verify


# (connect, read) timeouts for requests to the server: commits with thousands of runs take a while to serialize
REQUEST_TIMEOUT = (30, 600)
# Runs of `qa optimize`'s iterations: the web app doesn't show them with the batch's runs
HIDDEN_RUN_TYPES = ('optim_iteration',)
# runs(side=): the runs compared, or those of the reference bar. The web app may compare with several references one day (?compare=)
SIDES = ('new', 'reference')


class ResultsError(Exception):
  """
  The server could not give the runs: unknown project or commit, refused request, network error...
  `status` is its HTTP status when it answered, `reason` why it refused the request (e.g. "missing_role").
  """
  def __init__(self, message: str, status: Optional[int] = None, reason: Optional[str] = None):
    super().__init__(message)
    self.status = status
    self.reason = reason


@dataclass(frozen=True)
class _Side:
  """One bar of the web app's commit page: a project's commit, one of its batches, maybe filtered."""
  project: str
  commit: Optional[str]          # a commit id (or its start), a branch, a tag; None for the latest with results
  batch: str = 'default'
  filter: Optional[str] = None
  branch: Optional[str] = None   # without a commit: the latest commit with results on this branch

  def query(self) -> Dict[str, Any]:
    params: Dict[str, Any] = {'project': self.project, 'batch': self.batch, 'metrics': '{}'}
    if self.branch and not self.commit:
      params['branch'] = self.branch
    return params


@dataclass(frozen=True)
class _Selection:
  """What a web app URL shows: the server, the runs compared (`new`), and the reference they are compared to."""
  server: str
  new: _Side
  reference: _Side
  url: Optional[str] = None


def _text(query: Dict[str, List[str]], key: str) -> Optional[str]:
  """`?filter=a&filter=b` is one filter, "a b", like in the web app. None when absent or empty."""
  values = [v for v in query.get(key, []) if v]
  return ' '.join(values) if values else None


def _strip_prefix(path: str, prefix: str) -> Optional[str]:
  """`path` without the `prefix` segments, None when it doesn't start with them"""
  segments, prefix_segments = [s for s in path.split('/') if s], [s for s in prefix.split('/') if s]
  if segments[:len(prefix_segments)] != prefix_segments:
    return None
  return '/' + '/'.join(segments[len(prefix_segments):])


def parse_url(url: str, server: Optional[str] = None) -> _Selection:
  """
  Reads a web app URL like `https://qaboard/<project>/commit/<commit>?batch=ci&filter=night&reference=<id>&batch_ref=…`,
  the way the web app does (webapp/src/selection.js).

  The project is everything before `/commit/` (project ids contain slashes). `/<project>/commit` is the latest commit
  with results (on `?branch=` if given). Give `server` when QA-Board is served under a path prefix, e.g.
  `https://tools.example.com/qaboard`: the URL alone can't say where the project's name starts.
  """
  parts = urlsplit(url.strip())
  if not parts.scheme or not parts.netloc:
    raise ValueError(f"Not a QA-Board URL: {url!r}. Copy the address of a commit's page in the web app, like https://qaboard/my/project/commit/abc123?batch=ci")
  path = unquote(parts.path)
  if server:
    server = server.rstrip('/')
    prefix = urlsplit(server).path
    stripped = _strip_prefix(path, prefix) if prefix.strip('/') else path
    if stripped is None:
      raise ValueError(f"{url} is not under the server {server}")
    path = stripped
  else:
    server = f"{parts.scheme}://{parts.netloc}"
  segments = [s for s in path.split('/') if s]
  query = parse_qs(parts.query, keep_blank_values=True)
  route_index = next((i for i, s in enumerate(segments) if s == 'commit'), None)
  if route_index is None or route_index == 0:
    lists = any(s in ('commits', 'history', 'dashboard', 'committer') for s in segments)
    what = "a list of commits, not a commit's runs" if lists else "not the page of a commit's runs"
    raise ValueError(f"{url} is {what}. Open a commit in the web app (its address has /commit/) and copy the address, or name the runs: runs(project='group/repo', branch='main', batch='ci')")
  project = '/'.join(segments[:route_index])
  commit = '/'.join(segments[route_index + 1:]) or None
  batch = _text(query, 'batch') or _text(query, 'batch_new') or 'default'
  # users can compare results from different projects
  new = _Side(project=_text(query, 'new_project') or project, commit=commit, branch=_text(query, 'branch') if not commit else None,
              batch=batch, filter=_text(query, 'filter'))
  reference = _Side(
    project=_text(query, 'ref_project') or project,
    commit=_text(query, 'reference'),
    batch=_text(query, 'batch_ref') or 'default',
    filter=_text(query, 'filter_ref'),
  )
  return _Selection(server=server, new=new, reference=reference, url=url)


# Run's fields given as read-only mappings
_MAPPINGS = ('extra_parameters', 'params', 'metrics', 'input_metadata', 'data')


def _plain(value: Any) -> Any:
  """A copy of `value` with plain dicts and lists, for JSON"""
  if isinstance(value, Mapping):
    return {k: _plain(v) for k, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [_plain(v) for v in value]
  return value


@dataclass
class Run:
  """
  One run: an input processed with some configurations and parameters, on a commit, in a batch, as the server knows it.

  `qa runs --json` prints these fields (see `to_dict`). Read-only: the mappings are `MappingProxyType` views and
  `configs` a tuple, since changing them would change nothing on the server; `log_metrics()` does.
  """
  project: str
  commit: Optional[str]
  batch: str                                   # the batch's label in the web app; data['batch'] is the batch of qaboard.yaml it comes from
  input: str                                   # the input's path, relative to its database
  database: Optional[str] = None               # where the inputs are
  platform: str = 'linux'
  configs: Tuple[Any, ...] = ()                # the configurations, strings and mappings, then the tuning parameters: like context.configs
  params: Mapping[str, Any] = field(default_factory=dict)            # the mappings of configs merged, and the parameters the run reported: like context.params
  extra_parameters: Mapping[str, Any] = field(default_factory=dict)  # the tuning parameters alone (qa --tuning): rarely needed, they're in configs
  metrics: Mapping[str, Any] = field(default_factory=dict)
  type: str = ''                               # the input type (qaboard.yaml's inputs.types), 'optim_iteration' for qa optimize's iterations
  id: Optional[int] = None                     # QA-Board's id, None until the server knows the run
  output_dir: Optional[Path] = None            # where its files are
  is_pending: bool = True
  is_running: bool = False
  is_failed: bool = False
  deleted: bool = False                        # its files were deleted
  input_metadata: Mapping[str, Any] = field(default_factory=dict)
  data: Mapping[str, Any] = field(default_factory=dict)    # what else the server knows: who ran it, where...
  created_at: Optional[str] = None
  finished_at: Optional[str] = None
  server: Optional[str] = None

  def __post_init__(self) -> None:
    # read-only views: changing a run read from the server would change nothing on the server, run.log_metrics() does
    self.configs = tuple(self.configs)
    for name in _MAPPINGS:
      setattr(self, name, MappingProxyType(dict(getattr(self, name))))
    # how `log()` talks to the server: set by runs(), not fields
    self._token: Optional[str] = None
    self._dry_run: bool = False

  @classmethod
  def from_api(cls, output: Dict[str, Any], *, project: str, commit: Optional[str], batch: str, server: Optional[str] = None) -> 'Run':
    """A run as the API gives it, an "output" of /api/v1/commit/<id>"""
    data: Dict[str, Any] = output['data'] if isinstance(output.get('data'), dict) else {}
    extra_parameters: Dict[str, Any] = dict(output.get('extra_parameters') or {})
    # the effective parameters a run reported, shown over the tuning parameters (webapp/src/api/normalize.js)
    reported = data['params'] if isinstance(data.get('params'), dict) else {}
    return cls(
      project=project,
      commit=commit,
      batch=batch,
      input=str(output.get('test_input_path', '')),
      database=output.get('test_input_database'),
      platform=output.get('platform') or 'linux',
      configs=(*(output.get('configurations') or ()), *([extra_parameters] if extra_parameters else [])),
      extra_parameters=extra_parameters,
      params=run_params(output.get('configurations'), {**extra_parameters, **reported}),
      metrics=dict(output.get('metrics') or {}),
      type=output.get('output_type') or '',
      id=output.get('id'),
      output_dir=url_to_dir(output['output_dir_url']) if output.get('output_dir_url') else None,
      is_pending=bool(output.get('is_pending')),
      is_running=bool(output.get('is_running')),
      is_failed=bool(output.get('is_failed')),
      deleted=bool(output.get('deleted')),
      input_metadata=dict(output.get('test_input_metadata') or {}),
      data=dict(data),
      created_at=output.get('created_date'),
      finished_at=output.get('finished_at'),
      server=server,
    )

  @classmethod
  def _new(cls, *, project: str, input: str, batch: str = 'default', commit: Optional[str] = None, database: Optional[str] = None,
           platform: Optional[str] = None, configs: Optional[List[Any]] = None, extra_parameters: Optional[Dict[str, Any]] = None,
           output_dir: Optional[Path] = None, server: Optional[str] = None) -> 'Run':
    """A run that doesn't exist yet: what creating runs from code will start from, before the server knows it. Private until then."""
    extra_parameters = dict(extra_parameters or {})
    return cls(project=project, commit=commit, batch=batch, input=input, database=database, platform=platform or ('windows' if os.name == 'nt' else 'linux'),
               configs=(*(configs or ()), *([extra_parameters] if extra_parameters else [])), extra_parameters=extra_parameters,
               params=run_params(configs, extra_parameters), output_dir=output_dir, server=server,
               is_pending=True, is_running=False, is_failed=False)

  @property
  def state(self) -> str:
    """`pending` (not started), `running`, or `finished` (see `is_failed`)"""
    if self.is_running:
      return 'running'
    return 'pending' if self.is_pending else 'finished'

  @property
  def input_path(self) -> Optional[Path]:
    """The input's full path, when its database is known: like context.input_path"""
    return Path(self.database) / self.input if self.database else None

  @property
  def rel_input_path(self) -> Path:
    """`input` as a Path: like context.rel_input_path"""
    return Path(self.input)

  @property
  def url(self) -> Optional[str]:
    """The run in the web app"""
    if not (self.server and self.commit):
      return None
    # filters are regular expressions, and the text searched ends with the id
    query = urlencode({'batch': self.batch, 'filter': f"id:{self.id}$" if self.id is not None else self.input})
    return f"{self.server}/{quote(self.project)}/commit/{self.commit}?{query}"

  def log_metrics(self, metrics: Mapping[str, Any], *, note: Optional[str] = None, overwrite: bool = False, dry_run: Optional[bool] = None) -> Dict[str, Any]:
    """
    Adds metrics to the run, e.g. computed by your script from its files: `run.log_metrics({"sharpness": 0.4})`.

    The server merges them into the run's metrics (the run's own metrics.json isn't changed) and remembers in the run's
    `data["added_metrics"]` who added each one (the token's user), when and with which script. Values are finite
    numbers, booleans, short texts or None; wrap them in `Metric(...)` to declare them (unit, which way is better...).
    Metrics the run itself returned are refused unless `overwrite=True`: the run's value is then kept as `replaced`.
    If the run is run again and its code returns a metric of the same name, the run's value wins. Returns what was
    added, with its provenance.

    Needs to be signed in with a token with the ingest scope (`qa auth login`), and the developer role on the project.
    `dry_run=True` (or `runs(url, dry_run=True)`) prints what it would add instead.
    """
    if not isinstance(metrics, Mapping) or not metrics:
      raise ValueError("run.log_metrics() takes a mapping of metrics, e.g. run.log_metrics({'sharpness': 0.4})")
    values, definitions = split_metrics({k: _plain_value(v) for k, v in metrics.items()})
    declared = declared_metrics()
    definitions = {**{k: declared[k] for k in values if k in declared}, **definitions}
    for key, value in values.items():
      if not isinstance(key, str) or not key:
        raise ValueError(f"metrics' names are non-empty strings, not {key!r}")
      if isinstance(value, float) and not math.isfinite(value):
        print(f"WARNING: not logging {key}: NaN and infinity can't be saved", file=sys.stderr)
      elif value is not None and not isinstance(value, (bool, int, float, str)):
        raise ValueError(f"{key}: metrics added to runs are numbers, booleans, texts or None, not {type(value).__name__}")
    values = {k: v for k, v in values.items() if not (isinstance(v, float) and not math.isfinite(v))}
    if not values:
      return {}
    if self._dry_run if dry_run is None else dry_run:
      source = _script_source(note)
      print(f"[dry run] would add to {self!r}: {values} (by {source.get('user')}, {source.get('script')})", file=sys.stderr)
      return {k: {'value': v, 'dry_run': True, **source} for k, v in values.items()}
    if self.id is None or not self.server:
      raise ResultsError("This run isn't on a server yet: only runs from runs(url) can be logged to for now")
    payload: Dict[str, Any] = {'metrics': values, 'source': _script_source(note)}
    if overwrite:
      payload['overwrite'] = True
    if definitions:
      payload['metrics_definitions'] = definitions
    answer = _request(self.server, f"output/{self.id}/metrics", method='PATCH', json=payload, token=self._token)
    self.metrics = MappingProxyType(dict(answer.get('metrics') or {**self.metrics, **values}))
    if isinstance(answer.get('data'), dict):
      self.data = MappingProxyType(dict(answer['data']))
    return answer.get('added') or {}

  def log_artifact(self, name: Union[str, Path], source: Union[str, Path, bytes], *, overwrite: bool = False, dry_run: Optional[bool] = None) -> Optional[Path]:
    """
    Adds a file to the run, e.g. a map your script computed: `run.log_artifact("sharpness/map.png", path_or_bytes)`.

    `name` is the file's path in the run's folder (subfolders are created); `source` a file to copy (`str`/`Path`),
    or the content to write (`bytes`). Nothing is overwritten unless `overwrite=True`: runs'
    folders are shared, and the run's own files stay the run's. The web app then lists the file with the run's
    (its manifest is refreshed), and shows it with the viewer its extension picks. Returns the file's path.

    Writes in the shared storage as you, like `qa run --share`: you need write access to the run's folder.
    `dry_run=True` (or `runs(url, dry_run=True)`) prints what it would write instead.
    """
    if not self.output_dir:
      raise ResultsError(f"{self!r} has no folder (its files were deleted?): nothing to add a file to")
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.name:
      raise ValueError(f"log_artifact() takes a path inside the run's folder, like 'sharpness/map.png', not {str(name)!r}")
    target = self.output_dir / relative
    if isinstance(source, bytes):
      source_path, content = None, source
    else:
      source_path, content = Path(source), b''
      if not source_path.is_file():
        raise ValueError(f"{source!r} is not a file to copy. To write text, pass bytes: log_artifact(name, text.encode())")
    if self._dry_run if dry_run is None else dry_run:
      what = f"copy {source_path}" if source_path else f"write {len(content)} bytes"
      print(f"[dry run] would {what} to {target}", file=sys.stderr)
      return None
    if target.exists() and not overwrite:
      raise ResultsError(f"{target} exists: pass overwrite=True to replace it (not for files the run itself wrote)")
    target.parent.mkdir(parents=True, exist_ok=True)
    if source_path:
      shutil.copyfile(source_path, target)
    else:
      target.write_bytes(content)
    if self.id is not None and self.server:
      try:
        _request(self.server, f"output/{self.id}/manifest", params={'refresh': '1'}, token=self._token)
      except ResultsError as e:
        print(f"WARNING: {target} is written, but the web app may not list it yet: {e}", file=sys.stderr)
    return target

  def series(self, key: str) -> 'List[Point]':
    """
    What the run logged for `key` while it ran, with `run.log({key: value}, step=...)`: `(step, value, time)` rows,
    read from the series.jsonl of its folder (qaboard/series.py). Empty when it logged no such series.
    """
    if not self.output_dir:
      return []
    from .series import read_series
    return read_series(self.output_dir, key)

  def to_dict(self) -> Dict[str, Any]:
    """The run as JSON-friendly data: what `qa runs --json` prints"""
    d = {f.name: _plain(getattr(self, f.name)) for f in fields(self)}
    d['output_dir'] = str(self.output_dir) if self.output_dir else None
    d['state'] = self.state
    d['url'] = self.url
    return d

  def __repr__(self) -> str:
    where = f" id={self.id}" if self.id is not None else ''
    return f"<Run{where} {self.input} {list(self.configs)} {self.state}{' failed' if self.is_failed else ''}>".replace('  ', ' ')


class Runs(list):
  """The runs of a selection, in the order the server gives them. `side` says what they are. Slices are plain lists."""
  def __init__(self, runs: List[Run], side: Optional[_Side] = None, commit: Optional[str] = None, server: Optional[str] = None):
    super().__init__(runs)
    self.side = side
    self.commit = commit # the full commit id, resolved by the server
    self.server = server

  def __repr__(self) -> str:
    side = f" of {self.side.project}@{(self.commit or self.side.commit or self.side.branch or '')[:8]} batch={self.side.batch!r}" if self.side else ''
    return f"<Runs {len(self)}{side}>"


def _plain_value(value: Any) -> Any:
  """numpy scalars and 0-d arrays as Python numbers, like the CLI does for the metrics run() returns"""
  if not isinstance(value, (str, bytes, bool, int, float)) and hasattr(value, 'item'):
    try:
      return value.item()
    except Exception:
      return value
  return value


def _script_source(note: Optional[str] = None) -> Dict[str, Any]:
  """
  What the server records about the script that adds metrics: its name and the first 16 hex digits of its SHA-256, the
  qaboard version, a note. Who added them is the token's user: the server doesn't take the script's word for it.
  """
  from . import __version__
  source: Dict[str, Any] = {'qaboard_version': __version__}
  script = Path(sys.argv[0]) if sys.argv and sys.argv[0] else None
  if script and script.name and script.name not in ('-c', '-m') and 'ipykernel' not in script.name:
    source['script'] = script.name
    try:
      source['script_sha256'] = hashlib.sha256(script.read_bytes()).hexdigest()[:16]
    except OSError:
      pass
  else:
    source['script'] = '<notebook>' if script and 'ipykernel' in script.name else '<interactive>'
  if note:
    source['note'] = str(note)
  return source


def _token_for(server: str, token: Optional[str]) -> Optional[str]:
  """
  The token to send to `server`: the one given, else the one `qa` uses for it. A token from the environment
  (QABOARD_TOKEN) is for the configured server: we don't send it to whatever server a pasted URL names.
  """
  if token is not None:
    return token or None
  found, source = resolve_token(server)
  if found and source in ENV_TOKENS and not same_server(server, default_server()[0]):
    print(f"WARNING: not sending {source} to {server}: it is for {default_server()[0]}. Sign in with `qa auth login {server}`, or pass token=.", file=sys.stderr)
    _, login = find_login(read_hosts(), server)
    found = str(login['token']).strip() if login and login.get('token') else None
  return found


def _request(server: str, path: str, params: Optional[Dict[str, Any]] = None, token: Optional[str] = None,
             method: str = 'GET', json: Optional[Dict[str, Any]] = None, timeout: Optional[Tuple[float, float]] = None) -> Dict[str, Any]:
  import requests
  token = _token_for(server, token)
  headers = {'Authorization': f"Bearer {token}"} if token else {}
  verify = as_requests_verify(site_config('QABOARD_API_VERIFY'))
  url = f"{server}/api/v1/{path}"
  try:
    r = requests.request(method, url, params=params, json=json, headers=headers, verify=verify, timeout=timeout or REQUEST_TIMEOUT)
  except requests.RequestException as e:
    raise ResultsError(f"Could not reach {server}: {e}") from e
  if r.status_code >= 400:
    refused = refusal(r)
    if refused:
      scope = 'ingest' if method != 'GET' else 'read'
      hint = f"Sign in with `qa auth login {server}`, or set QABOARD_TOKEN to a token with the {scope} scope." if refused.get('reason') in ('login_required', 'ingest_token_required', 'missing_scope', 'token_expired', 'invalid_token') else "Ask the project's owners for access."
      raise ResultsError(f"{refused['error']} ({refused.get('reason')}). {hint}", status=r.status_code, reason=refused.get('reason') or 'refused')
    try:
      message = r.json().get('error') or r.text
    except ValueError:
      message = r.text
    raise ResultsError(f"{server} answered {r.status_code} to {path} ({params}): {message}", status=r.status_code)
  try:
    return r.json()
  except ValueError as e:
    raise ResultsError(f"Can't understand the answer of {url}: {r.text[:200]}") from e


def _side_runs(server: str, side: _Side, *, token: Optional[str], include_deleted: bool, include_hidden: bool, dry_run: bool = False) -> Runs:
  commit = _request(server, f"commit/{quote(side.commit, safe='')}" if side.commit else "commit", side.query(), token)
  batches = commit.get('batches') or {}
  if side.batch not in batches:
    available = ', '.join(sorted(batches)) or 'none'
    raise ResultsError(f"Commit {commit.get('id', side.commit)} of {side.project} has no batch {side.batch!r}. Available: {available}")
  outputs = batches[side.batch].get('outputs') or {}
  shown = filter_runs(side.filter, list(outputs.values()))
  runs = [Run.from_api(o, project=side.project, commit=commit.get('id'), batch=side.batch, server=server) for o in shown]
  if not include_deleted:
    runs = [r for r in runs if not r.deleted]
  if not include_hidden:
    runs = [r for r in runs if r.type not in HIDDEN_RUN_TYPES]
  for run in runs:
    run._token, run._dry_run = token, dry_run
  return Runs(runs, side=side, commit=commit.get('id'), server=server)


def runs(url: Optional[str] = None, *, project: Optional[str] = None, commit: Optional[str] = None, branch: Optional[str] = None,
         batch: Optional[str] = None, filter: Optional[str] = None, side: str = 'new', server: Optional[str] = None,
         token: Optional[str] = None, include_deleted: bool = False, include_hidden: bool = False, dry_run: bool = False) -> Runs:
  """
  The runs a web app page shows, as `Run` objects.

  Pass the page's address, or name the runs: `runs(project='group/repo', commit='abc123', batch='ci', filter='night')`
  (`commit` can be a branch or a tag; without it, the latest commit with results, on `branch` if given). Keyword
  arguments override what the URL says: `commit=` or `branch=` replaces the URL's. `side='reference'` gives the runs of
  the reference bar (`?reference=&batch_ref=&filter_ref=`) instead of the compared ones (`side='new'`).

  `server`: the QA-Board server, when the URL doesn't say (its address, or when it is served under a path prefix).
  Without a URL, the server is the one `qa` uses (QABOARD_URL...). `token`: an API token, else the one `qa` is
  signed in with. Left out unless asked: runs whose files were deleted (`include_deleted`), and runs the web app
  doesn't list with the batch, like `qa optimize`'s iterations (`include_hidden`). With `dry_run=True`, `run.log_metrics()`
  prints what it would add instead of sending it: try scripts on it first (`run.log_metrics(..., dry_run=False)` sends anyway).
  """
  if side not in SIDES:
    raise ValueError(f"side={side!r}: expected one of {', '.join(map(repr, SIDES))}. 'new' gives the runs compared, 'reference' those of the reference bar.")
  selected: _Side
  if url:
    selection = parse_url(url, server=server)
    selected = selection.reference if side == 'reference' else selection.new
    if side == 'reference' and not selected.commit and commit is None and branch is None:
      raise ValueError(f"{url} compares with the default reference: there is no ?reference= in it. Pick a reference in the web app, or name it: runs(project=…, commit=…)")
    server_url = selection.server
  else:
    if side == 'reference':
      raise ValueError("side='reference' needs a web app URL: without one, name the reference's runs: runs(project=…, commit=…)")
    if not project:
      raise ValueError("Give a web app URL, or the project (and commit, batch, filter): runs(project='group/repo', commit='abc123', batch='ci')")
    selected = _Side(project=project, commit=None)
    server_url = (server or default_server()[0]).rstrip('/')
  if commit is not None or branch is not None:
    side_commit, side_branch = commit or None, branch or None
  else:
    side_commit, side_branch = selected.commit, selected.branch
  selected = _Side(
    project=project or selected.project,
    commit=side_commit,
    branch=side_branch,
    batch=batch or selected.batch,
    filter=filter if filter is not None else selected.filter,
  )
  return _side_runs(server_url, selected, token=token, include_deleted=include_deleted, include_hidden=include_hidden, dry_run=dry_run)
