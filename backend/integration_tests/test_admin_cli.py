"""`qaboard-admin`, administration from the server's shell"""
import datetime

import pytest
from click.testing import CliRunner

from .conftest import login, new_token, bearer


def run(*args, input=None):
  from backend.database import db_session
  from backend.scripts.admin import cli
  result = CliRunner().invoke(cli, list(args), input=input)
  # like a new process: the tests' requests don't see what the command left in the session
  db_session.remove()
  return result


def events(action=None):
  from backend.models import AuditEvent
  query = AuditEvent.query
  if action:
    query = query.filter(AuditEvent.action == action)
  return query.order_by(AuditEvent.id).all()


def test_create_admin_with_password(make_client):
  """Creates a local admin, who can log in and use the admin API"""
  result = run('create-admin', 'alice', '--password', '--email', 'alice@example.com', '--full-name', 'Alice A', input='s3cret-pw\n')
  assert result.exit_code == 0, result.output
  assert "alice is an admin" in result.output
  assert 's3cret-pw' not in result.output
  from backend.models import User
  user = User.query.filter(User.user_name == 'alice').one()
  assert user.is_admin and user.status == 'active' and user.login_type == 'LOCAL'
  assert user.email == 'alice@example.com' and user.full_name == 'Alice A'
  assert user.password and user.password != 's3cret-pw'

  client = login(make_client(), 'alice', 's3cret-pw')
  assert client.get('/api/v1/user/me/').get_json()["is_admin"] is True
  overview = client.get('/api/v1/admin/overview')
  assert overview.status_code == 200 and overview.get_json()["counts"]["admins"] == 1


def test_create_admin_is_audited_as_system():
  run('create-admin', 'alice', '--password', input='s3cret-pw\n')
  created, updated = events('user.create'), events('user.update')
  assert len(created) == 1 and len(updated) == 1
  for event in created + updated:
    assert event.actor_kind == 'system' and event.actor_label == 'qaboard-admin' and event.actor_user_id is None
    assert event.target_type == 'user' and event.target_label == 'alice'
  assert created[0].meta == {"login_type": "LOCAL"}
  assert updated[0].changes == {"is_admin": {"from": False, "to": True}}
  # never the password
  assert all('s3cret-pw' not in str((e.meta, e.changes)) for e in events())


def test_create_admin_empty_password():
  result = run('create-admin', 'alice', '--password', input='\n')
  assert result.exit_code != 0 and "can't be empty" in result.output
  from backend.models import User
  assert User.query.count() == 0


def test_create_admin_missing_user():
  """Without --password, the user must exist: a clear message says what to do"""
  result = run('create-admin', 'bob')
  assert result.exit_code == 1
  assert "No user 'bob'" in result.output and "--password" in result.output
  from backend.models import User
  assert User.query.count() == 0 and events() == []


def test_create_admin_existing_user(make_user, logged_in, make_client):
  """Makes an existing user an admin, and enables them if they were disabled"""
  make_user('bob', status='disabled')
  result = run('create-admin', 'bob')
  assert result.exit_code == 0, result.output
  from backend.models import User
  user = User.query.filter(User.user_name == 'bob').one()
  assert user.is_admin and user.status == 'active'
  assert events('user.update')[0].changes == {"is_admin": {"from": False, "to": True}, "status": {"from": "disabled", "to": "active"}}
  assert login(make_client(), 'bob').get('/api/v1/admin/users').status_code == 200
  # again: nothing changes, nothing is audited
  assert run('create-admin', 'bob').exit_code == 0
  assert len(events('user.update')) == 1


def test_create_admin_existing_user_keeps_password(make_user, make_client):
  """--password doesn't change an existing user's password"""
  make_user('bob', password='old-password')
  result = run('create-admin', 'bob', '--password', input='new-password\n')
  assert result.exit_code == 0, result.output
  login(make_client(), 'bob', 'old-password')


def test_remove_admin(make_user, make_client):
  make_user('bob', is_admin=True)
  bob = login(make_client(), 'bob')
  assert bob.get('/api/v1/admin/overview').status_code == 200
  result = run('remove-admin', 'bob')
  assert result.exit_code == 0, result.output
  assert "bob is not an admin anymore." in result.output
  assert bob.get('/api/v1/admin/overview').status_code == 403
  [event] = events('user.update')
  assert event.actor_kind == 'system' and event.changes == {"is_admin": {"from": True, "to": False}}
  # by email too, and nothing to do
  assert run('remove-admin', 'bob@example.com').exit_code == 0
  assert len(events('user.update')) == 1
  result = run('remove-admin', 'nobody')
  assert result.exit_code == 1 and "No user 'nobody'" in result.output


def test_remove_admin_from_env(make_user, monkeypatch):
  """Admins from QABOARD_ADMINS stay admins: the command says so"""
  monkeypatch.setenv('QABOARD_ADMINS', 'bob')
  make_user('bob', is_admin=True)
  result = run('remove-admin', 'bob')
  assert result.exit_code == 0 and "still in $QABOARD_ADMINS" in result.output


def test_list_admins(make_user, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'carol@example.com')
  make_user('alice', is_admin=True)
  make_user('bob')
  make_user('carol')
  make_user('dave', is_admin=True, status='disabled')
  result = run('list-admins')
  assert result.exit_code == 0, result.output
  lines = result.output.strip().splitlines()
  assert lines == ["alice\talice@example.com", "carol\tcarol@example.com\t(from $QABOARD_ADMINS)"]


def test_revoke_tokens(logged_in, make_client):
  alice = logged_in('alice')
  tokens = [new_token(alice, name=f"t{i}") for i in range(2)]
  bob_token = new_token(logged_in('bob'))
  result = run('revoke-tokens', 'alice')
  assert result.exit_code == 0, result.output
  assert "Revoked 2 tokens of alice." in result.output
  for token in tokens:
    response = make_client().get('/api/v1/user/me/', headers=bearer(token["token"]))
    assert response.status_code == 401 and response.get_json()["reason"] == "token_revoked"
  assert make_client().get('/api/v1/user/me/', headers=bearer(bob_token["token"])).status_code == 200
  revoked = events('token.revoke')
  assert len(revoked) == 2
  for event in revoked:
    assert event.actor_kind == 'system' and event.actor_label == 'qaboard-admin' and event.actor_user_id is None
    assert event.meta == {"user": "alice", "reason": "qaboard-admin"}
  assert "Revoked 0 tokens of alice." in run('revoke-tokens', 'alice').output
  result = run('revoke-tokens', 'nobody')
  assert result.exit_code == 1 and "No user 'nobody'" in result.output


def test_purge_audit(make_user):
  from backend.database import db_session
  from backend.models import AuditEvent
  now = datetime.datetime.utcnow()
  db_session.add(AuditEvent(actor_kind='system', actor_label='test', action='test.old', created_at=now - datetime.timedelta(days=3)))
  db_session.add(AuditEvent(actor_kind='system', actor_label='test', action='test.recent', created_at=now - datetime.timedelta(hours=1)))
  db_session.commit()
  result = run('purge-audit', '--days', '1')
  assert result.exit_code == 0, result.output
  assert "Deleted 1 events older than 1 days." in result.output
  assert [e.action for e in events() if e.action.startswith('test.')] == ['test.recent']


def test_purge_audit_default_retention():
  """By default, audit.retention_days (730)"""
  from backend.database import db_session
  from backend.models import AuditEvent
  now = datetime.datetime.utcnow()
  db_session.add(AuditEvent(actor_kind='system', action='test.ancient', created_at=now - datetime.timedelta(days=800)))
  db_session.add(AuditEvent(actor_kind='system', action='test.old', created_at=now - datetime.timedelta(days=400)))
  db_session.commit()
  result = run('purge-audit')
  assert result.exit_code == 0, result.output
  assert "older than 730 days" in result.output
  assert [e.action for e in events() if e.action.startswith('test.')] == ['test.old']
