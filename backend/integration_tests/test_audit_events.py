"""
What the audit log records when people change runs, batches and milestones, start code in CI, or old results are
deleted: one event per action, in the project's history, with what changed.
Starting and redoing batches (batch.start, batch.redo) are tested in tests/test_tuning.py and tests/test_redo.py.
"""
import datetime
from types import SimpleNamespace

import pytest

from .test_access import ingest, ids, PROJECT, SHA
from .test_jobs import World, storage  # noqa: F401 (fixtures)


@pytest.fixture
def world(storage):
  return World(storage)


def events(action):
  from backend.database import db_session
  from backend.models import AuditEvent
  db_session.expire_all()
  return AuditEvent.query.filter(AuditEvent.action == action).order_by(AuditEvent.id).all()


@pytest.fixture
def bob(client, logged_in):
  """A developer of PROJECT (signed-in users are, by default), with a batch of two runs"""
  assert ingest(client).status_code == 200
  assert ingest(client, rel_input_path="inputs/b.txt").status_code == 200
  return logged_in('bob')


def test_batch_events(bob):
  from backend.database import db_session
  from backend.models import Output
  batch_id, _ = ids()
  assert bob.post('/api/v1/batch/rename/', json={"id": batch_id, "label": "renamed"}).status_code == 200
  [rename] = events('batch.rename')
  assert (rename.project_id, rename.target_type, rename.target_id, rename.target_label) == (PROJECT, 'batch', str(batch_id), 'renamed')
  assert rename.changes == {"label": {"from": "default", "to": "renamed"}} and rename.actor_label == 'bob'

  assert bob.post('/api/v1/batch/move/', json={"id": batch_id, "label": "moved"}).status_code == 200
  [move] = events('batch.move')
  assert (move.project_id, move.target_id, move.target_label) == (PROJECT, str(batch_id), 'renamed')
  # the emptied batch is deleted: it's said here, not with a batch.delete
  assert move.meta["to"] == "moved" and move.meta["runs"] == 2 and move.meta["source_deleted"] is True
  assert not events('batch.delete')
  db_session.remove()
  [moved_id] = {o.batch_id for o in Output.query.all()}
  assert moved_id != batch_id

  assert bob.post('/api/v1/batch/stop/', json={"id": moved_id}).status_code == 200
  [stop] = events('batch.stop')
  assert (stop.project_id, stop.target_id, stop.target_label) == (PROJECT, str(moved_id), 'moved')
  assert stop.meta == {"commit": SHA, "status": "stopped"}

  # without a runner, redoing is refused before anything starts: nothing to record
  assert bob.post('/api/v1/batch/redo/', json={"id": moved_id}).status_code == 400
  assert not events('batch.redo')


def test_run_events_say_only_what_changed(logged_in, world):
  bob = logged_in('bob')
  run = world.run(world.batch('proj/a'), deleted=False, files=True)
  world.commit()
  update = lambda body: bob.put(f'/api/v1/output/{run.id}/', json=body)
  assert update({"metrics": {"loss": 1.0}}).status_code == 200
  # loss is the same, is_failed too
  assert update({"metrics": {"loss": 1.0, "psnr": 30}, "is_failed": False}).status_code == 200
  first, event = events('run.update')
  assert first.changes == {"metrics": {"loss": {"from": None, "to": 1.0}}}
  assert (event.project_id, event.target_type, event.target_id, event.target_label) == ('proj/a', 'run', str(run.id), 'input-1.bin (base)')
  assert event.changes == {"metrics": {"psnr": {"from": None, "to": 30}}}
  assert event.meta["batch"] == "default" and event.meta["commit"] == 'a' * 40 and event.meta["input"] == "input-1.bin"

  # nothing changed: nothing recorded
  assert update({"metrics": {"psnr": 30}, "is_failed": False, "data": {}}).status_code == 200
  assert len(events('run.update')) == 2

  assert update({"is_failed": True, "data": {"notes": "flaky"}}).status_code == 200
  assert events('run.update')[-1].changes == {"is_failed": {"from": False, "to": True}, "data": {"notes": {"from": None, "to": "flaky"}}}

  deleted = bob.delete(f'/api/v1/output/{run.id}/?soft=true')
  assert deleted.status_code == 200, deleted.get_json()
  [delete] = events('run.delete')
  assert (delete.project_id, delete.target_id) == ('proj/a', str(run.id))
  assert delete.meta["soft"] is True and delete.meta["input"] == "input-1.bin" and delete.meta["batch"] == "default"


def test_milestone_events(bob):
  answer = bob.post('/api/v1/milestones', json={"project": PROJECT, "label": "v1", "commit": SHA, "shared": True})
  assert answer.status_code == 201, answer.get_json()
  milestone_id = answer.get_json()["id"]
  [create] = events('milestone.create')
  assert (create.project_id, create.target_type, create.target_id, create.target_label) == (PROJECT, 'milestone', str(milestone_id), 'v1')
  assert create.meta["commit_hexsha"] == SHA and create.meta["batch"] == "default" and create.meta["shared"] is True

  assert bob.post(f'/api/v1/milestones/{milestone_id}', json={"label": "v1.1", "notes": "the best"}).status_code == 200
  [update] = events('milestone.update')
  assert update.changes == {"label": {"from": "v1", "to": "v1.1"}, "notes": {"from": "", "to": "the best"}}
  # nothing changed
  assert bob.post(f'/api/v1/milestones/{milestone_id}', json={"label": "v1.1"}).status_code == 200
  assert len(events('milestone.update')) == 1

  assert bob.delete(f'/api/v1/milestones/{milestone_id}').status_code == 200
  [delete] = events('milestone.delete')
  assert (delete.project_id, delete.target_id, delete.target_label) == (PROJECT, str(milestone_id), 'v1.1')

  legacy = {"milestones": {PROJECT: {f"{PROJECT}/{SHA}/default": {"commit": SHA, "label": "old"}}}}
  assert bob.post('/api/v1/milestones/import', json=legacy).get_json()["imported"] == 1
  # importing again imports nothing: nothing to record
  assert bob.post('/api/v1/milestones/import', json=legacy).get_json()["imported"] == 0
  [imported] = events('milestone.import')
  assert (imported.project_id, imported.target_type, imported.target_id) == (PROJECT, 'project', PROJECT)
  assert imported.meta == {"imported": 1, "labels": ["old"]}


class FakeHost:
  url = "https://git.example.com"

  def __init__(self, status_code=200):
    self.status_code = status_code
    self.calls = []

  def api(self, method, path, **kwargs):
    self.calls.append((method, path))
    return SimpleNamespace(content=b'{}', status_code=self.status_code, ok=self.status_code < 400)


def test_ci_events(bob, monkeypatch):
  """Starting CI jobs runs code: recorded, also when the git host refuses"""
  import backend.api.integrations as integrations
  host = FakeHost()
  monkeypatch.setattr(integrations, 'gitlab_project', lambda data, permission: (host, 'group%2Frepo'))
  monkeypatch.setattr(integrations, 'gitlab_job_named', lambda host, project_id, commit_id, job_name: {"id": 42, "name": job_name})
  play = {"project": PROJECT, "project_id": "group/repo", "commit_id": SHA, "job_name": "benchmark"}
  assert bob.post('/api/v1/gitlab/job/play', json=play).status_code == 200
  host.status_code = 403
  assert bob.post('/api/v1/gitlab/job/play', json=play).status_code == 403
  started, refused = events('ci.gitlab_job_play')
  assert (started.project_id, started.target_type, started.target_id, started.target_label) == (PROJECT, 'gitlab_job', '42', 'benchmark')
  assert started.meta["status"] == "started" and started.meta["status_code"] == 200 and started.meta["commit"] == SHA
  assert refused.meta["status"] == "refused" and refused.meta["status_code"] == 403

  host = FakeHost(status_code=204)
  monkeypatch.setattr(integrations, 'github_workflow', lambda data, dispatch=False: (host, 'org/repo', data['workflow']))
  monkeypatch.setattr(integrations, 'dispatched_run', lambda *args: {"id": 7, "status": "queued", "html_url": "https://github.example.com/run/7"})
  monkeypatch.setattr(integrations.time, 'sleep', lambda seconds: None)
  dispatch = {"project": PROJECT, "repo": "org/repo", "workflow": "bench.yml", "ref": "main", "inputs": {"size": "big"}}
  assert bob.post('/api/v1/github/workflow/dispatch', json=dispatch).status_code == 200
  [event] = events('ci.github_workflow_dispatch')
  assert (event.project_id, event.target_type, event.target_id) == (PROJECT, 'github_workflow', 'bench.yml')
  assert event.meta["status"] == "started" and event.meta["status_code"] == 204 and event.meta["inputs"] == {"size": "big"}
  # which run it started
  assert event.meta["run_id"] == 7 and event.meta["run_url"] == "https://github.example.com/run/7"


def test_garbage_collection_records_one_event_per_project(world, storage, monkeypatch):
  from backend.models import Project, CiCommit
  from backend.clean import collect_garbage
  from backend.jobs.report import ConsoleReporter
  monkeypatch.setattr(Project, 'repo', property(lambda self: object()))
  monkeypatch.setattr(Project, 'protected_ref_commits', property(lambda self: []))
  old = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=100)
  for project_id, hexsha in [('proj', 'a' * 40), ('proj', 'b' * 40), ('proj-recent', 'a' * 40)]:
    batch = world.batch(project_id, hexsha=hexsha)
    for _ in range(2):
      world.run(batch, deleted=False, files=True)
  for commit in world.db.query(CiCommit).filter(CiCommit.project_id == 'proj'):
    commit.authored_datetime = commit.latest_output_datetime = old
  world.commit()

  # dry runs change nothing, and record nothing
  collect_garbage(lambda project_id: project_id.startswith('proj'), ConsoleReporter(), dryrun=True)
  assert not events('storage.garbage_collect')

  collect_garbage(lambda project_id: project_id.startswith('proj'), ConsoleReporter())
  # proj-recent's runs are recent: nothing deleted, nothing recorded
  [event] = events('storage.garbage_collect')
  assert (event.project_id, event.target_type, event.target_id, event.actor_kind) == ('proj', 'project', 'proj', 'system')
  assert event.meta["runs"] == 4 and event.meta["commits"] == 2 and event.meta["commits_deleted"] == 0
  assert event.meta["older_than"] == "1month" and event.meta["older_than_source"] == "default" and event.meta["dry_run"] is False
