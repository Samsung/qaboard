"""Where `qa` sends results (commits, batches, runs): ingest.auth modes, and who really sent them (data.submitted_by)"""
import os
from pathlib import Path

import pytest

from .conftest import new_token, bearer


PROJECT = 'group/repo'
SHA = 'b' * 40
STORAGE = Path(os.environ.get('QABOARD_STORAGE_ROOTS', '/tmp').split(':')[0])


def commit_payload(**extra):
  return {
    "project": PROJECT, "commit_sha": SHA, "commit_branch": "master",
    "commit_authored_datetime": "2026-10-01T12:00:00+00:00", "commit_message": "a commit",
    "commit_committer_name": "Alice", "commit_parents": [],
    **extra,
  }


def batch_payload(**extra):
  return commit_payload(batch_label="default", **extra)


def output_payload(**extra):
  return commit_payload(**{
    "batch_label": "default", "job_type": "local", "platform": "linux", "user": "alice",
    "configurations": ["base"], "extra_parameters": {}, "database": str(STORAGE / "database"),
    "rel_input_path": "inputs/a.txt", "input_type": "", "is_pending": False, "metrics": {"loss": 1.0},
    **extra,
  })


INGEST = {
  'commit': ('/api/v1/commit/', commit_payload),
  'batch': ('/api/v1/batch/', batch_payload),
  'output': ('/api/v1/output/', output_payload),
}


def saved_data(kind):
  """The `data` of the row each endpoint saved"""
  from backend.database import db_session
  from backend.models import CiCommit, Batch, Output
  db_session.remove()
  if kind == 'commit':
    return CiCommit.query.filter(CiCommit.project_id == PROJECT, CiCommit.hexsha == SHA).one().data
  if kind == 'batch':
    return Batch.query.join(CiCommit).filter(CiCommit.hexsha == SHA, Batch.label == 'default').one().data
  return Output.query.one().data


def send(client, kind, headers=None, **extra):
  url, payload = INGEST[kind]
  return client.post(url, json=payload(**extra), headers=headers or {})


def set_ingest_auth(monkeypatch, mode):
  if mode is None:
    monkeypatch.delenv('QABOARD_INGEST_AUTH', raising=False)
  else:
    monkeypatch.setenv('QABOARD_INGEST_AUTH', mode)


@pytest.mark.parametrize('kind', INGEST)
def test_anonymous_ingest_off(client, kind):
  """By default (ingest.auth=off), anonymous results are accepted, without submitted_by nor warning"""
  response = send(client, kind)
  assert response.status_code == 200, response.get_data(as_text=True)
  assert 'X-QABoard-Warning' not in response.headers
  assert 'submitted_by' not in saved_data(kind)


@pytest.mark.parametrize('kind', INGEST)
def test_anonymous_ingest_warn(client, monkeypatch, kind):
  """ingest.auth=warn accepts them, and tells the CLI to sign in"""
  set_ingest_auth(monkeypatch, 'warn')
  response = send(client, kind)
  assert response.status_code == 200, response.get_data(as_text=True)
  warning = response.headers.get('X-QABoard-Warning')
  assert warning and 'unverified' in warning and 'qa auth login' in warning
  assert 'submitted_by' not in saved_data(kind)


@pytest.mark.parametrize('kind', INGEST)
def test_anonymous_ingest_token(client, monkeypatch, kind):
  """ingest.auth=token refuses anonymous results, and saves nothing"""
  from backend.models import CiCommit, Batch, Output
  set_ingest_auth(monkeypatch, 'token')
  response = send(client, kind)
  assert response.status_code == 403
  body = response.get_json()
  assert body == {"error": "This server only accepts results sent with a token.", "reason": "ingest_token_required"}
  assert CiCommit.query.count() == 0 and Batch.query.count() == 0 and Output.query.count() == 0


@pytest.mark.parametrize('mode', [None, 'warn', 'token'])
@pytest.mark.parametrize('kind', INGEST)
def test_token_records_submitted_by(logged_in, make_client, monkeypatch, kind, mode):
  """With an ingest token, every mode records who sent the results, and doesn't warn"""
  set_ingest_auth(monkeypatch, mode)
  alice = logged_in('alice')
  token = new_token(alice, name="ci", scopes=["ingest"])
  response = send(make_client(), kind, headers=bearer(token["token"]))
  assert response.status_code == 200, response.get_data(as_text=True)
  assert 'X-QABoard-Warning' not in response.headers
  from backend.models import User
  alice_id = User.query.filter(User.user_name == 'alice').one().id
  assert saved_data(kind)["submitted_by"] == {
    "user_id": alice_id, "user_name": "alice", "token_id": token["id"], "token_name": "ci", "via": "token",
  }


@pytest.mark.parametrize('kind', INGEST)
def test_session_records_submitted_by(logged_in, kind):
  """A signed-in browser session is a verified sender too (via=session, no token)"""
  alice = logged_in('alice')
  response = send(alice, kind)
  assert response.status_code == 200, response.get_data(as_text=True)
  submitted_by = saved_data(kind)["submitted_by"]
  assert submitted_by["user_name"] == "alice" and submitted_by["via"] == "session"
  assert "token_id" not in submitted_by


FORGED = {"user_id": 666, "user_name": "mallory", "via": "token", "token_id": 1, "token_name": "forged"}


@pytest.mark.parametrize('kind', INGEST)
def test_cant_forge_submitted_by_anonymously(client, kind):
  """Clients can store any data, but not submitted_by"""
  response = send(client, kind, data={"submitted_by": FORGED, "other": "kept"})
  assert response.status_code == 200, response.get_data(as_text=True)
  data = saved_data(kind)
  assert 'submitted_by' not in data
  assert data.get("other") == "kept"


@pytest.mark.parametrize('kind', INGEST)
def test_cant_forge_submitted_by_with_token(logged_in, make_client, kind):
  """A token's user can't claim to be someone else either"""
  token = new_token(logged_in('alice'), name="ci", scopes=["ingest"])
  response = send(make_client(), kind, headers=bearer(token["token"]), data={"submitted_by": FORGED})
  assert response.status_code == 200, response.get_data(as_text=True)
  submitted_by = saved_data(kind)["submitted_by"]
  assert submitted_by["user_name"] == "alice" and submitted_by["token_id"] == token["id"]


def test_cant_forge_submitted_by_top_level(client):
  """Commits get the whole request as `data` in get_or_create: a top-level submitted_by isn't saved either"""
  response = send(client, 'commit', submitted_by=FORGED)
  assert response.status_code == 200, response.get_data(as_text=True)
  assert 'submitted_by' not in saved_data('commit')


def test_anonymous_run_clears_previous_submitter(logged_in, make_client):
  """A run re-sent anonymously is unverified again: it doesn't keep the previous sender"""
  token = new_token(logged_in('alice'), scopes=["ingest"])
  assert send(make_client(), 'output', headers=bearer(token["token"]), data={"job_options": {}}).status_code == 200
  assert saved_data('output')["submitted_by"]["user_name"] == "alice"
  assert send(make_client(), 'output', data={"job_options": {}}, user="mallory").status_code == 200
  data = saved_data('output')
  assert 'submitted_by' not in data and data["user"] == "mallory"


def test_anonymous_run_without_data_clears_previous_submitter(logged_in, make_client):
  """Same, for clients that don't send `data` with the run"""
  token = new_token(logged_in('alice'), scopes=["ingest"])
  assert send(make_client(), 'output', headers=bearer(token["token"])).status_code == 200
  assert send(make_client(), 'output', user="mallory").status_code == 200
  data = saved_data('output')
  assert 'submitted_by' not in data and data["user"] == "mallory"


@pytest.mark.parametrize('kind', INGEST)
def test_token_without_ingest_scope(logged_in, make_client, monkeypatch, kind):
  """In token mode it's a 403 missing_scope, in off mode the results are saved as unverified, with a warning"""
  token = new_token(logged_in('alice'), scopes=["read"])
  set_ingest_auth(monkeypatch, 'token')
  response = send(make_client(), kind, headers=bearer(token["token"]))
  assert response.status_code == 403
  body = response.get_json()
  assert body["reason"] == "missing_scope" and body["required"] == "ingest"

  set_ingest_auth(monkeypatch, None)
  response = send(make_client(), kind, headers=bearer(token["token"]))
  assert response.status_code == 200, response.get_data(as_text=True)
  warning = response.headers.get('X-QABoard-Warning')
  assert warning and '"ingest" scope' in warning and 'unverified' in warning
  assert 'submitted_by' not in saved_data(kind)


@pytest.mark.parametrize('kind', INGEST)
def test_token_restricted_to_other_projects(logged_in, make_client, monkeypatch, kind):
  """A token for other/* can't sign results of group/repo: 403 in token mode, unverified with a warning otherwise"""
  token = new_token(logged_in('alice'), scopes=["ingest"], projects=["other/*"])
  set_ingest_auth(monkeypatch, 'token')
  response = send(make_client(), kind, headers=bearer(token["token"]))
  assert response.status_code == 403
  assert response.get_json()["reason"] == "token_project"
  from backend.models import CiCommit
  assert CiCommit.query.count() == 0

  set_ingest_auth(monkeypatch, 'warn')
  response = send(make_client(), kind, headers=bearer(token["token"]))
  assert response.status_code == 200, response.get_data(as_text=True)
  assert PROJECT in response.headers.get('X-QABoard-Warning', '')
  assert 'submitted_by' not in saved_data(kind)


def test_token_for_the_project_pattern(logged_in, make_client, monkeypatch):
  """group/* covers group/repo"""
  set_ingest_auth(monkeypatch, 'token')
  token = new_token(logged_in('alice'), scopes=["ingest"], projects=["group/*"])
  response = send(make_client(), 'output', headers=bearer(token["token"]))
  assert response.status_code == 200, response.get_data(as_text=True)
  assert saved_data('output')["submitted_by"]["token_id"] == token["id"]


@pytest.mark.parametrize('reason', ['revoked', 'disabled'])
def test_unusable_token_is_never_ignored(logged_in, make_client, reason):
  """Even with ingest.auth=off, a broken token is a 401: silently saving unverified results would hide the problem"""
  alice = logged_in('alice')
  token = new_token(alice, scopes=["ingest"])
  from backend.database import db_session
  from backend.models import User
  if reason == 'revoked':
    assert alice.delete(f'/api/v1/user/tokens/{token["id"]}').status_code == 200
  else:
    User.query.filter(User.user_name == 'alice').update({"status": "disabled"})
    db_session.commit()
  response = send(make_client(), 'output', headers=bearer(token["token"]))
  assert response.status_code == 401
  assert response.get_json()["reason"] == {"revoked": "token_revoked", "disabled": "user_disabled"}[reason]


def test_ingest_with_sign_in_required(logged_in, make_client, monkeypatch):
  """Requiring sign-in leaves ingest open, unless ingest.auth=token"""
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  assert send(make_client(), 'output').status_code == 200
  token = new_token(logged_in('alice'), scopes=["ingest"])
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  response = send(make_client(), 'batch')
  assert response.status_code == 401 and response.get_json()["reason"] == "sign_in_required"
  assert send(make_client(), 'batch', headers=bearer(token["token"])).status_code == 200


def test_output_directory_in_storage(client, monkeypatch, tmp_path):
  """Runs say where they saved their outputs: inside $QABOARD_STORAGE_ROOTS it's accepted"""
  # conftest.py's storage root is inside $QABOARD_DATA_DIR, one of the server's private folders: it refuses it
  import backend.storage
  monkeypatch.setattr(backend.storage, 'storage_roots', [tmp_path])
  output_dir = tmp_path / "outputs" / "run-1"
  output_dir.mkdir(parents=True, exist_ok=True)
  response = send(client, 'output', output_directory=str(output_dir))
  assert response.status_code == 200, response.get_data(as_text=True)
  from backend.models import Output
  assert Output.query.one().output_dir_override == str(output_dir)


def test_runs_done_again_keep_one_row_and_a_trace_of_their_attempts(client, monkeypatch, tmp_path):
  """`qa` saves each attempt of a run in its own directory (qaboard/attempts.py): the run's row follows the latest"""
  import backend.storage
  from backend.database import db_session
  from backend.models import Output
  monkeypatch.setattr(backend.storage, 'storage_roots', [tmp_path])
  first = tmp_path / "outputs" / "linux" / "inputs-a"
  def report(output_dir, **extra):
    response = send(client, 'output', output_directory=str(output_dir), **extra)
    assert response.status_code == 200, response.get_data(as_text=True)
    db_session.remove()
    return response.get_json()

  run = report(first, metrics={"loss": 1.0, "is_failed": True})
  assert "attempt" not in run["data"] and "previous_attempts" not in run["data"]

  # `qa batch` says where the second attempt will be, then its `qa run` that it started and how it ended
  second = first.with_name("inputs-a_attempt2")
  report(second, is_pending=True, user="bob")
  report(second, is_pending=True, is_running=True, user="bob")
  again = report(second, metrics={"loss": 0.5}, user="bob", data={"attempt": 7, "previous_attempts": [], "storage": 10})
  assert again["id"] == run["id"] and Output.query.count() == 1
  assert again["output_dir_url"].endswith("/outputs/linux/inputs-a_attempt2")
  assert again["metrics"] == {"loss": 0.5} and again["is_failed"] is False
  # clients can't rewrite the attempts
  assert again["data"]["attempt"] == 2 and again["data"]["storage"] == 10
  previous, = again["data"]["previous_attempts"]
  assert (previous["attempt"], previous["status"], previous["user"]) == (1, "failed", "alice")
  assert previous["started_at"] and previous["finished_at"]

  # the ledger keeps what the earlier attempts measured
  assert previous["metrics"] == {"loss": 1.0, "is_failed": True}

  # a third attempt, that a fourth replaces before it says how it ended
  third, fourth = first.with_name("inputs-a_attempt3"), first.with_name("inputs-a_attempt4")
  report(third, is_pending=True, is_running=True)
  latest = report(fourth, is_pending=True, is_running=True)
  assert latest["data"]["attempt"] == 4
  attempts = latest["data"]["previous_attempts"]
  assert [(a["attempt"], a["status"], a["user"]) for a in attempts] == [(1, "failed", "alice"), (2, "success", "bob"), (3, "unfinished", "alice")]
  assert attempts[1]["metrics"] == {"loss": 0.5} and "metrics" not in attempts[2]
  assert not any(a.get("in_place") for a in attempts)

  # done again in the same folder, e.g. with --keep-previous: recorded too, viewers warn that files were replaced
  report(fourth, metrics={"loss": 0.2})
  in_place = report(fourth, is_pending=True, is_running=True)["data"]
  assert in_place["attempt"] == 4
  assert (in_place["previous_attempts"][-1]["in_place"], in_place["previous_attempts"][-1]["metrics"]) == (True, {"loss": 0.2})
  assert len(in_place["previous_attempts"]) == 4

  # deleting the run for good removes the latest attempt's folder, and the first attempt's that said where it was
  first.mkdir(parents=True)
  (first / "latest_attempt.txt").write_text("4\n")
  fourth.mkdir()
  (fourth / "out.txt").write_text("")
  output = Output.query.one()
  output.delete(soft=False)
  assert not fourth.exists() and not first.exists()


def test_output_directory_outside_storage(client):
  """Elsewhere it's refused, before anything is saved"""
  response = send(client, 'output', output_directory='/etc')
  assert response.status_code == 400
  assert 'QABOARD_STORAGE_ROOTS' in response.get_json()["error"]
  from backend.models import Output
  assert Output.query.count() == 0


@pytest.mark.parametrize('kind', ['commit', 'batch'])
def test_anonymous_updates_clear_the_verified_sender(logged_in, make_client, kind):
  """A batch or commit updated anonymously after a verified update doesn't stay "verified" (like runs)"""
  token = new_token(logged_in('alice'), scopes=["ingest"])
  assert send(make_client(), kind, headers=bearer(token["token"])).status_code == 200
  assert saved_data(kind)["submitted_by"]["user_name"] == "alice"
  assert send(make_client(), kind, user="mallory").status_code == 200
  assert 'submitted_by' not in saved_data(kind)


def test_batch_deletions_are_audited(logged_in, make_client):
  from backend.models import AuditEvent, Batch
  alice = logged_in('alice')
  assert send(make_client(), 'batch').status_code == 200
  batch_id = Batch.query.one().id
  assert alice.delete(f'/api/v1/batch/{batch_id}/').status_code == 200
  event = AuditEvent.query.filter_by(action='batch.delete').one()
  assert (event.actor_label, event.target_id, event.project_id, event.meta["commit"]) == ("alice", str(batch_id), PROJECT, SHA)
