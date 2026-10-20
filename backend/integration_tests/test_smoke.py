"""What we checked by hand before the user management changes: signup, login, milestones, tokens"""
from .conftest import login, bearer


def test_signup_login_me(client):
  response = client.post('/api/v1/user/signup/', data={"user_name": "alice", "password": "pw", "email": "a@example.com", "full_name": "Alice"})
  assert response.status_code == 200, response.get_json()
  assert "password" not in response.get_json()
  response = client.post('/api/v1/user/auth/', data={"username": "alice", "password": "pw"})
  assert response.status_code == 200
  assert "data" not in response.get_json()
  me = client.get('/api/v1/user/me/').get_json()
  assert me["is_authenticated"] and me["user_name"] == "alice"
  assert me["is_admin"] is False and me["status"] == "active" and me["kind"] == "human"
  assert "data" not in me


def test_wrong_password_doesnt_say_which(client, make_user):
  make_user('alice')
  for form in [{"username": "alice", "password": "wrong"}, {"username": "nobody", "password": "wrong"}]:
    response = client.post('/api/v1/user/auth/', data=form)
    assert response.status_code == 403
    assert response.get_json() == {"error": "Wrong user name or password.", "reason": "invalid_credentials"}


def test_milestones(logged_in, make_client):
  from backend.database import db_session
  from backend.models import Project
  db_session.add(Project(id='group/repo', data={}))
  db_session.commit()
  client = logged_in('bob')
  response = client.post('/api/v1/milestones', json={"project": "group/repo", "commit": "a" * 40, "label": "v1", "shared": True})
  assert response.status_code == 201, response.get_json()
  milestone_id = response.get_json()["id"]
  assert client.put(f'/api/v1/milestones/{milestone_id}/favorite').status_code == 200
  milestones = client.get('/api/v1/milestones?project=group/repo').get_json()["milestones"]
  assert [(m["label"], m["is_favorite"], m["can_edit"]) for m in milestones] == [("v1", True, True)]
  assert client.delete(f'/api/v1/milestones/{milestone_id}').status_code == 200
  anonymous = make_client()
  assert anonymous.post('/api/v1/milestones', json={"project": "group/repo", "commit": "a" * 40}).status_code == 401


def test_legacy_token_endpoint(logged_in, make_client):
  client = logged_in('carol')
  answer = client.post('/api/v1/user/token/').get_json()
  assert answer["token"].startswith("qab_pat_") and answer["expires_at"]
  me = make_client().get('/api/v1/user/me/', headers=bearer(answer["token"])).get_json()
  assert me["user_name"] == "carol"
  # the scopes tokens had before scopes: not the admin API
  assert set(me["token"]["scopes"]) == {"read", "ingest", "act"}
