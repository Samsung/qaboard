"""
Tests for backend/redo.py: redoing runs with a single `qa batch --runs-file`.
We run the real redo.sh script with bash, with a fake `qa` that the artifacts folder's .envrc puts in the PATH.
"""
import json
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import backend.redo as redo


def make_output(path="images/a.jpg", **kwargs):
  return SimpleNamespace(**{
    "test_input": SimpleNamespace(path=path, database="/datasets"),
    "output_type": "image",
    "platform": "linux",
    "configurations": ["base", {"x": 1}],
    "configuration": 'base:{"x": 1}',
    "extra_parameters": {"p": 1},
    "data": {"batch": "my-batch", "job_options": {"type": "dask", "concurrency": 3, "cluster": {"cores": 4}, "command_id": "old"}},
    **kwargs,
  })


def test_safe_job_options():
  assert redo.safe_job_options({
    "type": "lsf", "concurrency": 5, "queue": "gpu_q", "project": "group/project", "priority": 1000, "max_memory": "20000",
    "max_threads": 4, "resources": "select[mem>4000] rusage[mem=4000] span[hosts=1]", "concurrency_strategy": "waves", "timeout": 2.5,
  }) == {
    "type": "lsf", "concurrency": 5, "queue": "gpu_q", "project": "group/project", "priority": 1000, "max_memory": "20000",
    "max_threads": 4, "resources": "select[mem>4000] rusage[mem=4000] span[hosts=1]", "concurrency_strategy": "waves", "timeout": 2.5,
  }
  # `qa batch` puts job options in shell commands: we drop those we don't know, or with unsafe values
  assert redo.safe_job_options({
    "type": "evil",
    "concurrency": True,
    "queue": "q; rm -rf ~",
    "project": "$(id)",
    "max_memory": "1000; id",
    "resources": 'x" $(id) "',
    "options": "-W 1:00",
    "cluster": {"job_script_prologue": ["id"]},
    "scheduler_address": "tcp://attacker:8786",
    "bridge": "ssh evil {bsub_command}",
  }) == {}
  assert redo.safe_job_options(None) == {}
  assert redo.safe_job_options(["type", "lsf"]) == {}


def test_run_spec():
  assert redo.run_spec(make_output()) == {
    "input_path": "images/a.jpg",
    "database": "/datasets",
    "type": "image",
    "platform": "linux",
    "configurations": ["base", {"x": 1}],
    "extra_parameters": {"p": 1},
    "batch": "my-batch",
    "job_options": {"type": "dask", "concurrency": 3},
  }
  assert redo.run_spec(make_output(data={}))["job_options"] == {}


FAKE_QA = """#!/bin/bash
echo "$QA_BATCH_COMMAND_ID $QA_OUTPUTS_COMMIT $*" >> "{calls}"
[[ "$*" != *"{fail_on}"* ]]
"""

@pytest.fixture
def setup(tmp_path, monkeypatch):
  """A batch from the CI, with its artifacts. Returns a function that sets up a fake `qa`."""
  monkeypatch.delenv("QA_RUNNERS_LSF_BRIDGE", raising=False)
  monkeypatch.setenv("QABOARD_DEFAULT_USER", "ci")
  monkeypatch.setattr(redo, "check_storage_path", lambda path: Path(path))
  monkeypatch.setattr(redo, "db_session", MagicMock())
  artifacts_dir = tmp_path / "artifacts"
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  artifacts_dir.mkdir()
  (artifacts_dir / ".envrc").write_text(f'export PATH="{bin_dir}:$PATH"\n')
  outputs_dir = tmp_path / "outputs" / "ci" / "project" / "abcdef"
  ci_commit = SimpleNamespace(hexsha="abcdef", outputs_dir=outputs_dir, artifacts_dir=artifacts_dir, ensure_artifacts=MagicMock(return_value=None))
  batch = SimpleNamespace(label="my label", batch_dir=outputs_dir / "output" / "my-label", data={"commands": {"x": {}}}, ci_commit=ci_commit)
  calls = tmp_path / "calls.txt"

  def fake_qa(fail_on="NEVER"):
    qa = bin_dir / "qa"
    qa.write_text(FAKE_QA.format(calls=calls, fail_on=fail_on))
    qa.chmod(qa.stat().st_mode | stat.S_IEXEC)
    return batch, calls
  return fake_qa


def test_redo_outputs(setup, tmp_path):
  batch, calls = setup()
  outputs = [make_output("images/a.jpg"), make_output("images/b.jpg", data={})]
  submission = redo.redo_outputs(batch, outputs, {"user_name": "arthurf"})

  assert submission["status"] == "done", redo.log_tail(submission)
  assert submission["exit_code"] == 0
  assert submission["kind"] == "redo" and submission["runs"] == 2 and submission["user"] == "arthurf"
  # It's recorded with the batch, and we kept its other data
  assert batch.data["submissions"] == {submission["id"]: submission}
  assert batch.data["commands"] == {"x": {}}
  # Its files are saved in the user's batch directory
  log_dir = Path(submission["log_dir"])
  assert log_dir.parent == tmp_path / "outputs" / "arthurf" / "project" / "abcdef" / "output" / "my-label" / "qaboard-batches"
  runs = json.loads((log_dir / "runs.json").read_text())["runs"]
  assert [run["input_path"] for run in runs] == ["images/a.jpg", "images/b.jpg"]
  assert runs[0]["job_options"] == {"type": "dask", "concurrency": 3}
  # A single `qa batch` for all the runs
  [call] = calls.read_text().splitlines()
  command_id, outputs_commit, *args = call.split(" ")
  assert command_id == submission["id"]
  assert outputs_commit == str(tmp_path / "outputs" / "arthurf" / "project" / "abcdef")
  assert " ".join(args) == f"--label my label batch --no-wait --action-on-existing=run --action-on-pending=run --runs-file {log_dir}/runs.json"
  assert "[qaboard] qa batch exited with code 0" in redo.log_tail(submission)


def test_redo_outputs_refuses_unsafe_users(setup):
  batch, calls = setup()
  with pytest.raises(ValueError):
    redo.redo_outputs(batch, [make_output()], {"user_name": "a;b"})
  assert not calls.exists()


def test_redo_response(setup, dummy_app):
  batch, calls = setup()
  with dummy_app.test_request_context():
    response, status = redo.redo_response(batch, [], {"user_name": "arthurf"})
    assert status == 400
    response = redo.redo_response(batch, [make_output()], {"user_name": "arthurf"})
    assert response.get_json()["submission"]["status"] == "done"

  batch, calls = setup(fail_on="--runs-file")
  with dummy_app.test_request_context():
    response, status = redo.redo_response(batch, [make_output()], {"user_name": "arthurf"})
    assert status == 500
    assert "qa batch exited with code 1" in response.get_json()["error"]
    assert "[qaboard] qa batch exited with code 1" in response.get_json()["logs"]


def test_redo_refuses_unusable_artifacts(setup, dummy_app):
  # e.g. without its qaboard.yaml, a subproject's runs would be saved in the parent project
  from backend.artifacts import ArtifactsUnavailable
  batch, calls = setup()
  batch.ci_commit.ensure_artifacts = MagicMock(side_effect=ArtifactsUnavailable("The subproject's qaboard.yaml is missing.", {"ok": False}))
  with dummy_app.test_request_context():
    response, status = redo.redo_response(batch, [make_output()], {"user_name": "arthurf"})
  assert status == 409
  assert response.get_json() == {"error": "The subproject's qaboard.yaml is missing.", "artifacts": {"ok": False}}
  # nothing was started
  assert not calls.exists()


def test_redo_tells_what_could_not_be_restored(setup, dummy_app):
  batch, calls = setup()
  batch.ci_commit.ensure_artifacts = MagicMock(return_value={"status": "restored", "message": "Build outputs (e.g. binaries) can't be restored this way."})
  with dummy_app.test_request_context():
    response = redo.redo_response(batch, [make_output()], {"user_name": "arthurf"})
  assert response.get_json()["warning"] == "Build outputs (e.g. binaries) can't be restored this way."


def test_safe_job_options_of_kubernetes_runs(monkeypatch):
  options = {"type": "kubernetes", "concurrency": 10, "runs_per_pod": 4, "namespace": "kube-system", "run_as": {"uid": 0}}
  # Kubernetes runs only when the server starts `qa batch` on Kubernetes: else they'd use the server's credentials
  monkeypatch.delenv("QABOARD_TUNING_RUNNER", raising=False)
  assert redo.safe_job_options(options) == {"concurrency": 10, "runs_per_pod": 4}
  monkeypatch.setenv("QABOARD_TUNING_RUNNER", "kubernetes")
  assert redo.safe_job_options(options) == {"type": "kubernetes", "concurrency": 10, "runs_per_pod": 4}


def test_redo_on_kubernetes(setup, dummy_app, monkeypatch):
  """With QABOARD_TUNING_RUNNER=kubernetes, `qa batch` runs in a pod as the user, and we don't wait for it"""
  import backend.runner_jobs as runner_jobs
  batch, calls = setup()
  batch.ci_commit.project_id = "project"
  batch.ci_commit.project = SimpleNamespace(data={"qatools_config": {"runners": {"kubernetes": {"namespace": "algo-qa"}}}})
  monkeypatch.setenv("QABOARD_TUNING_RUNNER", "kubernetes")
  # it doesn't go through the LSF bridge
  monkeypatch.setenv("QA_RUNNERS_LSF_BRIDGE", "false {user} {command}")
  submitted = []
  user_info = {"user_name": "arthurf", "login_type": "LDAP"}
  def submit_driver(script_path, log_dir, user_info, ci_commit, command_id, on_prepared=None):
    record = {"kubernetes_job": f"qa-{command_id[:8]}-driver", "namespace": "algo-qa"}
    on_prepared(record)
    # it's recorded before it's submitted
    assert batch.data["submissions"][command_id]["kubernetes_job"] == record["kubernetes_job"]
    submitted.append((Path(script_path).name, log_dir, user_info, ci_commit, command_id))
    return record
  monkeypatch.setattr(runner_jobs, "submit_driver", submit_driver)
  with dummy_app.test_request_context():
    response = redo.redo_response(batch, [make_output()], user_info)
  submission = response.get_json()["submission"]
  assert submission["status"] == "submitted" and submission["runner"] == "kubernetes"
  assert submission["kubernetes_job"] == f"qa-{submission['id'][:8]}-driver" and submission["namespace"] == "algo-qa"
  [(script, log_dir, user, ci_commit, command_id)] = submitted
  assert (script, str(log_dir), user, ci_commit, command_id) == ("redo.sh", submission["log_dir"], user_info, batch.ci_commit, submission["id"])
  assert batch.data["submissions"][submission["id"]] == submission
  assert not calls.exists()

  # Users see why it could not start
  def refused(*args, **kwargs):
    raise runner_jobs.NotAllowed("QA-Board may not start or stop runs in the Kubernetes namespace 'x'")
  monkeypatch.setattr(runner_jobs, "submit_driver", refused)
  with dummy_app.test_request_context():
    response, status = redo.redo_response(batch, [make_output()], user_info)
  assert status == 500
  assert "namespace 'x'" in response.get_json()["error"]


SLOW_QA = """#!/bin/bash
echo "db=${{QABOARD_DB_PASSWORD:-none}} broker=${{CELERY_BROKER_URL:-none}} $*" >> "{calls}"
sleep 600
"""

def test_redo_on_the_server_does_not_wait(setup, dummy_app, monkeypatch):
  """Without the LSF bridge, `qa batch` runs on the server, detached: requests don't wait, harakiri doesn't kill it"""
  from backend.local_jobs import refresh_status, stop_local_submissions
  monkeypatch.setenv("QABOARD_LOCAL_START_WAIT", "1")
  monkeypatch.setenv("QABOARD_DB_PASSWORD", "db-secret")
  monkeypatch.setenv("CELERY_BROKER_URL", "pyamqp://qaboard:secret@rabbitmq//")
  batch, calls = setup()
  qa = Path(batch.ci_commit.artifacts_dir).parent / "bin" / "qa"
  qa.write_text(SLOW_QA.format(calls=calls))
  qa.chmod(qa.stat().st_mode | stat.S_IEXEC)
  # a run first done with Celery: `qa batch` sends it to the workers again, it needs the broker
  outputs = [make_output(data={"job_options": {"type": "celery"}})]
  with dummy_app.test_request_context():
    response = redo.redo_response(batch, outputs, {"user_name": "arthurf"})
  submission = response.get_json()["submission"]
  assert submission["status"] == "submitted" and submission["runner"] == "local", redo.log_tail(submission)
  assert isinstance(submission["pid"], int) and isinstance(submission["pgid"], int) and submission["host"]
  [call] = calls.read_text().splitlines()
  assert call.startswith("db=none broker=pyamqp://qaboard:secret@rabbitmq// --label my label batch")
  assert refresh_status(submission) == submission
  assert stop_local_submissions(batch.data)["stopped"] == [submission["id"]]
  assert refresh_status(submission)["status"] == "failed"
