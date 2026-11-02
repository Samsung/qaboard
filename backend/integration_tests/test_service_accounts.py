"""
Service accounts (backend/service_accounts.py): the instance's, managed by admins, and projects', managed by their
owners. They only use tokens, never reach outside of their project, and deleting them stops their tokens.
"""
import pytest

from .conftest import bearer
from .test_access import ingest, ids, team, PROJECT


OTHER = 'group/other'


def create(client, **body):
  return client.post('/api/v1/service-accounts', json={"name": "ci", **body})


def new_token(client, account_id, **body):
  response = client.post(f'/api/v1/service-accounts/{account_id}/tokens', json={"name": "gitlab", "scopes": ["read", "ingest", "act"], **body})
  assert response.status_code == 201, response.get_json()
  return response.get_json()


def test_project_owners_create_service_accounts_and_tokens(team, make_client):
  alice = team['alice']
  response = create(alice, project=PROJECT, role='developer', description="GitLab CI")
  assert response.status_code == 201, response.get_json()
  account = response.get_json()
  assert (account["user_name"], account["name"], account["role"], account["project"], account["owner_type"]) == \
         (f"{PROJECT}/ci[bot]", "ci", "developer", PROJECT, "project")
  assert account["description"] == "GitLab CI" and account["created_by"] == "alice"
  # it's a member of the project, like anyone
  grants = alice.get(f'/api/v1/project/access?project={PROJECT}').get_json()["grants"]
  assert any(g["subject"]["name"] == f"{PROJECT}/ci[bot]" and g["subject"]["kind"] == "service" and g["role"] == "developer" for g in grants)

  token = new_token(alice, account["id"], projects=[OTHER])
  assert token["token"].startswith("qab_svc_") and token["kind"] == "service"
  # restricted to its project, whatever was asked
  assert token["projects"] == [PROJECT]
  listed = alice.get(f'/api/v1/service-accounts?project={PROJECT}').get_json()["service_accounts"]
  assert [(a["name"], a["active_tokens"]) for a in listed] == [("ci", 1)]
  assert "token" not in alice.get(f'/api/v1/service-accounts/{account["id"]}').get_json()["tokens"][0]

  bot = make_client()
  me = bot.get('/api/v1/user/me/', headers=bearer(token["token"])).get_json()
  assert (me["user_name"], me["kind"], me["is_admin"]) == (f"{PROJECT}/ci[bot]", "service", False)
  # it sends results, and they say who sent them
  response = ingest(bot, headers=bearer(token["token"]), batch_label="from-ci")
  assert response.status_code == 200 and 'X-QABoard-Warning' not in response.headers
  from backend.database import db_session
  from backend.models import Output, Batch
  db_session.remove()
  output = Output.query.join(Batch).filter(Batch.label == "from-ci").one()
  assert output.data["submitted_by"]["user_name"] == f"{PROJECT}/ci[bot]"
  assert output.data["submitted_by"]["token_name"] == "gitlab"


def test_project_service_accounts_never_reach_other_projects(team, make_client):
  alice, root = team['alice'], team['root']
  assert ingest(make_client(), project=OTHER).status_code == 200
  account = create(alice, project=PROJECT, role='developer').get_json()
  secret = new_token(alice, account["id"])["token"]
  # even when someone gives it a role there
  response = root.post('/api/v1/project/access/grants', json={"project": OTHER, "subject": {"type": "user", "id": account["id"]}, "role": "developer"})
  assert response.status_code == 201
  bot = make_client()
  assert bot.get(f'/api/v1/commits?project={PROJECT}', headers=bearer(secret)).status_code == 200
  response = bot.get(f'/api/v1/commits?project={OTHER}', headers=bearer(secret))
  assert response.status_code == 403 and response.get_json()["reason"] == "token_project"
  # ingest.auth is off: saved like anonymous results, and the CLI is told why
  response = ingest(bot, project=OTHER, headers=bearer(secret))
  assert response.status_code == 200 and "can't send results to group/other" in response.headers['X-QABoard-Warning']
  # nor are they offered as members elsewhere
  users = alice.get('/api/v1/directory?q=ci').get_json()["users"]
  assert users == []


def test_who_manages_service_accounts(team, make_client):
  alice, bob, dave, root = team['alice'], team['bob'], team['dave'], team['root']
  # developers aren't owners
  assert create(bob, project=PROJECT, role='developer').status_code == 403
  assert bob.get(f'/api/v1/service-accounts?project={PROJECT}').status_code == 403
  # the instance's: admins only
  response = create(alice, role='viewer')
  assert response.status_code == 403 and response.get_json()["reason"] == "not_admin"
  assert alice.get('/api/v1/service-accounts').status_code == 403
  account = create(alice, project=PROJECT, role='developer').get_json()
  for client in (bob, dave):
    assert client.get(f'/api/v1/service-accounts/{account["id"]}').status_code == 403
    assert client.post(f'/api/v1/service-accounts/{account["id"]}/tokens', json={"name": "x", "scopes": ["read"]}).status_code == 403
    assert client.delete(f'/api/v1/service-accounts/{account["id"]}').status_code == 403
  # admins manage every service account
  assert root.get(f'/api/v1/service-accounts/{account["id"]}').status_code == 200
  # tokens can't create service accounts, nor tokens
  secret = alice.post('/api/v1/user/tokens', json={"name": "x", "scopes": ["read", "act"]}).get_json()["token"]
  response = make_client().post('/api/v1/service-accounts', json={"name": "ci2", "project": PROJECT, "role": "viewer"}, headers=bearer(secret))
  assert response.status_code == 403 and response.get_json()["reason"] == "session_required"
  response = make_client().post(f'/api/v1/service-accounts/{account["id"]}/tokens', json={"name": "x", "scopes": ["read"]}, headers=bearer(secret))
  assert response.status_code == 403 and response.get_json()["reason"] == "session_required"


def test_instance_service_accounts(team, make_client):
  root, alice = team['root'], team['alice']
  assert ingest(make_client(), project=OTHER).status_code == 200
  # no role yet: owners can add it to their projects
  response = create(root, name='nightly')
  assert response.status_code == 201, response.get_json()
  account = response.get_json()
  assert (account["user_name"], account["role"], account["owner_type"], account["project"]) == ("nightly[bot]", None, "instance", None)
  assert [u["user_name"] for u in alice.get('/api/v1/directory?q=nightly').get_json()["users"]] == ["nightly[bot]"]
  secret = new_token(root, account["id"])["token"]
  bot = make_client()
  assert bot.get(f'/api/v1/commits?project={PROJECT}', headers=bearer(secret)).status_code == 403
  # a role on all projects
  response = root.post(f'/api/v1/service-accounts/{account["id"]}', json={"role": "viewer"})
  assert response.status_code == 200 and response.get_json()["role"] == "viewer"
  assert bot.get(f'/api/v1/commits?project={PROJECT}', headers=bearer(secret)).status_code == 200
  batch_id, _ = ids()
  assert bot.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "x"}, headers=bearer(secret)).status_code == 403
  # owners give it more on their project
  response = alice.post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "user", "id": account["id"]}, "role": "developer"})
  assert response.status_code == 201
  assert bot.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "x"}, headers=bearer(secret)).status_code == 200
  assert root.post(f'/api/v1/service-accounts/{account["id"]}', json={"role": None}).get_json()["role"] is None
  assert [a["name"] for a in root.get('/api/v1/service-accounts').get_json()["service_accounts"]] == ["nightly"]
  # never the admin API
  response = root.post(f'/api/v1/service-accounts/{account["id"]}/tokens', json={"name": "x", "scopes": ["admin"]})
  assert response.status_code == 400 and "can't have the scopes: admin" in response.get_json()["error"]


def test_service_accounts_cant_sign_in(team, make_client):
  root = team['root']
  account = create(root, name='ci', role='viewer').get_json()
  response = make_client().post('/api/v1/user/auth/', data={"username": account["user_name"], "password": "password"})
  assert response.status_code == 403
  # people can't take their names
  response = make_client().post('/api/v1/user/signup/', data={"user_name": "ci[bot]", "password": "password"})
  assert response.status_code in (400, 409)
  response = make_client().post('/api/v1/user/signup/', data={"user_name": "other[bot]", "password": "password"})
  assert response.status_code == 400


def test_deleting_a_service_account_stops_its_tokens(team, make_client):
  alice = team['alice']
  account = create(alice, project=PROJECT, role='developer').get_json()
  secret = new_token(alice, account["id"])["token"]
  bot = make_client()
  assert bot.get('/api/v1/user/me/', headers=bearer(secret)).status_code == 200
  assert alice.delete(f'/api/v1/service-accounts/{account["id"]}').status_code == 200
  response = bot.get('/api/v1/user/me/', headers=bearer(secret))
  assert response.status_code == 401
  assert alice.get(f'/api/v1/service-accounts?project={PROJECT}').get_json()["service_accounts"] == []
  assert alice.get(f'/api/v1/service-accounts/{account["id"]}').status_code == 404
  grants = alice.get(f'/api/v1/project/access?project={PROJECT}').get_json()["grants"]
  assert not any(g["subject"]["id"] == account["id"] for g in grants)
  # the name stays taken: runs keep saying who sent them
  assert create(alice, project=PROJECT, role='developer').status_code == 409
  from backend.models import AuditEvent
  actions = [e.action for e in AuditEvent.query.filter(AuditEvent.target_id == str(account["id"])).all()]
  assert {"service_account.create", "service_account.delete"} <= set(actions)


def test_revoking_a_service_account_token(team, make_client):
  alice = team['alice']
  account = create(alice, project=PROJECT, role='viewer').get_json()
  token = new_token(alice, account["id"], scopes=["read"])
  response = alice.delete(f'/api/v1/service-accounts/{account["id"]}/tokens/{token["id"]}')
  assert response.status_code == 200 and response.get_json()["status"] == "revoked"
  response = make_client().get('/api/v1/user/me/', headers=bearer(token["token"]))
  assert response.status_code == 401 and response.get_json()["reason"] == "token_revoked"


@pytest.mark.parametrize("body, message", [
  ({"name": "CI bot", "role": "viewer"}, "lowercase"),
  ({"name": "ci", "role": "boss"}, "role"),
  ({"name": "ci"}, "role"),
])
def test_invalid_service_accounts(team, body, message):
  response = team['alice'].post('/api/v1/service-accounts', json={"project": PROJECT, **body})
  assert response.status_code == 400 and message in response.get_json()["error"]
