"""
The final status of a `qa batch` the server ran itself is recorded in batch.data once read (local_jobs.persist_final_status),
with jsonb_set, in its own transaction, skipping batches whose row is locked.
"""
import time

import pytest

from .test_jobs import World, storage  # noqa: F401 (fixtures)

SUBMISSION_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def world(storage):
  return World(storage)


def make_batch(world, log_dir, **fields):
  from sqlalchemy.orm.attributes import flag_modified
  batch = world.batch('proj/a')
  batch.data = {
    "label_note": "kept",
    "submissions": {
      SUBMISSION_ID: {"id": SUBMISSION_ID, "runner": "local", "status": "submitted", "pid": 999999, "pgid": 999999,
                      "host": "another-replica", "log_dir": str(log_dir), "user": "alice", **fields},
      OTHER_ID: {"id": OTHER_ID, "runner": "local", "status": "submitted", "pid": 999998, "host": "another-replica", "log_dir": str(log_dir / "other")},
    },
  }
  flag_modified(batch, "data")
  world.db.commit()
  return batch.id


def stored(batch_id):
  """batch.data as it is in the database, not as a session remembers it"""
  from sqlalchemy import text
  from backend.database import engine
  with engine.connect() as connection:
    return connection.execute(text("SELECT data FROM batches WHERE id = :id"), {"id": batch_id}).scalar_one()


def test_the_final_status_is_recorded_once(world, storage):
  from backend.local_jobs import refresh_status, persist_final_status
  from backend.models.Batch import with_log_dir_url
  log_dir = storage / "log"
  log_dir.mkdir()
  (log_dir / "exit_code").write_text("3\n")
  batch_id = make_batch(world, log_dir)
  submission = stored(batch_id)["submissions"][SUBMISSION_ID]

  refreshed = refresh_status(submission)
  assert refreshed["status"] == "failed" and refreshed["exit_code"] == 3
  assert persist_final_status(batch_id, refreshed)
  data = stored(batch_id)
  # only its status changed: the rest of the submission, the other submissions, the rest of batch.data are kept
  assert data["submissions"][SUBMISSION_ID] == {**submission, "status": "failed", "exit_code": 3}
  assert data["submissions"][OTHER_ID]["status"] == "submitted"
  assert data["label_note"] == "kept"
  # once
  assert not persist_final_status(batch_id, refreshed)

  # later reads don't need the storage
  (log_dir / "exit_code").unlink()
  serialized = with_log_dir_url(data["submissions"][SUBMISSION_ID], batch_id)
  assert serialized["status"] == "failed" and serialized["exit_code"] == 3


def test_what_was_recorded_meanwhile_wins(world, storage):
  """e.g. the batch was stopped since we read it: we don't overwrite its status"""
  from sqlalchemy.orm.attributes import flag_modified
  from backend.local_jobs import persist_final_status
  from backend.models import Batch
  batch_id = make_batch(world, storage)
  batch = world.db.get(Batch, batch_id)
  batch.data = {**batch.data, "submissions": {**batch.data["submissions"], SUBMISSION_ID: {**batch.data["submissions"][SUBMISSION_ID], "status": "stopped"}}}
  flag_modified(batch, "data")
  world.db.commit()
  assert not persist_final_status(batch_id, {"id": SUBMISSION_ID, "status": "done", "exit_code": 0})
  assert stored(batch_id)["submissions"][SUBMISSION_ID]["status"] == "stopped"
  # nothing to do for submissions that aren't there, unknown batches, or what isn't final
  assert not persist_final_status(batch_id, {"id": "33333333-3333-4333-8333-333333333333", "status": "done"})
  assert not persist_final_status(batch_id + 1000, {"id": OTHER_ID, "status": "done"})
  assert not persist_final_status(batch_id, {"id": OTHER_ID, "status": "submitted"})
  assert stored(batch_id)["submissions"][OTHER_ID]["status"] == "submitted"


def test_locked_batches_are_skipped(world, storage):
  """If something holds the batch's row (e.g. the request's own session changed it), we don't wait: we record it next time"""
  from sqlalchemy.orm.attributes import flag_modified
  from backend.local_jobs import persist_final_status
  from backend.models import Batch
  batch_id = make_batch(world, storage)
  final = {"id": SUBMISSION_ID, "status": "done", "exit_code": 0}

  # the session's own uncommitted change locks the row
  batch = world.db.get(Batch, batch_id)
  batch.data = {**batch.data, "label_note": "changed"}
  flag_modified(batch, "data")
  world.db.flush()
  started = time.monotonic()
  assert not persist_final_status(batch_id, final)
  assert time.monotonic() - started < 5
  world.db.commit()
  assert stored(batch_id)["submissions"][SUBMISSION_ID]["status"] == "submitted"

  # another connection's SELECT ... FOR UPDATE too
  from sqlalchemy import text
  from backend.database import engine
  with engine.connect() as other:
    transaction = other.begin()
    other.execute(text("SELECT id FROM batches WHERE id = :id FOR UPDATE"), {"id": batch_id})
    assert not persist_final_status(batch_id, final)
    transaction.rollback()

  assert persist_final_status(batch_id, final)
  data = stored(batch_id)
  assert data["submissions"][SUBMISSION_ID]["status"] == "done" and data["submissions"][SUBMISSION_ID]["exit_code"] == 0
  assert data["label_note"] == "changed"


def test_serializing_the_batch_records_it(world, storage):
  """What the API does: Batch.to_dict -> with_log_dir_url -> persist_final_status"""
  from backend.database import db_session
  from backend.models import Batch
  log_dir = storage / "log"
  log_dir.mkdir()
  (log_dir / "exit_code").write_text("0")
  batch_id = make_batch(world, log_dir)
  serialized = db_session.get(Batch, batch_id).to_dict(db_session)
  assert serialized["data"]["submissions"][SUBMISSION_ID]["status"] == "done"
  assert serialized["data"]["submissions"][OTHER_ID]["status"] == "submitted"
  db_session.rollback()
  submission = stored(batch_id)["submissions"][SUBMISSION_ID]
  assert submission["status"] == "done" and submission["exit_code"] == 0
