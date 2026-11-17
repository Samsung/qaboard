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

ALICE = {"user_name": "alice", "user_id": 1, "via": "token", "token_name": "laptop"}


@pytest.fixture
def added_metrics_env(outputs_api, monkeypatch):
  """A signed-in developer, alice, and a finished run with its own psnr"""
  import backend.api.auth as auth
  monkeypatch.setattr(auth.ingest_access, "return_value", (ALICE, None))
  monkeypatch.setattr(auth.is_authorized_user, "return_value", True)
  monkeypatch.setattr(outputs_api, "save_metrics_definitions", MagicMock())
  output = SimpleNamespace(id=7, data={}, metrics={"psnr": 30, "is_failed": False}, is_pending=False, is_running=False, is_failed=False, deleted=False,
                           batch=MagicMock(), output_dir=Path("/storage/project/output/7"))
  output.batch.ci_commit.project_id = "group/project"
  output.batch.ci_commit.branch = "main"
  output.batch.ci_commit.project.data = {"qatools_config": {"project": {"reference_branch": "main"}}}
  output.to_dict = lambda: {"metrics": output.metrics, "data": output.data}
  outputs_api.Output.query.filter.return_value.with_for_update.return_value.one.return_value = output
  outputs_api.Output.query.filter.return_value.one.return_value = output
  return output


def add_metrics(outputs_api, dummy_app, body):
  with dummy_app.test_request_context("/api/v1/output/7/metrics", method="PATCH", json=body):
    return outputs_api.add_output_metrics(7)


def test_scripts_add_metrics_with_provenance(outputs_api, dummy_app, added_metrics_env):
  output = added_metrics_env
  response = add_metrics(outputs_api, dummy_app, {
    "metrics": {"sharpness": 0.4, "ok": True, "label": "blurry", "nothing": None},
    "metrics_definitions": {"sharpness": {"smaller_is_better": False}, "psnr": {"smaller_is_better": True}},
    "source": {"script": "sharpness.py", "script_sha256": "abc123", "qaboard_version": "1.1.1", "user": "mallory", "secret": "no"},
  })
  body = response.get_json()
  # merged, the run's other metrics untouched
  assert output.metrics == {"psnr": 30, "is_failed": False, "sharpness": 0.4, "ok": True, "label": "blurry", "nothing": None}
  added = output.data["added_metrics"]
  assert set(added) == {"sharpness", "ok", "label", "nothing"}
  entry = added["sharpness"]
  assert entry["value"] == 0.4 and entry["script"] == "sharpness.py" and entry["script_sha256"] == "abc123"
  # who: the token's user, never what the script claims
  assert entry["user"] == "alice" and entry["token"] == "laptop" and "secret" not in entry and "replaced" not in entry
  assert entry["at"].startswith("20")
  assert body["added"] == added and "added_metrics_file" not in body
  # the run's own metrics are locked while we change them
  outputs_api.Output.query.filter.return_value.with_for_update.assert_called()
  # definitions: only for the metrics added, with the project's reference branch
  saved = outputs_api.save_metrics_definitions.call_args.args[2]
  assert saved["metrics_definitions"] == {"sharpness": {"smaller_is_better": False}}
  assert saved["commit_branch"] == "main" and saved["qaboard_config"] == {"project": {"reference_branch": "main"}}


def test_the_runs_own_metrics_are_not_replaced_silently(outputs_api, dummy_app, added_metrics_env):
  output = added_metrics_env
  response, status = add_metrics(outputs_api, dummy_app, {"metrics": {"psnr": 31, "sharpness": 0.4}})
  assert status == 409 and response.get_json()["metrics"] == ["psnr"]
  assert output.metrics == {"psnr": 30, "is_failed": False}
  add_metrics(outputs_api, dummy_app, {"metrics": {"psnr": 31}, "overwrite": True})
  assert output.metrics["psnr"] == 31 and output.data["added_metrics"]["psnr"]["replaced"] == 30
  # logging again replaces the script's value, and keeps the run's original
  add_metrics(outputs_api, dummy_app, {"metrics": {"psnr": 32}})
  assert output.metrics["psnr"] == 32 and output.data["added_metrics"]["psnr"]["replaced"] == 30


def test_added_metrics_need_a_token_and_the_project(outputs_api, dummy_app, added_metrics_env, monkeypatch):
  import backend.api.auth as auth
  output = added_metrics_env
  # the server's ingest.auth doesn't matter: this endpoint always needs a token with the ingest scope
  monkeypatch.setattr(auth.ingest_access, "return_value", (None, (dummy_app.response_class('{"error": "sign in"}', status=401, content_type='application/json'), 401)))
  _, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 401 and output.metrics == {"psnr": 30, "is_failed": False}
  assert auth.ingest_access.call_args.kwargs == {"require_token": True}
  # who can't see the project learns nothing, not even that the run exists
  monkeypatch.setattr(auth.ingest_access, "return_value", (ALICE, None))
  monkeypatch.setattr(auth.is_authorized_user, "return_value", False)
  response, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 403
  outputs_api.Output.query.filter.return_value.with_for_update.return_value.one.side_effect = outputs_api.NoResultFound
  response, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 404


@pytest.mark.parametrize("body, message", [
  ({}, "`metrics` must be an object"),
  ({"metrics": {}}, "`metrics` must be an object"),
  ({"metrics": {"is_failed": True}}, "only the run itself sets is_failed"),
  ({"metrics": {"x": float("nan")}}, "not a finite number"),
  ({"metrics": {"x": float("inf")}}, "not a finite number"),
  ({"metrics": {"x": {"nested": 1}}}, "not dict"),
  ({"metrics": {"x": [1, 2]}}, "not list"),
  ({"metrics": {"__proto__": 1}}, "invalid metric name"),
  ({"metrics": {"": 1}}, "invalid metric name"),
  ({"metrics": {"x" * 201: 1}}, "invalid metric name"),
  ({"metrics": {"x": "y" * 501}}, "limited to 500"),
  ({"metrics": {f"m{i}": i for i in range(501)}}, "at most 500"),
])
def test_added_metrics_values_are_checked(outputs_api, dummy_app, added_metrics_env, body, message):
  output = added_metrics_env
  response, status = add_metrics(outputs_api, dummy_app, body)
  assert status == 400 and message in response.get_json()["error"]
  assert output.metrics == {"psnr": 30, "is_failed": False}


def test_added_metrics_need_a_finished_run(outputs_api, dummy_app, added_metrics_env):
  output = added_metrics_env
  output.is_pending = True
  _, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 409
  output.is_pending, output.deleted = False, True
  _, status = add_metrics(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 409


def test_added_metrics_survive_a_rerun_unless_the_run_computes_them(outputs_api, dummy_app):
  output = outputs_api.test_output
  output.id = 7
  added = {"sharpness": {"value": 0.4, "at": "2026-11-02T10:00:00+00:00", "script": "sharpness.py"},
           "psnr": {"value": 31, "at": "2026-11-02T10:00:00+00:00", "replaced": 30}}
  # the database's copy is what counts, read under a lock: a script may have logged while the run ran
  output.data["added_metrics"] = {"stale": {"value": 1}}
  outputs_api.db_session.query.return_value.filter.return_value.with_for_update.return_value.scalar.return_value = {"added_metrics": added}
  result = notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 30})
  assert result["is_failed"] is False
  assert output.metrics == {"sharpness": 0.4, "psnr": 30}
  # the run computes psnr itself now: its value wins and the addition is forgotten
  assert set(output.data["added_metrics"]) == {"sharpness"}


def test_a_run_done_again_in_a_new_directory_keeps_a_trace_of_its_attempts(outputs_api, dummy_app):
  """`qa` saves each attempt of a run in its own directory (qaboard/attempts.py): the row keeps the latest's results"""
  import datetime
  output = outputs_api.test_output
  # the first time: nothing to remember
  output.id, output.output_dir_override = None, None
  notify(outputs_api, dummy_app, is_pending=False, metrics={"is_failed": True})
  assert "attempt" not in output.data and "previous_attempts" not in output.data
  assert output.output_dir_override == "/storage/project/output"

  # done again, by someone else: `qa batch` says where it will be, then `qa run` that it started and ended
  output.id, output.is_failed = 7, True
  output.started_at, output.finished_at = datetime.datetime(2026, 11, 3, 10, 12), datetime.datetime(2026, 11, 3, 10, 14)
  for status in ({"is_pending": True}, {"is_pending": True, "is_running": True}, {"is_pending": False, "metrics": {}}):
    notify(outputs_api, dummy_app, output_directory="/storage/project/output_attempt2", user="alice", **status)
  assert output.output_dir_override == "/storage/project/output_attempt2"
  assert output.data["attempt"] == 2
  # with its metrics: a record of what the attempt measured, not a sample of the new one
  assert output.data["previous_attempts"] == [
    {"attempt": 1, "status": "failed", "started_at": "2026-11-03T10:12:00Z", "finished_at": "2026-11-03T10:14:00Z", "user": "ci",
     "metrics": {"is_failed": True}},
  ]

  # again, while the second attempt never said how it ended
  output.is_pending, output.started_at, output.finished_at = True, None, None
  notify(outputs_api, dummy_app, output_directory="/storage/project/output_attempt3", is_pending=True, is_running=True)
  assert output.data["attempt"] == 3
  assert [(a["attempt"], a["status"], a.get("user")) for a in output.data["previous_attempts"]] == [(1, "failed", "ci"), (2, "unfinished", "alice")]

  # clients can't rewrite it
  notify(outputs_api, dummy_app, output_directory="/storage/project/output_attempt3", is_pending=False, metrics={},
         data={"attempt": 1, "previous_attempts": [], "storage": 10})
  assert output.data["attempt"] == 3 and len(output.data["previous_attempts"]) == 2
  assert output.data["storage"] == 10


def test_a_run_done_again_in_place_keeps_a_trace_too(outputs_api, dummy_app):
  """Local runs, projects that opt out and older `qa` replace the run's files where they are: viewers warn about caches"""
  output = outputs_api.test_output
  output.id, output.output_dir_override, output.is_failed = 7, "/storage/project/output", False
  output.metrics = {"psnr": 30, "notes": "x" * 500, "curve": [1, 2]}
  # `qa batch` says the run is pending, its `qa run` that it runs, then how it ended: one new attempt
  for status in ({"is_pending": True}, {"is_pending": True, "is_running": True}, {"is_pending": False, "metrics": {"psnr": 31}}):
    notify(outputs_api, dummy_app, **status)
  previous, = output.data["previous_attempts"]
  # plain values only
  assert previous == {"attempt": 1, "status": "success", "in_place": True, "metrics": {"psnr": 30}}, previous
  assert "attempt" not in output.data
  # updates of a finished run are not attempts: qa postprocess, qa sync
  notify(outputs_api, dummy_app, is_pending=False, metrics={"psnr": 32})
  assert len(output.data["previous_attempts"]) == 1
  # a run without its own directory, from very old clients
  notify(outputs_api, dummy_app, without=("output_directory",), is_pending=True, is_running=True)
  assert [a.get("in_place") for a in output.data["previous_attempts"]] == [True, True]
  assert output.data["previous_attempts"][1]["metrics"]["psnr"] == 32


def test_only_the_last_attempts_are_remembered():
  from backend.attempts import record_attempt, MAX_PREVIOUS_ATTEMPTS
  output = SimpleNamespace(id=7, data={}, output_dir_override="/storage/output", is_pending=False, is_failed=False)
  for attempt in range(2, MAX_PREVIOUS_ATTEMPTS + 5):
    record_attempt(output, f"/storage/output_attempt{attempt}")
    output.output_dir_override = f"/storage/output_attempt{attempt}"
  assert output.data["attempt"] == MAX_PREVIOUS_ATTEMPTS + 4
  assert [a["attempt"] for a in output.data["previous_attempts"]] == list(range(4, MAX_PREVIOUS_ATTEMPTS + 4))
  # runs done again in place, or that don't say where they are, change nothing
  before = dict(output.data)
  record_attempt(output, output.output_dir_override)
  record_attempt(output, None)
  assert output.data == before
  # back in a directory without a number, e.g. a custom --output: no attempt number
  record_attempt(output, "/elsewhere/output")
  assert "attempt" not in output.data


def test_hard_deletes_remove_the_folder_that_says_where_the_latest_attempt_is(tmp_path, monkeypatch):
  import backend.fs_utils as fs_utils
  from backend.attempts import forget_attempts
  first = tmp_path / "commit" / "output" / "linux" / "a"
  latest = first.with_name("a_attempt3")
  first.mkdir(parents=True)
  (first / "latest_attempt.txt").write_text("3\n")
  removed_parents = []
  monkeypatch.setattr(fs_utils, "rm_empty_parents", removed_parents.append)
  # the latest attempt's folder was removed: nothing is left of the run
  forget_attempts(latest)
  assert not first.exists()
  assert removed_parents == [first]
  # runs done once, or with other files left: nothing to do
  forget_attempts(first)
  first.mkdir()
  (first / "latest_attempt.txt").write_text("3\n")
  (first / "left.txt").write_text("")
  forget_attempts(latest)
  assert first.exists() and removed_parents == [first]


# ---------------------------------------------------------------- what running runs report (qaboard.start_run() in the SDK)

@pytest.fixture
def running_run(outputs_api, added_metrics_env, monkeypatch):
  """A run started from code, that logs while it runs"""
  output = added_metrics_env
  output.is_pending, output.is_running, output.metrics = True, True, {}
  monkeypatch.setattr(outputs_api, "current_data", lambda output: output.data)
  return output


def report_progress(outputs_api, dummy_app, body):
  with dummy_app.test_request_context("/api/v1/output/7/progress", method="PATCH", json=body):
    return outputs_api.report_output_progress(7)


def test_running_runs_report_their_metrics_and_params(outputs_api, dummy_app, running_run):
  import backend.api.auth as auth
  output = running_run
  report_progress(outputs_api, dummy_app, {"metrics": {"train/loss": 0.9, "val/loss": 1.2}, "params": {"optimizer": "adamw"},
                                           "metrics_definitions": {"val/loss": {"smaller_is_better": True}, "other": {"suffix": "%"}}})
  assert output.metrics == {"train/loss": 0.9, "val/loss": 1.2}
  assert output.data["params"] == {"optimizer": "adamw"}
  assert (output.is_pending, output.is_running) == (True, True)
  # the same access as the results `qa` sends, not a token whatever the server's policy
  assert auth.ingest_access.call_args.kwargs == {}
  saved = outputs_api.save_metrics_definitions.call_args.args[2]
  assert saved["metrics_definitions"] == {"val/loss": {"smaller_is_better": True}}
  # each report replaces the previous one: the run says everything each time
  response = report_progress(outputs_api, dummy_app, {"metrics": {"train/loss": 0.5}})
  assert output.metrics == {"train/loss": 0.5} and output.data["params"] == {"optimizer": "adamw"}
  assert response.get_json()["metrics"] == {"train/loss": 0.5}
  assert outputs_api.save_metrics_definitions.call_count == 1


def test_progress_keeps_the_metrics_scripts_added(outputs_api, dummy_app, running_run):
  output = running_run
  output.data["added_metrics"] = {"sharpness": {"value": 0.4, "at": "2026-11-02T10:00:00+00:00"}, "loss": {"value": 3, "at": "2026-11-02T10:00:00+00:00"}}
  report_progress(outputs_api, dummy_app, {"metrics": {"loss": 0.5}})
  assert output.metrics == {"sharpness": 0.4, "loss": 0.5}
  assert set(output.data["added_metrics"]) == {"sharpness"}


def test_only_running_runs_report_progress(outputs_api, dummy_app, running_run):
  output = running_run
  output.is_pending, output.is_running, output.metrics = False, False, {"psnr": 30}
  response, status = report_progress(outputs_api, dummy_app, {"metrics": {"loss": 0.5}})
  assert status == 409 and response.get_json()["reason"] == "not_running"
  # queued, not started
  output.is_pending = True
  _, status = report_progress(outputs_api, dummy_app, {"metrics": {"loss": 0.5}})
  assert status == 409 and output.metrics == {"psnr": 30}


@pytest.mark.parametrize("body, message", [
  ({"metrics": {"is_failed": True}}, "only the run itself sets is_failed"),
  ({"metrics": {"x": float("nan")}}, "not a finite number"),
  ({"metrics": [1]}, "`metrics` must be an object"),
  ({"metrics": {f"m{i}": i for i in range(2001)}}, "at most 2000"),
  ({"metrics": {}, "params": ["adamw"]}, "`params` must be an object"),
  ({"metrics": {}, "params": {"x": "y" * 100_000}}, "`params` must be an object"),
])
def test_progress_is_checked(outputs_api, dummy_app, running_run, body, message):
  response, status = report_progress(outputs_api, dummy_app, body)
  assert status == 400 and message in response.get_json()["error"]
  assert running_run.metrics == {}


def test_progress_needs_access_to_the_project(outputs_api, dummy_app, running_run, monkeypatch):
  import backend.api.auth as auth
  monkeypatch.setattr(auth.ingest_access, "return_value", (None, (dummy_app.response_class('{"error": "token"}', status=403, content_type='application/json'), 403)))
  _, status = report_progress(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 403 and running_run.metrics == {}
  monkeypatch.setattr(auth.ingest_access, "return_value", (ALICE, None))
  monkeypatch.setattr(auth.is_authorized_user, "return_value", False)
  _, status = report_progress(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 403
  # refused callers take no lock on the run
  outputs_api.Output.query.filter.return_value.with_for_update.assert_not_called()
  outputs_api.Output.query.filter.return_value.one.side_effect = outputs_api.NoResultFound
  _, status = report_progress(outputs_api, dummy_app, {"metrics": {"x": 1}})
  assert status == 404
