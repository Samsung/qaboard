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
    {"type": "kubernetes", "command_id": K8S_ID, "bridge": "", "namespace": "algo-qa", "project": "proj/a"},
    {"type": "kubernetes", "command_id": DRIVER_ID, "bridge": "", "user": "alice", "namespace": "algo-qa", "project": "proj/a"},
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
