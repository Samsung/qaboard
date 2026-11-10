"""Stopping batches (Batch.stop): the runner gets only validated options, and Kubernetes drivers are deleted too"""
from unittest import mock

import pytest

from .test_jobs import World, storage  # noqa: F401 (fixtures)
from .test_ingest import batch_payload, PROJECT, SHA

LSF_ID = "11111111-1111-4111-8111-111111111111"
K8S_ID = "22222222-2222-4222-8222-222222222222"
DRIVER_ID = "33333333-3333-4333-8333-333333333333"


@pytest.fixture
def world(storage):
  return World(storage)


class FakeRunner:
  stopped: list = []

  @classmethod
  def stop_jobs(cls, jobs, job_options):
    cls.stopped.append(job_options)


@pytest.fixture
def runners(monkeypatch):
  from qaboard.runners import runners
  FakeRunner.stopped = []
  monkeypatch.setenv('QABOARD_KUBERNETES_NAMESPACES', 'algo-qa')
  with mock.patch.dict(runners, {'kubernetes': FakeRunner, 'lsf': FakeRunner}):
    yield FakeRunner


def make_batch(world, data):
  from sqlalchemy.orm.attributes import flag_modified
  batch = world.batch('proj/a')
  world.run(batch, deleted=False, pending=True, user='alice')
  batch.data = data
  flag_modified(batch, "data")
  world.db.commit()
  return batch.id


def test_stop_a_kubernetes_batch(logged_in, world, runners):
  from backend.database import db_session
  from backend.models import Batch, Output
  alice = logged_in('alice')
  batch_id = make_batch(world, {
    "commands": {
      LSF_ID: {"runner": "lsf", "user": "alice"},
      K8S_ID: {"runner": "kubernetes", "namespace": "algo-qa", "context": "evil", "image": "x"},
    },
    "submissions": {
      DRIVER_ID: {"id": DRIVER_ID, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-33333333-driver", "namespace": "algo-qa", "user": "alice"},
    },
  })

  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  assert answer.status_code == 200, answer.get_json()
  # JSONB doesn't keep the order of keys. Kubernetes objects: only those of the batch's project
  assert sorted(runners.stopped, key=lambda options: options["command_id"]) == [
    {"type": "lsf", "command_id": LSF_ID, "bridge": "", "user": "alice"},
    {"type": "kubernetes", "command_id": K8S_ID, "bridge": "", "namespace": "algo-qa", "project": "proj/a", "api_retry_seconds": 15},
    {"type": "kubernetes", "command_id": DRIVER_ID, "bridge": "", "user": "alice", "namespace": "algo-qa", "project": "proj/a", "api_retry_seconds": 15},
  ]
  db_session.expire_all()
  batch = db_session.get(Batch, batch_id)
  assert batch.data["submissions"][DRIVER_ID]["status"] == "stopped"
  assert all(o.is_failed and not o.is_pending for o in db_session.query(Output).filter(Output.batch_id == batch_id))

  # nothing left to stop
  runners.stopped.clear()
  assert alice.post('/api/v1/batch/stop/', json={"id": batch_id}).get_json() == {}
  assert runners.stopped == []


def test_injected_kubernetes_commands_dont_block_stopping(logged_in, world, runners):
  """Commands are written by unauthenticated calls: one we may not stop is a warning, the LSF jobs are stopped as before"""
  from backend.database import db_session
  from backend.models import Output
  alice = logged_in('alice')
  batch_id = make_batch(world, {"commands": {
    LSF_ID: {"runner": "lsf", "user": "alice"},
    K8S_ID: {"runner": "kubernetes", "namespace": "kube-system"},
    "not-a-uuid": {"runner": "lsf"},
  }})

  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  assert answer.status_code == 200, answer.get_json()
  assert runners.stopped == [{"type": "lsf", "command_id": LSF_ID, "bridge": "", "user": "alice"}]
  warnings = answer.get_json()["warnings"]
  assert len(warnings) == 2 and any("kube-system" in w for w in warnings)
  db_session.expire_all()
  assert db_session.query(Output).filter(Output.batch_id == batch_id).one().is_failed
  # and the batch can be deleted
  assert alice.delete(f"/api/v1/batch/{batch_id}/").status_code == 200


def test_clients_cant_write_the_servers_batch_data(client, world):
  """POST /api/v1/batch is unauthenticated: it can't make the server stop drivers that don't exist"""
  from backend.database import db_session
  from backend.models import Batch, CiCommit
  forged = {
    "submissions": {DRIVER_ID: {"id": DRIVER_ID, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "x", "namespace": "algo-qa"}},
    "commands": {"replaced": {}},
    "submitted_by": {"user_name": "admin"},
    "best_iter": 3,
    "label_color": "red",
  }
  response = client.post('/api/v1/batch/', json={**batch_payload(), 'data': forged, 'command': {LSF_ID: {"runner": "lsf"}}})
  assert response.status_code == 200, response.get_data(as_text=True)
  db_session.remove()
  data = Batch.query.join(CiCommit).filter(CiCommit.project_id == PROJECT, CiCommit.hexsha == SHA, Batch.label == 'default').one().data
  assert "submissions" not in data and "submitted_by" not in data and "best_iter" not in data
  # commands come from `command`, merged
  assert data["commands"] == {LSF_ID: {"runner": "lsf"}}
  assert data["label_color"] == "red"



def test_stop_a_batch_started_on_the_server(logged_in, world, tmp_path, monkeypatch):
  """With QABOARD_TUNING_RUNNER=local or celery, `qa batch` runs on the server, detached: stopping the batch kills it"""
  import time
  import socket
  import psutil
  from sqlalchemy.orm.attributes import flag_modified
  from backend.database import db_session
  from backend.models import Batch, Output
  from backend.local_jobs import start_detached, qa_environment
  alice = logged_in('alice')
  batch = world.batch('proj/a')
  world.run(batch, deleted=False, pending=True, user='alice')
  log_dir = tmp_path / 'logs'
  log_dir.mkdir()
  script = log_dir / 'qa_batch.sh'
  script.write_text('#!/bin/bash\nsleep 600 & echo $! > child.pid\nwait\n')
  started = start_detached(script, log_dir, qa_environment('local-1'), wait=0.5)
  assert started['status'] == 'submitted'
  # one on another replica of the server
  other = {"id": "other-1", "runner": "celery", "status": "submitted", "pid": 1, "pgid": 1, "host": "other-replica", "log_dir": str(tmp_path / 'other')}
  batch.data = {"submissions": {
    "local-1": {"id": "local-1", "runner": "local", "log_dir": str(log_dir), "created_at": "2026-11-01T00:00:00Z", **started},
    "other-1": other,
  }}
  flag_modified(batch, "data")
  world.db.commit()
  batch_id = batch.id

  # the web app sees it runs
  from backend.models.Batch import with_log_dir_url
  assert with_log_dir_url(batch.data["submissions"]["local-1"])["status"] == "submitted"

  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  # the one on another replica keeps running: users are told
  assert answer.status_code == 500
  [error] = answer.get_json()["error"]
  assert "other-replica" in error and socket.gethostname() in error
  child = int((log_dir / 'child.pid').read_text())
  for _ in range(50):
    if not psutil.pid_exists(child) or psutil.Process(child).status() == psutil.STATUS_ZOMBIE:
      break
    time.sleep(0.1)
  else:
    raise AssertionError("qa batch's child still runs")
  db_session.expire_all()
  batch = db_session.get(Batch, batch_id)
  assert batch.data["submissions"]["local-1"]["status"] == "stopped"
  assert batch.data["submissions"]["other-1"]["status"] == "submitted"
  # runs may still run on the other replica
  assert db_session.query(Output).filter(Output.batch_id == batch_id).one().is_pending

  # once that one ended, stopping the batch fails its pending runs
  (tmp_path / 'other').mkdir()
  (tmp_path / 'other' / 'exit_code').write_text('0\n')
  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  assert answer.status_code == 200, answer.get_json()
  db_session.expire_all()
  assert db_session.query(Output).filter(Output.batch_id == batch_id).one().is_failed


def test_the_final_status_of_qa_batch_on_the_server_is_recorded(world, tmp_path):
  """Once `qa batch` ended, its status is read from storage once, then from the database"""
  from sqlalchemy import text
  from sqlalchemy.orm.attributes import flag_modified
  from backend.database import db_session
  from backend.models import Batch
  batch = world.batch('proj/a')
  log_dir = tmp_path / 'logs'
  log_dir.mkdir()
  submission = {"id": "local-1", "runner": "local", "status": "submitted", "pid": 1, "pgid": 1, "host": "other-replica",
                "log_dir": str(log_dir), "created_at": "2026-11-01T00:00:00Z"}
  batch.data = {"label_color": "red", "submissions": {"local-1": submission, "other-1": {**submission, "id": "other-1", "log_dir": str(tmp_path / 'x')}}}
  flag_modified(batch, "data")
  world.db.commit()
  batch_id = batch.id
  (log_dir / 'exit_code').write_text('3\n')

  # while the request's session holds the batch's row, we don't wait for it: next time
  db_session.execute(text("SELECT id FROM batches WHERE id = :id FOR UPDATE"), {"id": batch_id})
  assert db_session.get(Batch, batch_id).to_dict(db_session)["data"]["submissions"]["local-1"]["status"] == "failed"
  db_session.rollback()
  db_session.expire_all()
  assert db_session.get(Batch, batch_id).data["submissions"]["local-1"]["status"] == "submitted"

  serialized = db_session.get(Batch, batch_id).to_dict(db_session)["data"]["submissions"]["local-1"]
  assert (serialized["status"], serialized["exit_code"]) == ("failed", 3)
  db_session.expire_all()
  data = db_session.get(Batch, batch_id).data
  assert data["submissions"]["local-1"] == {**submission, "status": "failed", "exit_code": 3}
  # the rest is as it was
  assert data["submissions"]["other-1"]["status"] == "submitted" and data["label_color"] == "red"
  # we don't read the storage anymore
  (log_dir / 'exit_code').write_text('0\n')
  assert db_session.get(Batch, batch_id).to_dict(db_session)["data"]["submissions"]["local-1"]["exit_code"] == 3


def test_submissions_say_why_qa_batch_waits(world, tmp_path):
  """The runner of a driver that waits (e.g. a pending pod) says why in log.pending.txt: the web app shows it"""
  import datetime
  from sqlalchemy.orm.attributes import flag_modified
  from backend.database import db_session
  from backend.models import Batch
  batch = world.batch('proj/a')
  created_at = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=10)).replace(tzinfo=None).isoformat() + 'Z'
  batch.data = {"submissions": {DRIVER_ID: {"id": DRIVER_ID, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-33333333-driver",
                                            "namespace": "algo-qa", "log_dir": str(tmp_path), "created_at": created_at}}}
  flag_modified(batch, "data")
  world.db.commit()
  (tmp_path / 'log.pending.txt').write_text("The pod waits for a node with a GPU.\n")
  assert batch.to_dict(db_session)["data"]["submissions"][DRIVER_ID]["pending_note"] == "The pod waits for a node with a GPU."
  # after a day, it started or never will: we stop reading the storage
  batch.data["submissions"][DRIVER_ID]["created_at"] = "2026-11-01T00:00:00Z"
  flag_modified(batch, "data")
  world.db.commit()
  assert "pending_note" not in batch.to_dict(db_session)["data"]["submissions"][DRIVER_ID]
  batch.data["submissions"][DRIVER_ID]["created_at"] = created_at
  flag_modified(batch, "data")
  world.db.commit()
  (tmp_path / 'log.txt').write_text("qa batch\n")
  assert "pending_note" not in batch.to_dict(db_session)["data"]["submissions"][DRIVER_ID]
