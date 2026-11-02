"""
Tests for backend/api/batch.py: what the CLI sends when it starts a batch of runs.
"""
import sys
import types
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


HEXSHA = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def batch_api(monkeypatch):
  """Loads the real backend/api/batch.py"""
  models = sys.modules['backend.models']
  monkeypatch.setattr(models, "CiCommit", MagicMock())
  export_to_folder = types.ModuleType('backend.api.export_to_folder')
  export_to_folder.filter_outputs = MagicMock()
  monkeypatch.setitem(sys.modules, 'backend.api.export_to_folder', export_to_folder)
  path = Path(__file__).parent.parent / "backend" / "api" / "batch.py"
  spec = importlib.util.spec_from_file_location("backend.api._batch_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  ci_commit = module.CiCommit.get_or_create.return_value
  ci_commit.data = {}
  ci_commit.get_or_create_batch.return_value.id = 1
  ci_commit.get_or_create_batch.return_value.data = {}
  return module


@pytest.mark.parametrize("commit", [{"commit_sha": HEXSHA}, {"git_commit_sha": HEXSHA}])
def test_update_batch_commit(batch_api, dummy_app, commit):
  # The CLI also sends git_commit_sha for backward-compatibility, other clients don't have to
  body = {"project": "group/project", "batch_label": "default", **commit}
  with dummy_app.test_request_context("/api/v1/batch/", method="POST", json=body):
    assert batch_api.update_batch().get_json() == {"status": "OK", "id": 1}
  assert batch_api.CiCommit.get_or_create.call_args.kwargs["hexsha"] == HEXSHA


def test_batches_keep_their_own_qaboard_yaml(batch_api, dummy_app):
  # The commit keeps the qaboard.yaml of its first results. A batch keeps its own when it differs,
  # e.g. sent by `qa --share batch` with new visualizations: the web app shows them for that batch.
  ci_commit = batch_api.CiCommit.get_or_create.return_value
  batch = ci_commit.get_or_create_batch.return_value
  first = {"outputs": {"visualizations": []}}
  edited = {"outputs": {"visualizations": [{"name": "Output", "path": "out.png"}]}}
  metrics = {"main_metrics": ["psnr"]}
  def post(config):
    body = {"project": "group/project", "commit_sha": HEXSHA, "batch_label": "@alice| default", "qaboard_config": config, "qaboard_metrics": metrics}
    with dummy_app.test_request_context("/api/v1/batch/", method="POST", json=body):
      assert batch_api.update_batch().get_json()["status"] == "OK"

  post(first)
  assert ci_commit.data == {"qatools_config": first, "qatools_metrics": metrics}
  assert "qatools_config" not in batch.data

  post(edited)
  assert ci_commit.data["qatools_config"] == first
  assert batch.data["qatools_config"] == edited
  assert "qatools_metrics" not in batch.data

  # back to the commit's
  post(first)
  assert ci_commit.data["qatools_config"] == first
  assert "qatools_config" not in batch.data


class FakeOutput:
  def __init__(self, name, output_type='', data=None):
    self.name, self.output_type, self.data = name, output_type, data or {}
    self.batch = None
    self.deleted_files = False

  def delete(self, soft=False):
    self.deleted_files = True


class FakeBatch:
  def __init__(self, label, outputs=()):
    self.label, self.id, self.data = label, 1, {}
    self.outputs = list(outputs)
    self.deleted = False
    for o in self.outputs:
      o.batch = self

  def delete(self, session, **kwargs):
    self.deleted = True


@pytest.fixture
def optimization(batch_api, monkeypatch):
  """A commit with a CI batch, an optimization batch "tune" holding a previous best run, and its iteration batches"""
  ci_run = FakeOutput("ci")
  previous_best = FakeOutput("previous-best", data={"optimization_best": "tune|iter1"})
  iteration_summary = FakeOutput("iteration-1", output_type="optim_iteration")
  new_best = FakeOutput("new-best")
  batches = {
    "default": FakeBatch("default", [ci_run]),
    "tune": FakeBatch("tune", [previous_best, iteration_summary]),
    "tune|iter1": FakeBatch("tune|iter1"),
    "tune|iter2": FakeBatch("tune|iter2", [new_best]),
    "tune|iter3": FakeBatch("tune|iter3"),
    "tune|iterate": FakeBatch("tune|iterate"),
  }
  ci_commit = batch_api.CiCommit.get_or_create.return_value
  ci_commit.get_or_create_batch.side_effect = lambda label: batches.setdefault(label, FakeBatch(label))
  ci_commit.batches = list(batches.values())
  db_session = MagicMock()
  monkeypatch.setattr(batch_api, "db_session", db_session)
  return SimpleNamespace(batches=batches, ci_run=ci_run, previous_best=previous_best, new_best=new_best,
                         iteration_summary=iteration_summary, db_session=db_session)


def post_optimization(batch_api, dummy_app, batch_label, **data):
  body = {"project": "group/project", "commit_sha": HEXSHA, "batch_label": batch_label, "data": {"optimization": True, **data}}
  with dummy_app.test_request_context("/api/v1/batch/", method="POST", json=body):
    return batch_api.update_batch()


def test_optimization_replaces_its_previous_best(batch_api, dummy_app, optimization):
  # What `qa optimize` sends when iteration 2 is the new best
  response = post_optimization(batch_api, dummy_app, "tune", iteration=2, iteration_label="tune|iter2", is_best_iter=True)
  assert response.get_json()["status"] == "OK"
  tune = optimization.batches["tune"]
  assert optimization.previous_best.deleted_files
  assert not optimization.iteration_summary.deleted_files
  assert optimization.new_best.batch is tune and optimization.new_best.data["optimization_best"] == "tune|iter2"
  assert tune.data["best_iter"] == 2
  assert [b.label for b in optimization.batches.values() if b.deleted] == ["tune|iter1", "tune|iter2"]


def test_optimization_never_deletes_other_runs(batch_api, dummy_app, optimization):
  # Ingest is unauthenticated: a request naming the CI batch may not delete its runs
  response = post_optimization(batch_api, dummy_app, "default", iteration=2, iteration_label="default|iter2", is_best_iter=True,
                               keep_all_best_iters=False)
  assert response.get_json()["status"] == "OK"
  assert not optimization.ci_run.deleted_files
  deleted = [call.args[0] for call in optimization.db_session.delete.call_args_list]
  assert optimization.ci_run not in deleted
  assert not optimization.batches["default"].deleted


@pytest.mark.parametrize("data", [
  {"iteration": 2, "iteration_label": "default", "is_best_iter": True},  # would move the CI runs into "tune"
  {"iteration": 2, "iteration_label": "tune|iter3", "is_best_iter": True},
  {"iteration": "2"},
  {},
])
def test_optimization_rejects_inconsistent_iterations(batch_api, dummy_app, optimization, data):
  response, status = post_optimization(batch_api, dummy_app, "tune", **data)
  assert status == 400
  batch_api.CiCommit.get_or_create.assert_not_called()
  assert optimization.ci_run.batch is optimization.batches["default"]


def test_qa_notify_requests_an_email(batch_api, monkeypatch):
  # `qa batch` asks for an email, unless QA_NOTIFY=none (backend/notifications/)
  requests = []
  def request(session, command_id, ci_commit, batch, user_name, data=None):
    requests.append((command_id, user_name, data))
    return MagicMock(recipient=f'{user_name}@example.com'), None
  monkeypatch.setattr(batch_api, 'request_batch_notification', request)
  data = {'job_type': 'local', 'batch_label': '@jdoe| test', 'platform': 'linux'}
  assert batch_api.cli_notification(data, None, None, None) is None
  assert batch_api.cli_notification(data, {'c1': {'user': 'jdoe'}}, None, None) is None
  command = {'c1': {'user': 'jdoe', 'notify': {'channel': 'email', 'batches': ['low-light']}}}
  assert batch_api.cli_notification(data, command, None, None) == {'channel': 'email', 'recipient': 'jdoe@example.com'}
  assert requests == [('c1', 'jdoe', {'source': 'cli', 'label': '@jdoe| test', 'selected_group': 'low-light', 'platform': 'linux'})]
  assert 'CI' in batch_api.cli_notification({**data, 'job_type': 'ci'}, command, None, None)['error']
  assert len(requests) == 1


@pytest.fixture
def web_batch(batch_api, monkeypatch):
  """A batch the web app acts on, as a signed-in user"""
  import backend.api.auth as auth
  auth.is_authorized_user.return_value = True
  monkeypatch.setattr(batch_api, 'refresh_soon', MagicMock())
  batch = MagicMock(label='default', id=1)
  batch.ci_commit.batches = [batch, MagicMock(label='taken')]
  query = MagicMock()
  query.filter.return_value.one.return_value = batch
  monkeypatch.setattr(batch_api.Batch, 'query', query)
  return batch


def as_user(dummy_app, path, **kwargs):
  from flask import g
  context = dummy_app.test_request_context(path, **kwargs)
  context.push()
  g.user = {"user_name": "alice", "user_id": 1}
  return context


@pytest.mark.parametrize("label, status", [("taken", 409), ("default", 409), ("", 400), ("new", 200)])
def test_rename_batch(batch_api, dummy_app, web_batch, label, status):
  context = as_user(dummy_app, "/api/v1/batch/rename/", method="POST", json={"id": 1, "label": label})
  try:
    response = batch_api.rename_batch()
  finally:
    context.pop()
  response, code = response if isinstance(response, tuple) else (response, response.status_code)
  assert code == status
  # JSON, like other errors
  assert response.is_json
  if status == 200:
    assert response.get_json() == {"status": "OK"}
    web_batch.rename.assert_called_once_with(label="new", db_session=batch_api.db_session)
  else:
    assert response.get_json()["error"]
    web_batch.rename.assert_not_called()


@pytest.mark.parametrize("call", [
  lambda api: api.rename_batch(), lambda api: api.move_batch(), lambda api: api.stop_batch(),
  lambda api: api.redo_batch(), lambda api: api.delete_batch(7),
])
def test_unknown_batches(batch_api, dummy_app, web_batch, call):
  batch_api.Batch.query.filter.return_value.one.side_effect = batch_api.NoResultFound
  context = as_user(dummy_app, "/api/v1/batch/7", method="POST", json={"id": 7, "label": "x"})
  try:
    response, status = call(batch_api)
  finally:
    context.pop()
  assert status == 404 and response.get_json() == {"error": "Batch 7 not found"}


def test_unknown_commits_are_json_errors(batch_api, dummy_app):
  batch_api.CiCommit.get_or_create.side_effect = ValueError("BadName")
  body = {"project": "group/project", "batch_label": "default", "commit_sha": HEXSHA}
  with dummy_app.test_request_context("/api/v1/batch/", method="POST", json=body):
    response, status = batch_api.update_batch()
  # old `qa` versions only check it's an error
  assert status == 404 and HEXSHA in response.get_json()["error"]
