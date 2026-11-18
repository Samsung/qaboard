"""
A commit's artifacts through the server, for projects without a storage shared with it (`storage: upload`, or no
`storage`): what runs QA-Board starts itself (tuning, runs done again) need, like qaboard.yaml, the batch files and
the binaries the CI built.

- `qa save-artifacts` sends them (`send`): each file once, with its SHA-256, then the manifests that list them.
  Files the server already has (same path, same SHA-256) aren't sent again. The server saves them in a folder of the
  commit (backend/uploads.py) and runs `qa batch` there when it can read it.
- Pods and machines that can't read that folder fetch them (`fetch`, `qa fetch-artifacts`): once per cache, in a
  folder named by the hash of the files' list. A second fetch of the same artifacts reads nothing but that list.

    <cache>/<hash>/                   the repository's files, as the CI saved them
    <cache>/<hash>/.qaboard-artifacts.json  where they come from: {server, project, commit, hash, subproject}

The cache is $QABOARD_ARTIFACTS_CACHE, else ~/.cache/qaboard/artifacts: point it to a folder the node's pods share
(a hostPath) to fetch once per node. Nothing is removed from it.

Server side: backend/backend/api/commit_artifacts.py. Design: docs/design/ingest-upload-sdk.md (§3, item 2).
"""
import hashlib
import json
import os
import re
import shutil
import tempfile
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

import click

from .results import ResultsError, _request, _token_for
from .site_config import site_config, as_requests_verify

# Next to the files of fetched artifacts: where they come from
MARKER = '.qaboard-artifacts.json'
# How many files are sent or downloaded at once
WORKERS = 4
# (connect, read) timeouts, and how long we wait before trying a request again
TIMEOUT = (10.0, 600.0)
RETRY_DELAYS = (1.0, 4.0)
CHUNK = 1024 * 1024


class ArtifactsError(Exception):
  """The artifacts couldn't be sent or fetched: the message says why, and what to do"""


def sha256_of(file: Path) -> str:
  digest = hashlib.sha256()
  with open(file, 'rb') as f:
    for chunk in iter(lambda: f.read(CHUNK), b''):
      digest.update(chunk)
  return digest.hexdigest()


def bundle_hash(files: Dict[str, Dict[str, Any]]) -> str:
  """The hash of a commit's artifacts, as the server computes it (backend/api/commit_artifacts.py): their paths, SHA-256 and modes"""
  canonical = json.dumps({path: [info["sha256"], bool(info.get("executable"))] for path, info in sorted(files.items())}, separators=(',', ':'))
  return hashlib.sha256(canonical.encode()).hexdigest()


def is_executable(file: Path) -> bool:
  return bool(os.stat(file).st_mode & 0o111)


def cache_root() -> Path:
  configured = os.environ.get('QABOARD_ARTIFACTS_CACHE')
  if configured:
    return Path(configured).expanduser()
  base = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
  return Path(base) / 'qaboard' / 'artifacts'


def _commit_path(commit: str, *rest: str) -> str:
  return '/'.join([f"commit/{quote(commit, safe='')}/artifacts", *rest])


def _retried(request: Callable[[], Any]) -> Any:
  """A request, tried again when the server or the network had a problem"""
  for delay in (*RETRY_DELAYS, None):
    try:
      return request()
    except ResultsError as e:
      if not e.is_transient or delay is None:
        raise
      time.sleep(delay)


class ServerTooOld(ArtifactsError):
  """The server doesn't take artifacts over HTTP: it is older than this `qa`"""


DOCS = "https://samsung.github.io/qaboard/docs"


def explain(error: ResultsError, server: str, what: str = '', size: Optional[int] = None) -> str:
  """What went wrong with a request about artifacts, for people: the server's own words when it said why"""
  body = error.body if isinstance(error.body, dict) else {}
  if error.status is None:
    # the network: the cause, without the HTTP library's internals
    cause = re.search(r"\[Errno -?\d+\] ([^\"')]+)|(Read timed out|timed out)", str(error))
    reason = f" ({(cause.group(1) or cause.group(2)).strip().lower()})" if cause else ""
    return f"Could not reach QA-Board at {server}{reason}: check QABOARD_URL, and that the server runs."
  if error.status == 413:
    megabytes = f" ({size / 1024**2:.0f} MB)" if size else ""
    return (f"{what}{megabytes} is larger than QA-Board accepts. Leave it out of `artifacts` in qaboard.yaml, or ask "
            f"its administrators to raise the limit: {DOCS}/backend-admin/uploads#limits")
  if body.get('error'):
    return str(body['error'])
  if error.status is not None and not error.reason and error.status not in (401, 403):
    # e.g. a proxy's HTML page
    return f"QA-Board at {server} answered {error.status}, not as its API does: check QABOARD_URL."
  return str(error)


def listing(server: str, project: str, commit: str, token: Optional[str] = None) -> Optional[Dict[str, Any]]:
  """
  What the server has of the commit's artifacts ({"files", "hash", "url", "subproject"}), None if it has none.
  Raises ServerTooOld, or ArtifactsError when the server can't be asked.
  """
  try:
    answer = _retried(lambda: _request(server, _commit_path(commit), params={'project': project}, token=token, timeout=TIMEOUT))
  except ResultsError as e:
    reason = (e.body or {}).get('reason') if isinstance(e.body, dict) else None
    if e.status == 404 and reason in ('not_uploaded', 'deleted', 'unknown_commit'):
      return None
    if e.status == 404 and not reason and not e.reason and isinstance(e.body, dict):
      # older servers answer with the commit's results (GET /commit/<id>), here a commit they don't know
      raise ServerTooOld("This QA-Board server doesn't take artifacts over HTTP yet: upgrade it.") from e
    raise ArtifactsError(explain(e, server)) from e
  if 'files' not in answer:
    raise ServerTooOld("This QA-Board server doesn't take artifacts over HTTP yet: upgrade it.")
  return answer


# --- sending -----------------------------------------------------------------------------------------------------
def send(server: str, project: str, commit: str, groups: Dict[str, Tuple[Path, List[str]]], known: Optional[Dict[str, Any]],
         token: Optional[str] = None) -> Dict[str, int]:
  """
  Sends a commit's artifacts. `groups`: {group: (manifest path in the repository, [file paths in the repository])},
  paths relative to the current directory, the repository's root as `qa save-artifacts` sees it. `known`: what the
  server has (`listing`). Each file the server doesn't have, once, then the groups' manifests
  ({path: {"sha256", "st_size", "executable"}}), so that manifests only list files the server has.
  The commit must exist on the server. Returns {"sent", "skipped", "bytes"} (files, not manifests). Raises ArtifactsError.
  """
  has = {path: info['sha256'] for path, info in ((known or {}).get('files') or {}).items()}

  def put(path: str, content: Callable[[], Any], sha256: str, size: int) -> None:
    def request():
      body = content()
      try:
        return _request(server, _commit_path(commit, 'files', quote(path)), params={'project': project}, token=token, method='PUT',
                        data=body, headers={'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha256}, timeout=TIMEOUT)
      finally:
        if hasattr(body, 'close'):
          body.close()
    try:
      _retried(request)
    except ResultsError as e:
      raise ArtifactsError(f"QA-Board refused {path}: {explain(e, server, path, size)}") from e

  # the server doesn't keep modes: manifests say which files are programs, so that fetched copies run
  files: Dict[str, Dict[str, Any]] = {}
  for _, paths in groups.values():
    for path in paths:
      if path not in files:
        files[path] = {"sha256": sha256_of(Path(path)), "st_size": Path(path).stat().st_size, "executable": is_executable(Path(path))}
  missing = [(path, info) for path, info in files.items() if has.get(path) != info['sha256']]
  if missing:
    with ThreadPoolExecutor(max_workers=min(WORKERS, len(missing)), thread_name_prefix='qaboard-artifacts') as pool:
      list(pool.map(lambda item: put(item[0], lambda: open(item[0], 'rb'), item[1]['sha256'], item[1]['st_size']), missing))
  for manifest_path, paths in groups.values():
    # what earlier calls listed stays listed, like `qa save-artifacts` in a shared storage: manifests only grow
    previous = _previous_manifest(server, known, manifest_path, token)
    content = json.dumps({**previous, **{path: files[path] for path in paths}}, indent=1, sort_keys=True).encode()
    sha256 = hashlib.sha256(content).hexdigest()
    if has.get(manifest_path.as_posix()) != sha256:
      put(manifest_path.as_posix(), lambda: content, sha256, len(content))
  return {"sent": len(missing), "skipped": len(files) - len(missing), "bytes": sum(info['st_size'] for _, info in missing)}


def _previous_manifest(server: str, known: Optional[Dict[str, Any]], manifest_path: Path, token: Optional[str]) -> Dict[str, Any]:
  if not known or manifest_path.as_posix() not in (known.get('files') or {}):
    return {}
  try:
    content = _download_bytes(server, f"{known['url']}/{quote(manifest_path.as_posix())}", token)
    previous = json.loads(content)
    return previous if isinstance(previous, dict) else {}
  except (ArtifactsError, ValueError):
    return {}


# --- fetching ----------------------------------------------------------------------------------------------------
def fetch(server: str, project: str, commit: str, token: Optional[str] = None, cache: Optional[Path] = None,
          echo: Callable[[str], None] = lambda message: None) -> Path:
  """
  The folder of a commit's artifacts, fetched into the cache if they aren't there yet: the repository's root.
  The project's folder is under it, at the `subproject` in its marker. Raises ArtifactsError.
  """
  known = listing(server, project, commit, token=token)
  if not known:
    raise ArtifactsError(f"QA-Board has no artifacts for the commit {commit[:8]} of {project}: run `qa save-artifacts` on it (the CI usually does).")
  files: Dict[str, Dict[str, Any]] = known['files']
  bundle = bundle_hash(files)
  if bundle != known.get('hash'):
    raise ArtifactsError("The list of artifacts QA-Board sent doesn't match its hash: try again.")
  cache = Path(cache) if cache is not None else cache_root()
  target = cache / bundle[:32]
  if (target / MARKER).is_file():
    return target
  for path in files:
    if not _is_relative_path(path):
      raise ArtifactsError(f"QA-Board listed an artifact outside of the commit's folder: {path!r}")
  cache.mkdir(parents=True, exist_ok=True)
  # next to where they go, so that renaming the folder is atomic. Pods fetching at once each download, one keeps its copy
  staging = Path(tempfile.mkdtemp(prefix=f".{bundle[:32]}.", dir=cache))
  try:
    total = sum(info['size'] for info in files.values())
    echo(f"Fetching the artifacts of {commit[:8]} from QA-Board: {len(files)} files, {total / 1024**2:.1f} MB")
    with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix='qaboard-artifacts') as pool:
      list(pool.map(lambda item: _download(server, known['url'], item[0], item[1], staging, token), files.items()))
    marker = {"server": server, "project": project, "commit": commit, "hash": bundle, "subproject": known.get('subproject') or ''}
    (staging / MARKER).write_text(json.dumps(marker, indent=1))
    os.chmod(staging, 0o755)  # mkdtemp's is 0o700: other users of a shared cache read it too
    try:
      os.rename(staging, target)
    except OSError:
      if not (target / MARKER).is_file():
        raise
  finally:
    shutil.rmtree(staging, ignore_errors=True)
  return target


def _is_relative_path(path: str) -> bool:
  parts = path.split('/')
  return bool(path) and '\\' not in path and '\0' not in path and not any(part in ('', '.', '..') for part in parts)


def _download(server: str, url: str, path: str, info: Dict[str, Any], folder: Path, token: Optional[str]) -> None:
  file = folder.joinpath(*path.split('/'))
  file.parent.mkdir(parents=True, exist_ok=True)
  import requests
  headers = {'Authorization': f"Bearer {t}"} if (t := _token_for(server, token)) else {}
  address = f"{server}{url}/{quote(path)}"
  for delay in (*RETRY_DELAYS, None):
    try:
      with requests.get(address, headers=headers, stream=True, timeout=TIMEOUT, verify=as_requests_verify(site_config('QABOARD_API_VERIFY'))) as r:
        if r.status_code >= 400:
          if r.status_code < 500 and r.status_code not in (408, 429) or delay is None:
            raise ArtifactsError(f"Could not download {path} ({address}): {r.status_code} {r.text[:200]}")
        else:
          digest = hashlib.sha256()
          with open(file, 'wb') as f:
            for chunk in r.iter_content(CHUNK):
              f.write(chunk)
              digest.update(chunk)
          if digest.hexdigest() == info['sha256']:
            os.chmod(file, 0o755 if info.get('executable') else 0o644)
            return
          if delay is None:
            raise ArtifactsError(f"{path} doesn't have the SHA-256 QA-Board listed: it was replaced while we fetched it? Try again.")
    except requests.RequestException as e:
      if delay is None:
        raise ArtifactsError(f"Could not download {path} ({address}): {e}") from e
    time.sleep(delay)


def _download_bytes(server: str, url: str, token: Optional[str]) -> bytes:
  import requests
  headers = {'Authorization': f"Bearer {t}"} if (t := _token_for(server, token)) else {}
  try:
    r = requests.get(f"{server}{url}", headers=headers, timeout=TIMEOUT, verify=as_requests_verify(site_config('QABOARD_API_VERIFY')))
  except requests.RequestException as e:
    raise ArtifactsError(str(e)) from e
  if r.status_code >= 400:
    raise ArtifactsError(f"{r.status_code} {r.text[:200]}")
  return r.content


def read_marker(folder: Path) -> Optional[Dict[str, Any]]:
  """Where fetched artifacts come from, if `folder` is in a fetched copy: (the marker, with its `root`)"""
  for directory in (folder, *folder.parents):
    marker = directory / MARKER
    if marker.is_file():
      try:
        data = json.loads(marker.read_text())
      except (OSError, ValueError):
        return None
      return {**data, "root": str(directory)} if isinstance(data, dict) else None
  return None



@click.command(name='fetch-artifacts')
@click.option('--project', required=True, help="The project's id on QA-Board, like group/repo/subproject.")
@click.option('--commit', required=True, help="The commit's full id.")
@click.option('--root', 'repository_root', is_flag=True, help="Print the folder of the repository, not the project's.")
def fetch_artifacts(project, commit, repository_root):
  """
  Downloads a commit's artifacts from QA-Board, once per cache ($QABOARD_ARTIFACTS_CACHE), and prints their folder.
  For pods and machines without the storage the server keeps them in: cd "$(qa fetch-artifacts --project P --commit C)"
  """
  from .api import qaboard_url
  if not re.fullmatch(r'[0-9a-f]{40}', commit):
    click.secho("ERROR: --commit takes the commit's full id, 40 characters: `git rev-parse HEAD`.", fg='red', err=True)
    sys.exit(1)
  if not project.strip('/ '):
    click.secho("ERROR: --project takes the project's id on QA-Board, like group/repo.", fg='red', err=True)
    sys.exit(1)
  try:
    root = fetch(qaboard_url, project, commit, echo=lambda message: click.echo(message, err=True))
  except (ArtifactsError, OSError) as e:
    click.secho(f"ERROR: {e}", fg='red', err=True)
    sys.exit(1)
  marker = read_marker(root) or {}
  click.echo(str(root if repository_root else root / (marker.get('subproject') or '')))
