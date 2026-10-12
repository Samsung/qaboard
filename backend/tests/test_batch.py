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
