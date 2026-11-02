"""Admin > Storage: server jobs (hard-deleting deleted runs, deleting old results), their errors, schedules and workers"""
import os
import datetime
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def admin(logged_in):
  return logged_in('root', is_admin=True)


@pytest.fixture
def storage():
  """A folder of each test's own, in the storage"""
  root = Path(os.environ['QABOARD_STORAGE_ROOTS'].split(':')[0])
  return Path(tempfile.mkdtemp(dir=root))


def now():
  return datetime.datetime.utcnow()


class Run:
  def __init__(self, id, output_dir, batch_id):
    self.id, self.output_dir, self.batch_id = id, output_dir, batch_id


class World:
  """Projects, commits, batches and runs, with their folders in the storage"""
  def __init__(self, storage: Path):
    from backend.database import db_session
    self.db = db_session
    self.storage = storage
    self.projects = {}
    self.inputs = 0

  def project(self, project_id, data=None):
    from backend.models import Project
    if project_id not in self.projects:
      project = Project(id=project_id, data=data or {})
      self.db.add(project)
      self.projects[project_id] = project
    return self.projects[project_id]

  def batch(self, project_id, hexsha='a' * 40, label='default', branch='feature', created=None):
    from backend.models import CiCommit, Batch
    project = self.project(project_id)
    commit = (self.db.query(CiCommit).filter(CiCommit.project_id == project_id, CiCommit.hexsha == hexsha).one_or_none()
              or CiCommit(hexsha, project=project, branch=branch, authored_datetime=datetime.datetime.now(datetime.timezone.utc)))
    batch_dir = self.storage / project_id / hexsha[:8] / label
    batch = Batch(ci_commit=commit, label=label, batch_dir_override=str(batch_dir), data={}, created_date=created or now() - datetime.timedelta(days=400))
    self.db.add(batch)
    self.db.flush()
    return batch

  def run(self, batch, deleted=True, files=False, override=None, created=None, pending=False, user=None, size=None):
    """A run. `files`: its folder exists, with a manifest, like after a soft delete. `user` ran it, its files take `size` bytes."""
    from backend.models import Output, TestInput
    self.inputs += 1
    test_input = TestInput('/db', f'input-{self.inputs}.bin')
    data = {**({"user": user} if user else {}), **({"storage": size} if size is not None else {})}
    output = Output(batch=batch, test_input=test_input, platform='linux', configurations=['base'], extra_parameters={},
                    deleted=deleted, is_pending=pending, output_dir_override=str(override) if override else None,
                    created_date=created or now() - datetime.timedelta(days=300), data=data)
    self.db.add(output)
    self.db.flush()
    folder = output.output_dir
    if files:
      folder.mkdir(parents=True, exist_ok=True)
      if size:
        (folder / 'image.png').write_bytes(b'x' * 10)
        (folder / 'manifest.outputs.json').write_text('{"image.png": {"st_size": 10}}')
      else:
        (folder / 'manifest.outputs.json').write_text('{}')
    return Run(output.id, folder, batch.id)

  def commit(self):
    self.db.commit()


@pytest.fixture
def world(storage):
  return World(storage)


def exists(model, id):
  from backend.database import db_session
  db_session.expire_all()
  return db_session.get(model, id) is not None


def run_jobs():
  """What the `jobs` service does, until there's nothing left to do"""
  from backend.jobs.worker import Worker
  Worker(poll_seconds=0, echo=False).loop(once=True)


def start(admin, kind='hard_delete', **params):
  response = admin.post('/api/v1/admin/jobs', json={"kind": kind, "params": params})
  assert response.status_code == 201, response.get_json()
  return response.get_json()


def job(admin, job_id):
  return admin.get(f'/api/v1/admin/jobs/{job_id}').get_json()


# ---------------------------------------------------------------------------
# Hard deletes
# ---------------------------------------------------------------------------

def test_hard_delete_removes_deleted_runs_and_keeps_the_rest(admin, world, storage):
  from backend.models import Output, Batch
  batch = world.batch('proj')
  gone = world.run(batch)                                   # no files left: the fast path
  with_files = world.run(batch, override=storage / 'elsewhere' / 'run', files=True)
  alive = world.run(batch, deleted=False, files=True)       # not deleted
  recent = world.run(batch, created=now())                  # deleted, but newer than created_before
  redone = world.run(batch, pending=True)                   # deleted, but running again
  emptied = world.batch('proj', label='emptied')
  emptied_run = world.run(emptied, files=True)
  other = world.run(world.batch('other-project'))
  batch_id, emptied_id = batch.id, emptied.id
  world.commit()

  answer = start(admin, projects=['proj*'], created_before='1month')
  assert answer["status"] == 'queued' and answer["description"] == 'Hard-delete the deleted runs of proj*, created before 1month'
  run_jobs()

  done = job(admin, answer["id"])
  assert done["status"] == 'done', done["error"]
  assert not exists(Output, gone.id) and not exists(Output, with_files.id) and not exists(Output, emptied_run.id)
  assert exists(Output, alive.id) and exists(Output, recent.id) and exists(Output, redone.id) and exists(Output, other.id)
  assert not (storage / 'elsewhere').exists(), "its files are deleted, and the empty parent folders"
  assert alive.output_dir.exists()
  assert exists(Batch, batch_id) and not exists(Batch, emptied_id), "batches left without runs are deleted"
  progress = done["progress"]
  assert progress["runs_deleted"] == 3 and progress["runs_without_files"] == 1 and progress["runs_with_files"] == 2
  assert progress["batches_deleted"] == 1 and progress["projects_total"] == 1 and progress["projects_done"] == 1
  assert [line["message"] for line in done["log"]][-1] == 'Done'


def test_hard_delete_keeps_milestones(admin, world):
  from backend.models import Output, Milestone, Project
  saved = world.batch('proj', hexsha='b' * 40, label='saved')
  in_milestone = world.run(saved)
  # qaboard.yaml protects the latest commit of the reference branch
  reference = world.batch('proj', hexsha='c' * 40, branch='master')
  on_reference = world.run(reference)
  other = world.run(world.batch('proj', hexsha='b' * 40, label='other'))
  world.db.add(Milestone(project_id='proj', commit_hexsha='b' * 8, batch='saved', label='best so far'))
  world.commit()

  answer = start(admin)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done'
  assert exists(Output, in_milestone.id) and exists(Output, on_reference.id)
  assert not exists(Output, other.id), "the commit's other batches are not milestones"
  assert done["progress"]["runs_protected"] == 2 and done["progress"]["batches_protected"] == 2


def test_hard_delete_skips_projects_whose_milestones_need_git(admin, world):
  from backend.models import Output
  world.project('proj', data={"qatools_config": {"project": {"milestones": ["v1.0"]}}})
  run = world.run(world.batch('proj'))
  world.commit()
  answer = start(admin)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors'
  assert exists(Output, run.id)
  errors = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors').get_json()
  assert errors["total"] == 1 and errors["errors"][0]["kind"] == 'git' and 'proj was skipped' in errors["errors"][0]["message"]


def test_hard_delete_errors_dont_stop_the_job(admin, world, storage, monkeypatch):
  """Each error is recorded, with the file and its owner, and the run is kept to try again later"""
  from backend.models import Output
  from backend.jobs import hard_delete
  batch = world.batch('proj')
  locked = world.run(batch, override=storage / 'locked' / 'run', files=True)
  outside = Path(tempfile.mkdtemp(prefix='not-in-the-storage-'))
  unsafe = world.run(batch, override=outside, files=True)
  fine = world.run(batch, override=storage / 'fine' / 'run', files=True)
  batch_id = batch.id
  world.commit()

  real_delete = hard_delete.delete_files
  def delete_files(path):
    if 'locked' in str(path):
      raise Exception(f"ERROR [Errno 13] Permission denied: '{path}/image.png': Could not remove: {path}/manifest.outputs.json")
    return real_delete(path)
  monkeypatch.setattr(hard_delete, 'delete_files', delete_files)

  answer = start(admin)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors'
  assert exists(Output, locked.id) and exists(Output, unsafe.id) and not exists(Output, fine.id)
  assert outside.exists()
  assert done["progress"]["errors"] == {"permission": 1, "unsafe_path": 1}
  assert done["progress"]["runs_failed"] == 2 and done["progress"]["runs_deleted"] == 1
  assert any('permission error (root)' in line["message"] for line in done["log"])

  errors = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors').get_json()
  assert errors["total"] == 2
  permission = next(e for e in errors["errors"] if e["kind"] == 'permission')
  assert permission["path"] == f"{storage}/locked/run/manifest.outputs.json" and permission["owner"] == 'root'
  assert permission["output_id"] == locked.id and permission["project_id"] == 'proj' and permission["batch_id"] == batch_id
  assert {c["value"]: c["count"] for c in errors["by_kind"]} == {"permission": 1, "unsafe_path": 1}
  assert errors["by_owner"] == [{"value": 'root', "count": 2}]
  only = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors?kind=permission').get_json()
  assert only["total"] == 1

  csv = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors.csv')
  assert csv.status_code == 200 and csv.mimetype == 'text/csv'
  lines = csv.get_data(as_text=True).strip().splitlines()
  assert lines[0] == 'kind,owner,path,message,project_id,batch_id,output_id,created_at' and len(lines) == 3

  # once fixed, the same job again deletes them
  monkeypatch.setattr(hard_delete, 'delete_files', real_delete)
  retry = admin.post(f'/api/v1/admin/jobs/{answer["id"]}/retry').get_json()
  run_jobs()
  assert job(admin, retry["id"])["progress"]["runs_deleted"] == 1
  assert not exists(Output, locked.id)


def test_runs_whose_folder_is_unknown_are_reported(admin, world, storage):
  from backend.models import Output
  batch = world.batch('proj')
  Path(batch.batch_dir_override).mkdir(parents=True)
  broken = world.run(batch)
  world.db.get(Output, broken.id).test_input_id = None
  fine = world.run(batch)
  world.commit()
  answer = start(admin)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors' and done["progress"]["errors"] == {"other": 1}
  assert exists(Output, broken.id) and not exists(Output, fine.id)


def test_dry_runs_change_nothing(admin, world, storage):
  from backend.models import Output
  batch = world.batch('proj')
  runs = [world.run(batch), world.run(batch, override=storage / 'x' / 'run', files=True)]
  world.commit()
  answer = start(admin, dry_run=True)
  assert answer["dry_run"] is True
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done' and done["progress"]["runs_deleted"] == 2
  assert all(exists(Output, r.id) for r in runs) and (storage / 'x' / 'run').exists()
  # for real
  real = admin.post(f'/api/v1/admin/jobs/{answer["id"]}/retry', json={"dry_run": False}).get_json()
  assert real["dry_run"] is False
  run_jobs()
  assert not any(exists(Output, r.id) for r in runs)


def test_missing_folders_are_checked_once(world, storage):
  """Most deleted runs have no files: one missing parent folder answers for all of them"""
  from backend.jobs.common import Folders
  (storage / 'a' / 'b').mkdir(parents=True)
  folders = Folders()
  assert not folders.exists(storage / 'a' / 'b' / 'c' / 'd' / 'run1')
  checks = folders.checks
  assert not folders.exists(storage / 'a' / 'b' / 'c' / 'other' / 'run2')
  assert folders.checks == checks, "c is known missing"
  assert folders.exists(storage / 'a' / 'b')


def test_purge_runs_whose_files_are_gone(admin, world, storage):
  """Runs whose folder was deleted outside QA-Board: only their metadata goes, never files"""
  from backend.models import Output, Batch
  batch = world.batch('proj')
  live_gone = world.run(batch, deleted=False)
  live_here = world.run(batch, deleted=False, files=True)
  deleted_here = world.run(batch, deleted=True, files=True)
  emptied = world.batch('proj', label='gone')
  only_run = world.run(emptied, deleted=False)
  emptied_id = emptied.id
  world.commit()
  answer = start(admin, runs='missing_files', created_before='1month')
  assert answer["description"] == 'Hard-delete the runs whose files are gone of *, created before 1month'
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done', done["error"]
  assert not exists(Output, live_gone.id) and not exists(Output, only_run.id) and not exists(Batch, emptied_id)
  assert exists(Output, live_here.id) and exists(Output, deleted_here.id)
  assert deleted_here.output_dir.exists(), "this mode never deletes files"
  assert done["progress"]["runs_deleted"] == 2 and done["progress"]["live_runs_without_files"] == 2

  both = start(admin, runs='both')
  run_jobs()
  assert job(admin, both["id"])["progress"]["runs_deleted"] == 1
  assert not exists(Output, deleted_here.id) and exists(Output, live_here.id)


def test_storage_that_may_not_be_mounted_is_left_alone(admin, world, storage):
  """Everything looks missing when storage isn't mounted: we never purge runs from a folder missing under a storage root"""
  from backend.models import Output
  root = Path(os.environ['QABOARD_STORAGE_ROOTS'].split(':')[0])
  batch = world.batch('proj')
  unmounted = world.run(batch, deleted=False, override=root / 'not-mounted' / 'run')
  outside = world.run(batch, deleted=False, override='/nowhere/run')
  outside_deleted = world.run(batch, deleted=True, override='/nowhere/run2')
  world.commit()
  answer = start(admin, runs='both')
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors' and done["progress"]["errors"] == {"storage": 2}
  assert exists(Output, unmounted.id) and exists(Output, outside.id)
  assert not exists(Output, outside_deleted.id), "users deleted it: its metadata can go"
  errors = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors').get_json()["errors"]
  assert any('is it mounted?' in e["message"] for e in errors)


def test_estimate_and_matching_projects(admin, world):
  world.run(world.batch('proj/a'))
  world.run(world.batch('proj/a', label='other'))
  b = world.batch('proj/b')
  world.run(b)
  world.run(b, deleted=False)
  world.run(world.batch('other'))
  world.commit()
  answer = admin.post('/api/v1/admin/jobs/estimate', json={"kind": "hard_delete", "params": {"projects": ["proj/*"]}}).get_json()
  assert answer == {"total": 3, "projects": {"proj/a": 2, "proj/b": 1}, "timeout": False}
  answer = admin.post('/api/v1/admin/jobs/estimate', json={"kind": "hard_delete", "params": {"projects": ["proj/*"], "created_before": "2000-01-01"}}).get_json()
  assert answer["total"] == 0
  matching = admin.get('/api/v1/admin/jobs/projects?projects=proj/*&exclude_projects=*/b').get_json()
  assert matching == {"total": 1, "projects": ["proj/a"]}


# ---------------------------------------------------------------------------
# The queue
# ---------------------------------------------------------------------------

def test_jobs_are_validated_and_one_runs_at_a_time(admin, logged_in):
  bad = admin.post('/api/v1/admin/jobs', json={"kind": "hard_delete", "params": {"created_before": "soon"}})
  assert bad.status_code == 400 and 'created_before' in bad.get_json()["error"]
  assert admin.post('/api/v1/admin/jobs', json={"kind": "nope"}).status_code == 400
  assert admin.post('/api/v1/admin/jobs', json={"kind": "hard_delete", "params": {"what": 1}}).get_json()["error"] == 'Unknown parameters: what'
  everything = admin.post('/api/v1/admin/jobs', json={"kind": "garbage_collect", "params": {"older_than": "1week"}})
  assert everything.status_code == 400 and 'default_older_than' in everything.get_json()["error"]

  first = start(admin)
  busy = admin.post('/api/v1/admin/jobs', json={"kind": "hard_delete"})
  assert busy.status_code == 409 and busy.get_json()["job"]["id"] == first["id"]
  # other kinds can run meanwhile
  start(admin, kind='garbage_collect', projects=['p*'], older_than='2weeks')

  cancelled = admin.post(f'/api/v1/admin/jobs/{first["id"]}/cancel').get_json()
  assert cancelled["status"] == 'cancelled'
  assert admin.post(f'/api/v1/admin/jobs/{first["id"]}/cancel').status_code == 400
  listed = admin.get('/api/v1/admin/jobs').get_json()
  assert [j["kind"] for j in listed["jobs"]] == ['garbage_collect', 'hard_delete']
  assert listed["workers"] == {"online": [], "last_seen_at": None}
  assert [j["kind"] for j in admin.get('/api/v1/admin/jobs?status=queued,running').get_json()["jobs"]] == ['garbage_collect']

  from backend.models import AuditEvent
  assert [e.action for e in AuditEvent.query.filter(AuditEvent.target_type == 'job').order_by(AuditEvent.id)] == ['job.create', 'job.create', 'job.cancel']
  bob = logged_in('bob')
  assert bob.post('/api/v1/admin/jobs', json={"kind": "hard_delete"}).status_code == 403


def test_running_jobs_can_be_cancelled(admin, world, monkeypatch):
  """Cancelling a running job: it stops at its next check"""
  from backend.database import db_session
  from backend.models import Job
  from backend.jobs import hard_delete
  for i in range(3):
    world.run(world.batch(f'proj{i}', hexsha=str(i) * 40))
  world.commit()
  answer = start(admin)
  real_project = hard_delete.HardDelete.project
  def project(self, project_id):
    finished = real_project(self, project_id)
    # an admin cancels while the job runs
    from backend.database import engine
    with engine.begin() as connection:
      connection.execute(Job.__table__.update().where(Job.__table__.c.id == answer["id"]).values(cancel_requested=True))
    self.report.flushed_at = None
    return finished
  monkeypatch.setattr(hard_delete.HardDelete, 'project', project)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'cancelled' and done["progress"]["projects_done"] == 1


def test_interrupted_jobs_resume(admin, world, monkeypatch):
  """Deploys stop the worker (SIGTERM): the job is queued again, and the next worker resumes where it was"""
  from backend.models import Job, Output
  from backend.jobs import hard_delete, queue
  from backend.jobs.worker import Worker
  runs = [world.run(world.batch(f'proj{i}', hexsha=str(i) * 40)) for i in range(3)]
  world.commit()
  answer = start(admin)
  worker = Worker(poll_seconds=0, echo=False)
  real_project = hard_delete.HardDelete.project
  def project(self, project_id):
    finished = real_project(self, project_id)
    worker.stop()
    return finished
  monkeypatch.setattr(hard_delete.HardDelete, 'project', project)
  worker.loop(once=True)
  interrupted = job(admin, answer["id"])
  assert interrupted["status"] == 'queued' and interrupted["progress"]["projects_done"] == 1
  assert interrupted["log"][-1]["message"] == 'The worker is stopping: queued again, it will resume'

  monkeypatch.setattr(hard_delete.HardDelete, 'project', real_project)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done' and done["attempts"] == 2
  assert done["progress"]["projects_done"] == 3 and done["progress"]["runs_deleted"] == 3
  assert [line["message"] for line in done["log"] if line["message"].startswith(('Starting', 'Resuming'))] == [
    'Starting: Hard-delete the deleted runs of *', 'Resuming: Hard-delete the deleted runs of *']


def test_jobs_of_dead_workers_are_queued_again(admin):
  from backend.database import db_session
  from backend.models import Job
  from backend.jobs import queue
  answer = start(admin)
  db_session.expire_all()
  stuck = db_session.get(Job, answer["id"])
  stuck.status, stuck.worker, stuck.heartbeat_at, stuck.attempts = 'running', 'gone:1', now() - datetime.timedelta(hours=1), 1
  db_session.commit()
  assert queue.requeue_stale() == 1
  again = job(admin, answer["id"])
  assert again["status"] == 'queued' and 'stopped responding' in again["log"][-1]["message"]


def test_cancelled_jobs_of_dead_workers_stay_cancelled(admin):
  from backend.database import db_session
  from backend.models import Job
  from backend.jobs import queue
  answer = start(admin)
  db_session.expire_all()
  stuck = db_session.get(Job, answer["id"])
  stuck.status, stuck.worker, stuck.heartbeat_at, stuck.attempts, stuck.cancel_requested = 'running', 'gone:1', now() - datetime.timedelta(hours=1), 1, True
  db_session.commit()
  assert queue.requeue_stale() == 1
  assert job(admin, answer["id"])["status"] == 'cancelled'


def test_running_jobs_can_be_cancelled_without_waiting(admin, monkeypatch):
  """A job stuck where it can't check whether it's cancelled (a storage that doesn't answer...): admins don't wait for it"""
  from backend.database import db_session
  from backend.models import Job
  from backend.jobs import queue, hard_delete
  answer = start(admin)
  forced = {}
  def stuck(params, report):
    # what admins do while the worker is busy
    assert admin.post(f'/api/v1/admin/jobs/{answer["id"]}/cancel').get_json()["status"] == 'running'
    forced.update(admin.post(f'/api/v1/admin/jobs/{answer["id"]}/cancel', json={"force": True}).get_json())
    forced["next"] = admin.post('/api/v1/admin/jobs', json={"kind": "hard_delete"}).status_code
    raise RuntimeError("the worker gives up later")
  monkeypatch.setattr(hard_delete, 'run', stuck)
  run_jobs()
  assert forced["status"] == 'cancelled' and 'without waiting' in forced["log"][-1]["message"]
  assert forced["next"] == 201, "another job of its kind can start"
  db_session.expire_all()
  done = db_session.get(Job, answer["id"])
  assert done.status == 'cancelled' and done.error is None and done.log[-1]["message"] == 'Its worker stopped too'


def test_crashes_are_reported(admin, monkeypatch):
  from backend.jobs import hard_delete
  def crash(params, report):
    raise RuntimeError("boom")
  monkeypatch.setattr(hard_delete, 'run', crash)
  answer = start(admin)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'failed' and 'RuntimeError: boom' in done["error"]
  assert done["log"][-2]["message"] == 'The job crashed: RuntimeError: boom'


@pytest.fixture
def alerts(monkeypatch):
  """What the jobs tell Sentry and send by email"""
  from backend.jobs import alerts
  sent = {"sentry": [], "emails": []}
  monkeypatch.setattr(alerts, 'report_to_sentry', lambda job, status, error=None, message=None, schedule=None: sent["sentry"].append((job.kind, status, error, message)))
  monkeypatch.setattr('backend.notifications.mail.send_email', lambda to, subject, html, text, headers=None, settings=None: sent["emails"].append({"to": to, "subject": subject, "text": text}))
  monkeypatch.setenv('QABOARD_SMTP_HOST', 'smtp.example.com')
  monkeypatch.setenv('QABOARD_EMAIL_DOMAIN', 'example.com')
  return sent


def scheduled(kind='hard_delete', name='nightly purge'):
  from backend.database import db_session
  from backend.models import JobSchedule
  from backend.jobs import queue
  schedule = queue.save_schedule(JobSchedule(), {"name": name, "kind": kind, "cron": "0 2 * * *", "params": {}})
  job = queue.run_schedule(schedule)
  db_session.commit()
  return job.id


def test_scheduled_jobs_that_crash_are_reported(admin, alerts, monkeypatch):
  from backend.jobs import hard_delete
  def crash(params, report):
    raise RuntimeError("boom")
  monkeypatch.setattr(hard_delete, 'run', crash)
  job_id = scheduled()
  run_jobs()
  assert job(admin, job_id)["status"] == 'failed'
  [(kind, status, error, _)] = alerts["sentry"]
  assert (kind, status, str(error)) == ('hard_delete', 'failed', 'boom')
  # `root` is the admin
  [email] = alerts["emails"]
  assert email["to"] == 'root@example.com'
  assert email["subject"] == '[QA-Board] Scheduled job failed: nightly purge'
  assert 'RuntimeError: boom' in email["text"] and f'/admin/storage/jobs/{job_id}' in email["text"]


def test_scheduled_jobs_that_catch_errors_are_reported(admin, alerts, monkeypatch):
  from backend.jobs import hard_delete
  def errors(params, report):
    report.error('permission', "Permission denied: /somewhere", path='/somewhere', owner='alice')
  monkeypatch.setattr(hard_delete, 'run', errors)
  monkeypatch.setenv('QABOARD_JOBS_FAILURE_EMAIL_TO', 'ops@example.com, bob')
  job_id = scheduled()
  run_jobs()
  assert job(admin, job_id)["status"] == 'done_with_errors'
  assert [(kind, status) for kind, status, *_ in alerts["sentry"]] == [('hard_delete', 'done_with_errors')]
  [email] = alerts["emails"]
  assert email["to"] == 'ops@example.com, bob@example.com'
  assert email["subject"] == '[QA-Board] Scheduled job ended with 1 errors: nightly purge'
  assert '- [permission] (alice) Permission denied: /somewhere' in email["text"]


def test_only_scheduled_jobs_are_emailed(admin, alerts, monkeypatch):
  from backend.jobs import hard_delete
  def crash(params, report):
    raise RuntimeError("boom")
  monkeypatch.setattr(hard_delete, 'run', crash)
  start(admin)
  run_jobs()
  assert len(alerts["sentry"]) == 1 and alerts["emails"] == []
  # and admins can turn the emails off
  monkeypatch.setenv('QABOARD_JOBS_FAILURE_EMAILS', 'false')
  scheduled()
  run_jobs()
  assert len(alerts["sentry"]) == 2 and alerts["emails"] == []


def test_failing_schedules_dont_flood_inboxes(admin, alerts, monkeypatch):
  from backend.database import db_session
  from backend.models import JobSchedule
  from backend.jobs import hard_delete, queue
  def crash(params, report):
    raise RuntimeError("boom")
  monkeypatch.setattr(hard_delete, 'run', crash)
  job_id = scheduled(name='nightly\npurge')
  run_jobs()
  assert alerts["emails"][0]["subject"] == '[QA-Board] Scheduled job failed: nightly purge'
  schedule = db_session.query(JobSchedule).one()
  # it fails again soon after: Sentry knows, admins were already told
  queue.run_schedule(schedule)
  db_session.commit()
  run_jobs()
  assert len(alerts["sentry"]) == 2 and len(alerts["emails"]) == 1
  # admins who click "Run now" see it fail
  ran = admin.post(f'/api/v1/admin/job-schedules/{schedule.id}/run')
  assert ran.status_code == 201
  run_jobs()
  assert len(alerts["sentry"]) == 3 and len(alerts["emails"]) == 1
  assert job(admin, job_id)["status"] == 'failed'


def test_jobs_that_succeed_are_not_reported(admin, alerts, monkeypatch):
  from backend.jobs import hard_delete
  monkeypatch.setattr(hard_delete, 'run', lambda params, report: None)
  scheduled()
  run_jobs()
  assert alerts == {"sentry": [], "emails": []}


def test_jobs_given_up_are_reported(admin, alerts):
  from backend.database import db_session
  from backend.models import Job
  from backend.jobs import queue
  job_id = scheduled()
  stuck = db_session.get(Job, job_id)
  stuck.status, stuck.worker, stuck.heartbeat_at, stuck.attempts = 'running', 'gone:1', now() - datetime.timedelta(hours=1), queue.MAX_ATTEMPTS
  db_session.commit()
  queue.requeue_stale()
  assert [(kind, status) for kind, status, *_ in alerts["sentry"]] == [('hard_delete', 'failed')]
  assert 'giving up' in alerts["emails"][0]["text"]


def test_email_content():
  from types import SimpleNamespace
  from backend.jobs.alerts import email_content
  job = SimpleNamespace(id=3, kind='hard_delete', schedule_id=None, progress=None)
  content = email_content(job, 'failed', error_summary='<boom>')
  assert content["subject"] == '[QA-Board] Scheduled job failed: Hard-delete runs'
  assert '&lt;boom&gt;' in content["html"] and '<boom>' in content["text"]


def test_sentry_events(monkeypatch):
  """What Sentry gets: jobs' errors are tagged with their kind, those they caught are grouped by kind"""
  from types import SimpleNamespace
  import sentry_sdk
  from backend.jobs import alerts
  events = []
  sentry_sdk.init(dsn='https://key@sentry.example.com/1', transport=lambda event: events.append(event), default_integrations=False)
  try:
    job = SimpleNamespace(id=3, kind='hard_delete', schedule_id=1, worker='w', attempts=1, params={}, progress={"errors": {"permission": 2}})
    alerts.report_to_sentry(job, 'done_with_errors')
    try:
      raise RuntimeError("boom")
    except RuntimeError as e:
      alerts.report_to_sentry(job, 'failed', error=e)
    # the worker's retries are reported once
    alerts.capture_exception(ConnectionError("database down"))
    alerts.capture_exception(ConnectionError("database down"))
    sentry_sdk.flush()
  finally:
    sentry_sdk.get_client().close()
  sentry_sdk.init()
  caught, crashed, worker = [e if isinstance(e, dict) else e.get_event() for e in events]
  assert caught["fingerprint"] == ['qaboard-job', 'hard_delete', 'done_with_errors'] and caught["level"] == 'warning'
  assert caught["tags"]["job.kind"] == 'hard_delete' and caught["contexts"]["job"]["progress"] == {"errors": {"permission": 2}}
  assert crashed["exception"]["values"][-1]["value"] == 'boom' and crashed["tags"]["job.status"] == 'failed'
  assert worker["exception"]["values"][-1]["type"] == 'ConnectionError'


def test_workers_say_they_are_alive(admin):
  from backend.jobs.worker import Worker
  worker = Worker(echo=False)
  worker.heartbeat()
  workers = admin.get('/api/v1/admin/jobs').get_json()["workers"]
  assert [w["id"] for w in workers["online"]] == [worker.id]


def test_garbage_collection_reports_projects_it_cant_read(admin, world):
  world.run(world.batch('proj'), deleted=False)
  world.commit()
  answer = start(admin, kind='garbage_collect')
  assert answer["description"] == 'Delete the old results of *, as qaboard.yaml says (else older than 1month)'
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors' and done["progress"]["errors"] == {"git": 1}


# ---------------------------------------------------------------------------
# Schedules
# ---------------------------------------------------------------------------

def test_schedules(admin):
  from backend.database import db_session
  from backend.models import JobSchedule
  from backend.jobs import queue
  bad = admin.post('/api/v1/admin/job-schedules', json={"name": "nightly", "kind": "hard_delete", "cron": "0 25 * * *"})
  assert bad.status_code == 400 and 'hour' in bad.get_json()["error"]
  assert admin.post('/api/v1/admin/job-schedules', json={"name": "nightly", "kind": "hard_delete", "cron": "0 2 * * *", "timezone": "Mars/Base"}).status_code == 400
  assert admin.get('/api/v1/admin/job-schedules/next-runs?cron=0+2+*+*+*&timezone=Asia/Jerusalem').status_code == 200
  assert admin.get('/api/v1/admin/job-schedules/next-runs?cron=nope').status_code == 400

  created = admin.post('/api/v1/admin/job-schedules', json={
    "name": "nightly purge", "kind": "hard_delete", "cron": "0 2 * * *", "timezone": "Asia/Jerusalem",
    "params": {"created_before": "1month"},
  })
  assert created.status_code == 201, created.get_json()
  schedule = created.get_json()
  assert schedule["enabled"] and schedule["next_run_at"] and schedule["params"]["projects"] == ['*']
  assert schedule["description"] == 'Hard-delete the deleted runs of *, created before 1month'

  # nothing is due yet
  assert queue.run_due_schedules() == 0
  # ...now it is
  db_session.expire_all()
  row = db_session.get(JobSchedule, schedule["id"])
  row.next_run_at = now() - datetime.timedelta(minutes=1)
  db_session.commit()
  assert queue.run_due_schedules() == 1
  listed = admin.get('/api/v1/admin/job-schedules').get_json()["schedules"][0]
  assert listed["last_job"]["status"] == 'queued' and listed["last_job"]["created_by"] == 'schedule: nightly purge'
  assert listed["next_run_at"] > queue.iso(now())
  # while it runs, the schedule's next run is skipped, and says why
  db_session.expire_all()
  row = db_session.get(JobSchedule, schedule["id"])
  row.next_run_at = now() - datetime.timedelta(minutes=1)
  db_session.commit()
  queue.run_due_schedules()
  listed = admin.get('/api/v1/admin/job-schedules').get_json()["schedules"][0]
  assert listed["last_message"].startswith('Skipped: Job #')

  assert admin.post(f'/api/v1/admin/job-schedules/{schedule["id"]}/run').status_code == 409
  run_jobs()
  ran = admin.post(f'/api/v1/admin/job-schedules/{schedule["id"]}/run')
  assert ran.status_code == 201 and ran.get_json()["schedule_id"] == schedule["id"]

  updated = admin.post(f'/api/v1/admin/job-schedules/{schedule["id"]}', json={"enabled": False, "params": {"projects": ["a*"]}}).get_json()
  assert updated["enabled"] is False and updated["next_run_at"] is None and updated["params"]["projects"] == ['a*']
  assert admin.delete(f'/api/v1/admin/job-schedules/{schedule["id"]}').status_code == 200
  assert admin.get('/api/v1/admin/job-schedules').get_json()["schedules"] == []
  from backend.models import AuditEvent
  assert [e.action for e in AuditEvent.query.filter(AuditEvent.target_type == 'job_schedule').order_by(AuditEvent.id)] == [
    'job_schedule.create', 'job_schedule.update', 'job_schedule.delete']


def test_cron():
  from backend.jobs.cron import Cron, next_run, CronError
  at = datetime.datetime(2026, 10, 21, 13, 37)  # a Wednesday
  assert Cron('0 2 * * *').next_after(at) == datetime.datetime(2026, 10, 22, 2, 0)
  assert Cron('*/15 * * * *').next_after(at) == datetime.datetime(2026, 10, 21, 13, 45)
  assert Cron('30 1 * * mon-fri').next_after(datetime.datetime(2026, 10, 23, 2, 0)) == datetime.datetime(2026, 10, 26, 1, 30)
  assert Cron('59 1 1 * *').next_after(at) == datetime.datetime(2026, 11, 1, 1, 59)
  assert Cron('@weekly').next_after(at) == datetime.datetime(2026, 10, 25, 0, 0)
  # day of month OR day of week, like cron
  assert Cron('0 0 1 * 5').next_after(at) == datetime.datetime(2026, 10, 23, 0, 0)
  assert Cron('0 0 29 2 *').next_after(at) == datetime.datetime(2028, 2, 29, 0, 0)
  # 02:00 in Jerusalem is 23:00 UTC (summer time ends on October 25th, 2026)
  assert next_run('0 2 * * *', 'Asia/Jerusalem', at) == datetime.datetime(2026, 10, 21, 23, 0)
  assert next_run('0 2 * * *', 'Asia/Jerusalem', datetime.datetime(2026, 10, 26, 12, 0)) == datetime.datetime(2026, 10, 27, 0, 0)
  for wrong in ['', '* * * *', '60 * * * *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a b c d e']:
    with pytest.raises(CronError):
      Cron(wrong)
  with pytest.raises(CronError):
    Cron('0 0 31 2 *').next_after(at)


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

def artifacts(world, storage, hexsha, branch='feature', files=True, latest=None, project='proj', days=90):
  """A commit with artifacts: a manifest of the "build" group, and its files"""
  import json
  from backend.models import CiCommit
  folder = storage / 'artifacts' / hexsha[:8]
  commit = CiCommit(hexsha, project=world.project(project), branch=branch,
                    authored_datetime=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days))
  commit.latest_output_datetime = latest or commit.authored_datetime
  commit.commit_dir_override = str(folder)
  world.db.add(commit)
  world.db.flush()
  if files:
    (folder / 'manifests').mkdir(parents=True)
    (folder / 'build').mkdir()
    for name in ['app', 'keep.txt']:
      (folder / 'build' / name).write_text(name)
    (folder / 'manifests' / 'build.json').write_text(json.dumps({"build/app": {}, "build/keep.txt": {}}))
  return commit.id, folder


def test_delete_artifacts(admin, world, storage):
  from backend.database import db_session
  from backend.models import CiCommit, Milestone, Batch
  old, old_dir = artifacts(world, storage, '1' * 40)
  gone, _ = artifacts(world, storage, '2' * 40, files=False)
  milestone, milestone_dir = artifacts(world, storage, '3' * 40)
  world.db.add(Milestone(project_id='proj', commit_hexsha='3' * 40, batch='default'))
  reference, reference_dir = artifacts(world, storage, '4' * 40, branch='master')
  older_reference, older_reference_dir = artifacts(world, storage, '5' * 40, branch='master', days=200)
  recent, recent_dir = artifacts(world, storage, '6' * 40, latest=datetime.datetime.now(datetime.timezone.utc))
  busy, busy_dir = artifacts(world, storage, '7' * 40)
  world.run(world.batch('proj', hexsha='7' * 40), deleted=False, pending=True)
  world.commit()

  assert admin.post('/api/v1/admin/jobs', json={"kind": "delete_artifacts"}).status_code == 400, "older_than is required"
  answer = start(admin, kind='delete_artifacts', older_than='1month', keep=['build/keep.txt'], dry_run=True)
  assert answer["description"] == 'Delete the artifacts of *, for commits without runs for 1month, keeping build/keep.txt'
  run_jobs()
  dry = job(admin, answer["id"])
  assert dry["status"] == 'done' and dry["progress"]["commits_deleted"] == 2 and (old_dir / 'build' / 'app').exists()
  db_session.expire_all()
  assert not db_session.get(CiCommit, gone).deleted

  answer = admin.post(f'/api/v1/admin/jobs/{answer["id"]}/retry', json={"dry_run": False}).get_json()
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done', done["error"]
  progress = done["progress"]
  assert progress["commits_deleted"] == 2 and progress["commits_without_files"] == 1 and progress["artifacts_files"] == 1
  # the reference branch's commits aren't even looked at
  assert progress["commits_protected"] == 1 and progress["commits_busy"] == 1
  assert not (old_dir / 'build' / 'app').exists() and (old_dir / 'build' / 'keep.txt').exists()
  for folder in [milestone_dir, reference_dir, older_reference_dir, recent_dir, busy_dir]:
    assert (folder / 'build' / 'app').exists(), folder
  db_session.expire_all()
  deleted = {c.id: c for c in CiCommit.query.filter(CiCommit.deleted.is_(True))}
  assert set(deleted) == {old, gone}
  assert deleted[old].data['artifacts_deleted']['by'] == f'admin job #{answer["id"]}'
  assert deleted[gone].data['artifacts_deleted']['already_gone'] is True

  # the reference branch's older commits, when asked (its latest stays)
  answer = start(admin, kind='delete_artifacts', older_than='1month', can_delete_reference_branch=True)
  run_jobs()
  assert not (older_reference_dir / 'build' / 'app').exists() and (reference_dir / 'build' / 'app').exists()


def test_artifacts_errors_are_tried_again(admin, world, storage, monkeypatch):
  from backend.models import CiCommit
  from backend.jobs import common
  old, old_dir = artifacts(world, storage, '1' * 40)
  world.commit()
  import sys
  ci_commit_module = sys.modules['backend.models.CiCommit']
  real_rmtree = ci_commit_module.rmtree
  def rmtree(path):
    raise Exception(f"ERROR [Errno 13] Permission denied: '{path}': Could not remove: {path}")
  monkeypatch.setattr(ci_commit_module, 'rmtree', rmtree)
  answer = start(admin, kind='delete_artifacts', older_than='1month')
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done_with_errors' and done["progress"]["errors"] == {"permission": 2} and done["progress"]["commits_failed"] == 1
  error = admin.get(f'/api/v1/admin/jobs/{answer["id"]}/errors').get_json()["errors"][0]
  assert error["path"] == str(old_dir / 'build' / 'app') and error["owner"] == 'root'

  monkeypatch.setattr(ci_commit_module, 'rmtree', real_rmtree)
  answer = start(admin, kind='delete_artifacts', older_than='1month')
  run_jobs()
  assert job(admin, answer["id"])["progress"]["commits_deleted"] == 1
  assert not (old_dir / 'build' / 'app').exists()
