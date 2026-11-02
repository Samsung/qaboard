"""
QA-Board's runs from Python: the runs a web app page shows, as `Run` objects.

    import qaboard as qb
    for run in qb.runs("https://qaboard/my/project/commit/abc123?batch=ci&filter=night"):
        print(run.input, run.metrics["psnr"], run.dir / "output.png")

The URL is the one in the browser: `runs()` reads the project, commit, batch and filter from it and asks the server
for the runs, filtered like the web app does (qaboard/filters.py). `qa runs <url>` does the same from the shell.

`Run` is also what `start_run()` will give to code that creates runs without `qa` as the entrypoint (training loops,
evals): the same object, in a different state. Writing to runs (`run.log`, `run.save_file`) is not available yet:
see the methods' messages.

This module doesn't need a qaboard.yaml: it only talks to the server, found in the URL. It reads the token to send
like the rest of qa (qaboard/credentials.py).
"""
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

from .credentials import resolve_token, refusal, default_server
from .filters import filter_runs, run_params
from .site_config import site_config, as_requests_verify


# (connect, read) timeouts for requests to the server: commits with thousands of runs take a while to serialize
REQUEST_TIMEOUT = (30, 600)
# Page kinds of the web app whose URLs name runs (webapp/src/route_paths.js). Others (history, dashboard...) don't.
COMMIT_ROUTES = ('commit', 'commits')


class ResultsError(Exception):
  """The server could not give the runs: unknown project or commit, refused request, network error..."""


@dataclass(frozen=True)
class Side:
  """One bar of the web app's commit page: a project's commit, one of its batches, maybe filtered."""
  project: str
  commit: Optional[str]          # a commit id (or its start), a branch, a tag; None for the latest with results
  batch: str = 'default'
  filter: Optional[str] = None
  branch: Optional[str] = None   # when the URL is a branch's page: the latest commit with results on it

  def query(self, **extra) -> Dict[str, Any]:
    params: Dict[str, Any] = {'project': self.project, 'batch': self.batch, 'metrics': '{}', **extra}
    if self.branch:
      params['branch'] = self.branch
    return params


@dataclass(frozen=True)
class Selection:
  """What a web app URL shows: the server, the runs compared (`new`), and the reference they are compared to."""
  server: str
  new: Side
  reference: Optional[Side] = None
  url: Optional[str] = None


def _first(query: Dict[str, List[str]], key: str) -> Optional[str]:
  values = query.get(key)
  return values[0] if values else None


def parse_url(url: str, server: Optional[str] = None) -> Selection:
  """
  Reads a web app URL: `https://qaboard/<project>/commit/<commit>?batch=ci&filter=night&reference=<id>&batch_ref=…`.

  The project is everything before `/commit/` (project ids contain slashes). `/<project>/commit` is the latest commit
  with results, `/<project>/commits/<branch>` the latest on that branch. Give `server` when QA-Board is served under a
  path prefix, e.g. `https://tools.example.com/qaboard`: the URL alone can't say where the project's name starts.
  """
  parts = urlsplit(url.strip())
  if not parts.scheme or not parts.netloc:
    raise ValueError(f"Not a QA-Board URL: {url!r}. Copy the address of a commit's page in the web app, like https://qaboard/my/project/commit/abc123?batch=ci")
  path = unquote(parts.path)
  if server:
    prefix = urlsplit(server).path.rstrip('/')
    if prefix and path.startswith(prefix):
      path = path[len(prefix):]
    server = server.rstrip('/')
  else:
    server = f"{parts.scheme}://{parts.netloc}"
  segments = [s for s in path.split('/') if s]
  route_index = next((i for i, s in enumerate(segments) if s in COMMIT_ROUTES), None)
  if route_index is None or route_index == 0:
    raise ValueError(f"{url} is not the page of a commit's runs. Open a commit in the web app (its address has /commit/ or /commits/) and copy the address, or give the project and commit: runs(project='group/repo', commit='abc123', batch='ci')")
  project = '/'.join(segments[:route_index])
  route, rest = segments[route_index], '/'.join(segments[route_index + 1:]) or None
  query = parse_qs(parts.query, keep_blank_values=True)
  commit, branch = (rest, None) if route == 'commit' else (None, rest)
  new = Side(project=project, commit=commit, branch=branch, batch=_first(query, 'batch') or 'default', filter=_first(query, 'filter') or None)
  reference_commit = _first(query, 'reference')
  reference = Side(
    project=_first(query, 'ref_project') or project,
    commit=reference_commit or None,
    batch=_first(query, 'batch_ref') or new.batch,
    filter=_first(query, 'filter_ref') or None,
  ) if (reference_commit or _first(query, 'batch_ref') or _first(query, 'filter_ref')) else None
  return Selection(server=server, new=new, reference=reference, url=url)


def _url_to_dir(url: Optional[str]) -> Optional[Path]:
  """The API gives file locations as `/s<path>`: the path on the shared storage, as the server mounts it."""
  if not url:
    return None
  path = unquote(url)[2:]
  if os.name == 'nt':
    from .compat import linux_to_windows
    path = linux_to_windows(path)
  return Path(path)


class NotYetAvailable(NotImplementedError):
  pass


@dataclass
class Run:
  """
  One run: an input processed with some configurations and parameters, on a commit, in a batch.

  From `runs(url)`, a run is `finished` (maybe `failed`), with its `metrics` and the files in `dir`. From
  `start_run()`, it starts `pending`: the same object, that your code fills in.
  """
  project: str
  commit: Optional[str]
  batch: str
  input: str                                   # the input's path, relative to its database
  database: Optional[str] = None               # where the inputs are
  platform: str = 'linux'
  configurations: List[Any] = field(default_factory=list)
  params: Dict[str, Any] = field(default_factory=dict)      # the tuning parameters (extra_parameters in the API)
  metrics: Dict[str, Any] = field(default_factory=dict)
  id: Optional[int] = None                     # QA-Board's id, None until the server knows the run
  dir: Optional[Path] = None                   # where its files are
  is_pending: bool = True
  is_running: bool = False
  is_failed: bool = False
  deleted: bool = False                        # its files were deleted
  input_metadata: Dict[str, Any] = field(default_factory=dict)
  data: Dict[str, Any] = field(default_factory=dict)       # what else the server knows: who ran it, where...
  created_at: Optional[str] = None
  finished_at: Optional[str] = None
  server: Optional[str] = None

  @classmethod
  def from_api(cls, output: Dict[str, Any], *, project: str, commit: Optional[str], batch: str, server: Optional[str] = None) -> 'Run':
    """A run as the API gives it, an "output" of /api/v1/commit/<id>"""
    data: Dict[str, Any] = output['data'] if isinstance(output.get('data'), dict) else {}
    params: Dict[str, Any] = dict(output.get('extra_parameters') or {})
    if isinstance(data.get('params'), dict): # the effective parameters a run sent, shown over the tuning parameters
      params.update(data['params'])
    return cls(
      project=project,
      commit=commit,
      batch=batch,
      input=str(output.get('test_input_path', '')),
      database=output.get('test_input_database'),
      platform=output.get('platform') or 'linux',
      configurations=list(output.get('configurations') or []),
      params=params,
      metrics=dict(output.get('metrics') or {}),
      id=output.get('id'),
      dir=_url_to_dir(output.get('output_dir_url')),
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
  def new(cls, *, project: str, input: str, batch: str = 'default', commit: Optional[str] = None, database: Optional[str] = None,
          platform: str = 'linux', configurations: Optional[List[Any]] = None, params: Optional[Dict[str, Any]] = None,
          dir: Optional[Path] = None, server: Optional[str] = None) -> 'Run':
    """A run that doesn't exist yet: what `start_run()` creates, before the server knows it."""
    return cls(project=project, commit=commit, batch=batch, input=input, database=database, platform=platform,
               configurations=list(configurations or []), params=dict(params or {}), dir=dir, server=server,
               is_pending=True, is_running=False, is_failed=False)

  @property
  def state(self) -> str:
    """`pending` (not started), `running`, or `finished` (see `is_failed`)"""
    if self.is_running:
      return 'running'
    return 'pending' if self.is_pending else 'finished'

  @property
  def parameters(self) -> Dict[str, Any]:
    """Every parameter, as the web app shows them: the configurations' objects' keys, then the tuning parameters"""
    return run_params(self.configurations, self.params)

  @property
  def input_path(self) -> Optional[Path]:
    """The input's full path, when its database is known"""
    return Path(self.database) / self.input if self.database else None

  @property
  def url(self) -> Optional[str]:
    """The run in the web app"""
    if not (self.server and self.commit):
      return None
    query = urlencode({'batch': self.batch, 'filter': f"id:{self.id}" if self.id is not None else self.input})
    return f"{self.server}/{quote(self.project)}/commit/{self.commit}?{query}"

  def log(self, step: Optional[int] = None, **metrics: Any) -> None:
    """Adds metrics to the run. Not available yet: writing to runs comes with the next step of the SDK."""
    raise NotYetAvailable("run.log() isn't available yet: QA-Board will merge the metrics you log into the run, and remember your script added them. For now, your project's postprocess() can compute metrics: `qa batch --action-on-existing postprocess`.")

  def save_file(self, path: Union[str, Path], content: Union[bytes, str]) -> Path:
    """Adds a file to the run's folder. Not available yet: writing to runs comes with the next step of the SDK."""
    raise NotYetAvailable("run.save_file() isn't available yet: it will write under run.dir without overwriting anything, and refresh the run's manifest.")

  def series(self, key: str) -> List[Any]:
    """The values logged over time for a metric, e.g. a loss. Not available yet."""
    raise NotYetAvailable("run.series() isn't available yet: runs started with start_run() will keep the values logged at each step in their folder.")

  def __repr__(self) -> str:
    where = f" id={self.id}" if self.id is not None else ''
    return f"<Run{where} {self.input} {self.configurations} {self.params if self.params else ''} {self.state}{' failed' if self.is_failed else ''}>".replace('  ', ' ')


class Runs(list):
  """The runs of a selection, in the order the server gives them. `selection` says what they are."""
  def __init__(self, runs: List[Run], selection: Optional[Selection] = None, side: Optional[Side] = None, commit: Optional[str] = None):
    super().__init__(runs)
    self.selection = selection
    self.side = side
    self.commit = commit # the full commit id, resolved by the server

  def __repr__(self) -> str:
    side = f" of {self.side.project}@{(self.commit or self.side.commit or '')[:8]} batch={self.side.batch!r}" if self.side else ''
    return f"<Runs {len(self)}{side}>"


def _request(server: str, path: str, params: Dict[str, Any], token: Optional[str] = None) -> Dict[str, Any]:
  import requests
  if token is None:
    token, _ = resolve_token(server)
  headers = {'Authorization': f"Bearer {token}"} if token else {}
  verify = as_requests_verify(site_config('QABOARD_API_VERIFY'))
  url = f"{server}/api/v1/{path}"
  try:
    r = requests.get(url, params=params, headers=headers, verify=verify, timeout=REQUEST_TIMEOUT)
  except requests.RequestException as e:
    raise ResultsError(f"Could not reach {server}: {e}") from e
  if r.status_code >= 400:
    refused = refusal(r)
    if refused:
      raise ResultsError(f"{refused['error']} ({refused.get('reason')}). Sign in with `qa auth login {server}`, or set QABOARD_TOKEN to a token with the read scope.")
    try:
      message = r.json().get('error') or r.text
    except ValueError:
      message = r.text
    raise ResultsError(f"{server} answered {r.status_code} to {path} ({params}): {message}")
  try:
    return r.json()
  except ValueError as e:
    raise ResultsError(f"Can't understand the answer of {url}: {r.text[:200]}") from e


def _side_runs(server: str, side: Side, *, token: Optional[str], include_deleted: bool, selection: Optional[Selection] = None) -> Runs:
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
  return Runs(runs, selection=selection, side=side, commit=commit.get('id'))


def runs(url: Optional[str] = None, *, project: Optional[str] = None, commit: Optional[str] = None, branch: Optional[str] = None,
         batch: Optional[str] = None, filter: Optional[str] = None, reference: bool = False, server: Optional[str] = None,
         token: Optional[str] = None, include_deleted: bool = False) -> Runs:
  """
  The runs a web app page shows, as `Run` objects.

  Pass the page's address, or name the runs: `runs(project='group/repo', commit='abc123', batch='ci', filter='night')`
  (`commit` can be a branch or a tag; without it, the latest commit with results). Keyword arguments override what
  the URL says. `reference=True` gives the runs of the reference bar (`?reference=&batch_ref=&filter_ref=`) instead.

  `server`: the QA-Board server, when the URL doesn't say (its address, or when it is served under a path prefix).
  Without a URL, the server is the one `qa` uses (QABOARD_URL...). `token`: an API token, else the one `qa` is
  signed in with. Runs whose files were deleted are left out, unless `include_deleted`.
  """
  if url:
    selection = parse_url(url, server=server)
    side = selection.reference if reference else selection.new
    if reference and side is None:
      raise ValueError(f"{url} compares with the default reference: there is no ?reference= in it. Pick a reference in the web app, or name it: runs(project=…, commit=…)")
  else:
    if not project:
      raise ValueError("Give a web app URL, or the project (and commit, batch, filter): runs(project='group/repo', commit='abc123', batch='ci')")
    selection = None
    side = Side(project=project, commit=None, batch='default')
    server = (server or default_server()[0]).rstrip('/')
  assert side is not None
  side = Side(
    project=project or side.project,
    commit=commit if commit is not None else side.commit,
    branch=branch if branch is not None else side.branch,
    batch=batch or side.batch,
    filter=filter if filter is not None else side.filter,
  )
  server_url = selection.server if selection else server
  assert server_url
  return _side_runs(server_url, side, token=token, include_deleted=include_deleted, selection=selection)


def start_run(*, input: str, configurations: Optional[List[Any]] = None, params: Optional[Dict[str, Any]] = None,
              batch: str = 'default', project: Optional[str] = None, **kwargs: Any) -> Run:
  """
  Creates a run from your own code, without `qa` as the entrypoint (training loops, evals): a `Run` in state
  `pending`, that `with start_run(...) as run:` marks running, then finished (failed on an exception).

  Not available yet. It will give the same `Run` as `runs()`: see tests/test_results.py for the contract.
  """
  raise NotYetAvailable("start_run() isn't available yet. Today, runs are created by `qa run` and `qa batch`: see https://samsung.github.io/qaboard/docs/running-your-code")
