"""
Single sign-on with OpenID Connect, against a throwaway IdP: real RSA keys, discovery, JWKS and the token endpoint,
served with `responses`. Like EMMA's oidc.test.ts: tampered tokens, alg none, wrong audience, nonce replay...
"""
import time
import base64
import hashlib
from urllib.parse import urlparse, parse_qs

import pytest
import responses
from joserfc import jwt
from joserfc.jwk import RSAKey, KeySet

from .conftest import login


ISSUER = 'https://idp.example.com/realms/company'
CLIENT_ID = 'qaboard'
SECRET = 'idp-secret'


class FakeIdP:
  def __init__(self, mocked):
    self.key = RSAKey.generate_key(2048, parameters={"kid": "key-1"}, private=True)
    self.mocked = mocked
    self.claims = {}
    self.header = {"alg": "RS256", "kid": "key-1"}
    self.signing_key = self.key
    self.token_status = 200
    self.raw_id_token = None
    self.last_token_request = None
    mocked.add(responses.GET, f'{ISSUER}/.well-known/openid-configuration', json={
      "issuer": ISSUER,
      "authorization_endpoint": f'{ISSUER}/protocol/openid-connect/auth',
      "token_endpoint": f'{ISSUER}/protocol/openid-connect/token',
      "jwks_uri": f'{ISSUER}/protocol/openid-connect/certs',
      "userinfo_endpoint": f'{ISSUER}/protocol/openid-connect/userinfo',
      "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
    })
    mocked.add(responses.GET, f'{ISSUER}/protocol/openid-connect/certs', json=KeySet([self.key]).as_dict(private=False))
    mocked.add_callback(responses.POST, f'{ISSUER}/protocol/openid-connect/token', callback=self.token_endpoint)
    self.nonce = None
    self.challenge = None
    # refresh tokens (refresh_groups): what the token endpoint answers to grant_type=refresh_token
    self.refresh_refused = False
    self.refreshed = 0

  def refresh(self, body):
    import json
    if self.refresh_refused or body['refresh_token'][0] not in ('rt-1', f'rt-{self.refreshed + 1}'):
      return (400, {}, json.dumps({"error": "invalid_grant", "error_description": "Token is not active"}))
    self.refreshed += 1
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "subject-alice", "exp": now + 300, "iat": now,
              "preferred_username": "alice", "email": "alice@example.com", "groups": ["/camera"], **self.claims}
    id_token = jwt.encode(self.header, {k: v for k, v in claims.items() if v is not None}, self.signing_key)
    # rotated
    return (200, {}, json.dumps({"access_token": "at", "id_token": id_token, "refresh_token": f"rt-{self.refreshed + 1}", "token_type": "Bearer"}))

  def token_endpoint(self, request):
    import json
    body = parse_qs(request.body)
    self.last_token_request = request
    if body.get('grant_type') == ['refresh_token']:
      return self.refresh(body)
    verifier = body['code_verifier'][0]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    if challenge != self.challenge or body['code'][0] != 'the-code':
      return (400, {}, json.dumps({"error": "invalid_grant", "error_description": "bad code or PKCE"}))
    if self.token_status != 200:
      return (self.token_status, {}, json.dumps({"error": "server_error"}))
    now = int(time.time())
    claims = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "subject-alice", "exp": now + 300, "iat": now, "nonce": self.nonce,
              "preferred_username": "alice", "email": "alice@example.com", "name": "Alice Doe", "groups": ["/camera"], **self.claims}
    claims = {k: v for k, v in claims.items() if v is not None}
    id_token = self.raw_id_token or jwt.encode(self.header, claims, self.signing_key, algorithms=["RS256", "none"] if self.header.get("alg") == "none" else None)
    return (200, {}, json.dumps({"access_token": "at", "id_token": id_token, "refresh_token": "rt-1", "token_type": "Bearer"}))

  def start(self, client, url='/api/v1/auth/oidc/sso/start?next=/group/repo/commits'):
    response = client.get(url)
    assert response.status_code == 302, response.get_data(as_text=True)
    location = urlparse(response.headers['Location'])
    params = {k: v[0] for k, v in parse_qs(location.query).items()}
    assert location.geturl().startswith(f'{ISSUER}/protocol/openid-connect/auth')
    assert params['code_challenge_method'] == 'S256' and params['client_id'] == CLIENT_ID
    self.nonce, self.challenge = params['nonce'], params['code_challenge']
    self.last_start = params
    return params

  def sign_in(self, client, state=None, **extra):
    params = self.start(client)
    query = {"code": "the-code", "state": state or params['state'], **extra}
    from urllib.parse import urlencode
    # where the IdP sends users back
    return client.get(f'{urlparse(params["redirect_uri"]).path}?{urlencode(query)}')


@pytest.fixture
def idp(monkeypatch):
  monkeypatch.setenv('QABOARD_OIDC_ISSUER', ISSUER)
  monkeypatch.setenv('QABOARD_OIDC_CLIENT_ID', CLIENT_ID)
  monkeypatch.setenv('QABOARD_OIDC_CLIENT_SECRET', SECRET)
  monkeypatch.setenv('QABOARD_URL', 'http://localhost')
  from backend.sign_in import oidc
  oidc.clear_cache()
  with responses.RequestsMock(assert_all_requests_are_fired=False) as mocked:
    yield FakeIdP(mocked)
  oidc.clear_cache()


def error_of(response):
  assert response.status_code == 302
  location = urlparse(response.headers['Location'])
  assert location.path == '/login', response.headers['Location']
  return parse_qs(location.query)['error'][0]


def test_sign_in_creates_the_account(idp, make_client):
  from backend.models import User, UserIdentity, UserSession, AuditEvent
  client = make_client()
  response = idp.sign_in(client)
  assert response.status_code == 302 and response.headers['Location'] == '/group/repo/commits'
  # the environment's provider uses the redirect URI the docs say to register
  assert idp.last_start["redirect_uri"] == "http://localhost/api/v1/auth/oidc/callback"
  me = client.get('/api/v1/user/me/').get_json()
  assert me["user_name"] == "alice" and me["full_name"] == "Alice Doe" and me["email"] == "alice@example.com"
  user = User.query.one()
  assert user.login_type == 'OIDC' and user.status == 'active'
  identity = UserIdentity.query.filter_by(provider_id='sso').one()
  assert identity.subject == 'subject-alice' and 'nonce' not in identity.claims
  assert UserSession.query.one().provider_id == 'sso'
  event = AuditEvent.query.filter_by(action='auth.login').one()
  # recorded, never used for access (yet)
  assert event.meta["provider"] == "sso" and event.meta["idp_groups"] == ["/camera"]
  # the secret went server-to-server, never through the browser
  assert idp.last_token_request.headers['Authorization'].startswith('Basic ')


def test_signing_in_again_uses_the_identity(idp, make_client):
  idp.sign_in(make_client())
  # a renamed account at the IdP: the subject is what matters
  idp.claims = {"preferred_username": "alice.doe"}
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "alice"


def test_existing_accounts_arent_taken_by_user_name(idp, make_user, make_client):
  make_user('alice')
  assert error_of(idp.sign_in(make_client())) == 'account_exists'


def test_match_users_by_user_name(idp, make_user, make_client, monkeypatch):
  """For IdPs federated to the same directory as LDAP, like at SIRC"""
  monkeypatch.setenv('QABOARD_OIDC_MATCH_USERS', 'username')
  user_id = make_user('alice').id
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["user_id"] == user_id


def test_username_claim(idp, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_OIDC_USERNAME_CLAIM', 'samaccountname')
  idp.claims = {"samaccountname": "afl"}
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "afl"


def test_missing_username_claim(idp, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_OIDC_USERNAME_CLAIM', 'samaccountname')
  idp.mocked.add(responses.GET, f'{ISSUER}/protocol/openid-connect/userinfo', json={"sub": "subject-alice"})
  assert error_of(idp.sign_in(make_client())) == 'sso_misconfigured'


def test_claims_missing_from_the_id_token_come_from_userinfo(idp, make_client):
  idp.claims = {"preferred_username": None}
  idp.mocked.add(responses.GET, f'{ISSUER}/protocol/openid-connect/userinfo', json={"sub": "subject-alice", "preferred_username": "alice"})
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "alice"


def test_userinfo_for_another_subject_is_ignored(idp, make_client):
  idp.claims = {"preferred_username": None}
  idp.mocked.add(responses.GET, f'{ISSUER}/protocol/openid-connect/userinfo', json={"sub": "mallory", "preferred_username": "admin"})
  assert error_of(idp.sign_in(make_client())) == 'sso_misconfigured'


@pytest.mark.parametrize('change, code', [
  ({"aud": "another-app"}, 'sso_misconfigured'),
  ({"iss": "https://evil.example.com"}, 'sso_misconfigured'),
  ({"exp": int(time.time()) - 3600}, 'sso_expired'),
  ({"nonce": "replayed"}, 'sso_expired'),
])
def test_invalid_id_tokens(idp, make_client, change, code):
  from backend.models import User, UserSession
  idp.claims = change
  assert error_of(idp.sign_in(make_client())) == code
  assert User.query.count() == 0 and UserSession.query.count() == 0


def test_tokens_signed_by_another_key(idp, make_client):
  idp.signing_key = RSAKey.generate_key(2048, parameters={"kid": "key-1"}, private=True)
  assert error_of(idp.sign_in(make_client())) == 'sso_misconfigured'


def test_alg_none_is_refused(idp, make_client):
  header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b'=').decode()
  now = int(time.time())
  import json
  payload = {"iss": ISSUER, "aud": CLIENT_ID, "sub": "subject-alice", "exp": now + 300, "iat": now, "preferred_username": "alice"}
  def unsigned(nonce):
    body = base64.urlsafe_b64encode(json.dumps({**payload, "nonce": nonce}).encode()).rstrip(b'=').decode()
    return f"{header}.{body}."
  params = idp.start(make_client_ := make_client())
  idp.raw_id_token = unsigned(idp.nonce)
  response = make_client_.get(f'/api/v1/auth/oidc/sso/callback?code=the-code&state={params["state"]}')
  assert error_of(response) == 'sso_misconfigured'


def test_state_mismatch(idp, make_client):
  assert error_of(idp.sign_in(make_client(), state='forged')) == 'sso_expired'


def test_callback_without_starting(idp, client):
  assert error_of(client.get('/api/v1/auth/oidc/sso/callback?code=the-code&state=x')) == 'sso_expired'


def test_the_idp_refuses(idp, make_client):
  client = make_client()
  params = idp.start(client)
  response = client.get(f'/api/v1/auth/oidc/sso/callback?error=access_denied&state={params["state"]}')
  assert error_of(response) == 'sso_failed'
  from backend.models import AuditEvent
  event = AuditEvent.query.filter_by(action='auth.login_failed').one()
  assert event.meta["reason"] == "sso_failed" and "access_denied" in event.meta["detail"]
  # users get the event's id, to give admins, and which provider failed
  query = parse_qs(urlparse(response.headers['Location']).query)
  assert query['ref'] == [str(event.id)] and query['provider'] == ['sso']


def test_the_idp_is_down(monkeypatch, client):
  monkeypatch.setenv('QABOARD_OIDC_ISSUER', 'https://down.example.com')
  monkeypatch.setenv('QABOARD_OIDC_CLIENT_ID', CLIENT_ID)
  from backend.sign_in import oidc
  oidc.clear_cache()
  with responses.RequestsMock() as mocked:
    mocked.add(responses.GET, 'https://down.example.com/.well-known/openid-configuration', body=ConnectionError("refused"))
    assert error_of(client.get('/api/v1/auth/oidc/sso/start')) == 'sso_unavailable'


def test_disabled_users(idp, make_client):
  idp.sign_in(make_client())
  from backend.database import db_session
  from backend.models import User
  User.query.update({"status": "disabled"})
  db_session.commit()
  assert error_of(idp.sign_in(make_client())) == 'user_disabled'


def test_new_users_wait_for_an_admin(idp, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_ACCESS_POLICY', 'domains')
  monkeypatch.setenv('QABOARD_ALLOWED_EMAIL_DOMAINS', 'corp.example')
  client = make_client()
  # the sign-in page shows them their request
  assert idp.sign_in(client).headers['Location'] == '/login?next=%2Fgroup%2Frepo%2Fcommits'
  me = client.get('/api/v1/user/me/').get_json()
  assert me["reason"] == "user_pending" and me["pending"]["user_name"] == "alice"


def test_only_verified_emails_count(idp, make_client, monkeypatch):
  """For the domains policy and the emails of $QABOARD_ADMINS: some IdPs let users choose their email"""
  from backend.database import db_session
  from backend.models import User
  monkeypatch.setenv('QABOARD_ACCESS_POLICY', 'domains')
  monkeypatch.setenv('QABOARD_ALLOWED_EMAIL_DOMAINS', 'example.com')
  monkeypatch.setenv('QABOARD_ADMINS', 'alice@example.com')
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["reason"] == "user_pending"
  User.query.update({"status": "active"})
  db_session.commit()
  assert client.get('/api/v1/user/me/').get_json()["is_admin"] is False
  # the IdP says it's verified: at the next sign-in
  idp.claims["email_verified"] = True
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["is_admin"] is True
  idp.claims.update({"sub": "subject-bob", "preferred_username": "bob", "email": "bob@example.com"})
  bob = make_client()
  idp.sign_in(bob)
  me = bob.get('/api/v1/user/me/').get_json()
  assert me["user_name"] == "bob" and me["status"] == "active" and me["is_admin"] is False


def test_link_another_sign_in_method(idp, make_user, make_client):
  make_user('alice.local', email='alice@example.com')
  client = login(make_client(), 'alice.local')
  params = idp.start(client, '/api/v1/auth/oidc/sso/start?link=1')
  response = client.get(f'/api/v1/auth/oidc/sso/callback?code=the-code&state={params["state"]}')
  assert response.headers['Location'] == '/settings/sign-in'
  identities = client.get('/api/v1/user/identities').get_json()["identities"]
  assert sorted(i["provider_id"] for i in identities) == ["local", "sso"]
  # now SSO signs in to that account
  other = make_client()
  idp.sign_in(other)
  assert other.get('/api/v1/user/me/').get_json()["user_name"] == "alice.local"
  # and it can be unlinked, not the last one
  sso_id = next(i["id"] for i in identities if i["provider_id"] == "sso")
  local_id = next(i["id"] for i in identities if i["provider_id"] == "local")
  assert client.delete(f'/api/v1/user/identities/{sso_id}').status_code == 200
  assert client.delete(f'/api/v1/user/identities/{local_id}').status_code == 400


def test_next_only_goes_to_our_pages(idp, make_client):
  client = make_client()
  params = idp.start(client, '/api/v1/auth/oidc/sso/start?next=https://evil.example.com/')
  response = client.get(f'/api/v1/auth/oidc/sso/callback?code=the-code&state={params["state"]}')
  assert response.headers['Location'] == '/'


def test_admins_add_providers(idp, logged_in, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'a-key-for-tests')
  root = logged_in('root')
  response = root.post('/api/v1/admin/sign-in/providers', json={
    "id": "keycloak", "name": "Keycloak", "issuer": ISSUER, "client_id": CLIENT_ID, "client_secret": SECRET, "claims": {"username": "preferred_username"},
  })
  assert response.status_code == 201, response.get_json()
  provider = response.get_json()
  assert provider["has_secret"] and "client_secret" not in provider["config"]
  assert provider["redirect_uri"] == "http://localhost/api/v1/auth/oidc/keycloak/callback"
  from backend.models import AuthProvider
  assert SECRET not in (AuthProvider.query.one().secret_encrypted or '')
  listed = root.get('/api/v1/admin/sign-in').get_json()["providers"]
  assert {p["id"]: p["source"] for p in listed} == {"sso": "env", "keycloak": "database", "local": "env"}
  # it signs in, with its own callback
  client = make_client()
  params = idp.start(client, '/api/v1/auth/oidc/keycloak/start')
  response = client.get(f'/api/v1/auth/oidc/keycloak/callback?code=the-code&state={params["state"]}')
  assert response.status_code == 302 and response.headers['Location'] == '/'
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "alice"
  # env providers are read-only
  assert root.post('/api/v1/admin/sign-in/providers/sso', json={"name": "x"}).status_code == 400
  assert root.post('/api/v1/admin/sign-in/providers', json={"id": "Bad Id", "issuer": ISSUER, "client_id": "x"}).status_code == 400


def test_secrets_need_the_encryption_key(logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  monkeypatch.delenv('QABOARD_ENCRYPTION_KEY', raising=False)
  response = logged_in('root').post('/api/v1/admin/sign-in/providers', json={"id": "k", "issuer": ISSUER, "client_id": "x", "client_secret": "s"})
  assert response.status_code == 400 and "QABOARD_ENCRYPTION_KEY" in response.get_json()["error"]


def test_the_doctor(idp, logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root = logged_in('root')
  idp.mocked.add(responses.GET, f'{ISSUER}/protocol/openid-connect/auth', status=400, body="We are sorry... Invalid parameter: redirect_uri")
  checks = {c["check"]: c for c in root.post('/api/v1/admin/sign-in/providers/sso/test').get_json()["checks"]}
  assert checks["discovery"]["ok"] and checks["issuer"]["ok"] and checks["signing keys"]["ok"] and checks["client secret"]["ok"]
  assert not checks["redirect URI"]["ok"] and "http://localhost/api/v1/auth/oidc/callback" in checks["redirect URI"]["detail"]
