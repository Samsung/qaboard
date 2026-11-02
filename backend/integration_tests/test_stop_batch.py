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
