"""Storage usage, for users: their usage by project, batch, commit, branch and folder, and deleting their runs' files"""
import os
import datetime
from pathlib import Path

import pytest

from .test_jobs import World, run_jobs, exists, storage, admin  # noqa: F401 (fixtures)


@pytest.fixture
def world(storage):
  return World(storage)


GB = 1000 ** 3


def refresh():
  from backend import storage_usage
  storage_usage.refresh_range(0, storage_usage.max_batch_id() + 1)


@pytest.fixture
def alice(logged_in):
  return logged_in('alice')


def setup_runs(world, storage):
  """alice has 2 batches in proj/a (one is a milestone) and 1 in proj/b, bob 1 batch in proj/a"""
  from backend.models import Milestone
  big = world.batch('proj/a', hexsha='a' * 40, label='big', branch='feature')
  for _ in range(3):
    world.run(big, deleted=False, user='alice', size=10 * GB, files=True)
  world.run(big, deleted=False, user='bob', size=1 * GB, files=True)
  world.run(big, deleted=True, user='alice', size=100 * GB)  # deleted runs don't count
  saved = world.batch('proj/a', hexsha='a' * 40, label='saved', branch='feature')
  world.run(saved, deleted=False, user='alice', size=5 * GB, files=True)
  world.db.add(Milestone(project_id='proj/a', commit_hexsha='a' * 40, batch='saved'))
  elsewhere = world.batch('proj/b', hexsha='b' * 40, branch='master')
  world.run(elsewhere, deleted=False, user='alice', size=2 * GB, override=storage / 'users' / 'alice' / 'x' / 'run1', files=True)
  world.run(elsewhere, deleted=False, user='alice', size=2 * GB, override=storage / 'users' / 'alice' / 'x' / 'run2', files=True)
  ids = {"big": big.id, "saved": saved.id, "elsewhere": elsewhere.id}
  world.commit()
  refresh()
  return ids


def member(world, user_name, *projects, role='developer'):
  """A grant: being signed in isn't enough to see other people's usage"""
  from backend.models import RoleGrant, User
  user = User.query.filter(User.user_name == user_name).one()
  for project in projects:
    world.db.add(RoleGrant(subject_type='user', subject_id=user.id, resource_type='project', resource_id=project, role=role))
  world.commit()


def others_visible_to(value):
  from backend.database import db_session
  from backend.models import Setting
  from backend import settings
  db_session.add(Setting(key='storage.others_visible_to', value={"value": value}))
  db_session.commit()
  settings.invalidate_cache()


def test_common_folder():
  from backend.storage_usage import common_folder
  assert common_folder('/a/b/batch', True, None, None) == '/a/b/batch'
  assert common_folder(None, False, '/a/b/run1', '/a/b/run2') == '/a/b'
  assert common_folder(None, False, '/a/bc/run', '/a/b/run') == '/a'
  assert common_folder(None, False, '/a/b/run', '/a/b/run') == '/a/b/run'
  assert common_folder('/a/b/batch', True, '/a/b/x/run1', '/a/b/y/run2') == '/a/b'
  assert common_folder(None, True, None, None) is None


def test_overview(alice, world, storage):
  setup_runs(world, storage)
  answer = alice.get('/api/v1/storage/overview').get_json()
  assert answer["scope"] == 'me' and answer["me"] == 'alice' and answer["updated_at"]
  # the deleted run's leftovers were never measured: it was deleted before QA-Board measured them
  assert answer["totals"] == {"bytes": 39 * GB, "runs": 6, "batches": 3, "commits": 2, "projects": 2, "deleted": {"runs": 1, "bytes": 0, "unmeasured": 1}}
  assert [(p["project_id"], p["bytes"]) for p in answer["projects"]] == [('proj/a', 35 * GB), ('proj/b', 4 * GB)]
  assert answer["top_folders"][0]["bytes"] == 39 * GB or len(answer["top_folders"]) > 1
  # signed-in users are developers of public projects (projects.signed_in_role), but not their members
  everyone = alice.get('/api/v1/storage/overview?scope=all').get_json()
  assert everyone["can_see_others"] == 'none' and everyone["totals"]["bytes"] == 0 and "users" not in everyone
  assert alice.get('/api/v1/storage/users').get_json()["users"] == []
  assert alice.get('/api/v1/storage/overview?scope=user&user=bob').get_json()["totals"]["bytes"] == 0
  # her own runs, with scope=user
  assert alice.get('/api/v1/storage/overview?scope=user&user=alice').get_json()["totals"]["bytes"] == 39 * GB
  member(world, 'alice', 'proj/a')
  everyone = alice.get('/api/v1/storage/overview?scope=all').get_json()
  assert everyone["can_see_others"] == 'some' and everyone["totals"]["bytes"] == 36 * GB
  member(world, 'alice', 'proj/b', role='owner')
  everyone = alice.get('/api/v1/storage/overview?scope=all').get_json()
  assert everyone["can_see_others"] == 'some' and everyone["totals"]["bytes"] == 40 * GB
  assert [(u["user_name"], u["bytes"]) for u in everyone["users"]] == [('alice', 39 * GB), ('bob', 1 * GB)]
  bob = alice.get('/api/v1/storage/overview?scope=user&user=bob').get_json()
  assert bob["totals"]["bytes"] == 1 * GB
  leaderboard = alice.get('/api/v1/storage/users').get_json()
  assert [(u["user_name"], u["bytes"], u["top_project"]["project_id"]) for u in leaderboard["users"]] == [('alice', 39 * GB, 'proj/a'), ('bob', 1 * GB, 'proj/a')]
  assert alice.get('/api/v1/storage/overview?scope=nope').status_code == 400


def test_private_projects_are_hidden(alice, logged_in, world, storage):
  """Users who can't read a private project don't see its usage, even with scope=all"""
  from backend.models import ProjectVisibility
  setup_runs(world, storage)
  world.db.add(ProjectVisibility(path='proj/b', visibility='private'))
  world.commit()
  others_visible_to('signed_in')
  bob = logged_in('bob')
  everyone = bob.get('/api/v1/storage/overview?scope=all').get_json()
  assert [p["project_id"] for p in everyone["projects"]] == ['proj/a']
  assert everyone["totals"]["bytes"] == 36 * GB
  assert bob.get('/api/v1/storage/overview?scope=all&project=proj/b').status_code == 403


def test_batches_commits_branches(alice, world, storage):
  ids = setup_runs(world, storage)
  batches = alice.get('/api/v1/storage/items?group=batch').get_json()
  assert batches["total"] == 3 and batches["totals"]["bytes"] == 39 * GB
  assert [(i["key"], i["bytes"], i["runs"], i["milestone"]) for i in batches["items"]] == [
    (ids["big"], 30 * GB, 3, False), (ids["saved"], 5 * GB, 1, True), (ids["elsewhere"], 4 * GB, 2, False)]
  assert batches["items"][2]["folder"] == str(storage / 'users' / 'alice' / 'x')
  commits = alice.get('/api/v1/storage/items?group=commit').get_json()["items"]
  assert [(c["hexsha"][:1], c["bytes"], c["batches"], c["milestones"]) for c in commits] == [('a', 35 * GB, 2, ['saved']), ('b', 4 * GB, 1, [])]
  branches = alice.get('/api/v1/storage/items?group=branch').get_json()["items"]
  assert [b["key"] for b in branches] == [['proj/a', 'feature'], ['proj/b', 'master']]
  # filters
  assert alice.get('/api/v1/storage/items?project=proj/b').get_json()["total"] == 1
  assert alice.get('/api/v1/storage/items?search=sav').get_json()["items"][0]["batch_label"] == 'saved'
  assert alice.get('/api/v1/storage/items?older_than_days=100').get_json()["total"] == 3
  assert alice.get('/api/v1/storage/items?older_than_days=1000').get_json()["total"] == 0
  assert alice.get('/api/v1/storage/items?branch=master').get_json()["total"] == 1
  oldest = alice.get('/api/v1/storage/items?sort=runs').get_json()["items"]
  assert oldest[0]["runs"] == 3
  # page
  page = alice.get('/api/v1/storage/items?limit=1&offset=1').get_json()
  assert page["total"] == 3 and [i["key"] for i in page["items"]] == [ids["saved"]]


def test_folders(alice, world, storage):
  setup_runs(world, storage)
  users = storage / 'users'
  # the folder from a quota alert
  inside = alice.get(f'/api/v1/storage/items?folder={users}/').get_json()
  assert inside["total"] == 1 and inside["totals"]["bytes"] == 4 * GB and inside["items"][0]["partial"] is False
  # a folder inside a batch's folder: the batch is only partly in it
  deeper = alice.get(f'/api/v1/storage/items?folder={users}/alice/x/run1').get_json()
  assert deeper["total"] == 1 and deeper["items"][0]["partial"] is True
  tree = alice.get(f'/api/v1/storage/folders?path={users}').get_json()
  # alice/ only leads to x/: the row skips to it
  assert tree["path"] == str(users) and [(c["name"], c["bytes"]) for c in tree["children"]] == [('alice/x', 4 * GB)]
  assert tree["children"][0]["path"] == str(users / 'alice' / 'x')
  leaf = alice.get(f'/api/v1/storage/folders?path={users}/alice/x').get_json()
  assert leaf["here"]["bytes"] == 4 * GB and leaf["children"] == []
  partial = alice.get(f'/api/v1/storage/folders?path={users}/alice/x/run1').get_json()
  assert partial["partial"] == {"bytes": 4 * GB, "runs": 2, "batches": 1}
  root = alice.get('/api/v1/storage/folders?path=/').get_json()
  assert root["path"] == '/' and not root["skipped"] and root["children"][0]["bytes"] == 39 * GB
  # without a path: where the runs split
  start = alice.get('/api/v1/storage/folders').get_json()
  assert start["skipped"] and start["path"] != '/' and str(users).startswith(start["path"])
  assert sum(c["bytes"] for c in start["children"]) + start["here"]["bytes"] == 39 * GB
  assert alice.get('/api/v1/storage/items?folder=relative/path').status_code == 400


def test_delete_my_runs(alice, world, storage, monkeypatch):
  """Users delete their runs' files: milestones and other users' runs are kept"""
  from backend.models import Output
  ids = setup_runs(world, storage)
  selection = {"group": "commit", "keys": [], "scope": "all"}
  commit_id = alice.get('/api/v1/storage/items?group=commit').get_json()["items"][0]["key"]
  selection["keys"] = [commit_id]
  preview = alice.post('/api/v1/storage/preview', json=selection).get_json()
  assert preview["owner"] == 'alice'
  assert (preview["runs"], preview["bytes"], preview["batches"]) == (3, 30 * GB, 1)
  assert preview["kept"]["milestones"] == {"runs": 1, "bytes": 5 * GB, "batches": 1}
  # among everyone's runs, alice deletes hers even where she can't see other people's: their names stay hidden
  assert preview["kept"]["others"]["users"] == [] and preview["kept"]["others"]["bytes"] == 1 * GB
  member(world, 'alice', 'proj/a')
  assert alice.post('/api/v1/storage/preview', json=selection).get_json()["kept"]["others"]["users"] == ['bob']
  assert preview["confirm_phrase"] is None and preview["projects"] == [{"project_id": 'proj/a', "bytes": 30 * GB}]

  # big deletions need a confirmation
  import backend.api.storage as api
  monkeypatch.setattr(api, 'CONFIRM_BYTES', 10 * GB)
  refused = alice.post('/api/v1/storage/delete', json=selection)
  assert refused.status_code == 400 and refused.get_json()["reason"] == 'confirmation_required'
  answer = alice.post('/api/v1/storage/delete', json={**selection, "confirm": "Delete 1 batches"})
  assert answer.status_code == 201, answer.get_json()
  job = answer.get_json()["job"]
  assert job["kind"] == 'delete_runs' and job["description"] == "Delete the files of alice's runs: 1 batch (30.0 GB)"
  run_jobs()
  done = alice.get(f'/api/v1/storage/jobs/{job["id"]}').get_json()
  assert done["status"] == 'done', done["error"]
  assert done["progress"]["runs_deleted"] == 3 and done["progress"]["bytes_deleted"] == 30 * GB
  runs = Output.query.filter(Output.batch_id == ids["big"]).all()
  assert sorted((o.data.get('user'), o.deleted) for o in runs) == [('alice', True), ('alice', True), ('alice', True), ('alice', True), ('bob', False)]
  # soft deletes: the files are gone, the manifest stays
  alice_run = next(o for o in runs if o.data.get('user') == 'alice' and o.data.get('storage') == 10 * GB)
  assert not (alice_run.output_dir / 'image.png').exists() and (alice_run.output_dir / 'manifest.outputs.json').exists()
  # the usage is up to date
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["bytes"] == 9 * GB
  assert [j["id"] for j in alice.get('/api/v1/storage/jobs').get_json()["jobs"]] == [job["id"]]


def test_delete_in_a_folder_and_by_filters(alice, world, storage):
  from backend.models import Output
  ids = setup_runs(world, storage)
  run1 = storage / 'users' / 'alice' / 'x' / 'run1'
  # everything that matches: needs filters
  assert alice.post('/api/v1/storage/preview', json={"scope": "all"}).status_code == 400
  answer = alice.post('/api/v1/storage/delete', json={"filters": {"folder": str(run1)}})
  assert answer.status_code == 201, answer.get_json()
  assert answer.get_json()["preview"]["partial_batches"] == 1
  run_jobs()
  job = alice.get(f'/api/v1/storage/jobs/{answer.get_json()["job"]["id"]}').get_json()
  assert job["progress"]["runs_deleted"] == 1 and job["progress"]["runs_kept_outside_folder"] == 1
  runs = {o.output_dir_override: o.deleted for o in Output.query.filter(Output.batch_id == ids["elsewhere"])}
  assert runs == {str(run1): True, str(storage / 'users' / 'alice' / 'x' / 'run2'): False}
  # nothing left to delete there
  nothing = alice.post('/api/v1/storage/delete', json={"group": "batch", "keys": [ids["saved"]]})
  assert nothing.status_code == 400 and 'kept' in nothing.get_json()["error"]


def test_only_admins_delete_other_users_runs(alice, admin, logged_in, world, storage):
  ids = setup_runs(world, storage)
  preview = admin.post('/api/v1/storage/preview', json={"scope": "all", "group": "batch", "keys": [ids["big"]]}).get_json()
  assert preview["owner"] is None and preview["runs"] == 4
  preview = admin.post('/api/v1/storage/preview', json={"scope": "user", "user": "bob", "group": "batch", "keys": [ids["big"]]}).get_json()
  assert preview["owner"] == 'bob' and preview["runs"] == 1
  # alice's deletions are hers
  job = alice.post('/api/v1/storage/delete', json={"group": "batch", "keys": [ids["big"]]}).get_json()["job"]
  bob = logged_in('bob')
  assert bob.get(f'/api/v1/storage/jobs/{job["id"]}').status_code == 404
  assert bob.post(f'/api/v1/storage/jobs/{job["id"]}/cancel').status_code == 404
  assert admin.get(f'/api/v1/storage/jobs/{job["id"]}').status_code == 200
  assert alice.post(f'/api/v1/storage/jobs/{job["id"]}/cancel').get_json()["status"] == 'cancelled'


def test_deleting_from_the_web_app_updates_the_usage(alice, world, storage):
  ids = setup_runs(world, storage)
  assert alice.delete(f'/api/v1/batch/{ids["elsewhere"]}?soft=true').status_code == 200
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["bytes"] == 35 * GB


def test_the_worker_keeps_the_usage_up_to_date(alice, world, storage, monkeypatch):
  from backend.models import JobSchedule, Job, CiCommit
  from backend.jobs import worker as worker_module
  monkeypatch.setenv('QABOARD_STORAGE_USAGE_AUTO', '1')
  batch = world.batch('proj/a')
  world.run(batch, deleted=False, user='alice', size=GB)
  world.commit()
  run_jobs()
  # a first rebuild, and a nightly one
  assert [s.name for s in JobSchedule.query.all()] == ['Storage usage']
  assert [j.status for j in Job.query.filter(Job.kind == 'storage_usage')] == ['done']
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["bytes"] == GB
  # new runs: their commit says so
  world.run(world.db.merge(batch), deleted=False, user='alice', size=GB)
  world.db.query(CiCommit).update({CiCommit.latest_output_datetime: datetime.datetime.now(datetime.timezone.utc)})
  world.commit()
  worker = worker_module.Worker(poll_seconds=0, echo=False)
  worker.refresh_usage()
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["bytes"] == 2 * GB


def test_users_deletions_dont_wait_for_maintenance(admin, alice, world, storage):
  from backend.jobs import queue
  ids = setup_runs(world, storage)
  long_job = admin.post('/api/v1/admin/jobs', json={"kind": "hard_delete", "params": {"dry_run": True}}).get_json()
  mine = alice.post('/api/v1/storage/delete', json={"group": "batch", "keys": [ids["elsewhere"]]}).get_json()["job"]
  # two users can delete at the same time
  assert alice.post('/api/v1/storage/delete', json={"group": "batch", "keys": [ids["big"]]}).status_code == 201
  assert queue.claim('w:1', interactive=True) == mine["id"]
  assert queue.claim('w:1', interactive=False) == long_job["id"]
