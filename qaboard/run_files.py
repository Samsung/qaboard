"""
A run's files, from the server, for runs whose folder isn't mounted here (they sent their files over HTTP, or are
in a storage this machine doesn't see). Fetched once per run and attempt into a local cache:

    <cache>/manifests/<key>/          a run's manifests, for `qa check-bit-accuracy` (qaboard/bit_accuracy.py)

The cache is under $XDG_CACHE_HOME/qaboard, else ~/.cache/qaboard. `<key>` names a run's attempt: the server, the
run's folder, id and when it finished, so a run done again is fetched again. Nothing is removed from it.

Next (docs/design/ingest-upload-sdk.md §3 item 1): `qaboard.local_path("qaboard://<run>/...")`, a run's file as a
local path, downloaded here once, keyed by its manifest's hash.
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import quote

from .http_client import ResultsError, RETRY_DELAYS, download

# Runs' manifests: the hashes of their files (qaboard/utils.py save_outputs_manifest)
MANIFESTS = ('manifest.outputs.json', 'manifest.inputs.json')
# In a folder of fetched manifests, once they all are there: what run they are of
FETCHED_MARKER = '.qaboard-fetched-manifests'
# (connect, read) timeouts: manifests are small
MANIFEST_TIMEOUT = (10.0, 120.0)


def cache_root() -> Path:
  return Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'qaboard'


def attempt_key(server: str, run: Dict[str, Any]) -> str:
  """What names a run's attempt in the cache: a run done again has another `finished_at`"""
  return hashlib.sha256(json.dumps([server, run.get('output_dir_url'), run.get('finished_at'), run.get('id')]).encode()).hexdigest()[:32]


def fetch_file(server: str, run: Dict[str, Any], name: str, target: Path, token: Optional[str] = None,
               timeout=MANIFEST_TIMEOUT) -> bool:
  """
  Saves the run's file `name` (a path in its folder, with "/") in `target`, whole or not at all.
  Returns False when the server doesn't have it (404). Raises ResultsError.
  """
  url = run.get('output_dir_url')
  if not url:
    raise ValueError(f"The server didn't say where the files of run {run.get('id')} are")
  target.parent.mkdir(parents=True, exist_ok=True)
  fd, partial = tempfile.mkstemp(prefix=f".{target.name}.", suffix='.tmp', dir=target.parent)
  os.close(fd)
  try:
    download(server, f"{url.rstrip('/')}/{quote(name)}", Path(partial), token=token, timeout=timeout, retries=RETRY_DELAYS)
    os.replace(partial, target)
  except ResultsError as e:
    if e.status == 404:
      return False
    raise
  finally:
    if os.path.exists(partial):
      os.remove(partial)
  return True


def _warn(message: str) -> None:
  from click import secho
  secho(f"WARNING: {message}", fg='yellow', err=True)


def fetched_manifests(run: Dict[str, Any], server: Optional[str], token: Optional[str] = None,
                      warn: Callable[[str], None] = _warn) -> Optional[Path]:
  """
  A folder with the manifests of a run from QA-Board (as the API gives it, with `output_dir_url`), None if it has
  none or they can't be fetched (we `warn` why). A finished run's are fetched once: they don't change.
  """
  if not run.get('output_dir_url') or not server:
    return None
  folder = cache_root() / 'manifests' / attempt_key(server, run)
  if (folder / FETCHED_MARKER).exists() and not run.get('is_pending'):
    return folder
  found = False
  for name in MANIFESTS:
    try:
      fetched = fetch_file(server, run, name, folder / name, token=token)
    except ResultsError as e:
      warn(f"could not fetch {name} of the reference run: {e}")
      return None
    if fetched:
      found = True
    else:
      # a run done again may not have it anymore
      (folder / name).unlink(missing_ok=True)
  if not found:
    return None
  (folder / FETCHED_MARKER).write_text(str(run['output_dir_url']))
  return folder
