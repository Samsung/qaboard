"""The admin API: who is an admin, users, tokens, the audit log, settings, the overview"""
import datetime

import pytest

from .conftest import login, new_token, bearer
from .test_sign_in_required import api_routes


def user_id(user_name):
  from backend.models import User
  return User.query.filter(User.user_name == user_name).one().id


@pytest.fixture
def admin(logged_in):
  """A client logged-in as `root`, an admin from the database"""
  return logged_in('root', is_admin=True)


# ---------------------------------------------------------------------------
# Who can use it
# ---------------------------------------------------------------------------

def test_every_admin_endpoint_needs_an_admin(app, logged_in, make_client):
  """Anonymous: 401 sign_in_required. Signed in but not an admin: 403 not_admin. And nothing happens."""
  from backend.models import Setting, User
  routes = api_routes(app, prefix='/api/v1/admin/')
  assert len({endpoint for _, _, endpoint in routes}) >= 11
  bob = logged_in('bob')
  bob_id = user_id('bob')
  wrong = []
  for url, method, endpoint in routes:
    url = url.replace('/users/1', f'/users/{bob_id}')
    body = {"is_admin": True, "status": "active", "auth.require_sign_in": True}
    response = make_client().open(url, method=method, json=body)
    if response.status_code != 401 or response.get_json().get('reason') != 'sign_in_required':
      wrong.append(f"anonymous {method} {url}: {response.status_code}")
    response = bob.open(url, method=method, json=body)
    answer = response.get_json() or {}
    if response.status_code != 403 or answer.get('reason') != 'not_admin' or not answer.get('error'):
      wrong.append(f"non-admin {method} {url}: {response.status_code} {answer}")
  assert not wrong, "\n".join(wrong)
  assert User.query.filter(User.user_name == 'bob').one().is_admin is False
  assert Setting.query.count() == 0


def test_admin_from_the_database(admin):
  assert admin.get('/api/v1/admin/overview').status_code == 200
  assert admin.get('/api/v1/user/me/').get_json()["is_admin"] is True


def directory_account(user_name):
  """Like users who signed in with LDAP or SAML: their emails come from the directory"""
  from backend.database import db_session
  from backend.models import User
  User.query.filter(User.user_name == user_name).update({"login_type": "LDAP"})
  db_session.commit()


@pytest.mark.parametrize('admins, directory', [
  ('carol', False),
  ('Carol@Example.com', True),
  ('someone, carol@example.com ,other', True),
])
def test_admins_from_env(logged_in, monkeypatch, admins, directory):
  """QABOARD_ADMINS lists user names, or the emails of directory accounts (in any case)"""
  carol = logged_in('carol')
  if directory:
    directory_account('carol')
  assert carol.get('/api/v1/admin/overview').status_code == 403
  monkeypatch.setenv('QABOARD_ADMINS', admins)
  assert carol.get('/api/v1/admin/overview').status_code == 200
  assert carol.get('/api/v1/user/me/').get_json()["is_admin"] is True
  user = carol.get(f'/api/v1/admin/users/{user_id("carol")}').get_json()["user"]
  assert user["is_admin"] is True and user["is_admin_from_env"] is True


@pytest.mark.parametrize('user_name, email, admins', [
  # local sign-up could create "ALICE" next to the admin "alice" (and "alice" before they sign in: test_access_policy.py)
  ('ALICE', 'a@example.com', 'alice'),
  # local sign-up doesn't verify emails
  ('mallory', 'boss@example.com', 'boss@example.com'),
])
def test_local_accounts_cant_pass_for_env_admins(client, make_user, monkeypatch, user_name, email, admins):
  monkeypatch.setenv('QABOARD_ADMINS', admins)
  response = client.post('/api/v1/user/signup/', data={"user_name": user_name, "password": "pw", "email": email})
  if user_name.casefold() in admins:
    # sign-up refuses the names in QABOARD_ADMINS, whatever their case
    assert response.status_code == 409
    make_user(user_name, password='pw', email=email)
  else:
    assert response.status_code == 200
  login(client, user_name, 'pw')
  assert client.get('/api/v1/user/me/').get_json()["is_admin"] is False
  assert client.get('/api/v1/admin/overview').status_code == 403


def test_user_names_are_unique_whatever_their_case(client, make_user):
  make_user('alice')
  response = client.post('/api/v1/user/signup/', data={"user_name": "Alice", "password": "pw"})
  assert response.status_code == 409


def test_disabled_admins_arent_admins(logged_in, make_client, monkeypatch):
  """Even from QABOARD_ADMINS: their token stops working"""
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root = logged_in('root')
  token = new_token(root, scopes=["read", "admin"])
  from backend.database import db_session
  from backend.models import User
  User.query.filter(User.user_name == 'root').update({"status": "disabled"})
  db_session.commit()
  response = make_client().get('/api/v1/admin/overview', headers=bearer(token["token"]))
  assert response.status_code == 401 and response.get_json()["reason"] == "user_disabled"


def test_admin_scope_token(admin, make_client):
  """An admin's token with the admin scope can use the admin API"""
  token = new_token(admin, name="admin-bot", scopes=["read", "admin"])
  client = make_client()
  response = client.get('/api/v1/admin/users', headers=bearer(token["token"]))
  assert response.status_code == 200
  assert [u["user_name"] for u in response.get_json()["users"]] == ["root"]
  response = client.post('/api/v1/admin/settings', json={"tokens.default_lifetime_days": 30}, headers=bearer(token["token"]))
  assert response.status_code == 200, response.get_json()
  from backend.models import AuditEvent
  event = AuditEvent.query.filter(AuditEvent.action == 'setting.update').one()
  assert event.actor_kind == 'token' and event.actor_token_id == token["id"] and event.actor_label == 'root'


def test_admin_token_without_admin_scope(admin, make_client):
  """403 missing_scope, even for an admin"""
  token = new_token(admin, scopes=["read", "act", "ingest"])
  response = make_client().get('/api/v1/admin/users', headers=bearer(token["token"]))
  assert response.status_code == 403
  body = response.get_json()
  assert body["reason"] == "missing_scope" and body["required"] == "admin"


def test_admin_token_of_a_demoted_admin(admin, logged_in, make_client):
  """The scope doesn't make anyone an admin: once demoted, their token gets 403 not_admin"""
  other_admin = logged_in('other', is_admin=True)
  token = new_token(admin, scopes=["read", "admin"])
  assert make_client().get('/api/v1/admin/users', headers=bearer(token["token"])).status_code == 200
  response = other_admin.post(f'/api/v1/admin/users/{user_id("root")}', json={"is_admin": False})
  assert response.status_code == 200, response.get_json()
  response = make_client().get('/api/v1/admin/users', headers=bearer(token["token"]))
  assert response.status_code == 403 and response.get_json()["reason"] == "not_admin"


def test_non_admins_cant_create_admin_tokens(logged_in):
  bob = logged_in('bob')
  response = bob.post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read", "admin"]})
  assert response.status_code == 403
  assert response.get_json()["reason"] == "not_admin"
  from backend.models import Token
  assert Token.query.count() == 0


def test_tokens_cant_change_admin_settings_without_admin_scope(admin, logged_in, make_client):
  """A non-admin's token with every scope it may have still can't use the admin API"""
  token = new_token(logged_in('bob'), scopes=["read", "act", "ingest"])
  response = make_client().post('/api/v1/admin/settings', json={"ingest.auth": "off"}, headers=bearer(token["token"]))
  assert response.status_code == 403 and response.get_json()["reason"] == "not_admin"


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

@pytest.fixture
def people(admin, make_user, logged_in, monkeypatch):
  """root (admin), alice and bob (signed in), carol (disabled), dave (pending, Dave Smith), erin (admin from env)"""
  logged_in('alice')
  logged_in('bob')
  make_user('carol', status='disabled')
  make_user('dave', full_name='Dave Smith', email='dsmith@corp.example', status='pending')
  make_user('erin', login_type='LDAP')
  monkeypatch.setenv('QABOARD_ADMINS', 'erin@example.com')
  return admin


def names(answer):
  return [u["user_name"] for u in answer["users"]]


def test_users_list(people):
  answer = people.get('/api/v1/admin/users').get_json()
  assert answer["total"] == 6
  # signed in first (the latest first), then the newest
  assert names(answer)[:3] == ["bob", "alice", "root"]
  assert set(names(answer)) == {"root", "alice", "bob", "carol", "dave", "erin"}
  user = next(u for u in answer["users"] if u["user_name"] == "dave")
  assert set(user) >= {"id", "user_name", "full_name", "email", "kind", "status", "is_admin", "is_admin_from_env",
                       "login_type", "created_date", "last_login_at", "active_tokens"}
  assert user["status"] == "pending" and user["last_login_at"] is None and user["kind"] == "human"
  assert "password" not in user and "data" not in user


@pytest.mark.parametrize('query,expected', [
  ('search=bo', ['bob']),
  ('search=SMITH', ['dave']),
  ('search=corp.example', ['dave']),
  ('search=nobody', []),
  ('status=disabled', ['carol']),
  ('status=pending', ['dave']),
  ('admin=true', ['erin', 'root']),
  ('admin=true&search=erin', ['erin']),
  ('status=active&search=r', ['erin', 'root']),
])
def test_users_filters(people, query, expected):
  answer = people.get(f'/api/v1/admin/users?{query}').get_json()
  assert sorted(names(answer)) == expected
  assert answer["total"] == len(expected)


def test_users_filters_validation(people):
  assert people.get('/api/v1/admin/users?status=banned').status_code == 400
  assert people.get('/api/v1/admin/users?limit=ten').status_code == 400


def test_users_pagination(people):
  """Pages don't overlap and cover everyone, `total` doesn't depend on the page"""
  everyone = names(people.get('/api/v1/admin/users').get_json())
  pages = []
  for offset in range(0, 8, 2):
    answer = people.get(f'/api/v1/admin/users?limit=2&offset={offset}').get_json()
    assert answer["total"] == 6
    assert len(answer["users"]) <= 2
    pages.extend(names(answer))
  assert pages == everyone


def test_user_detail(people, make_client):
  """The user, their tokens (never the secret) and their audit events"""
  bob = login(make_client(), 'bob')
  token = new_token(bob, name="laptop")
  answer = people.get(f'/api/v1/admin/users/{user_id("bob")}').get_json()
  assert answer["user"]["user_name"] == "bob" and answer["user"]["active_tokens"] == 1
  assert [(t["id"], t["name"], t["status"]) for t in answer["tokens"]] == [(token["id"], "laptop", "active")]
  assert "token" not in answer["tokens"][0] and "token_hash" not in answer["tokens"][0]
  actions = [e["action"] for e in answer["audit"]]
  assert actions[0] == "token.create" and actions.count("auth.login") == 2
  assert all(e["actor_user_id"] == user_id("bob") or e["target_id"] == str(user_id("bob")) for e in answer["audit"])
  assert people.get('/api/v1/admin/users/999999').status_code == 404


def test_user_detail_audit_includes_changes_by_others(people):
  """Events about them, e.g. an admin disabling them"""
  bob_id = user_id('bob')
  assert people.post(f'/api/v1/admin/users/{bob_id}', json={"status": "disabled"}).status_code == 200
  audit = people.get(f'/api/v1/admin/users/{bob_id}').get_json()["audit"]
  assert audit[0]["action"] == "user.update" and audit[0]["actor_label"] == "root"


def test_disable_a_user(people, make_client):
  bob = login(make_client(), 'bob')
  bob_id = user_id('bob')
  response = people.post(f'/api/v1/admin/users/{bob_id}', json={"status": "disabled"})
  assert response.status_code == 200, response.get_json()
  assert response.get_json()["status"] == "disabled" and response.get_json()["user_name"] == "bob"
  assert bob.get('/api/v1/user/preferences').status_code == 401
  from backend.models import AuditEvent
  event = AuditEvent.query.filter(AuditEvent.action == 'user.update').one()
  assert event.target_id == str(bob_id) and event.target_label == "bob" and event.actor_label == "root"
  assert event.changes == {"status": {"from": "active", "to": "disabled"}}
  # and back
  response = people.post(f'/api/v1/admin/users/{bob_id}', json={"status": "active"})
  assert response.get_json()["status"] == "active"
  login(bob, 'bob')


def test_make_admin(people, make_client):
  bob_id = user_id('bob')
  response = people.post(f'/api/v1/admin/users/{bob_id}', json={"is_admin": True})
  assert response.status_code == 200 and response.get_json()["is_admin"] is True
  bob = login(make_client(), 'bob')
  assert bob.get('/api/v1/admin/overview').status_code == 200
  response = people.post(f'/api/v1/admin/users/{bob_id}', json={"is_admin": False})
  assert response.get_json()["is_admin"] is False
  assert bob.get('/api/v1/admin/overview').status_code == 403
  from backend.models import AuditEvent
  changes = [e.changes for e in AuditEvent.query.filter(AuditEvent.action == 'user.update').order_by(AuditEvent.id)]
  assert changes == [{"is_admin": {"from": False, "to": True}}, {"is_admin": {"from": True, "to": False}}]


def test_no_change_no_event(people):
  """Saving the same values isn't audited"""
  response = people.post(f'/api/v1/admin/users/{user_id("bob")}', json={"status": "active", "is_admin": False})
  assert response.status_code == 200
  from backend.models import AuditEvent
  assert AuditEvent.query.filter(AuditEvent.action == 'user.update').count() == 0


@pytest.mark.parametrize('body,message', [
  ({"status": "disabled"}, "can't disable your own account"),
  ({"status": "pending"}, "can't disable your own account"),
  ({"is_admin": False}, "can't remove your own admin role"),
])
def test_admins_cant_lock_themselves_out(people, body, message):
  response = people.post(f'/api/v1/admin/users/{user_id("root")}', json=body)
  assert response.status_code == 400
  assert message in response.get_json()["error"]
  me = people.get('/api/v1/user/me/').get_json()
  assert me["is_admin"] is True and me["status"] == "active"


def test_env_admins_cant_be_demoted(people):
  """They're admins because of QABOARD_ADMINS: the sentence says so"""
  from backend.models import User
  erin_id = user_id('erin')
  response = people.post(f'/api/v1/admin/users/{erin_id}', json={"is_admin": False})
  assert response.status_code == 400
  assert "QABOARD_ADMINS" in response.get_json()["error"] and "erin" in response.get_json()["error"]
  # nor disabled: they're the break-glass access
  response = people.post(f'/api/v1/admin/users/{erin_id}', json={"status": "disabled"})
  assert response.status_code == 400 and "QABOARD_ADMINS" in response.get_json()["error"]
  assert User.query.filter(User.id == erin_id).one().status == "active"


@pytest.mark.parametrize('body', [{"status": "banned"}, {"is_admin": "yes"}, {"status": "disabled", "is_admin": "yes"}])
def test_update_validation(people, body):
  """Invalid values are 400s, and nothing is saved, even the valid fields"""
  from backend.database import db_session
  from backend.models import User, AuditEvent
  response = people.post(f'/api/v1/admin/users/{user_id("bob")}', json=body)
  assert response.status_code == 400 and response.get_json()["error"]
  db_session.remove()
  assert User.query.filter(User.user_name == 'bob').one().status == "active"
  assert AuditEvent.query.filter(AuditEvent.action == 'user.update').count() == 0


def test_update_unknown_user(people):
  assert people.post('/api/v1/admin/users/999999', json={"status": "disabled"}).status_code == 404


def test_revoke_user_tokens(people, make_client):
  bob = login(make_client(), 'bob')
  tokens = [new_token(bob, name=f"t{i}") for i in range(3)]
  assert bob.delete(f'/api/v1/user/tokens/{tokens[0]["id"]}').status_code == 200
  alice_token = new_token(login(make_client(), 'alice'))
  response = people.post(f'/api/v1/admin/users/{user_id("bob")}/revoke-tokens')
  assert response.status_code == 200
  assert response.get_json() == {"revoked": 2}
  for token in tokens:
    response = make_client().get('/api/v1/user/me/', headers=bearer(token["token"]))
    assert response.status_code == 401 and response.get_json()["reason"] == "token_revoked"
  assert make_client().get('/api/v1/user/me/', headers=bearer(alice_token["token"])).status_code == 200
  from backend.models import AuditEvent
  events = AuditEvent.query.filter(AuditEvent.action == 'token.revoke', AuditEvent.actor_label == 'root').all()
  assert sorted(int(e.target_id) for e in events) == [tokens[1]["id"], tokens[2]["id"]]
  assert all(e.meta == {"user": "bob", "reason": "admin"} for e in events)
  # again: nothing left to revoke
  assert people.post(f'/api/v1/admin/users/{user_id("bob")}/revoke-tokens').get_json() == {"revoked": 0}
  assert people.post('/api/v1/admin/users/999999/revoke-tokens').status_code == 404


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------

def test_tokens_list(people, make_client):
  alice = login(make_client(), 'alice')
  bob = login(make_client(), 'bob')
  a1 = new_token(alice, name="a1")
  b1 = new_token(bob, name="b1")
  b2 = new_token(bob, name="b2")
  bob.delete(f'/api/v1/user/tokens/{b1["id"]}')
  answer = people.get('/api/v1/admin/tokens').get_json()
  assert answer["total"] == 3
  assert [(t["name"], t["status"], t["user"]["user_name"]) for t in answer["tokens"]] == [
    ("b2", "active", "bob"), ("b1", "revoked", "bob"), ("a1", "active", "alice"),
  ]
  assert all("token" not in t for t in answer["tokens"])
  assert answer["tokens"][0]["user"]["id"] == user_id("bob")

  def listed(query):
    answer = people.get(f'/api/v1/admin/tokens?{query}').get_json()
    assert answer["total"] == len(answer["tokens"])
    return [t["id"] for t in answer["tokens"]]
  assert listed('status=active') == [b2["id"], a1["id"]]
  assert listed('status=revoked') == [b1["id"]]
  assert listed('status=expired') == []
  assert listed(f'user={user_id("bob")}') == [b2["id"], b1["id"]]
  assert listed(f'user={user_id("bob")}&status=active') == [b2["id"]]
  answer = people.get('/api/v1/admin/tokens?limit=1&offset=1').get_json()
  assert [t["id"] for t in answer["tokens"]] == [b1["id"]] and answer["total"] == 3
  assert people.get('/api/v1/admin/tokens?status=weird').status_code == 400
  assert people.get('/api/v1/admin/tokens?user=bob').status_code == 400


def test_tokens_list_expired(people, make_client):
  """The status depends on dates: expired and idle-expired tokens are filtered by what they are now"""
  from backend.database import db_session
  from backend.models import Token
  alice = login(make_client(), 'alice')
  expired = new_token(alice, name="expired")
  idle = new_token(alice, name="idle", idle_expiry_days=7)
  long_ago = datetime.datetime.utcnow() - datetime.timedelta(days=30)
  Token.query.filter(Token.id == expired["id"]).update({"expires_at": long_ago})
  Token.query.filter(Token.id == idle["id"]).update({"created_at": long_ago})
  db_session.commit()
  assert [t["name"] for t in people.get('/api/v1/admin/tokens?status=expired').get_json()["tokens"]] == ["expired"]
  assert [t["name"] for t in people.get('/api/v1/admin/tokens?status=idle_expired').get_json()["tokens"]] == ["idle"]
  assert people.get('/api/v1/admin/tokens?status=active').get_json()["total"] == 0
  # they aren't counted as active
  overview = people.get('/api/v1/admin/overview').get_json()
  assert overview["counts"]["active_tokens"] == 0
  assert people.get('/api/v1/admin/users?search=alice').get_json()["users"][0]["active_tokens"] == 0


def test_admin_revokes_a_token(people, make_client):
  bob = login(make_client(), 'bob')
  token = new_token(bob, name="laptop")
  response = people.delete(f'/api/v1/admin/tokens/{token["id"]}')
  assert response.status_code == 200
  answer = response.get_json()
  assert answer["status"] == "revoked" and answer["revoked_at"] and answer["user"]["user_name"] == "bob"
  response = make_client().get('/api/v1/projects', headers=bearer(token["token"]))
  assert response.status_code == 401 and response.get_json()["reason"] == "token_revoked"
  # the user sees it revoked
  assert bob.get('/api/v1/user/tokens').get_json()["tokens"][0]["status"] == "revoked"
  from backend.models import Token
  assert Token.query.filter(Token.id == token["id"]).one().revoked_by_id == user_id("root")
  assert people.delete('/api/v1/admin/tokens/999999').status_code == 404


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def test_audit_list_and_filters(people, make_client):
  bob = login(make_client(), 'bob')
  token = new_token(bob, name="laptop")
  bob.delete(f'/api/v1/user/tokens/{token["id"]}')
  people.post(f'/api/v1/admin/users/{user_id("alice")}', json={"status": "disabled"})
  make_client().post('/api/v1/user/auth/', data={"username": "bob", "password": "wrong"})

  def actions(query=''):
    answer = people.get(f'/api/v1/admin/audit?{query}').get_json()
    return [e["action"] for e in answer["events"]]
  everything = actions()
  # newest first
  assert everything[:4] == ["auth.login_failed", "user.update", "token.revoke", "token.create"]
  assert actions('action=token') == ["token.revoke", "token.create"]
  assert actions('action=token.create') == ["token.create"]
  assert actions('action=auth') == [a for a in everything if a.startswith('auth.')]
  assert actions('action=tok') == []
  assert set(actions('actor=bob')) == {"token.revoke", "token.create", "auth.login"}
  assert actions('actor=root&action=user') == ["user.update"]
  assert actions('target_type=token') == ["token.revoke", "token.create"]
  # sign-ins are about their user too
  assert actions(f'target_type=user&target_id={user_id("alice")}') == ["user.update", "auth.login"]

  event = people.get('/api/v1/admin/audit?action=user.update').get_json()["events"][0]
  assert set(event) >= {"id", "created_at", "actor_kind", "actor_user_id", "actor_label", "actor_token_id", "ip",
                        "user_agent", "action", "target_type", "target_id", "target_label", "project_id", "changes", "meta"}
  assert event["actor_kind"] == "user" and event["actor_user_id"] == user_id("root") and event["target_label"] == "alice"
  assert event["ip"] == "127.0.0.1" and event["created_at"].endswith("+00:00")


def test_audit_keyset_pagination(people, make_client):
  """`next_before_id` gives the next page, until it's null"""
  bob = login(make_client(), 'bob')
  for i in range(4):
    new_token(bob, name=f"t{i}")
  from backend.models import AuditEvent
  total = AuditEvent.query.count()
  assert total >= 8
  ids, before_id, pages = [], None, 0
  while True:
    answer = people.get('/api/v1/admin/audit?limit=3' + (f'&before_id={before_id}' if before_id else '')).get_json()
    pages += 1
    assert len(answer["events"]) <= 3
    ids.extend(e["id"] for e in answer["events"])
    before_id = answer["next_before_id"]
    if before_id is None:
      break
    assert before_id == answer["events"][-1]["id"]
  assert ids == sorted(ids, reverse=True) and len(set(ids)) == len(ids) == total
  assert pages == -(-total // 3)
  # with a filter
  answer = people.get('/api/v1/admin/audit?action=token&limit=2').get_json()
  assert [e["target_label"] for e in answer["events"]] == ["t3", "t2"] and answer["next_before_id"]
  answer = people.get(f'/api/v1/admin/audit?action=token&limit=2&before_id={answer["next_before_id"]}').get_json()
  assert [e["target_label"] for e in answer["events"]] == ["t1", "t0"] and answer["next_before_id"] is None
  assert people.get('/api/v1/admin/audit?before_id=abc').status_code == 400


def test_audit_actions_facet(people, make_client):
  new_token(login(make_client(), 'bob'))
  actions = people.get('/api/v1/admin/audit/actions').get_json()["actions"]
  assert actions == sorted(set(actions))
  assert {"auth.login", "token.create"} <= set(actions)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def settings_by_key(client):
  return {s["key"]: s for s in client.get('/api/v1/admin/settings').get_json()["settings"]}


def test_settings_list(admin):
  settings = settings_by_key(admin)
  assert set(settings) == {
    'auth.require_sign_in', 'auth.local_signup', 'auth.allowed_origins', 'ingest.auth',
    'tokens.default_lifetime_days', 'tokens.max_lifetime_days', 'tokens.cli_idle_expiry_days', 'audit.retention_days',
    'auth.access_policy', 'auth.allowed_email_domains', 'auth.access_request_webhook', 'auth.sso_auto_redirect',
    'sessions.idle_days', 'sessions.max_days', 'projects.default_visibility', 'projects.signed_in_role',
    'storage.exports_root', 'storage.others_visible_to', 'jobs.failure_emails', 'jobs.failure_email_to',
  }
  assert all(s["source"] == "default" and s["editable"] and s["description"] for s in settings.values())
  assert settings["auth.require_sign_in"]["value"] is False and settings["auth.require_sign_in"]["env"] == "QABOARD_LOGIN_REQUIRED"
  assert settings["ingest.auth"]["value"] == "off" and settings["ingest.auth"]["choices"] == ["off", "warn", "token"]
  assert settings["tokens.default_lifetime_days"]["value"] == 90
  assert settings["tokens.max_lifetime_days"]["value"] is None
  assert settings["tokens.cli_idle_expiry_days"]["value"] == 180
  assert settings["audit.retention_days"]["value"] == 730
  assert settings["auth.local_signup"]["value"] is True


@pytest.mark.parametrize('body,message', [
  ({"tokens.max_lifetime_days": 0}, "at least 1"),
  ({"tokens.default_lifetime_days": "90"}, "whole number"),
  ({"tokens.default_lifetime_days": True}, "whole number"),
  ({"audit.retention_days": 7}, "at least 30"),
  ({"ingest.auth": "maybe"}, "off, warn, token"),
  ({"auth.require_sign_in": "yes"}, "true or false"),
  ({"auth.allowed_origins": "https://a.example"}, "list"),
  ({"no.such.setting": 1}, "Unknown setting"),
  ({}, "null resets"),
  (["ingest.auth"], "null resets"),
  ({"tokens.default_lifetime_days": 30, "ingest.auth": "maybe"}, "off, warn, token"),
])
def test_settings_validation(admin, body, message):
  """400 with a sentence, and nothing is saved"""
  from backend.database import db_session
  from backend.models import Setting, AuditEvent
  response = admin.post('/api/v1/admin/settings', json=body)
  assert response.status_code == 400
  assert message in response.get_json()["error"]
  db_session.remove()
  assert Setting.query.count() == 0
  assert AuditEvent.query.filter(AuditEvent.action == 'setting.update').count() == 0
  assert settings_by_key(admin)["tokens.default_lifetime_days"]["value"] == 90


def test_secret_settings_are_never_shown(admin):
  """Webhook URLs are credentials: admins see the host, the audit log too"""
  from backend.models import AuditEvent
  from backend.settings import setting
  url = 'https://hooks.slack.com/services/T000/B000/XXXX'
  response = admin.post('/api/v1/admin/settings', json={"auth.access_request_webhook": url})
  assert response.status_code == 200
  described = {s["key"]: s for s in response.get_json()["settings"]}["auth.access_request_webhook"]
  assert described["value"] == 'https://hooks.slack.com/…' and described["secret"] is True
  assert setting('auth.access_request_webhook') == url
  event = AuditEvent.query.filter(AuditEvent.action == 'setting.update').one()
  assert 'XXXX' not in str(event.changes) and event.changes["value"]["to"] == 'https://hooks.slack.com/…'
  # saving what's shown would lose the real URL
  response = admin.post('/api/v1/admin/settings', json={"auth.access_request_webhook": 'https://hooks.slack.com/…'})
  assert response.status_code == 400 and "hidden" in response.get_json()["error"]
  assert setting('auth.access_request_webhook') == url
  assert 'XXXX' not in admin.get('/api/v1/admin/settings').get_data(as_text=True)


def test_settings_update_reset_and_audit(admin):
  response = admin.post('/api/v1/admin/settings', json={"tokens.max_lifetime_days": 30, "ingest.auth": "warn"})
  assert response.status_code == 200, response.get_json()
  settings = {s["key"]: s for s in response.get_json()["settings"]}
  assert settings["tokens.max_lifetime_days"]["value"] == 30 and settings["tokens.max_lifetime_days"]["source"] == "database"
  assert settings["ingest.auth"]["value"] == "warn" and settings["ingest.auth"]["source"] == "database"
  from backend.models import AuditEvent, Setting
  events = {e.target_id: e for e in AuditEvent.query.filter(AuditEvent.action == 'setting.update')}
  assert events["tokens.max_lifetime_days"].changes == {"value": {"from": None, "to": 30}}
  assert events["ingest.auth"].changes == {"value": {"from": "off", "to": "warn"}}
  assert all(e.actor_label == "root" and e.target_type == "setting" for e in events.values())
  assert Setting.query.filter(Setting.key == 'ingest.auth').one().updated_by_id == user_id("root")
  assert admin.get('/api/v1/config').get_json()["ingest_auth"] == "warn"

  # same value: no event
  admin.post('/api/v1/admin/settings', json={"ingest.auth": "warn"})
  assert AuditEvent.query.filter(AuditEvent.action == 'setting.update').count() == 2

  # null resets to the default
  response = admin.post('/api/v1/admin/settings', json={"ingest.auth": None, "tokens.max_lifetime_days": None})
  settings = {s["key"]: s for s in response.get_json()["settings"]}
  assert settings["ingest.auth"]["value"] == "off" and settings["ingest.auth"]["source"] == "default"
  assert settings["tokens.max_lifetime_days"]["value"] is None and settings["tokens.max_lifetime_days"]["source"] == "default"
  assert Setting.query.count() == 0
  event = AuditEvent.query.filter(AuditEvent.action == 'setting.update', AuditEvent.target_id == 'ingest.auth').order_by(AuditEvent.id.desc()).first()
  assert event.changes == {"value": {"from": "warn", "to": "off"}}
  # resetting what's already the default is fine
  assert admin.post('/api/v1/admin/settings', json={"ingest.auth": None}).status_code == 200


def test_settings_from_env_are_read_only(admin, monkeypatch):
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  monkeypatch.setenv('QABOARD_DISABLE_SIGNUP', '1')
  settings = settings_by_key(admin)
  assert settings["ingest.auth"] == {**settings["ingest.auth"], "value": "token", "source": "env", "editable": False}
  assert settings["auth.local_signup"]["value"] is False and settings["auth.local_signup"]["source"] == "env"
  response = admin.post('/api/v1/admin/settings', json={"ingest.auth": "off"})
  assert response.status_code == 400
  assert "$QABOARD_INGEST_AUTH" in response.get_json()["error"]
  response = admin.post('/api/v1/admin/settings', json={"ingest.auth": None})
  assert response.status_code == 400
  from backend.models import Setting
  assert Setting.query.count() == 0


def test_env_wins_over_database_settings(admin, monkeypatch):
  """A database value set before the environment variable stays, but the environment wins"""
  admin.post('/api/v1/admin/settings', json={"ingest.auth": "warn"})
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  setting = settings_by_key(admin)["ingest.auth"]
  assert setting["value"] == "token" and setting["source"] == "env"


def test_max_token_lifetime_takes_effect(admin, logged_in):
  bob = logged_in('bob')
  response = bob.post('/api/v1/user/tokens', json={"name": "forever", "scopes": ["read"], "expires_in_days": None})
  assert response.status_code == 201 and response.get_json()["expires_at"] is None
  assert admin.post('/api/v1/admin/settings', json={"tokens.max_lifetime_days": 30}).status_code == 200

  response = bob.post('/api/v1/user/tokens', json={"name": "forever", "scopes": ["read"], "expires_in_days": None})
  assert response.status_code == 400 and "at most 30 days" in response.get_json()["error"]
  response = bob.post('/api/v1/user/tokens', json={"name": "long", "scopes": ["read"], "expires_in_days": 60})
  assert response.status_code == 400 and "30 days" in response.get_json()["error"]
  # the default (90 days) is capped
  token = new_token(bob, scopes=["read"])
  expires_at = datetime.datetime.fromisoformat(token["expires_at"])
  days = (expires_at - datetime.datetime.now(datetime.timezone.utc)).days
  assert 29 <= days <= 30


def test_default_token_lifetime_takes_effect(admin, logged_in):
  admin.post('/api/v1/admin/settings', json={"tokens.default_lifetime_days": 7})
  token = new_token(logged_in('bob'), scopes=["read"])
  days = (datetime.datetime.fromisoformat(token["expires_at"]) - datetime.datetime.now(datetime.timezone.utc)).days
  assert 6 <= days <= 7


def test_local_signup_setting_takes_effect(admin, make_client):
  admin.post('/api/v1/admin/settings', json={"auth.local_signup": False})
  response = make_client().post('/api/v1/user/signup/', data={"user_name": "eve", "password": "pw"})
  assert response.status_code == 403 and response.get_json()["reason"] == "signup_disabled"
  assert make_client().get('/api/v1/config').get_json()["local_signup"] is False


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------

def test_overview(people, make_client):
  new_token(login(make_client(), 'bob'))
  overview = people.get('/api/v1/admin/overview').get_json()
  # root, alice, bob signed in; erin is an admin from the env; carol disabled; dave pending
  assert overview["counts"] == {"users": 6, "active_30d": 3, "admins": 2, "pending": 1, "disabled": 1, "active_tokens": 1}
  checklist = {item["id"]: item for item in overview["checklist"]}
  assert set(checklist) >= {"require_sign_in", "ingest_auth", "https", "secret_key", "legacy_tokens", "local_signup"}
  for item in overview["checklist"]:
    assert item["severity"] in ("info", "warning", "danger") and item["title"]
    # what to do about it
    assert item["ok"] or item["detail"]
    assert isinstance(item["ok"], bool)
  assert checklist["require_sign_in"]["ok"] is False and checklist["require_sign_in"]["severity"] == "warning"
  assert checklist["ingest_auth"]["ok"] is False
  assert checklist["secret_key"]["ok"] is True
  assert checklist["legacy_tokens"]["ok"] is True
  assert checklist["local_signup"]["ok"] is True
  # the test server has no QABOARD_WEBHOOK_SECRET
  assert checklist["webhook_secret"]["ok"] is False and "QABOARD_WEBHOOK_SECRET" in checklist["webhook_secret"]["detail"]


def test_overview_checklist_follows_settings(admin, monkeypatch):
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  # set when the server starts, from QABOARD_URL=https://... or QABOARD_COOKIE_SECURE
  from backend import app
  monkeypatch.setitem(app.config, 'SESSION_COOKIE_SECURE', True)
  checklist = {item["id"]: item for item in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  for id in ["require_sign_in", "ingest_auth", "https"]:
    assert checklist[id]["ok"] is True and checklist[id]["severity"] == "info", id
  # sign-in required, but anyone can create a local account
  assert checklist["local_signup"]["ok"] is False and "qaboard-admin create-admin" in checklist["local_signup"]["detail"]


def test_overview_checklist_says_what_to_do_next(admin, monkeypatch):
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'warn')
  checklist = {item["id"]: item for item in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert '"token"' in checklist["ingest_auth"]["detail"] and '"warn"' not in checklist["ingest_auth"]["detail"]


@pytest.mark.parametrize('value', ['Token', ' warn '])
def test_env_settings_ignore_case_and_spaces(admin, monkeypatch, value):
  monkeypatch.setenv('QABOARD_INGEST_AUTH', value)
  settings = {s["key"]: s for s in admin.get('/api/v1/admin/settings').get_json()["settings"]}
  assert settings["ingest.auth"]["value"] == value.strip().lower() and settings["ingest.auth"]["source"] == "env"


def test_invalid_env_settings_are_reported(admin, monkeypatch):
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'tokens')
  overview = admin.get('/api/v1/admin/overview').get_json()
  item = next(i for i in overview["checklist"] if i["id"] == "invalid_env:ingest.auth")
  assert item["severity"] == "danger" and "QABOARD_INGEST_AUTH" in item["title"] and "'tokens'" in item["detail"]
  settings = {s["key"]: s for s in admin.get('/api/v1/admin/settings').get_json()["settings"]}
  assert settings["ingest.auth"]["error"] and settings["ingest.auth"]["source"] == "default"


def test_overview_legacy_tokens(admin):
  """Tokens from before scopes are flagged"""
  from backend.database import db_session
  from backend.models import Token
  db_session.add(Token(token_hash='f' * 64, prefix='abcd', kind='legacy', name='old', user_id=user_id('root')))
  db_session.commit()
  checklist = {item["id"]: item for item in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert checklist["legacy_tokens"]["ok"] is False and "1 legacy token" in checklist["legacy_tokens"]["title"]


def test_pgadmin_signs_admins_in(admin, logged_in, monkeypatch):
  """nginx asks before proxying /pgadmin4/ (services/nginx/snippets/pgadmin.conf), and passes the account to pgAdmin"""
  # Flower and other admin services (services/nginx/snippets/qaboard-admins-only.conf)
  assert admin.get('/api/v1/admin/authorize').status_code == 204
  assert logged_in('carol').get('/api/v1/admin/authorize').status_code == 403
  monkeypatch.delenv('QABOARD_PGADMIN_USER', raising=False)
  monkeypatch.delenv('PGADMIN_DEFAULT_EMAIL', raising=False)
  assert admin.get('/api/v1/admin/pgadmin/authorize').status_code == 404
  monkeypatch.setenv('PGADMIN_DEFAULT_EMAIL', 'pgadmin@example.com')
  response = admin.get('/api/v1/admin/pgadmin/authorize')
  assert response.status_code == 204 and response.headers['X-Pgadmin-User'] == 'pgadmin@example.com'
  response = logged_in('bob').get('/api/v1/admin/pgadmin/authorize')
  assert response.status_code == 403 and 'X-Pgadmin-User' not in response.headers
