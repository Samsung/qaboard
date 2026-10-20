"""API tokens: created from sessions, hashed, scoped, restricted to projects, expiring, revocable"""
import datetime

from .conftest import new_token, bearer, make_projects


def test_tokens_are_shown_once_and_stored_hashed(logged_in, make_client):
  from backend.models import Token
  client = logged_in('alice')
  answer = new_token(client, name="laptop", scopes=["read", "ingest"])
  secret = answer["token"]
  assert secret.startswith("qab_pat_") and answer["prefix"] == secret[:12]
  assert answer["scopes"] == ["read", "ingest"] and answer["status"] == "active"
  token = Token.query.one()
  assert token.token is None and token.token_hash != secret and secret not in str(token.data)
  # never again
  listed = client.get('/api/v1/user/tokens').get_json()["tokens"]
  assert [t["name"] for t in listed] == ["laptop"] and "token" not in listed[0]
  me = make_client().get('/api/v1/user/me/', headers=bearer(secret)).get_json()
  assert me["user_name"] == "alice" and me["token"]["name"] == "laptop"


def test_the_default_expiry(logged_in):
  answer = new_token(logged_in('alice'))
  expires_at = datetime.datetime.fromisoformat(answer["expires_at"])
  assert 89 <= (expires_at - datetime.datetime.now(datetime.timezone.utc)).days <= 90
  answer = new_token(logged_in('bob'), expires_in_days=None)
  assert answer["expires_at"] is None


def test_creating_tokens_needs_a_session(logged_in, make_client):
  secret = new_token(logged_in('alice'))["token"]
  response = make_client().post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read"]}, headers=bearer(secret))
  assert response.status_code == 403 and response.get_json()["reason"] == "session_required"
  response = make_client().post('/api/v1/user/token/', headers=bearer(secret))
  assert response.status_code == 403
  assert make_client().post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read"]}).status_code == 401


def test_invalid_token_requests(logged_in):
  client = logged_in('alice')
  for body, message in [
    ({"scopes": ["read"]}, "name"),
    ({"name": "x"}, "scopes"),
    ({"name": "x", "scopes": ["read", "fly"]}, "Unknown scopes: fly"),
    ({"name": "x", "scopes": ["read"], "expires_in_days": 0}, "expires_in_days"),
    ({"name": "x", "scopes": ["read"], "projects": "group/repo"}, None),
    ({"name": "x", "scopes": ["read"], "projects": [1]}, "projects"),
  ]:
    response = client.post('/api/v1/user/tokens', json=body)
    if message is None:
      assert response.status_code == 201 and response.get_json()["projects"] == ["group/repo"]
    else:
      assert response.status_code == 400 and message in response.get_json()["error"], body
  response = client.post('/api/v1/user/tokens', json={"name": "x", "scopes": ["admin"]})
  assert response.status_code == 403 and response.get_json()["reason"] == "not_admin"


def test_broken_tokens_are_refused_with_a_reason(logged_in, make_client):
  from backend.database import db_session
  from backend.models import Token
  client = logged_in('alice')
  secret = new_token(client)["token"]
  anonymous = make_client()

  def reason(token):
    response = anonymous.get('/api/v1/projects', headers=bearer(token))
    assert response.status_code == 401
    return response.get_json()["reason"]

  assert reason("nonsense") == "token_invalid"
  # a valid checksum, but unknown
  from backend import tokens
  assert reason(tokens.generate()) == "token_invalid"
  # a typo breaks the checksum
  assert reason(secret[:-1] + ("A" if secret[-1] != "A" else "B")) == "token_invalid"

  def update_token(**fields):
    # each request ends the database session: we load the token again
    Token.query.filter(Token.id == token_id).update(fields)
    db_session.commit()

  token_id = Token.query.one().id
  update_token(expires_at=datetime.datetime.utcnow() - datetime.timedelta(minutes=1))
  assert reason(secret) == "token_expired"

  update_token(expires_at=None, idle_expiry_days=30, last_used_at=datetime.datetime.utcnow() - datetime.timedelta(days=31))
  assert reason(secret) == "token_idle_expired"

  update_token(idle_expiry_days=None)
  assert anonymous.get('/api/v1/projects', headers=bearer(secret)).status_code == 200
  assert client.delete(f'/api/v1/user/tokens/{token_id}').get_json()["status"] == "revoked"
  assert reason(secret) == "token_revoked"


def test_tokens_remember_when_they_were_used(logged_in, make_client):
  from backend.models import Token, AuditEvent
  secret = new_token(logged_in('alice'))["token"]
  make_client().get('/api/v1/projects', headers={**bearer(secret), "X-Forwarded-For": "10.0.0.1"})
  token = Token.query.one()
  assert token.last_used_at is not None and token.last_used_ip == "10.0.0.1"
  # at most every few minutes, even from other IPs: tokens shared by CI runners change IPs all the time
  make_client().get('/api/v1/projects', headers={**bearer(secret), "X-Forwarded-For": "10.0.0.2"})
  assert Token.query.one().last_used_ip == "10.0.0.1"
  assert AuditEvent.query.filter_by(action='token.new_ip').count() == 0
  from backend.database import db_session
  Token.query.update({"last_used_at": datetime.datetime.utcnow() - datetime.timedelta(minutes=6)})
  db_session.commit()
  make_client().get('/api/v1/projects', headers={**bearer(secret), "X-Forwarded-For": "10.0.0.2"})
  assert Token.query.one().last_used_ip == "10.0.0.2"
  assert AuditEvent.query.filter_by(action='token.new_ip').one().meta == {"previous_ip": "10.0.0.1"}


def test_scopes(logged_in, make_client):
  from backend.database import db_session
  from backend.models import Project
  db_session.add(Project(id='group/repo', data={}))
  db_session.commit()
  client = logged_in('alice')
  milestone = {"project": "group/repo", "commit": "a" * 40, "label": "v1"}

  read_only = new_token(client, scopes=["read"])["token"]
  response = make_client().post('/api/v1/milestones', json=milestone, headers=bearer(read_only))
  assert response.status_code == 403
  assert response.get_json() == {"error": "This token can't do this: it needs the \"act\" scope.", "reason": "missing_scope", "required": "act"}
  assert make_client().get('/api/v1/milestones?project=group/repo', headers=bearer(read_only)).status_code == 200

  ingest_only = new_token(client, scopes=["ingest"])["token"]
  response = make_client().get('/api/v1/projects', headers=bearer(ingest_only))
  assert response.status_code == 403 and response.get_json()["required"] == "read"
  # it can still say who it is
  assert make_client().get('/api/v1/user/me/', headers=bearer(ingest_only)).get_json()["user_name"] == "alice"

  act = new_token(client, scopes=["read", "act"])["token"]
  assert make_client().post('/api/v1/milestones', json=milestone, headers=bearer(act)).status_code == 201


def test_project_restrictions(logged_in, make_client):
  make_projects('group/repo', 'group/repo/sub', 'other/repo')
  client = logged_in('alice')
  secret = new_token(client, projects=["group/repo"])["token"]
  projects = make_client().get('/api/v1/projects', headers=bearer(secret)).get_json()
  assert set(projects) == {'group/repo', 'group/repo/sub'}
  response = make_client().post('/api/v1/milestones?project=other/repo', json={"project": "other/repo", "commit": "a" * 40}, headers=bearer(secret))
  assert response.status_code == 403
  assert make_client().get('/api/v1/milestones?project=other/repo', headers=bearer(secret)).status_code == 403


def test_a_token_only_revokes_itself(logged_in, make_client):
  client = logged_in('alice')
  first, second = new_token(client), new_token(client)
  response = make_client().delete(f'/api/v1/user/tokens/{second["id"]}', headers=bearer(first["token"]))
  assert response.status_code == 403
  response = make_client().delete(f'/api/v1/user/tokens/{first["id"]}', headers=bearer(first["token"]))
  assert response.status_code == 200 and response.get_json()["status"] == "revoked"
  # other users' tokens don't exist for you
  other = logged_in('bob')
  assert other.delete(f'/api/v1/user/tokens/{second["id"]}').status_code == 404


def test_token_events_are_audited(logged_in):
  from backend.models import AuditEvent
  client = logged_in('alice')
  token = new_token(client, name="ci")
  client.delete(f'/api/v1/user/tokens/{token["id"]}')
  events = [(e.action, e.actor_label, e.target_label) for e in AuditEvent.query.order_by(AuditEvent.id) if e.action.startswith('token.')]
  assert events == [("token.create", "alice", "ci"), ("token.revoke", "alice", "ci")]
  assert all(token["token"] not in str(e.meta) for e in AuditEvent.query)


def test_max_lifetime(logged_in, monkeypatch):
  from backend.database import db_session
  from backend.models import Setting
  from backend import settings
  db_session.add(Setting(key='tokens.max_lifetime_days', value={"value": 30}))
  db_session.commit()
  settings.invalidate_cache()
  client = logged_in('alice')
  response = client.post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read"], "expires_in_days": None})
  assert response.status_code == 400 and "30 days" in response.get_json()["error"]
  response = client.post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read"], "expires_in_days": 31})
  assert response.status_code == 400
  # the default (90 days) is capped
  expires_at = datetime.datetime.fromisoformat(new_token(client)["expires_at"])
  assert (expires_at - datetime.datetime.now(datetime.timezone.utc)).days <= 30


def test_the_manage_scope_isnt_offered_until_it_does_something(logged_in):
  response = logged_in('alice').post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read", "manage"]})
  assert response.status_code == 400 and "manage" in response.get_json()["error"]


def test_me_says_when_the_token_expires(logged_in, make_client):
  token = new_token(logged_in('alice'), expires_in_days=None, idle_expiry_days=30)
  me = make_client().get('/api/v1/user/me/', headers=bearer(token["token"])).get_json()["token"]
  assert me["expires_at"] is None and me["idle_expiry_days"] == 30 and me["last_used_at"]


def test_the_config_says_how_long_tokens_last(client):
  from backend.database import db_session
  from backend.models import Setting
  from backend import settings
  assert client.get('/api/v1/config').get_json()["tokens"] == {"default_lifetime_days": 90, "max_lifetime_days": None}
  db_session.add(Setting(key='tokens.max_lifetime_days', value={"value": 30}))
  db_session.commit()
  settings.invalidate_cache()
  assert client.get('/api/v1/config').get_json()["tokens"] == {"default_lifetime_days": 90, "max_lifetime_days": 30}


def test_errors_say_when_tokens_expired(logged_in, make_client):
  from backend.database import db_session
  from backend.models import Token
  token = new_token(logged_in('alice'))
  Token.query.update({"expires_at": datetime.datetime(2026, 9, 1)})
  db_session.commit()
  response = make_client().get('/api/v1/projects', headers=bearer(token["token"]))
  assert response.get_json() == {"error": "This token expired on 2026-09-01.", "reason": "token_expired"}
