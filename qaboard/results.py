"""
QA-Board's runs from Python: the runs a web app page shows, as `Run` objects.

    import qaboard as qb
    for run in qb.runs("https://qaboard/my/project/commit/abc123?batch=ci&filter=night"):
        print(run.input, run.metrics.get("psnr"), run.output_dir / "output.png")

The URL is the one in the browser: `runs()` reads the project, commit, batch and filter from it like the web app
(webapp/src/selection.js) and asks the server for the runs, filtered like the web app does (qaboard/filters.py).
`qa runs <url>` does the same from the shell.

`Run` is also what runs created without `qa` as the entrypoint (training loops, evals) will be made of, once the SDK
can create and write to runs. Reading is experimental: names may still change.

This module doesn't need a qaboard.yaml: it only talks to the server, found in the URL. It reads the token to send
like the rest of qa (qaboard/credentials.py).
"""
import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

from .credentials import resolve_token, refusal, default_server, same_server, read_hosts, find_login, ENV_TOKENS
from .filters import filter_runs, run_params
from .site_config import site_config, as_requests_verify


# (connect, read) timeouts for requests to the server: commits with thousands of runs take a while to serialize
REQUEST_TIMEOUT = (30, 600)
# Runs of `qa optimize`'s iterations: the web app doesn't show them with the batch's runs
HIDDEN_RUN_TYPES = ('optim_iteration',)


class ResultsError(Exception):
  """The server could not give the runs: unknown project or commit, refused request, network error..."""


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


def _url_to_dir(url: Optional[str]) -> Optional[Path]:
  """The API gives file locations as `/s<path>`: the path on the shared storage, as the server mounts it."""
  if not url:
    return None
  path = unquote(url)[2:]
  if os.name == 'nt':
    from .compat import linux_to_windows
    path = linux_to_windows(path)
  return Path(path)


@dataclass
class Run:
  """
  One run: an input processed with some configurations and parameters, on a commit, in a batch, as the server knows it.

  Experimental: names may change. `qa runs --json` prints these fields (see `to_dict`).
  """
  project: str
  commit: Optional[str]
  batch: str                                   # the batch's label in the web app; data['batch'] is the batch of qaboard.yaml it comes from
  input: str                                   # the input's path, relative to its database
  database: Optional[str] = None               # where the inputs are
  platform: str = 'linux'
  configurations: List[Any] = field(default_factory=list)
  extra_parameters: Dict[str, Any] = field(default_factory=dict)  # the tuning parameters given to the run
  params: Dict[str, Any] = field(default_factory=dict)            # every parameter, as the web app shows them: the configurations' objects, the tuning parameters, and those the run reported
  metrics: Dict[str, Any] = field(default_factory=dict)
  type: str = ''                               # the input type (qaboard.yaml's inputs.types), 'optim_iteration' for qa optimize's iterations
  id: Optional[int] = None                     # QA-Board's id, None until the server knows the run
  output_dir: Optional[Path] = None            # where its files are
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
      configurations=list(output.get('configurations') or []),
      extra_parameters=extra_parameters,
      params=run_params(output.get('configurations'), {**extra_parameters, **reported}),
      metrics=dict(output.get('metrics') or {}),
      type=output.get('output_type') or '',
      id=output.get('id'),
      output_dir=_url_to_dir(output.get('output_dir_url')),
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
           platform: Optional[str] = None, configurations: Optional[List[Any]] = None, extra_parameters: Optional[Dict[str, Any]] = None,
           output_dir: Optional[Path] = None, server: Optional[str] = None) -> 'Run':
    """A run that doesn't exist yet: what creating runs from code will start from, before the server knows it. Private until then."""
    return cls(project=project, commit=commit, batch=batch, input=input, database=database, platform=platform or ('windows' if os.name == 'nt' else 'linux'),
               configurations=list(configurations or []), extra_parameters=dict(extra_parameters or {}),
               params=run_params(configurations, extra_parameters), output_dir=output_dir, server=server,
               is_pending=True, is_running=False, is_failed=False)

  @property
  def state(self) -> str:
    """`pending` (not started), `running`, or `finished` (see `is_failed`)"""
    if self.is_running:
      return 'running'
    return 'pending' if self.is_pending else 'finished'

  @property
  def input_path(self) -> Optional[Path]:
    """The input's full path, when its database is known"""
    return Path(self.database) / self.input if self.database else None

  @property
  def url(self) -> Optional[str]:
    """The run in the web app"""
    if not (self.server and self.commit):
      return None
    # filters are regular expressions, and the text searched ends with the id
    query = urlencode({'batch': self.batch, 'filter': f"id:{self.id}$" if self.id is not None else self.input})
    return f"{self.server}/{quote(self.project)}/commit/{self.commit}?{query}"

  def to_dict(self) -> Dict[str, Any]:
    """The run as JSON-friendly data: what `qa runs --json` prints"""
    d = asdict(self)
    d['output_dir'] = str(self.output_dir) if self.output_dir else None
    d['state'] = self.state
    d['url'] = self.url
    return d

  def __repr__(self) -> str:
    where = f" id={self.id}" if self.id is not None else ''
    return f"<Run{where} {self.input} {self.configurations} {self.extra_parameters if self.extra_parameters else ''} {self.state}{' failed' if self.is_failed else ''}>".replace('  ', ' ')


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


def _request(server: str, path: str, params: Dict[str, Any], token: Optional[str] = None) -> Dict[str, Any]:
  import requests
  token = _token_for(server, token)
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


def _side_runs(server: str, side: _Side, *, token: Optional[str], include_deleted: bool, include_hidden: bool) -> Runs:
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
  return Runs(runs, side=side, commit=commit.get('id'), server=server)


def runs(url: Optional[str] = None, *, project: Optional[str] = None, commit: Optional[str] = None, branch: Optional[str] = None,
         batch: Optional[str] = None, filter: Optional[str] = None, reference: bool = False, server: Optional[str] = None,
         token: Optional[str] = None, include_deleted: bool = False, include_hidden: bool = False) -> Runs:
  """
  The runs a web app page shows, as `Run` objects. Experimental.

  Pass the page's address, or name the runs: `runs(project='group/repo', commit='abc123', batch='ci', filter='night')`
  (`commit` can be a branch or a tag; without it, the latest commit with results, on `branch` if given). Keyword
  arguments override what the URL says: `commit=` or `branch=` replaces the URL's. `reference=True` gives the runs of
  the reference bar (`?reference=&batch_ref=&filter_ref=`) instead.

  `server`: the QA-Board server, when the URL doesn't say (its address, or when it is served under a path prefix).
  Without a URL, the server is the one `qa` uses (QABOARD_URL...). `token`: an API token, else the one `qa` is
  signed in with. Left out unless asked: runs whose files were deleted (`include_deleted`), and runs the web app
  doesn't list with the batch, like `qa optimize`'s iterations (`include_hidden`).
  """
  if url:
    selection = parse_url(url, server=server)
    side = selection.reference if reference else selection.new
    if reference and not side.commit:
      raise ValueError(f"{url} compares with the default reference: there is no ?reference= in it. Pick a reference in the web app, or name it: runs(project=…, commit=…)")
    server_url = selection.server
  else:
    if not project:
      raise ValueError("Give a web app URL, or the project (and commit, batch, filter): runs(project='group/repo', commit='abc123', batch='ci')")
    side = _Side(project=project, commit=None)
    server_url = (server or default_server()[0]).rstrip('/')
  if commit is not None or branch is not None:
    side_commit, side_branch = commit or None, branch or None
  else:
    side_commit, side_branch = side.commit, side.branch
  side = _Side(
    project=project or side.project,
    commit=side_commit,
    branch=side_branch,
    batch=batch or side.batch,
    filter=filter if filter is not None else side.filter,
  )
  return _side_runs(server_url, side, token=token, include_deleted=include_deleted, include_hidden=include_hidden)
