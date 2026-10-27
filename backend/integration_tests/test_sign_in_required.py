"""auth.require_sign_in for real (every /api/ route), disabled users, cross-site writes, tokens in URLs and cookies"""
import re

import pytest
from werkzeug.exceptions import NotFound, MethodNotAllowed
from werkzeug.routing import RequestRedirect

from .conftest import login, new_token, bearer, make_projects


PLACEHOLDERS = {'IntegerConverter': '1', 'PathConverter': 'a/b'}


def api_routes(app, prefix='/api/'):
  """(url, method, endpoint) for every rule under `prefix`, with placeholder values, and the endpoint it reaches"""
  adapter = app.url_map.bind('localhost')
  routes = set()
  for rule in app.url_map.iter_rules():
    if not rule.rule.startswith(prefix):
      continue
    url = re.sub(r'<(?:[^:<>]+:)?([^<>]+)>', lambda m: PLACEHOLDERS.get(type(rule._converters[m.group(1)]).__name__, 'x'), rule.rule)
    for method in sorted(rule.methods - {'OPTIONS', 'HEAD'}):
      try:
        endpoint, _ = adapter.match(url, method=method)
      except (NotFound, MethodNotAllowed, RequestRedirect):
        endpoint = rule.endpoint
      routes.add((url, method, endpoint))
  return sorted(routes)


def test_the_walk_sees_the_routes(app):
  """The walk below covers the API, including the admin and token endpoints"""
  endpoints = {endpoint for _, _, endpoint in api_routes(app)}
  assert len(endpoints) > 60
  assert {'get_projects', 'admin_users', 'new_token', 'update_preferences', 'get_output', 'api_ci_commit'} <= endpoints


@pytest.mark.parametrize('ingest_auth', ['off', 'token'])
def test_every_api_route_requires_sign_in(app, make_client, monkeypatch, ingest_auth):
  """With QABOARD_LOGIN_REQUIRED, anonymous requests get a 401 everywhere but the allow-list"""
  from backend.actor import PUBLIC_ENDPOINTS, INGEST_ENDPOINTS
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  monkeypatch.setenv('QABOARD_INGEST_AUTH', ingest_auth)
  wrong, checked = [], 0
  for url, method, endpoint in api_routes(app):
    if endpoint in PUBLIC_ENDPOINTS:
      continue
    if (endpoint, method) in INGEST_ENDPOINTS and ingest_auth != 'token':
      continue
    response = make_client().open(url, method=method, json={})
    checked += 1
    body = response.get_json(silent=True) or {}
    if response.status_code != 401 or body.get('reason') != 'sign_in_required' or not body.get('error'):
      wrong.append(f"{method} {url} ({endpoint}): {response.status_code} {body}")
  assert not wrong, "\n".join(wrong)
  assert checked > 100


@pytest.mark.parametrize('url', ['/api/v1/config', '/api/v1/health', '/api/v1/user/me/'])
def test_public_endpoints_stay_open(client, monkeypatch, url):
  """Signing in needs some endpoints"""
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  assert client.get(url).status_code == 200


def test_anonymous_can_log_in_and_out(client, make_user, monkeypatch):
  """Logging in works when sign-in is required, then the API answers"""
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  make_user('alice')
  login(client, 'alice')
  assert client.get('/api/v1/projects').status_code == 200
  assert client.post('/api/v1/user/logout/').status_code == 200
  assert client.get('/api/v1/projects').status_code == 401


def test_public_reads_by_default(client):
  """Without the setting, anonymous users read projects as before"""
  make_projects('group/repo')
  for url in ['/api/v1/projects', '/api/v1/commits?project=group/repo', '/api/v1/milestones?project=group/repo']:
    response = client.get(url)
    assert response.status_code == 200, (url, response.get_data(as_text=True))
  assert 'group/repo' in client.get('/api/v1/projects').get_json()
  config = client.get('/api/v1/config').get_json()
  assert config["require_sign_in"] is False and config["login_required"] is False


def test_falsy_env_values(client, monkeypatch):
  """QABOARD_LOGIN_REQUIRED=false means false"""
  for value in ['false', '0', 'no', 'off', '']:
    monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', value)
    assert client.get('/api/v1/projects').status_code == 200, value


def test_setting_in_the_database(logged_in, make_client, monkeypatch):
  """Setting auth.require_sign_in from the admin panel has the same effect, and /config says so"""
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  admin = logged_in('root')
  anonymous = make_client()
  assert anonymous.get('/api/v1/projects').status_code == 200
  response = admin.post('/api/v1/admin/settings', json={"auth.require_sign_in": True})
  assert response.status_code == 200, response.get_json()
  setting = next(s for s in response.get_json()["settings"] if s["key"] == "auth.require_sign_in")
  assert setting["value"] is True and setting["source"] == "database"

  response = anonymous.get('/api/v1/projects')
  assert response.status_code == 401 and response.get_json()["reason"] == "sign_in_required"
  config = anonymous.get('/api/v1/config').get_json()
  assert config["require_sign_in"] is True and config["login_required"] is True
  # signed-in users don't notice
  assert admin.get('/api/v1/projects').status_code == 200

  assert admin.post('/api/v1/admin/settings', json={"auth.require_sign_in": None}).status_code == 200
  assert anonymous.get('/api/v1/projects').status_code == 200
  assert anonymous.get('/api/v1/config').get_json()["require_sign_in"] is False


def test_env_wins_over_the_database(logged_in, make_client, monkeypatch):
  """QABOARD_LOGIN_REQUIRED=0 overrides a database value"""
  from backend.database import db_session
  from backend.models import Setting
  db_session.add(Setting(key='auth.require_sign_in', value={"value": True}))
  db_session.commit()
  assert make_client().get('/api/v1/projects').status_code == 401
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '0')
  assert make_client().get('/api/v1/projects').status_code == 200
  assert make_client().get('/api/v1/config').get_json()["require_sign_in"] is False


def disable(user_name, status='disabled'):
  from backend.database import db_session
  from backend.models import User
  User.query.filter(User.user_name == user_name).update({"status": status})
  db_session.commit()


def test_disabled_user_session_stops_working(logged_in):
  """At the next request"""
  alice = logged_in('alice')
  assert alice.get('/api/v1/user/preferences').status_code == 200
  disable('alice')
  for method, url in [('GET', '/api/v1/user/preferences'), ('POST', '/api/v1/user/preferences'), ('GET', '/api/v1/user/tokens'),
                      ('POST', '/api/v1/user/tokens'), ('GET', '/api/v1/user/audit')]:
    response = alice.open(url, method=method, json={"preferences": {"a": 1}, "name": "t", "scopes": ["read"]})
    assert response.status_code == 401, url
  me = alice.get('/api/v1/user/me/').get_json()
  assert me["is_authenticated"] is False and "user_name" not in me


def test_disabled_user_session_says_why(logged_in):
  """The 401 and /user/me give the reason, so the web app can say the account is disabled"""
  alice = logged_in('alice')
  disable('alice')
  response = alice.get('/api/v1/user/preferences')
  assert response.status_code == 401
  body = response.get_json()
  assert body["reason"] == "user_disabled" and "disabled" in body["error"]


def test_disabled_user_me_says_why(logged_in):
  """/user/me, that the web app calls first, says why the user isn't signed in anymore"""
  alice = logged_in('alice')
  disable('alice')
  me = alice.get('/api/v1/user/me/').get_json()
  assert me["is_authenticated"] is False and me["reason"] == "user_disabled" and me["error"]


def test_disabled_user_with_sign_in_required(logged_in, monkeypatch):
  """When sign-in is required, the 401 of every endpoint says the account is disabled, not just "sign in\""""
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', '1')
  alice = logged_in('alice')
  disable('alice')
  response = alice.get('/api/v1/projects')
  assert response.status_code == 401 and response.get_json()["reason"] == "user_disabled"


def test_disabled_user_is_logged_out(logged_in):
  """The session is closed: enabling the account again doesn't bring old sessions back (e.g. a stolen laptop's)"""
  alice = logged_in('alice')
  disable('alice')
  assert alice.get('/api/v1/user/me/').get_json()["is_authenticated"] is False
  disable('alice', 'active')
  assert alice.get('/api/v1/user/me/').get_json()["is_authenticated"] is False


def test_enabled_again_user_can_log_in(logged_in):
  """Once enabled again, users sign in as usual"""
  alice = logged_in('alice')
  disable('alice')
  assert alice.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"}).status_code == 403
  disable('alice', 'active')
  login(alice, 'alice')
  assert alice.get('/api/v1/user/me/').get_json()["user_name"] == "alice"


def test_disabled_users_cant_log_in(client, make_user):
  """403 with a reason, and the failure is audited"""
  from backend.models import AuditEvent, User
  make_user('alice', status='disabled')
  response = client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"})
  assert response.status_code == 403
  body = response.get_json()
  assert body["reason"] == "user_disabled" and "disabled" in body["error"]
  assert client.get('/api/v1/user/me/').get_json()["is_authenticated"] is False
  assert User.query.filter(User.user_name == 'alice').one().last_login_at is None
  event = AuditEvent.query.filter(AuditEvent.action == 'auth.login_failed').one()
  assert event.target_label == 'alice' and event.meta["reason"] == "disabled"


def test_disabled_users_wrong_password(client, make_user):
  """With a wrong password, a disabled account looks like any failed login: we don't say it exists"""
  make_user('alice', status='disabled')
  response = client.post('/api/v1/user/auth/', data={"username": "alice", "password": "wrong"})
  assert response.status_code == 403
  assert response.get_json()["reason"] == "invalid_credentials"


def test_pending_users_sign_in_to_wait(client, make_user, make_client):
  """Users waiting for an admin sign in to a page that says so, where they say why they need access"""
  make_user('alice', status='pending')
  response = client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"})
  assert response.status_code == 200 and response.get_json()["status"] == "pending"
  me = client.get('/api/v1/user/me/').get_json()
  assert me["is_authenticated"] is False and me["reason"] == "user_pending"
  assert me["pending"]["user_name"] == "alice" and me["pending"]["request"]["status"] == "pending"
  # nothing else
  assert client.get('/api/v1/user/tokens').status_code == 401
  response = client.post('/api/v1/user/access-request', json={"message": "I'm in the camera team"})
  assert response.status_code == 200 and response.get_json()["message"] == "I'm in the camera team"
  assert client.get('/api/v1/user/me/').get_json()["pending"]["request"]["message"] == "I'm in the camera team"
  assert make_client().post('/api/v1/user/access-request', json={"message": "x"}).status_code == 401
  from backend.models import AuditEvent
  event = AuditEvent.query.filter(AuditEvent.action == 'auth.login').one()
  assert event.meta["pending"] is True


def test_pending_user_session(logged_in):
  """A pending user's session doesn't work either"""
  alice = logged_in('alice')
  disable('alice', 'pending')
  response = alice.get('/api/v1/user/preferences')
  assert response.status_code == 401 and response.get_json()["reason"] == "user_pending"


@pytest.mark.parametrize('status', ['disabled', 'pending'])
def test_disabled_user_token(logged_in, make_client, status):
  """Their tokens stop working too, everywhere, with a 401 that says why"""
  token = new_token(logged_in('alice'))
  assert make_client().get('/api/v1/user/me/', headers=bearer(token["token"])).get_json()["user_name"] == "alice"
  disable('alice', status)
  for method, url in [('GET', '/api/v1/user/me/'), ('GET', '/api/v1/projects'), ('POST', '/api/v1/user/preferences')]:
    response = make_client().open(url, method=method, headers=bearer(token["token"]), json={"preferences": {}})
    assert response.status_code == 401, url
    assert response.get_json()["reason"] == f"user_{status}"


# ---------------------------------------------------------------------------
# Cross-site writes (CSRF)
# ---------------------------------------------------------------------------

def preferences(client):
  return client.get('/api/v1/user/preferences').get_json()["preferences"]


@pytest.mark.parametrize('headers', [
  {"Origin": "https://evil.example"},
  {"Origin": "http://localhost.evil.example"},
  {"Origin": "null"},
  {"Referer": "https://evil.example/page"},
])
def test_cross_site_cookie_writes_are_refused(logged_in, headers):
  """A logged-in browser POSTing from another site gets a 403, and nothing changes"""
  alice = logged_in('alice')
  response = alice.post('/api/v1/user/preferences', json={"preferences": {"theme": "dark"}}, headers=headers)
  assert response.status_code == 403
  body = response.get_json()
  assert body["reason"] == "cross_site_write" and "auth.allowed_origins" in body["error"]
  assert preferences(alice) == {}
  # reading is fine (SameSite cookies, and CORS answers)
  assert alice.get('/api/v1/user/preferences', headers=headers).status_code == 200


@pytest.mark.parametrize('method,url,body', [
  ('POST', '/api/v1/milestones', {"project": "group/repo", "commit": "a" * 40, "label": "v1"}),
  ('POST', '/api/v1/user/tokens', {"name": "stolen", "scopes": ["read"]}),
  ('POST', '/api/v1/user/logout/', {}),
  ('DELETE', '/api/v1/user/tokens/1', None),
])
def test_cross_site_writes_on_other_endpoints(logged_in, method, url, body):
  """The check runs before every endpoint, including those that create credentials"""
  alice = logged_in('alice')
  response = alice.open(url, method=method, json=body, headers={"Origin": "https://evil.example"})
  assert response.status_code == 403 and response.get_json()["reason"] == "cross_site_write"
  from backend.models import Token, Milestone
  assert Token.query.count() == 0 and Milestone.query.count() == 0
  assert alice.get('/api/v1/user/me/').get_json()["is_authenticated"] is True


@pytest.mark.parametrize('origin', ['http://localhost', 'http://localhost:5151', 'https://LOCALHOST'])
def test_same_origin_writes_work(logged_in, origin):
  """Our own origin (the request's host) is always allowed"""
  alice = logged_in('alice')
  response = alice.post('/api/v1/user/preferences', json={"preferences": {"theme": "dark"}}, headers={"Origin": origin})
  assert response.status_code == 200, response.get_json()
  assert preferences(alice) == {"theme": "dark"}


def test_writes_without_origin_work(logged_in):
  """Non-browser clients (and old browsers) don't send Origin: SameSite=Lax cookies protect those"""
  alice = logged_in('alice')
  assert alice.post('/api/v1/user/preferences', json={"preferences": {"theme": "dark"}}).status_code == 200


def test_allowed_origins_env(logged_in, monkeypatch):
  """Origins in QABOARD_ALLOWED_ORIGINS can make changes with the users' cookies"""
  monkeypatch.setenv('QABOARD_ALLOWED_ORIGINS', 'https://dashboards.example.com, https://other.example.com')
  alice = logged_in('alice')
  for origin in ['https://dashboards.example.com', 'https://other.example.com']:
    response = alice.post('/api/v1/user/preferences', json={"preferences": {"from": origin}}, headers={"Origin": origin})
    assert response.status_code == 200, (origin, response.get_json())
  response = alice.post('/api/v1/user/preferences', json={"preferences": {"theme": "dark"}}, headers={"Origin": "https://evil.example"})
  assert response.status_code == 403


def test_allowed_origins_setting(logged_in, monkeypatch):
  """The same from the database"""
  monkeypatch.setenv('QABOARD_ADMINS', 'alice')
  alice = logged_in('alice')
  headers = {"Origin": "https://dashboards.example.com"}
  assert alice.post('/api/v1/user/preferences', json={"preferences": {"a": 1}}, headers=headers).status_code == 403
  response = alice.post('/api/v1/admin/settings', json={"auth.allowed_origins": ["https://dashboards.example.com"]})
  assert response.status_code == 200, response.get_json()
  assert alice.post('/api/v1/user/preferences', json={"preferences": {"a": 1}}, headers=headers).status_code == 200


def test_qaboard_url_is_an_allowed_origin(logged_in, monkeypatch):
  """Behind a proxy, the public URL's host is ours even if the backend sees another Host"""
  monkeypatch.setenv('QABOARD_URL', 'https://qaboard.example.com')
  alice = logged_in('alice')
  response = alice.post('/api/v1/user/preferences', json={"preferences": {"a": 1}}, headers={"Origin": "https://qaboard.example.com"})
  assert response.status_code == 200, response.get_json()


def test_bearer_writes_from_other_origins(logged_in, make_client):
  """Tokens aren't sent automatically by browsers: no CSRF, no Origin check"""
  token = new_token(logged_in('alice'))
  client = make_client()
  response = client.post('/api/v1/user/preferences', json={"preferences": {"theme": "dark"}},
                         headers={**bearer(token["token"]), "Origin": "https://evil.example"})
  assert response.status_code == 200, response.get_json()
  assert response.get_json()["preferences"] == {"theme": "dark"}


def test_anonymous_writes_from_other_origins(client):
  """Without cookies there's nothing to forge: anonymous ingest from anywhere still works"""
  response = client.post('/api/v1/user/auth/', data={"username": "nobody", "password": "x"}, headers={"Origin": "https://evil.example"})
  assert response.status_code == 403 and response.get_json()["reason"] == "invalid_credentials"


def test_cors_for_our_origins(logged_in, monkeypatch):
  """Allowed origins get CORS answers"""
  monkeypatch.setenv('QABOARD_ALLOWED_ORIGINS', 'https://dashboards.example.com')
  alice = logged_in('alice')
  response = alice.get('/api/v1/user/me/', headers={"Origin": "https://dashboards.example.com"})
  assert response.headers.get('Access-Control-Allow-Origin') == "https://dashboards.example.com"


@pytest.mark.parametrize('method', ['GET', 'OPTIONS'])
def test_cors_never_allows_credentials_for_other_origins(logged_in, method):
  """flask-cors answers every origin, but without Access-Control-Allow-Credentials: other websites can't read
  authenticated answers (docs/design/user-management.md, Appendix B), and the Origin check blocks their cookie writes"""
  alice = logged_in('alice')
  response = alice.open('/api/v1/user/me/', method=method, headers={
    "Origin": "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
  })
  assert response.status_code == 200
  assert 'Access-Control-Allow-Credentials' not in response.headers
  if method == 'GET':
    assert response.get_json()["user_name"] == "alice"


# ---------------------------------------------------------------------------
# Tokens in URLs, and cookies
# ---------------------------------------------------------------------------

def test_token_in_url_for_reads(logged_in, make_client):
  """?token= works for GET (e.g. links to files)"""
  token = new_token(logged_in('alice'))
  client = make_client()
  me = client.get(f'/api/v1/user/me/?token={token["token"]}').get_json()
  assert me["user_name"] == "alice" and me["token"]["id"] == token["id"]
  assert client.get(f'/api/v1/user/preferences?token={token["token"]}').status_code == 200


def test_token_in_url_refused_for_writes(logged_in, make_client):
  """URLs end up in access logs: writes need the Authorization header"""
  token = new_token(logged_in('alice'))
  client = make_client()
  for method, url in [('POST', '/api/v1/user/preferences'), ('POST', '/api/v1/output/'), ('DELETE', f'/api/v1/user/tokens/{token["id"]}')]:
    response = client.open(f'{url}?token={token["token"]}', method=method, json={"preferences": {"theme": "dark"}})
    assert response.status_code == 401, url
    body = response.get_json()
    assert body["reason"] == "token_in_url" and "Authorization header" in body["error"]
  # the token wasn't revoked
  assert client.get('/api/v1/user/me/', headers=bearer(token["token"])).get_json()["user_name"] == "alice"
  assert client.get('/api/v1/user/preferences', headers=bearer(token["token"])).get_json()["preferences"] == {}


def test_broken_token_in_url(make_client):
  """A bad ?token= is a 401, not an anonymous request"""
  response = make_client().get('/api/v1/projects?token=qab_pat_nope')
  assert response.status_code == 401 and response.get_json()["reason"] == "token_invalid"


def test_token_requests_set_no_cookie(logged_in, make_client):
  """Token requests never open a session"""
  token = new_token(logged_in('alice'))
  client = make_client()
  for method, url in [('GET', '/api/v1/user/me/'), ('GET', '/api/v1/user/preferences'), ('POST', '/api/v1/user/preferences'),
                      ('GET', '/api/v1/projects'), ('POST', '/api/v1/user/logout/')]:
    response = client.open(url, method=method, headers=bearer(token["token"]), json={"preferences": {"a": 1}})
    assert response.status_code == 200, (url, response.get_json())
    assert 'Set-Cookie' not in response.headers, (url, response.headers.get('Set-Cookie'))
  response = client.get(f'/api/v1/user/me/?token={token["token"]}')
  assert 'Set-Cookie' not in response.headers
  # the next anonymous request is anonymous
  assert client.get('/api/v1/user/me/').get_json()["is_authenticated"] is False


def test_token_logout_keeps_the_token(logged_in, make_client):
  """POST /logout with a token neither revokes it nor logs out the user's browser"""
  alice = logged_in('alice')
  token = new_token(alice)
  assert make_client().post('/api/v1/user/logout/', headers=bearer(token["token"])).status_code == 200
  assert make_client().get('/api/v1/user/me/', headers=bearer(token["token"])).get_json()["user_name"] == "alice"
  assert alice.get('/api/v1/user/me/').get_json()["is_authenticated"] is True


def test_session_cookie_flags(client, make_user):
  """HttpOnly and SameSite=Lax"""
  make_user('alice')
  response = client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"})
  cookies = response.headers.getlist('Set-Cookie')
  assert cookies
  for cookie in cookies:
    assert 'HttpOnly' in cookie and 'SameSite=Lax' in cookie, cookie


def test_token_wins_over_the_session(logged_in):
  """A browser that also sends a token acts as the token's user, without changing its cookie"""
  alice = logged_in('alice')
  bob_token = new_token(logged_in('bob'), scopes=["read"])
  response = alice.get('/api/v1/user/me/', headers=bearer(bob_token["token"]))
  assert response.get_json()["user_name"] == "bob" and 'Set-Cookie' not in response.headers
  assert alice.get('/api/v1/user/me/').get_json()["user_name"] == "alice"


def test_the_jenkins_trigger_needs_a_sign_in_when_required(client, monkeypatch):
  """It uses the server's Jenkins credentials: it's not ingest, even when ingest is open"""
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  response = client.post('/api/v1/jenkins/build/trigger', json={})
  assert response.status_code == 401 and response.get_json()["reason"] == "sign_in_required"


def test_the_jenkins_trigger_without_a_user(client, logged_in, monkeypatch):
  """Like qa's Windows runner: only the jobs that projects' qaboard.yaml list, unless ingest requires tokens"""
  from backend.database import db_session
  from backend.models import Project
  import backend.api.integrations as integrations
  db_session.add(Project(id='group/windows', data={"qatools_config": {"runners": {"jenkins": {"build_url": "http://jenkins/job/windows"}}}}))
  db_session.commit()
  monkeypatch.setattr(integrations, "_declared_jenkins_jobs", {"at": None, "build_urls": set()})
  monkeypatch.setattr(integrations, "jenkins_credentials", {"jenkins": {"user": "u", "token": "t", "crumb": "c"}})
  started = []
  monkeypatch.setattr(integrations, "trigger_jenkins_build", lambda data: started.append(data['build_url']) or integrations.jsonify({"status": "pending"}))
  for data in [{"build_url": "http://jenkins/job/windows"}, {"build_url": "http://jenkins/job/windows/", "project": "group/windows", "commit": "abc"}]:
    assert client.post('/api/v1/jenkins/build/trigger/', json=data).status_code == 200
  for data in [{"build_url": "http://jenkins/job/deploy"}, {"build_url": "http://jenkins/job/deploy", "project": "group/windows"}]:
    response = client.post('/api/v1/jenkins/build/trigger/', json=data)
    assert response.status_code == 403 and "qaboard.yaml" in response.get_json()["error"]
  assert started == ["http://jenkins/job/windows", "http://jenkins/job/windows/"]
  # signed-in users can start any job, and the audit log says who did
  alice = logged_in('alice')
  assert alice.post('/api/v1/jenkins/build/trigger/', json={"build_url": "http://jenkins/job/deploy"}).status_code == 200
  from backend.models import AuditEvent
  assert [e.target_label for e in AuditEvent.query.filter(AuditEvent.action == 'jenkins.build').order_by(AuditEvent.id).all()][-1] == "http://jenkins/job/deploy"
  # with ingest.auth "token", qa needs a token
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  response = client.post('/api/v1/jenkins/build/trigger/', json={"build_url": "http://jenkins/job/windows"})
  assert response.status_code == 403 and response.get_json()["reason"] == "ingest_token_required"


def test_the_jenkins_build_status(client, logged_in, monkeypatch):
  """Like the trigger: anonymous for qa's Windows runner unless ingest requires tokens, only on the Jenkins hosts, only the status"""
  from types import SimpleNamespace
  from backend.database import db_session
  from backend.models import Project
  import backend.api.integrations as integrations
  db_session.add(Project(id='group/windows', data={"qatools_config": {"runners": {"jenkins": {"build_url": "http://jenkins:8080/job/windows"}}}}))
  db_session.commit()
  monkeypatch.setattr(integrations, "_declared_jenkins_jobs", {"at": None, "build_urls": set()})
  monkeypatch.setattr(integrations, "jenkins_credentials", {"jenkins": {"user": "u", "token": "t", "crumb": "c"}})
  fetched, answer = [], {"json": {"building": False, "result": "SUCCESS"}}
  def get(url, **kwargs):
    fetched.append(url)
    body = answer["json"]
    def json():
      if body is None:
        raise ValueError("not JSON")
      return body
    return SimpleNamespace(status_code=200, json=json, text="<html>the admin page of another service</html>", headers={"Content-Type": "text/html"})
  monkeypatch.setattr(integrations.requests, "get", get)
  for data in [{"web_url": "http://jenkins/job/windows/12/"}, {"url": "http://jenkins:8080/job/windows/12/api/json"}]:
    response = client.post('/api/v1/jenkins/build/', json=data)
    assert response.status_code == 200 and response.get_json()["status"] == "success", data
  assert fetched == ["http://jenkins/job/windows/12/api/json", "http://jenkins:8080/job/windows/12/api/json"]
  # not other hosts, schemes or ports: the server sends its Jenkins credentials there
  for url in ["http://other/job/x/api/json", "http://jenkins:9200/api/json", "ftp://jenkins/job/x/api/json",
              "http://u:p@jenkins/job/x/api/json", "https://jenkins:8080/job/x/api/json", "http://jenkins:x/api/json"]:
    assert client.post('/api/v1/jenkins/build/', json={"url": url}).status_code == 403, url
  assert len(fetched) == 2
  # never what the URL answered
  answer["json"] = None
  response = client.post('/api/v1/jenkins/build/', json={"web_url": "http://jenkins/job/windows/12/"})
  assert response.status_code == 500 and "another service" not in response.get_data(as_text=True)
  answer["json"] = {"jobs": ["secrets"]}
  response = client.post('/api/v1/jenkins/build/', json={"web_url": "http://jenkins/job/windows/12/"})
  assert response.status_code == 500 and "secrets" not in response.get_data(as_text=True)
  # with ingest.auth "token", qa needs a token, like to start builds
  answer["json"] = {"building": True}
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  response = client.post('/api/v1/jenkins/build/', json={"web_url": "http://jenkins/job/windows/12/"})
  assert response.status_code == 403 and response.get_json()["reason"] == "ingest_token_required"
  token = new_token(logged_in('alice'), scopes=["ingest"])["token"]
  response = client.post('/api/v1/jenkins/build/', json={"web_url": "http://jenkins/job/windows/12/"}, headers=bearer(token))
  assert response.status_code == 200 and response.get_json()["status"] == "running"
  read_only = new_token(logged_in('bob'), scopes=["read"])["token"]
  assert client.post('/api/v1/jenkins/build/', json={"web_url": "http://jenkins/job/windows/12/"}, headers=bearer(read_only)).status_code == 403


def test_reads_say_why_a_token_cant_access_a_project(logged_in, make_client):
  """Restricted tokens get a reason (JSON), not a plain-text 403"""
  from .conftest import make_projects
  make_projects('group/repo', 'other/repo')
  token = new_token(logged_in('alice'), scopes=["read"], projects=["group/*"])
  for url in ['/api/v1/commits?project=other/repo', '/api/v1/project?project=other/repo', '/api/v1/project/branches?project=other/repo']:
    response = make_client().get(url, headers=bearer(token["token"]))
    assert response.status_code == 403, url
    assert response.get_json() == {"error": "This token can't access other/repo.", "reason": "token_project"}, url
