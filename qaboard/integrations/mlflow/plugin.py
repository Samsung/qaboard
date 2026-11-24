"""
What pyproject.toml's entry points name: MLflow imports this module, and only it, whenever MLflow is imported, so it
imports nothing. MLflow calls these functions with the URI when code uses one of our schemes.
"""
from typing import Any


def tracking_store(store_uri: str, artifact_uri: str | None = None, **_: Any) -> Any:
  """`qaboard:`, QA-Board only"""
  from .store import QABoardStore
  return QABoardStore(store_uri, artifact_uri)


def mirror_tracking_store(store_uri: str, artifact_uri: str | None = None, **_: Any) -> Any:
  """`qaboard+http://...`, `qaboard+file:...`, `qaboard+sqlite:...`: MLflow's store of the rest of the URI, copied to QA-Board"""
  from .store import mirror_store
  return mirror_store(store_uri, artifact_uri)


def registry_store(store_uri: str, tracking_uri: str | None = None, **_: Any) -> Any:
  """The model registry of `qaboard:` (MLflow uses the tracking URI by default): QA-Board doesn't have one"""
  from .store import NoModelRegistry
  return NoModelRegistry(store_uri)


def mirror_registry_store(store_uri: str, tracking_uri: str | None = None, **_: Any) -> Any:
  """The model registry of `qaboard+<uri>`: the one of <uri>"""
  from .store import mirror_registry
  return mirror_registry(store_uri, tracking_uri)


def artifact_repository(artifact_uri: str, *args: Any, **kwargs: Any) -> Any:
  """`qaboard-artifacts:/<run or logged model id>/<path>`"""
  from .artifacts import repository
  return repository(artifact_uri, *args, **kwargs)
