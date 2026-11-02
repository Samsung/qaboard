"""Runs' files: manifests, deletes, and runs saved twice"""
import os
import json
import stat

import pytest

from .test_jobs import World, storage  # noqa: F401 (fixtures)


@pytest.fixture
def world(storage):
  return World(storage)


@pytest.fixture
def umask():
  """The umask is process-wide: what the server sets, every thread sees"""
  previous = os.umask(0o022)
  yield 0o022
  os.umask(previous)


def current_umask():
  mask = os.umask(0)
  os.umask(mask)
  return mask


def test_manifests_dont_change_the_umask(world, umask):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False, files=True, size=10)
  world.commit()
  output = world.db.get(Output, run.id)
  manifest = output.update_manifest()
  assert 'image.png' in manifest
  assert current_umask() == umask
  # users' runs rewrite it under their own accounts
  assert stat.S_IMODE((run.output_dir / 'manifest.outputs.json').stat().st_mode) == 0o666


def test_manifests_of_runs_without_folder(world, umask):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False)
  world.commit()
  output = world.db.get(Output, run.id)
  assert output.update_manifest() == {}
  assert stat.S_IMODE(run.output_dir.stat().st_mode) == 0o777
  assert current_umask() == umask


def test_soft_deletes_remove_the_empty_folders(world):
  from backend.models import Output
  run = world.run(world.batch('proj'), deleted=False, files=True)
  (run.output_dir / 'sub' / 'deeper').mkdir(parents=True)
  (run.output_dir / 'sub' / 'deeper' / 'a.png').write_bytes(b'a')
  (run.output_dir / 'kept').mkdir()
  (run.output_dir / 'kept' / 'b.png').write_bytes(b'b')
  (run.output_dir / 'kept' / 'notes.txt').write_bytes(b'not in the manifest')
  (run.output_dir / 'manifest.outputs.json').write_text(json.dumps({'sub/deeper/a.png': {}, 'kept/b.png': {}}))
  world.commit()
  output = world.db.get(Output, run.id)
  output.delete(soft=True)
  assert not (run.output_dir / 'sub').exists()
  assert sorted(p.name for p in (run.output_dir / 'kept').iterdir()) == ['notes.txt']
  assert (run.output_dir / 'manifest.outputs.json').exists()
  assert output.deleted


def test_runs_saved_twice_keep_the_newest(world):
  from backend.models import Output
  batch = world.batch('proj')
  first = world.run(batch, deleted=False, files=True, size=10)
  output = world.db.get(Output, first.id)
  duplicate = Output(batch=batch, test_input=output.test_input, platform=output.platform, configurations=output.configurations,
                     extra_parameters=output.extra_parameters, data={"newest": True})
  world.db.add(duplicate)
  world.commit()
  duplicate_id = duplicate.id
  found = Output.get_or_create(world.db, batch=batch, test_input=output.test_input, platform='linux',
                               configurations=['base'], extra_parameters={})
  assert found.id == duplicate_id and found.data == {"newest": True}
  assert [o.id for o in world.db.query(Output).filter(Output.batch_id == batch.id)] == [duplicate_id]
  # the files stay: they are the newest's too
  assert (first.output_dir / 'image.png').exists()


def test_exports_dont_replace_what_was_there(world, logged_in):
  """Users choose the export folder: what's in it isn't theirs, and isn't an export they can delete"""
  from backend.models import Export
  run = world.run(world.batch('proj'), deleted=False, files=True, size=10)
  world.commit()
  alice = logged_in('alice')
  def export(folder, method='POST', **headers):
    url = f'/api/v1/export/?project=proj&new_commit_id={"a" * 40}&path=*.png&export_type=link&export_dir={folder}'
    return alice.open(url, method=method, headers=headers)
  fresh = world.storage / 'fresh'
  response = export(fresh)
  assert response.status_code == 200 and response.get_json()["errors"] == [], response.get_json()
  assert response.get_json()["export_id"] and response.get_json()["nb_files_exported"] == 1
  name, = [p.name for p in fresh.iterdir() if p.name.endswith('.png')]
  assert os.path.samefile(fresh / name, run.output_dir / 'image.png')
  # exporting again into our own export is fine
  assert export(fresh).get_json()["errors"] == []
  # someone's folder, with a file or a folder named like what we export
  for kind in ('file', 'folder'):
    theirs = world.storage / f'theirs-{kind}'
    theirs.mkdir()
    if kind == 'file':
      (theirs / name).write_text('precious')
    else:
      (theirs / name).mkdir()
      (theirs / name / 'results.csv').write_text('precious')
    response = export(theirs)
    assert response.status_code == 200 and len(response.get_json()["errors"]) == 1, response.get_json()
    assert response.get_json()["export_id"] is None
    precious = theirs / name if kind == 'file' else theirs / name / 'results.csv'
    assert precious.read_text() == 'precious'
    assert Export.query.filter(Export.path == str(theirs)).count() == 0
  # other websites' links (GET, with cookies): refused. The web app's own pages: fine
  response = export(world.storage / 'from-a-link', method='GET')
  assert response.status_code == 403 and response.get_json()["reason"] == "cross_site_write"
  assert export(world.storage / 'from-a-link', method='GET', **{'Sec-Fetch-Site': 'cross-site', 'Referer': 'http://localhost/'}).status_code == 403
  assert export(world.storage / 'from-a-link', method='GET', Referer='https://evil.example/').status_code == 403
  assert not (world.storage / 'from-a-link').exists()
  assert export(world.storage / 'older-web-app', method='GET', **{'Sec-Fetch-Site': 'same-origin'}).status_code == 200
  assert export(world.storage / 'older-browser', method='GET', Referer='http://localhost/proj/commit/a').status_code == 200
  # cross-site POSTs are refused by backend/actor.py
  assert export(world.storage / 'from-a-form', Origin='https://evil.example').status_code == 403


def test_exports_with_tokens(world, logged_in, make_client):
  """Scripts export with a token, GET or POST: it writes, so it needs the "act" scope"""
  from .conftest import new_token, bearer
  world.run(world.batch('proj'), deleted=False, files=True, size=10)
  world.commit()
  alice = logged_in('alice')
  script = make_client()
  def export(token, folder, method):
    url = f'/api/v1/export/?project=proj&new_commit_id={"a" * 40}&path=*.png&export_type=link&export_dir={world.storage / folder}'
    return script.open(url, method=method, headers=bearer(token))
  reader = new_token(alice, scopes=["read"])["token"]
  for method in ('GET', 'POST'):
    response = export(reader, f'read-{method}', method)
    assert response.status_code == 403 and response.get_json()["reason"] == "missing_scope", response.get_json()
    assert not (world.storage / f'read-{method}').exists()
  actor = new_token(alice, scopes=["read", "act"])["token"]
  for method in ('GET', 'POST'):
    response = export(actor, f'act-{method}', method)
    assert response.status_code == 200 and response.get_json()["nb_files_exported"] == 1, response.get_json()
