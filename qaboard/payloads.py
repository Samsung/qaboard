"""
What `qa` and `qaboard.start_run()` send to QA-Board with results: one definition for both (qaboard/api.py,
qaboard/active_run.py), read by the server's POST /api/v1/output/, /batch/ and /commit/ (backend/api/).

No side effects, and nothing read from the current project: callers give what they know (qaboard/config.py).
"""
import os
from pathlib import Path
from typing import Any
from collections.abc import Mapping


def serialize_path(path: Any) -> str:
  """Paths as the server expects them: linux-style, also from Windows clients"""
  value = path
  if os.name == 'nt':
    from .compat import windows_to_linux_path
    try:
      value = windows_to_linux_path(path)
    except Exception:
      pass
    if issubclass(type(value), Path):
      value = value.as_posix()
  return str(value)


def serialize_paths(data: Any) -> Any:
  """Serialize recursively Path to strings"""
  if issubclass(type(data), Path):
    data = serialize_path(data)
  elif isinstance(data, dict):
    data = {key: serialize_paths(value) for key, value in data.items()}
  elif isinstance(data, list):
    data = [serialize_paths(value) for value in data]
  return data


# Where the client saved results: the server chooses the folder of runs that send it their files (qaboard/upload.py)
CLIENT_FOLDERS = ('output_directory', 'artifacts_commit', 'ci_commit_dir', 'commit_ci_dir', 'outputs_commit', 'batch_dir', 'batch_conf_dir')


def results_payload(fields: Mapping[str, Any], *, is_ci: bool, run_context: Mapping[str, Any], commit_id: str | None,
                    commit: Mapping[str, Any], config: Mapping[str, Any] | None, metrics_file: Mapping[str, Any] | None,
                    uploads_files: bool = False, default_branch: str | None = None) -> dict[str, Any]:
  """
  The body of a request that sends results: `fields` (the run, batch or commit), with where it comes from and what
  the server needs to create its commit, batch and project when it doesn't know them.
  - commit: what we know about the commit, as `commit_*` fields (config.commit_data()). Only the date is required.
  - config, metrics_file: the project's qaboard.yaml and metrics file. None when there is none, e.g. a notebook
    outside a project: the project then keeps the configuration it has.
  - default_branch: the repository's default branch (git.default_branch): the server keeps the first it gets, the
    reference of projects whose qaboard.yaml doesn't set project.reference_branch.
  - uploads_files: the results aren't in a storage the server reads, their files are sent to it ("storage": "upload").
    The folders of this computer mean nothing to the server: they aren't sent.
  """
  if uploads_files:
    fields = {key: value for key, value in fields.items() if key not in CLIENT_FOLDERS}
  payload: dict[str, Any] = {
    'job_type': 'ci' if is_ci else 'local',
    # where it runs, more precisely: older servers ignore it
    'run_context': dict(run_context),
    'commit_sha': commit_id,
    'git_commit_sha': commit_id, # backward compat for now
    # with some light custom serialization for Path objects
    **serialize_paths(dict(fields)),
    # Will help initialize/update the commit/batch in QA-Board.
    # We send it with every object type, even if it's wasteful: it makes init easier
    **serialize_paths(dict(commit)),
  }
  if uploads_files:
    payload['storage'] = 'upload'
  if default_branch:
    payload['project_default_branch'] = default_branch
  if config is not None:
    payload['qaboard_config'] = serialize_paths(_plain(config))
    payload['qaboard_metrics'] = metrics_file
  return payload


def _plain(value: Any) -> Any:
  """A copy with plain dicts and lists: configurations are read-only for us"""
  if isinstance(value, Mapping):
    return {key: _plain(v) for key, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [_plain(v) for v in value]
  return value
