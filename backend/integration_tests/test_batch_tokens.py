"""
The tokens of the batches QA-Board starts (tokens.mint_for_batch): revoked when the batch is stopped, ending soon
after its runs end, and the only way its driver sends its log when it doesn't see the server's storage.
"""
import datetime

import pytest

from .conftest import bearer
from .test_ingest import output_payload, PROJECT
from .test_jobs import storage  # noqa: F401 (fixture)

COMMAND_ID = "44444444-4444-4444-8444-444444444444"


def batch_token(user_name, command_id=COMMAND_ID, **data):
  """A batch token of `user_name`, as mint_for_batch makes them"""
  from backend.database import db_session
  from backend.models import User
  from backend import tokens
  user = User.query.filter(User.user_name == user_name).one()
  token, secret = tokens.mint(user, name="Batch", scopes=['read', 'ingest'], kind='batch', projects=[PROJECT],
                              expires_at=tokens.utcnow() + datetime.timedelta(days=30), idle_expiry_days=1,
                              data={"command_id": command_id, **data})
  db_session.commit()
  return token.id, secret


def stored(token_id):
  from backend.database import db_session
  from backend.models import Token
  db_session.expire_all()
  return db_session.get(Token, token_id)


def is_revoked(token_id):
  return stored(token_id).revoked


def ends_soon(token_id):
  from backend import tokens
  return stored(token_id).expires_at <= tokens.utcnow() + tokens.ENDED_BATCH_GRACE


def test_the_token_ends_soon_after_the_batchs_last_run_ends(logged_in, make_client):
  logged_in('alice', is_admin=True)
  token_id, secret = batch_token('alice')
  client = make_client()
  run = lambda input_path, pending: client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(
    rel_input_path=input_path, is_pending=pending, data={"root_command_id": COMMAND_ID}))
  # `qa batch` tells QA-Board about all its runs before it starts them
  for input_path in ("inputs/a.txt", "inputs/b.txt"):
    assert run(input_path, True).status_code == 200
  assert run("inputs/a.txt", False).status_code == 200
  assert not ends_soon(token_id)
  assert run("inputs/b.txt", False).status_code == 200
  # its driver may still send the end of its log
  assert ends_soon(token_id) and not is_revoked(token_id)


def test_qa_optimize_and_redo_keep_their_token_until_stopped(logged_in, make_client):
  logged_in('alice', is_admin=True)
  token_id, secret = batch_token('alice', until_stopped=True)
  payload = output_payload(is_pending=False, data={"root_command_id": COMMAND_ID})
  assert make_client().post('/api/v1/output/', headers=bearer(secret), json=payload).status_code == 200
  assert not ends_soon(token_id)


@pytest.fixture
def log_dir(storage):
  directory = storage / "output" / "qaboard-batches" / f"20261118-100000-{COMMAND_ID[:8]}"
  directory.mkdir(parents=True)
  return directory


def test_the_driver_sends_its_log_with_the_batchs_token(logged_in, make_client, log_dir, tmp_path):
  alice = logged_in('alice', is_admin=True)
  _, secret = batch_token('alice', log_dir=str(log_dir))
  client = make_client()
  url = f"/api/v1/batch/submissions/{COMMAND_ID}/log"
  answer = client.put(f"{url}?offset=0", headers=bearer(secret), data=b"hello\n")
  assert answer.status_code == 200 and answer.get_json() == {"size": 6}
  assert client.put(f"{url}?offset=6", headers=bearer(secret), data=b"world\n").get_json() == {"size": 12}
  assert (log_dir / "log.txt").read_text() == "hello\nworld\n"
  # the server wrote in it meanwhile: the driver goes on after it
  answer = client.put(f"{url}?offset=6", headers=bearer(secret), data=b"again\n")
  assert answer.status_code == 409 and answer.get_json()["size"] == 12

  # only the batch's own token
  _, other_batch = batch_token('alice', command_id="55555555-5555-4555-8555-555555555555", log_dir=str(log_dir))
  assert client.put(f"{url}?offset=12", headers=bearer(other_batch), data=b"x").status_code == 403
  personal = alice.post('/api/v1/user/tokens', json={"name": "t", "scopes": ["read", "ingest", "act"]}).get_json()["token"]
  assert client.put(f"{url}?offset=12", headers=bearer(personal), data=b"x").status_code == 403
  assert alice.put(f"{url}?offset=12", data=b"x", headers={"Origin": "http://localhost"}).status_code == 403
  assert client.put(f"{url}?offset=12", data=b"x").status_code in (401, 403)
  # into a folder of the storage only
  _, outside = batch_token('alice', log_dir=str(tmp_path))
  assert client.put(f"{url}?offset=0", headers=bearer(outside), data=b"x").status_code == 400
  assert (log_dir / "log.txt").read_text() == "hello\nworld\n"
