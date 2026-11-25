"""
MLflow tracking stores that log to QA-Board (see __init__.py):

- `QABoardStore`, for `qaboard:`: QA-Board only. MLflow's experiments, runs and logged models live in this process's
  memory, so that MLflow works as usual (get_run, search_runs, metric histories, artifacts of the runs of this
  process); what they log goes to QA-Board runs (recorder.py). What QA-Board lacks warns once (`unsupported`).
- `MirrorStore`, for `qaboard+<uri>`: MLflow's store of <uri> (a tracking server, a folder, a database) does
  everything and stays the source of truth (run ids, get_run, search...); what it is told is also copied to QA-Board,
  never failing because of it (warned once). Runs' artifact URIs are rewritten to `qaboard-artifacts:` so that files
  go to both (artifacts.py).

MLflow builds them through plugin.py, by URI scheme.
"""
import inspect
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any
from collections.abc import Callable
from urllib.parse import quote

from mlflow.entities import Experiment, ExperimentTag, LifecycleStage, Metric, Param, Run, RunData, RunInfo, RunStatus, RunTag, ViewType
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE, INVALID_STATE, NOT_IMPLEMENTED, RESOURCE_ALREADY_EXISTS, RESOURCE_DOES_NOT_EXIST
from mlflow.store.entities.paged_list import PagedList
from mlflow.store.tracking.abstract_store import AbstractStore
from mlflow.utils.search_utils import SearchExperimentsUtils, SearchUtils

from . import ARTIFACTS_SCHEME, MIRROR_PREFIX, unsupported
from . import artifacts
from .recorder import DOCS, RecordedRun, recorder, say_once

DEFAULT_EXPERIMENT_ID = '0'
DEFAULT_EXPERIMENT_NAME = 'Default'


def _batch(name: str | None) -> str | None:
  """MLflow's default experiment is start_run()'s default batch"""
  return None if not name or name == DEFAULT_EXPERIMENT_NAME else name


def _status(status: Any) -> str:
  return status if isinstance(status, str) else RunStatus.to_string(status)


def _safe(what: str, call: Callable[[], Any], mirror: bool) -> Any:
  """What QA-Board is told never fails MLflow code: said once by kind of failure"""
  try:
    return call()
  except MlflowException:
    raise
  except Exception as e:
    where = "MLflow has it, QA-Board doesn't" if mirror else "QA-Board doesn't have it"
    say_once(f"failed:{what}:{type(e).__name__}", f"WARNING: couldn't log {what} to QA-Board: {type(e).__name__}: {e}. {where} (said once).")
    return None


def _not_found(what: str) -> MlflowException:
  return MlflowException(f"{what} not found. With MLFLOW_TRACKING_URI=qaboard:, MLflow's runs and experiments live in the memory of the "
                         f"process that logs them: other processes see the runs in QA-Board's web app, or use mirror mode ({DOCS}).",
                         error_code=RESOURCE_DOES_NOT_EXIST)


REGISTRY = "the model registry (mlflow.register_model, models:/<name>/<version> URIs)"
REGISTRY_HINT = "QA-Board has no model registry: log in mirror mode (MLFLOW_TRACKING_URI=qaboard+<your MLflow URI>) to keep MLflow's"
# The features of MLflow's tracking store QA-Board doesn't have, by method name: (words in the name, feature, hint)
FEATURES = (
  (('trace', 'span', 'assessment', 'issue', 'session'), "MLflow Tracing (mlflow.trace, mlflow.start_span, GenAI autologging)", "traces aren't kept: QA-Board has no trace viewer"),
  (('dataset',), "evaluation datasets (mlflow.genai.datasets)", "not kept"),
  (('scorer', 'scoring', 'label_schema', 'review_queue', 'labeling', 'judge'), "GenAI evaluation (scorers, labeling, review queues)", "not kept: use QA-Board's metrics"),
  (('prompt',), "prompts (mlflow.genai prompt registry)", "not kept"),
  (('model_version', 'registered_model'), REGISTRY, REGISTRY_HINT),
  (('gateway', 'endpoint', 'secret', 'budget', 'guardrail', 'webhook'), "MLflow's AI gateway and webhooks", "not kept"),
  (('mcp', 'skill'), "MLflow's MCP servers and skills registries", "not kept"),
  (('experiment_tag',), "experiment tags", "kept in this process only, not in QA-Board"),
)


def _feature(name: str) -> tuple:
  for words, feature, hint in FEATURES:
    if any(word in name for word in words):
      return feature, hint
  return f"MlflowClient: the store's {name}()", "not supported with MLFLOW_TRACKING_URI=qaboard:"


@dataclass
class _Experiment:
  id: str
  name: str
  tags: dict[str, str] = field(default_factory=dict)
  lifecycle: str = LifecycleStage.ACTIVE
  created: int = field(default_factory=lambda: int(time.time() * 1000))

  def entity(self) -> Experiment:
    return Experiment(self.id, self.name, f"{ARTIFACTS_SCHEME}:/experiments/{self.id}", self.lifecycle,
                      tags=[ExperimentTag(k, v) for k, v in self.tags.items()], creation_time=self.created, last_update_time=self.created)


@dataclass
class _Run:
  id: str
  experiment_id: str
  user_id: str
  name: str
  start_time: int
  status: str = 'RUNNING'
  end_time: int | None = None
  lifecycle: str = LifecycleStage.ACTIVE
  params: dict[str, str] = field(default_factory=dict)
  tags: dict[str, str] = field(default_factory=dict)
  metrics: dict[str, list[Metric]] = field(default_factory=dict)
  outputs: list[Any] = field(default_factory=list)

  def entity(self) -> Run:
    info = RunInfo(self.id, self.experiment_id, self.user_id, self.status, self.start_time, self.end_time, self.lifecycle,
                   artifact_uri=artifacts.uri(self.id), run_name=self.name)
    # MLflow's latest value: the highest step, then the latest time, then the latest logged
    latest = [max(enumerate(history), key=lambda m: (m[1].step, m[1].timestamp, m[0]))[1] for history in self.metrics.values() if history]
    data = RunData(metrics=latest, params=[Param(k, v) for k, v in self.params.items()], tags=[RunTag(k, v) for k, v in self.tags.items()])
    from mlflow.entities import RunInputs
    inputs = RunInputs(dataset_inputs=[])
    try:
      from mlflow.entities import RunOutputs  # MLflow 3
      return Run(info, data, run_inputs=inputs, run_outputs=RunOutputs(model_outputs=list(self.outputs)))
    except (ImportError, TypeError):
      return Run(info, data, run_inputs=inputs)


class _QABoardStore(AbstractStore):
  def __init__(self, store_uri: str | None = None, artifact_uri: str | None = None):
    super().__init__()
    self.store_uri = store_uri
    self._lock = threading.RLock()
    self._experiments: dict[str, _Experiment] = {DEFAULT_EXPERIMENT_ID: _Experiment(DEFAULT_EXPERIMENT_ID, DEFAULT_EXPERIMENT_NAME)}
    self._runs: dict[str, _Run] = {}
    self._models: dict[str, Any] = {}

  # --- experiments: batches ----------------------------------------------------------------------------------------
  def _experiment(self, experiment_id: str) -> _Experiment:
    experiment = self._experiments.get(str(experiment_id))
    if experiment is None:
      raise _not_found(f"Experiment {experiment_id}")
    return experiment

  def search_experiments(self, view_type=ViewType.ACTIVE_ONLY, max_results=None, filter_string=None, order_by=None, page_token=None, **_):
    with self._lock:
      experiments = [e.entity() for e in self._experiments.values() if LifecycleStage.matches_view_type(view_type, e.lifecycle)]
    experiments = SearchExperimentsUtils.sort(SearchExperimentsUtils.filter(experiments, filter_string), order_by)
    page, token = SearchUtils.paginate(experiments, page_token, max_results or 1000)
    return PagedList(page, token)

  def create_experiment(self, name, artifact_location=None, tags=None, **_):
    if not name or not isinstance(name, str):
      raise MlflowException("An experiment's name is a non-empty text", error_code=INVALID_PARAMETER_VALUE)
    with self._lock:
      if any(e.name == name for e in self._experiments.values()):
        raise MlflowException(f"Experiment '{name}' already exists.", error_code=RESOURCE_ALREADY_EXISTS)
      experiment_id = str(len(self._experiments))
      self._experiments[experiment_id] = _Experiment(experiment_id, name, {t.key: t.value for t in tags or []})
      return experiment_id

  def get_experiment(self, experiment_id):
    with self._lock:
      return self._experiment(experiment_id).entity()

  def get_experiment_by_name(self, experiment_name):
    with self._lock:
      for experiment in self._experiments.values():
        if experiment.name == experiment_name:
          return experiment.entity()
    return None

  def delete_experiment(self, experiment_id):
    unsupported.warn("mlflow.delete_experiment", "QA-Board keeps the batch and its runs: delete runs from the web app")
    with self._lock:
      self._experiment(experiment_id).lifecycle = LifecycleStage.DELETED

  def restore_experiment(self, experiment_id):
    with self._lock:
      self._experiment(experiment_id).lifecycle = LifecycleStage.ACTIVE

  def rename_experiment(self, experiment_id, new_name):
    unsupported.warn("MlflowClient.rename_experiment", "the runs logged before stay in the batch of the former name")
    with self._lock:
      self._experiment(experiment_id).name = new_name

  def set_experiment_tag(self, experiment_id, tag):
    unsupported.warn(*_feature('experiment_tag'))
    with self._lock:
      self._experiment(experiment_id).tags[tag.key] = tag.value

  def delete_experiment_tag(self, experiment_id, key):
    with self._lock:
      self._experiment(experiment_id).tags.pop(key, None)

  # --- runs --------------------------------------------------------------------------------------------------------
  def _run(self, run_id: str) -> _Run:
    run = self._runs.get(run_id)
    if run is None:
      raise _not_found(f"Run '{run_id}'")
    return run

  def _active(self, run_id: str) -> _Run:
    run = self._run(run_id)
    if run.lifecycle != LifecycleStage.ACTIVE:
      raise MlflowException(f"The run {run_id} must be in the 'active' state. Current state is {run.lifecycle}.", error_code=INVALID_STATE)
    return run

  def create_run(self, experiment_id, user_id, start_time, tags, run_name=None, **_):
    from mlflow.utils.name_utils import _generate_random_name
    tags = {t.key: t.value for t in tags or []}
    with self._lock:
      experiment = self._experiment(experiment_id or DEFAULT_EXPERIMENT_ID)
      if experiment.lifecycle != LifecycleStage.ACTIVE:
        raise MlflowException(f"Could not create run under non-active experiment with ID {experiment.id}.", error_code=INVALID_STATE)
      named = bool(run_name or tags.get('mlflow.runName'))
      name = run_name or tags.get('mlflow.runName') or _generate_random_name()
      tags['mlflow.runName'] = name
      run_id = uuid.uuid4().hex
      try:
        recorder.create(run_id, experiment=_batch(experiment.name), name=name, named=named, tags=tags)
      except (ValueError, OSError) as e:
        raise MlflowException(f"QA-Board can't start the run: {e}", error_code=INVALID_PARAMETER_VALUE) from e
      artifacts.register(run_id, run_id=run_id)
      run = _Run(run_id, experiment.id, user_id or 'unknown', name, start_time or int(time.time() * 1000), tags=tags)
      self._runs[run_id] = run
      return run.entity()

  def get_run(self, run_id):
    with self._lock:
      return self._run(run_id).entity()

  def update_run_info(self, run_id, run_status, end_time, run_name=None, **_):
    status = _status(run_status)
    with self._lock:
      run = self._active(run_id)
      run.status, run.end_time = status, end_time
      if run_name:
        run.name = run.tags['mlflow.runName'] = run_name
      info = run.entity().info
    recorded = recorder.get(run_id)
    if recorded is not None:
      if status == 'RUNNING':
        recorded.reopen()
        recorded.set_name(run_name)
      elif status in ('FINISHED', 'FAILED', 'KILLED'):
        _safe("the end of the run", lambda: recorded.end(status), mirror=False)
    return info

  def delete_run(self, run_id):
    unsupported.warn("mlflow.delete_run", "QA-Board keeps the run: delete it from the web app")
    with self._lock:
      self._run(run_id).lifecycle = LifecycleStage.DELETED

  def restore_run(self, run_id):
    with self._lock:
      self._run(run_id).lifecycle = LifecycleStage.ACTIVE

  # --- logging -----------------------------------------------------------------------------------------------------
  def log_metric(self, run_id, metric):
    self.log_batch(run_id, [metric], [], [])

  def log_param(self, run_id, param):
    self.log_batch(run_id, [], [param], [])

  def set_tag(self, run_id, tag):
    self.log_batch(run_id, [], [], [tag])

  def delete_tag(self, run_id, key):
    with self._lock:
      run = self._active(run_id)
      if key not in run.tags:
        raise MlflowException(f"No tag with name: {key} in run with id {run_id}", error_code=RESOURCE_DOES_NOT_EXIST)
      del run.tags[key]
    recorded = recorder.get(run_id)
    if recorded is not None:
      recorded.delete_tag(key)

  def log_batch(self, run_id, metrics, params, tags):
    metrics, params, tags = list(metrics or []), list(params or []), list(tags or [])
    with self._lock:
      run = self._active(run_id)
      for param in params:
        # like MLflow's stores: a parameter keeps its value
        if param.key in run.params and run.params[param.key] != str(param.value):
          raise MlflowException(f"Changing param values is not allowed. Param with key='{param.key}' was already logged with value='{run.params[param.key]}' "
                                f"for run ID='{run_id}'. Attempted logging new value '{param.value}'.", error_code=INVALID_PARAMETER_VALUE)
      for param in params:
        run.params[param.key] = str(param.value)
      for tag in tags:
        run.tags[tag.key] = str(tag.value)
        if tag.key == 'mlflow.runName':
          run.name = str(tag.value)
      for metric in metrics:
        run.metrics.setdefault(metric.key, []).append(metric)
    recorded = recorder.get(run_id)
    if recorded is not None:
      _record(recorded, metrics, params, tags, mirror=False)

  # synchronous=False: logged now, in order. It only changes memory and files, which doesn't wait for the network
  def log_batch_async(self, run_id, metrics, params, tags):
    from mlflow.utils.async_logging.run_operations import RunOperations
    self.log_batch(run_id, metrics, params, tags)
    return RunOperations([])

  def log_metric_async(self, run_id, metric):
    return self.log_batch_async(run_id, [metric], [], [])

  def log_param_async(self, run_id, param):
    return self.log_batch_async(run_id, [], [param], [])

  def set_tag_async(self, run_id, tag):
    return self.log_batch_async(run_id, [], [], [tag])

  def get_metric_history(self, run_id, metric_key, max_results=None, page_token=None):
    with self._lock:
      history = list(self._run(run_id).metrics.get(metric_key, []))
    if max_results is None and page_token is None:
      return PagedList(history, None)
    page, token = SearchUtils.paginate(history, page_token, max_results or len(history) or 1)
    return PagedList(page, token)

  def _search_runs(self, experiment_ids, filter_string, run_view_type, max_results, order_by, page_token):
    with self._lock:
      runs = [r.entity() for r in self._runs.values()
              if r.experiment_id in [str(i) for i in experiment_ids] and LifecycleStage.matches_view_type(run_view_type, r.lifecycle)]
    runs = SearchUtils.sort(SearchUtils.filter(runs, filter_string), order_by)
    return SearchUtils.paginate(runs, page_token, max_results)

  def log_inputs(self, run_id, datasets=None, models=None, **_):
    if datasets:
      unsupported.warn("datasets (mlflow.log_input)", "not kept: log the dataset's name and digest as parameters, before the first metric, to make them part of the run's identity")
    with self._lock:
      self._active(run_id)

  def log_outputs(self, run_id, models):
    with self._lock:
      self._active(run_id).outputs.extend(models or [])

  def record_logged_model(self, run_id, mlflow_model):
    """MLflow 2's log_model: the model's files are artifacts; the history tag, like MLflow's own stores"""
    with self._lock:
      run = self._active(run_id)
      history = json.loads(run.tags.get('mlflow.log-model.history', '[]'))
      history.append(mlflow_model.get_tags_dict() if hasattr(mlflow_model, 'get_tags_dict') else mlflow_model.to_dict())
      run.tags['mlflow.log-model.history'] = json.dumps(history)

  # --- MLflow 3's logged models: their files are saved under models/<name> in the QA-Board run's folder ------------
  def create_logged_model(self, experiment_id=DEFAULT_EXPERIMENT_ID, name=None, source_run_id=None, tags=None, params=None, model_type=None, **_):
    from mlflow.entities import LoggedModel, LoggedModelStatus
    from mlflow.utils.name_utils import _generate_random_name
    with self._lock:
      self._experiment(experiment_id)
      name = name or _generate_random_name()
      model_id = f"m-{uuid.uuid4().hex}"
      now = int(time.time() * 1000)
      if source_run_id is None:
        unsupported.warn("logged models without a run (mlflow.initialize_logged_model)", "QA-Board saves a model's files in its run's folder: log models in a run")
      artifacts.register(model_id, run_id=source_run_id, prefix=f"models/{name}")
      model = LoggedModel(experiment_id=str(experiment_id), model_id=model_id, name=name, artifact_location=artifacts.uri(model_id),
                          creation_timestamp=now, last_updated_timestamp=now, model_type=model_type, source_run_id=source_run_id,
                          status=LoggedModelStatus.PENDING, tags=tags, params=params)
      self._models[model_id] = model
      return model

  def _model(self, model_id: str) -> Any:
    model = self._models.get(model_id)
    if model is None:
      raise _not_found(f"Logged model '{model_id}'")
    return model

  def get_logged_model(self, model_id, allow_deleted=False, **_):
    with self._lock:
      return self._model(model_id)

  def finalize_logged_model(self, model_id, status):
    with self._lock:
      model = self._model(model_id)
      model._status = status
      model._last_updated_timestamp = int(time.time() * 1000)
      return model

  def set_logged_model_tags(self, model_id, tags):
    with self._lock:
      model = self._model(model_id)
      model._tags = {**(model.tags or {}), **{t.key: t.value for t in tags}}

  def delete_logged_model_tag(self, model_id, key):
    with self._lock:
      model = self._model(model_id)
      model._tags = {k: v for k, v in (model.tags or {}).items() if k != key}

  def delete_logged_model(self, model_id):
    unsupported.warn("MlflowClient.delete_logged_model", "QA-Board keeps the model's files: delete the run from the web app")
    with self._lock:
      self._models.pop(model_id, None)

  def search_logged_models(self, experiment_ids, filter_string=None, datasets=None, max_results=None, order_by=None, page_token=None, **_):
    with self._lock:
      models = [m for m in self._models.values() if m.experiment_id in [str(i) for i in experiment_ids]]
    try:
      from mlflow.utils.search_utils import SearchLoggedModelsUtils
      models = SearchLoggedModelsUtils.sort(SearchLoggedModelsUtils.filter_logged_models(models, filter_string, datasets), order_by)
    except Exception:
      if filter_string or datasets or order_by:
        unsupported.warn("mlflow.search_logged_models(filter_string=..., order_by=...)", "the filters and order are ignored: all the logged models of this process are returned")
    page, token = SearchUtils.paginate(models, page_token, max_results or 100)
    return PagedList(page, token)


def _record(recorded: RecordedRun, metrics: list[Any], params: list[Any], tags: list[Any], mirror: bool) -> None:
  if params:
    _safe("parameters", lambda: recorded.log_params({p.key: p.value for p in params}), mirror)
  if tags:
    _safe("tags", lambda: recorded.set_tags({t.key: t.value for t in tags}), mirror)
  if metrics:
    # in their order: MLflow's queue of asynchronous logging merges batches
    ordered = sorted(metrics, key=lambda m: (m.step or 0, m.timestamp or 0))
    _safe("metrics", lambda: recorded.log_metrics((m.key, m.value, m.step) for m in ordered), mirror)


def _unimplemented(name: str) -> bool:
  """Whether AbstractStore leaves `name` to the stores: abstract, or raising NotImplementedError"""
  if name in getattr(AbstractStore, '__abstractmethods__', ()):
    return True
  try:
    return 'NotImplementedError' in inspect.getsource(getattr(AbstractStore, name))
  except (OSError, TypeError):
    return False


def _stub(name: str) -> Callable[..., Any]:
  feature, hint = _feature(name)

  def method(self: Any, *args: Any, **kwargs: Any) -> Any:
    unsupported.warn(feature, hint)
    raise MlflowException(f"{feature} isn't supported with MLFLOW_TRACKING_URI=qaboard: {hint}. See {DOCS}", error_code=NOT_IMPLEMENTED)
  method.__name__ = name
  return method


# Every other method of MLflow's store (traces, GenAI evaluation, datasets... and those of future versions of MLflow)
# warns once, and raises like a store without the feature
QABoardStore = type('QABoardStore', (_QABoardStore,), {
  '__doc__': "The tracking store of MLFLOW_TRACKING_URI=qaboard: (see the module's docstring)",
  **{name: _stub(name) for name in dir(AbstractStore)
     if not name.startswith('_') and callable(getattr(AbstractStore, name, None)) and name not in _QABoardStore.__dict__ and _unimplemented(name)},
})


class NoModelRegistry:
  """The model registry of `qaboard:`: every call says QA-Board has none"""
  def __init__(self, store_uri: str | None = None):
    self.store_uri = store_uri

  def __getattr__(self, name: str) -> Any:
    if name.startswith('__'):
      raise AttributeError(name)

    def method(*args: Any, **kwargs: Any) -> Any:
      unsupported.warn(REGISTRY, REGISTRY_HINT)
      raise MlflowException(f"{REGISTRY_HINT} ({DOCS})", error_code=NOT_IMPLEMENTED)
    return method


# --- mirror mode ---------------------------------------------------------------------------------------------------
def inner_uri(uri: str) -> str:
  if not uri.startswith(MIRROR_PREFIX):
    raise MlflowException(f"Not a QA-Board mirror URI: {uri}", error_code=INVALID_PARAMETER_VALUE)
  inner = uri[len(MIRROR_PREFIX):]
  if inner.startswith(('qaboard:', 'qaboard+')):
    raise MlflowException(f"{uri}: mirror mode wraps another MLflow URI, like qaboard+http://mlflow.example:5000", error_code=INVALID_PARAMETER_VALUE)
  return inner


def mirror_store(store_uri: str, artifact_uri: str | None = None) -> 'MirrorStore':
  from mlflow.tracking._tracking_service.utils import _tracking_store_registry
  inner = inner_uri(store_uri)
  delegate = _tracking_store_registry.get_store_builder(inner)(store_uri=inner, artifact_uri=artifact_uri)
  return MirrorStore(delegate, inner)


def mirror_registry(store_uri: str, tracking_uri: str | None = None) -> Any:
  from mlflow.tracking._model_registry import utils
  registry: Any = utils._get_store_registry() if hasattr(utils, '_get_store_registry') else utils._model_registry_store_registry
  inner = inner_uri(store_uri)
  inner_tracking = inner_uri(tracking_uri) if tracking_uri and tracking_uri.startswith(MIRROR_PREFIX) else (tracking_uri or inner)
  builder = registry.get_store_builder(inner)
  try:
    delegate = builder(store_uri=inner, tracking_uri=inner_tracking)
  except TypeError:
    delegate = builder(store_uri=inner)
  return MirrorRegistry(delegate, inner_tracking)


class MirrorRegistry:
  """
  The model registry of the URI after `qaboard+`. A model version's files are at an `mlflow-artifacts:/` URI of the
  tracking server, which MLflow resolves with the tracking URI, qaboard+http...: they are given with the server's.
  """
  def __init__(self, delegate: Any, tracking_uri: str):
    self.__dict__.update(_delegate=delegate, _tracking_uri=tracking_uri)

  @property  # type: ignore[misc]
  def __class__(self) -> Any:
    return type(self._delegate)

  def __getattr__(self, name: str) -> Any:
    return getattr(self._delegate, name)

  def __setattr__(self, name: str, value: Any) -> None:
    setattr(self._delegate, name, value)

  def get_model_version_download_uri(self, name, version):
    uri = self._delegate.get_model_version_download_uri(name, version)
    if isinstance(uri, str) and uri.startswith('mlflow-artifacts:') and self._tracking_uri.startswith(('http://', 'https://')):
      from mlflow.store.artifact.mlflow_artifacts_repo import MlflowArtifactsRepository
      return MlflowArtifactsRepository.resolve_uri(uri, self._tracking_uri)
    return uri


class MirrorStore:
  """
  MLflow's store of the URI after `qaboard+`, which does everything; what it logs is copied to QA-Board. It passes for
  the store it wraps (`isinstance`), and forwards what it doesn't override.
  """
  def __init__(self, delegate: Any, tracking_uri: str):
    self.__dict__['_delegate'] = delegate
    self.__dict__['_tracking_uri'] = tracking_uri

  @property  # type: ignore[misc]
  def __class__(self) -> Any:
    return type(self._delegate)

  def __getattr__(self, name: str) -> Any:
    return getattr(self._delegate, name)

  def __setattr__(self, name: str, value: Any) -> None:
    setattr(self._delegate, name, value)

  def __repr__(self) -> str:
    return f"<QA-Board mirror of {self._delegate!r}>"

  def _url(self, experiment_id: str, run_id: str) -> str | None:
    if self._tracking_uri.startswith(('http://', 'https://')):
      return f"{self._tracking_uri.rstrip('/')}/#/experiments/{quote(str(experiment_id))}/runs/{quote(run_id)}"
    return None

  def _run(self, run: Any) -> Any:
    """The run, its artifacts going to both stores"""
    info = run.info
    original = info.artifact_uri
    if original and not original.startswith(ARTIFACTS_SCHEME):
      artifacts.register(info.run_id, run_id=info.run_id, delegate=original, tracking_uri=self._tracking_uri)
      info._artifact_uri = artifacts.uri(info.run_id)
    return run

  def _model(self, model: Any) -> Any:
    original = getattr(model, 'artifact_location', None)
    if original and not original.startswith(ARTIFACTS_SCHEME):
      artifacts.register(model.model_id, run_id=model.source_run_id, prefix=f"models/{model.name}", delegate=original, tracking_uri=self._tracking_uri)
      model._artifact_location = artifacts.uri(model.model_id)
    return model

  # --- runs --------------------------------------------------------------------------------------------------------
  def create_run(self, experiment_id, user_id, start_time, tags, run_name=None, **kwargs):
    run = self._delegate.create_run(experiment_id=experiment_id, user_id=user_id, start_time=start_time, tags=tags, run_name=run_name, **kwargs)
    given = {t.key: t.value for t in tags or []}

    def create() -> None:
      experiment = self._delegate.get_experiment(run.info.experiment_id)
      recorder.create(run.info.run_id, experiment=_batch(experiment.name if str(run.info.experiment_id) != DEFAULT_EXPERIMENT_ID else None),
                      name=run.info.run_name or '', named=bool(run_name or given.get('mlflow.runName')),
                      tags={**given, **run.data.tags}, mirror=self._url(run.info.experiment_id, run.info.run_id))
    _safe("the run", create, mirror=True)
    return self._run(run)

  def get_run(self, run_id):
    return self._run(self._delegate.get_run(run_id))

  def search_runs(self, *args, **kwargs):
    runs = self._delegate.search_runs(*args, **kwargs)
    for run in runs:
      self._run(run)
    return runs

  def update_run_info(self, run_id, run_status, end_time, run_name=None, **kwargs):
    info = self._delegate.update_run_info(run_id, run_status, end_time, run_name=run_name, **kwargs)
    recorded = recorder.get(run_id)
    if recorded is not None:
      status = _status(run_status)
      if status == 'RUNNING':
        _safe("the run", lambda: (recorded.reopen(), recorded.set_name(run_name)), mirror=True)
      elif status in ('FINISHED', 'FAILED', 'KILLED'):
        _safe("the end of the run", lambda: recorded.end(status), mirror=True)
    if info is not None and getattr(info, 'artifact_uri', None) and not info.artifact_uri.startswith(ARTIFACTS_SCHEME):
      artifacts.register(run_id, run_id=run_id, delegate=info.artifact_uri, tracking_uri=self._tracking_uri)
      info._artifact_uri = artifacts.uri(run_id)
    return info

  # --- logging: the delegate first, it is the source of truth ------------------------------------------------------
  def _copy(self, run_id: str, metrics: Any = (), params: Any = (), tags: Any = ()) -> None:
    recorded = recorder.get(run_id)
    if recorded is not None:
      _record(recorded, list(metrics or []), list(params or []), list(tags or []), mirror=True)

  def log_metric(self, run_id, metric):
    result = self._delegate.log_metric(run_id, metric)
    self._copy(run_id, metrics=[metric])
    return result

  def log_param(self, run_id, param):
    result = self._delegate.log_param(run_id, param)
    self._copy(run_id, params=[param])
    return result

  def set_tag(self, run_id, tag):
    result = self._delegate.set_tag(run_id, tag)
    self._copy(run_id, tags=[tag])
    return result

  def delete_tag(self, run_id, key):
    result = self._delegate.delete_tag(run_id, key)
    recorded = recorder.get(run_id)
    if recorded is not None:
      _safe("a deleted tag", lambda: recorded.delete_tag(key), mirror=True)
    return result

  def log_batch(self, run_id, metrics, params, tags):
    result = self._delegate.log_batch(run_id, metrics=metrics, params=params, tags=tags)
    self._copy(run_id, metrics, params, tags)
    return result

  # synchronous=False: MLflow's queue sends to the delegate; QA-Board's logging doesn't wait on the network anyway
  def log_metric_async(self, run_id, metric):
    operations = self._delegate.log_metric_async(run_id, metric)
    self._copy(run_id, metrics=[metric])
    return operations

  def log_param_async(self, run_id, param):
    operations = self._delegate.log_param_async(run_id, param)
    self._copy(run_id, params=[param])
    return operations

  def set_tag_async(self, run_id, tag):
    operations = self._delegate.set_tag_async(run_id, tag)
    self._copy(run_id, tags=[tag])
    return operations

  def log_batch_async(self, run_id, metrics, params, tags):
    operations = self._delegate.log_batch_async(run_id, metrics=metrics, params=params, tags=tags)
    self._copy(run_id, metrics, params, tags)
    return operations

  def log_inputs(self, run_id, *args, **kwargs):
    result = self._delegate.log_inputs(run_id, *args, **kwargs)
    if (args and args[0]) or kwargs.get('datasets'):
      unsupported.warn("datasets (mlflow.log_input)", "kept in MLflow only: log the dataset's name and digest as parameters, before the first metric, to make them part of the run's identity in QA-Board")
    return result

  # --- logged models (MLflow 3): their files go to both stores too -------------------------------------------------
  def create_logged_model(self, *args, **kwargs):
    return self._model(self._delegate.create_logged_model(*args, **kwargs))

  def get_logged_model(self, *args, **kwargs):
    return self._model(self._delegate.get_logged_model(*args, **kwargs))

  def finalize_logged_model(self, *args, **kwargs):
    return self._model(self._delegate.finalize_logged_model(*args, **kwargs))

  def search_logged_models(self, *args, **kwargs):
    models = self._delegate.search_logged_models(*args, **kwargs)
    for model in models:
      self._model(model)
    return models
