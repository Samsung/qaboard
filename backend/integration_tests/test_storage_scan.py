"""What deleted runs leave, deletion rules, exports, and storage scans: finding and cleaning what QA-Board doesn't track"""
import os
import json
import datetime
from pathlib import Path

import pytest

from .test_jobs import World, run_jobs, exists, storage, admin, start, job  # noqa: F401 (fixtures)
from .test_storage_usage import refresh, GB


@pytest.fixture
def world(storage):
  return World(storage)


@pytest.fixture
def alice(logged_in):
  return logged_in('alice')


def write(path: Path, size=10, name='image.png'):
  path.mkdir(parents=True, exist_ok=True)
  (path / name).write_bytes(b'x' * size)
  return path


# ---------------------------------------------------------------------------
# What deleted runs leave
# ---------------------------------------------------------------------------

def test_soft_deletes_measure_what_they_leave(alice, world, storage):
  from backend.models import Output
  batch = world.batch('proj')
  run = world.run(batch, deleted=False, user='alice', size=10 * GB, files=True)
  # a file the manifest doesn't list: soft deletes keep it
  (run.output_dir / 'log.txt').write_bytes(b'l' * 1000)
  batch_id = batch.id
  world.commit()
  assert alice.delete(f'/api/v1/batch/{batch_id}?soft=true').status_code == 200
  output = world.db.get(Output, run.id)
  world.db.refresh(output)
  assert output.deleted and output.data['storage_left'] == 1000 + len('{"image.png": {"st_size": 10}}') and output.data['deleted_at']
  totals = alice.get('/api/v1/storage/overview').get_json()["totals"]
  assert totals["bytes"] == 0 and totals["deleted"] == {"runs": 1, "bytes": output.data['storage_left'], "unmeasured": 0}


def test_partial_deletes_update_the_size(world, storage):
  from backend.models import Output
  batch = world.batch('proj')
  run = world.run(batch, deleted=False, size=10, files=True)
  world.commit()
  output = world.db.get(Output, run.id)
  output.delete(soft=True, filter='*.png')
  assert not output.deleted and output.data['storage'] == len('{"image.png": {"st_size": 10}}')


def test_measure_what_older_deletions_left(admin, alice, world, storage):
  batch = world.batch('proj')
  left = world.run(batch, deleted=True, user='alice', files=True)   # deleted before QA-Board measured
  gone = world.run(batch, deleted=True, user='alice')                # its folder is gone
  world.commit()
  refresh()
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["deleted"]["unmeasured"] == 2
  answer = start(admin, kind='measure_deleted')
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done', done["error"]
  assert done["progress"]["runs_measured"] == 1 and done["progress"]["runs_without_files"] == 1
  assert alice.get('/api/v1/storage/overview').get_json()["totals"]["deleted"] == {"runs": 2, "bytes": 2, "unmeasured": 0}


# ---------------------------------------------------------------------------
# Deletion rules
# ---------------------------------------------------------------------------

def test_rules(admin, alice, world):
  world.project('proj', data={"qatools_config": {"storage": {"garbage": {"after": "2weeks", "artifacts": {"delete": True}}}}})
  world.project('other')
  world.commit()
  for body in [
    {"name": "Nightly purge", "kind": "hard_delete", "cron": "0 2 * * *", "timezone": "Asia/Jerusalem", "params": {"created_before": "1month"}},
    {"name": "Old results", "kind": "garbage_collect", "cron": "59 1 * * 6", "params": {"default_older_than": "1month"}},
    {"name": "Artifacts of others", "kind": "delete_artifacts", "cron": "0 3 1 * *", "params": {"projects": ["other"], "older_than": "2months"}},
    {"name": "Disabled", "kind": "hard_delete", "cron": "0 4 * * *", "enabled": False},
  ]:
    assert admin.post('/api/v1/admin/job-schedules', json=body).status_code == 201
  rules = alice.get('/api/v1/storage/rules?project=proj').get_json()
  assert [r["schedule"] for r in rules["rules"]] == ['Old results', 'Nightly purge'] or [r["schedule"] for r in rules["rules"]] == ['Nightly purge', 'Old results']
  by_name = {r["schedule"]: r for r in rules["rules"]}
  assert by_name['Nightly purge']["when"] == 'every day at 02:00 (Asia/Jerusalem)'
  assert by_name['Nightly purge']["detail"] == "Runs that were deleted created before 1month are removed for good, with what's left of their files."
  old = by_name['Old results']
  assert old["when"] == 'every Saturday at 01:59 (UTC)' and old["after"] == '2weeks'
  assert "qaboard.yaml" in old["detail"] and "artifacts are deleted too" in old["detail"]
  assert rules["settings"] == {"after": "2weeks", "artifacts_delete": True, "can_delete_reference_branch": False}
  other = alice.get('/api/v1/storage/rules?project=other').get_json()["rules"]
  assert {r["schedule"] for r in other} == {'Nightly purge', 'Old results', 'Artifacts of others'}
  assert {r["schedule"]: r for r in other}['Old results']["after"] == '1month'
  assert {r["schedule"]: r for r in other}['Artifacts of others']["when"] == 'on the 1st of every month at 03:00 (UTC)'


def test_cron_in_words():
  from backend.jobs.cron import describe
  assert describe('0 2 * * 1-5', 'UTC') == 'every weekday at 02:00 (UTC)'
  assert describe('15 * * * *') == 'every hour at :15'
  assert describe('*/10 2 * * *') == 'on the schedule "*/10 2 * * *" (UTC)'


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def test_exports(alice, logged_in, admin, world, storage):
  from backend.exports import record
  from backend.database import db_session
  run = write(storage / 'outputs' / 'run', size=1000)
  folder = storage / 'exports' / 'alice' / 'one'
  folder.mkdir(parents=True)
  os.link(run / 'image.png', folder / 'image@new.png')
  (folder / 'copy.png').write_bytes(b'c' * 500)
  (folder / '0.qa.url').write_text('[InternetShortcut]')
  export = record(folder, project_id='proj', hexsha='a' * 40, batch_label='default', user_name='alice', export_type='link', nb_files=2)
  db_session.commit()
  assert export.bytes == 1000 + 500 + len('[InternetShortcut]') and export.linked_bytes == 1000 and export.files == 3
  # again into the same folder
  record(folder, project_id='proj', user_name='alice')
  db_session.commit()
  listed = alice.get('/api/v1/storage/exports').get_json()
  assert [e["path"] for e in listed["exports"]] == [str(folder)] and listed["exports"][0]["exports"] == 2
  assert listed["totals"] == {"count": 1, "bytes": export.bytes, "linked_bytes": 1000}
  assert alice.get('/api/v1/storage/overview').get_json()["exports"]["count"] == 1
  bob = logged_in('bob')
  assert bob.get('/api/v1/storage/exports').get_json()["exports"] == []
  assert bob.post('/api/v1/storage/exports/delete', json={"ids": [export.id]}).status_code == 403
  answer = alice.post('/api/v1/storage/exports/delete', json={"ids": [export.id]})
  assert answer.status_code == 201
  run_jobs()
  assert not folder.exists() and (run / 'image.png').exists(), "the run's file stays: the export only had a link"
  assert alice.get('/api/v1/storage/exports').get_json()["exports"] == []
  deletions = alice.get('/api/v1/storage/jobs').get_json()["jobs"]
  assert deletions[0]["kind"] == 'delete_exports' and deletions[0]["status"] == 'done'


def test_exports_root(admin, monkeypatch, storage):
  from backend.exports import default_dir
  assert default_dir('alice', 'group/proj', 'abcdef123456') is None
  assert admin.post('/api/v1/admin/settings', json={"storage.exports_root": "/not/in/the/storage"}).status_code == 400
  assert admin.post('/api/v1/admin/settings', json={"storage.exports_root": str(storage / 'exports')}).status_code == 200
  path = default_dir('alice', 'group/proj', 'abcdef123456')
  assert str(path).startswith(f"{storage}/exports/alice/group/proj/") and path.name.endswith('-abcdef12')


# ---------------------------------------------------------------------------
# Scans
# ---------------------------------------------------------------------------

def tree(world, storage):
  """A batch's folder with a run QA-Board knows, one it doesn't, one deleted; exports; artifacts; junk"""
  from backend.models import Output, CiCommit, Export
  outputs = storage / 'outputs'
  batch = world.batch('proj', hexsha='ab' + 'c' * 38, label='default')
  batch.batch_dir_override = str(outputs / 'ab' / 'cccccccccccccc' / 'output')
  known = world.run(batch, deleted=False, user='alice', size=3000, files=True)
  (known.output_dir / 'run.json').write_text('{}')
  deleted = world.run(batch, deleted=True, user='alice', files=True)
  untracked = write(Path(batch.batch_dir_override) / 'stray-run', size=2000)
  (untracked / 'run.json').write_text(json.dumps({"database": "/db", "input_path": "stray.bin", "platform": "linux", "configurations": ["base"], "extra_parameters": {}}))
  (untracked / 'metrics.json').write_text(json.dumps({"loss": 0.5}))
  (untracked / 'manifest.outputs.json').write_text(json.dumps({"image.png": {"st_size": 2000}}))
  shared = write(outputs / 'ab' / 'cccccccccccccc' / 'share' / '1234abcd', size=4000)
  (shared / '0.qa.url').write_text('x')
  tracked_export = write(storage / 'exports' / 'tracked', size=100)
  (tracked_export / '0.common.json').write_text('{}')
  world.db.add(Export(path=str(tracked_export), owner='root', bytes=100))
  commit = CiCommit('de' + 'f' * 38, project=world.project('proj'), branch='feature')
  commit.commit_dir_override = str(storage / 'artifacts' / 'de' / 'ffffffffffffff')
  commit.deleted = True
  world.db.add(commit)
  write(Path(commit.commit_dir_override) / 'manifests', size=5, name='build.json')
  write(Path(commit.commit_dir_override) / 'build', size=6000, name='app')
  write(storage / 'junk', size=7000, name='core.dump')
  ids = {"batch": batch.id, "known": known.id, "deleted": deleted.id}
  world.commit()
  return ids, {"batch": Path(batch.batch_dir_override), "known": known.output_dir, "deleted": deleted.output_dir, "untracked": untracked, "shared": shared,
               "tracked_export": tracked_export, "artifacts": Path(commit.commit_dir_override), "junk": storage / 'junk'}


def scan(admin, storage, **params):
  answer = start(admin, kind='scan_storage', roots=[str(storage)], min_size_mb=0, threads=4, **params)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'done', done["error"]
  return admin.get('/api/v1/admin/scans').get_json()["scans"][0]


def entries(admin, scan_id, **params):
  return {e["path"]: e for e in admin.get(f'/api/v1/admin/scans/{scan_id}/entries', query_string=params).get_json()["entries"]}


def test_scan_finds_what_qaboard_doesnt_track(admin, world, storage):
  ids, paths = tree(world, storage)
  result = scan(admin, storage)
  assert result["status"] == 'done' and result["errors"] == 0
  by_kind = result["by_kind"]
  assert by_kind["run"] > 0 and by_kind["untracked_run"] >= 2000 and by_kind["untracked_export"] >= 4000
  assert by_kind["export"] >= 100 and by_kind["deleted_artifacts"] >= 6000 and by_kind["untracked_files"] >= 7000
  assert by_kind["deleted_run"] > 0
  assert result["untracked_bytes"] == sum(v for k, v in by_kind.items() if k in ('deleted_run', 'untracked_run', 'deleted_artifacts', 'untracked_export', 'untracked_files'))

  roots = entries(admin, result["id"])
  assert list(roots) == [str(storage)] and roots[str(storage)]["bytes"] == result["bytes"]
  top = entries(admin, result["id"], parent=str(storage))
  assert top[str(paths["junk"])]["kind"] == 'folder' and top[str(paths["junk"])]["deletable"] is True
  assert top[str(storage / 'outputs')]["deletable"] is False, "QA-Board's runs are inside"
  batch_dir = str(paths["batch"])
  assert entries(admin, result["id"], parent=str(paths["batch"].parent))[batch_dir]["kind"] == 'batch'
  inside = entries(admin, result["id"], parent=batch_dir)
  assert inside[batch_dir + '/stray-run']["kind"] == 'untracked_run' and inside[batch_dir + '/stray-run']["ref"]["batch_id"] == ids["batch"]
  runs = entries(admin, result["id"], parent=str(paths["known"].parent))
  assert runs[str(paths["known"])]["kind"] == 'run' and runs[str(paths["deleted"])]["kind"] == 'deleted_run'
  assert runs[str(paths["known"])]["ref"]["output_id"] == ids["known"]
  flat = entries(admin, result["id"], flat='true')
  assert str(paths["shared"]) in flat and str(paths["artifacts"]) in flat and str(paths["known"]) not in flat
  scan_detail = admin.get(f'/api/v1/admin/scans/{result["id"]}').get_json()
  assert scan_detail["owners"][0]["owner"] == 'root' and scan_detail["owners"][0]["untracked_bytes"] == result["untracked_bytes"]


def test_scan_reads_each_folder_once(admin, storage):
  """Nested roots, the same folder under another path, and storage snapshots are scanned once, or not at all"""
  data = write(storage / 'data' / 'big', size=1000)
  (storage / 'data' / '.snapshot' / 'hourly.0').mkdir(parents=True)
  write(storage / 'data' / '.snapshot' / 'hourly.0' / 'big', size=1000)
  (storage / 'link').symlink_to(storage / 'data')
  roots = [str(storage / 'data'), str(storage / 'link'), str(data), str(storage / 'link' / 'big')]
  # an admin's own exclusions don't bring the snapshots back
  answer = start(admin, kind='scan_storage', roots=roots, min_size_mb=0, threads=2, exclude_paths=['*/nothing'])
  run_jobs()
  assert job(admin, answer["id"])["status"] == 'done'
  result = admin.get('/api/v1/admin/scans').get_json()["scans"][0]
  assert result["roots"] == [str(storage / 'data')]
  assert result["bytes"] == 1000 and result["files"] == 1


def test_scans_stop_inside_big_folders(admin, storage, monkeypatch):
  """Cancelling doesn't wait for a big folder to be done, the folders read are the progress meanwhile, and the scan can be deleted"""
  from backend.database import engine
  from backend.models import Job
  from backend.jobs import scan as scan_job, report
  for i in range(30):
    write(storage / 'huge' / f'sub{i}' / 'deeper')
  monkeypatch.setattr(scan_job, 'PROGRESS_EVERY', 0.01)
  monkeypatch.setattr(report, 'FLUSH_EVERY', 0)
  answer = start(admin, kind='scan_storage', roots=[str(storage)], min_size_mb=0, threads=1)
  real_read = scan_job.Scanner.read
  def read(self, path):
    if self.dirs == 10:
      with engine.begin() as connection:
        connection.execute(Job.__table__.update().where(Job.__table__.c.id == answer["id"]).values(cancel_requested=True))
      import time
      time.sleep(0.2)  # the main thread notices
    return real_read(self, path)
  monkeypatch.setattr(scan_job.Scanner, 'read', read)
  run_jobs()
  done = job(admin, answer["id"])
  assert done["status"] == 'cancelled', done["log"]
  assert done["progress"].get("folders_done", 0) == 0 and 10 <= done["progress"]["dirs_explored"] < 60
  scans = admin.get('/api/v1/admin/scans').get_json()["scans"]
  assert scans[0]["status"] == 'cancelled'
  assert admin.delete(f'/api/v1/admin/scans/{scans[0]["id"]}').status_code == 200
  assert admin.get('/api/v1/admin/scans').get_json()["scans"] == []


def test_running_scans_cant_be_deleted(admin, storage):
  start(admin, kind='scan_storage', roots=[str(storage)])
  from backend.database import db_session
  from backend.models import StorageScan, Job
  queued = Job.query.filter(Job.kind == 'scan_storage').one()
  db_session.add(StorageScan(job_id=queued.id, roots=[str(storage)]))
  db_session.commit()
  scan_id = StorageScan.query.one().id
  refused = admin.delete(f'/api/v1/admin/scans/{scan_id}')
  assert refused.status_code == 400 and 'cancel its job' in refused.get_json()["error"]


def test_scan_actions(admin, world, storage):
  from backend.models import Output, Export
  ids, paths = tree(world, storage)
  result = scan(admin, storage)
  scan_id = result["id"]
  # what QA-Board uses is never deleted from here
  refused = admin.post(f'/api/v1/admin/scans/{scan_id}/delete', json={"paths": [str(paths["known"])]})
  assert refused.status_code == 400
  refused = admin.post(f'/api/v1/admin/scans/{scan_id}/delete', json={"paths": [str(storage / 'outputs')]})
  assert refused.status_code == 400
  answer = admin.post(f'/api/v1/admin/scans/{scan_id}/delete', json={"paths": [str(paths["junk"]), str(paths["artifacts"]), str(paths["deleted"])]})
  assert answer.status_code == 201, answer.get_json()
  run_jobs()
  done = job(admin, answer.get_json()["job"]["id"])
  assert done["status"] == 'done', done
  assert not paths["junk"].exists() and not paths["artifacts"].exists() and not paths["deleted"].exists()
  assert world.db.get(Output, ids["deleted"]).data["storage_left"] == 0
  assert entries(admin, scan_id, parent=str(storage))[str(paths["junk"])]["action"] == 'deleted'

  # exports it found: tracked, their owners see them
  tracked = admin.post(f'/api/v1/admin/scans/{scan_id}/track-exports', json={"paths": [str(paths["shared"])]}).get_json()
  assert [e["path"] for e in tracked["exports"]] == [str(paths["shared"])] and tracked["exports"][0]["source"] == 'scan'
  assert Export.query.filter(Export.path == str(paths["shared"])).one().owner == 'root'

  # runs it found in a batch's folder: back in QA-Board
  answer = admin.post(f'/api/v1/admin/scans/{scan_id}/import-runs', json={"paths": [str(paths["untracked"])]})
  assert answer.status_code == 201
  run_jobs()
  imported = Output.query.filter(Output.output_dir_override == str(paths["untracked"])).one()
  assert imported.batch_id == ids["batch"] and imported.data["storage"] == 2000 and imported.metrics == {"loss": 0.5}
  assert imported.test_input.path == 'stray.bin' and not imported.deleted
  # a new scan knows it
  again = scan(admin, storage)
  assert entries(admin, again["id"], parent=str(paths["batch"]))[str(paths["untracked"])]["kind"] == 'run'


def test_users_see_and_delete_their_untracked_files(admin, alice, world, storage, monkeypatch):
  ids, paths = tree(world, storage)
  result = scan(admin, storage)
  # the files are root's here: pretend they're alice's
  from backend.database import db_session
  from sqlalchemy import text
  db_session.execute(text("UPDATE storage_scan_entries SET owner = 'alice', owners = '{\"alice\": 1}' WHERE scan_id = :id"), {"id": result["id"]})
  db_session.execute(text("UPDATE storage_scans SET totals = jsonb_set(totals, '{by_owner}', jsonb_build_object('alice', totals->'by_kind')) WHERE id = :id"), {"id": result["id"]})
  db_session.commit()
  answer = alice.get('/api/v1/storage/untracked').get_json()
  assert answer["scan"]["id"] == result["id"] and answer["totals"]["bytes"] == result["untracked_bytes"]
  listed = [e["path"] for e in answer["entries"]]
  assert str(paths["junk"]) in listed and str(paths["shared"]) in listed and str(paths["known"]) not in listed
  refused = alice.post('/api/v1/storage/untracked/delete', json={"paths": [str(storage / 'outputs')]})
  assert refused.status_code == 400
  deletion = alice.post('/api/v1/storage/untracked/delete', json={"paths": [str(paths["junk"])]})
  assert deletion.status_code == 201
  run_jobs()
  assert not paths["junk"].exists()
  assert str(paths["junk"]) not in [e["path"] for e in alice.get('/api/v1/storage/untracked').get_json()["entries"]]
