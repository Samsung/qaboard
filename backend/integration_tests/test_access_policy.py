"""Who gets an account when they first sign in, and the requests of users waiting for an admin"""
import pytest

from .conftest import login


def signup(client, user_name, email):
  return client.post('/api/v1/user/signup/', data={"user_name": user_name, "password": "pw", "email": email})


@pytest.mark.parametrize('policy, email, status', [
  ('open', 'a@other.com', 'active'),
  ('approval', 'a@example.com', 'pending'),
  # local sign-up doesn't verify emails: anyone could type one of the domains (OIDC's verified emails: test_oidc.py)
  ('domains', 'a@example.com', 'pending'),
  ('domains', 'a@other.com', 'pending'),
  ('domains', None, 'pending'),
])
def test_access_policy(client, monkeypatch, policy, email, status):
  monkeypatch.setenv('QABOARD_ACCESS_POLICY', policy)
  monkeypatch.setenv('QABOARD_ALLOWED_EMAIL_DOMAINS', 'example.com, @corp.example')
  assert signup(client, 'alice', email).status_code == 200
  from backend.models import User, AccessRequest
  assert User.query.one().status == status
  login(client, 'alice', 'pw')
  assert AccessRequest.query.count() == (1 if status == 'pending' else 0)


def test_admins_decide(logged_in, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  from backend.models import AccessRequest
  root = logged_in('root')
  monkeypatch.setenv('QABOARD_ACCESS_POLICY', 'approval')
  alice = make_client()
  signup(alice, 'alice', 'alice@example.com')
  login(alice, 'alice', 'pw')
  alice.post('/api/v1/user/access-request', json={"message": "camera team"})
  requests = root.get('/api/v1/admin/access-requests').get_json()["requests"]
  assert [(r["user"]["user_name"], r["message"], r["status"]) for r in requests] == [("alice", "camera team", "pending")]
  alice_id = requests[0]["user"]["id"]
  # on the user's page too
  assert root.get(f'/api/v1/admin/users/{alice_id}').get_json()["access_request"]["message"] == "camera team"
  assert root.post(f'/api/v1/admin/users/{alice_id}', json={"status": "active"}).status_code == 200
  assert AccessRequest.query.one().status == "approved"
  assert root.get(f'/api/v1/admin/users/{alice_id}').get_json()["access_request"]["status"] == "approved"
  # the same session now works
  assert alice.get('/api/v1/user/me/').get_json()["user_name"] == "alice"
  assert alice.get('/api/v1/user/tokens').status_code == 200
  assert root.get('/api/v1/admin/access-requests').get_json()["requests"] == []


def test_admins_are_notified(make_client, monkeypatch):
  """By the webhook here (and by email when QA-Board can send emails)"""
  import responses
  monkeypatch.setenv('QABOARD_ACCESS_POLICY', 'approval')
  monkeypatch.setenv('QABOARD_ACCESS_REQUEST_WEBHOOK', 'https://hooks.example.com/qaboard')
  sent = []
  import backend.sign_in.access as access
  monkeypatch.setattr(access.threading, 'Thread', lambda target, args, **kwargs: type('T', (), {'start': lambda self: target(*args)})())
  with responses.RequestsMock() as mocked:
    mocked.add(responses.POST, 'https://hooks.example.com/qaboard', json={}, status=200)
    client = make_client()
    signup(client, 'alice', 'alice@example.com')
    login(client, 'alice', 'pw')
    assert len(mocked.calls) == 1
    import json
    text = json.loads(mocked.calls[0].request.body)["text"]
    assert "alice" in text and "/admin/users/" in text


def test_the_sign_in_page_options(client, monkeypatch):
  answer = client.get('/api/v1/auth/providers').get_json()
  assert [p["id"] for p in answer["providers"]] == ["local"] and answer["password_form"] is True
  monkeypatch.setenv('QABOARD_OIDC_ISSUER', 'https://idp.example.com/realms/company')
  monkeypatch.setenv('QABOARD_OIDC_CLIENT_ID', 'qaboard')
  monkeypatch.setenv('QABOARD_OIDC_BUTTON_LABEL', 'Company SSO')
  answer = client.get('/api/v1/auth/providers?next=/group/repo/commits').get_json()
  # SSO first, then the password form for local accounts
  assert [(p["id"], p["name"], p["recommended"]) for p in answer["providers"]] == [("sso", "Company SSO", True), ("local", "QA-Board account", False)]
  assert answer["providers"][0]["start_url"] == "/api/v1/auth/oidc/sso/start?next=%2Fgroup%2Frepo%2Fcommits"
  # with SAML and SSO, the password form is for break-glass admins: /login?local=1
  monkeypatch.setenv('QABOARD_LOGIN_TYPE', 'SAML')
  answer = client.get('/api/v1/auth/providers').get_json()
  assert [p["id"] for p in answer["providers"]] == ["sso", "saml"] and answer["password_form"] is False
  answer = client.get('/api/v1/auth/providers?local=1').get_json()
  assert [p["id"] for p in answer["providers"]] == ["sso", "saml", "local"] and answer["password_form"] is True
  # with LDAP, one form for directory and local accounts
  monkeypatch.setenv('QABOARD_LOGIN_TYPE', 'LDAP')
  assert [p["id"] for p in client.get('/api/v1/auth/providers').get_json()["providers"]] == ["sso", "ldap"]


def test_auto_redirect(client, monkeypatch):
  monkeypatch.setenv('QABOARD_OIDC_ISSUER', 'https://idp.example.com/realms/company')
  monkeypatch.setenv('QABOARD_SSO_AUTO_REDIRECT', 'true')
  assert client.get('/api/v1/auth/providers').get_json()["auto_redirect"] is False
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  assert client.get('/api/v1/auth/providers').get_json()["auto_redirect"] is True
  assert client.get('/api/v1/auth/providers?local=1').get_json()["auto_redirect"] is False


def test_the_admins_of_the_environment(client, make_user, make_client, monkeypatch):
  """$QABOARD_ADMINS: local sign-up can't take their names, and only verified emails count"""
  monkeypatch.setenv('QABOARD_ADMINS', 'Root, boss@example.com, chief@example.com')
  for name in ('Root', 'root', 'ROOT'):
    assert signup(client, name, f'{name}@other.com').status_code == 409
  assert signup(client, 'mallory', 'boss@example.com').status_code == 200
  mallory = login(make_client(), 'mallory', 'pw')
  assert mallory.get('/api/v1/user/me/').get_json()["is_admin"] is False
  assert mallory.get('/api/v1/admin/users').status_code == 403
  # the directory's emails, and the names (e.g. a local account from qaboard-admin create-admin)
  make_user('chief', email='chief@example.com', login_type='SAML')
  make_user('Root')
  for name in ('chief', 'Root'):
    assert login(make_client(), name).get('/api/v1/user/me/').get_json()["is_admin"] is True, name
