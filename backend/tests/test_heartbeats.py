"""
Tests for runs that stop reporting: backend/heartbeats.py, and what the endpoints of backend/api/outputs.py record.
"""
import datetime
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend import config, heartbeats

from .test_uploads import outputs_api, start, upload_root  # noqa: F401 (fixtures)

NOW = datetime.datetime(2026, 11, 18, 12, 0)


def running_run(**data):
  run = SimpleNamespace(id=1, data=data, is_pending=True, is_running=True, is_failed=False, reported_at=NOW - datetime.timedelta(minutes=30))
  run.set_status = lambda is_pending, is_running, now=None: run.__dict__.update(is_pending=bool(is_pending or is_running), is_running=bool(is_running))
  return run


@pytest.fixture
def silent_runs(monkeypatch):
  runs = []
  output_model = MagicMock()
  output_model.reported_at.__lt__.return_value = True  # SQL, not compared here
  output_model.query.filter.return_value.with_for_update.return_value.all.side_effect = lambda: list(runs)
  monkeypatch.setattr(sys.modules['backend.models'], "Output", output_model, raising=False)
  ended = []
  run_activity = MagicMock()
  run_activity.cancel_notifications = lambda command_ids, reason: ended.extend((command_id, reason) for command_id in command_ids)
  monkeypatch.setitem(sys.modules, 'backend.run_activity', run_activity)
  monkeypatch.setattr(config, "silent_run_timeout_minutes", 15)
  return runs, ended


def test_silent_runs_that_send_heartbeats_fail(silent_runs):
  runs, ended = silent_runs
  beating = running_run(heartbeat=True, root_command_id="c1")
  runs.append(beating)  # what the query returns: older clients' runs are filtered out in SQL
  assert heartbeats.fail_silent_runs(now=NOW) == 1
  conditions = " ".join(str(c) for c in sys.modules['backend.models'].Output.query.filter.call_args.args)
  assert "(outputs.data->>'heartbeat') = 'true'" in conditions
  assert (beating.is_pending, beating.is_running, beating.is_failed) == (False, False, True)
  assert beating.data["silent_since"] == "2026-11-18T11:30:00Z"
  assert "Stopped reporting at 2026-11-18 11:30 UTC" in beating.data["failed_reason"]
  # like for stuck runs, no "batch ended" email
  assert ended == [("c1", beating.data["failed_reason"])]


def test_never_with_a_timeout_of_zero(silent_runs, monkeypatch):
  runs, _ = silent_runs
  runs.append(running_run(heartbeat=True))
  monkeypatch.setattr(config, "silent_run_timeout_minutes", 0)
  assert heartbeats.fail_silent_runs(now=NOW) == 0


def test_a_silent_run_that_reports_again_runs_again():
  run = running_run(heartbeat=True, silent_since="2026-11-18T11:30:00Z", failed_reason="Stopped reporting")
  run.is_pending = run.is_running = False
  run.is_failed = True
  heartbeats.reported(run, now=NOW)
  assert (run.is_pending, run.is_running, run.is_failed, run.reported_at) == (True, True, False, NOW)
  assert "silent_since" not in run.data and "failed_reason" not in run.data


def test_runs_say_whether_they_send_heartbeats(outputs_api, dummy_app):
  start(outputs_api, dummy_app, heartbeat=True)
  run = outputs_api.test_output
  assert run.data["heartbeat"] is True and run.reported_at is not None
  # an older client running it again doesn't
  start(outputs_api, dummy_app)
  assert "heartbeat" not in run.data
  # nor can clients say it in the run's data, or that it's silent
  start(outputs_api, dummy_app, data={"heartbeat": True, "silent_since": "x"})
  assert "heartbeat" not in run.data and "silent_since" not in run.data


def test_a_heartbeat_changes_nothing_but_revives_a_silent_run(outputs_api, dummy_app):
  run = outputs_api.test_output
  outputs_api.Output.query.filter.return_value.with_for_update.return_value.one.return_value = run
  run.metrics = {"loss": 0.5}
  run.data = {"heartbeat": True, "silent_since": "2026-11-18T11:30:00Z"}
  run.is_failed = True
  with dummy_app.test_request_context("/api/v1/output/7/progress", method="PATCH", json={}):
    response = outputs_api.report_output_progress(7)
  assert not isinstance(response, tuple), response[0].get_json()
  assert (run.is_pending, run.is_running, run.is_failed, run.metrics) == (True, True, False, {"loss": 0.5})
  # a run that ended doesn't run again
  run.is_pending = run.is_running = False
  with dummy_app.test_request_context("/api/v1/output/7/progress", method="PATCH", json={}):
    response = outputs_api.report_output_progress(7)
  assert response[1] == 409
