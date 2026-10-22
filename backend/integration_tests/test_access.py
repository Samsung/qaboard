"""
Roles on projects (docs/design/user-management.md, Appendix D): visibility, grants, groups, access requests, and every
project endpoint as an outsider, a viewer and a developer of a private project.
"""
import os
import datetime
from pathlib import Path

import pytest

from .conftest import login, new_token, bearer


PROJECT = 'group/secret'
SHA = 'c' * 40
STORAGE = Path(os.environ.get('QABOARD_STORAGE_ROOTS', '/tmp').split(':')[0])


def ingest(client, project=PROJECT, headers=None, **extra):
  payload = {
    "project": project, "commit_sha": SHA, "commit_branch": "master", "commit_authored_datetime": "2026-10-01T12:00:00+00:00",
    "commit_message": "a commit", "commit_committer_name": "Alice", "commit_parents": [],
    "batch_label": "default", "job_type": "local", "platform": "linux", "user": "alice", "configurations": ["base"],
    "extra_parameters": {}, "database": str(STORAGE / "database"), "rel_input_path": "inputs/a.txt", "input_type": "",
    "is_pending": False, "metrics": {"loss": 1.0}, **extra,
  }
  return client.post('/api/v1/output/', json=payload, headers=headers or {})


def ids(project=PROJECT):
  from backend.database import db_session
  from backend.models import Output, Batch, CiCommit
  db_session.remove()
  output = Output.query.join(Batch).join(CiCommit).filter(CiCommit.project_id == project).first()
  return output.batch.id, output.id


@pytest.fixture
def team(client, logged_in, monkeypatch):
  """group/secret, private: alice owns it, bob is a developer, carol a viewer, dave nothing. root is an admin."""
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  assert ingest(client).status_code == 200
  users = {name: logged_in(name) for name in ('root', 'alice', 'bob', 'carol', 'dave')}
  from backend.models import User
  user_ids = {u.user_name: u.id for u in User.query.all()}
  root = users['root']
  for name, role in [('alice', 'owner'), ('bob', 'developer'), ('carol', 'viewer')]:
    response = root.post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "user", "id": user_ids[name]}, "role": role})
    assert response.status_code == 201, response.get_json()
  assert users['alice'].post('/api/v1/project/access/visibility', json={"project": PROJECT, "visibility": "private"}).status_code == 200
  users['ids'] = user_ids
  return users


def test_defaults_keep_todays_behaviour(client, logged_in):
  """Public projects, and signed-in users are developers: as before roles"""
  assert ingest(client).status_code == 200
  batch_id, _ = ids()
  assert client.get(f'/api/v1/commits?project={PROJECT}').status_code == 200
  dave = logged_in('dave')
  assert dave.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "renamed"}).status_code == 200
  access = dave.get(f'/api/v1/project/access?project={PROJECT}').get_json()
  assert (access["my_role"], access["via"], access["can_manage"]) == ("developer", "signed_in", False)
  assert access["visibility"] == {"effective": "public", "own": None, "inherited_from": None, "default": "public", "parent": "public"}
  assert client.get(f'/api/v1/project/access?project={PROJECT}').get_json()["my_role"] == "viewer"


def test_signed_in_users_as_viewers(client, logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_SIGNED_IN_ROLE', 'viewer')
  assert ingest(client).status_code == 200
  batch_id, _ = ids()
  dave = logged_in('dave')
  assert dave.get(f'/api/v1/commits?project={PROJECT}').status_code == 200
  response = dave.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "renamed"})
  assert response.status_code == 403
  body = response.get_json()
  assert (body["reason"], body["required"], body["role"], body["project"]) == ("missing_role", "developer", "viewer", PROJECT)
  assert body["error"] == f"You need the developer role to change the runs of {PROJECT}: you're a viewer."


# endpoint: (method, url, json), expected for (outsider, viewer, developer): "ok" (not 401/403), or the status
def endpoints(batch_id, output_id):
  return {
    "commits": (("GET", f'/api/v1/commits?project={PROJECT}', None), (403, "ok", "ok")),
    "project": (("GET", f'/api/v1/project?project={PROJECT}', None), (403, "ok", "ok")),
    "commit": (("GET", f'/api/v1/commit/{SHA}?project={PROJECT}', None), (403, "ok", "ok")),
    "branches": (("GET", f'/api/v1/project/branches?project={PROJECT}', None), (403, "ok", "ok")),
    "output": (("GET", f'/api/v1/output/{output_id}', None), (403, "ok", "ok")),
    "manifest": (("GET", f'/api/v1/output/{output_id}/manifest', None), (403, "ok", "ok")),
    "milestones": (("GET", f'/api/v1/milestones?project={PROJECT}', None), (403, "ok", "ok")),
    "compare": (("GET", f'/api/v1/commit/{SHA}/compare?project={PROJECT}', None), (403, "ok", "ok")),
    "groups": (("GET", f'/api/v1/tests/groups?project={PROJECT}&name=extra-batches', None), (403, "ok", "ok")),
    "access": (("GET", f'/api/v1/project/access?project={PROJECT}', None), (403, "ok", "ok")),
    "rename": (("POST", '/api/v1/batch/rename/', {"id": batch_id, "label": "renamed"}), (403, 403, "ok")),
    "update run": (("PUT", f'/api/v1/output/{output_id}', {"is_failed": True}), (403, 403, "ok")),
    "save groups": (("POST", f'/api/v1/tests/groups?project={PROJECT}&name=extra-batches', {"groups": {}}), (403, 403, "ok")),
    "export": (("POST", f'/api/v1/export?project={PROJECT}&new_commit_id={SHA}', None), (403, 403, "ok")),
    "milestone": (("POST", '/api/v1/milestones', {"project": PROJECT, "label": "m", "commit_hexsha": SHA, "commit_project_id": PROJECT, "batch": "default"}), (403, 403, "ok")),
    "visibility": (("POST", '/api/v1/project/access/visibility', {"project": PROJECT, "visibility": "private"}), (403, 403, 403)),
  }


def call(client, method, url, body):
  return client.open(url, method=method, json=body) if body is not None else client.open(url, method=method)


ACCESS_REASONS = {"sign_in_required", "missing_role", "token_project", "missing_scope"}

def refused(response) -> bool:
  """Refused because of who's calling (not, e.g., a missing storage folder)"""
  if response.status_code not in (401, 403):
    return False
  return (response.get_json(silent=True) or {}).get("reason") in ACCESS_REASONS


def test_every_endpoint_follows_the_role(team):
  batch_id, output_id = ids()
  failures = []
  for name, ((method, url, body), expected) in endpoints(batch_id, output_id).items():
    for user, want in zip(('dave', 'carol', 'bob'), expected):
      response = call(team[user], method, url, body)
      ok = not refused(response) if want == "ok" else (response.status_code == want and refused(response))
      if not ok:
        failures.append(f"{name} as {user}: {response.status_code} {response.get_data(as_text=True)[:100]}, expected {want}")
  assert not failures, failures


def test_anonymous_users_are_asked_to_sign_in(team, client):
  response = client.get(f'/api/v1/commits?project={PROJECT}')
  assert response.status_code == 401
  assert response.get_json() == {"error": f"Sign in to see {PROJECT}.", "reason": "sign_in_required"}
  assert PROJECT not in client.get('/api/v1/projects').get_json()


def test_refusals_say_whom_to_ask(team):
  response = team['dave'].get(f'/api/v1/commits?project={PROJECT}')
  body = response.get_json()
  assert body["reason"] == "missing_role" and body["can_request"] is True and body["role"] is None
  assert [o["name"] for o in body["owners"]] == ["alice"]
  assert body["error"] == f"You don't have access to {PROJECT}."
  assert PROJECT not in team['dave'].get('/api/v1/projects').get_json()
  assert PROJECT in team['carol'].get('/api/v1/projects').get_json()


def test_admins_are_owners_everywhere(team):
  access = team['root'].get(f'/api/v1/project/access?project={PROJECT}').get_json()
  assert (access["my_role"], access["via"], access["can_manage"]) == ("owner", "admin", True)


def test_the_access_page(team):
  owner = team['alice'].get(f'/api/v1/project/access?project={PROJECT}').get_json()
  assert owner["can_manage"] and owner["visibility"]["effective"] == "private" and owner["visibility"]["own"] == "private"
  assert sorted((g["subject"]["name"], g["role"], g["inherited"]) for g in owner["grants"]) == [
    ("alice", "owner", False), ("bob", "developer", False), ("carol", "viewer", False)]
  viewer = team['carol'].get(f'/api/v1/project/access?project={PROJECT}').get_json()
  assert viewer["my_role"] == "viewer" and viewer["via"] == "grant" and not viewer["can_manage"]
  assert "grants" not in viewer and [o["name"] for o in viewer["owners"]] == ["alice"]


def test_visibility_and_grants_apply_to_the_projects_under_a_prefix(client, logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  for project in ('group/a', 'group/a/sub', 'groupie/x'):
    assert ingest(client, project=project).status_code == 200
  root, bob = logged_in('root'), logged_in('bob')
  from backend.models import User
  bob_id = User.query.filter(User.user_name == 'bob').one().id
  # a private group makes its projects private, they can't be more public
  root.post('/api/v1/project/access/visibility', json={"project": "group", "visibility": "private"})
  root.post('/api/v1/project/access/visibility', json={"project": "group/a/sub", "visibility": "public"})
  visibility = root.get('/api/v1/project/access?project=group/a/sub').get_json()["visibility"]
  assert visibility == {"effective": "private", "own": "public", "inherited_from": "group", "default": "public", "parent": "private"}
  assert bob.get('/api/v1/commits?project=group/a/sub').status_code == 403
  # a grant on the group: its projects, by path segments
  root.post('/api/v1/project/access/grants', json={"project": "group", "subject": {"type": "user", "id": bob_id}, "role": "viewer"})
  assert bob.get('/api/v1/commits?project=group/a/sub').status_code == 200
  assert bob.get('/api/v1/commits?project=groupie/x').status_code == 200 # public
  root.post('/api/v1/project/access/visibility', json={"project": "groupie", "visibility": "private"})
  assert bob.get('/api/v1/commits?project=groupie/x').status_code == 403
  grants = root.get('/api/v1/project/access?project=group/a').get_json()["grants"]
  assert [(g["subject"]["name"], g["resource_id"], g["inherited"]) for g in grants] == [("bob", "group", True)]


def test_project_ids_with_dots_dont_get_around_access(team, client):
  """pub/../group/secret would get pub's access (public, or a grant on pub), and reach group/secret's files"""
  from backend.api.tuning import get_groups_path
  get_groups_path(PROJECT, name='extra-batches').write_text("secret: {}")
  dave = team['dave']
  assert dave.get(f'/api/v1/tests/groups?project={PROJECT}&name=extra-batches').status_code == 403
  for project in ['pub/../group/secret', 'group/./secret', 'group//secret', 'pub/..', '..']:
    for response in [dave.get(f'/api/v1/tests/groups?project={project}&name=extra-batches'),
                     dave.post(f'/api/v1/tests/groups?project={project}&name=extra-batches', json={"groups": "x: {}"}),
                     dave.get(f'/api/v1/commits?project={project}'),
                     client.get(f'/api/v1/project?project={project}')]:
      assert response.status_code == 400 and response.get_json()["reason"] == "invalid_project", (project, response.request.path)
  assert get_groups_path(PROJECT, name='extra-batches').read_text() == "secret: {}"
  # qa can't create such projects
  for project in ['pub/../group/secret', 'a//b', '/a/b', 'a/b/', '']:
    response = ingest(client, project=project)
    assert response.status_code == 400 and response.get_json()["reason"] == "invalid_project", project
  from backend.models import Project
  assert [p.id for p in Project.query.all()] == [PROJECT]
  # slashes around are tolerated to read, like before
  assert team['carol'].get(f'/api/v1/commits?project=/{PROJECT}/').status_code == 200
  assert team['dave'].get(f'/api/v1/commits?project=/{PROJECT}/').status_code == 403


def test_imported_milestones_need_access_to_their_results(team, client):
  """Milestones protect their results from deletion, and describe their runs: like when saving one"""
  from backend.database import db_session
  from backend.models import Milestone
  assert ingest(client, project='pub').status_code == 200
  legacy = {"milestones": {"pub": {f"group/secret/{SHA}/default": {"commit": SHA, "project": PROJECT, "label": "theirs"}}}}
  answer = team['dave'].post('/api/v1/milestones/import', json=legacy).get_json()
  assert answer["imported"] == 0 and answer["done"] == [] and "group/secret" in answer["skipped"][0]["reason"]
  answer = team['carol'].post('/api/v1/milestones/import', json=legacy).get_json()
  assert answer["imported"] == 1 and answer["done"] == ["pub"]
  # viewers don't save milestones
  answer = team['carol'].post('/api/v1/milestones/import', json={"milestones": {PROJECT: {f"{PROJECT}/{SHA}/default": {"commit": SHA}}}}).get_json()
  assert answer["imported"] == 0 and answer["done"] == [] and answer["skipped"][0]["project"] == PROJECT
  assert [m.label for m in Milestone.query.all()] == ["theirs"]
  # milestones from before, listed by users who can't see their results, aren't described with them
  db_session.add(Milestone(project_id='pub', commit_project_id=PROJECT, commit_hexsha=SHA, batch='default', shared=True, label='old', data={}))
  db_session.commit()
  assert team['dave'].get('/api/v1/milestones?project=pub').status_code == 200
  db_session.remove()
  assert 'runs' not in Milestone.query.filter(Milestone.label == 'old').one().data
  team['carol'].get('/api/v1/milestones?project=pub')
  db_session.remove()
  assert Milestone.query.filter(Milestone.label == 'old').one().data['runs']


def test_expired_grants_are_ignored(team):
  from backend.database import db_session
  from backend.models import RoleGrant
  RoleGrant.query.filter(RoleGrant.subject_id == team['ids']['carol']).update({"expires_at": datetime.datetime.utcnow() - datetime.timedelta(minutes=1)})
  db_session.commit()
  assert team['carol'].get(f'/api/v1/commits?project={PROJECT}').status_code == 403
  response = team['alice'].post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "user", "id": team['ids']['carol']}, "role": "viewer", "expires_at": "2020-01-01"})
  assert response.status_code == 400 and "future" in response.get_json()["error"]


def test_projects_keep_an_owner(team):
  owner_grant = next(g for g in team['alice'].get(f'/api/v1/project/access?project={PROJECT}').get_json()["grants"] if g["role"] == "owner")
  response = team['alice'].delete(f'/api/v1/project/access/grants/{owner_grant["id"]}')
  assert response.status_code == 400 and "last owner" in response.get_json()["error"]
  # demoting yourself is the same
  response = team['alice'].post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "user", "id": team['ids']['alice']}, "role": "developer"})
  assert response.status_code == 400
  # with another owner, it's fine
  team['alice'].post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "user", "id": team['ids']['bob']}, "role": "owner"})
  assert team['alice'].delete(f'/api/v1/project/access/grants/{owner_grant["id"]}').status_code == 200
  # the project is private: without a grant, she can't see it anymore
  assert team['alice'].get(f'/api/v1/project/access?project={PROJECT}').status_code == 403


def test_access_requests(team):
  dave, alice = team['dave'], team['alice']
  assert dave.post('/api/v1/project/access/requests', json={"project": "nope/nope", "role": "viewer"}).status_code == 404
  response = dave.post('/api/v1/project/access/requests', json={"project": PROJECT, "role": "developer", "message": "camera team"})
  assert response.status_code == 201
  # one pending request per user and project
  assert dave.post('/api/v1/project/access/requests', json={"project": PROJECT, "role": "viewer", "message": "just looking"}).status_code == 200
  requests = alice.get(f'/api/v1/project/access?project={PROJECT}').get_json()["requests"]
  assert [(r["user"]["user_name"], r["role"], r["message"]) for r in requests] == [("dave", "viewer", "just looking")]
  # only managers decide
  assert team['bob'].post(f'/api/v1/project/access/requests/{requests[0]["id"]}', json={"decision": "approve"}).status_code == 403
  response = alice.post(f'/api/v1/project/access/requests/{requests[0]["id"]}', json={"decision": "approve", "role": "developer"})
  assert response.status_code == 200 and response.get_json()["status"] == "approved"
  batch_id, _ = ids()
  assert dave.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "renamed"}).status_code == 200
  assert alice.get(f'/api/v1/project/access?project={PROJECT}').get_json()["requests"] == []
  # no request for a role you have
  response = team['bob'].post('/api/v1/project/access/requests', json={"project": PROJECT, "role": "viewer"})
  assert response.status_code == 400 and "already a developer" in response.get_json()["error"]
  # denied
  team['carol'].post('/api/v1/project/access/requests', json={"project": PROJECT, "role": "developer"})
  request_id = alice.get(f'/api/v1/project/access?project={PROJECT}').get_json()["requests"][0]["id"]
  assert alice.post(f'/api/v1/project/access/requests/{request_id}', json={"decision": "deny"}).get_json()["status"] == "denied"
  assert team['carol'].get(f'/api/v1/project/access?project={PROJECT}').get_json()["my_role"] == "viewer"


def test_ingest_follows_roles(team, monkeypatch, make_client):
  """With ingest.auth=token, a developer's token can send results, a viewer's can't. Otherwise: saved, unverified."""
  carol_token = new_token(team['carol'])["token"]
  bob_token = new_token(team['bob'])["token"]
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  response = ingest(make_client(), headers=bearer(carol_token))
  assert response.status_code == 403 and response.get_json()["reason"] == "missing_role"
  assert ingest(make_client(), headers=bearer(bob_token)).status_code == 200
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'warn')
  response = ingest(make_client(), headers=bearer(carol_token))
  assert response.status_code == 200 and "developer role" in response.headers['X-QABoard-Warning']


def test_tokens_restricted_to_other_projects(team, make_client):
  token = new_token(team['bob'], projects=["other/*"])["token"]
  response = make_client().get(f'/api/v1/commits?project={PROJECT}', headers=bearer(token))
  assert response.status_code == 403 and response.get_json()["reason"] == "token_project"


def test_files_of_private_projects(team, client):
  from backend.database import db_session
  from backend.models import Project
  from backend.api.files import invalidate_project_dirs
  project = Project.query.filter(Project.id == PROJECT).one()
  project.data = {**project.data, "qatools_config": {"storage": str(STORAGE)}}
  db_session.commit()
  invalidate_project_dirs()
  path = STORAGE / PROJECT / 'output' / 'log.txt'
  assert client.get(f'/api/v1/files/authorize?path={path}').status_code == 401
  assert team['dave'].get(f'/api/v1/files/authorize?path={path}').status_code == 403
  assert team['carol'].get(f'/api/v1/files/authorize?path={path}').status_code == 204
  # a public project's files are public
  assert client.get(f'/api/v1/files/authorize?path={STORAGE / "other" / "x"}').status_code == 204
  # tokens restricted to other projects can't read them
  token = new_token(team['bob'], projects=["other/*"])["token"]
  assert client.get(f'/api/v1/files/authorize?path={path}', headers=bearer(token)).status_code == 403


def test_groups_from_sign_in_claims(team, make_client):
  root = team['root']
  group = root.post('/api/v1/admin/groups', json={"name": "camera-team", "description": "The camera algorithms team"}).get_json()
  assert root.post('/api/v1/admin/groups', json={"name": "Camera-Team"}).status_code == 409
  # the domain of verified emails: not local accounts', anyone can sign up with any email
  rule = root.post(f'/api/v1/admin/groups/{group["id"]}/rules', json={"claim": "email_domain", "values": ["EXAMPLE.com"]}).get_json()
  root.post('/api/v1/project/access/grants', json={"project": PROJECT, "subject": {"type": "group", "id": group["id"]}, "role": "viewer"})
  dave = make_client()
  assert dave.get(f'/api/v1/commits?project={PROJECT}').status_code == 401
  login(dave, 'dave')
  assert dave.get(f'/api/v1/commits?project={PROJECT}').status_code == 403
  # the directory's (e.g. an account LDAP knows)
  from backend.database import db_session
  from backend.models import User
  User.query.filter(User.user_name == 'dave').one().data = [["CN=dave,DC=example,DC=com", {"mail": ["dave@example.com"]}]]
  db_session.commit()
  login(dave, 'dave')
  assert dave.get(f'/api/v1/commits?project={PROJECT}').status_code == 200
  details = root.get(f'/api/v1/admin/groups/{group["id"]}').get_json()
  assert ("dave", "rule") in [(m["user"]["user_name"], m["source"]) for m in details["members"]]
  # without the rule, the next sign-in removes them, but not the members admins added
  root.post(f'/api/v1/admin/groups/{group["id"]}/members', json={"user_id": team['ids']['carol']})
  root.delete(f'/api/v1/admin/groups/{group["id"]}/rules/{rule["id"]}')
  login(make_client(), 'dave')
  login(make_client(), 'carol')
  members = root.get(f'/api/v1/admin/groups/{group["id"]}').get_json()["members"]
  assert [(m["user"]["user_name"], m["source"]) for m in members] == [("carol", "manual")]
  # deleting the group deletes its grants
  assert root.delete(f'/api/v1/admin/groups/{group["id"]}').status_code == 200
  from backend.models import RoleGrant
  assert RoleGrant.query.filter(RoleGrant.subject_type == 'group').count() == 0


def test_roles_on_all_projects(team):
  root = team['root']
  group = root.post('/api/v1/admin/groups', json={"name": "qa"}).get_json()
  root.post(f'/api/v1/admin/groups/{group["id"]}/members', json={"user_id": team['ids']['dave']})
  grant = root.post('/api/v1/admin/grants', json={"subject": {"type": "group", "id": group["id"]}, "role": "viewer"}).get_json()
  # private projects included
  assert team['dave'].get(f'/api/v1/commits?project={PROJECT}').status_code == 200
  assert [g["id"] for g in root.get('/api/v1/admin/grants?resource_type=instance').get_json()["grants"]] == [grant["id"]]
  assert team['alice'].get('/api/v1/admin/grants').status_code == 403
  root.delete(f'/api/v1/admin/grants/{grant["id"]}')
  assert team['dave'].get(f'/api/v1/commits?project={PROJECT}').status_code == 403


def test_the_directory(team):
  found = team['dave'].get('/api/v1/directory?q=car').get_json()
  assert [u["user_name"] for u in found["users"]] == ["carol"]
  assert team['dave'].get('/api/v1/directory?q=%25').get_json()["users"] == []


def test_the_yaml_restrictions_still_apply(client, logged_in, monkeypatch):
  """Projects in QABOARD_LOGIN_RESTRICTED_YAML are private, the users its rules match are developers"""
  import backend.api.auth as auth
  monkeypatch.setattr(auth, 'is_login_restricted', True)
  monkeypatch.setattr(auth, 'users_restrict_config', {"projects": {"group/secret": {"user_name": ["bob"]}}})
  assert ingest(client).status_code == 200
  batch_id, _ = ids()
  bob, dave = logged_in('bob'), logged_in('dave')
  assert dave.get(f'/api/v1/commits?project={PROJECT}').status_code == 403
  assert bob.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "renamed"}).status_code == 200
  access = bob.get(f'/api/v1/project/access?project={PROJECT}').get_json()
  assert (access["my_role"], access["via"]) == ("developer", "yaml")
  assert access["visibility"]["effective"] == "private" and access["visibility"]["inherited_from"] == "QABOARD_LOGIN_RESTRICTED_YAML"


def test_changes_are_audited(team):
  actions = [e["action"] for e in team['root'].get(f'/api/v1/admin/audit?project={PROJECT}').get_json()["events"]]
  assert "visibility.update" in actions and actions.count("grant.create") == 3
