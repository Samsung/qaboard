"""
The artifact repository of `qaboard-artifacts:/<key>/<path>`, the artifact URI of the runs (and MLflow 3's logged
models) of our stores: <key> is a run id or a logged model id, registered by store.py with where its files go.

- QA-Board only (`qaboard:`): files are saved in the QA-Board run's folder (`ActiveRun.log_artifact`), a logged
  model's under models/<name>. They are read back from there: the runs of this process only.
- Mirror mode: MLflow's artifact repository of the run's real artifact URI does everything, and the files it is
  sent are also copied to the QA-Board run, when this process logs it.
"""
import os
import posixpath
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from . import ARTIFACTS_SCHEME, unsupported
from .recorder import DOCS, QABOARD_FILES, recorder, say_once


@dataclass(frozen=True)
class Location:
  # the MLflow run whose QA-Board run gets the files, and where in its folder
  run_id: Optional[str]
  prefix: str = ''
  # mirror mode: the real artifact URI, and the tracking URI that resolves it
  delegate: Optional[str] = None
  tracking_uri: Optional[str] = None


_locations: Dict[str, Location] = {}
_lock = threading.Lock()


def uri(key: str) -> str:
  return f"{ARTIFACTS_SCHEME}:/{key}"


def register(key: str, *, run_id: Optional[str], prefix: str = '', delegate: Optional[str] = None, tracking_uri: Optional[str] = None) -> None:
  with _lock:
    _locations[key] = Location(run_id, prefix, delegate, tracking_uri)


def parse(artifact_uri: str) -> Tuple[str, str]:
  """(key, path under it)"""
  path = urlparse(artifact_uri).path.strip('/')
  key, _, rest = path.partition('/')
  return key, rest


def _join(*parts: Optional[str]) -> str:
  return posixpath.join(*[p.strip('/') for p in parts if p and p.strip('/')]) if any(p and p.strip('/') for p in parts) else ''


def repository(artifact_uri: str, *args: Any, **kwargs: Any) -> Any:
  key, path = parse(artifact_uri)
  with _lock:
    location = _locations.get(key)
  if location is not None and location.delegate:
    return MirrorArtifactRepository(artifact_uri, location, path)
  return QABoardArtifactRepository(artifact_uri, *args, **kwargs)


def _copy(location: Location, local: str, relative: str) -> None:
  """Copies files MLflow logs to the QA-Board run of this process, if there is one"""
  recorded = recorder.get(location.run_id) if location.run_id else None
  if recorded is not None and not recorded.skip:
    recorded.save_artifact(local, relative)


def _artifact_repository_class() -> Any:
  from mlflow.store.artifact.artifact_repo import ArtifactRepository
  return ArtifactRepository


class QABoardArtifactRepository(_artifact_repository_class()):  # type: ignore[misc]
  """The files of the runs of `qaboard:`, in the folders of their QA-Board runs"""
  def __init__(self, artifact_uri: str, *args: Any, **kwargs: Any):
    super().__init__(artifact_uri, *args, **kwargs)
    self.key, self.path = parse(artifact_uri)

  def _location(self) -> Location:
    with _lock:
      location = _locations.get(self.key)
    if location is None or not location.run_id or recorder.get(location.run_id) is None:
      from mlflow.exceptions import MlflowException
      from mlflow.protos.databricks_pb2 import RESOURCE_DOES_NOT_EXIST
      raise MlflowException(f"{self.artifact_uri}: with MLFLOW_TRACKING_URI=qaboard:, MLflow reads the files of the runs of this process only. "
                            f"Find the run's files in QA-Board's web app, or use mirror mode ({DOCS}).", error_code=RESOURCE_DOES_NOT_EXIST)
    return location

  def _relative(self, *parts: Optional[str]) -> str:
    return _join(self._location().prefix, self.path, *parts)

  def _folder(self) -> Optional[Path]:
    location = self._location()
    recorded = recorder.get(location.run_id) if location.run_id else None
    return recorded.output_dir(start=False) if recorded is not None else None

  def log_artifact(self, local_file, artifact_path=None):
    _copy(self._location(), local_file, self._relative(artifact_path, os.path.basename(local_file)))

  def log_artifacts(self, local_dir, artifact_path=None):
    _copy(self._location(), local_dir, self._relative(artifact_path))

  def list_artifacts(self, path=None):
    from mlflow.entities import FileInfo
    folder = self._folder()
    if folder is None:
      return []
    relative = self._relative(path)
    directory = folder / relative if relative else folder
    if not directory.is_dir():
      return []
    infos = []
    for entry in sorted(directory.iterdir()):
      # QA-Board's own files aren't the run's artifacts
      if entry.name.startswith('.') or (not relative and QABOARD_FILES.fullmatch(entry.name)):
        continue
      name = _join(path, entry.name)
      infos.append(FileInfo(name, entry.is_dir(), None if entry.is_dir() else entry.stat().st_size))
    return infos

  def _download_file(self, remote_file_path, local_path):
    folder = self._folder()
    if folder is None:
      raise FileNotFoundError(remote_file_path)
    shutil.copyfile(folder / self._relative(remote_file_path), local_path)

  def delete_artifacts(self, artifact_path=None):
    unsupported.warn("deleting artifacts (MlflowClient.delete_artifacts)", "QA-Board keeps the run's files: delete the run from the web app")


class MirrorArtifactRepository:
  """Mirror mode: MLflow's repository of the real artifact URI, and a copy of what it is sent in the QA-Board run"""
  def __init__(self, artifact_uri: str, location: Location, path: str):
    from mlflow.store.artifact.artifact_repository_registry import get_artifact_repository
    assert location.delegate is not None
    delegate_uri = location.delegate.rstrip('/') + (f"/{path}" if path else '')
    try:
      delegate = get_artifact_repository(delegate_uri, tracking_uri=location.tracking_uri)
    except TypeError:  # MLflow 2: mlflow-artifacts:/ URIs resolve with the tracking URI, which says qaboard+...
      if delegate_uri.startswith('mlflow-artifacts:'):
        from mlflow.store.artifact.mlflow_artifacts_repo import MlflowArtifactsRepository
        delegate_uri = MlflowArtifactsRepository.resolve_uri(delegate_uri, location.tracking_uri)
      delegate = get_artifact_repository(delegate_uri)
    self.__dict__.update(_delegate=delegate, _location=location, _path=path, artifact_uri=artifact_uri)

  @property  # type: ignore[misc]
  def __class__(self) -> Any:
    return type(self._delegate)

  def __getattr__(self, name: str) -> Any:
    return getattr(self._delegate, name)

  def __repr__(self) -> str:
    return f"<QA-Board mirror of {self._delegate!r}>"

  def _also(self, local: str, relative: str) -> None:
    try:
      _copy(self._location, local, _join(self._location.prefix, self._path, relative))
    except Exception as e:
      say_once(f"artifacts:{type(e).__name__}", f"WARNING: couldn't copy MLflow artifacts to QA-Board: {type(e).__name__}: {e}. MLflow has them (said once).")

  def log_artifact(self, local_file, artifact_path=None):
    result = self._delegate.log_artifact(local_file, artifact_path)
    self._also(local_file, _join(artifact_path, os.path.basename(local_file)))
    return result

  def log_artifacts(self, local_dir, artifact_path=None):
    result = self._delegate.log_artifacts(local_dir, artifact_path)
    self._also(local_dir, _join(artifact_path))
    return result

  def _log_artifact_async(self, filename, artifact_path=None, artifact=None):
    """mlflow.log_image(..., synchronous=False): copied now, sent to MLflow by its queue"""
    operations = self._delegate._log_artifact_async(filename, artifact_path, artifact)
    if artifact is not None and hasattr(artifact, 'save'):
      with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, os.path.basename(filename))
        artifact.save(local)
        self._also(local, _join(artifact_path, os.path.basename(filename)))
    return operations
