"""
CI jobs without stored secrets (backend/ci_trust.py): service accounts trust CI jobs, whose OIDC ID tokens are
exchanged for short-lived tokens. Against a throwaway GitHub-like issuer: real RSA keys, discovery and JWKS served
with `responses`.
"""
import time

import pytest
import responses
from joserfc import jwt
from joserfc.jwk import RSAKey, KeySet

from .conftest import bearer
from .test_access import ingest, team, PROJECT # noqa: F401 (team is a fixture)


ISSUER = 'https://token.actions.githubusercontent.com'
AUDIENCE = 'http://localhost'
OTHER = 'group/other'


class FakeIssuer:
  def __init__(self, mocked, issuer=ISSUER):
    self.issuer = issuer
    self.key = RSAKey.generate_key(2048, parameters={"kid": "key-1"}, private=True)
    mocked.add(responses.GET, f'{issuer}/.well-known/openid-configuration', json={"issuer": issuer, "jwks_uri": f'{issuer}/.well-known/jwks'})
    mocked.add(responses.GET, f'{issuer}/.well-known/jwks', json=KeySet([self.key]).as_dict(private=False))

  def token(self, key=None, header=None, **claims):
    now = int(time.time())
    claims = {
      "iss": self.issuer, "aud": AUDIENCE, "sub": "repo:camera-algo/isp:ref:refs/heads/main", "exp": now + 300, "iat": now, "nbf": now,
      "repository": "camera-algo/isp", "repository_id": "1234", "ref": "refs/heads/main", "ref_protected": "true",
      "run_id": "42", "workflow": "QA", **claims,
    }
    return jwt.encode(header or {"alg": "RS256", "kid": "key-1"}, {k: v for k, v in claims.items() if v is not None}, key or self.key)


@pytest.fixture
def issuer(monkeypatch):
  monkeypatch.setenv('QABOARD_URL', AUDIENCE)
  from backend.sign_in import oidc
  oidc.clear_cache()
  with responses.RequestsMock(assert_all_requests_are_fired=False) as mocked:
    yield FakeIssuer(mocked)
    # never anything else: the unverified tokens' issuers aren't fetched
    assert all(call.request.url.startswith(ISSUER) for call in mocked.calls), [c.request.url for c in mocked.calls]
  oidc.clear_cache()


def account(client, project=PROJECT, name='ci', role='developer'):
  response = client.post('/api/v1/service-accounts', json={"name": name, "project": project, "role": role})
  assert response.status_code == 201, response.get_json()
  return response.get_json()


def trust(client, account_id, **body):
  return client.post(f'/api/v1/service-accounts/{account_id}/ci-trust', json={"provider": "github", "repository": "camera-algo/isp", **body})


def exchange(client, subject_token, as_form=False, **extra):
  body = {"grant_type": "urn:ietf:params:oauth:grant-type:token-exchange", "subject_token": subject_token,
          "subject_token_type": "urn:ietf:params:oauth:token-type:id_token", **extra}
  return client.post('/api/v1/auth/token-exchange', **({"data": body} if as_form else {"json": body}))


def test_a_trusted_job_gets_a_token_of_the_service_account(team, issuer, make_client):
  alice = team['alice']
  ci = account(alice)
  response = trust(alice, ci["id"], ref="main")
  assert response.status_code == 201, response.get_json()
  policy, = response.get_json()["ci_trust"]
  assert (policy["issuer"], policy["audience"], policy["created_by"]) == (ISSUER, AUDIENCE, "alice")
  assert policy["conditions"] == {"repository": ["camera-algo/isp"], "ref": ["refs/heads/main"]}

  bot = make_client()
  response = exchange(bot, issuer.token(), as_form=True)
  assert response.status_code == 200, response.get_json()
  answer = response.get_json()
  assert answer["access_token"].startswith("qab_tmp_") and answer["token_type"] == "Bearer"
  assert answer["issued_token_type"] == "urn:ietf:params:oauth:token-type:access_token"
  assert answer["service_account"] == f"{PROJECT}/ci[bot]" and answer["expires_in"] == 360 * 60
  assert answer["scopes"] == ["read", "ingest", "act"] and answer["projects"] == [PROJECT]

  # it sends results, which say who sent them
  response = ingest(bot, headers=bearer(answer["access_token"]), batch_label="from-ci")
  assert response.status_code == 200 and 'X-QABoard-Warning' not in response.headers
  from backend.database import db_session
  from backend.models import Output, Batch, AuditEvent, Token
  db_session.remove()
  output = Output.query.join(Batch).filter(Batch.label == "from-ci").one()
  assert output.data["submitted_by"]["user_name"] == f"{PROJECT}/ci[bot]"
  assert output.data["submitted_by"]["token_name"] == "GitHub Actions: camera-algo/isp@main"
  token = Token.query.filter(Token.kind == 'ci').one()
  assert token.data["job_url"] == "https://github.com/camera-algo/isp/actions/runs/42" and token.data["policy"] == policy["id"]
  event = AuditEvent.query.filter_by(action='token.exchange').one()
  assert event.actor_label == f"{PROJECT}/ci[bot]" and event.meta["repository"] == "camera-algo/isp" and event.meta["ref"] == "refs/heads/main"
  assert not AuditEvent.query.filter_by(action='token.create', target_id=str(token.id)).count()
  assert AuditEvent.query.filter_by(action='service_account.ci_trust.create').count() == 1
  # when it was last used, and the token, while it works
  detail = alice.get(f'/api/v1/service-accounts/{ci["id"]}').get_json()
  assert detail["ci_trust"][0]["last_used_at"] and [t["kind"] for t in detail["tokens"]] == ["ci"]

  # it can't reach other projects
  response = bot.get(f'/api/v1/commits?project={OTHER}', headers=bearer(answer["access_token"]))
  assert response.status_code == 403 and response.get_json()["reason"] == "token_project"


def test_invalid_id_tokens_are_refused(team, issuer, client):
  ci = account(team['alice'])
  assert trust(team['alice'], ci["id"]).status_code == 201
  other_key = RSAKey.generate_key(2048, parameters={"kid": "key-1"}, private=True)
  cases = {
    "wrong audience": (issuer.token(aud="https://elsewhere.example"), 403, "audience"),
    "expired": (issuer.token(exp=int(time.time()) - 3600, iat=int(time.time()) - 4000, nbf=None), 401, "expired"),
    "bad signature": (issuer.token(key=other_key), 401, "invalid"),
    "issued in the future": (issuer.token(nbf=int(time.time()) + 3600), 401, "invalid"),
    "no expiry": (issuer.token(exp=None), 401, "invalid"),
    "other repository": (issuer.token(repository="evil/isp", repository_id="666"), 403, "No service account trusts this job"),
    "not a JWT": ("not-a-jwt", 400, "JWT"),
  }
  for name, (token, status, message) in cases.items():
    response = exchange(client, token)
    assert response.status_code == status, (name, response.get_json())
    assert message in response.get_json()["error_description"], (name, response.get_json())
  # never the token in the answer
  assert issuer.token() not in str(exchange(client, issuer.token(aud="x")).get_json())


def test_alg_none_and_symmetric_algorithms_are_refused(team, issuer, client):
  ci = account(team['alice'])
  assert trust(team['alice'], ci["id"]).status_code == 201
  import base64, json
  b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()
  claims = {"iss": ISSUER, "aud": AUDIENCE, "repository": "camera-algo/isp", "exp": int(time.time()) + 300, "iat": int(time.time())}
  unsigned = f"{b64({'alg': 'none'})}.{b64(claims)}."
  response = exchange(client, unsigned)
  assert response.status_code == 401 and response.get_json()["error"] == "invalid_grant"
  from joserfc.jwk import OctKey
  hs256 = jwt.encode({"alg": "HS256"}, claims, OctKey.import_key("a-secret-of-at-least-32-bytes-ok!!"))
  assert exchange(client, hs256).status_code == 401


def test_issuers_that_no_policy_trusts_are_never_fetched(team, issuer, client):
  ci = account(team['alice'])
  assert trust(team['alice'], ci["id"]).status_code == 201
  # signed by a key at an issuer we don't trust: refused before any request (the fixture checks it)
  other = issuer.token(iss="https://internal.example/oidc")
  response = exchange(client, other)
  assert response.status_code == 403 and "No service account on this server trusts CI jobs from https://internal.example/oidc" in response.get_json()["error_description"]


def test_policies_must_pin_the_repository(team, issuer):
  alice = team['alice']
  ci = account(alice)
  refused = [
    {"repository": None},
    {"repository": "*"},
    {"repository": "*/*"},
    {"repository": "c*/isp"},
    {"repository": "isp"},
    {"repository": None, "conditions": {"repository_id": ["12*"]}},
    {"repository": "camera-algo/isp", "conditions": {"ref": ["*"]}},
    {"repository": "camera-algo/isp", "conditions": {"aud": ["x"]}},
    {"provider": "gitlab", "repository": None, "conditions": {"ref": ["main"]}},
    {"provider": "other", "issuer": "https://ci.example.com", "repository": None, "conditions": {"sub": ["*:main"]}},
    {"provider": "other", "issuer": "http://ci.example.com", "repository": "x"},
  ]
  for body in refused:
    response = trust(alice, ci["id"], **body)
    assert response.status_code == 400, (body, response.get_json())
  assert trust(alice, ci["id"], repository="camera-algo/*").status_code == 201
  # the same twice
  assert trust(alice, ci["id"], repository="camera-algo/*").status_code == 409


def test_only_admins_trust_issuers_that_arent_git_hosts(team, issuer, monkeypatch):
  alice, root = team['alice'], team['root']
  ci = account(alice)
  gitlab = dict(provider="gitlab", issuer="https://gitlab.example.com/", repository="camera-algo/isp", environment="production")
  # the server would fetch their keys
  response = trust(alice, ci["id"], **gitlab)
  assert response.status_code == 403 and "admin" in response.get_json()["error"]
  import sys
  from types import SimpleNamespace
  git_hosts = sys.modules['backend.git_hosts']
  monkeypatch.setattr(git_hosts, 'git_hosts', [SimpleNamespace(url="https://gitlab.example.com")])
  response = trust(alice, ci["id"], **gitlab)
  assert response.status_code == 201
  monkeypatch.setattr(git_hosts, 'git_hosts', [])
  assert trust(root, ci["id"], **{**gitlab, "issuer": "https://ci.example.com"}).status_code == 201
  gitlab = response.get_json()["ci_trust"][-1]
  assert gitlab["issuer"] == "https://gitlab.example.com" and gitlab["conditions"] == {"project_path": ["camera-algo/isp"], "environment": ["production"]}


def test_who_manages_trusted_jobs(team, issuer):
  alice, bob, root = team['alice'], team['bob'], team['root']
  ci = account(alice)
  # developers aren't owners
  assert trust(bob, ci["id"]).status_code == 403
  policy = trust(alice, ci["id"]).get_json()["ci_trust"][0]
  assert bob.delete(f'/api/v1/service-accounts/{ci["id"]}/ci-trust/{policy["id"]}').status_code == 403
  response = alice.delete(f'/api/v1/service-accounts/{ci["id"]}/ci-trust/{policy["id"]}')
  assert response.status_code == 200 and response.get_json()["ci_trust"] == []
  assert alice.delete(f'/api/v1/service-accounts/{ci["id"]}/ci-trust/{policy["id"]}').status_code == 404
  # the instance's are admins'
  nightly = root.post('/api/v1/service-accounts', json={"name": "nightly"}).get_json()
  assert trust(alice, nightly["id"]).status_code == 403
  assert trust(root, nightly["id"]).status_code == 201
  from backend.models import AuditEvent
  assert AuditEvent.query.filter_by(action='service_account.ci_trust.delete').count() == 1


def test_conditions_and_accounts(team, issuer, client):
  alice, root = team['alice'], team['root']
  ci = account(alice)
  assert trust(alice, ci["id"], ref="main").status_code == 201
  # another branch
  response = exchange(client, issuer.token(ref="refs/heads/feature"))
  assert response.status_code == 403 and "camera-algo/isp" in response.get_json()["error_description"]
  # an instance account trusts the job too: which one?
  nightly = root.post('/api/v1/service-accounts', json={"name": "nightly", "role": "viewer"}).get_json()
  assert trust(root, nightly["id"], repository="camera-algo/*").status_code == 201
  response = exchange(client, issuer.token())
  assert response.status_code == 400 and "QABOARD_SERVICE_ACCOUNT" in response.get_json()["error_description"]
  response = exchange(client, issuer.token(), service_account="nightly[bot]")
  assert response.status_code == 200 and response.get_json()["service_account"] == "nightly[bot]"
  assert response.get_json()["projects"] == []
  response = exchange(client, issuer.token(), service_account=f"{PROJECT}/ci[bot]")
  assert response.get_json()["service_account"] == f"{PROJECT}/ci[bot]"
  response = exchange(client, issuer.token(), service_account="someone-else")
  assert response.status_code == 403
  # deleted (disabled) accounts trust nobody
  assert root.delete(f'/api/v1/service-accounts/{nightly["id"]}').status_code == 200
  assert exchange(client, issuer.token()).get_json()["service_account"] == f"{PROJECT}/ci[bot]"


def test_the_exchange_needs_the_grant_type(client):
  response = client.post('/api/v1/auth/token-exchange', json={"subject_token": "x"})
  assert response.status_code == 400 and response.get_json()["error"] == "unsupported_grant_type"
  response = exchange(client, "x", subject_token_type="urn:ietf:params:oauth:token-type:saml2")
  assert response.status_code == 400


def test_the_exchange_works_when_signing_in_is_required(team, issuer, client, monkeypatch):
  ci = account(team['alice'])
  assert trust(team['alice'], ci["id"]).status_code == 201
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  response = exchange(client, issuer.token())
  assert response.status_code == 200, response.get_json()
  assert ingest(client, headers=bearer(response.get_json()["access_token"])).status_code == 200


def test_what_tokens_say_about_gitlab_jobs():
  from backend.ci_trust import describe_job, job_label
  job = describe_job('gitlab', {"iss": "https://gitlab.example.com", "project_path": "camera-algo/isp", "ref": "main",
                                "pipeline_id": 7, "job_id": 42, "environment": "production"})
  assert job == {"client": "GitLab CI", "repository": "camera-algo/isp", "ref": "main", "run_id": "7", "job_id": "42",
                 "environment": "production", "job_url": "https://gitlab.example.com/camera-algo/isp/-/jobs/42"}
  assert job_label(job) == "GitLab CI: camera-algo/isp@main"
