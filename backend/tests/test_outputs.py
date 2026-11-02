"""
Tests for backend/api/outputs.py: how the CLI's updates change an output's status.
"""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def outputs_api(monkeypatch):
  """Loads the real backend/api/outputs.py, with an existing output that failed"""
  models = sys.modules['backend.models']
  for name in ("TestInput", "CiCommit", "Output"):
    monkeypatch.setattr(models, name, MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "outputs.py"
  spec = importlib.util.spec_from_file_location("backend.api._outputs_status_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  monkeypatch.setattr(module, "check_storage_path", lambda path: path)
  module.CiCommit.get_or_create.return_value.project.latest_output_datetime = None
  module.CiCommit.get_or_create.return_value.latest_output_datetime = None
  output = SimpleNamespace(data={}, deleted=False, is_failed=True, is_pending=False, is_running=False, metrics={"psnr": 30})
  output.to_dict = lambda: {"is_failed": output.is_failed, "is_pending": output.is_pending, "is_running": output.is_running}
  # Output.set_status, without the dates (integration_tests/test_activity.py tests them)
  output.set_status = lambda is_pending, is_running: output.__dict__.update(is_pending=bool(is_pending or is_running), is_running=bool(is_running))
  module.Output.get_or_create.return_value = output
  module.test_output = output
  return module


def post(outputs_api, dummy_app, without=(), **data):
  body = {
    "git_commit_sha": "0" * 40, "project": "group/project", "batch_label": "default", "job_type": "ci",
    "user": "ci", "platform": "linux", "configurations": [], "extra_parameters": {},
    "input_path": "a.jpg", "database": "/datasets", "output_directory": "/storage/project/output",
    **data,
  }
  for key in without:
    del body[key]
  with dummy_app.test_request_context("/api/v1/output/", method="POST", json=body):
    return outputs_api.new_output_webhook()


def notify(outputs_api, dummy_app, **data):
  return post(outputs_api, dummy_app, **data).get_json()


@pytest.mark.parametrize("status", [{"is_pending": True}, {"is_pending": True, "is_running": True}])
def test_failed_output_running_again_is_not_failed(outputs_api, dummy_app, status):
  # qa batch says the run is pending, then qa run says it's running
  assert notify(outputs_api, dummy_app, **status) == {"is_failed": False, "is_pending": True, "is_running": status.get("is_running", False)}


@pytest.mark.parametrize("data, is_failed", [
  ({"metrics": {"is_failed": True}}, True),
  ({"metrics": {"is_failed": False}}, False),
  ({"is_failed": True}, True),
])
def test_finished_output_status(outputs_api, dummy_app, data, is_failed):
  notify(outputs_api, dummy_app, is_pending=True)
  assert notify(outputs_api, dummy_app, is_pending=False, **data)["is_failed"] == is_failed


@pytest.mark.parametrize("metrics", [None, {}, {"psnr": 30}])
def test_finished_output_without_is_failed(outputs_api, dummy_app, metrics):
  # not None: batches would count it as neither valid nor failed
  assert notify(outputs_api, dummy_app, is_pending=False, metrics=metrics)["is_failed"] is False


def test_commit_sha_without_legacy_key(outputs_api, dummy_app):
  # The CLI also sends git_commit_sha for backward-compatibility, other clients don't have to
  response = post(outputs_api, dummy_app, without=["git_commit_sha"], commit_sha="1" * 40)
  assert response.status_code == 200
  assert outputs_api.CiCommit.get_or_create.call_args.kwargs["hexsha"] == "1" * 40


def test_missing_commit(outputs_api, dummy_app):
  response, status = post(outputs_api, dummy_app, without=["git_commit_sha"])
  assert status == 400
  outputs_api.CiCommit.get_or_create.assert_not_called()


def test_clients_cannot_mark_runs_as_replaceable(outputs_api, dummy_app):
  # Only the server marks the best iteration's runs, which `qa optimize` may later delete (see api/batch.py)
  notify(outputs_api, dummy_app, data={"optimization_best": "default|iter1", "storage": "nfs"})
  assert "optimization_best" not in outputs_api.test_output.data
  assert outputs_api.test_output.data["storage"] == "nfs"


def test_the_web_app_cannot_change_what_only_the_server_sets(outputs_api, dummy_app):
  from flask import g
  import backend.api.auth as auth
  auth.is_authorized_user.return_value = True
  output = SimpleNamespace(data={"submitted_by": {"user_name": "alice"}}, metrics={}, batch=MagicMock(), to_dict=lambda: {})
  outputs_api.Output.query.filter.return_value.one.return_value = output
  data = {"submitted_by": {"user_name": "mallory"}, "optimization_best": "default|iter1", "notes": "ok"}
  with dummy_app.test_request_context("/api/v1/output/7/", method="PUT", json={"data": data}):
    g.user = {"user_name": "mallory"}
    outputs_api.update_output(7)
  assert output.data == {"submitted_by": {"user_name": "alice"}, "notes": "ok"}


def test_metrics_definitions_are_saved(outputs_api, dummy_app, monkeypatch):
  save = MagicMock()
  monkeypatch.setattr(outputs_api, "save_metrics_definitions", save)
  notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 30})
  save.assert_not_called()
  definitions = {"psnr": {"suffix": " dB", "smaller_is_better": False}}
  notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 30}, metrics_definitions=definitions)
  assert save.call_args.args[2]["metrics_definitions"] == definitions
  # the run is saved even if its definitions can't be
  save.side_effect = ValueError("database error")
  assert notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 30}, metrics_definitions=definitions)["is_failed"] is False


@pytest.mark.parametrize("method, call", [
  ("GET", lambda api: api.get_output(7)), ("PUT", lambda api: api.update_output(7)),
  ("POST", lambda api: api.output_redo(7)), ("GET", lambda api: api.get_output_manifest(7)),
])
def test_unknown_outputs(outputs_api, dummy_app, method, call):
  outputs_api.Output.query.filter.return_value.one.side_effect = outputs_api.NoResultFound
  with dummy_app.test_request_context("/api/v1/output/7/", method=method, json={}):
    response, status = call(outputs_api)
  assert status == 404 and response.get_json() == {"error": "Cannot find output 7"}


def test_pending_outputs_cant_be_deleted(outputs_api, dummy_app, monkeypatch):
  from flask import g
  import backend.api.auth as auth
  auth.is_authorized_user.return_value = True
  outputs_api.Output.query.filter.return_value.one.return_value = SimpleNamespace(is_pending=True, batch=MagicMock())
  with dummy_app.test_request_context("/api/v1/output/7/", method="DELETE"):
    g.user = {"user_name": "alice"}
    response, status = outputs_api.update_output(7)
  assert status == 409 and "wait" in response["error"]


# ---------------------------------------------------------------- metrics added by scripts (run.log() in the SDK)

def existing_output(outputs_api, **attrs):
  import backend.api.auth as auth
  auth.ingest_access.return_value = (None, None)
  output = SimpleNamespace(id=7, data={}, metrics={"psnr": 30, "is_failed": False}, is_pending=False, is_running=False, is_failed=False,
                           batch=MagicMock(), output_dir=Path("/storage/project/output/7"), **attrs)
  output.batch.ci_commit.project_id = "group/project"
  output.batch.ci_commit.branch = "main"
  output.to_dict = lambda: {"metrics": output.metrics, "data": output.data}
  outputs_api.Output.query.filter.return_value.one.return_value = output
  return output


def add_metrics(outputs_api, dummy_app, body):
  with dummy_app.test_request_context("/api/v1/output/7/metrics", method="PATCH", json=body):
    return outputs_api.add_output_metrics(7)


def test_scripts_add_metrics_with_provenance(outputs_api, dummy_app, monkeypatch):
  output = existing_output(outputs_api)
  monkeypatch.setattr(outputs_api, "save_added_metrics_file", lambda output, added: True)
  save_definitions = MagicMock()
  monkeypatch.setattr(outputs_api, "save_metrics_definitions", save_definitions)
  response = add_metrics(outputs_api, dummy_app, {
    "metrics": {"sharpness": 0.4, "psnr": 31},
    "metrics_definitions": {"sharpness": {"smaller_is_better": False}},
    "source": {"script": "sharpness.py", "script_sha256": "abc123", "qaboard_version": "1.1.1", "user": "alice", "secret": "no"},
  })
  body = response.get_json()
  # merged, the run's other metrics untouched
  assert output.metrics == {"psnr": 31, "is_failed": False, "sharpness": 0.4}
  added = output.data["added_metrics"]
  assert set(added) == {"sharpness", "psnr"}
  assert added["sharpness"]["value"] == 0.4 and added["sharpness"]["script"] == "sharpness.py" and added["sharpness"]["user"] == "alice"
  assert "secret" not in added["sharpness"] and "verified" not in added["sharpness"]
  assert added["sharpness"]["at"].startswith("20")
  assert body["added"] == added and body["added_metrics_file"] is True
  assert save_definitions.call_args.args[2] == {"metrics_definitions": {"sharpness": {"smaller_is_better": False}}, "commit_branch": "main"}


def test_added_metrics_say_who_verified_them(outputs_api, dummy_app, monkeypatch):
  import backend.api.auth as auth
  output = existing_output(outputs_api)
  monkeypatch.setattr(outputs_api, "save_added_metrics_file", lambda output, added: False)
  auth.ingest_access.return_value = ({"user_name": "bob", "user_id": 2}, None)
  add_metrics(outputs_api, dummy_app, {"metrics": {"sharpness": 0.4}, "source": {"user": "alice"}})
  # the token's user, not what the script claims
  assert output.data["added_metrics"]["sharpness"]["user"] == "bob"
  assert output.data["added_metrics"]["sharpness"]["verified"] is True
  auth.ingest_access.return_value = (None, None)


def test_added_metrics_refusals(outputs_api, dummy_app, monkeypatch):
  import backend.api.auth as auth
  output = existing_output(outputs_api)
  monkeypatch.setattr(outputs_api, "save_added_metrics_file", lambda output, added: True)
  for body, message in [
    ({}, "`metrics` must be an object"),
    ({"metrics": {}}, "`metrics` must be an object"),
    ({"metrics": {"is_failed": True}}, "only the run itself sets is_failed"),
    ({"metrics": {"x": float("nan")}}, "every metric was NaN"),
  ]:
    response, status = add_metrics(outputs_api, dummy_app, body)
    assert status == 400 and message in response.get_json()["error"], body
  assert output.metrics == {"psnr": 30, "is_failed": False}
  output.is_pending = True
  response, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 409
  output.is_pending = False
  # the server's ingest policy applies, like for results sent by qa
  auth.ingest_access.return_value = (None, (dummy_app.response_class('{"error": "token required"}', status=403, content_type='application/json'), 403))
  _, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 403
  auth.ingest_access.return_value = (None, None)


def test_added_metrics_survive_a_rerun_unless_the_run_computes_them(outputs_api, dummy_app):
  output = outputs_api.test_output
  output.data["added_metrics"] = {"sharpness": {"value": 0.4, "at": "2026-11-02T10:00:00+00:00", "script": "sharpness.py"},
                                  "psnr": {"value": 31, "at": "2026-11-02T10:00:00+00:00"}}
  result = notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 30})
  assert result["is_failed"] is False
  assert output.metrics == {"sharpness": 0.4, "psnr": 30}
  # the run computes psnr itself now: its value wins and the addition is forgotten
  assert set(output.data["added_metrics"]) == {"sharpness"}


def test_added_metrics_file(outputs_api, tmp_path, monkeypatch):
  monkeypatch.setattr(outputs_api, "check_storage_path", lambda path: path)
  monkeypatch.setattr(outputs_api, "chmod_shared", lambda path: None)
  output = SimpleNamespace(id=7, output_dir=tmp_path)
  (tmp_path / "metrics.added.json").write_text('{"old": {"value": 1}}')
  assert outputs_api.save_added_metrics_file(output, {"sharpness": {"value": 0.4}}) is True
  import json
  assert json.loads((tmp_path / "metrics.added.json").read_text()) == {"old": {"value": 1}, "sharpness": {"value": 0.4}}
  # a folder that isn't there (deleted, or the storage isn't mounted): no error, the database has the metrics
  assert outputs_api.save_added_metrics_file(SimpleNamespace(id=8, output_dir=tmp_path / "missing"), {}) is False
