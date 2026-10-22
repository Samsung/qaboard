"""Activity: what runs now and what ran recently, the batches that start soon, and marking stuck runs as failed"""
import datetime
from types import SimpleNamespace

import pytest

from .test_jobs import World, run_jobs, storage, admin, start, job  # noqa: F401 (fixtures)
from .test_ingest import output_payload, STORAGE


@pytest.fixture
def world(storage):
  return World(storage)


@pytest.fixture
def alice(logged_in):
  return logged_in('alice')


def ago(**delta):
  return datetime.datetime.utcnow() - datetime.timedelta(**delta)


def add_run(world, batch, status, user='alice', queued=None, started=None, finished=None, created=None, job_options=None, root_command_id=None):
  from backend.models import Output, TestInput
  world.inputs += 1
  data = {"user": user, **({"job_options": job_options} if job_options else {}), **({"root_command_id": root_command_id} if root_command_id else {})}
  output = Output(batch=batch, test_input=TestInput('/db', f'input-{world.inputs}.bin'), platform='linux', configurations=['base'],
                  extra_parameters={}, deleted=False, data=data, created_date=created or queued or ago(days=1),
                  is_pending=status in ('waiting', 'running'), is_running=status == 'running', is_failed=status == 'failed',
                  queued_at=queued, started_at=started, finished_at=finished)
  world.db.add(output)
  world.db.flush()
  return output.id


def setup_runs(world):
  """In proj/a: alice's batch with runs waiting, running and done; bob's runs, and an old one. In proj/b: alice's failed run."""
  lsf = {"type": "lsf", "queue": "gpu", "command_id": "x", "project": "isp"}
  tuning = world.batch('proj/a', hexsha='a' * 40, label='tuning')
  ids = {"tuning": tuning.id}
  ids['waiting'] = add_run(world, tuning, 'waiting', queued=ago(minutes=30), job_options=lsf, root_command_id='cmd-1')
  ids['running'] = add_run(world, tuning, 'running', queued=ago(hours=2), started=ago(hours=1), job_options=lsf, root_command_id='cmd-1')
  ids['done'] = add_run(world, tuning, 'done', queued=ago(hours=3), started=ago(hours=2, minutes=30), finished=ago(hours=2), job_options=lsf, root_command_id='cmd-1')
  # ended before the window: not shown
  add_run(world, tuning, 'done', queued=ago(days=3), started=ago(days=3), finished=ago(days=2, hours=23))
  # from before QA-Board saved dates: still pending, only with its creation date
  ids['stuck'] = add_run(world, tuning, 'running', user='bob', created=ago(days=20))
  ci = world.batch('proj/a', hexsha='a' * 40, label='default')
  ids['ci'] = ci.id
  ids['bob'] = add_run(world, ci, 'running', user='bob', queued=ago(minutes=10), started=ago(minutes=5), job_options={"type": "local"})
  other = world.batch('proj/b', hexsha='b' * 40, label='default', branch='master')
  ids['failed'] = add_run(world, other, 'failed', queued=ago(hours=5), started=ago(hours=5), finished=ago(hours=4))
  world.commit()
  return ids


def test_overview(alice, world):
  setup_runs(world)
  answer = alice.get('/api/v1/activity/overview').get_json()
  assert answer["scope"] == 'me' and answer["window"] == '24h'
  assert {k: answer["totals"][k] for k in ('waiting', 'running', 'done', 'failed', 'active_projects', 'active_batches', 'long_active')} == {
    'waiting': 1, 'running': 1, 'done': 1, 'failed': 1, 'active_projects': 1, 'active_batches': 1, 'long_active': 0}
  assert [(p["key"], p["waiting"], p["running"], p["ended"], p["failed"]) for p in answer["projects"]] == [('proj/a', 1, 1, 1, 0), ('proj/b', 0, 0, 1, 1)]
  assert answer["queues"][0]["key"] == 'gpu'
  assert "users" not in answer

  everyone = alice.get('/api/v1/activity/overview?scope=all').get_json()
  assert (everyone["totals"]["running"], everyone["totals"]["long_active"]) == (3, 1)
  # the most active runs first, then the most runs
  assert [(u["key"], u["waiting"], u["running"]) for u in everyone["users"]] == [('alice', 1, 1), ('bob', 0, 2)]
  assert everyone["stuck"]["runs"] == 1 and "schedule" not in everyone["stuck"]

  # the timeline: 24 bars of an hour. The latest has the runs that wait and run now.
  bars = everyone["timeline"]["bars"]
  assert len(bars) == 24 and everyone["timeline"]["step_seconds"] == 3600
  # runs that waited or ran at some point during the bar: bob's run waited 5 minutes before it started
  assert (bars[-1]["waiting"], bars[-1]["running"]) == (2, 3)
  # the run pending for 20 days runs in every bar
  assert all(bar["running"] >= 1 for bar in bars)
  assert sum(bar["done"] for bar in bars) == 1 and sum(bar["failed"] for bar in bars) == 1
  # a week back: the run that ended 3 days ago
  week = alice.get('/api/v1/activity/overview?window=7d').get_json()
  assert week["totals"]["done"] == 2 and len(week["timeline"]["bars"]) == 28
  assert alice.get('/api/v1/activity/overview?window=1y').status_code == 400


def test_groups(alice, world):
  ids = setup_runs(world)
  batches = alice.get('/api/v1/activity/items?group=batch&scope=all').get_json()
  assert batches["total"] == 3
  first = batches["items"][0]
  assert (first["key"], first["waiting"], first["running"], first["done"], first["batch_label"], first["nb_users"]) == (ids["tuning"], 1, 2, 1, 'tuning', 2)
  assert first["queues"] == ['gpu'] and first["runners"] == ['lsf']
  assert first["run_seconds"] == 1800 and first["wait_seconds"] is not None
  # the run pending for 20 days
  oldest = alice.get('/api/v1/activity/items?group=batch&scope=all&sort=oldest').get_json()["items"][0]
  assert oldest["key"] == ids["tuning"] and oldest["active_since"] < first["latest"]

  def keys(**params):
    query = '&'.join(f"{k}={v}" for k, v in params.items())
    return [(i["key"], i["runs"]) for i in alice.get(f'/api/v1/activity/items?scope=all&{query}').get_json()["items"]]
  assert keys(group='project') == [('proj/a', 5), ('proj/b', 1)]
  assert keys(group='user') == [('bob', 2), ('alice', 4)]
  # the most active first, then the latest news
  assert keys(group='runner', status='active') == [('lsf', 2), ('local', 1), ('', 1)]
  assert keys(group='queue', status='ended') == [('gpu', 1), ('', 1)]
  assert keys(group='option', option='project', status='active') == [('', 2), ('isp', 2)]
  assert keys(group='status') == [('running', 3), ('waiting', 1), ('done', 1), ('failed', 1)]
  assert keys(group='project', search='bbbb') == [('proj/b', 1)]
  assert keys(group='batch', search='tun') == [(ids["tuning"], 4)]
  assert alice.get('/api/v1/activity/items?group=nope').status_code == 400
  assert alice.get('/api/v1/activity/items?group=option').status_code == 400


def test_commands(alice, world):
  from sqlalchemy.orm.attributes import flag_modified
  ids = setup_runs(world)
  from backend.models import Batch
  batch = world.db.get(Batch, ids["tuning"])
  batch.data = {"commands": {"cmd-1": {"argv": ["qa", "batch", "tuning"], "command_created_at_datetime": "2026-10-22T08:00:00", "job_url": "https://ci/1", "user": "alice"}}}
  flag_modified(batch, "data")
  world.commit()
  items = alice.get('/api/v1/activity/items?group=command').get_json()["items"]
  command = next(i for i in items if i["key"] == 'cmd-1')
  assert command["command"] == {"argv": "qa batch tuning", "created_at": "2026-10-22T08:00:00", "job_url": "https://ci/1", "runner": None, "user": "alice"}


def test_runs(alice, world):
  ids = setup_runs(world)
  answer = alice.get(f'/api/v1/activity/runs?group=batch&key={ids["tuning"]}&scope=all').get_json()
  assert answer["total"] == 4
  # running first, then waiting, then what ended
  assert [r["status"] for r in answer["runs"]] == ['running', 'running', 'waiting', 'done']
  run = next(r for r in answer["runs"] if r["id"] == ids["waiting"])
  assert run["input_path"].startswith('input-') and run["configurations"] == ['base'] and run["batch_label"] == 'tuning'
  # what users chose, not what qa sets
  assert run["job_options"] == {"type": "lsf", "queue": "gpu", "project": "isp"}
  assert run["output_dir_url"] and run["queued_at"].endswith('Z') and run["started_at"] is None
  assert alice.get('/api/v1/activity/runs?status=failed').get_json()["runs"][0]["id"] == ids["failed"]
  assert alice.get('/api/v1/activity/runs?group=batch&key=nope').status_code == 400


def test_private_projects_are_hidden(alice, logged_in, world):
  from backend.models import ProjectVisibility
  setup_runs(world)
  world.db.add(ProjectVisibility(path='proj/b', visibility='private'))
  world.commit()
  bob = logged_in('bob')
  everyone = bob.get('/api/v1/activity/overview?scope=all').get_json()
  assert [p["key"] for p in everyone["projects"]] == ['proj/a']
  assert bob.get('/api/v1/activity/items?scope=all&group=project').get_json()["total"] == 1
  assert bob.get('/api/v1/activity/runs?project=proj/b&scope=all').status_code == 403


def test_starting_soon(alice, world):
  """Batches started from QA-Board whose `qa batch` didn't start yet"""
  from sqlalchemy.orm.attributes import flag_modified
  ids = setup_runs(world)
  from backend.models import Batch
  batch = world.db.get(Batch, ids["ci"])
  created = lambda **delta: ago(**delta).isoformat() + 'Z'
  batch.data = {
    "submissions": {
      "queued": {"id": "queued", "status": "submitted", "runner": "lsf", "user": "alice", "created_at": created(minutes=5), "lsf_job_id": "123", "log_dir": str(STORAGE / "logs")},
      "started": {"id": "started", "status": "submitted", "runner": "lsf", "user": "alice", "created_at": created(minutes=20)},
      "failed": {"id": "failed", "status": "failed", "runner": "lsf", "user": "alice", "created_at": created(minutes=5)},
      "lost": {"id": "lost", "status": "submitted", "runner": "lsf", "user": "alice", "created_at": created(days=10)},
      "bobs": {"id": "bobs", "status": "submitting", "runner": "local", "user": "bob", "created_at": created(minutes=1)},
    },
    # `qa batch` started: it saved its command
    "commands": {"started": {"argv": ["qa", "batch"]}},
  }
  flag_modified(batch, "data")
  world.commit()
  soon = alice.get('/api/v1/activity/overview').get_json()["starting_soon"]
  assert [(s["id"], s["lsf_job_id"], s["batch_label"], s["project_id"]) for s in soon] == [('queued', '123', 'default', 'proj/a')]
  assert soon[0]["log_dir_url"]
  everyone = alice.get('/api/v1/activity/overview?scope=all').get_json()["starting_soon"]
  assert [s["id"] for s in everyone] == ['bobs', 'queued']


def test_users_mark_their_runs_as_failed(alice, world):
  from backend.database import db_session
  from backend.models import Output, BatchNotification, Batch
  ids = setup_runs(world)
  batch = world.db.get(Batch, ids["tuning"])
  world.db.add(BatchNotification(command_id='cmd-1', ci_commit_id=batch.ci_commit_id, batch_id=batch.id, user_name='alice', status='waiting'))
  world.commit()
  # a preview first: only alice's own runs, bob's stuck run in the same batch isn't hers
  body = {"group": "batch", "key": ids["tuning"], "scope": "all", "dry_run": True}
  preview = alice.post('/api/v1/activity/fail', json=body).get_json()
  assert preview == {"runs": 2, "batches": 1, "projects": {"proj/a": 2}, "dry_run": True}
  # never everything by mistake
  assert alice.post('/api/v1/activity/fail', json={"scope": "all"}).status_code == 400
  done = alice.post('/api/v1/activity/fail', json={**body, "dry_run": False}).get_json()
  assert done["runs"] == 2
  db_session.expire_all()
  waiting = db_session.get(Output, ids["waiting"])
  assert (waiting.is_pending, waiting.is_running, waiting.is_failed) == (False, False, True)
  assert waiting.finished_at is not None and 'Marked as failed by alice' in waiting.data["failed_reason"]
  assert db_session.get(Output, ids["stuck"]).is_pending
  # no run of the command is pending: the email it waited for won't come
  assert db_session.query(BatchNotification).filter_by(command_id='cmd-1').one().status == 'cancelled'
  # it's audited
  assert db_session.execute(__import__('sqlalchemy').text("SELECT count(*) FROM audit_events WHERE action = 'runs.fail'")).scalar() == 1


def test_users_need_access_to_fail_runs(alice, world, monkeypatch):
  ids = setup_runs(world)
  monkeypatch.setenv('QABOARD_SIGNED_IN_ROLE', 'viewer')
  answer = alice.post('/api/v1/activity/fail', json={"group": "batch", "key": ids["tuning"]})
  assert answer.status_code == 403 and answer.get_json()["reason"] == 'forbidden_project'


def test_fail_stuck_runs_job(admin, world):
  from backend.database import db_session
  from backend.models import Output
  ids = setup_runs(world)
  # a dry run first: nothing changes
  dry = start(admin, kind='fail_stuck_runs', older_than='1week', dry_run=True)
  run_jobs()
  answer = job(admin, dry["id"])
  assert answer["status"] == 'done' and answer["progress"]["runs_failed"] == 1
  db_session.expire_all()
  assert db_session.get(Output, ids["stuck"]).is_pending
  # then for real
  real = start(admin, kind='fail_stuck_runs', older_than='1week')
  run_jobs()
  assert job(admin, real["id"])["progress"]["runs_failed"] == 1
  db_session.expire_all()
  stuck = db_session.get(Output, ids["stuck"])
  assert (stuck.is_pending, stuck.is_running, stuck.is_failed) == (False, False, True)
  assert 'after 1week' in stuck.data["failed_reason"]
  # the others are untouched
  assert db_session.get(Output, ids["running"]).is_pending and db_session.get(Output, ids["waiting"]).is_pending
  # admins see the schedule that does it
  assert admin.post('/api/v1/admin/job-schedules', json={"name": "Stuck runs", "kind": "fail_stuck_runs", "params": {"older_than": "1week"}, "cron": "0 3 * * *", "timezone": "UTC"}).status_code == 201
  stuck = admin.get('/api/v1/activity/overview?scope=all').get_json()["stuck"]
  assert stuck["runs"] == 0 and stuck["schedule"]["name"] == 'Stuck runs' and stuck["schedule"]["older_than"] == '1week'
  assert admin.post('/api/v1/admin/jobs', json={"kind": "fail_stuck_runs", "params": {"older_than": "soon"}}).status_code == 400


def test_runs_say_when_they_were_queued_started_and_ended(client):
  """What `qa batch` and `qa run` send: queued, running, then ended"""
  from backend.database import db_session
  from backend.models import Output
  def send(**status):
    response = client.post('/api/v1/output/', json=output_payload(**status))
    assert response.status_code == 200, response.get_json()
    db_session.remove()
    output = db_session.get(Output, response.get_json()["id"])
    # the app uses the same session: a copy, so that the next requests don't change it
    return SimpleNamespace(queued_at=output.queued_at, started_at=output.started_at, finished_at=output.finished_at)
  queued = send(is_pending=True)
  assert queued.queued_at and not queued.started_at and not queued.finished_at
  running = send(is_pending=True, is_running=True)
  assert running.queued_at == queued.queued_at and running.started_at >= running.queued_at and not running.finished_at
  ended = send(is_pending=False)
  assert (ended.queued_at, ended.started_at) == (running.queued_at, running.started_at) and ended.finished_at >= ended.started_at
  # a redo is a new attempt
  again = send(is_pending=True)
  assert again.queued_at > ended.queued_at and not again.started_at and not again.finished_at
  # `qa run` alone: it runs right away
  direct = send(is_pending=True, is_running=True, rel_input_path='inputs/b.txt')
  assert direct.queued_at == direct.started_at


def test_older_runs_count_from_when_they_were_created(alice, world):
  """Runs from before QA-Board recorded when runs end: they started when created, and ended compute_time later"""
  from backend.models import Output
  batch = world.batch('proj/a', hexsha='a' * 40, label='old')
  recent = add_run(world, batch, 'done', created=ago(hours=2))
  world.db.get(Output, recent).metrics = {"compute_time": 1500, "loss": 1}
  unknown = add_run(world, batch, 'done', created=ago(hours=1))
  add_run(world, batch, 'failed', created=ago(days=3))
  # started before the window, ended in it
  long = add_run(world, batch, 'done', created=ago(hours=25))
  world.db.get(Output, long).metrics = {"compute_time": 7200}
  # nonsense compute times are ignored
  world.db.get(Output, add_run(world, batch, 'done', created=ago(hours=3))).metrics = {"compute_time": "slow"}
  world.commit()
  answer = alice.get('/api/v1/activity/overview').get_json()
  assert (answer["totals"]["done"], answer["totals"]["failed"]) == (4, 0)
  assert sum(bar["done"] for bar in answer["timeline"]["bars"]) == 4
  assert any(bar["running"] for bar in answer["timeline"]["bars"])
  runs = {r["id"]: r for r in alice.get('/api/v1/activity/runs').get_json()["runs"]}
  assert runs[recent]["estimated"] and runs[recent]["started_at"] == runs[recent]["created_date"]
  assert runs[recent]["finished_at"] > runs[recent]["started_at"]
  assert (runs[unknown]["started_at"], runs[unknown]["finished_at"]) == (None, runs[unknown]["created_date"])
  assert long in runs
  week = alice.get('/api/v1/activity/items?group=batch&window=7d').get_json()["items"][0]
  assert (week["done"], week["failed"], week["run_seconds"]) == (4, 1, (1500 + 7200) / 2)
