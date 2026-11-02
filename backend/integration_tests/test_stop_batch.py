"""Stopping batches (Batch.stop): the runner gets only validated options, and Kubernetes drivers are deleted too"""
from unittest import mock

import pytest

from .test_jobs import World, storage  # noqa: F401 (fixtures)


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


def test_stop_a_kubernetes_batch(logged_in, world, runners):
  from sqlalchemy.orm.attributes import flag_modified
  from backend.database import db_session
  from backend.models import Batch, Output
  alice = logged_in('alice')
  batch = world.batch('proj/a')
  world.run(batch, deleted=False, pending=True, user='alice')
  batch.data = {
    "commands": {
      "lsf-command": {"runner": "lsf", "user": "alice"},
      "k8s-command": {"runner": "kubernetes", "namespace": "algo-qa", "context": "evil", "image": "x"},
    },
    "submissions": {
      "driver": {"id": "driver", "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-driver-driver", "namespace": "algo-qa", "user": "alice"},
    },
  }
  flag_modified(batch, "data")
  world.db.commit()

  batch_id = batch.id
  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  assert answer.status_code == 200, answer.get_json()
  # JSONB doesn't keep the order of keys
  assert sorted(runners.stopped, key=lambda options: options["command_id"]) == [
    {"type": "kubernetes", "command_id": "driver", "bridge": "", "user": "alice", "namespace": "algo-qa"},
    {"type": "kubernetes", "command_id": "k8s-command", "bridge": "", "namespace": "algo-qa"},
    {"type": "lsf", "command_id": "lsf-command", "bridge": "", "user": "alice"},
  ]
  db_session.expire_all()
  batch = db_session.get(Batch, batch_id)
  assert batch.data["submissions"]["driver"]["status"] == "stopped"
  assert all(o.is_failed and not o.is_pending for o in db_session.query(Output).filter(Output.batch_id == batch_id))

  # nothing left to stop
  runners.stopped.clear()
  assert alice.post('/api/v1/batch/stop/', json={"id": batch_id}).get_json() == {}
  assert runners.stopped == []


def test_kubernetes_batches_in_other_namespaces_keep_running(logged_in, world, runners):
  from sqlalchemy.orm.attributes import flag_modified
  from backend.database import db_session
  from backend.models import Output
  alice = logged_in('alice')
  batch = world.batch('proj/a')
  world.run(batch, deleted=False, pending=True, user='alice')
  batch.data = {"commands": {"k8s-command": {"runner": "kubernetes", "namespace": "kube-system"}}}
  flag_modified(batch, "data")
  world.db.commit()

  batch_id = batch.id
  answer = alice.post("/api/v1/batch/stop/", json={"id": batch_id})
  assert answer.status_code == 500
  assert "kube-system" in answer.get_json()["error"][0]
  assert runners.stopped == []
  # users can try again once the admins allowed it
  db_session.expire_all()
  assert db_session.query(Output).filter(Output.batch_id == batch_id).one().is_pending


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
