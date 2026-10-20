"""What users manage about themselves: preferences, and their own audit log"""
import datetime

import pytest

from .conftest import login, new_token, bearer


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------

def save(client, preferences, **kwargs):
  return client.post('/api/v1/user/preferences', json={"preferences": preferences}, **kwargs)


def test_preferences_start_empty(logged_in):
  answer = logged_in('alice').get('/api/v1/user/preferences').get_json()
  assert answer == {"preferences": {}, "updated_at": None}


def test_preferences_merge(logged_in):
  """Top-level keys are merged, values are replaced as a whole, null removes a key"""
  alice = logged_in('alice')
  answer = save(alice, {"theme": "dark", "favorites": ["a", "b"], "tuning": {"x": 1, "y": 2}}).get_json()
  assert answer["preferences"] == {"theme": "dark", "favorites": ["a", "b"], "tuning": {"x": 1, "y": 2}}
  answer = save(alice, {"favorites": ["c"], "tuning": {"x": 3}, "commitListDensity": "compact"}).get_json()
  assert answer["preferences"] == {"theme": "dark", "favorites": ["c"], "tuning": {"x": 3}, "commitListDensity": "compact"}
  answer = save(alice, {"theme": None, "not-there": None}).get_json()
  assert answer["preferences"] == {"favorites": ["c"], "tuning": {"x": 3}, "commitListDensity": "compact"}
  # falsy values aren't removals
  answer = save(alice, {"siderCollapsed": False, "count": 0, "name": ""}).get_json()
  assert answer["preferences"]["siderCollapsed"] is False and answer["preferences"]["count"] == 0 and answer["preferences"]["name"] == ""
  assert alice.get('/api/v1/user/preferences').get_json() == answer


def test_preferences_are_saved_in_the_database(logged_in):
  alice = logged_in('alice')
  save(alice, {"theme": "dark"})
  from backend.models import User
  user = User.query.filter(User.user_name == 'alice').one()
  assert user.preferences == {"theme": "dark"} and user.preferences_updated_at is not None


def test_preferences_follow_the_user(logged_in, make_client):
  """Another browser (another session) sees them"""
  alice = logged_in('alice')
  save(alice, {"theme": "dark"})
  other_browser = login(make_client(), 'alice')
  assert other_browser.get('/api/v1/user/preferences').get_json()["preferences"] == {"theme": "dark"}


def test_preferences_are_per_user(logged_in):
  save(logged_in('alice'), {"theme": "dark"})
  assert logged_in('bob').get('/api/v1/user/preferences').get_json()["preferences"] == {}


def test_preferences_updated_at(logged_in):
  alice = logged_in('alice')
  before = datetime.datetime.now(datetime.timezone.utc)
  first = save(alice, {"theme": "dark"}).get_json()["updated_at"]
  updated_at = datetime.datetime.fromisoformat(first)
  assert updated_at.tzinfo is not None
  assert before - datetime.timedelta(seconds=5) <= updated_at <= datetime.datetime.now(datetime.timezone.utc)
  second = save(alice, {"theme": "light"}).get_json()["updated_at"]
  assert datetime.datetime.fromisoformat(second) >= updated_at
  assert alice.get('/api/v1/user/preferences').get_json()["updated_at"] == second


def test_preferences_size_limit(logged_in):
  """64 KiB at most, in total: a 413 saves nothing"""
  alice = logged_in('alice')
  save(alice, {"theme": "dark"})
  response = save(alice, {"big": "x" * (64 * 1024)})
  assert response.status_code == 413
  assert "64 KiB" in response.get_json()["error"]
  assert alice.get('/api/v1/user/preferences').get_json()["preferences"] == {"theme": "dark"}
  # just under the limit is fine
  assert save(alice, {"big": "x" * (60 * 1024)}).status_code == 200
  # the limit is on the merged preferences
  assert save(alice, {"big2": "x" * (10 * 1024)}).status_code == 413
  # removing keys makes room
  assert save(alice, {"big": None, "big2": "x" * (10 * 1024)}).status_code == 200


@pytest.mark.parametrize('body', [{}, {"preferences": ["theme"]}, {"preferences": "dark"}, {"theme": "dark"}])
def test_preferences_validation(logged_in, body):
  alice = logged_in('alice')
  response = alice.post('/api/v1/user/preferences', json=body)
  assert response.status_code == 400 and "preferences" in response.get_json()["error"]


@pytest.mark.parametrize('method', ['GET', 'POST'])
def test_preferences_anonymous(client, method):
  response = client.open('/api/v1/user/preferences', method=method, json={"preferences": {"theme": "dark"}})
  assert response.status_code == 401
  assert response.get_json()["reason"] == "sign_in_required"


def test_preferences_with_tokens(logged_in, make_client):
  """Tokens read them with `read`, change them with `act`"""
  alice = logged_in('alice')
  reader = new_token(alice, scopes=["read"])
  writer = new_token(alice, scopes=["read", "act"])
  client = make_client()
  assert client.get('/api/v1/user/preferences', headers=bearer(reader["token"])).status_code == 200
  response = save(client, {"theme": "dark"}, headers=bearer(reader["token"]))
  assert response.status_code == 403
  assert response.get_json()["reason"] == "missing_scope" and response.get_json()["required"] == "act"
  assert save(client, {"theme": "dark"}, headers=bearer(writer["token"])).status_code == 200
  assert alice.get('/api/v1/user/preferences').get_json()["preferences"] == {"theme": "dark"}


# ---------------------------------------------------------------------------
# The user's own audit log
# ---------------------------------------------------------------------------

def my_events(client, query=''):
  response = client.get(f'/api/v1/user/audit{query}')
  assert response.status_code == 200, response.get_json()
  return response.get_json()


def test_my_audit_events(logged_in, make_client):
  """Sign-ins and tokens, newest first, and not other users' events"""
  alice = logged_in('alice')
  token = new_token(alice, name="laptop")
  alice.delete(f'/api/v1/user/tokens/{token["id"]}')
  bob = logged_in('bob')
  new_token(bob, name="bob's")
  make_client().post('/api/v1/user/auth/', data={"username": "bob", "password": "wrong"})

  answer = my_events(alice)
  assert [e["action"] for e in answer["events"]] == ["token.revoke", "token.create", "auth.login"]
  assert answer["next_before_id"] is None
  from backend.models import User
  alice_id = User.query.filter(User.user_name == 'alice').one().id
  login_event = answer["events"][-1]
  assert login_event["actor_user_id"] == alice_id and login_event["actor_kind"] == "user"
  assert login_event["meta"]["provider"] == "local" and login_event["ip"] == "127.0.0.1"
  assert answer["events"][1]["target_label"] == "laptop" and answer["events"][1]["meta"]["scopes"] == ["read", "ingest", "act"]

  # failed attempts on my account are mine to see
  bob_actions = [e["action"] for e in my_events(bob)["events"]]
  assert bob_actions == ["auth.login_failed", "token.create", "auth.login"]
  assert all(e["target_label"] != "laptop" for e in my_events(bob)["events"])


def test_my_audit_includes_events_about_me(logged_in, make_client, monkeypatch):
  """An admin disabling then enabling me shows up in my log"""
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root = logged_in('root')
  alice = logged_in('alice')
  from backend.models import User
  alice_id = User.query.filter(User.user_name == 'alice').one().id
  root.post(f'/api/v1/admin/users/{alice_id}', json={"status": "disabled"})
  root.post(f'/api/v1/admin/users/{alice_id}', json={"status": "active"})
  login(alice, 'alice')
  events = my_events(alice)["events"]
  assert [e["action"] for e in events][:3] == ["auth.login", "user.update", "user.update"]
  assert events[1]["actor_label"] == "root"


def test_my_audit_token_events(logged_in, make_client):
  """What my tokens did (e.g. used from a new IP) is in my log"""
  alice = logged_in('alice')
  token = new_token(alice)
  make_client().get('/api/v1/user/me/', headers=bearer(token["token"]), environ_base={"REMOTE_ADDR": "10.0.0.1"})
  from backend.database import db_session
  from backend.models import Token
  Token.query.filter(Token.id == token["id"]).update({"last_used_at": datetime.datetime.utcnow() - datetime.timedelta(hours=1)})
  db_session.commit()
  make_client().get('/api/v1/user/me/', headers=bearer(token["token"]), environ_base={"REMOTE_ADDR": "10.0.0.2"})
  event = my_events(alice)["events"][0]
  assert event["action"] == "token.new_ip" and event["actor_kind"] == "token" and event["actor_token_id"] == token["id"]
  assert event["meta"] == {"previous_ip": "10.0.0.1"} and event["ip"] == "10.0.0.2"


def test_my_audit_pagination(logged_in):
  alice = logged_in('alice')
  for i in range(5):
    new_token(alice, name=f"t{i}")
  page = my_events(alice, '?limit=4')
  assert [e["target_label"] for e in page["events"]] == ["t4", "t3", "t2", "t1"]
  page = my_events(alice, f'?limit=4&before_id={page["next_before_id"]}')
  assert [e["action"] for e in page["events"]] == ["token.create", "auth.login"] and page["next_before_id"] is None


def test_my_audit_anonymous(client):
  response = client.get('/api/v1/user/audit')
  assert response.status_code == 401 and response.get_json()["reason"] == "sign_in_required"


def test_failed_logins_are_audited(client, make_user):
  """Wrong password, unknown user: auth.login_failed, with the user name they typed, linked to the account if it exists"""
  from backend.models import AuditEvent, User
  make_user('alice')
  for user_name in ['alice', 'nobody']:
    response = client.post('/api/v1/user/auth/', data={"username": user_name, "password": "wrong"})
    assert response.status_code == 403
  events = AuditEvent.query.filter(AuditEvent.action == 'auth.login_failed').order_by(AuditEvent.id).all()
  alice_id = str(User.query.filter(User.user_name == 'alice').one().id)
  assert [(e.target_type, e.target_id, e.target_label, e.actor_kind, e.actor_user_id) for e in events] == [
    ("user", alice_id, "alice", "anonymous", None), ("user", None, "nobody", "anonymous", None),
  ]
  assert all(e.ip == "127.0.0.1" and e.meta["login_type"] == "LOCAL" for e in events)


def test_failed_login_reasons(client, make_user):
  """Admins can tell password guessing on an account from typos in user names"""
  from backend.models import AuditEvent
  make_user('alice')
  client.post('/api/v1/user/auth/', data={"username": "alice", "password": "wrong"})
  client.post('/api/v1/user/auth/', data={"username": "nobody", "password": "wrong"})
  events = AuditEvent.query.filter(AuditEvent.action == 'auth.login_failed').order_by(AuditEvent.id).all()
  assert [e.meta["reason"] for e in events] == ["invalid-password", "invalid-username"]


def test_the_audit_never_contains_passwords(client, make_user, logged_in, monkeypatch):
  """Search the whole audit_events table for the passwords people typed"""
  from sqlalchemy import text
  from backend.database import db_session
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  password = 'S3cret-Pa55word-xyzzy'
  make_user('alice', password=password)
  client.post('/api/v1/user/auth/', data={"username": "alice", "password": password + "-typo"})
  login(client, 'alice', password)
  client.post('/api/v1/user/signup/', data={"user_name": "bob", "password": password + "-bob", "email": "b@example.com"})
  token = new_token(client, name="laptop")
  logged_in('root').post('/api/v1/admin/settings', json={"tokens.default_lifetime_days": 30})
  client.delete(f'/api/v1/user/tokens/{token["id"]}')
  client.post('/api/v1/user/logout/')
  dump = db_session.execute(text("SELECT string_agg(audit_events::text, '\n') FROM audit_events")).scalar()
  assert 'auth.login_failed' in dump and 'auth.login' in dump and 'auth.signup' in dump and 'auth.logout' in dump
  assert password not in dump
  assert token["token"] not in dump and token["token"][12:] not in dump
