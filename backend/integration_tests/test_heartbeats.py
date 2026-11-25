"""Runs that stop reporting, against PostgreSQL: backend/heartbeats.py, and the endpoints that lock a run"""
import datetime
from backend import clock

from .conftest import new_token, bearer


def make_run(**fields):
  from backend.database import db_session
  from backend.models import Project, CiCommit, Batch, Output, TestInput
  project = Project(id="group/repo", data={})
  commit = CiCommit("a" * 40, project=project, branch="master")
  batch = Batch(ci_commit=commit, label="default")
  test_input = TestInput(path="input", database="/")
  output = Output(batch=batch, test_input=test_input, platform="linux", configurations=[], extra_parameters={}, **fields)
  db_session.add_all([project, commit, batch, test_input, output])
  db_session.commit()
  return output.id


def test_silent_runs_are_failed():
  from backend import heartbeats
  from backend.database import db_session
  from backend.models import Output
  long_ago = clock.utcnow() - datetime.timedelta(hours=1)
  silent = make_run(is_pending=True, is_running=True, reported_at=long_ago, data={"heartbeat": True})
  assert heartbeats.fail_silent_runs() == 1
  db_session.remove()
  output = Output.query.get(silent)
  assert output.is_failed and not output.is_running and "Stopped reporting" in output.data["failed_reason"]
  # nothing left to fail
  assert heartbeats.fail_silent_runs() == 0


def test_runs_report_progress(logged_in):
  alice = logged_in('alice', is_admin=True)
  token = new_token(alice)["token"]
  run = make_run(is_pending=True, is_running=True, data={"heartbeat": True})
  response = alice.application.test_client().patch(f'/api/v1/output/{run}/progress', json={"metrics": {"loss": 0.5}}, headers=bearer(token))
  assert response.status_code == 200, response.get_json()


def test_scripts_add_metrics_to_finished_runs(logged_in):
  alice = logged_in('alice', is_admin=True)
  token = new_token(alice)["token"]
  run = make_run(is_pending=False, is_running=False, metrics={"accuracy": 0.5})
  response = alice.application.test_client().patch(f'/api/v1/output/{run}/metrics', json={"metrics": {"recall": 0.75}}, headers=bearer(token))
  assert response.status_code == 200, response.get_json()
